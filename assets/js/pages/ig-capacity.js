/*
 * Photo sharing: requirements and capacity.
 * A live back-of-the-envelope calculator. Every input recomputes every output;
 * per-server capacities are stated assumptions, not measurements. The number
 * that shapes this design is write amplification: one post becomes one
 * feed-cache write per follower, and one celebrity post becomes tens of
 * millions of them.
 */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;
  const esc = ui.esc;

  const INPUTS = [
    { id: 'dau', label: 'Daily active users', unit: 'million', min: 10, max: 2000, step: 10, value: 500 },
    { id: 'posts', label: 'Posts per user per day', unit: '', min: 0.05, max: 2, step: 0.05, value: 0.2 },
    { id: 'followers', label: 'Average followers per account', unit: '', min: 20, max: 2000, step: 10, value: 200 },
    { id: 'inactive', label: 'Followers inactive for 30 days', unit: '%', min: 0, max: 90, step: 5, value: 50 },
    { id: 'celeb', label: 'Followers of the biggest account', unit: 'million', min: 1, max: 600, step: 1, value: 50 },
    { id: 'feeds', label: 'Feed opens per user per day', unit: '', min: 1, max: 40, step: 1, value: 10 },
    { id: 'stories', label: 'Stories per user per day', unit: '', min: 0, max: 5, step: 0.1, value: 1 },
    { id: 'dms', label: 'Messages per user per day', unit: '', min: 0, max: 50, step: 1, value: 4 },
    { id: 'media', label: 'Stored bytes per post (all renditions)', unit: 'MB', min: 0.5, max: 20, step: 0.5, value: 4 },
    { id: 'image', label: 'Bytes per image served', unit: 'KB', min: 50, max: 1000, step: 50, value: 200 },
    { id: 'peak', label: 'Peak-to-average ratio', unit: '×', min: 1, max: 10, step: 0.5, value: 3 },
  ];
  const REQS = [
    { id: 'hybrid', label: 'Hybrid fan-out: pull accounts over 1 million followers', value: true },
    { id: 'skip', label: 'Skip inactive followers during fan-out', value: false },
    { id: 'cdn', label: 'Serve images from a CDN', value: true },
    { id: 'expire', label: 'Delete Stories media after 24 hours', value: true },
  ];
  const CAP = {
    api: { label: 'API servers', per: 5000, unit: 'requests/s each' },
    feedcache: { label: 'Feed cache nodes', per: 100000, unit: 'operations/s each' },
    fanout: { label: 'Fan-out workers', per: 20000, unit: 'cache writes/s each' },
    posts: { label: 'Posts DB shards', per: 3000, unit: 'writes/s each' },
    ws: { label: 'Messaging gateways', per: 100000, unit: 'open connections each' },
    origin: { label: 'Media origin servers', per: 10, unit: 'Gbps each' },
  };
  const SCENARIOS = {
    normal: { label: 'Normal day', set: { dau: 500, posts: 0.2, celeb: 50, peak: 3 } },
    newyear: { label: 'New Year’s Eve', set: { dau: 700, posts: 0.6, celeb: 50, peak: 6 } },
    mega: { label: 'Biggest account posts', set: { dau: 500, posts: 0.2, celeb: 600, peak: 3 } },
  };
  const AVAIL = { '99.9': 43.8, '99.95': 21.9, '99.99': 4.4 };

  function fmt(n, d) {
    if (n >= 1e12) return (n / 1e12).toFixed(d == null ? 1 : d) + ' trillion';
    if (n >= 1e9) return (n / 1e9).toFixed(d == null ? 1 : d) + ' billion';
    if (n >= 1e6) return (n / 1e6).toFixed(d == null ? 1 : d) + ' million';
    if (n >= 100) return Math.round(n).toLocaleString('en-US');
    return n.toFixed(d == null ? 1 : d);
  }

  function compute(v, r) {
    const users = v.dau * 1e6;
    const day = 86400;
    const peak = (perDay) => (perDay / day) * v.peak;
    const postsDay = users * v.posts;
    const postRps = peak(postsDay);
    const feedRps = peak(users * v.feeds);
    const active = r.skip ? 1 - v.inactive / 100 : 1;
    const fanWrites = postRps * v.followers * active;
    const celebWrites = v.celeb * 1e6 * active;
    const celebSeconds = r.hybrid ? 0 : celebWrites / (CAP.fanout.per * 50); // 50 workers' worth before scaling
    const storiesDay = users * v.stories;
    const storyRps = peak(storiesDay);
    const dmRps = peak(users * v.dms);
    const sockets = users * 0.12;
    const mediaTBday = (postsDay * v.media * 1e6) / 1e12;
    const storyTBday = (storiesDay * v.media * 0.5 * 1e6) / 1e12;
    const mediaPBYear = (mediaTBday * 365 + (r.expire ? storyTBday : storyTBday * 365)) / 1000;
    const imagesPerFeed = 8;
    const egressGbps = (feedRps * imagesPerFeed * v.image * 1000 * 8) / 1e9;
    const originGbps = r.cdn ? egressGbps * 0.05 : egressGbps;
    const servers = {
      api: Math.ceil((feedRps + postRps * 3 + dmRps + storyRps) / CAP.api.per),
      feedcache: Math.ceil((feedRps + fanWrites) / CAP.feedcache.per),
      fanout: Math.ceil(fanWrites / CAP.fanout.per),
      posts: Math.ceil((postRps * 2) / CAP.posts.per),
      ws: Math.ceil(sockets / CAP.ws.per),
      origin: Math.ceil(originGbps / CAP.origin.per),
    };
    return { postsDay, postRps, feedRps, fanWrites, celebWrites, celebSeconds, storyRps, dmRps, sockets, mediaTBday, mediaPBYear, egressGbps, originGbps, servers, ratio: feedRps / postRps, amplification: v.followers * active };
  }

  function insights(v, r, o) {
    const out = [];
    out.push(`Every post becomes about ${fmt(o.amplification, 0)} feed-cache writes${r.skip ? ` (${fmt(v.followers, 0)} followers, inactive ones skipped)` : ''}: ${fmt(o.postRps, 0)} posts a second turn into ${fmt(o.fanWrites)} cache writes a second. Write amplification, not post volume, sizes the fan-out tier.`);
    out.push(r.hybrid
      ? `The biggest account has ${fmt(v.celeb * 1e6)} followers. Under hybrid fan-out its post is written once to a celebrity cache and pulled at read time, so it costs nothing extra at write time.`
      : `The biggest account has ${fmt(v.celeb * 1e6)} followers. Fanning one post out on write means ${fmt(o.celebWrites)} cache writes: about ${o.celebSeconds.toFixed(0)} s of work for fifty workers, during which every ordinary post queues behind it. This is the celebrity problem; hybrid fan-out is the standard answer.`);
    out.push(`Feeds are opened ${fmt(o.ratio, 0)} times for every post created. The read path (one cache lookup, one ranking call) must be fast; the write path can be asynchronous.`);
    out.push(r.cdn
      ? `Feed images move ${fmt(o.egressGbps)} Gbps at peak. The CDN serves about 95%, leaving ${fmt(o.originGbps)} Gbps for the origin.`
      : `Without a CDN, ${fmt(o.egressGbps)} Gbps of images leave your own servers at peak. Bandwidth, not compute, becomes the biggest bill.`);
    out.push(`Media grows by about ${fmt(o.mediaTBday, 0)} TB a day for posts${r.expire ? '; Stories media is deleted after 24 hours' : `, plus Stories kept for ever`}: roughly ${fmt(o.mediaPBYear, 0)} PB a year. Hot storage for the last few weeks, cold storage for the rest.`);
    out.push(`${fmt(o.dmRps)} messages a second over about ${fmt(o.sockets)} open connections. Messages need ordering within a thread and exactly-once display; sockets need a connection registry and reconnect backoff (see the messaging lab).`);
    if (v.peak >= 5) out.push(`A ${v.peak}× peak (New Year’s Eve, a World Cup final) is planned for: pre-scale the fan-out and cache tiers, and shed ranking first (chronological fallback) before shedding reads.`);
    return out;
  }

  ui.mountIgCapacity = function (pageId) {
    const main = ui.mountShell(pageId);
    const page = SDL.page(pageId);
    const vals = Object.fromEntries(INPUTS.map((i) => [i.id, i.value]));
    const reqs = Object.fromEntries(REQS.map((i) => [i.id, i.value]));
    let avail = '99.99';
    main.innerHTML = `
      <div class="lab-head">
        <h1>${esc(page.title)}</h1>
        <p class="lede">${esc(page.summary)}</p>
        <p class="disclaimer">Back-of-the-envelope estimates for learning, not Instagram’s figures. Per-server capacities are stated assumptions; real numbers depend on hardware, payload, and software.</p>
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
      const tile = (label, value, hint, tone) => `<div class="metric"${tone ? ` data-tone="${tone}"` : ''}><dt>${esc(label)}</dt><dd>${esc(value)}</dd>${hint ? `<p class="metric-hint">${esc(hint)}</p>` : ''}</div>`;
      const hot = !reqs.hybrid;
      q('[data-ref="load"]').innerHTML =
        tile('Feed opens per second', fmt(o.feedRps)) +
        tile('Posts per second', fmt(o.postRps), `${fmt(o.postsDay)} a day`) +
        tile('Feed-cache writes per second', fmt(o.fanWrites), `${fmt(o.amplification, 0)}× amplification`, 'warn') +
        tile('One celebrity post', `${fmt(o.celebWrites)} writes`, hot ? `✕ about ${o.celebSeconds.toFixed(0)} s of fan-out` : '✓ pulled at read time instead', hot ? 'fail' : 'ok') +
        tile('Stories per second', fmt(o.storyRps)) +
        tile('Messages per second', fmt(o.dmRps), `${fmt(o.sockets)} open connections`) +
        tile('CDN egress at peak', `${fmt(o.egressGbps)} Gbps`, reqs.cdn ? `origin ${fmt(o.originGbps)} Gbps` : 'no CDN: all from origin') +
        tile('New media per day', `${fmt(o.mediaTBday, 0)} TB`, `about ${fmt(o.mediaPBYear, 0)} PB a year`);
      const max = Math.max(...Object.values(o.servers), 1);
      const top = Object.entries(o.servers).sort((a, b) => b[1] - a[1])[0][0];
      q('[data-ref="bars"]').innerHTML = `<div class="cap-bars">${Object.entries(o.servers).map(([k, n]) => `
        <div class="cap-bar${k === top ? ' is-top' : ''}"><span class="cap-label">${esc(CAP[k].label)}</span><span class="cap-track"><i style="width:${(n / max) * 100}%"></i></span><span class="cap-n">${n}</span></div>`).join('')}</div>`;
      q('[data-ref="caps"]').textContent = 'Assumed capacity: ' + Object.values(CAP).map((c) => `${c.label.toLowerCase()} ${c.per.toLocaleString('en-US')} ${c.unit}`).join('; ') + '. Workers do not fix a celebrity: one post still means one write per follower however many machines run.';
      q('[data-ref="insights"]').innerHTML = insights(vals, reqs, o).map((t) => `<li>${esc(t)}</li>`).join('');
      q('[data-ref="avail"]').textContent = `${avail}% availability allows about ${AVAIL[avail]} minutes of downtime per month${avail === '99.99' ? ': too little for manual recovery, so feed and messaging failover must be automatic.' : avail === '99.9' ? '. A noticeable outage every month.' : ', roughly one short incident.'}`;
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
})();
