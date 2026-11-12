/*
 * Video metadata and storage. Bytes live in object storage; facts live in the
 * metadata database. Publishing must keep them in step: write objects before
 * the metadata that points at them, verify before going public, and clean up
 * orphans and abandoned multipart uploads.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const RENDS = [['480p', 180], ['720p', 380], ['1080p', 640]];
  const GRACE = 3000;

  function startPublish(sim) {
    const st = sim.state;
    const vid = 'vid-' + ++st.seq.video;
    sim.startAction(`Creator: publish ${vid}`, function* (ctx) {
      const u = ctx.ui.creator;
      u.busy = true;
      u.message = 'Publishing…';
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'Object writes and the metadata row are keyed by video ID.'] });
      const r = yield ctx.call('publish', 'publish', { vid }, { timeout: 6000 });
      u.busy = false;
      if (r.ok) {
        u.message = r.value.status === 'public' ? `${vid} is public.` : `${vid} is saved but not public yet: ${r.value.reason}.`;
        u.tone = r.value.status === 'public' ? 'ok' : 'warn';
        u.last = vid;
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', r.value.status === 'public' ? 'Metadata says public.' : 'Metadata saved, held back from public.'], async: 'n/a' });
        ctx.explain(r.value.status === 'public'
          ? (r.value.missing.length ? `The video went public while ${r.value.missing.join(', ')} was missing from object storage. Viewers who pick that quality get an error.` : 'Every rendition was stored, then the metadata row marked the video public.')
          : `The publish gate checked object storage before going public and found ${r.value.missing.join(', ')} missing, so the video stays private until it is there.`);
      } else {
        u.message = `Publish failed: ${r.error.message}`;
        u.tone = 'fail';
        Y.failed(ctx, 'Shows an error; the creator can retry.');
        ctx.explain(`Publishing failed with ${r.error.code}. ${st.config.objectsFirst ? 'Objects were written first, so no metadata points at anything missing. Any objects already written are now orphans for the cleanup job.' : ''}`);
      }
    }, { self: 'creator' });
  }
  function startWatch(sim) {
    const vid = sim.ui.creator.last || Object.keys(sim.state.videos).slice(-1)[0];
    sim.startAction(`Viewer: watch ${vid || 'a video'} in 1080p`, function* (ctx) {
      const v = ctx.ui.viewer;
      Y.L(ctx, { committed: ['n/a', 'Watching is a read.'], async: 'n/a', retrySafe: 'yes' });
      const r = yield ctx.call('watch', 'play', { vid, quality: '1080p' }, { timeout: 1500 });
      if (r.ok) { v.result = `Playing ${vid} in 1080p.`; v.tone = 'ok'; Y.L(ctx, { displayed: 'yes', accepted: 'yes' }); }
      else { v.result = r.error.code === 'NOT_FOUND' ? `Error: ${vid} is listed but its 1080p file does not exist.` : `Can’t play: ${r.error.message}`; v.tone = 'fail'; ctx.state.broken += r.error.code === 'NOT_FOUND' ? 1 : 0; Y.failed(ctx, 'Shows a playback error.'); }
    }, { self: 'viewer' });
  }

  const sc = (SDL.scenarios.storage = {
    id: 'storage',
    seed: 139,
    productWidth: 560,
    intro: 'Publish a video from the creator phone, then watch it from the viewer phone. Then break object storage or the metadata database mid-publish and compare the write orders.',
    topology: {
      width: 1100, height: 520,
      nodes: [
        { id: 'creator', label: 'Creator app', sub: 'Publishes', kind: 'client', x: 100, y: 90, latency: 1, role: 'Publishes processed videos.', owns: ['Nothing'] },
        { id: 'viewer', label: 'Viewer app', sub: 'Watches', kind: 'client', x: 100, y: 420, latency: 1, role: 'Plays videos the metadata lists as public.', owns: ['Nothing'] },
        { id: 'publish', label: 'Publishing service', sub: 'Objects + metadata', kind: 'service', x: 320, y: 90, latency: 4, role: 'Writes rendition files and the metadata row in the configured order, and runs the publish gate.', ops: [{ name: 'publish', desc: 'Store renditions and metadata.' }], owns: ['Publish rules'] },
        { id: 'metadb', label: 'Video metadata', sub: 'Facts about videos', kind: 'db', x: 560, y: 90, latency: 8, role: 'Title, status, and the list of renditions that should exist.', ops: [{ name: 'upsert', desc: 'Write a video row.' }, { name: 'get', desc: 'Read a video.' }], owns: ['videos'] },
        { id: 'objstore', label: 'Object storage', sub: 'Video bytes', kind: 'store', x: 560, y: 300, latency: 14, role: 'Rendition files and in-progress multipart uploads, billed by size.', ops: [{ name: 'put', desc: 'Store a file.' }, { name: 'head', desc: 'Does it exist?' }], owns: ['objects', 'multipart uploads'] },
        { id: 'watch', label: 'Watch API', sub: 'Playback lookups', kind: 'service', x: 320, y: 420, latency: 3, role: 'Looks up a public video and fetches the requested rendition.', ops: [{ name: 'play', desc: 'Resolve and fetch.' }], owns: ['Nothing'] },
        { id: 'gc', label: 'Cleanup job', sub: 'Lifecycle rules', kind: 'worker', x: 800, y: 300, latency: 4, role: 'Deletes objects no metadata references and aborts multipart uploads idle for too long.', ops: [{ name: 'sweep', desc: 'Find and delete waste.' }], owns: ['Lifecycle rules'] },
      ],
      edges: [
        { from: 'creator', to: 'publish', latency: 30 },
        { from: 'publish', to: 'metadb', latency: 4 },
        { from: 'publish', to: 'objstore', latency: 6 },
        { from: 'viewer', to: 'watch', latency: 30 },
        { from: 'watch', to: 'metadb', latency: 4 },
        { from: 'watch', to: 'objstore', latency: 6 },
        { from: 'gc', to: 'objstore', latency: 4 },
        { from: 'gc', to: 'metadb', latency: 4 },
      ],
    },
    modeLabels: { partial: 'Failing 1080p writes' },
    failures: [
      { id: 'obj-down', node: 'objstore', mode: 'down', label: 'Object storage unavailable', desc: 'No file can be written or read.' },
      { id: 'partial', node: 'objstore', mode: 'partial', label: '1080p writes fail', desc: 'The largest rendition cannot be stored.' },
      { id: 'meta-down', node: 'metadb', mode: 'down', label: 'Metadata database down', desc: 'Files can be stored but nothing records them.' },
      { id: 'gc-paused', node: 'gc', mode: 'paused', label: 'Cleanup job paused', desc: 'Waste accumulates until it resumes.' },
    ],
    switches: Y.switches([
      ['objectsFirst', 'Write objects before metadata', 'Off: write the metadata row first, then the files it points at.'],
      ['gate', 'Publish gate', 'Before going public, check that every listed rendition exists.'],
      ['cleanup', 'Lifecycle cleanup', 'Delete unreferenced objects and abort idle multipart uploads after 3 s.'],
    ]),
    presets: Y.presets({ objectsFirst: true, gate: true, cleanup: true }, [
      { id: 'publish', label: 'Publish and watch', desc: 'Three renditions stored, metadata written, the video plays.', run: (s) => { startPublish(s); s.schedule(2200, () => startWatch(s)); } },
      { id: 'partial-first', label: '1080p fails, objects written first', desc: 'The publish stops before any metadata is written, so nothing points at the missing file. The stored renditions become orphans for cleanup.', run: (s) => { s.inject('objstore', 'partial'); startPublish(s); s.schedule(2600, () => startWatch(s)); } },
      { id: 'partial-gate', label: '1080p fails, metadata first, gate on', desc: 'The metadata row exists, but the gate sees 1080p is missing and keeps the video private. No viewer hits a broken file.', sw: { objectsFirst: false }, run: (s) => { s.inject('objstore', 'partial'); startPublish(s); s.schedule(2600, () => startWatch(s)); } },
      { id: 'partial-bad', label: '1080p fails, metadata first, no gate', desc: 'Metadata goes public first, then the 1080p write fails. Viewers get errors.', sw: { objectsFirst: false, gate: false }, run: (s) => { s.inject('objstore', 'partial'); startPublish(s); s.schedule(2600, () => startWatch(s)); } },
      { id: 'orphans', label: 'Metadata down: orphans cleaned up', desc: 'Files are stored, then the metadata write fails. The cleanup job deletes the unreferenced files.', run: (s) => { s.inject('metadb', 'down', true, 2500); startPublish(s); } },
      { id: 'orphans-bad', label: 'Metadata down, no cleanup', desc: 'The same orphans stay forever, billed every month.', sw: { cleanup: false }, run: (s) => { s.inject('metadb', 'down', true, 2500); startPublish(s); } },
      { id: 'abandoned', label: 'Abandoned multipart upload', desc: 'A creator gives up halfway through a raw upload. The lifecycle rule aborts it.', run: (s) => s.do('abandon', {}) },
      { id: 'abandoned-bad', label: 'Abandoned upload, no lifecycle rule', desc: 'The parts stay, invisible and billed.', sw: { cleanup: false }, run: (s) => s.do('abandon', {}) },
      { id: 'obj-down', label: 'Object storage down', desc: 'With objects first, nothing is published and nothing points at missing files.', run: (s) => { s.inject('objstore', 'down', true, 3000); startPublish(s); } },
    ]),
    initialState: () => ({ config: { objectsFirst: true, gate: true, cleanup: true }, videos: {}, objects: {}, multipart: {}, broken: 0, freed: 0, seq: { video: 0, upload: 0 } }),
    initialUI: () => ({ creator: { busy: false, last: null, message: 'Tap Publish.', tone: '' }, viewer: { result: 'Publish something, then watch it.', tone: '' } }),
    actions: {
      publish(sim) { startPublish(sim); },
      watch(sim) { startWatch(sim); },
      abandon(sim) {
        const st = sim.state;
        const id = 'mpu-' + ++st.seq.upload;
        st.multipart[id] = { id, size: 320, started: sim.now };
        sim.note(`A creator started a 640 MB multipart upload (${id}) and abandoned it after 320 MB. The parts are stored but belong to no object.`);
      },
      set: Y.setAction,
    },
    handlers: {
      publish: {
        publish: function* (ctx, p) {
          const st = ctx.state;
          const names = RENDS.map(([r]) => r);
          const writeMeta = function* (status) { return yield ctx.call('metadb', 'upsert', { vid: p.vid, status, renditions: names }, { timeout: 600 }); };
          if (!st.config.objectsFirst) ctx.must(yield* writeMeta(st.config.gate ? 'verifying' : 'public'));
          const missing = [];
          for (const [r, size] of RENDS) {
            const w = yield* ctx.retry({ attempts: 2, baseMs: 150 }, function* () { return yield ctx.call('objstore', 'put', { key: `${p.vid}/${r}`, size }, { timeout: 800 }); });
            if (!w.ok) missing.push(r);
          }
          if (st.config.objectsFirst) {
            if (missing.length) ctx.fail('PARTIAL_WRITE', `${missing.join(', ')} could not be stored.`);
            ctx.must(yield* writeMeta(st.config.gate ? 'verifying' : 'public'));
          }
          if (st.config.gate) {
            const absent = [];
            for (const r of names) { const h = yield ctx.call('objstore', 'head', { key: `${p.vid}/${r}` }, { timeout: 500 }); if (!h.ok || !h.value.exists) absent.push(r); }
            if (absent.length) return { status: 'verifying', reason: `${absent.join(', ')} missing`, missing: absent };
            ctx.must(yield ctx.call('metadb', 'upsert', { vid: p.vid, status: 'public', renditions: names }, { timeout: 600 }));
          }
          return { status: 'public', missing };
        },
      },
      metadb: {
        upsert(ctx, p) { ctx.state.videos[p.vid] = { status: p.status, renditions: p.renditions }; ctx.ledger('committed', 'yes', `Metadata: ${p.status}.`); return { ok: true }; },
        get(ctx, p) { const v = ctx.state.videos[p.vid]; if (!v) ctx.fail('NOT_FOUND', 'No such video.'); return v; },
        list(ctx) { return { vids: Object.keys(ctx.state.videos) }; },
      },
      objstore: {
        put(ctx, p) {
          if (ctx.mode('partial') && p.key.endsWith('1080p')) ctx.fail('WRITE_FAILED', '1080p write failed.');
          ctx.state.objects[p.key] = { size: p.size, t: ctx.now() };
          return { stored: p.key };
        },
        head(ctx, p) { return { exists: !!ctx.state.objects[p.key] }; },
        get(ctx, p) { if (!ctx.state.objects[p.key]) ctx.fail('NOT_FOUND', `${p.key} does not exist.`); return { bytes: ctx.state.objects[p.key].size }; },
      },
      watch: {
        play: function* (ctx, p) {
          if (!p.vid) ctx.fail('NOTHING', 'Nothing has been published yet.');
          const v = ctx.must(yield ctx.call('metadb', 'get', { vid: p.vid }, { timeout: 500 }));
          if (v.status !== 'public') ctx.fail('NOT_PUBLIC', `${p.vid} is not public yet.`);
          return ctx.must(yield ctx.call('objstore', 'get', { key: `${p.vid}/${p.quality}` }, { timeout: 800 }));
        },
      },
      gc: {},
    },
    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(1000);
          const st = ctx.state;
          if (!st.config.cleanup || ctx.sim.nodes.gc.modes.paused) continue;
          const l = yield ctx.call('metadb', 'list', {}, { timeout: 500, quiet: 'all' });
          if (!l.ok) continue;
          const known = new Set(l.value.vids);
          for (const [k, o] of Object.entries(st.objects)) {
            if (!known.has(k.split('/')[0]) && ctx.now() - o.t > GRACE) {
              yield ctx.call('objstore', 'head', { key: k }, { timeout: 400, quiet: 'all' });
              delete st.objects[k];
              st.freed += o.size;
              ctx.log({ op: `deleted orphan ${k}`, status: 'recovered', detail: `No metadata references it after ${GRACE / 1000} s: ${o.size} MB freed.` });
            }
          }
          for (const [id, m] of Object.entries(st.multipart)) {
            if (ctx.now() - m.started > GRACE) { delete st.multipart[id]; st.freed += m.size; ctx.log({ op: `aborted ${id}`, status: 'recovered', detail: `Idle for over ${GRACE / 1000} s: ${m.size} MB of parts released.` }); }
          }
        }
      }, { self: 'gc', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      for (const [vid, v] of Object.entries(st.videos)) {
        const missing = v.renditions.filter((r) => !st.objects[`${vid}/${r}`]);
        if (v.status === 'public' && missing.length) return { key: 'wrong', label: `${vid} is public but ${missing.join(', ')} does not exist in object storage.` };
      }
      const orphanMB = Object.entries(st.objects).filter(([k]) => !st.videos[k.split('/')[0]]).reduce((a, [, o]) => a + o.size, 0);
      const mpuMB = Object.values(st.multipart).reduce((a, m) => a + m.size, 0);
      if (orphanMB || mpuMB) return { key: 'stale', label: `${orphanMB + mpuMB} MB of storage is referenced by nothing${st.config.cleanup ? ' (cleanup will remove it)' : ' and nothing will ever remove it'}.` };
      const held = Object.entries(st.videos).filter(([, v]) => v.status !== 'public');
      if (held.length) return { key: 'stale', label: `${held.map(([k]) => k).join(', ')} is held back from public until its renditions exist.` };
      return { key: 'ok', label: 'Every public video’s files exist, and every file belongs to a video.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const orphanMB = Object.entries(st.objects).filter(([k]) => !st.videos[k.split('/')[0]]).reduce((a, [, o]) => a + o.size, 0);
      return [
        { label: 'Public videos', value: Object.values(st.videos).filter((v) => v.status === 'public').length },
        { label: 'Broken playbacks', value: st.broken, tone: st.broken ? 'fail' : '' },
        { label: 'Orphaned storage', value: `${orphanMB} MB`, tone: orphanMB ? 'warn' : '' },
        { label: 'Abandoned upload parts', value: `${Object.values(st.multipart).reduce((a, m) => a + m.size, 0)} MB` },
        { label: 'Storage freed by cleanup', value: `${st.freed} MB` },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['creator', 'Creator phone'], ['viewer', 'Viewer phone']], { note: 'Publish from the left phone, watch from the right. A metadata row that points at a missing file breaks playback.' }); },
      render(el, sim) {
        const st = sim.state;
        const c = sim.ui.creator;
        const rows = Object.entries(st.videos).slice(-3).map(([k, v]) => `<div class="app-card ${v.status === 'public' ? 'is-ok' : 'is-hot'}"><strong>${k}: ${v.status}</strong><span class="app-sub">${RENDS.map(([r]) => `${r} ${st.objects[`${k}/${r}`] ? '✓' : '✕'}`).join('  ')}</span></div>`).join('');
        Y.paint(el, sim, 'creator', { head: '<div><p class="app-title">YouTube Studio</p></div>', body: `${Y.btn('publish', c.busy ? '<span class="spinner"></span>Publishing…' : 'Publish next video', { disabled: c.busy })}${Y.btn('abandon', 'Start and abandon a raw upload', { cls: 'secondary' })}${Y.msg(c.message, c.tone)}${rows}` }, {});
        const v = sim.ui.viewer;
        Y.paint(el, sim, 'viewer', { head: '<div><p class="app-title">YouTube</p></div>', body: `${Y.video('Latest upload', 'Distributed Daily', c.last || 'nothing yet', 140)}${Y.btn('watch', 'Watch in 1080p')}${Y.msg(v.result, v.tone)}` }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
