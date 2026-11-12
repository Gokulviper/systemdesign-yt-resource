/*
 * Hot partitions, throttling, and adaptive capacity.
 * Two partitions on two nodes, each able to serve about a thousand requests
 * a second. Maya's cart shares Partition 1 with a flash-sale deal that
 * everyone reads and with a noisy tenant's keys. When the deal gets famous,
 * Partition 1 melts and Maya's requests queue behind the crowd. The
 * defences: per-partition token buckets that fail fast instead of queueing,
 * adaptive capacity that lends the idle partition's share to the busy one,
 * a read-through cache for the hot reads, and splitting the partition at
 * the point where the traffic divides, which helps a noisy tenant and does
 * nothing for a single hot key.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const KEY = 'cart:maya';
  const HOT = 'deal:flash';
  const NODE_CAP = 1000;
  const SAFE_CAP = 850;
  const QUOTA = 500;
  const BURST = 300;
  const STEADY = 150;
  const FLOOD = 1500;
  const MODERATE = 600;
  const NOISY = 800;
  const CACHE_TTL = 5000;
  const SPLIT_AFTER = 1000;
  const COPY_MS = 400;
  const SLO = 200;
  const WINDOW = 1000;
  const PARTS = ['p1', 'p2', 'p3'];
  const NAME = { p1: 'Partition 1', p2: 'Partition 2', p3: 'Partition 3' };
  const CART_KEYS = [...Array(200)].map((_, i) => `cart:u${String(i).padStart(3, '0')}`);
  const ORDER_KEYS = [...Array(200)].map((_, i) => `orders:${String(i).padStart(3, '0')}`);
  const NOISY_KEYS = [...Array(60)].map((_, i) => `b:${String(i).padStart(2, '0')}`);

  const partitionOf = (st, key) => PARTS.find((p) => st.parts[p] && st.parts[p].lo <= key && key < st.parts[p].hi);
  const dead = (sim, n) => !!(sim.nodes[n].modes.down || sim.nodes[n].modes.crashed);
  const floodRate = (sim) => (sim.nodes.router.modes.flood ? FLOOD : sim.nodes.router.modes.moderate ? MODERATE : 0);
  const noisyRate = (sim) => (sim.nodes.router.modes.noisy ? NOISY : 0);
  const lastRps = (st, p) => (st.last[p] ? st.last[p].admitted : 0);
  const quotaOf = (st, p) => {
    if (!st.config.adaptive) return QUOTA;
    const spare = PARTS.filter((x) => x !== p && st.parts[x]).reduce((s, x) => s + Math.max(0, QUOTA - lastRps(st, x)), 0);
    return Math.min(SAFE_CAP, QUOTA + spare);
  };
  const count = (st, p, key, field) => { const w = st.win[p]; w[field]++; if (field === 'admitted') w.keys[key] = (w.keys[key] || 0) + 1; };

  /* ---------- Maya and Dev ---------- */
  function startMaya(sim, op, item) {
    const u = sim.ui.maya;
    sim.startAction(op === 'add' ? `Maya: add ${item}` : 'Maya: refresh cart', function* (ctx) {
      const st = ctx.state;
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const items = op === 'add' ? Y.kv.union([u.cart, [item]]) : null;
      const r = op === 'add' ? yield ctx.call('router', 'put', { key: KEY, value: items }, { timeout: 1500 }) : yield ctx.call('router', 'get', { key: KEY }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency; u.lastErr = r.ok ? '' : r.error.code;
      const p = partitionOf(st, KEY);
      if (!r.ok) {
        u.error = r.error.message;
        Y.failed(ctx, 'The cart shows an error.');
        ctx.explain({
          THROTTLED: `${NAME[p]} is over its quota of ${quotaOf(st, p)} requests a second, so the admission controller refused Maya's request in ${SDL.fmtMs(r.latency)} rather than let it queue. The node behind it stays healthy; Maya pays with a fast error. A hot partition throttles every key in it, not just the hot one.`,
          TIMEOUT: `${NAME[p]} is overloaded: requests wait ${SDL.fmtMs(ctx.sim.queueWait(p))} for a worker, longer than the client is willing to wait. Maya's cart is nowhere near the hot key, but it shares the partition with it.`,
        }[r.error.code] || r.error.message);
        return;
      }
      if (op === 'add') { u.cart = items; st.acked = items.slice(); } else u.cart = r.value.value || [];
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: op === 'add' ? ['yes', `Written to ${NAME[p]}.`] : 'n/a', async: 'n/a' });
      const w = ctx.sim.queueWait(p);
      ctx.explain(`${op === 'add' ? 'Saved' : 'Read'} via ${NAME[p]} in ${SDL.fmtMs(r.latency)}${r.value.waited > 20 ? `, of which ${SDL.fmtMs(r.value.waited)} was waiting in ${NAME[p]}'s queue behind ${lastRps(st, p)} requests a second of other traffic` : ''}.${w > SLO ? ` The queue is now ${SDL.fmtMs(w)}; the next request may not be so lucky.` : ''}`);
    }, { self: 'maya' });
  }
  function startDeal(sim) {
    sim.startAction('Dev: change the deal price', function* (ctx) {
      const st = ctx.state;
      st.dealVersion++;
      const price = 20 - st.dealVersion * 2;
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call('router', 'put', { key: HOT, value: { price, v: st.dealVersion } }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      if (!r.ok) { Y.failed(ctx, 'Not saved.'); ctx.explain(r.error.message); return; }
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'yes', async: st.config.cache ? ['pending', `Cached copies expire within ${CACHE_TTL / 1000} s.`] : 'n/a' });
      ctx.explain(`The deal is now $${price} in ${NAME[partitionOf(st, HOT)]}.${st.config.cache ? ` The cache still holds the old price until its ${CACHE_TTL / 1000} s TTL runs out; every cached read until then is stale. Writes here do not invalidate the cache.` : ''}`);
    }, { self: 'dev' });
  }

  /* ---------- background traffic ---------- */
  function* bgRequest(c, op, key) {
    const st = c.state;
    const r = yield c.call('router', op, op === 'put' ? { key, value: [`v${c.now() % 7}`] } : { key }, { timeout: 1500, quiet: 'all' });
    if (!r.ok) st.bg[r.error.code === 'THROTTLED' ? 'throttled' : 'failed']++;
    else if (key === HOT && r.value.value && r.value.value.v < st.dealVersion) st.bg.staleDeal++;
  }

  /* ---------- split ---------- */
  function* splitPartition(ctx, p, manual) {
    const st = ctx.state; const sim = ctx.sim;
    if (st.parts.p3 || st.splitting) return;
    const win = st.last[p];
    if (!win || !Object.keys(win.keys).length) return;
    const keys = Object.keys(win.keys).sort();
    const total = keys.reduce((s, k) => s + win.keys[k], 0);
    let acc = 0; let mid = keys[keys.length - 1];
    for (const k of keys) { acc += win.keys[k]; if (acc >= total / 2) { mid = k; break; } }
    if (mid === keys[0] && keys.length > 1) mid = keys[1];
    if (mid <= st.parts[p].lo || mid >= st.parts[p].hi) return;
    st.splitting = true;
    const hotShare = Math.round(100 * (win.keys[HOT] || 0) / total);
    ctx.log({ op: `splitting ${NAME[p]} at “${mid}”`, status: 'warn', detail: `${manual ? 'Dev asked for a split' : `${NAME[p]} has been hot for ${SPLIT_AFTER} ms`}. The split point is where the last second's traffic divides in half: ${keys.indexOf(mid)} keys and ${Math.round(100 * (acc - win.keys[mid]) / total)}% of requests stay; the rest move to ${NAME.p3}.${hotShare > 50 ? ` One key, ${HOT}, is ${hotShare}% of the traffic, so whichever side it lands on stays hot.` : ''}` });
    yield ctx.call('p3', 'import', { from: p, mid }, { timeout: 5000 });
    const hi = st.parts[p].hi;
    st.parts.p3 = { lo: mid, hi };
    st.parts[p].hi = mid;
    for (const k of Object.keys(st.data[p])) if (k >= mid) { st.data.p3[k] = st.data[p][k]; delete st.data[p][k]; }
    st.stats.splits++;
    st.splitting = false;
    sim.note(`${NAME[p]} is now [${st.parts[p].lo}, ${mid}) and ${NAME.p3} is [${mid}, ${hi}). Maya's cart is in ${NAME[partitionOf(st, KEY)]}; ${HOT} is in ${NAME[partitionOf(st, HOT)]}.`);
  }

  const sc = (SDL.scenarios['kv-admission'] = {
    id: 'kv-admission',
    seed: 47,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Turn the flash sale on and refresh Maya’s cart: it shares Partition 1 with the deal everyone is reading. Then switch on token buckets, adaptive capacity, and the cache, and try a split, first for the single hot key and then for the noisy tenant.',
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'cart:maya in Partition 1', x: 90, y: 120, latency: 1, role: 'An ordinary tenant whose key happens to live in the hot partition.', owns: ['What the phone shows'] },
        { id: 'dev', label: 'Dev’s console', kind: 'client', sub: 'Operator', x: 90, y: 440, latency: 1, role: 'Starts the flash sale and the noisy tenant, changes the deal price, and can split a partition by hand.', owns: ['Traffic knobs'] },
        { id: 'router', label: 'Request router', kind: 'gateway', sub: 'Partition map', x: 330, y: 280, latency: 1, role: 'Maps a key to its partition by key range, asks admission control for a token, consults the cache for catalog reads, and forwards.', ops: [{ name: 'get', desc: 'Read a key.' }, { name: 'put', desc: 'Write a key.' }], owns: ['Partition map (ranges)'] },
        { id: 'admission', label: 'Admission control', kind: 'service', sub: 'Token buckets', x: 560, y: 90, latency: 1, role: `One token bucket per partition: ${QUOTA} tokens a second, up to ${BURST} saved as burst credit. Adaptive capacity raises a bucket's rate with whatever the other partitions are not using, up to ${SAFE_CAP}.`, ops: [{ name: 'check', desc: 'Take a token or refuse.' }], owns: ['Token buckets'] },
        { id: 'cache', label: 'Read-through cache', kind: 'cache', sub: `Catalog keys, TTL ${CACHE_TTL / 1000} s`, x: 560, y: 470, latency: 0.5, role: 'Serves repeated reads of catalog keys such as the deal without touching the partition. Entries expire by TTL; writes do not invalidate them.', ops: [{ name: 'get', desc: 'Lookup.' }, { name: 'set', desc: 'Fill.' }], owns: ['Cached catalog values'] },
        { id: 'p1', label: 'Partition 1', kind: 'db', sub: 'One node, about 1,000 req/s', x: 860, y: 90, latency: 1, serviceMs: 1, servers: 1, role: 'Keys from “a” to “n”: the noisy tenant’s b:* keys, every cart, and the deal. One worker; requests queue when it is busy.', ops: [{ name: 'get', desc: 'Read.' }, { name: 'put', desc: 'Write.' }], owns: ['Its key range'] },
        { id: 'p2', label: 'Partition 2', kind: 'db', sub: 'One node, about 1,000 req/s', x: 860, y: 280, latency: 1, serviceMs: 1, servers: 1, role: 'Keys from “n” onward: orders and sessions. Lightly loaded; its unused share is what adaptive capacity lends out.', ops: [{ name: 'get', desc: 'Read.' }, { name: 'put', desc: 'Write.' }], owns: ['Its key range'] },
        { id: 'p3', label: 'Partition 3', kind: 'db', sub: 'Spare node', x: 860, y: 470, latency: 1, serviceMs: 1, servers: 1, role: 'Empty until a split hands it the upper half of a hot partition’s range.', ops: [{ name: 'get', desc: 'Read.' }, { name: 'put', desc: 'Write.' }, { name: 'import', desc: 'Take over a range.' }], owns: ['Nothing yet'] },
        { id: 'splitter', label: 'Split worker', kind: 'worker', sub: 'Split for heat', x: 1080, y: 280, latency: 2, role: `Watches each partition's last second of traffic. After ${SPLIT_AFTER} ms of overload it splits the range at the key where the traffic divides in half and copies the upper part to the spare node.`, owns: ['Nothing'] },
      ],
      edges: [
        { from: 'maya', to: 'router', latency: 15 },
        { from: 'dev', to: 'router', latency: 15 },
        { from: 'router', to: 'admission', latency: 1 },
        { from: 'router', to: 'cache', latency: 1 },
        { from: 'router', to: 'p1', latency: 2 },
        { from: 'router', to: 'p2', latency: 2 },
        { from: 'router', to: 'p3', latency: 2 },
        { from: 'splitter', to: 'p1', latency: 2 },
        { from: 'splitter', to: 'p3', latency: 2 },
        { from: 'splitter', to: 'router', latency: 2, via: [[1080, 530], [330, 530]] },
      ],
      queues: [],
    },
    modeLabels: { flood: `Flash sale: ${Y.num(FLOOD)} reads/s of one key`, moderate: `Busy sale: ${MODERATE} reads/s of one key`, noisy: `Noisy tenant: ${NOISY} writes/s over 60 keys` },
    failures: [
      { id: 'flood', node: 'router', mode: 'flood', label: `Flash sale: ${Y.num(FLOOD)} reads/s of ${HOT}`, desc: 'One key gets famous. All of it lands on Partition 1, beyond what one node can serve.' },
      { id: 'moderate', node: 'router', mode: 'moderate', label: `Busy sale: ${MODERATE} reads/s of ${HOT}`, desc: `Within the node's capacity but above Partition 1's ${QUOTA} req/s quota. A fixed bucket throttles it; adaptive capacity does not.` },
      { id: 'noisy', node: 'router', mode: 'noisy', label: `Noisy tenant: ${NOISY} writes/s over b:00–b:59`, desc: 'Many keys, all in Partition 1. A split at the traffic midpoint halves the load.' },
      { id: 'cache-down', node: 'cache', mode: 'down', label: 'Cache down', desc: 'Every catalog read goes to the partition again.' },
      { id: 'splitter-paused', node: 'splitter', mode: 'paused', label: 'Split worker paused', desc: 'A hot partition stays hot.' },
      { id: 'p1-slow', node: 'p1', mode: 'slow', params: { factor: 3 }, label: 'Partition 1 slow', desc: 'Its node serves a third as many requests a second. Even the steady load starts to queue.' },
      { id: 'admission-down', node: 'admission', mode: 'down', label: 'Admission controller down', desc: 'The router fails open and forwards everything. Protection gone.' },
    ],
    switches: Y.switches([
      ['buckets', 'Per-partition token buckets', `Each partition admits ${QUOTA} requests a second plus up to ${BURST} saved credits. Beyond that the router answers “throttled” at once instead of letting the node’s queue grow.`],
      ['adaptive', 'Adaptive capacity', `A busy partition may use the share its neighbours are not using, up to ${SAFE_CAP} requests a second. Needs token buckets.`],
      ['cache', 'Read-through cache for catalog keys', `Reads of deal:* are served from the cache after the first miss, for ${CACHE_TTL / 1000} s. The partition sees one read per TTL instead of thousands.`],
      ['autoSplit', 'Split for heat', `After ${SPLIT_AFTER} ms of overload the split worker divides the partition at the key where its traffic splits in half.`],
    ]),
    presets: Y.presets({ buckets: false, adaptive: false, cache: false, autoSplit: false }, [
      { id: 'steady', label: 'Steady state', desc: `${STEADY} requests a second on each partition. Maya's save and refresh take a few milliseconds each.`, run: (s) => { s.schedule(300, () => startMaya(s, 'add', 'Socks')); s.schedule(1500, () => startMaya(s, 'refresh')); } },
      { id: 'meltdown', label: 'Flash sale: Partition 1 melts', desc: `${Y.num(FLOOD)} reads a second of one deal land on Partition 1, more than its node can serve. The queue grows every second. Maya's cart is an innocent neighbour: her request waits behind the crowd and times out.`, run: (s) => { s.schedule(300, () => startMaya(s, 'add', 'Socks')); s.schedule(500, () => s.inject('router', 'flood')); s.schedule(3500, () => startMaya(s, 'refresh')); s.schedule(6000, () => startMaya(s, 'add', 'Hat')); } },
      { id: 'buckets', label: 'Token buckets: fail fast, node stays healthy', desc: `Same flood with a ${QUOTA} req/s bucket on Partition 1. Two thirds of the requests are refused in a millisecond; the node never queues. Maya is in the same bucket, so her requests are refused too, but quickly, and the partition is alive for everyone who gets through.`, sw: { buckets: true }, run: (s) => { s.schedule(300, () => startMaya(s, 'add', 'Socks')); s.schedule(500, () => s.inject('router', 'flood')); s.schedule(3500, () => startMaya(s, 'refresh')); s.schedule(6000, () => startMaya(s, 'add', 'Hat')); } },
      { id: 'fixed-quota', label: 'Busy sale, fixed quota: throttled with room to spare', desc: `${MODERATE} reads a second, well inside what the node can do, but above Partition 1's ${QUOTA} req/s share. The bucket throttles a third of the traffic while Partition 2 sits idle.`, sw: { buckets: true }, run: (s) => { s.schedule(300, () => startMaya(s, 'add', 'Socks')); s.schedule(500, () => s.inject('router', 'moderate')); s.schedule(3500, () => startMaya(s, 'refresh')); s.schedule(6000, () => startMaya(s, 'add', 'Hat')); } },
      { id: 'adaptive', label: 'Busy sale, adaptive capacity', desc: `The same ${MODERATE} reads a second. Partition 2 uses ${STEADY} of its ${QUOTA}, so Partition 1's bucket is raised with the difference. Nothing is throttled and the node is still comfortable.`, sw: { buckets: true, adaptive: true }, run: (s) => { s.schedule(300, () => startMaya(s, 'add', 'Socks')); s.schedule(500, () => s.inject('router', 'moderate')); s.schedule(3500, () => startMaya(s, 'refresh')); s.schedule(6000, () => startMaya(s, 'add', 'Hat')); } },
      { id: 'cache', label: 'Flash sale through the cache', desc: `The deal is a catalog key, so after one miss the cache answers the ${Y.num(FLOOD)} reads a second. Partition 1 sees the steady load plus one read per TTL. Maya does not notice the sale.`, sw: { cache: true }, run: (s) => { s.schedule(300, () => startMaya(s, 'add', 'Socks')); s.schedule(500, () => s.inject('router', 'flood')); s.schedule(3500, () => startMaya(s, 'refresh')); s.schedule(6000, () => startMaya(s, 'add', 'Hat')); } },
      { id: 'cache-stale', label: 'The cache serves an old price', desc: `Mid-sale, Dev changes the deal price. The partition has the new price; the cache keeps the old one until its ${CACHE_TTL / 1000} s TTL expires, and every read in between is stale. Invalidating on write is the fix this cache does not have.`, sw: { cache: true }, run: (s) => { s.schedule(500, () => s.inject('router', 'flood')); s.schedule(5800, () => startDeal(s)); s.schedule(6300, () => startMaya(s, 'refresh')); } },
      { id: 'cache-down', label: 'Cache down during the sale', desc: 'The cache was carrying the sale. Without it every read goes to Partition 1 again, and the node melts like it did without a cache.', sw: { cache: true }, run: (s) => { s.schedule(300, () => startMaya(s, 'add', 'Socks')); s.schedule(500, () => s.inject('router', 'flood')); s.schedule(2500, () => s.inject('cache', 'down')); s.schedule(6000, () => startMaya(s, 'refresh')); } },
      { id: 'split-hot-key', label: 'Splitting does nothing for one hot key', desc: `Split for heat is on. The worker splits Partition 1 where the traffic divides, which is at the deal itself. The deal moves to Partition 3 alone and keeps melting a node; Maya's cart stays on a now-quiet Partition 1. A single item cannot be split.`, sw: { autoSplit: true }, run: (s) => { s.schedule(300, () => startMaya(s, 'add', 'Socks')); s.schedule(500, () => s.inject('router', 'flood')); s.schedule(5500, () => startMaya(s, 'refresh')); } },
      { id: 'noisy-meltdown', label: 'Noisy tenant, no split', desc: `A tenant writes ${NOISY} times a second across sixty keys, all in Partition 1. Together with the steady load that is more than the node serves. Maya's refresh queues and times out.`, run: (s) => { s.schedule(300, () => startMaya(s, 'add', 'Socks')); s.schedule(500, () => s.inject('router', 'noisy')); s.schedule(4000, () => startMaya(s, 'refresh')); } },
      { id: 'noisy-split', label: 'Noisy tenant, split for heat', desc: `Same tenant with the split worker on. The traffic midpoint falls inside the tenant's keys, so half of them move to Partition 3. Both partitions end up under capacity and Maya's refresh is quick again.`, sw: { autoSplit: true }, run: (s) => { s.schedule(300, () => startMaya(s, 'add', 'Socks')); s.schedule(500, () => s.inject('router', 'noisy')); s.schedule(5500, () => startMaya(s, 'refresh')); } },
      { id: 'admission-down', label: 'Admission controller down: fail open', desc: 'Token buckets are on, but the controller is unreachable. The router forwards everything rather than refuse everything, and the flood reaches the node.', sw: { buckets: true }, run: (s) => { s.inject('admission', 'down'); s.schedule(300, () => startMaya(s, 'add', 'Socks')); s.schedule(500, () => s.inject('router', 'flood')); s.schedule(4000, () => startMaya(s, 'refresh')); } },
    ]),
    initialState: () => ({
      config: { buckets: false, adaptive: false, cache: false, autoSplit: false },
      parts: { p1: { lo: 'a', hi: 'n' }, p2: { lo: 'n', hi: '~' }, p3: null },
      data: { p1: { [HOT]: { price: 20, v: 0 } }, p2: {}, p3: {} },
      bucket: { p1: BURST, p2: BURST, p3: BURST },
      win: { p1: { admitted: 0, throttled: 0, keys: {} }, p2: { admitted: 0, throttled: 0, keys: {} }, p3: { admitted: 0, throttled: 0, keys: {} } },
      last: {}, hotSince: {}, cache: {}, cacheStats: { hits: 0, misses: 0 }, dealVersion: 0, splitting: false, acked: null,
      bg: { throttled: 0, failed: 0, staleDeal: 0 }, stats: { splits: 0, throttled: 0 },
    }),
    initialUI: () => ({ maya: { cart: [], pending: false, error: '', lastMs: null, lastErr: '' } }),
    actions: {
      add(sim, a) { startMaya(sim, 'add', a.item); },
      refresh(sim) { startMaya(sim, 'refresh'); },
      flood(sim, a) { sim.restore('router', 'moderate'); if (a.on) sim.inject('router', 'flood'); else sim.restore('router', 'flood'); },
      noisy(sim, a) { if (a.on) sim.inject('router', 'noisy'); else sim.restore('router', 'noisy'); },
      deal(sim) { startDeal(sim); },
      split(sim) { sim.spawn(function* (ctx) { yield* splitPartition(ctx, 'p1', true); }, { self: 'splitter' }); },
    },
    handlers: {
      router: {
        get: function* (ctx, p) { return yield* route(ctx, 'get', p); },
        put: function* (ctx, p) { return yield* route(ctx, 'put', p); },
      },
      admission: {
        check(ctx, p) {
          const st = ctx.state;
          if (st.bucket[p.part] >= 1) { st.bucket[p.part] -= 1; return { admitted: true }; }
          st.stats.throttled++;
          ctx.fail('THROTTLED', `${NAME[p.part]} is over its quota (${Math.round(quotaOf(st, p.part))} req/s); try again later.`);
        },
      },
      cache: {
        get(ctx, p) { const e = ctx.state.cache[p.key]; if (e && e.exp > ctx.now()) { ctx.state.cacheStats.hits++; return { hit: true, value: e.value }; } ctx.state.cacheStats.misses++; return { hit: false }; },
        set(ctx, p) { ctx.state.cache[p.key] = { value: p.value, exp: ctx.now() + CACHE_TTL }; return {}; },
      },
      p1: partition('p1'), p2: partition('p2'),
      p3: Object.assign(partition('p3'), { import: function* (ctx, p) { yield ctx.wait(COPY_MS); return { copied: Object.keys(ctx.state.data[p.from]).filter((k) => k >= p.mid).length }; } }),
    },
    setup(sim) {
      // Traffic window: once a second the counters become "last second" and the split worker's view.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(WINDOW);
          const st = ctx.state;
          for (const p of PARTS) { st.last[p] = st.win[p]; st.win[p] = { admitted: 0, throttled: 0, keys: {} }; }
        }
      }, { self: 'router', quiet: 'all' });
      // Token bucket refill.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(50);
          const st = ctx.state;
          for (const p of PARTS) st.bucket[p] = Math.min(BURST, st.bucket[p] + quotaOf(st, p) * 0.05);
        }
      }, { self: 'admission', quiet: 'all' });
      // Split worker.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(250);
          const st = ctx.state;
          if (!ctx.alive() || !st.config.autoSplit || st.parts.p3) continue;
          for (const p of ['p1', 'p2']) {
            const hot = ctx.sim.queueWait(p) > SLO || lastRps(st, p) > 0.8 * NODE_CAP;
            if (!hot) { st.hotSince[p] = 0; continue; }
            if (!st.hotSince[p]) st.hotSince[p] = ctx.now();
            if (ctx.now() - st.hotSince[p] >= SPLIT_AFTER) yield* splitPartition(ctx, p, false);
          }
        }
      }, { self: 'splitter', quiet: 'all' });
      Y.load(sim, 'router', () => STEADY, function* (c, i) { yield* bgRequest(c, i % 10 < 7 ? 'get' : 'put', CART_KEYS[(i * 37) % CART_KEYS.length]); });
      Y.load(sim, 'router', () => STEADY, function* (c, i) { yield* bgRequest(c, i % 10 < 7 ? 'get' : 'put', ORDER_KEYS[(i * 53) % ORDER_KEYS.length]); });
      Y.load(sim, 'router', (s) => floodRate(s), function* (c) { yield* bgRequest(c, 'get', HOT); });
      Y.load(sim, 'router', (s) => noisyRate(s), function* (c, i) { yield* bgRequest(c, 'put', NOISY_KEYS[(i * 7) % NOISY_KEYS.length]); });
    },
    consistency(sim) {
      const st = sim.state; const u = sim.ui.maya;
      if (u.pending) return { key: 'stale', label: 'Maya is waiting.' };
      if (u.error) return { key: 'stale', label: `Maya's last request failed: ${u.error}` };
      const live = PARTS.filter((p) => st.parts[p]);
      const hotPart = live.find((p) => sim.queueWait(p) > SLO);
      if (hotPart) return { key: 'stale', label: `${NAME[hotPart]} is overloaded: a new request waits ${SDL.fmtMs(sim.queueWait(hotPart))} for its worker. ${partitionOf(st, KEY) === hotPart ? 'Every key in that partition is slow, Maya’s cart included.' : 'Maya’s cart lives elsewhere and is unaffected.'}` };
      const thr = live.find((p) => st.last[p] && st.last[p].throttled > 0.1 * (st.last[p].admitted + st.last[p].throttled));
      if (thr) { const w = st.last[thr]; return { key: 'stale', label: `${NAME[thr]} is throttling ${Math.round(100 * w.throttled / (w.admitted + w.throttled))}% of its requests${st.config.adaptive ? '' : ` while ${live.filter((p) => p !== thr).map((p) => `${NAME[p]} uses ${lastRps(st, p)} of ${QUOTA}`).join(' and ')}`}. The node is healthy; the quota is the limit.` }; }
      const c = st.cache[HOT];
      const dealPart = partitionOf(st, HOT);
      if (st.config.cache && c && c.exp > sim.now && dealPart && st.data[dealPart][HOT] && c.value.v < st.data[dealPart][HOT].v) return { key: 'stale', label: `The cache serves the deal at $${c.value.price}; the partition has $${st.data[dealPart][HOT].price}. ${SDL.fmtMs(c.exp - sim.now)} until the TTL expires. ${st.bg.staleDeal} stale reads so far.` };
      const p = partitionOf(st, KEY);
      const have = st.data[p][KEY] || [];
      if (u.cart.length !== have.length || u.cart.some((it) => !have.includes(it))) return { key: 'stale', label: `The phone shows ${u.cart.join(', ') || 'an empty cart'}; ${NAME[p]} has ${have.join(', ') || 'nothing'}.` };
      const busiest = live.reduce((b, x) => (lastRps(st, x) > lastRps(st, b) ? x : b), live[0]);
      return { key: 'ok', label: `Every partition answers within budget. Busiest: ${NAME[busiest]} at ${Y.num(lastRps(st, busiest))} req/s${st.config.cache && st.cacheStats.hits ? `; the cache absorbs ${Math.round(100 * st.cacheStats.hits / (st.cacheStats.hits + st.cacheStats.misses))}% of catalog reads` : ''}${st.stats.splits ? `; ${st.stats.splits} split` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const rps = (p) => (st.parts[p] ? `${Y.num(lastRps(st, p))}${st.last[p] && st.last[p].throttled ? ` (+${Y.num(st.last[p].throttled)} throttled)` : ''}` : '–');
      const hits = st.cacheStats.hits + st.cacheStats.misses;
      const hotShare = st.last.p1 && st.last.p1.admitted ? Math.round(100 * (st.last.p1.keys[HOT] || 0) / st.last.p1.admitted) : 0;
      return [
        { label: 'Partition 1 / 2 / 3 req/s', value: `${rps('p1')} / ${rps('p2')} / ${rps('p3')}` },
        { label: 'Queue wait P1 / P2 / P3', value: PARTS.map((p) => (st.parts[p] ? SDL.fmtMs(sim.queueWait(p)) : '–')).join(' / '), tone: PARTS.some((p) => st.parts[p] && sim.queueWait(p) > SLO) ? 'fail' : '' },
        { label: 'Quota P1 (effective)', value: st.config.buckets ? `${Math.round(quotaOf(st, 'p1'))} req/s` : 'none' },
        { label: 'Maya’s last request', value: sim.ui.maya.lastMs == null ? '–' : `${SDL.fmtMs(sim.ui.maya.lastMs)}${sim.ui.maya.lastErr ? ` ${sim.ui.maya.lastErr}` : ''}`, tone: sim.ui.maya.lastErr ? 'fail' : sim.ui.maya.lastMs > SLO ? 'warn' : '' },
        { label: 'Hot key share of Partition 1', value: `${hotShare}%`, tone: hotShare > 50 ? 'warn' : '' },
        { label: 'Cache hit ratio', value: hits ? `${Math.round(100 * st.cacheStats.hits / hits)}%` : '–' },
        { label: 'Stale deal reads', value: st.bg.staleDeal, tone: st.bg.staleDeal ? 'warn' : '' },
        { label: 'Throttled / timed out (background)', value: `${Y.num(st.bg.throttled)} / ${Y.num(st.bg.failed)}`, tone: st.bg.failed ? 'fail' : st.bg.throttled ? 'warn' : '' },
        { label: 'Splits', value: st.stats.splits },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Maya’s cart lives in Partition 1 next to the flash-sale deal and the noisy tenant. The console shows each partition’s load against what its node can serve.',
          side: `<p class="ops-title">Partitions</p><div class="ops-traffic">${Y.btn('flood', 'Flash sale on', { arg: { on: true } })}${Y.btn('flood', 'Sale off', { arg: { on: false }, cls: 'secondary' })}${Y.btn('noisy', 'Noisy tenant on', { arg: { on: true }, cls: 'secondary' })}${Y.btn('noisy', 'Tenant off', { arg: { on: false }, cls: 'secondary' })}${Y.btn('deal', 'Change the deal price', { cls: 'secondary' })}${Y.btn('split', 'Split Partition 1 now', { cls: 'secondary' })}</div><div data-ref="parts"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state; const u = sim.ui.maya;
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Cart</p><p class="app-sub">Maya · ${NAME[partitionOf(st, KEY)]}</p></div>`,
          cart: u.cart.length ? u.cart.map((it) => `<div class="app-card"><span class="app-kv"><strong>${esc(it)}</strong><span>1</span></span></div>`).join('') : '<p class="app-sub">Your cart is empty.</p>',
          msg: Y.msg(u.error, 'fail') || (u.pending ? '<p class="app-msg"><span class="spinner"></span>Working…</p>' : u.lastMs != null ? `<p class="app-msg">Last request ${SDL.fmtMs(u.lastMs)}.</p>` : ''),
          actions: `<div class="app-row">${['Socks', 'Hat', 'Mug'].map((it) => Y.btn('add', `Add ${it.toLowerCase()}`, { arg: { item: it }, cls: u.cart.includes(it) ? 'secondary' : '', disabled: u.pending })).join('')}</div><div class="app-row">${Y.btn('refresh', 'Refresh', { cls: 'secondary', disabled: u.pending })}</div>`,
        }, {});
        const rows = PARTS.map((p) => {
          const part = st.parts[p];
          if (!part) return `<div class="ops-row" data-tone="ok"><div class="ops-name"><strong>${NAME[p]}</strong><span>spare node, no range yet</span></div></div>`;
          const w = st.last[p] || { admitted: 0, throttled: 0, keys: {} };
          const q = sim.queueWait(p);
          const tone = dead(sim, p) ? 'fail' : q > SLO ? 'fail' : w.throttled > 0.1 * (w.admitted + w.throttled) || q > 50 ? 'warn' : 'ok';
          const holds = [KEY, HOT].filter((k) => partitionOf(st, k) === p).map((k) => (k === KEY ? 'Maya’s cart' : 'the deal')).join(' and ');
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name"><strong>${NAME[p]} · [${esc(part.lo)}, ${esc(part.hi === '~' ? 'end' : part.hi)})</strong><span>${Y.num(w.admitted)} req/s${w.throttled ? ` · ${Y.num(w.throttled)} throttled` : ''} · queue ${SDL.fmtMs(q)}</span></div><div class="ops-bar"><i style="width:${Math.min(100, Math.round(100 * w.admitted / NODE_CAP))}%"></i></div><span class="ops-val">${holds ? `holds ${holds} · ` : ''}${st.config.buckets ? `quota ${Math.round(quotaOf(st, p))} req/s, ${Math.round(st.bucket[p])} credits` : 'no quota'}</span></div>`;
        }).join('');
        const hits = st.cacheStats.hits + st.cacheStats.misses;
        const c = st.cache[HOT];
        const cacheRow = `<div class="ops-row" data-tone="${dead(sim, 'cache') ? 'fail' : c && st.data[partitionOf(st, HOT)] && st.data[partitionOf(st, HOT)][HOT] && c.exp > sim.now && c.value.v < st.data[partitionOf(st, HOT)][HOT].v ? 'warn' : 'ok'}"><div class="ops-name"><strong>Cache</strong><span>${st.config.cache ? `${hits ? Math.round(100 * st.cacheStats.hits / hits) : 0}% hits` : 'off'}</span></div><span class="ops-val">${c && c.exp > sim.now ? `${HOT} = $${c.value.price}, expires in ${SDL.fmtMs(c.exp - sim.now)}` : 'nothing cached'} · partition has $${(st.data[partitionOf(st, HOT)] || {})[HOT] ? st.data[partitionOf(st, HOT)][HOT].price : '–'}</span></div>`;
        const cs = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="parts"]'), {
          rows: `<div class="ops-shards">${rows}${cacheRow}</div>`,
          cfg: `<p class="app-sub">Each node serves about ${Y.num(NODE_CAP)} req/s. Buckets ${st.config.buckets ? 'on' : 'off'} · adaptive ${st.config.adaptive ? 'on' : 'off'} · cache ${st.config.cache ? 'on' : 'off'} · split for heat ${st.config.autoSplit ? 'on' : 'off'}.</p>`,
          recon: `<p class="recon" data-tone="${cs.key}">${cs.key === 'ok' ? '✓' : cs.key === 'stale' ? '…' : '✕'} ${esc(cs.label)}</p>`,
        }, {});
      },
    },
  });

  function* route(ctx, op, p) {
    const st = ctx.state; const sim = ctx.sim;
    const part = partitionOf(st, p.key);
    if (!part) ctx.fail('INTERNAL', `No partition for ${p.key}`);
    if (st.config.buckets && !dead(sim, 'admission')) {
      const a = yield ctx.call('admission', 'check', { part }, { timeout: 300, quiet: ctx.quiet });
      if (!a.ok) { if (a.error.code === 'THROTTLED') { count(st, part, p.key, 'throttled'); ctx.fail('THROTTLED', a.error.message); } }
    }
    const isCatalog = p.key.startsWith('deal:');
    if (op === 'get' && st.config.cache && isCatalog && !dead(sim, 'cache')) {
      const c = yield ctx.call('cache', 'get', { key: p.key }, { timeout: 300, quiet: ctx.quiet });
      if (c.ok && c.value.hit) return { value: c.value.value, from: 'cache', waited: 0 };
    }
    count(st, part, p.key, 'admitted');
    const waited = sim.queueWait(part);
    const r = ctx.must(yield ctx.call(part, op, p, { timeout: 1400, quiet: ctx.quiet }));
    if (op === 'get' && st.config.cache && isCatalog && !dead(sim, 'cache')) yield ctx.call('cache', 'set', { key: p.key, value: r.value }, { timeout: 300, quiet: 'all' });
    return Object.assign({ waited }, r);
  }
  function partition(id) {
    return {
      get(ctx, p) { return { value: ctx.state.data[id][p.key] || null }; },
      put(ctx, p) { ctx.state.data[id][p.key] = p.value; return { value: p.value }; },
    };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
