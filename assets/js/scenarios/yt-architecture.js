/*
 * High-level architecture. The whole platform on one diagram: the watch path
 * (global load balancer, regional API, metadata, CDN) and the upload path
 * (upload API, object storage, processing, metadata primary). Two regions;
 * the metadata primary lives in region A with a read replica in region B.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  function region(sim) { const st = sim.state; return st.config.failover && sim.nodes.apiA.modes.down ? 'B' : 'A'; }
  function startWatch(sim) {
    sim.startAction('Viewer: watch a video', function* (ctx) {
      Y.L(ctx, { committed: ['n/a', 'Watching is reads.'], async: 'n/a', retrySafe: 'yes', displayed: 'pending' });
      const r = yield ctx.call('glb', 'watch', {}, { timeout: 1500 });
      if (!r.ok) { ctx.ui.viewer.msg = `Error: ${r.error.message}`; Y.failed(ctx, 'Shows an error.'); return; }
      const seg = yield ctx.call('cdn', 'segment', {}, { timeout: 1500 });
      ctx.ui.viewer.msg = seg.ok ? `Playing, served by region ${r.value.region}${seg.value.hit ? ' and a CDN cache hit' : ' and the origin'}.` : 'Video data unavailable.';
      Y.L(ctx, { displayed: seg.ok ? 'yes' : 'no', accepted: 'yes' });
      ctx.explain(`The global load balancer sent the viewer to region ${r.value.region}. Its API read the video’s metadata from ${r.value.region === 'A' ? 'the primary' : 'the region B replica'}, then the player fetched segments from the CDN${seg.ok && seg.value.hit ? ' without touching storage' : ''}.`);
    }, { self: 'viewer' });
  }
  function startUpload(sim) {
    sim.startAction('Creator: upload a video', function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'Uploads are resumable sessions.'] });
      const r = yield ctx.call('glb', 'upload', {}, { timeout: 2500 });
      ctx.ui.creator.msg = r.ok ? 'Uploaded; processing.' : `Upload unavailable: ${r.error.message}`;
      if (r.ok) Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', 'File stored and metadata written to the primary.'], async: ['pending', 'Processing.'] });
      else { Y.failed(ctx); ctx.explain(r.error.code === 'READ_ONLY' ? 'Region A, home of the metadata primary, is down. Region B can serve reads from its replica but cannot accept writes, so uploads pause until A returns or the replica is promoted. This is a deliberate trade-off: no split-brain.' : `The upload failed with ${r.error.code}.`); }
    }, { self: 'creator' });
  }

  const sc = (SDL.scenarios['yt-architecture'] = {
    id: 'yt-architecture',
    seed: 223,
    productWidth: 560,
    intro: 'Watch a video and upload one: the two paths share almost nothing. Then take region A down and see which path survives.',
    topology: {
      width: 1100, height: 540,
      nodes: [
        { id: 'viewer', label: 'Viewer', sub: 'Watch path', kind: 'client', x: 90, y: 110, latency: 1, role: 'Watches videos.', owns: ['Nothing'] },
        { id: 'creator', label: 'Creator', sub: 'Upload path', kind: 'client', x: 90, y: 430, latency: 1, role: 'Uploads videos.', owns: ['Nothing'] },
        { id: 'glb', label: 'Global load balancer', sub: 'DNS + anycast', kind: 'gateway', x: 300, y: 270, latency: 3, role: 'Routes each request to a healthy region.', ops: [{ name: 'watch', desc: 'Route a watch request.' }, { name: 'upload', desc: 'Route an upload.' }], owns: ['Region health'] },
        { id: 'apiA', label: 'API, region A', sub: 'Primary region', kind: 'service', x: 520, y: 150, latency: 4, role: 'Watch and upload APIs in region A.', ops: [{ name: 'watch', desc: 'Resolve a video.' }, { name: 'upload', desc: 'Accept an upload.' }], owns: ['Nothing durable'] },
        { id: 'apiB', label: 'API, region B', sub: 'Secondary region', kind: 'service', x: 520, y: 390, latency: 4, role: 'The same APIs in region B.', ops: [{ name: 'watch', desc: 'Resolve a video.' }, { name: 'upload', desc: 'Accept an upload.' }], owns: ['Nothing durable'] },
        { id: 'metaA', label: 'Metadata primary', sub: 'Region A', kind: 'db', x: 760, y: 150, latency: 8, role: 'All metadata writes.', ops: [{ name: 'get', desc: 'Read.' }, { name: 'put', desc: 'Write.' }], owns: ['videos (authoritative)'] },
        { id: 'metaB', label: 'Metadata replica', sub: 'Region B', kind: 'db', x: 760, y: 390, latency: 6, role: 'Read-only copy in region B.', ops: [{ name: 'get', desc: 'Read.' }], owns: ['videos (copy)'] },
        { id: 'storage', label: 'Object storage', sub: 'Multi-region', kind: 'store', x: 980, y: 270, latency: 12, role: 'Video files, replicated across regions.', ops: [{ name: 'put', desc: 'Store a file.' }, { name: 'get', desc: 'Read a segment.' }], owns: ['video files'] },
        { id: 'cdn', label: 'CDN', sub: 'Edges worldwide', kind: 'cdn', x: 300, y: 60, latency: 3, role: 'Serves video bytes near viewers; misses go to storage.', ops: [{ name: 'segment', desc: 'Serve a segment.' }], owns: ['Cached segments'] },
        { id: 'pipeline', label: 'Processing', sub: 'Transcoding', kind: 'worker', x: 980, y: 470, latency: 6, role: 'Transcodes uploads (see the processing lab).', ops: [{ name: 'run', desc: 'Process an upload.' }], owns: ['Jobs'] },
      ],
      edges: [
        { from: 'viewer', to: 'glb', latency: 25 }, { from: 'creator', to: 'glb', latency: 25 }, { from: 'viewer', to: 'cdn', latency: 20, label: 'video bytes' },
        { from: 'glb', to: 'apiA', latency: 8 }, { from: 'glb', to: 'apiB', latency: 12 },
        { from: 'apiA', to: 'metaA', latency: 3 }, { from: 'apiB', to: 'metaB', latency: 3 }, { from: 'apiB', to: 'metaA', latency: 40, label: 'cross-region writes' },
        { from: 'metaA', to: 'metaB', latency: 40, label: 'replication' },
        { from: 'apiA', to: 'storage', latency: 8 }, { from: 'apiB', to: 'storage', latency: 10 },
        { from: 'cdn', to: 'storage', latency: 30, via: [[980, 60]] }, { from: 'storage', to: 'pipeline', latency: 6 },
      ],
    },
    failures: [
      { id: 'regionA', node: 'apiA', mode: 'down', label: 'Region A outage (API)', desc: 'Use with the metadata failure for a full regional outage.' },
      { id: 'metaA', node: 'metaA', mode: 'down', label: 'Region A outage (metadata primary)', desc: 'Writes cannot be accepted anywhere.' },
      { id: 'cdn-down', node: 'cdn', mode: 'down', label: 'CDN outage', desc: 'Video bytes must come from somewhere else.' },
    ],
    switches: Y.switches([
      ['failover', 'Regional failover', 'Route traffic to region B when region A is unhealthy. Off: region A users get errors.'],
      ['cdn', 'Serve video through the CDN', 'Off: every segment comes from object storage.'],
    ]),
    presets: Y.presets({ failover: true, cdn: true }, [
      { id: 'watch', label: 'Watch path', desc: 'Load balancer, regional API, metadata, then bytes from the CDN.', run: (s) => startWatch(s) },
      { id: 'upload', label: 'Upload path', desc: 'Regional API, object storage, metadata primary, processing.', run: (s) => startUpload(s) },
      { id: 'outage', label: 'Region A outage, failover', desc: 'Viewers are served from region B’s replica; uploads pause because the primary is in A.', run: (s) => { s.inject('apiA', 'down'); s.inject('metaA', 'down'); startWatch(s); s.schedule(600, () => startUpload(s)); } },
      { id: 'outage-bad', label: 'Region A outage, no failover', desc: 'The load balancer keeps sending people to a dead region.', sw: { failover: false }, run: (s) => { s.inject('apiA', 'down'); s.inject('metaA', 'down'); startWatch(s); } },
    ]),
    initialState: () => ({ config: { failover: true, cdn: true }, cached: false, errors: 0, readOnly: false }),
    initialUI: () => ({ viewer: { msg: 'Tap Watch.' }, creator: { msg: 'Tap Upload.' } }),
    actions: { watch(sim) { startWatch(sim); }, upload(sim) { startUpload(sim); }, set: Y.setAction },
    handlers: {
      glb: {
        watch: function* (ctx) { const rg = region(ctx.sim); const r = yield ctx.call(rg === 'A' ? 'apiA' : 'apiB', 'watch', {}, { timeout: 1200 }); if (!r.ok) ctx.state.errors++; return Object.assign({ region: rg }, ctx.must(r)); },
        upload: function* (ctx) { const rg = region(ctx.sim); const r = yield ctx.call(rg === 'A' ? 'apiA' : 'apiB', 'upload', {}, { timeout: 2200 }); if (!r.ok && r.error.code === 'READ_ONLY') ctx.state.readOnly = true; return ctx.must(r); },
      },
      apiA: { watch: function* (ctx) { return ctx.must(yield ctx.call('metaA', 'get', {}, { timeout: 600 })); }, upload: function* (ctx) { ctx.must(yield ctx.call('storage', 'put', {}, { timeout: 800 })); return ctx.must(yield ctx.call('metaA', 'put', {}, { timeout: 600 })); } },
      apiB: {
        watch: function* (ctx) { return ctx.must(yield ctx.call('metaB', 'get', {}, { timeout: 600 })); },
        upload: function* (ctx) { ctx.must(yield ctx.call('storage', 'put', {}, { timeout: 800 })); const w = yield ctx.call('metaA', 'put', {}, { timeout: 600 }); if (!w.ok) ctx.fail('READ_ONLY', 'Metadata primary unreachable; region B is read-only.'); return w.value; },
      },
      metaA: { get() { return { ok: true }; }, put() { return { ok: true }; } },
      metaB: { get() { return { ok: true }; } },
      storage: { put() { return { ok: true }; }, get() { return { ok: true }; } },
      cdn: {
        segment: function* (ctx) {
          const st = ctx.state;
          if (st.config.cdn && st.cached) return { hit: true };
          ctx.must(yield ctx.call('storage', 'get', {}, { timeout: 1000 }));
          if (st.config.cdn) st.cached = true;
          return { hit: false };
        },
      },
    },
    consistency(sim) {
      const st = sim.state;
      if (st.errors) return { key: 'wrong', label: 'Viewers got errors: traffic kept going to a failed region.' };
      if (st.readOnly) return { key: 'stale', label: 'Watching works from region B, but uploads are paused until the metadata primary is back (or promoted).' };
      return { key: 'ok', label: 'Both paths are healthy.' };
    },
    metrics(snap, sim) { return [{ label: 'Serving region', value: region(sim) }, { label: 'Viewer errors', value: sim.state.errors, tone: sim.state.errors ? 'fail' : '' }]; },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['viewer', 'Viewer'], ['creator', 'Creator']], { note: 'The watch path and the upload path share only the load balancer and storage.' }); },
      render(el, sim) {
        Y.paint(el, sim, 'viewer', { head: '<div><p class="app-title">YouTube</p></div>', body: `${Y.btn('watch', 'Watch a video')}${Y.msg(sim.ui.viewer.msg)}` }, {});
        Y.paint(el, sim, 'creator', { head: '<div><p class="app-title">YouTube Studio</p></div>', body: `${Y.btn('upload', 'Upload a video')}${Y.msg(sim.ui.creator.msg)}` }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
