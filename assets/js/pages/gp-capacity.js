/*
 * Photo backup: requirements and capacity.
 * A live back-of-the-envelope calculator. Users and uploads per user set the
 * daily ingest; sizes, storage saver, and dedupe turn it into logical bytes;
 * the durability scheme (three copies, Reed–Solomon, cross-region parity) and
 * the hot window turn logical bytes into raw disk and a yearly bill. Storage
 * growth is the number that shapes the design; thumbnail reads come second.
 */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;
  const esc = ui.esc;

  const INPUTS = [
    { id: 'users', label: 'Monthly active users', unit: 'million', min: 10, max: 3000, step: 10, value: 1500 },
    { id: 'perUser', label: 'Photos and videos per user per day', unit: '', min: 0.1, max: 10, step: 0.1, value: 2.7 },
    { id: 'video', label: 'Share that are videos', unit: '%', min: 0, max: 50, step: 1, value: 10 },
    { id: 'photoMB', label: 'Average photo size', unit: 'MB', min: 0.5, max: 10, step: 0.1, value: 2.5 },
    { id: 'videoMB', label: 'Average video size', unit: 'MB', min: 5, max: 300, step: 5, value: 30 },
    { id: 'peak', label: 'Peak-to-average ratio', unit: '×', min: 1, max: 6, step: 0.5, value: 3 },
    { id: 'holiday', label: 'Holiday peak (New Year’s Day)', unit: '×', min: 2, max: 20, step: 1, value: 10 },
    { id: 'saver', label: 'Uploads on storage saver', unit: '%', min: 0, max: 100, step: 5, value: 30 },
    { id: 'dedupe', label: 'Uploads that are duplicates', unit: '%', min: 0, max: 30, step: 1, value: 5 },
    { id: 'hotDays', label: 'Days a photo stays on the hot tier', unit: 'days', min: 7, max: 365, step: 1, value: 30 },
    { id: 'years', label: 'Years of history kept', unit: 'years', min: 1, max: 15, step: 1, value: 5 },
    { id: 'dau', label: 'Monthly users who open the app daily', unit: '%', min: 5, max: 80, step: 5, value: 30 },
    { id: 'tiles', label: 'Thumbnails loaded per session', unit: '', min: 20, max: 1000, step: 10, value: 200 },
    { id: 'price', label: 'Raw disk cost', unit: '$/TB-month', min: 1, max: 20, step: 0.5, value: 4 },
  ];
  const REQS = [
    { id: 'ec', label: 'Erasure-code photos once they leave the hot tier (Reed–Solomon 10+4)', value: true },
    { id: 'geo', label: 'Survive losing a whole region (cross-region copies or parity)', value: true },
    { id: 'applySaver', label: 'Storage saver recompresses (to about 40% of the size)', value: true },
    { id: 'applyDedupe', label: 'Deduplicate by content hash', value: true },
  ];
  const SCENARIOS = {
    big: { label: 'Global photo app', set: { users: 1500, perUser: 2.7, video: 10, holiday: 10, years: 5 } },
    young: { label: 'New service, year one', set: { users: 50, perUser: 3, video: 15, holiday: 8, years: 1 } },
    video: { label: 'Video-heavy', set: { users: 1500, perUser: 2.7, video: 30, videoMB: 60, years: 5 } },
  };
  const AVAIL = { '99.9': 525, '99.99': 52.6, '99.999': 5.26 };
  const META_BYTES = 1000; // one library item row with its indexes
  const THUMB_KB = 60; // all renditions of one item
  const SAVER_RATIO = 0.4;

  function fmt(n, d) {
    if (n >= 1e12) return (n / 1e12).toFixed(d == null ? 1 : d) + ' trillion';
    if (n >= 1e9) return (n / 1e9).toFixed(d == null ? 1 : d) + ' billion';
    if (n >= 1e6) return (n / 1e6).toFixed(d == null ? 1 : d) + ' million';
    if (n >= 1000) return Math.round(n).toLocaleString('en-US');
    return n.toFixed(d == null ? 1 : d);
  }
  const bytes = (b) => (b >= 1e18 ? (b / 1e18).toFixed(1) + ' EB' : b >= 1e15 ? (b / 1e15).toFixed(1) + ' PB' : b >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(1) + ' MB');
  const bps = (b) => (b >= 1e12 ? (b / 1e12).toFixed(1) + ' Tbps' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' Gbps' : (b / 1e6).toFixed(0) + ' Mbps');
  const money = (d) => (d >= 1e9 ? '$' + (d / 1e9).toFixed(1) + ' billion' : d >= 1e6 ? '$' + (d / 1e6).toFixed(0) + ' million' : '$' + Math.round(d).toLocaleString('en-US'));

  function compute(v, r) {
    const users = v.users * 1e6;
    const daily = users * v.perUser;
    const avg = daily / 86400;
    const peak = avg * v.peak;
    const holiday = avg * v.holiday;
    const vid = v.video / 100;
    const itemMB = (1 - vid) * v.photoMB + vid * v.videoMB;
    const ingestBytes = daily * itemMB * 1e6; // over the network, before dedupe
    const ingestBps = (ingestBytes * 8) / 86400;
    const saverF = r.applySaver ? 1 - (v.saver / 100) * (1 - SAVER_RATIO) : 1;
    const dedupeF = r.applyDedupe ? 1 - v.dedupe / 100 : 1;
    const logicalDay = ingestBytes * saverF * dedupeF;
    const logicalYear = logicalDay * 365;
    const total = logicalYear * v.years;
    const hot = Math.min(total, logicalDay * v.hotDays);
    const warm = total - hot;
    const hotX = 3; // three full copies; with geo on they span regions
    const warmX = r.ec ? (r.geo ? 2.1 : 1.4) : 3;
    const rawHot = hot * hotX;
    const rawWarm = warm * warmX;
    const raw = rawHot + rawWarm;
    const rawAll3 = total * 3;
    const costYear = (raw / 1e12) * v.price * 12;
    const cost3Year = (rawAll3 / 1e12) * v.price * 12;
    const meta = daily * 365 * META_BYTES * v.years;
    const thumbs = daily * 365 * THUMB_KB * 1e3 * v.years;
    const dau = users * (v.dau / 100);
    const thumbReads = (dau * 3 * v.tiles) / 86400;
    const thumbPeak = thumbReads * v.peak;
    const egressBps = thumbPeak * 20e3 * 8; // 20 KB per grid thumbnail
    const search = (dau * 1) / 86400;
    const items = daily * 365 * v.years;
    return { users, daily, avg, peak, holiday, itemMB, ingestBytes, ingestBps, logicalDay, logicalYear, total, hot, warm, warmX, raw, rawAll3, costYear, cost3Year, meta, thumbs, dau, thumbReads, thumbPeak, egressBps, search, items };
  }

  function insights(v, r, o) {
    const out = [];
    out.push(`${fmt(o.users)} users × ${v.perUser} a day is ${fmt(o.daily)} uploads: ${fmt(o.avg, 0)} a second on average, ${fmt(o.peak, 0)} at a ${v.peak}× daily peak, and ${fmt(o.holiday, 0)} on New Year’s Day. The holiday peak sizes the upload fleet, and it is why the edge must refuse with Retry-After and clients must add jitter.`);
    out.push(`At ${o.itemMB.toFixed(1)} MB an item that is ${bytes(o.ingestBytes)} a day over the network, ${bps(o.ingestBps)} on average. Resumable uploads matter at this size: a restart from zero on a flaky network is paid again in bandwidth and battery.`);
    out.push(`Storage is the number that shapes the design: ${bytes(o.logicalYear)} of new photos a year after storage saver and dedupe, ${bytes(o.total)} over ${v.years} years. ${r.ec ? `Keeping only the last ${v.hotDays} days on three copies and erasure-coding the rest at ${o.warmX}× brings raw disk to ${bytes(o.raw)} instead of ${bytes(o.rawAll3)}: ${money(o.cost3Year - o.costYear)} a year saved at $${v.price}/TB-month.` : `With three copies of everything, raw disk is ${bytes(o.raw)} and ${money(o.costYear)} a year. Turn on erasure coding to see what moving cold photos to Reed–Solomon chunks saves.`}`);
    out.push(r.ec ? 'Erasure coding is not free. A normal read still hits the one chunk that holds the photo, but if that chunk is lost the read must fetch 10 others and rebuild it, and repairing a lost disk reads 10 times its size across the network. That is why fresh photos, which are viewed most, stay on full copies.' : 'With full copies, a lost disk is repaired by copying it once, and any copy can serve a read. It is simple and fast, and it costs 3× the bytes forever.');

    out.push(`Metadata is small next to the bytes: ${fmt(o.items)} items at about ${META_BYTES} bytes is ${bytes(o.meta)}. Shard it by user so every user’s items, change log, and quota live together and commit in one transaction.`);
    out.push(`Thumbnails are about ${bytes(o.thumbs)} on disk but dominate reads: ${fmt(o.dau)} daily users loading ${v.tiles} tiles three times a day is ${fmt(o.thumbReads, 0)} a second (${fmt(o.thumbPeak, 0)} at peak, ${bps(o.egressBps)} of egress). Serve them from a CDN and coalesce misses.`);
    out.push(`Search is light by comparison: about ${fmt(o.search, 0)} queries a second. The cost of search is labelling every upload (${fmt(o.avg, 0)} images a second) and re-labelling ${fmt(o.items)} items whenever the model changes.`);
    return out;
  }

  ui.mountGpCapacity = function (pageId) {
    const main = ui.mountShell(pageId);
    const page = SDL.page(pageId);
    const vals = Object.fromEntries(INPUTS.map((i) => [i.id, i.value]));
    const reqs = Object.fromEntries(REQS.map((i) => [i.id, i.value]));
    let avail = '99.9';
    main.innerHTML = `
      <div class="lab-head">
        <h1>${esc(page.title)}</h1>
        <p class="lede">${esc(page.summary)}</p>
        <p class="disclaimer">Back-of-the-envelope estimates for learning. The upload rate starts from Google’s 2020 figure of about 28 billion uploads a week; sizes, prices, and ratios are stated assumptions, not any company’s internals.</p>
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
          <h3 class="subhead">Availability target for browsing</h3>
          <div class="ops-traffic" role="group" aria-label="Availability">${Object.keys(AVAIL).map((a) => `<button class="btn ops-tbtn" data-avail="${a}">${a}%</button>`).join('')}</div>
        </section>
        <div class="lab-main">
          <section class="panel panel-metrics" aria-labelledby="h-load"><h2 id="h-load">Sizing <span class="sim-tag">Estimated</span></h2><dl class="metric-grid" data-ref="load"></dl></section>
          <section class="panel panel-diagram" aria-labelledby="h-srv"><h2 id="h-srv">Raw storage: three copies versus tiers</h2><div data-ref="store"></div><p class="surge-meta" data-ref="caps"></p><h3 class="subhead">Requests per second</h3><div data-ref="bars"></div></section>
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
        tile('Uploads a day', fmt(o.daily), `${fmt(o.avg, 0)}/s average, ${fmt(o.peak, 0)}/s at peak`) +
        tile('Holiday peak', `${fmt(o.holiday, 0)}/s`, 'sizes the upload fleet', 'warn') +
        tile('Ingest bandwidth', bps(o.ingestBps), `${bytes(o.ingestBytes)} a day`) +
        tile('New storage a year', bytes(o.logicalYear), 'logical, after saver and dedupe', 'warn') +
        tile('Raw disk', bytes(o.raw), `${vals.years} years, ${reqs.ec ? `hot 3×, warm ${o.warmX}×` : 'all 3×'}`, 'fail') +
        tile('Disk bill a year', money(o.costYear), `at $${vals.price}/TB-month`, 'fail') +
        tile('Metadata', bytes(o.meta), `${fmt(o.items)} items`) +
        tile('Thumbnail reads', `${fmt(o.thumbPeak, 0)}/s`, `at peak, ${bps(o.egressBps)} egress`);
      const store = { 'Three copies of everything': o.rawAll3, 'Hot 3× + warm tier': o.raw, 'Logical bytes': o.total, Thumbnails: o.thumbs, Metadata: o.meta };
      const smax = Math.max(...Object.values(store), 1);
      q('[data-ref="store"]').innerHTML = `<div class="cap-bars is-wide">${Object.entries(store).map(([k, b], i) => `<div class="cap-bar${i === 0 ? ' is-top' : ''}"><span class="cap-label">${esc(k)}</span><span class="cap-track"><i style="width:${(b / smax) * 100}%"></i></span><span class="cap-n">${bytes(b)}</span></div>`).join('')}</div>`;
      q('[data-ref="caps"]').textContent = `Erasure coding stores 14 chunks for every 10 chunks of data, so any 4 can be lost. Parity across regions brings the factor to about 2.1× (Facebook’s published f4 design), against 3× or more for full copies.`;
      const bars = { 'Uploads at peak': o.peak, 'Uploads on New Year’s Day': o.holiday, 'Thumbnail reads at peak': o.thumbPeak, 'Searches': o.search };
      const max = Math.max(...Object.values(bars), 1);
      const topBar = Object.entries(bars).sort((a, b) => b[1] - a[1])[0][0];
      q('[data-ref="bars"]').innerHTML = `<div class="cap-bars is-wide">${Object.entries(bars).map(([k, n]) => `
        <div class="cap-bar${k === topBar ? ' is-top' : ''}"><span class="cap-label">${esc(k)}</span><span class="cap-track"><i style="width:${(n / max) * 100}%"></i></span><span class="cap-n">${n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : fmt(n, 0)}/s</span></div>`).join('')}</div>`;
      q('[data-ref="insights"]').innerHTML = insights(vals, reqs, o).map((t) => `<li>${esc(t)}</li>`).join('');
      q('[data-ref="avail"]').textContent = `${avail}% allows about ${AVAIL[avail]} minutes a year when the library cannot be browsed. Durability is a separate promise: a backed-up photo must never be lost, which is about copies and repair, not uptime. Uploads can wait, because the phone keeps the original until the create commits.`;
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
