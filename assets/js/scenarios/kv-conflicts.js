/*
 * Versioning, vector clocks, and lost updates.
 * One cart, two devices, two coordinators. The phone's cart service writes
 * through Node 1, the tablet's through Node 2; both replicate to N = 3 with
 * W = 2 and read R = 2. The question is what happens when two versions of the
 * same cart meet: last writer wins (with and without clock skew), vector
 * clocks with siblings the cart service merges by union, the removed item
 * that comes back after a merge, tombstones that stop it, and the false
 * siblings a retry creates when the coordinator, not the device, is the
 * actor in the clock.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const V = Y.vclock;
  const K = Y.kv;

  const KEY = 'cart:maya';
  const OWNERS = ['n1', 'n2', 'n3'];
  const N = 3;
  const W = 2;
  const R = 2;
  const REPLICA_TIMEOUT = 600;
  const COORD_TIMEOUT = 900;
  const SKEW_MS = 2000;
  const NAME = { n1: 'Node 1', n2: 'Node 2', n3: 'Node 3', cartA: 'Cart service A', cartB: 'Cart service B' };
  const DEVICE = { maya: 'phone', tablet: 'tablet' };
  const SERVICE = { maya: 'cartA', tablet: 'cartB' };
  const COORDS = { cartA: ['n1', 'n2', 'n3'], cartB: ['n2', 'n1', 'n3'] };

  const dead = (sim, n) => !!(sim.nodes[n].modes.down || sim.nodes[n].modes.crashed);
  const skewOf = (sim, n) => (sim.nodes[n].modes.behind ? -SKEW_MS : sim.nodes[n].modes.ahead ? SKEW_MS : 0);
  const held = (st, n) => st.store[n] || [];
  const reconcile = (st, versions) => K.reconcile(versions, st.config.vclock);
  function applyWrite(st, node, incoming, context) {
    const res = K.applyWrite(held(st, node), incoming, context, st.config.vclock);
    st.store[node] = res.versions;
    for (const it of res.lost) if (!st.lost.includes(it)) st.lost.push(it);
    return res;
  }
  const truth = (sim) => reconcile(sim.state, OWNERS.flatMap((n) => held(sim.state, n)));
  const fmtVersion = (st, v) => `[${v.items.join(', ') || 'empty'}]${v.tombs && v.tombs.length ? ` −${v.tombs.join(',')}` : ''} ${st.config.vclock ? V.fmt(v.clock) : `t=${v.ts}`}`;

  /* ---------- devices ---------- */
  function startMutate(sim, dev, op, item) {
    const u = sim.ui[dev];
    sim.startAction(`Maya (${DEVICE[dev]}): ${op === 'add' ? 'add' : 'remove'} ${item}`, function* (ctx) {
      const st = ctx.state;
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', st.config.devClock ? 'A retry carries the same device clock, so it is the same version.' : 'A retry gets a fresh coordinator clock: the store may keep it as a second version.'] });
      const r = yield ctx.call(SERVICE[dev], 'mutate', { op, item, device: dev, items: u.cart, tombs: u.tombs, context: u.clock }, { timeout: 2600 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency;
      if (!r.ok) {
        u.error = r.error.message;
        Y.failed(ctx, 'The cart shows an error and is unchanged.');
        ctx.explain(r.error.code === 'QUORUM' ? `Fewer than W = ${W} replicas acknowledged, so the coordinator refused the write.` : r.error.message);
        return;
      }
      const v = r.value;
      u.cart = v.items; u.tombs = v.tombs; u.clock = v.clock; u.lastWrite = v;
      if (op === 'add') { if (!st.acked.includes(item)) st.acked.push(item); st.removed = st.removed.filter((x) => x !== item); } else { if (!st.removed.includes(item)) st.removed.push(item); st.acked = st.acked.filter((x) => x !== item); }
      Y.L(ctx, {
        displayed: ['yes', `${v.items.length} item${v.items.length === 1 ? '' : 's'}.`],
        accepted: ['yes', `${NAME[v.coordinator]} coordinated${v.attempts > 1 ? ` on attempt ${v.attempts}` : ''}.`],
        committed: ['yes', `${v.acked.length} copies: ${v.acked.map((n) => NAME[n]).join(', ')}.`],
        async: v.acked.length >= N ? 'yes' : ['pending', 'Third replica.'],
      });
      const skew = v.skew ? ` ${NAME[v.coordinator]}’s clock is ${Math.abs(v.skew) / 1000} s ${v.skew < 0 ? 'behind' : 'ahead'}, so it stamped the write t=${v.ts} instead of ${v.ts - v.skew}.` : '';
      const clockTxt = st.config.vclock ? ` Version clock ${V.fmt(v.clock)}${v.attempts > 1 && !st.config.devClock ? ` (the first attempt was stamped by ${NAME[v.firstCoordinator]}, so two concurrent versions now exist with the same items)` : ''}.` : ` Stamped t=${v.ts}.${skew}`;
      ctx.explain(`${op === 'add' ? 'Added' : 'Removed'} “${item}” from the ${DEVICE[dev]} via ${NAME[SERVICE[dev]]} and ${NAME[v.coordinator]}${v.attempts > 1 ? ` after ${NAME[v.firstCoordinator]} did not answer` : ''}; ${v.acked.length} replicas acknowledged in ${SDL.fmtMs(r.latency)}.${clockTxt}${v.siblings > 1 ? ` The replicas hold ${v.siblings} siblings; the cart service merges them by union${st.config.tombstones ? ', removals winning' : ''} on the next read.` : ''}${op === 'remove' && !st.config.tombstones ? ' Without a tombstone, nothing records that the item was removed: a concurrent version that still has it will bring it back.' : ''}`);
    }, { self: dev });
  }
  function startRefresh(sim, dev) {
    const u = sim.ui[dev];
    sim.startAction(`Maya (${DEVICE[dev]}): refresh cart`, function* (ctx) {
      const st = ctx.state;
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call(SERVICE[dev], 'read', { device: dev }, { timeout: 2600 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency;
      if (!r.ok) { u.error = r.error.message; Y.failed(ctx, 'Not refreshed.'); ctx.explain(r.error.message); return; }
      const v = r.value;
      const before = u.cart.slice();
      u.cart = v.items; u.tombs = v.tombs; u.clock = v.clock;
      Y.L(ctx, { displayed: ['yes', `${v.items.length} item${v.items.length === 1 ? '' : 's'}.`], accepted: 'yes', committed: 'n/a', async: 'n/a' });
      const back = st.removed.filter((it) => v.items.includes(it));
      const same = before.length === v.items.length && before.every((it) => v.items.includes(it));
      ctx.explain(`${NAME[v.coordinator]} read R = ${R} (${v.from.map((n) => NAME[n]).join(', ')})${v.siblings > 1 ? ` and found ${v.siblings} siblings with clocks ${v.clocks.map((c) => V.fmt(c)).join(' and ')}: concurrent, so neither replaces the other. The cart service merged them by union${v.tombs.length ? `, dropping ${v.tombs.join(', ')} because a sibling carries its tombstone` : ''}` : ''}. ${same ? 'Same cart as before.' : `The ${DEVICE[dev]} now shows ${v.items.join(', ') || 'an empty cart'}.`}${back.length ? ` “${back.join('”, “')}” is back although Maya removed it: the removal was a plain overwrite of the list, and the union with a concurrent version that still had the item re-added it.` : ''}${st.config.vclock ? '' : ` Last writer wins: the replicas kept the version with the latest timestamp, t=${v.ts}.`}`);
    }, { self: dev });
  }

  /* ---------- cart service ---------- */
  function cartService(id) {
    return {
      mutate: function* (ctx, p) {
        const st = ctx.state;
        let items = p.items.slice(); let tombs = (p.tombs || []).slice();
        if (p.op === 'add') { if (!items.includes(p.item)) items.push(p.item); tombs = tombs.filter((x) => x !== p.item); } else { items = items.filter((x) => x !== p.item); if (st.config.tombstones && !tombs.includes(p.item)) tombs.push(p.item); }
        let firstCoordinator = null;
        const r = yield* ctx.retry({ attempts: 2, baseMs: 60, jitter: 0, retryable: (x) => x.error && (x.error.code === 'TIMEOUT' || x.error.code === 'UNAVAILABLE') }, function* (attempt) {
          const live = COORDS[id].filter((n) => !dead(ctx.sim, n));
          const coord = live[Math.min(attempt - 1, live.length - 1)];
          if (!coord) return { ok: false, error: { code: 'UNAVAILABLE', message: 'No replica is up.' } };
          if (attempt === 1) firstCoordinator = coord;
          if (attempt > 1) ctx.log({ op: `retry via ${NAME[coord]}`, status: 'warn', detail: `${NAME[firstCoordinator]} did not answer within ${COORD_TIMEOUT} ms. The cart service does not know whether the write landed, so it retries through the next node in the preference list.` });
          return yield ctx.call(coord, 'coordinatePut', { items, tombs, context: p.context, device: p.device }, { timeout: COORD_TIMEOUT });
        });
        const v = ctx.must(r);
        return Object.assign(v, { attempts: r.attempts, firstCoordinator });
      },
      read: function* (ctx) {
        const coord = COORDS[id].find((n) => !dead(ctx.sim, n));
        if (!coord) ctx.fail('UNAVAILABLE', 'No replica is up.');
        return ctx.must(yield ctx.call(coord, 'coordinateGet', {}, { timeout: 2000 }));
      },
    };
  }

  /* ---------- replicas ---------- */
  function replica(id) {
    return {
      coordinatePut: function* (ctx, p) {
        const st = ctx.state;
        const context = p.context || {};
        const actor = st.config.devClock ? p.device : id;
        const clock = st.config.vclock ? V.inc(context, actor) : {};
        const skew = skewOf(ctx.sim, id);
        const version = { items: p.items, tombs: p.tombs, clock, ts: ctx.now() + skew, device: p.device, by: id };
        st.stats.puts++;
        const local = applyWrite(st, id, version, context);
        const acked = [id]; const failed = []; let pending = 0;
        for (const n of OWNERS.filter((x) => x !== id)) {
          pending++;
          ctx.spawn(function* (c) { const r = yield c.call(n, 'store', { version, context }, { timeout: REPLICA_TIMEOUT }); pending--; if (r.ok) acked.push(n); else failed.push(n); });
        }
        while (acked.length < W && pending > 0) yield ctx.wait(5);
        if (acked.length < W) ctx.fail('QUORUM', `Only ${acked.length} of W = ${W} replicas acknowledged (${failed.map((n) => NAME[n]).join(', ')} did not answer).`);
        const actionId = ctx.actionId;
        ctx.spawn(function* (c) { while (pending > 0) yield c.wait(10); if (acked.length >= N) ctx.sim.setLedger(actionId, 'async', 'yes', `All ${N} copies written.`); }, { actionId });
        const view = reconcile(st, held(st, id));
        return { coordinator: id, items: view.items, tombs: view.tombs, clock: view.clock, ts: version.ts, skew, acked: acked.slice(), siblings: Math.max(view.siblings, local.siblings) };
      },
      coordinateGet: function* (ctx) {
        const st = ctx.state;
        st.stats.gets++;
        const responses = [{ node: id, versions: held(st, id).slice() }];
        let pending = 0;
        for (const n of OWNERS.filter((x) => x !== id)) {
          pending++;
          ctx.spawn(function* (c) { const x = yield c.call(n, 'read', {}, { timeout: REPLICA_TIMEOUT }); pending--; if (x.ok) responses.push({ node: n, versions: x.value.versions }); });
        }
        while (responses.length < R && pending > 0) yield ctx.wait(5);
        if (responses.length < R) ctx.fail('QUORUM', `Only ${responses.length} of R = ${R} replicas answered.`);
        const used = responses.slice(0, R);
        const all = used.flatMap((x) => x.versions);
        const merged = reconcile(st, all);
        const sib = st.config.vclock ? V.siblings(all) : [];
        if (merged.siblings > 1) st.stats.merges++;
        return { coordinator: id, from: used.map((x) => x.node), items: merged.items, tombs: merged.tombs, clock: merged.clock, ts: merged.ts, siblings: merged.siblings, clocks: sib.map((v) => v.clock) };
      },
      store(ctx, p) { const res = applyWrite(ctx.state, id, p.version, p.context || {}); return { stored: res.kept === 'new', siblings: res.siblings }; },
      read(ctx) { return { versions: held(ctx.state, id).slice() }; },
    };
  }

  const both = (s, t, item) => { s.schedule(t, () => startMutate(s, 'maya', 'add', item[0])); s.schedule(t, () => startMutate(s, 'tablet', 'add', item[1])); };
  const refreshBoth = (s, t) => { s.schedule(t, () => startRefresh(s, 'maya')); s.schedule(t + 250, () => startRefresh(s, 'tablet')); };
  const shareCart = (s) => { s.schedule(300, () => startMutate(s, 'maya', 'add', 'Socks')); s.schedule(700, () => startMutate(s, 'maya', 'add', 'Hat')); s.schedule(1100, () => startRefresh(s, 'tablet')); };

  const sc = (SDL.scenarios['kv-conflicts'] = {
    id: 'kv-conflicts',
    seed: 37,
    productWidth: 640,
    intro: 'Add an item on both devices at the same moment, first with last writer wins and then with vector clocks. Then remove an item on one device while the other adds, with tombstones off and on, and watch a dropped reply create two versions of the same cart.',
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'Zone A', x: 90, y: 120, latency: 1, role: 'Holds the cart it last read plus the version clock it came with (its context). Every write sends the whole cart and that context.', owns: ['What the phone shows', 'Context clock'] },
        { id: 'tablet', label: 'Maya’s tablet', kind: 'client', sub: 'Zone B', x: 90, y: 460, latency: 1, role: 'Same app, other device, other zone. Served by Cart service B and Node 2.', owns: ['What the tablet shows', 'Context clock'] },
        { id: 'cartA', label: 'Cart service A', kind: 'service', sub: 'Merges siblings', x: 340, y: 120, latency: 2, role: 'The application layer. Builds the new cart from the device’s copy, writes it through Node 1 (Node 2 on a timeout), and merges siblings by union on read: adds win, unless a tombstone says an item was removed.', ops: [{ name: 'mutate', desc: 'Add or remove an item.' }, { name: 'read', desc: 'Read and merge.' }], owns: ['Merge rule', 'Nothing durable'] },
        { id: 'cartB', label: 'Cart service B', kind: 'service', sub: 'Merges siblings', x: 340, y: 460, latency: 2, role: 'The tablet’s instance of the same service, writing through Node 2 (Node 1 on a timeout).', ops: [{ name: 'mutate', desc: 'Add or remove an item.' }, { name: 'read', desc: 'Read and merge.' }], owns: ['Merge rule', 'Nothing durable'] },
        { id: 'n1', label: 'Node 1', kind: 'db', sub: 'Replica · phone’s coordinator', x: 640, y: 90, latency: 3, role: `Stamps each version with a clock (vector clock, or its wall-clock time for last writer wins), stores it, replicates to the other owners, and acknowledges at W = ${W}.`, ops: [{ name: 'coordinatePut', desc: 'Stamp, store, replicate.' }, { name: 'coordinateGet', desc: `Read R = ${R}, return versions.` }, { name: 'store', desc: 'Store a version.' }, { name: 'read', desc: 'Local versions.' }], owns: ['Versions of the cart'] },
        { id: 'n2', label: 'Node 2', kind: 'db', sub: 'Replica · tablet’s coordinator', x: 640, y: 480, latency: 3, role: 'The tablet’s coordinator. Its wall clock can be skewed, which matters only for last writer wins.', ops: [{ name: 'coordinatePut', desc: 'Stamp, store, replicate.' }, { name: 'coordinateGet', desc: `Read R = ${R}.` }, { name: 'store', desc: 'Store a version.' }, { name: 'read', desc: 'Local versions.' }], owns: ['Versions of the cart'] },
        { id: 'n3', label: 'Node 3', kind: 'db', sub: 'Replica', x: 940, y: 285, latency: 3, role: 'Third owner. Receives every version from both coordinators and keeps siblings when their clocks are concurrent.', ops: [{ name: 'store', desc: 'Store a version.' }, { name: 'read', desc: 'Local versions.' }], owns: ['Versions of the cart'] },
      ],
      edges: [
        { from: 'maya', to: 'cartA', latency: 40 },
        { from: 'tablet', to: 'cartB', latency: 40 },
        { from: 'cartA', to: 'n1', latency: 2 },
        { from: 'cartA', to: 'n2', latency: 4 },
        { from: 'cartB', to: 'n2', latency: 2 },
        { from: 'cartB', to: 'n1', latency: 4 },
        { from: 'n1', to: 'n2', latency: 2 },
        { from: 'n1', to: 'n3', latency: 2 },
        { from: 'n2', to: 'n3', latency: 2 },
      ],
      queues: [],
    },
    modeLabels: { behind: `Clock ${SKEW_MS / 1000} s behind`, ahead: `Clock ${SKEW_MS / 1000} s ahead` },
    failures: [
      { id: 'n2-behind', node: 'n2', mode: 'behind', label: `Node 2’s clock is ${SKEW_MS / 1000} s behind`, desc: 'Every version it stamps looks older than it is. Under last writer wins its writes lose to anything written in the last two seconds.' },
      { id: 'n2-ahead', node: 'n2', mode: 'ahead', label: `Node 2’s clock is ${SKEW_MS / 1000} s ahead`, desc: 'Its versions look newer than they are: for two seconds, nothing written through Node 1 can replace them.' },
      { id: 'n1-drop', node: 'n1', mode: 'dropResponse', label: 'Node 1 loses its replies', desc: 'The write lands and replicates, but Cart service A never hears. It retries through Node 2.' },
      { id: 'n1-down', node: 'n1', mode: 'down', label: 'Node 1 down', desc: 'Cart service A falls back to Node 2. Both devices now share a coordinator.' },
      { id: 'n3-down', node: 'n3', mode: 'down', label: 'Node 3 down', desc: `W = ${W} is still reachable with Nodes 1 and 2; Node 3 falls behind and catches up on the next write it receives.` },
      { id: 'n2-slow', node: 'n2', mode: 'slow', params: { factor: 60 }, label: 'Node 2 slow', desc: 'Writes through it take long enough that an impatient cart service retries elsewhere.' },
    ],
    switches: Y.switches([
      ['vclock', 'Vector clocks (off: last writer wins)', 'Each version carries a clock; concurrent versions are kept as siblings for the cart service to merge. Off: the replica keeps whichever version has the later wall-clock timestamp.'],
      ['tombstones', 'Tombstones for removed items', 'A removal records the item as removed inside the version, so a merge with a concurrent version that still has it drops it. Off: a removal is just a shorter list, and a union merge brings the item back.'],
      ['devClock', 'Device is the clock actor (off: coordinator)', 'The counter in the vector clock belongs to the device that wrote, so a retried write has the same clock. Off: the coordinator’s counter is used, as in the Dynamo paper, and a retry through another coordinator makes a second, concurrent version with identical contents.'],
    ]),
    presets: Y.presets({ vclock: true, tombstones: true, devClock: true }, [
      { id: 'sequential', label: 'One after the other: no conflict', desc: 'The phone adds socks. The tablet refreshes, sees them, and adds a hat from that context. Its clock dominates the phone’s version, so the replicas keep one version.', run: (s) => { s.schedule(300, () => startMutate(s, 'maya', 'add', 'Socks')); s.schedule(900, () => startRefresh(s, 'tablet')); s.schedule(1500, () => startMutate(s, 'tablet', 'add', 'Hat')); s.schedule(2200, () => startRefresh(s, 'maya')); } },
      { id: 'concurrent-lww', label: 'Same moment, last writer wins', desc: 'Both devices add an item at the same instant from an empty cart. Each coordinator stamps its wall clock; the replicas keep the later stamp. One acknowledged item is gone.', sw: { vclock: false }, run: (s) => { both(s, 300, ['Socks', 'Hat']); refreshBoth(s, 1500); } },
      { id: 'concurrent-vclock', label: 'Same moment, vector clocks', desc: 'The same two writes with clocks {phone:1} and {tablet:1}: concurrent, so every replica keeps both as siblings. Each device’s refresh merges them by union. A later write from the merged context collapses the siblings into one version.', run: (s) => { both(s, 300, ['Socks', 'Hat']); refreshBoth(s, 1500); s.schedule(2400, () => startMutate(s, 'maya', 'add', 'Mug')); s.schedule(3200, () => startRefresh(s, 'tablet')); } },
      { id: 'skew-lww', label: 'Clock skew: the later write loses', desc: `Last writer wins, and Node 2’s clock is ${SKEW_MS / 1000} s behind. The phone adds socks; the tablet refreshes, sees them, and adds a hat half a second later. Node 2 stamps the hat with an older time, so every replica keeps the socks-only version. The tablet was told “saved”.`, sw: { vclock: false }, run: (s) => { s.inject('n2', 'behind'); s.schedule(300, () => startMutate(s, 'maya', 'add', 'Socks')); s.schedule(900, () => startRefresh(s, 'tablet')); s.schedule(1500, () => startMutate(s, 'tablet', 'add', 'Hat')); refreshBoth(s, 2400); } },
      { id: 'skew-vclock', label: 'Clock skew: vector clocks do not care', desc: 'The same skew and the same writes with vector clocks. The hat’s clock descends from the socks’ clock, so it dominates regardless of what the wall clocks say.', run: (s) => { s.inject('n2', 'behind'); s.schedule(300, () => startMutate(s, 'maya', 'add', 'Socks')); s.schedule(900, () => startRefresh(s, 'tablet')); s.schedule(1500, () => startMutate(s, 'tablet', 'add', 'Hat')); refreshBoth(s, 2400); } },
      { id: 'stale-context-lww', label: 'Writing from a stale read, last writer wins', desc: 'The tablet never refreshed, so it still believes the cart is empty. A second after the phone adds socks, the tablet adds a hat from that stale context. Last writer wins replaces the whole cart: socks gone. The classic lost update.', sw: { vclock: false }, run: (s) => { s.schedule(300, () => startMutate(s, 'maya', 'add', 'Socks')); s.schedule(1300, () => startMutate(s, 'tablet', 'add', 'Hat')); refreshBoth(s, 2200); } },
      { id: 'stale-context-vclock', label: 'Writing from a stale read, vector clocks', desc: 'The same stale write. Its clock {tablet:1} does not descend from {phone:1}, so the replicas keep both and the merge has both items. The store cannot tell “stale context” from “concurrent”, and does not need to.', run: (s) => { s.schedule(300, () => startMutate(s, 'maya', 'add', 'Socks')); s.schedule(1300, () => startMutate(s, 'tablet', 'add', 'Hat')); refreshBoth(s, 2200); } },
      { id: 'remove-resurrect', label: 'The removed item comes back', desc: 'Both devices show socks and a hat. At the same moment the phone removes the socks and the tablet adds a mug. Without tombstones the phone’s version is just a shorter list; the union merge puts the socks back in the cart.', sw: { tombstones: false }, run: (s) => { shareCart(s); s.schedule(1700, () => startMutate(s, 'maya', 'remove', 'Socks')); s.schedule(1700, () => startMutate(s, 'tablet', 'add', 'Mug')); refreshBoth(s, 2800); } },
      { id: 'remove-tombstone', label: 'Tombstones: the removal wins', desc: 'The same race with tombstones. The phone’s version records “socks removed”, so when the cart service merges the siblings the socks stay out and the mug stays in.', run: (s) => { shareCart(s); s.schedule(1700, () => startMutate(s, 'maya', 'remove', 'Socks')); s.schedule(1700, () => startMutate(s, 'tablet', 'add', 'Mug')); refreshBoth(s, 2800); } },
      { id: 'retry-false-sibling', label: 'A retry makes a false sibling', desc: 'The coordinator is the clock actor and Node 1 loses its reply. The write landed on all three replicas as {n1:1}. Cart service A retries through Node 2, which stamps the same cart {n2:1}: concurrent with the first, so every replica now holds two siblings with identical contents. Harmless for a cart, but every retry grows the clock and the sibling count.', sw: { devClock: false }, run: (s) => { s.inject('n1', 'dropResponse'); s.schedule(300, () => startMutate(s, 'maya', 'add', 'Socks')); s.schedule(2600, () => s.restore('n1')); s.schedule(3200, () => startRefresh(s, 'tablet')); } },
      { id: 'retry-device-clock', label: 'The same retry with device clocks', desc: 'With the device as actor the retry carries the same clock {phone:1}. The replicas recognise the version they already hold and keep exactly one.', run: (s) => { s.inject('n1', 'dropResponse'); s.schedule(300, () => startMutate(s, 'maya', 'add', 'Socks')); s.schedule(2600, () => s.restore('n1')); s.schedule(3200, () => startRefresh(s, 'tablet')); } },
    ]),
    initialState: () => ({ config: { vclock: true, tombstones: true, devClock: true }, store: { n1: [], n2: [], n3: [] }, acked: [], removed: [], lost: [], stats: { puts: 0, gets: 0, merges: 0 } }),
    initialUI: () => ({
      maya: { cart: [], tombs: [], clock: {}, pending: false, error: '', lastMs: null, lastWrite: null },
      tablet: { cart: [], tombs: [], clock: {}, pending: false, error: '', lastMs: null, lastWrite: null },
    }),
    actions: {
      add(sim, a) { startMutate(sim, a.device, 'add', a.item); },
      remove(sim, a) { startMutate(sim, a.device, 'remove', a.item); },
      refresh(sim, a) { startRefresh(sim, a.device); },
    },
    handlers: { cartA: cartService('cartA'), cartB: cartService('cartB'), n1: replica('n1'), n2: replica('n2'), n3: replica('n3') },
    setup() {},
    consistency(sim) {
      const st = sim.state;
      const ui = sim.ui;
      const t = truth(sim);
      const skewed = OWNERS.find((n) => skewOf(sim, n));
      if (st.lost.length) return { key: 'wrong', label: `“${st.lost.join('”, “')}” ${st.lost.length === 1 ? 'was' : 'were'} acknowledged and then discarded by last writer wins${skewed ? `: ${NAME[skewed]}’s skewed clock decided which version was “last”` : ''}. The device that wrote ${st.lost.length === 1 ? 'it' : 'them'} was told “saved”.` };
      const back = st.removed.filter((it) => t.items.includes(it));
      if (back.length) return { key: 'wrong', label: `Maya removed “${back.join('”, “')}” and was told so, but the store has ${back.length === 1 ? 'it' : 'them'} again: a union merge with a concurrent version re-added ${back.length === 1 ? 'it' : 'them'}. The removal is lost.` };
      for (const dev of ['maya', 'tablet']) {
        if (ui[dev].pending) return { key: 'stale', label: `The ${DEVICE[dev]} is waiting.` };
        if (ui[dev].error) return { key: 'stale', label: `The ${DEVICE[dev]}’s last request failed: ${ui[dev].error}` };
      }
      const gone = st.acked.filter((it) => !t.items.includes(it));
      if (gone.length) return { key: 'wrong', label: `“${gone.join('”, “')}” ${gone.length === 1 ? 'was' : 'were'} acknowledged and ${gone.length === 1 ? 'is' : 'are'} on no replica.` };
      for (const dev of ['maya', 'tablet']) {
        const diff = t.items.filter((it) => !ui[dev].cart.includes(it)).concat(ui[dev].cart.filter((it) => !t.items.includes(it)));
        if (diff.length) return { key: 'stale', label: `The ${DEVICE[dev]} shows ${ui[dev].cart.join(', ') || 'an empty cart'}; the store’s merged cart is ${t.items.join(', ') || 'empty'}. A refresh would fix it.` };
      }
      const down = OWNERS.filter((n) => dead(sim, n));
      if (down.length) return { key: 'stale', label: `${down.map((n) => NAME[n]).join(', ')} down: fewer than ${N} copies reachable.` };
      const behind = OWNERS.filter((n) => { const v = reconcile(st, held(st, n)); return t.items.some((it) => !v.items.includes(it)) || v.items.some((it) => !t.items.includes(it)); });
      if (behind.length) return { key: 'stale', label: `${behind.map((n) => NAME[n]).join(', ')} ${behind.length === 1 ? 'is' : 'are'} behind the other replicas. R = ${R} masks it; the next write it receives catches it up.` };
      const sib = Math.max(...OWNERS.map((n) => held(st, n).length), 0);
      return { key: 'ok', label: `Both devices and all ${N} replicas agree on ${t.items.length} item${t.items.length === 1 ? '' : 's'}${sib > 1 ? `, held as ${sib} siblings${st.config.devClock ? '' : ' (two of them identical: the retry)'} until the next write collapses them` : ''}${st.stats.merges ? `; ${st.stats.merges} merge${st.stats.merges === 1 ? '' : 's'} on read` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const t = truth(sim);
      const sib = Math.max(...OWNERS.map((n) => held(st, n).length), 0);
      const back = st.removed.filter((it) => t.items.includes(it));
      const clockLen = Math.max(...OWNERS.flatMap((n) => held(st, n).map((v) => Object.keys(v.clock).length)), 0);
      return [
        { label: 'Conflict rule', value: st.config.vclock ? `vector clocks · actor ${st.config.devClock ? 'device' : 'coordinator'}` : 'last writer wins' },
        { label: 'Phone / tablet last request', value: `${sim.ui.maya.lastMs == null ? '–' : SDL.fmtMs(sim.ui.maya.lastMs)} / ${sim.ui.tablet.lastMs == null ? '–' : SDL.fmtMs(sim.ui.tablet.lastMs)}` },
        { label: 'Siblings stored', value: sib, tone: sib > 1 ? 'warn' : '' },
        { label: 'Clock entries (max)', value: clockLen },
        { label: 'Merges on read', value: st.stats.merges },
        { label: 'Retries', value: sim.retries, tone: sim.retries ? 'warn' : '' },
        { label: 'Items lost to overwrite', value: st.lost.length, tone: st.lost.length ? 'fail' : '' },
        { label: 'Removed items resurrected', value: back.length, tone: back.length ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['tablet', 'Maya’s tablet']], {
          note: 'The phone writes through Cart service A and Node 1, the tablet through Cart service B and Node 2. Each device keeps the version clock it last read; the console shows every version each replica holds.',
          below: `<div class="ops-console"><p class="ops-title">Versions of ${KEY} on each replica</p><div data-ref="reps"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const t = truth(sim);
        for (const dev of ['maya', 'tablet']) {
          const u = sim.ui[dev];
          Y.paint(el, sim, dev, {
            head: `<div><p class="app-title">Cart</p><p class="app-sub">Maya · ${DEVICE[dev]} · via ${NAME[SERVICE[dev]]} → ${NAME[COORDS[SERVICE[dev]][0]]}</p><p class="app-sub">context ${st.config.vclock ? V.fmt(u.clock) : 'none (last writer wins)'}</p></div>`,
            cart: u.cart.length ? u.cart.map((it) => `<div class="app-card ${st.lost.includes(it) || st.removed.includes(it) ? 'is-fail' : ''}"><span class="app-kv"><strong>${esc(it)}</strong>${Y.btn('remove', 'Remove', { arg: { device: dev, item: it }, cls: 'secondary', disabled: u.pending })}</span></div>`).join('') : '<p class="app-sub">Your cart is empty.</p>',
            msg: Y.msg(u.error, 'fail') || (u.pending ? '<p class="app-msg"><span class="spinner"></span>Working…</p>' : ''),
            actions: `<div class="app-row">${['Socks', 'Hat', 'Mug'].map((it) => Y.btn('add', `Add ${it.toLowerCase()}`, { arg: { device: dev, item: it }, cls: u.cart.includes(it) ? 'secondary' : '', disabled: u.pending })).join('')}</div><div class="app-row">${Y.btn('refresh', 'Refresh', { arg: { device: dev }, cls: 'secondary', disabled: u.pending })}</div>`,
          }, {});
        }
        const rows = OWNERS.map((n) => {
          const vs = held(st, n);
          const down = dead(sim, n);
          const v = reconcile(st, vs);
          const behind = t.items.some((it) => !v.items.includes(it)) || v.items.some((it) => !t.items.includes(it));
          const tone = down ? 'fail' : behind ? 'warn' : vs.length > 1 ? 'warn' : 'ok';
          const skew = skewOf(sim, n);
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name"><strong>${NAME[n]}${skew ? ` · clock ${skew > 0 ? '+' : '−'}${Math.abs(skew) / 1000} s` : ''}</strong><span>${down ? 'down' : vs.length > 1 ? `${vs.length} siblings` : behind ? 'behind' : vs.length ? 'one version' : 'nothing yet'}</span></div>${vs.length ? `<span class="ops-val">${esc(vs.map((x) => fmtVersion(st, x)).join('  |  '))}</span>` : ''}</div>`;
        }).join('');
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="reps"]'), {
          rows: `<div class="ops-shards">${rows}</div>`,
          cfg: `<p class="app-sub">N = ${N}, W = ${W}, R = ${R} · ${st.config.vclock ? `vector clocks, actor = ${st.config.devClock ? 'device' : 'coordinator'}` : 'last writer wins'} · tombstones ${st.config.tombstones ? 'on' : 'off'} · merged cart: ${t.items.join(', ') || 'empty'}${t.tombs && t.tombs.length ? ` · removed: ${t.tombs.join(', ')}` : ''}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
