/*
 * Home rentals: requirements and capacity.
 * A live back-of-the-envelope calculator. Nights booked and the average stay
 * give bookings per second (small); the look-to-book ratio turns them into
 * searches (large). Listings and the booking horizon give listing-night rows
 * and an availability bitmap small enough to keep in memory on every search
 * shard. Smart pricing turns into index writes that dwarf bookings, calendar
 * sync into outbound polls, and photos into the bytes that dominate storage.
 */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;
  const esc = ui.esc;

  const INPUTS = [
    { id: 'listings', label: 'Active listings', unit: 'million', min: 0.1, max: 20, step: 0.1, value: 9 },
    { id: 'nights', label: 'Nights booked a year', unit: 'million', min: 1, max: 1000, step: 1, value: 533 },
    { id: 'stay', label: 'Average stay', unit: 'nights', min: 1, max: 14, step: 0.5, value: 4 },
    { id: 'look', label: 'Search requests per booking', unit: '', min: 10, max: 2000, step: 10, value: 300 },
    { id: 'views', label: 'Listing pages viewed per booking', unit: '', min: 1, max: 200, step: 1, value: 30 },
    { id: 'peak', label: 'Peak-to-average ratio', unit: '×', min: 1, max: 10, step: 0.5, value: 4 },
    { id: 'horizon', label: 'Booking horizon', unit: 'days', min: 90, max: 1095, step: 5, value: 730 },
    { id: 'smart', label: 'Listings on automatic pricing', unit: '%', min: 0, max: 100, step: 5, value: 30 },
    { id: 'reprice', label: 'Nights repriced per listing per day', unit: '', min: 1, max: 730, step: 1, value: 365 },
    { id: 'ical', label: 'Listings syncing another site’s calendar', unit: '%', min: 0, max: 60, step: 1, value: 20 },
    { id: 'poll', label: 'Calendar poll interval', unit: 'hours', min: 0.25, max: 24, step: 0.25, value: 2 },
    { id: 'photos', label: 'Photos per listing', unit: '', min: 5, max: 100, step: 1, value: 25 },
    { id: 'photoMB', label: 'Average photo size', unit: 'MB', min: 0.5, max: 10, step: 0.1, value: 3 },
    { id: 'msgs', label: 'Messages per booking', unit: '', min: 0, max: 50, step: 1, value: 10 },
  ];
  const REQS = [
    { id: 'bitmap', label: 'Keep a bitmap of free nights in the search index (no calendar call per result)', value: true },
    { id: 'batch', label: 'Batch price changes: one index update per listing a day, not one per night', value: true },
    { id: 'push', label: 'Channel managers push changes instead of being polled', value: false },
    { id: 'renditions', label: 'Store resized renditions of every photo (about +30%)', value: true },
  ];
  const SCENARIOS = {
    big: { label: 'Global marketplace', set: { listings: 9, nights: 533, stay: 4, look: 300, smart: 30, ical: 20 } },
    young: { label: 'Regional start-up', set: { listings: 0.2, nights: 5, stay: 3, look: 500, smart: 10, ical: 40 } },
    holiday: { label: 'New Year rush', set: { peak: 10, look: 800 } },
  };
  const AVAIL = { '99.9': 525, '99.99': 52.6, '99.999': 5.26 };
  const YEAR = 365 * 86400;
  const ROW_BYTES = 120; // one listing-night row with its indexes
  const THUMB_KB = 60;
  const RESULTS = 20;

  function fmt(n, d) {
    if (n >= 1e12) return (n / 1e12).toFixed(d == null ? 1 : d) + ' trillion';
    if (n >= 1e9) return (n / 1e9).toFixed(d == null ? 1 : d) + ' billion';
    if (n >= 1e6) return (n / 1e6).toFixed(d == null ? 1 : d) + ' million';
    if (n >= 1000) return Math.round(n).toLocaleString('en-US');
    return n.toFixed(d == null ? 1 : d);
  }
  const bytes = (b) => (b >= 1e15 ? (b / 1e15).toFixed(1) + ' PB' : b >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(1) + ' MB');
  const bps = (b) => (b >= 1e12 ? (b / 1e12).toFixed(1) + ' Tbps' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' Gbps' : (b / 1e6).toFixed(0) + ' Mbps');
  const rate = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : fmt(n, n < 10 ? 1 : 0));

  function compute(v, r) {
    const listings = v.listings * 1e6;
    const bookings = (v.nights * 1e6) / v.stay;
    const bAvg = bookings / YEAR;
    const bPeak = bAvg * v.peak;
    const sAvg = (bookings * v.look) / YEAR;
    const sPeak = sAvg * v.peak;
    const viewPeak = ((bookings * v.views) / YEAR) * v.peak;
    const calChecks = r.bitmap ? 0 : sPeak * RESULTS; // one calendar check per result on every search
    const rows = listings * v.horizon;
    const rowBytes = rows * ROW_BYTES;
    const bitmap = (listings * v.horizon) / 8;
    const prices = listings * v.horizon * 4;
    const smartListings = listings * (v.smart / 100);
    const nightPriceWrites = (smartListings * v.reprice) / 86400;
    const indexWrites = (r.batch ? smartListings / 86400 : nightPriceWrites) + bAvg * 2;
    const icalListings = listings * (v.ical / 100);
    const polls = r.push ? 0 : icalListings / (v.poll * 3600);
    const pushes = r.push ? bAvg * 3 : 0;
    const photoBytes = listings * v.photos * v.photoMB * 1e6 * (r.renditions ? 1.3 : 1);
    const egress = sPeak * RESULTS * THUMB_KB * 1e3 * 8;
    const msgs = (bookings * v.msgs) / YEAR;
    const msgBytesYear = bookings * v.msgs * 500;
    return { listings, bookings, bAvg, bPeak, sAvg, sPeak, viewPeak, calChecks, rows, rowBytes, bitmap, prices, nightPriceWrites, indexWrites, icalListings, polls, pushes, photoBytes, egress, msgs, msgBytesYear };
  }

  function insights(v, r, o) {
    const out = [];
    out.push(`${fmt(v.nights * 1e6)} nights at ${v.stay} a stay is ${fmt(o.bookings)} bookings a year: ${rate(o.bAvg)} a second on average and ${rate(o.bPeak)} at a ${v.peak}× peak. Bookings are tiny. What makes them hard is that a night must never be sold twice, so they go through one strongly consistent calendar row per night, sharded by listing.`);
    out.push(`Searches are where the load is: ${v.look} search requests per booking (map pans, filter changes, date changes) is ${rate(o.sPeak)} a second at peak, ${Math.round(o.sPeak / Math.max(o.bPeak, 1e-9)).toLocaleString('en-US')} times the booking rate. Search reads a copy of the calendar that may lag a few seconds; the booking path always re-checks the real one.`);
    out.push(r.bitmap
      ? `The date filter is cheap because availability fits in memory: ${fmt(o.listings)} listings × ${v.horizon} nights is ${fmt(o.rows)} listing-nights, but as one bit each that is ${bytes(o.bitmap)}, small enough to keep on every search shard. Nightly prices are larger (${bytes(o.prices)} at 4 bytes a night), so shard them or keep coarse price buckets in the index.`
      : `Without a bitmap in the index, every result must be checked against the calendar service: ${rate(o.calChecks)} calendar reads a second at peak. That is why the free nights live in the search index as a bitmap (${bytes(o.bitmap)} for every listing).`);
    out.push(`Price changes, not bookings, dominate writes. Automatic pricing on ${v.smart}% of listings, repricing ${v.reprice} nights each a day, is ${rate(o.nightPriceWrites)} night-price writes a second. ${r.batch ? `Batched into one document update per listing a day, the index takes ${rate(o.indexWrites)} updates a second.` : `Sent to the index one night at a time, that is ${rate(o.indexWrites)} index updates a second: batch them per listing.`}`);
    out.push(r.push
      ? `With channel managers pushing changes, calendar sync costs about ${rate(o.pushes)} webhooks a second and a double booking across sites is a window of seconds.`
      : `Calendar sync by polling ${fmt(o.icalListings)} iCal feeds every ${v.poll} h is ${rate(o.polls)} outbound fetches a second, and leaves a window of up to ${v.poll} h in which both sites can sell the same night. Polling faster costs more fetches; only push narrows the window to seconds.`);
    out.push(`Photos are the bytes: ${fmt(o.listings)} listings × ${v.photos} photos × ${v.photoMB} MB is ${bytes(o.photoBytes)}${r.renditions ? ' with resized renditions' : ''}. Every search page loads about ${RESULTS} thumbnails, so peak image egress is ${bps(o.egress)}: serve it from a CDN. The listing-night rows themselves are only ${bytes(o.rowBytes)}.`);
    out.push(`Messages are modest: ${rate(o.msgs)} a second, about ${bytes(o.msgBytesYear)} a year. They need order within a conversation and delivery to offline phones (see the direct messages lab), not raw throughput.`);
    return out;
  }

  ui.mountBnbCapacity = function (pageId) {
    const main = ui.mountShell(pageId);
    const page = SDL.page(pageId);
    const vals = Object.fromEntries(INPUTS.map((i) => [i.id, i.value]));
    const reqs = Object.fromEntries(REQS.map((i) => [i.id, i.value]));
    let avail = '99.99';
    main.innerHTML = `
      <div class="lab-head">
        <h1>${esc(page.title)}</h1>
        <p class="lede">${esc(page.summary)}</p>
        <p class="disclaimer">Back-of-the-envelope estimates for learning. The defaults start from Airbnb’s reported 533 million nights and seats booked in 2025 and about 9 million listings; ratios, sizes, and intervals are stated assumptions, not any company’s internals.</p>
      </div>
      <div class="cap-grid">
        <section class="panel panel-product" aria-labelledby="h-in">
          <h2 id="h-in">Inputs</h2>
          <div class="ops-traffic cap-scen" role="group" aria-label="Scenarios">${Object.entries(SCENARIOS).map(([k, s]) => `<button class="btn ops-tbtn" data-scen="${k}">${esc(s.label)}</button>`).join('')}</div>
          <div class="cap-inputs">${INPUTS.map((i) => `
            <div class="cap-input"><label for="in-${i.id}">${esc(i.label)}</label>
              <input type="range" id="in-${i.id}" data-in="${i.id}" min="${i.min}" max="${i.max}" step="${i.step}" value="${i.value}">
              <output for="in-${i.id}" data-out="${i.id}"></output></div>`).join('')}</div>
          <h3 class="subhead">Design choices</h3>
          <div class="cap-reqs">${REQS.map((r) => `<label class="check"><input type="checkbox" data-req="${r.id}"${r.value ? ' checked' : ''}> ${esc(r.label)}</label>`).join('')}</div>
          <h3 class="subhead">Availability target for booking</h3>
          <div class="ops-traffic" role="group" aria-label="Availability">${Object.keys(AVAIL).map((a) => `<button class="btn ops-tbtn" data-avail="${a}">${a}%</button>`).join('')}</div>
        </section>
        <div class="lab-main">
          <section class="panel panel-metrics" aria-labelledby="h-load"><h2 id="h-load">Sizing <span class="sim-tag">Estimated</span></h2><dl class="metric-grid" data-ref="load"></dl></section>
          <section class="panel panel-diagram" aria-labelledby="h-rps"><h2 id="h-rps">Requests and writes per second at peak</h2><div data-ref="bars"></div><h3 class="subhead">Storage</h3><div data-ref="store"></div></section>
          <section class="panel panel-ledger" aria-labelledby="h-ins"><h2 id="h-ins">What these numbers say</h2><ul class="ledger-notes" data-ref="insights"></ul><p class="recon" data-ref="avail"></p></section>
        </div>
      </div>`;
    const q = (s) => main.querySelector(s);
    function render() {
      for (const i of INPUTS) q(`[data-out="${i.id}"]`).textContent = `${vals[i.id]}${i.unit ? (i.unit.length <= 2 ? i.unit : ' ' + i.unit) : ''}`;
      main.querySelectorAll('[data-avail]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.avail === avail)));
      const o = compute(vals, reqs);
      const tile = (label, value, hint, tone) => `<div class="metric"${tone ? ` data-tone="${tone}"` : ''}><dt>${esc(label)}</dt><dd>${esc(value)}</dd>${hint ? `<p class="metric-hint">${esc(hint)}</p>` : ''}</div>`;
      q('[data-ref="load"]').innerHTML =
        tile('Bookings', `${rate(o.bPeak)}/s`, `at peak; ${rate(o.bAvg)}/s average`) +
        tile('Search requests', `${rate(o.sPeak)}/s`, 'at peak: the load that shapes the design', 'warn') +
        tile('Index updates', `${rate(o.indexWrites)}/s`, reqs.batch ? 'prices batched per listing' : 'one per repriced night', reqs.batch ? '' : 'fail') +
        tile('Listing-night rows', fmt(o.rows), `${bytes(o.rowBytes)} in the calendar database`) +
        tile('Availability bitmap', bytes(o.bitmap), 'fits in memory on every shard', 'ok') +
        tile(reqs.push ? 'Sync webhooks' : 'Calendar polls', `${rate(reqs.push ? o.pushes : o.polls)}/s`, reqs.push ? 'window: seconds' : `window: up to ${vals.poll} h`, reqs.push ? '' : 'warn') +
        tile('Photo storage', bytes(o.photoBytes), `${vals.photos} photos a listing`, 'fail') +
        tile('Image egress', bps(o.egress), 'at peak, from the CDN');
      const bars = { 'Search requests': o.sPeak, 'Listing page views': o.viewPeak, 'Index updates': o.indexWrites, [reqs.push ? 'Sync webhooks' : 'Calendar polls']: reqs.push ? o.pushes : o.polls, Messages: o.msgs * vals.peak, Bookings: o.bPeak };
      if (!reqs.bitmap) bars['Calendar checks from search'] = o.calChecks;
      const max = Math.max(...Object.values(bars), 1);
      const top = Object.entries(bars).sort((a, b) => b[1] - a[1])[0][0];
      q('[data-ref="bars"]').innerHTML = `<div class="cap-bars is-wide">${Object.entries(bars).map(([k, n]) => `
        <div class="cap-bar${k === top ? ' is-top' : ''}"><span class="cap-label">${esc(k)}</span><span class="cap-track"><i style="width:${Math.max(0.5, (n / max) * 100)}%"></i></span><span class="cap-n">${rate(n)}/s</span></div>`).join('')}</div>`;
      const store = { Photos: o.photoBytes, 'Listing-night rows': o.rowBytes, 'Nightly prices': o.prices, 'Messages a year': o.msgBytesYear, 'Availability bitmap': o.bitmap };
      const smax = Math.max(...Object.values(store), 1);
      q('[data-ref="store"]').innerHTML = `<div class="cap-bars is-wide">${Object.entries(store).map(([k, b], i) => `<div class="cap-bar${i === 0 ? ' is-top' : ''}"><span class="cap-label">${esc(k)}</span><span class="cap-track"><i style="width:${Math.max(0.5, (b / smax) * 100)}%"></i></span><span class="cap-n">${bytes(b)}</span></div>`).join('')}</div>`;
      q('[data-ref="insights"]').innerHTML = insights(vals, reqs, o).map((t) => `<li>${esc(t)}</li>`).join('');
      q('[data-ref="avail"]').textContent = `${avail}% allows about ${AVAIL[avail]} minutes a year when nobody can book. Search can degrade (stale or partial results) and stay up; booking and payments cannot, and they must also never be wrong: no night sold twice, no guest charged twice.`;
    }
    main.addEventListener('input', (e) => { const id = e.target.dataset.in; if (id) { vals[id] = Number(e.target.value); render(); } });
    main.addEventListener('change', (e) => { const id = e.target.dataset.req; if (id) { reqs[id] = e.target.checked; render(); } });
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
})();
