/*
 * Video platform: requirements and capacity. Two calculator pages, no
 * simulation: every control recomputes every output immediately.
 */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;
  const esc = ui.esc;
  const fmt = (n, d) => (n >= 1e12 ? (n / 1e12).toFixed(d == null ? 1 : d) + ' trillion' : n >= 1e9 ? (n / 1e9).toFixed(d == null ? 1 : d) + ' billion' : n >= 1e6 ? (n / 1e6).toFixed(d == null ? 1 : d) + ' million' : n >= 1e3 ? Math.round(n).toLocaleString('en-US') : n.toFixed(d == null ? 1 : d));

  function frame(main, page, left, right) {
    main.innerHTML = `<div class="lab-head"><h1>${esc(page.title)}</h1><p class="lede">${esc(page.summary)}</p>
      <p class="disclaimer">Back-of-the-envelope estimates for learning; every assumption is visible and adjustable. Not YouTube’s real figures.</p></div>
      <div class="cap-grid"><section class="panel panel-product">${left}</section><div class="lab-main">${right}</div></div>`;
  }
  function sliders(list) {
    return `<div class="cap-inputs">${list.map((i) => `<div class="cap-input"><label for="in-${i.id}">${esc(i.label)}</label><input type="range" id="in-${i.id}" data-in="${i.id}" min="${i.min}" max="${i.max}" step="${i.step}" value="${i.value}"><output data-out="${i.id}"></output></div>`).join('')}</div>`;
  }

  /* ---------------- requirements ---------------- */
  const FEATURES = [
    { id: 'upload', label: 'Creators upload videos', comps: ['Upload API', 'Object storage', 'Processing pipeline', 'Metadata DB'], lab: 'upload' },
    { id: 'watch', label: 'Viewers watch with adaptive quality', comps: ['CDN', 'Origin', 'Player ABR'], lab: 'streaming' },
    { id: 'engage', label: 'Likes, comments, views', comps: ['Counters', 'Event stream', 'Comments DB'], lab: 'likes' },
    { id: 'discover', label: 'Home feed and search', comps: ['Recommender', 'Search index', 'Feature store'], lab: 'feed' },
    { id: 'social', label: 'Subscriptions and notifications', comps: ['Subscription graph', 'Fan-out workers', 'Push providers'], lab: 'subscriptions' },
    { id: 'live', label: 'Live streaming with chat', comps: ['Ingest', 'Live transcoders', 'Chat fan-out'], lab: 'live' },
    { id: 'creators', label: 'Creator analytics', comps: ['Analytics pipeline', 'Data lake'], lab: 'analytics' },
  ];
  const CONSIST = [
    ['Video bytes and metadata', 'Strong at publish time', 'A public video must never point at a missing file.'],
    ['Like and view counts', 'Eventual (seconds)', 'Nobody is harmed by a count a few seconds behind; exactness would not scale.'],
    ['Your own comment', 'Read-your-writes', 'You must see your comment immediately, even if others see it a moment later.'],
    ['Subscriptions feed', 'Eventual (seconds to minutes)', 'Fan-out is asynchronous by design.'],
    ['Payments for memberships', 'Strong, exactly once', 'Money needs idempotency and a ledger.'],
  ];
  function mountReq(pageId) {
    const main = ui.mountShell(pageId);
    const page = SDL.page(pageId);
    const on = Object.fromEntries(FEATURES.map((f) => [f.id, f.id !== 'live']));
    let avail = 99.95;
    let p99 = 200;
    frame(main, page, `<h2>Functional requirements</h2><div class="cap-reqs">${FEATURES.map((f) => `<label class="check"><input type="checkbox" data-feat="${f.id}"${on[f.id] ? ' checked' : ''}> ${esc(f.label)}</label>`).join('')}</div>
      <h3 class="subhead">Availability target</h3><div class="ops-traffic">${[99.9, 99.95, 99.99].map((a) => `<button class="btn ops-tbtn" data-avail="${a}">${a}%</button>`).join('')}</div>
      <h3 class="subhead">Playback start, p99 target</h3><div class="ops-traffic">${[200, 500, 1000].map((v) => `<button class="btn ops-tbtn" data-p99="${v}">${v} ms</button>`).join('')}</div>`,
    `<section class="panel panel-diagram"><h2>Components these requirements pull in</h2><div data-ref="comps"></div></section>
     <section class="panel panel-metrics"><h2>Non-functional consequences</h2><ul class="ledger-notes" data-ref="nfr"></ul></section>
     <section class="panel panel-ledger"><h2>Consistency, chosen per feature</h2><table class="ledger"><thead><tr><th>Data</th><th>Model</th><th>Why</th></tr></thead><tbody>${CONSIST.map((c) => `<tr><td>${esc(c[0])}</td><td>${esc(c[1])}</td><td>${esc(c[2])}</td></tr>`).join('')}</tbody></table></section>`);
    const render = () => {
      main.querySelectorAll('[data-avail]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.avail === avail)));
      main.querySelectorAll('[data-p99]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.p99 === p99)));
      const chosen = FEATURES.filter((f) => on[f.id]);
      main.querySelector('[data-ref="comps"]').innerHTML = `<div class="system-cards">${chosen.map((f) => `<a class="system-card" href="${ui.href(f.lab)}"><span class="system-title">${esc(f.label)}</span><span class="system-blurb">${f.comps.map(esc).join(', ')}</span><span class="system-go">Open the lab →</span></a>`).join('') || '<p class="empty">Pick at least one requirement.</p>'}</div>`;
      const mins = { 99.9: 43.8, 99.95: 21.9, 99.99: 4.4 }[avail];
      const notes = [
        `${avail}% availability allows about ${mins} minutes of downtime a month${avail >= 99.99 ? ': failover must be automatic, and every dependency on the watch path needs a fallback.' : '.'}`,
        `A ${p99} ms p99 start time ${p99 <= 200 ? 'requires CDN edges near viewers and a cached first segment; the origin cannot be on the hot path.' : p99 <= 500 ? 'is achievable with a CDN and a fast manifest service.' : 'leaves room for origin fetches on cold videos.'}`,
        `${chosen.length} feature areas mean ${chosen.reduce((a, f) => a + f.comps.length, 0)} major components. Each one added to the watch path adds a way for playback to fail; keep optional features (comments, recommendations) off the critical path.`,
      ];
      if (on.live) notes.push('Live streaming adds a real-time path where seconds of latency matter and nothing can be recomputed later.');
      if (!on.upload) notes.push('Without uploads there is no content: every other feature depends on the upload and processing pipeline.');
      main.querySelector('[data-ref="nfr"]').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
    };
    main.addEventListener('change', (e) => { if (e.target.dataset.feat) { on[e.target.dataset.feat] = e.target.checked; render(); } });
    main.addEventListener('click', (e) => {
      const a = e.target.closest('[data-avail]'); if (a) { avail = +a.dataset.avail; render(); }
      const p = e.target.closest('[data-p99]'); if (p) { p99 = +p.dataset.p99; render(); }
    });
    render();
  }

  /* ---------------- capacity ---------------- */
  const IN = [
    { id: 'dau', label: 'Daily active viewers (million)', min: 100, max: 3000, step: 50, value: 1500 },
    { id: 'minutes', label: 'Watch minutes per viewer per day', min: 10, max: 120, step: 5, value: 45 },
    { id: 'bitrate', label: 'Average delivered bitrate (Mbps)', min: 0.5, max: 8, step: 0.5, value: 2.5 },
    { id: 'peak', label: 'Peak-to-average ratio', min: 1, max: 5, step: 0.25, value: 2 },
    { id: 'uploadHours', label: 'Hours of video uploaded per minute', min: 100, max: 1000, step: 50, value: 500 },
    { id: 'ladder', label: 'Stored rendition size vs source (%)', min: 50, max: 300, step: 10, value: 150 },
    { id: 'hit', label: 'CDN cache hit rate (%)', min: 80, max: 99.5, step: 0.5, value: 95 },
    { id: 'replicas', label: 'Storage replication factor', min: 1, max: 5, step: 1, value: 3 },
  ];
  const SCEN = { normal: ['Typical day', {}], final: ['World Cup final', { peak: 4, dau: 2200 }], hd: ['Everyone moves to 4K', { bitrate: 8 }], cdn: ['CDN hit rate drops to 85%', { hit: 85 }] };
  function mountCap(pageId) {
    const main = ui.mountShell(pageId);
    const page = SDL.page(pageId);
    const v = Object.fromEntries(IN.map((i) => [i.id, i.value]));
    frame(main, page, `<h2>Inputs</h2><div class="ops-traffic cap-scen">${Object.entries(SCEN).map(([k, s]) => `<button class="btn ops-tbtn" data-scen="${k}">${esc(s[0])}</button>`).join('')}</div>${sliders(IN)}`,
      `<section class="panel panel-metrics"><h2>Load and storage <span class="sim-tag">Estimated</span></h2><dl class="metric-grid" data-ref="out"></dl></section>
       <section class="panel panel-diagram"><h2>Where the cost goes</h2><div data-ref="bars"></div></section>
       <section class="panel panel-ledger"><h2>What these numbers say</h2><ul class="ledger-notes" data-ref="ins"></ul></section>`);
    const render = () => {
      for (const i of IN) main.querySelector(`[data-out="${i.id}"]`).textContent = String(v[i.id]);
      const watchSec = v.dau * 1e6 * v.minutes * 60;
      const avgStreams = watchSec / 86400;
      const peakStreams = avgStreams * v.peak;
      const egressTbps = (peakStreams * v.bitrate) / 1e6;
      const originTbps = egressTbps * (1 - v.hit / 100);
      const uploadHoursDay = v.uploadHours * 60 * 24;
      const sourceTB = uploadHoursDay * 3600 * 8 / 8 / 1e6; // ~8 Mbps sources → MB → TB
      const storedTBday = sourceTB * (1 + v.ladder / 100) * v.replicas;
      const storagePBy = (storedTBday * 365) / 1000;
      const transcodeCores = uploadHoursDay * 3600 * 4 / 86400; // ~4 core-seconds per second of video per ladder
      const edgeServers = Math.ceil((egressTbps * 1e6) / 40000);
      const out = [
        ['Concurrent streams at peak', fmt(peakStreams, 1)], ['CDN egress at peak', `${egressTbps.toFixed(0)} Tbps`],
        ['Origin traffic at peak', `${originTbps.toFixed(1)} Tbps`], ['Video uploaded per day', `${fmt(uploadHoursDay, 0)} hours`],
        ['New storage per day', `${fmt(storedTBday, 0)} TB`], ['Storage added per year', `${fmt(storagePBy, 0)} PB`],
        ['Transcoding cores, steady state', fmt(transcodeCores, 0)], ['Edge servers (40 Gbps each)', fmt(edgeServers, 0)],
      ];
      main.querySelector('[data-ref="out"]').innerHTML = out.map(([l, x]) => `<div class="metric"><dt>${esc(l)}</dt><dd>${esc(x)}</dd></div>`).join('');
      const costs = { 'CDN egress': egressTbps * 100, 'Storage growth': storagePBy * 0.5, 'Origin egress': originTbps * 100, 'Transcoding': transcodeCores / 200 };
      const max = Math.max(...Object.values(costs));
      const top = Object.entries(costs).sort((a, b) => b[1] - a[1])[0][0];
      main.querySelector('[data-ref="bars"]').innerHTML = `<div class="cap-bars">${Object.entries(costs).map(([k, c]) => `<div class="cap-bar${k === top ? ' is-top' : ''}"><span class="cap-label">${esc(k)}</span><span class="cap-track"><i style="width:${(c / max) * 100}%"></i></span><span class="cap-n">${Math.round((c / max) * 100)}</span></div>`).join('')}</div><p class="surge-meta">Relative cost index, largest = 100. Unit costs are illustrative.</p>`;
      main.querySelector('[data-ref="ins"]').innerHTML = [
        `Delivery dominates: ${egressTbps.toFixed(0)} Tbps at peak. Every percentage point of CDN hit rate keeps about ${(egressTbps / 100).toFixed(1)} Tbps away from the origin.`,
        `Storage only grows: about ${fmt(storagePBy, 0)} PB a year at ${v.replicas} replicas. Moving old, rarely watched renditions to cold storage is the main lever.`,
        `Uploads are small next to viewing: ${fmt(uploadHoursDay, 0)} hours a day in, versus ${fmt(watchSec / 3600, 0)} hours watched.`,
        v.peak >= 3.5 ? `A ${v.peak}× peak (a final, a launch) must be absorbed by the CDN; pre-warming popular segments before the event matters more than adding origin capacity.` : 'Peaks are moderate; the CDN absorbs them if hit rates hold.',
      ].map((t) => `<li>${esc(t)}</li>`).join('');
    };
    main.addEventListener('input', (e) => { if (e.target.dataset.in) { v[e.target.dataset.in] = +e.target.value; render(); } });
    main.addEventListener('click', (e) => {
      const s = e.target.closest('[data-scen]');
      if (!s) return;
      Object.assign(v, Object.fromEntries(IN.map((i) => [i.id, i.value])), SCEN[s.dataset.scen][1]);
      for (const i of IN) main.querySelector(`[data-in="${i.id}"]`).value = v[i.id];
      main.querySelectorAll('[data-scen]').forEach((b) => b.setAttribute('aria-pressed', String(b === s)));
      render();
    });
    render();
  }

  ui.mountCalc = (id) => (id === 'yt-requirements' ? mountReq(id) : mountCap(id));
})();
