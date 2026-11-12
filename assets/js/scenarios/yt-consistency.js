/*
 * Caching, replication, and consistency. Writes go to the primary and reach
 * two replicas asynchronously. Reads go through a cache-aside cache to a
 * replica. Read-your-writes, cache invalidation, and quorum reads each fix
 * one kind of staleness.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const TITLES = ['Raft explained', 'Raft explained (2026 edition)', 'Raft, the complete guide', 'Raft in 10 minutes'];

  function startEdit(sim) {
    const st = sim.state;
    const title = TITLES[++st.seq.title % TITLES.length];
    sim.startAction(`Creator: rename to “${title}”`, function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'Setting a title is idempotent.'] });
      const r = yield ctx.call('api', 'write', { title }, { timeout: 1200 });
      if (!r.ok) { Y.failed(ctx); return; }
      st.lastWriteAt = ctx.now();
      Y.L(ctx, { accepted: 'yes', committed: ['yes', `Primary has “${title}” (version ${r.value.version}).`], async: ['pending', 'Replicating.'] });
      yield ctx.wait(150);
      const back = yield ctx.call('api', 'read', { who: 'creator' }, { timeout: 1200 });
      ctx.ui.creator.title = back.ok ? back.value.title : '?';
      ctx.ui.creator.src = back.ok ? back.value.src : '';
      const own = back.ok && back.value.title === title;
      if (!own) st.ryw = true;
      Y.L(ctx, { displayed: [own ? 'yes' : 'no', own ? 'The creator sees the new title.' : `The creator sees the old title “${back.ok ? back.value.title : '?'}” right after saving.`] });
      ctx.explain(own ? `The creator saved and immediately read back the new title${back.value.src === 'primary' ? ', because read-your-writes routed their read to the primary' : ''}.` : `The creator just saved “${title}” but reads back the old title from ${back.value.src}: replication had not reached it yet. That breaks read-your-writes, the guarantee users notice most.`);
    }, { self: 'creator' });
  }
  function startView(sim) {
    sim.startAction('Viewer: open the video page', function* (ctx) {
      Y.L(ctx, { committed: ['n/a', 'A read.'], async: 'n/a', retrySafe: 'yes', displayed: 'pending' });
      const r = yield ctx.call('api', 'read', { who: 'viewer' }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx); return; }
      Object.assign(ctx.ui.viewer, { title: r.value.title, src: r.value.src, version: r.value.version });
      const fresh = r.value.version === ctx.state.primary.version;
      Y.L(ctx, { displayed: [fresh ? 'yes' : 'no', `Shows “${r.value.title}” from ${r.value.src}.`], accepted: 'yes' });
      ctx.explain(fresh ? `The viewer sees the latest title, served from ${r.value.src}.` : `The viewer sees an older title from ${r.value.src} (version ${r.value.version}, latest ${ctx.state.primary.version}). For a title, a few seconds of staleness is usually acceptable; the question is how long it lasts.`);
    }, { self: 'viewer' });
  }

  const sc = (SDL.scenarios['yt-consistency'] = {
    id: 'yt-consistency',
    seed: 199,
    productWidth: 560,
    intro: 'Rename the video on the creator phone, then open it on the viewer phone. Slow the replicas or turn off cache invalidation and watch who sees what.',
    topology: {
      width: 1050, height: 480,
      nodes: [
        { id: 'creator', label: 'Creator app', sub: 'Edits the title', kind: 'client', x: 100, y: 100, latency: 1, role: 'Writes, then immediately reads back.', owns: ['Nothing'] },
        { id: 'viewer', label: 'Viewer app', sub: 'Reads the page', kind: 'client', x: 100, y: 380, latency: 1, role: 'Reads the title.', owns: ['Nothing'] },
        { id: 'api', label: 'Video API', sub: 'Routes reads and writes', kind: 'service', x: 340, y: 240, latency: 3, role: 'Writes to the primary; reads through the cache from a replica, or from the primary for read-your-writes.', ops: [{ name: 'write', desc: 'Update title.' }, { name: 'read', desc: 'Read title.' }], owns: ['Routing rules'] },
        { id: 'cache', label: 'Cache', sub: 'Cache-aside, 10 s TTL', kind: 'cache', x: 580, y: 100, latency: 2, role: 'Holds the title for 10 s after a read miss.', ops: [{ name: 'get', desc: 'Cached title.' }, { name: 'set', desc: 'Store.' }, { name: 'del', desc: 'Invalidate.' }], owns: ['title cache'] },
        { id: 'primary', label: 'Primary', sub: 'All writes', kind: 'db', x: 580, y: 300, latency: 8, role: 'Takes every write and ships changes to the replicas.', ops: [{ name: 'write', desc: 'Commit.' }, { name: 'read', desc: 'Authoritative read.' }], owns: ['videos (authoritative)'] },
        { id: 'replica1', label: 'Replica 1', sub: 'Async copy', kind: 'db', x: 860, y: 220, latency: 5, role: 'Receives changes after a replication delay.', ops: [{ name: 'read', desc: 'Possibly stale read.' }], owns: ['videos (copy)'] },
        { id: 'replica2', label: 'Replica 2', sub: 'Async copy', kind: 'db', x: 860, y: 400, latency: 5, role: 'Receives changes after a replication delay.', ops: [{ name: 'read', desc: 'Possibly stale read.' }], owns: ['videos (copy)'] },
      ],
      edges: [
        { from: 'creator', to: 'api', latency: 30 },
        { from: 'viewer', to: 'api', latency: 30 },
        { from: 'api', to: 'cache', latency: 2 },
        { from: 'api', to: 'primary', latency: 3 },
        { from: 'api', to: 'replica1', latency: 4, via: [[700, 220]] },
        { from: 'api', to: 'replica2', latency: 4, via: [[700, 440]] },
        { from: 'primary', to: 'replica1', latency: 10, label: 'replication' },
        { from: 'primary', to: 'replica2', latency: 10 },
      ],
    },
    modeLabels: { lag: 'Replication lagging' },
    failures: [
      { id: 'lag', node: 'replica1', mode: 'lag', label: 'Replica 1 lags 3 s', desc: 'Changes reach replica 1 three seconds late.' },
      { id: 'lag2', node: 'replica2', mode: 'lag', label: 'Replica 2 lags 3 s', desc: 'Changes reach replica 2 three seconds late.' },
      { id: 'primary-down', node: 'primary', mode: 'down', label: 'Primary down', desc: 'Writes fail; reads from replicas continue.' },
    ],
    switches: Y.switches([
      ['invalidate', 'Invalidate the cache on write', 'Delete the cached title when it changes. Off: readers see the old title until the 10 s TTL expires.'],
      ['ryw', 'Read-your-writes', 'For 5 s after writing, route that user’s reads to the primary.'],
      ['quorum', 'Quorum reads', 'Read both replicas and the primary’s version, return the newest. Slower, never stale.'],
    ]),
    presets: Y.presets({ invalidate: true, ryw: true, quorum: false }, [
      { id: 'edit', label: 'Rename, then view', desc: 'The creator sees the new title at once; the viewer sees it after replication.', run: (s) => { startEdit(s); s.schedule(900, () => startView(s)); } },
      { id: 'no-ryw', label: 'Rename with lagging replicas, no read-your-writes', desc: 'The creator saves, reads back, and sees their old title.', sw: { ryw: false }, run: (s) => { s.inject('replica1', 'lag'); s.inject('replica2', 'lag'); startEdit(s); } },
      { id: 'ryw', label: 'Same, with read-your-writes', desc: 'The creator’s read goes to the primary and shows the new title, even though replicas lag.', run: (s) => { s.inject('replica1', 'lag'); s.inject('replica2', 'lag'); startEdit(s); } },
      { id: 'no-invalidate', label: 'Cached title, no invalidation', desc: 'A viewer cached the old title; for 10 s everyone keeps seeing it.', sw: { invalidate: false }, run: (s) => { startView(s); s.schedule(600, () => startEdit(s)); s.schedule(2500, () => startView(s)); } },
      { id: 'invalidate', label: 'Cached title, invalidated on write', desc: 'The write deletes the cached entry; the next viewer gets the new title.', run: (s) => { startView(s); s.schedule(600, () => startEdit(s)); s.schedule(2500, () => startView(s)); } },
      { id: 'quorum', label: 'Lagging replica, quorum read', desc: 'One replica is behind; reading several copies and taking the newest still returns the latest title.', sw: { quorum: true }, run: (s) => { s.inject('replica1', 'lag'); startEdit(s); s.schedule(900, () => startView(s)); } },
    ]),
    initialState: () => ({ config: { invalidate: true, ryw: true, quorum: false }, primary: { title: TITLES[0], version: 1 }, replicas: { replica1: { title: TITLES[0], version: 1 }, replica2: { title: TITLES[0], version: 1 } }, cache: null, rr: 0, lastWriteAt: -1e9, ryw: false, seq: { title: 0 } }),
    initialUI: () => ({ creator: { title: TITLES[0], src: '' }, viewer: { title: '—', src: '', version: 0 } }),
    actions: { edit(sim) { startEdit(sim); }, view(sim) { startView(sim); }, set: Y.setAction },
    handlers: {
      api: {
        write: function* (ctx, p) {
          const r = ctx.must(yield ctx.call('primary', 'write', p, { timeout: 800 }));
          if (ctx.state.config.invalidate) yield ctx.call('cache', 'del', {}, { timeout: 300 });
          return r;
        },
        read: function* (ctx, p) {
          const st = ctx.state;
          if (p.who === 'creator' && st.config.ryw && ctx.now() - st.lastWriteAt < 5000) return Object.assign({ src: 'primary' }, ctx.must(yield ctx.call('primary', 'read', {}, { timeout: 600 })));
          if (st.config.quorum) {
            const rs = [];
            for (const n of ['replica1', 'replica2', 'primary']) { const r = yield ctx.call(n, 'read', {}, { timeout: 600 }); if (r.ok) rs.push(Object.assign({ src: n === 'primary' ? 'primary' : n.replace('replica', 'replica ') }, r.value)); }
            if (!rs.length) ctx.fail('UNAVAILABLE', 'No copy answered.');
            return rs.sort((a, b) => b.version - a.version)[0];
          }
          const c = yield ctx.call('cache', 'get', {}, { timeout: 300 });
          if (c.ok && c.value.hit) return Object.assign({ src: 'the cache' }, c.value.v);
          const rep = ['replica1', 'replica2'][st.rr++ % 2];
          const r = ctx.must(yield ctx.call(rep, 'read', {}, { timeout: 600 }));
          yield ctx.call('cache', 'set', { v: r }, { timeout: 300 });
          return Object.assign({ src: rep.replace('replica', 'replica ') }, r);
        },
      },
      cache: {
        get(ctx) { const c = ctx.state.cache; return c && ctx.now() - c.t < 10000 ? { hit: true, v: c.v } : { hit: false }; },
        set(ctx, p) { ctx.state.cache = { v: p.v, t: ctx.now() }; return { ok: true }; },
        del(ctx) { ctx.state.cache = null; return { ok: true }; },
      },
      primary: {
        write(ctx, p) {
          const st = ctx.state;
          st.primary = { title: p.title, version: st.primary.version + 1 };
          const snap = Object.assign({}, st.primary);
          for (const r of ['replica1', 'replica2']) {
            const delay = ctx.sim.nodes[r].modes.lag ? 3000 : 300;
            ctx.sim.schedule(delay, () => { if (st.replicas[r].version < snap.version) st.replicas[r] = Object.assign({}, snap); });
          }
          return Object.assign({}, st.primary);
        },
        read(ctx) { return Object.assign({}, ctx.state.primary); },
      },
      replica1: { read(ctx) { return Object.assign({}, ctx.state.replicas.replica1); } },
      replica2: { read(ctx) { return Object.assign({}, ctx.state.replicas.replica2); } },
    },
    consistency(sim) {
      const st = sim.state;
      if (st.ryw) return { key: 'wrong', label: 'The creator saved a new title and then saw their old one: read-your-writes was violated.' };
      const v = sim.ui.viewer;
      if (v.version && v.version < st.primary.version) return { key: 'stale', label: `The viewer last saw version ${v.version}; the latest is ${st.primary.version} (served from ${v.src}).` };
      return { key: 'ok', label: 'Everyone sees the latest title, and the creator always sees their own edits.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      return [
        { label: 'Primary version', value: st.primary.version },
        { label: 'Replica 1 version', value: st.replicas.replica1.version, tone: st.replicas.replica1.version < st.primary.version ? 'warn' : 'ok' },
        { label: 'Replica 2 version', value: st.replicas.replica2.version, tone: st.replicas.replica2.version < st.primary.version ? 'warn' : 'ok' },
        { label: 'Cached version', value: st.cache ? st.cache.v.version : 'empty' },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['creator', 'Creator'], ['viewer', 'Viewer']], { note: 'Each phone shows the title it last read and where that read was served from.' }); },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const c = sim.ui.creator;
        const v = sim.ui.viewer;
        Y.paint(el, sim, 'creator', { head: '<div><p class="app-title">YouTube Studio</p></div>', body: `<div class="app-card"><strong>${esc(c.title)}</strong><span class="app-sub">${c.src ? `read from ${esc(c.src)}` : 'current title'}</span></div>${Y.btn('edit', 'Rename video')}` }, {});
        Y.paint(el, sim, 'viewer', { head: '<div><p class="app-title">YouTube</p></div>', body: `${Y.video(v.title, 'Distributed Daily', v.src ? `from ${v.src}` : '', 200)}${Y.btn('view', 'Open video page')}` }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
