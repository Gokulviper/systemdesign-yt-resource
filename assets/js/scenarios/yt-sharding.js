/*
 * Database sharding. Requests for videos are routed to shards by a shard key.
 * Sharding by channel puts a celebrity channel's traffic on one shard; hashing
 * the video ID spreads it. Adding a shard moves keys: about 80% with modulo
 * hashing, about 20% with consistent hashing, and moved keys cost migration work.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const VIDEOS = 2000;
  const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const channelOf = (v) => (v % 10 < 4 ? 'megastar' : 'ch' + (v % 50));

  function shardFor(st, v) {
    const key = st.key === 'channel' ? channelOf(v) : 'v' + v;
    const h = hash(key);
    if (!st.config.consistent) return 's' + ((h % st.shards) + 1);
    // Consistent hashing: a ring of 64 virtual points per shard; take the first point clockwise.
    let best = null;
    for (const p of st.ring) if (p.at >= h && (!best || p.at < best.at)) best = p;
    return (best || st.ring.reduce((a, b) => (b.at < a.at ? b : a))).shard;
  }
  function buildRing(st) {
    st.ring = [];
    for (let i = 1; i <= st.shards; i++) for (let k = 0; k < 160; k++) st.ring.push({ shard: 's' + i, at: hash(`s${i}#${k}`) });
  }

  const sc = (SDL.scenarios['yt-sharding'] = {
    id: 'yt-sharding',
    seed: 211,
    productWidth: 560,
    intro: 'Traffic flows to four shards by the chosen key. Switch the key to “channel” and watch MegaStar’s 40% of traffic pile onto one shard. Then add a fifth shard with and without consistent hashing.',
    topology: {
      width: 1050, height: 520,
      nodes: [
        { id: 'app', label: 'App servers', sub: 'Read and write videos', kind: 'client', x: 100, y: 260, latency: 1, role: 'Issue about 120 requests per second; 40% are for MegaStar’s videos.', owns: ['Nothing'] },
        { id: 'router', label: 'Shard router', sub: 'Key → shard', kind: 'gateway', x: 340, y: 260, latency: 2, role: 'Computes the shard for each request from the shard key.', ops: [{ name: 'route', desc: 'Send to the owning shard.' }], owns: ['Shard map or hash ring'] },
        { id: 's1', label: 'Shard 1', sub: 'Videos', kind: 'db', x: 620, y: 60, latency: 2, serviceMs: 15, role: 'One partition of the video table. About 66 requests per second.', ops: [{ name: 'get', desc: 'Serve a row.' }], owns: ['part of videos'] },
        { id: 's2', label: 'Shard 2', sub: 'Videos', kind: 'db', x: 620, y: 180, latency: 2, serviceMs: 15, role: 'One partition.', ops: [{ name: 'get', desc: 'Serve a row.' }], owns: ['part of videos'] },
        { id: 's3', label: 'Shard 3', sub: 'Videos', kind: 'db', x: 620, y: 300, latency: 2, serviceMs: 15, role: 'One partition.', ops: [{ name: 'get', desc: 'Serve a row.' }], owns: ['part of videos'] },
        { id: 's4', label: 'Shard 4', sub: 'Videos', kind: 'db', x: 620, y: 420, latency: 2, serviceMs: 15, role: 'One partition.', ops: [{ name: 'get', desc: 'Serve a row.' }], owns: ['part of videos'] },
        { id: 's5', label: 'Shard 5', sub: 'Added later', kind: 'db', x: 900, y: 240, latency: 2, serviceMs: 15, role: 'Joins when you add a shard.', ops: [{ name: 'get', desc: 'Serve a row.' }], owns: ['part of videos'] },
        { id: 'mover', label: 'Rebalancer', sub: 'Migrates rows', kind: 'worker', x: 900, y: 440, latency: 2, role: 'Copies rows whose owner changed to their new shard, in batches that use shard capacity.', ops: [{ name: 'move', desc: 'Migrate a batch.' }], owns: ['Migration progress'] },
      ],
      edges: [
        { from: 'app', to: 'router', latency: 5 },
        ...['s1', 's2', 's3', 's4', 's5'].map((s) => ({ from: 'router', to: s, latency: 3 })),
        { from: 'mover', to: 's5', latency: 3 },
      ],
    },
    failures: [
      { id: 's2-down', node: 's2', mode: 'down', label: 'Shard 2 down', desc: 'Only the keys it owns are unavailable.' },
      { id: 's1-slow', node: 's1', mode: 'slow', params: { factor: 4 }, label: 'Shard 1 slow', desc: 'A noisy neighbour on one shard.' },
    ],
    switches: Y.switches([
      ['consistent', 'Consistent hashing', 'A hash ring with virtual nodes. Off: hash modulo the shard count.'],
    ]),
    presets: Y.presets({ consistent: true }, [
      { id: 'video', label: 'Shard by video ID', desc: 'Hashing video IDs spreads MegaStar’s traffic evenly; every shard is comfortable.', run: (s) => s.do('setKey', { key: 'video' }) },
      { id: 'channel', label: 'Shard by channel', desc: 'All of MegaStar’s videos live on one shard, which gets about 70% more than it can serve.', run: (s) => s.do('setKey', { key: 'channel' }) },
      { id: 'add-consistent', label: 'Add a shard, consistent hashing', desc: 'About a fifth of rows move; migration is brief.', run: (s) => { s.do('setKey', { key: 'video' }); s.schedule(1000, () => s.do('addShard', {})); } },
      { id: 'add-modulo', label: 'Add a shard, modulo hashing', desc: 'About four fifths of rows change owner; the migration floods every shard.', sw: { consistent: false }, run: (s) => { s.do('setKey', { key: 'video' }); s.schedule(1000, () => s.do('addShard', {})); } },
      { id: 'shard-down', label: 'One shard fails', desc: 'A quarter of videos are unavailable; the rest are unaffected.', run: (s) => { s.do('setKey', { key: 'video' }); s.inject('s2', 'down'); } },
    ]),
    initialState: () => { const st = { config: { consistent: true }, key: 'video', shards: 4, moving: 0, moved: 0, errors: 0, served: 0, seq: { req: 0 } }; buildRing(st); return st; },
    initialUI: () => ({}),
    actions: {
      setKey(sim, a) { sim.state.key = a.key; sim.note(`Shard key is now ${a.key === 'video' ? 'hash(video_id)' : 'channel_id'}.`); },
      addShard(sim) {
        const st = sim.state;
        if (st.shards === 5) return;
        const before = Array.from({ length: VIDEOS }, (_, v) => shardFor(st, v));
        st.shards = 5;
        buildRing(st);
        const moved = before.filter((s, v) => shardFor(st, v) !== s).length;
        st.moving = moved;
        st.moved = moved;
        sim.note(`Shard 5 added. ${moved} of ${VIDEOS} rows (${Math.round((moved / VIDEOS) * 100)}%) now belong to a different shard and must be migrated.`);
      },
      set: Y.setAction,
    },
    handlers: {
      router: { route: function* (ctx, p) { return ctx.must(yield ctx.call(shardFor(ctx.state, p.v), 'get', p, { timeout: 800 })); } },
      s1: { get() { return { ok: true }; } }, s2: { get() { return { ok: true }; } }, s3: { get() { return { ok: true }; } }, s4: { get() { return { ok: true }; } }, s5: { get() { return { ok: true }; } },
    },
    setup(sim) {
      Y.load(sim, 'app', () => 120, function* (ctx, n) {
        const st = ctx.state;
        const v = (n * 7919) % VIDEOS;
        const r = yield ctx.call('router', 'route', { v }, { timeout: 1000, quiet: 'all' });
        if (r.ok) st.served++; else st.errors++;
        ctx.sim.recordOutcome(r.ok, r.latency);
      });
      // Migration: batches of 20 rows; each batch loads a source and a target shard.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(20);
          const st = ctx.state;
          if (st.moving <= 0) continue;
          const batch = Math.min(20, st.moving);
          st.moving -= batch;
          const src = 's' + (1 + (st.moving % 4));
          ctx.spawn(function* (c) { yield c.call(src, 'get', { migrate: batch }, { timeout: 2000, quiet: 'all' }); yield c.call('s5', 'get', { migrate: batch }, { timeout: 2000, quiet: 'all' }); }, { quiet: 'all' });
          if (st.moving === 0) ctx.log({ op: 'migration finished', status: 'ok', detail: `${st.moved} rows moved.` });
        }
      }, { self: 'mover', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const shards = ['s1', 's2', 's3', 's4', 's5'].slice(0, st.shards);
      if (sim.activeFailures().some((f) => f.mode === 'down')) return { key: 'stale', label: 'A quarter of videos are unavailable while one shard is down; the other shards are unaffected.' };
      const hot = shards.find((s) => sim.queueWait(s) > 500);
      if (hot) return { key: 'stale', label: `${sim.nodes[hot].label} is overloaded (${SDL.fmtMs(sim.queueWait(hot))} queue)${st.moving ? ' by migration traffic' : st.key === 'channel' ? ': a hot shard caused by the shard key' : ''}.` };
      return { key: 'ok', label: 'Load is spread across shards and every request is served.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const out = ['s1', 's2', 's3', 's4', 's5'].slice(0, st.shards).map((s) => { const w = sim.queueWait(s); return { label: `${sim.nodes[s].label} queue`, value: SDL.fmtMs(w), tone: w > 500 ? 'fail' : w > 80 ? 'warn' : 'ok' }; });
      out.push({ label: 'Rows moved by last resize', value: st.moved ? `${st.moved} (${Math.round((st.moved / VIDEOS) * 100)}%)` : 'n/a' });
      out.push({ label: 'Rows still migrating', value: st.moving });
      return out;
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [], { note: 'Choose the shard key and resize the cluster. The bars show each shard’s queue.', side: '<p class="ops-title">Shard key</p><div class="ops-traffic"><button class="btn ops-tbtn" data-act="setKey" data-arg=\'{"key":"video"}\' data-k="video">hash(video_id)</button><button class="btn ops-tbtn" data-act="setKey" data-arg=\'{"key":"channel"}\' data-k="channel">channel_id</button><button class="btn" data-act="addShard">Add shard 5</button></div><div class="ops-shards" data-ref="rows"></div>' }); },
      render(el, sim) {
        const st = sim.state;
        el.querySelectorAll('[data-k]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === st.key)));
        const shards = ['s1', 's2', 's3', 's4', 's5'].slice(0, st.shards);
        const rows = shards.map((s) => `<div class="ops-row" data-shard="${s}"><div class="ops-name"><strong>${sim.nodes[s].label}</strong><span data-live="n-${s}"></span></div><div class="ops-bar"><i data-live-width="w-${s}"></i></div><span class="ops-val" data-live="v-${s}"></span></div>`).join('');
        const live = {};
        const memoKey = `${st.key}|${st.shards}|${st.config.consistent}`;
        if (this._memoKey !== memoKey) { this._memoKey = memoKey; this._counts = {}; for (let v = 0; v < VIDEOS; v++) { const o = shardFor(st, v); this._counts[o] = (this._counts[o] || 0) + 1; } }
        for (const s of shards) { const w = sim.queueWait(s); live[`w-${s}`] = `${Math.min(100, w / 20)}%`; live[`v-${s}`] = sim.nodes[s].modes.down ? 'down' : `${Math.round(w)} ms queue`; live[`n-${s}`] = `${this._counts[s] || 0} rows`; }
        const box = el.querySelector('[data-ref="rows"]');
        SDL.ui.paintSections(box, { rows }, live);
        box.querySelectorAll('.ops-row').forEach((r) => { const w = sim.queueWait(r.dataset.shard); r.dataset.tone = sim.nodes[r.dataset.shard].modes.down || w > 500 ? 'fail' : w > 80 ? 'warn' : 'ok'; });
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
