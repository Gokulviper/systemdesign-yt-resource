/*
 * CDN and edge caching. Three regional edges cache segments; misses go to an
 * origin shield (a mid-tier cache) and then to the origin, which has real
 * capacity. A viral video is a burst of identical misses: request coalescing
 * collapses them into one upstream fetch; the shield collapses the three
 * regions' fetches into one origin fetch.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const REGIONS = { us: ['Americas', 'edgeUS', 'edgeEU'], eu: ['Europe', 'edgeEU', 'edgeUS'], as: ['Asia', 'edgeAS', 'edgeEU'] };
  const POPULAR = 40;

  function* request(ctx, region, key, mine) {
    const st = ctx.state;
    const [, edge, alt] = REGIONS[region];
    const t0 = ctx.now();
    let r = yield ctx.call(edge, 'get', { key }, { timeout: 2500, quiet: mine ? false : 'all' });
    if (!r.ok && st.config.failover && r.error.code === 'UNAVAILABLE') {
      if (mine) ctx.log({ op: `${edge} down, routed to ${alt}`, status: 'retry', detail: 'DNS steering sends this region to the next-nearest edge.' });
      r = yield ctx.call(alt, 'get', { key }, { timeout: 2500, quiet: mine ? false : 'all' });
      if (r.ok) r.value.via = alt;
    }
    ctx.sim.recordOutcome(r.ok, ctx.now() - t0);
    const rs = st.regions[region];
    rs.n++;
    if (!r.ok) { rs.errors++; st.errorTimes.push(ctx.now()); }
    else if (r.value.hit) rs.hits++;
    rs.lat.push(ctx.now() - t0);
    if (rs.lat.length > 80) rs.lat.shift();
    return r;
  }

  function startPlay(sim) {
    const st = sim.state;
    sim.startAction('Viewer (Americas): play a segment', function* (ctx) {
      Y.L(ctx, { committed: ['n/a', 'Reads only.'], async: 'n/a', retrySafe: 'yes', displayed: 'pending' });
      const key = st.traffic.viral ? `viral-${1 + (st.seq.mine++ % 6)}` : `pop-${st.seq.mine++ % POPULAR}`;
      const r = yield* request(ctx, 'us', key, true);
      const u = ctx.ui.viewer;
      if (r.ok) {
        u.last = `Segment ${key} in ${Math.round(r.latency)} ms (${r.value.hit === true ? 'edge hit' : r.value.hit === 'coalesced' ? 'waited for a fetch already in flight' : 'fetched from upstream'}${r.value.via ? `, via ${r.value.via}` : ''})`;
        u.tone = r.latency > 800 ? 'warn' : 'ok';
        Y.L(ctx, { displayed: ['yes', u.last], accepted: 'yes' });
        ctx.explain(r.value.hit === true ? 'The edge had this segment cached: it never left the region.' : r.value.hit === 'coalesced' ? 'Another viewer’s request for the same segment was already on its way upstream; this one simply waited for it instead of fetching again.' : 'Nobody nearby had requested this segment yet, so the edge fetched it from upstream and cached it for everyone after.');
      } else { u.last = `Error: ${r.error.message}`; u.tone = 'fail'; Y.failed(ctx, 'Playback error.'); }
    }, { self: 'usView' });
  }

  const sc = (SDL.scenarios.cdn = {
    id: 'cdn',
    seed: 151,
    productWidth: 600,
    intro: 'Normal traffic is almost all edge hits. Press “Viral video” and watch thousands of misses for brand-new segments: shield and coalescing decide whether the origin survives.',
    topology: {
      width: 1100, height: 560,
      nodes: [
        { id: 'usView', label: 'Viewers: Americas', sub: 'Includes your phone', kind: 'client', x: 100, y: 90, latency: 1, role: 'Viewers in the Americas.', owns: ['Nothing'] },
        { id: 'euView', label: 'Viewers: Europe', sub: 'Background load', kind: 'client', x: 100, y: 280, latency: 1, role: 'Viewers in Europe.', owns: ['Nothing'] },
        { id: 'asView', label: 'Viewers: Asia', sub: 'Background load', kind: 'client', x: 100, y: 470, latency: 1, role: 'Viewers in Asia.', owns: ['Nothing'] },
        { id: 'edgeUS', label: 'Edge: Americas', sub: 'Regional cache', kind: 'cdn', x: 370, y: 90, latency: 2, role: 'Caches segments near viewers. Coalesces concurrent misses when enabled.', ops: [{ name: 'get', desc: 'Serve or fetch a segment.' }], owns: ['Cached segments'] },
        { id: 'edgeEU', label: 'Edge: Europe', sub: 'Regional cache', kind: 'cdn', x: 370, y: 280, latency: 2, role: 'Caches segments near viewers.', ops: [{ name: 'get', desc: 'Serve or fetch a segment.' }], owns: ['Cached segments'] },
        { id: 'edgeAS', label: 'Edge: Asia', sub: 'Regional cache', kind: 'cdn', x: 370, y: 470, latency: 2, role: 'Caches segments near viewers.', ops: [{ name: 'get', desc: 'Serve or fetch a segment.' }], owns: ['Cached segments'] },
        { id: 'shield', label: 'Origin shield', sub: 'Mid-tier cache', kind: 'cache', x: 650, y: 280, latency: 3, role: 'One cache in front of the origin that every edge asks first. When off, requests pass straight through.', ops: [{ name: 'get', desc: 'Serve or fetch from origin.' }], owns: ['Cached segments'] },
        { id: 'origin', label: 'Origin', sub: 'About 60 requests/s', kind: 'service', x: 910, y: 280, latency: 5, serviceMs: 30, servers: 2, role: 'Packages and serves segments. Two workers at 30 ms each: about 66 requests per second.', ops: [{ name: 'get', desc: 'Produce a segment.' }], owns: ['Source video'] },
      ],
      edges: [
        { from: 'usView', to: 'edgeUS', latency: 20 },
        { from: 'euView', to: 'edgeEU', latency: 20 },
        { from: 'asView', to: 'edgeAS', latency: 20 },
        { from: 'usView', to: 'edgeEU', latency: 90, label: 'failover' },
        { from: 'edgeUS', to: 'shield', latency: 40 },
        { from: 'edgeEU', to: 'shield', latency: 15 },
        { from: 'edgeAS', to: 'shield', latency: 60 },
        { from: 'shield', to: 'origin', latency: 8 },
      ],
    },
    failures: [
      { id: 'edgeUS-down', node: 'edgeUS', mode: 'down', label: 'Americas edge outage', desc: 'The region’s edge stops serving.' },
      { id: 'shield-down', node: 'shield', mode: 'down', label: 'Origin shield down', desc: 'Every miss fails until it returns.' },
      { id: 'origin-slow', node: 'origin', mode: 'slow', params: { factor: 6 }, label: 'Origin slow', desc: 'Each request takes 6 times longer.' },
    ],
    switches: Y.switches([
      ['coalesce', 'Request coalescing', 'Concurrent misses for the same segment share one upstream fetch. Off: each miss fetches separately.'],
      ['shield', 'Origin shield caching', 'Edges ask one shared cache first. Off: the shield passes everything to the origin.'],
      ['failover', 'Route around a failed edge', 'Send a region to the next-nearest edge. Off: its viewers get errors.'],
    ]),
    presets: Y.presets({ coalesce: true, shield: true, failover: true }, [
      { id: 'normal', label: 'Normal day', desc: 'Popular segments are cached everywhere; nearly every request is an edge hit.', run: (s) => { s.do('traffic', { viral: false }); s.schedule(800, () => startPlay(s)); } },
      { id: 'viral', label: 'Viral video, shield and coalescing', desc: 'A brand-new video takes off worldwide. Each new segment reaches the origin once.', run: (s) => { s.do('traffic', { viral: true }); s.schedule(1500, () => startPlay(s)); s.schedule(5000, () => s.do('traffic', { viral: false })); } },
      { id: 'viral-stampede', label: 'Viral video, no coalescing', desc: 'Every concurrent miss goes upstream: a cache stampede. The origin queue explodes.', sw: { coalesce: false }, run: (s) => { s.do('traffic', { viral: true }); s.schedule(1500, () => startPlay(s)); s.schedule(5000, () => s.do('traffic', { viral: false })); } },
      { id: 'viral-noshield', label: 'Viral video, no shield', desc: 'Coalescing works per edge, but three regions each fetch every new segment from the origin: three times the origin load.', sw: { shield: false }, run: (s) => { s.do('traffic', { viral: true }); s.schedule(1500, () => startPlay(s)); s.schedule(5000, () => s.do('traffic', { viral: false })); } },
      { id: 'outage', label: 'Edge outage, failover', desc: 'The Americas edge fails; viewers are steered to Europe. Slower, but working.', run: (s) => { s.inject('edgeUS', 'down'); s.schedule(800, () => startPlay(s)); } },
      { id: 'outage-bad', label: 'Edge outage, no failover', desc: 'Americas viewers get errors until the edge returns.', sw: { failover: false }, run: (s) => { s.inject('edgeUS', 'down'); s.schedule(800, () => startPlay(s)); } },
      { id: 'purge', label: 'Purge at peak', desc: 'A wrong thumbnail forces a purge of a popular video. Every edge refills from the shield at once.', run: (s) => { s.schedule(500, () => s.do('purge', {})); s.schedule(1200, () => startPlay(s)); } },
    ]),
    initialState: () => {
      const warm = () => Object.fromEntries(Array.from({ length: POPULAR }, (_, i) => [`pop-${i}`, true]));
      const reg = () => ({ n: 0, hits: 0, errors: 0, lat: [] });
      return {
        config: { coalesce: true, shield: true, failover: true },
        cache: { edgeUS: warm(), edgeEU: warm(), edgeAS: warm(), shield: warm() },
        inflight: { edgeUS: {}, edgeEU: {}, edgeAS: {}, shield: {} },
        traffic: { viral: false }, viralKey: 0, originHits: [], errorTimes: [],
        regions: { us: reg(), eu: reg(), as: reg() }, seq: { mine: 0, req: 0 },
      };
    },
    initialUI: () => ({ viewer: { last: 'Tap Play to request a segment from the Americas edge.', tone: '' } }),
    actions: {
      play(sim) { startPlay(sim); },
      traffic(sim, a) { sim.state.traffic.viral = a.viral; if (a.viral) sim.state.viralStart = sim.now; sim.note(a.viral ? 'A new video goes viral worldwide: about 200 requests per second per region for segments nobody has cached.' : 'Traffic back to normal.'); },
      purge(sim) { const st = sim.state; for (const c of Object.values(st.cache)) for (const k of Object.keys(c)) if (k.startsWith('pop-')) delete c[k]; sim.note('Purged every cached copy of the popular video from every edge and the shield.'); },
      set: Y.setAction,
    },
    handlers: {
      edgeUS: cacheHandlers('edgeUS', 'shield'),
      edgeEU: cacheHandlers('edgeEU', 'shield'),
      edgeAS: cacheHandlers('edgeAS', 'shield'),
      shield: cacheHandlers('shield', 'origin'),
      origin: { get(ctx) { ctx.state.originHits.push(ctx.now()); return { bytes: 1 }; } },
    },
    setup(sim) {
      for (const [region, [, , ]] of Object.entries(REGIONS)) {
        const self = { us: 'usView', eu: 'euView', as: 'asView' }[region];
        Y.load(sim, self, (s) => (s.state.traffic.viral ? 200 : 12), function* (ctx) {
          const st = ctx.state;
          const n = ++st.seq.req;
          let key;
          if (st.traffic.viral) {
            // A new video: segments are requested in order as viewers progress through it.
            const elapsed = ctx.now() - st.viralStart;
            const head = 1 + Math.floor(elapsed / 300);
            key = `viral-${Math.max(1, head - (n % 3))}`;
          } else key = `pop-${n % POPULAR}`;
          yield* request(ctx, region, key, false);
        });
      }
    },
    consistency(sim) {
      const st = sim.state;
      const recentErr = st.errorTimes.filter((t) => sim.now - t < 1500).length;
      if (recentErr) return { key: 'wrong', label: `${recentErr} viewer requests failed in the last 1.5 s.` };
      const w = sim.queueWait('origin');
      if (w > 400) return { key: 'stale', label: `The origin is overloaded: new requests wait ${SDL.fmtMs(w)} before being served.` };
      return { key: 'ok', label: 'Viewers are served, and the origin is within capacity.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const ors = st.originHits.filter((t) => sim.now - t < 1000).length;
      const hit = (r) => (st.regions[r].n ? `${Math.round((st.regions[r].hits / st.regions[r].n) * 100)}%` : 'n/a');
      const w = sim.queueWait('origin');
      return [
        { label: 'Origin requests per second', value: ors, tone: ors > 60 ? 'fail' : ors > 30 ? 'warn' : 'ok' },
        { label: 'Origin queue', value: SDL.fmtMs(w), tone: w > 400 ? 'fail' : w > 80 ? 'warn' : 'ok' },
        { label: 'Hit rate: Americas', value: hit('us') },
        { label: 'Hit rate: Europe', value: hit('eu') },
        { label: 'Hit rate: Asia', value: hit('as') },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['usView', 'Your phone (Americas)']], {
          note: 'The console shows each region’s cache hit rate and latency, and how busy the origin is.',
          side: `<p class="ops-title">Edges</p><div class="ops-traffic"><button class="btn ops-tbtn" data-act="traffic" data-arg='{"viral":true}' data-k="viral">Viral video</button><button class="btn ops-tbtn" data-act="traffic" data-arg='{"viral":false}' data-k="normal">Normal</button><button class="btn ops-tbtn" data-act="purge">Purge popular video</button></div><div class="ops-shards" data-ref="regions"></div>`,
        });
      },
      render(el, sim) {
        const st = sim.state;
        el.querySelectorAll('[data-k]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.k === 'viral') === st.traffic.viral)));
        const u = sim.ui.viewer;
        Y.paint(el, sim, 'usView', { head: '<div><p class="app-title">YouTube</p></div>', body: `${Y.video(st.traffic.viral ? 'NEW: everyone is watching this' : 'Weekly systems roundup', 'Distributed Daily', '', st.traffic.viral ? 10 : 260)}${Y.btn('play', 'Play next segment')}${Y.msg(u.last, u.tone)}` }, {});
        const rows = Object.entries(REGIONS).map(([r, [label, edge]]) => `<div class="ops-row" data-region="${r}"><div class="ops-name"><strong>${label}</strong><span data-live="h-${r}"></span></div><div class="ops-bar"><i data-live-width="w-${r}"></i></div><span class="ops-val" data-live="v-${r}"></span></div>`).join('')
          + '<div class="ops-row" data-region="origin"><div class="ops-name"><strong>Origin</strong><span data-live="h-o"></span></div><div class="ops-bar"><i data-live-width="w-o"></i></div><span class="ops-val" data-live="v-o"></span></div>';
        const live = {};
        for (const r of Object.keys(REGIONS)) {
          const s = st.regions[r];
          const p95 = SDL.percentile(s.lat.slice().sort((a, b) => a - b), 95) || 0;
          live[`h-${r}`] = s.n ? `${Math.round((s.hits / s.n) * 100)}% hits` : '';
          live[`w-${r}`] = `${Math.min(100, p95 / 20)}%`;
          live[`v-${r}`] = `${Math.round(p95)} ms p95${sim.nodes[REGIONS[r][1]].modes.down ? ', edge down' : ''}`;
        }
        const ors = st.originHits.filter((t) => sim.now - t < 1000).length;
        live['h-o'] = `${ors} requests/s`;
        live['w-o'] = `${Math.min(100, sim.queueWait('origin') / 20)}%`;
        live['v-o'] = `${Math.round(sim.queueWait('origin'))} ms queue`;
        const box = el.querySelector('[data-ref="regions"]');
        SDL.ui.paintSections(box, { rows }, live);
        box.querySelectorAll('.ops-row').forEach((row) => {
          const r = row.dataset.region;
          if (r === 'origin') { const w = sim.queueWait('origin'); row.dataset.tone = w > 400 ? 'fail' : w > 80 ? 'warn' : 'ok'; return; }
          const s = st.regions[r];
          const p95 = SDL.percentile(s.lat.slice().sort((a, b) => a - b), 95) || 0;
          row.dataset.tone = sim.nodes[REGIONS[r][1]].modes.down ? 'fail' : p95 > 800 ? 'fail' : p95 > 250 ? 'warn' : 'ok';
        });
      },
    },
  });

  function cacheHandlers(id, upstream) {
    return {
      get: function* (ctx, p) {
        const st = ctx.state;
        const isShield = id === 'shield';
        const cache = st.cache[id];
        if (!(isShield && !st.config.shield) && cache[p.key]) { if (!isShield) ctx.count('cacheHit'); return { hit: true }; }
        if (!isShield) ctx.count('cacheMiss');
        const inflight = st.inflight[id];
        if (st.config.coalesce && inflight[p.key]) {
          const t0 = ctx.now();
          while (inflight[p.key] && ctx.now() - t0 < 2200) yield ctx.wait(20);
          if (cache[p.key]) return { hit: 'coalesced' };
        }
        inflight[p.key] = true;
        const r = yield ctx.call(upstream, 'get', p, { timeout: 2200 });
        delete inflight[p.key];
        ctx.must(r);
        if (!(isShield && !st.config.shield)) cache[p.key] = true;
        return { hit: false };
      },
    };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
