/*
 * Ride hailing: requirements and capacity.
 * A live back-of-the-envelope calculator. Every input recomputes every output;
 * per-server capacities are stated assumptions, not measurements.
 */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;
  const esc = ui.esc;

  const INPUTS = [
    { id: 'riders', label: 'Daily active riders', unit: 'million', min: 1, max: 50, step: 1, value: 10 },
    { id: 'tripsPer', label: 'Trips per rider per day', unit: '', min: 0.2, max: 3, step: 0.1, value: 0.6 },
    { id: 'peak', label: 'Peak-to-average ratio', unit: '×', min: 1, max: 8, step: 0.5, value: 3 },
    { id: 'drivers', label: 'Drivers online at peak', unit: 'thousand', min: 50, max: 2000, step: 50, value: 600 },
    { id: 'interval', label: 'Driver ping interval', unit: 's', min: 1, max: 15, step: 1, value: 4 },
    { id: 'coalesce', label: 'Stationary pings coalesced', unit: '%', min: 0, max: 80, step: 5, value: 30 },
    { id: 'bytes', label: 'Bytes per ping', unit: 'B', min: 50, max: 500, step: 10, value: 120 },
    { id: 'duration', label: 'Average trip length', unit: 'min', min: 5, max: 60, step: 1, value: 18 },
    { id: 'retention', label: 'GPS trail retention', unit: 'days', min: 7, max: 730, step: 7, value: 91 },
  ];
  const REQS = [
    { id: 'live', label: 'Riders watch the car move live', value: true },
    { id: 'trails', label: 'Store every GPS point of every trip', value: true },
    { id: 'multi', label: 'Active-active in two regions', value: false },
    { id: 'surge', label: 'Surge computed per map cell', value: true },
  ];
  const CAP = {
    ingest: { label: 'Location ingest servers', per: 20000, unit: 'pings/s each' },
    geo: { label: 'Geo index shards', per: 25000, unit: 'writes/s each, with 2× hot-key headroom' },
    ws: { label: 'WebSocket servers', per: 50000, unit: 'connections each' },
    dispatch: { label: 'Dispatch servers', per: 2000, unit: 'requests/s each' },
    stream: { label: 'Stream brokers', per: 50, unit: 'MB/s each' },
    tripdb: { label: 'Trip database primaries', per: 5000, unit: 'writes/s each' },
    surge: { label: 'Surge aggregator workers', per: 30000, unit: 'events/s each' },
  };
  const SCENARIOS = {
    weekday: { label: 'Typical weekday', set: { riders: 10, tripsPer: 0.6, peak: 3, drivers: 600, interval: 4 } },
    nye: { label: 'New Year’s Eve', set: { riders: 14, tripsPer: 0.9, peak: 6, drivers: 900, interval: 4 } },
    cities: { label: 'Launch in 10 more cities', set: { riders: 15, tripsPer: 0.6, peak: 3, drivers: 900, interval: 4 } },
    fast: { label: 'Ping every second', set: { riders: 10, tripsPer: 0.6, peak: 3, drivers: 600, interval: 1 } },
  };
  const AVAIL = { '99.9': 43.8, '99.95': 21.9, '99.99': 4.4 };

  function fmt(n, d) {
    if (n >= 1e9) return (n / 1e9).toFixed(d == null ? 1 : d) + ' billion';
    if (n >= 1e6) return (n / 1e6).toFixed(d == null ? 1 : d) + ' million';
    if (n >= 1e4) return Math.round(n).toLocaleString('en-US');
    if (n >= 100) return Math.round(n).toLocaleString('en-US');
    return n.toFixed(d == null ? 1 : d);
  }

  function compute(v, r) {
    const trips = v.riders * 1e6 * v.tripsPer;
    const avgTripRps = trips / 86400;
    const peakTripRps = avgTripRps * v.peak;
    const inProgress = peakTripRps * v.duration * 60;
    const pings = (v.drivers * 1000) / v.interval;
    const geoWrites = pings * (1 - v.coalesce / 100);
    const livePushes = r.live ? inProgress / v.interval : 0;
    const regions = r.multi ? 2 : 1;
    const streamMBs = (pings * v.bytes * regions) / 1e6;
    const avgPings = pings * 0.4;
    const trailTB = r.trails ? (avgPings * 86400 * v.bytes * v.retention * 3 * regions) / 1e12 : 0;
    const conns = v.drivers * 1000 + inProgress * 1.5 + peakTripRps * 60 * 3;
    const dispatchRps = peakTripRps * 8;
    const tripWrites = peakTripRps * 6;
    const surgeEvents = r.surge ? pings + peakTripRps * 4 : 0;
    const servers = {
      ingest: Math.ceil((pings * regions) / CAP.ingest.per),
      geo: Math.ceil((geoWrites * 2 * regions) / (CAP.geo.per * 2)) * 2,
      ws: Math.ceil((conns * regions) / CAP.ws.per),
      dispatch: Math.ceil((dispatchRps * regions) / CAP.dispatch.per),
      stream: Math.ceil(streamMBs / CAP.stream.per),
      tripdb: Math.ceil((tripWrites * regions) / CAP.tripdb.per),
      surge: r.surge ? Math.ceil((surgeEvents * regions) / CAP.surge.per) : 0,
    };
    return { trips, avgTripRps, peakTripRps, inProgress, pings, geoWrites, livePushes, streamMBs, trailTB, conns, dispatchRps, tripWrites, servers };
  }

  function insights(v, r, o) {
    const out = [];
    const top = Object.entries(o.servers).sort((a, b) => b[1] - a[1])[0];
    const why = {
      ingest: `every one of ${fmt(o.pings)} pings per second passes through ingest`,
      geo: `every one of ${fmt(o.geoWrites)} uncoalesced pings per second is a geo index write`,
      ws: `every online driver and every rider on a trip holds an open socket: ${fmt(o.conns)} at peak`,
      dispatch: `matching does several lookups for each of ${fmt(o.peakTripRps)} requests per second`,
      stream: `the location stream carries ${fmt(o.streamMBs)} MB/s`,
      tripdb: `each trip writes about six times`,
      surge: 'surge consumes every ping as a supply signal',
    }[top[0]];
    out.push(`${CAP[top[0]].label} are the largest group at ${top[1]} machines, because ${why}.`);
    out.push(`Driver pings outnumber ride requests about ${fmt(o.pings / Math.max(1, o.peakTripRps), 0)} to 1 at peak (${fmt(o.pings)} versus ${fmt(o.peakTripRps)} per second). Location, not trips, drives the load.`);
    const saved = (v.drivers * 1000) / v.interval - o.geoWrites;
    if (v.coalesce > 0) out.push(`Coalescing ${v.coalesce}% of stationary pings saves ${fmt(saved)} geo index writes per second.`);
    if (v.interval <= 2) out.push(`Pinging every ${v.interval} s gives smoother tracking, but ${Math.round(4 / v.interval)}× the ingest load of a 4 s interval.`);
    if (r.trails) out.push(`Keeping every GPS point for ${v.retention} days needs about ${fmt(o.trailTB, 0)} TB (three replicas${r.multi ? ', two regions' : ''}). Downsampling old trails is the usual saving.`);
    if (v.peak >= 5) out.push(`A ${v.peak}× peak means provisioning for ${v.peak} times the average. Autoscaling and pre-warming before known events (concerts, New Year’s Eve) matter more than raw efficiency.`);
    if (r.multi) out.push('Active-active doubles most capacity and adds cross-region replication, in exchange for surviving a region outage.');
    return out;
  }

  ui.mountCapacity = function (pageId) {
    const main = ui.mountShell(pageId);
    const page = SDL.page(pageId);
    const vals = Object.fromEntries(INPUTS.map((i) => [i.id, i.value]));
    const reqs = Object.fromEntries(REQS.map((i) => [i.id, i.value]));
    let avail = '99.95';
    main.innerHTML = `
      <div class="lab-head">
        <h1>${esc(page.title)}</h1>
        <p class="lede">${esc(page.summary)}</p>
        <p class="disclaimer">Back-of-the-envelope estimates for learning. Per-server capacities are stated assumptions; real numbers depend on hardware, payload, and software.</p>
      </div>
      <div class="cap-grid">
        <section class="panel panel-product" aria-labelledby="h-in">
          <h2 id="h-in">Inputs</h2>
          <div class="ops-traffic cap-scen" role="group" aria-label="Scenarios">${Object.entries(SCENARIOS).map(([k, s]) => `<button class="btn ops-tbtn" data-scen="${k}">${esc(s.label)}</button>`).join('')}</div>
          <div class="cap-inputs">${INPUTS.map((i) => `
            <div class="cap-input"><label for="in-${i.id}">${esc(i.label)}</label>
              <input type="range" id="in-${i.id}" data-in="${i.id}" min="${i.min}" max="${i.max}" step="${i.step}" value="${i.value}">
              <output for="in-${i.id}" data-out="${i.id}"></output></div>`).join('')}</div>
          <h3 class="subhead">Functional requirements</h3>
          <div class="cap-reqs">${REQS.map((r) => `<label class="check"><input type="checkbox" data-req="${r.id}"${r.value ? ' checked' : ''}> ${esc(r.label)}</label>`).join('')}</div>
          <h3 class="subhead">Availability target</h3>
          <div class="ops-traffic" role="group" aria-label="Availability">${Object.keys(AVAIL).map((a) => `<button class="btn ops-tbtn" data-avail="${a}">${a}%</button>`).join('')}</div>
        </section>
        <div class="lab-main">
          <section class="panel panel-metrics" aria-labelledby="h-load"><h2 id="h-load">Load at peak <span class="sim-tag">Estimated</span></h2><dl class="metric-grid" data-ref="load"></dl></section>
          <section class="panel panel-diagram" aria-labelledby="h-srv"><h2 id="h-srv">Servers by component</h2><div data-ref="bars"></div><p class="surge-meta" data-ref="caps"></p></section>
          <section class="panel panel-ledger" aria-labelledby="h-ins"><h2 id="h-ins">What these numbers say</h2><ul class="ledger-notes" data-ref="insights"></ul><p class="recon" data-ref="avail"></p></section>
        </div>
      </div>`;
    const q = (s) => main.querySelector(s);
    function render() {
      for (const i of INPUTS) q(`[data-out="${i.id}"]`).textContent = `${vals[i.id]}${i.unit ? (i.unit.length <= 2 ? i.unit : ' ' + i.unit) : ''}`;
      main.querySelectorAll('[data-avail]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.avail === avail)));
      const o = compute(vals, reqs);
      const tile = (label, value, hint) => `<div class="metric"><dt>${esc(label)}</dt><dd>${esc(value)}</dd>${hint ? `<p class="metric-hint">${esc(hint)}</p>` : ''}</div>`;
      q('[data-ref="load"]').innerHTML =
        tile('Trips per day', fmt(o.trips)) +
        tile('Ride requests per second', fmt(o.peakTripRps), `average ${fmt(o.avgTripRps)}`) +
        tile('Trips in progress', fmt(o.inProgress)) +
        tile('Location pings per second', fmt(o.pings)) +
        tile('Geo index writes per second', fmt(o.geoWrites), `after ${vals.coalesce}% coalescing`) +
        tile('Live tracking pushes per second', reqs.live ? fmt(o.livePushes) : 'off') +
        tile('Location stream', `${fmt(o.streamMBs)} MB/s`) +
        tile('GPS trail storage', reqs.trails ? `${fmt(o.trailTB, 0)} TB` : 'off', `${vals.retention} days, 3 replicas`) +
        tile('Open WebSockets', fmt(o.conns)) +
        tile('Trip database writes per second', fmt(o.tripWrites), 'about 6 per trip');
      const max = Math.max(...Object.values(o.servers), 1);
      const top = Object.entries(o.servers).sort((a, b) => b[1] - a[1])[0][0];
      q('[data-ref="bars"]').innerHTML = `<div class="cap-bars">${Object.entries(o.servers).map(([k, n]) => `
        <div class="cap-bar${k === top ? ' is-top' : ''}"><span class="cap-label">${esc(CAP[k].label)}</span><span class="cap-track"><i style="width:${(n / max) * 100}%"></i></span><span class="cap-n">${n}</span></div>`).join('')}</div>`;
      q('[data-ref="caps"]').textContent = 'Assumed capacity: ' + Object.values(CAP).map((c) => `${c.label.toLowerCase()} ${c.per.toLocaleString('en-US')} ${c.unit}`).join('; ') + '.';
      q('[data-ref="insights"]').innerHTML = insights(vals, reqs, o).map((t) => `<li>${esc(t)}</li>`).join('');
      q('[data-ref="avail"]').textContent = `${avail}% availability allows about ${AVAIL[avail]} minutes of downtime per month${avail === '99.99' ? ': too little for manual recovery, so failover must be automatic.' : avail === '99.9' ? '.' : ', roughly one short incident.'}`;
    }
    main.addEventListener('input', (e) => {
      const id = e.target.dataset.in;
      if (id) { vals[id] = Number(e.target.value); render(); }
    });
    main.addEventListener('change', (e) => {
      const id = e.target.dataset.req;
      if (id) { reqs[id] = e.target.checked; render(); }
    });
    main.addEventListener('click', (e) => {
      const s = e.target.closest('[data-scen]');
      if (s) {
        Object.assign(vals, SCENARIOS[s.dataset.scen].set);
        for (const i of INPUTS) q(`[data-in="${i.id}"]`).value = vals[i.id];
        main.querySelectorAll('[data-scen]').forEach((b) => b.setAttribute('aria-pressed', String(b === s)));
        render();
      }
      const a = e.target.closest('[data-avail]');
      if (a) { avail = a.dataset.avail; render(); }
    });
    render();
    window.SDL_CAPACITY = { compute, vals, reqs };
  };
  ui.capacityCompute = compute;
})();
