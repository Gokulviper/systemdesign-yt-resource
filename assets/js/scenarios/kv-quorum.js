/*
 * Replication, quorums, and hinted handoff.
 * One key, three replicas, two devices on different coordinators. Maya's
 * phone goes through the request router to Node 1; her tablet talks to the
 * node nearest to it, Node 3. W says how many replicas must acknowledge a
 * write, R how many a read consults. Sloppy quorums let stand-in nodes take
 * writes with a hint when an owner is down; read repair fixes a replica that
 * fell behind; and a network partition shows what "always writable" costs.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const V = Y.vclock;
  const K = Y.kv;

  const KEY = 'cart:maya';
  const OWNERS = ['n1', 'n2', 'n3'];
  const STANDINS = ['n4', 'n5'];
  const NODES = OWNERS.concat(STANDINS);
  const N = 3;
  const LAZY_MS = 300;
  const HINT_POLL_MS = 500;
  const REPLICA_TIMEOUT = 600;
  const SIDE = { maya: 'A', router: 'A', n1: 'A', n2: 'A', n4: 'A', tablet: 'B', n3: 'B', n5: 'B' };
  const NAME = { n1: 'Node 1', n2: 'Node 2', n3: 'Node 3', n4: 'Node 4', n5: 'Node 5' };
  const DEVICE = { maya: 'phone', tablet: 'tablet' };

  const W = (st) => (st.config.w2 ? 2 : 1);
  const RQ = (st) => (st.config.r2 ? 2 : 1);
  const dead = (sim, n) => !!(sim.nodes[n].modes.down || sim.nodes[n].modes.crashed);
  const partitioned = (sim) => !!sim.nodes.n3.modes.partition;
  const cut = (sim, a, b) => partitioned(sim) && SIDE[a] !== SIDE[b];

  /** A call that respects the partition: packets across the cut are dropped and the caller times out. */
  function* xcall(ctx, to, op, payload, opts) {
    opts = opts || {};
    if (cut(ctx.sim, ctx.self, to)) {
      const timeout = opts.timeout || 1500;
      if (opts.quiet !== 'all') ctx.log({ op: `${op} → ${NAME[to] || to} dropped`, status: 'lost', detail: `The partition separates ${NAME[ctx.self] || ctx.self} from ${NAME[to] || to}. The packet never arrives; the caller waits ${timeout} ms and gives up.` });
      ctx.state.stats.dropped++;
      yield ctx.wait(timeout);
      return { ok: false, error: { code: 'TIMEOUT', message: `${NAME[to] || to} did not answer within ${timeout} ms.` }, unknown: true, latency: timeout };
    }
    return yield ctx.call(to, op, payload, opts);
  }

  function applyWrite(st, node, incoming, context) {
    const res = K.applyWrite(st.store[node][KEY], incoming, context, st.config.vclock);
    st.store[node][KEY] = res.versions;
    for (const it of res.lost) if (!st.lost.includes(it)) st.lost.push(it);
    return res;
  }
  const reconcile = (st, versions) => K.reconcile(versions, st.config.vclock);
  const held = (st, n) => st.store[n][KEY] || [];
  function truth(sim) {
    const st = sim.state;
    const all = NODES.flatMap((n) => held(st, n)).concat(NODES.flatMap((n) => st.hints[n].map((h) => h.version)));
    return reconcile(st, all);
  }

  /* ---------- devices ---------- */
  function startAdd(sim, dev, item) {
    const u = sim.ui[dev];
    sim.startAction(`Maya (${DEVICE[dev]}): add ${item}`, function* (ctx) {
      const st = ctx.state;
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'The write carries the whole cart and the version it was based on.'] });
      const items = K.union([u.cart, [item]]);
      const payload = { key: KEY, items, context: u.clock, device: dev };
      const r = dev === 'maya'
        ? yield ctx.call('router', 'put', payload, { timeout: 2500 })
        : yield* xcall(ctx, 'n3', 'coordinatePut', payload, { timeout: 2500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency;
      if (r.ok) {
        const v = r.value;
        u.cart = v.items; u.clock = v.clock; u.lastWrite = v;
        st.acked = K.union([st.acked, items]);
        Y.L(ctx, {
          displayed: ['yes', `${v.items.length} item${v.items.length === 1 ? '' : 's'}.`],
          accepted: ['yes', `${NAME[v.coordinator]} coordinated.`],
          committed: v.acked.length >= 2 ? ['yes', `${v.acked.length} copies: ${v.acked.map((n) => NAME[n] + (v.hinted.includes(n) ? ' (hint)' : '')).join(', ')}.`] : ['pending', `One copy on ${NAME[v.coordinator]}; replication is batched.`],
          async: v.acked.length >= N && !v.hinted.length ? 'yes' : ['pending', 'Remaining replicas or hint replay.'],
        });
        const real = v.acked.filter((n) => !v.hinted.includes(n)).length;
        ctx.explain(`Added “${item}”. ${NAME[v.coordinator]} answered after W = ${v.w} acknowledgement${v.w === 1 ? '' : 's'} in ${SDL.fmtMs(r.latency)}: ${v.acked.map((n) => NAME[n] + (v.hinted.includes(n) ? ` standing in for ${NAME[v.hintFor[n]]}` : '')).join(', ')}.${v.hinted.length ? ` Only ${real} of the ${v.acked.length} acknowledged copies ${real === 1 ? 'is' : 'are'} on a real owner; the rest are hints that will be replayed when the owners return.` : ''}${v.waited ? ` It first waited ${SDL.fmtMs(v.waited)} for replicas that never answered.` : ''}${v.siblings > 1 ? ` The replicas now hold ${v.siblings} siblings, merged by union on read.` : ''}`);
      } else {
        u.error = r.error.message;
        Y.failed(ctx, 'The cart shows an error and is unchanged.');
        ctx.explain({
          QUORUM: `Fewer than W = ${W(st)} replicas answered and sloppy quorums are off. The coordinator refused rather than acknowledge a write it could not make durable on enough nodes.`,
          TIMEOUT: `${dev === 'tablet' ? 'The tablet’s nearest node did not answer' : 'The router never heard back'}. The write may or may not have landed.`,
          UNAVAILABLE: `${dev === 'tablet' ? 'Node 3, the tablet’s nearest node, is down. A client-side driver would try the next node; this one does not.' : 'No owner would take the write.'}`,
        }[r.error.code] || r.error.message);
      }
    }, { self: dev });
  }
  function startRefresh(sim, dev) {
    const u = sim.ui[dev];
    sim.startAction(`Maya (${DEVICE[dev]}): refresh cart`, function* (ctx) {
      const st = ctx.state;
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const payload = { key: KEY, device: dev };
      const r = dev === 'maya' ? yield ctx.call('router', 'get', payload, { timeout: 2500 }) : yield* xcall(ctx, 'n3', 'coordinateGet', payload, { timeout: 2500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency;
      if (!r.ok) { u.error = r.error.message; Y.failed(ctx, 'Not refreshed.'); ctx.explain(r.error.code === 'QUORUM' ? `Fewer than R = ${RQ(st)} replicas answered. The coordinator refused to answer from too few copies.` : r.error.message); return; }
      const v = r.value;
      const before = u.cart.slice();
      u.cart = v.items; u.clock = v.clock;
      const t = truth(ctx.sim);
      const missing = t.items.filter((it) => !v.items.includes(it));
      Y.L(ctx, { displayed: ['yes', `${v.items.length} item${v.items.length === 1 ? '' : 's'}.`], accepted: 'yes', committed: 'n/a', async: v.repaired ? ['yes', `Read repair updated ${v.repaired.map((n) => NAME[n]).join(', ')}.`] : 'n/a' });
      const from = v.from.map((n) => `${NAME[n]} (${v.counts[n]})`).join(', ');
      if (missing.length) ctx.explain(`${NAME[v.coordinator]} read R = ${v.r}: ${from}. ${v.r === 1 ? 'It answered from its own copy, which has not received the write yet.' : 'None of the copies it read has the write yet.'} With W = ${W(st)} and R = ${v.r}, R + W = ${W(st) + v.r} is not more than N = ${N}, so the read and write sets can miss each other. The store has “${missing.join('”, “')}” on another replica.`);
      else ctx.explain(`${NAME[v.coordinator]} read R = ${v.r}: ${from}${v.siblings > 1 ? `, found ${v.siblings} siblings and merged them by union` : ''}${v.repaired ? `, and sent the newest version to ${v.repaired.map((n) => NAME[n]).join(', ')}, which ${v.repaired.length === 1 ? 'was' : 'were'} behind` : ''}. ${before.length === v.items.length && before.every((it) => v.items.includes(it)) ? 'Same cart as before.' : `The ${DEVICE[dev]} now shows ${v.items.join(', ') || 'an empty cart'}.`}`);
    }, { self: dev });
  }

  /* ---------- replicas ---------- */
  function* writeReplicas(ctx, coordinator, version, context) {
    const st = ctx.state;
    const sim = ctx.sim;
    const w = W(st);
    const acked = [coordinator];
    const hinted = [];
    const hintFor = {};
    const failed = [];
    const chosen = [];
    let pending = 0;
    const t0 = ctx.now();
    const attempt = (node, forOwner) => {
      pending++;
      ctx.spawn(function* (c) {
        const r = yield* xcall(c, node, 'store', { key: KEY, version, context, hintFor: forOwner }, { timeout: REPLICA_TIMEOUT });
        pending--;
        if (r.ok) { acked.push(node); if (forOwner) { hinted.push(node); hintFor[node] = forOwner; } return; }
        failed.push(node);
        if (!st.config.sloppy || forOwner) return;
        const standin = STANDINS.find((s) => !chosen.includes(s) && !failed.includes(s) && !dead(sim, s) && !cut(sim, coordinator, s));
        if (!standin) return;
        chosen.push(standin);
        c.log({ op: `hint for ${NAME[node]} → ${NAME[standin]}`, status: 'warn', detail: `${NAME[node]} did not answer. ${NAME[standin]} stores the write with a hint and replays it when ${NAME[node]} is back.` });
        attempt(standin, node);
      });
    };
    const local = applyWrite(st, coordinator, version, context);
    const others = OWNERS.filter((x) => x !== coordinator);
    if (w === 1) {
      const actionId = ctx.actionId;
      ctx.spawn(function* (c) {
        yield c.wait(LAZY_MS);
        if (dead(sim, coordinator)) { st.stats.lostReplication++; c.log({ op: 'replication batch lost', status: 'lost', detail: `${NAME[coordinator]} died before the batched replication left. It held the only copy.` }); return; }
        for (const t of others) attempt(t);
        while (pending > 0) yield c.wait(10);
        if (acked.length >= 2) sim.setLedger(actionId, 'committed', 'yes', `${acked.length} copies, ${LAZY_MS} ms after the acknowledgement.`);
        sim.setLedger(actionId, 'async', 'yes', `Replicated to ${acked.slice(1).map((n) => NAME[n]).join(', ') || 'nobody'}.`);
      }, { actionId });
      return { acked: acked.slice(), hinted, hintFor, w, siblings: local.siblings, waited: 0 };
    }
    for (const t of others) attempt(t);
    while (acked.length < w && pending > 0) yield ctx.wait(5);
    const waited = ctx.now() - t0;
    if (acked.length < w) ctx.fail('QUORUM', `Only ${acked.length} of W = ${w} replicas acknowledged (${failed.map((n) => NAME[n]).join(', ')} did not answer).`);
    const actionId = ctx.actionId;
    ctx.spawn(function* (c) { while (pending > 0) yield c.wait(10); if (acked.length >= N) sim.setLedger(actionId, 'async', 'yes', `All ${N} copies written${hinted.length ? `, ${hinted.length} as hints` : ''}.`); }, { actionId });
    return { acked: acked.slice(), hinted: hinted.slice(), hintFor: Object.assign({}, hintFor), w, siblings: local.siblings, waited: waited > 100 ? waited : 0 };
  }

  function replica(id) {
    return {
      coordinatePut: function* (ctx, p) {
        const st = ctx.state;
        const context = p.context || {};
        const clock = st.config.vclock ? Object.assign({}, context, { [p.device]: (context[p.device] || 0) + 1 }) : {};
        const version = { items: p.items, clock, ts: ctx.now(), device: p.device };
        st.stats.puts++;
        const res = yield* writeReplicas(ctx, id, version, context);
        const view = reconcile(st, held(st, id));
        return Object.assign({ coordinator: id, items: view.items, clock: view.clock }, res, { siblings: Math.max(view.siblings, res.siblings) });
      },
      coordinateGet: function* (ctx, p) {
        const st = ctx.state;
        const r = RQ(st);
        st.stats.gets++;
        const responses = [{ node: id, versions: held(st, id).slice() }];
        let pending = 0;
        for (const n of OWNERS.filter((x) => x !== id)) {
          pending++;
          ctx.spawn(function* (c) { const x = yield* xcall(c, n, 'read', { key: KEY }, { timeout: REPLICA_TIMEOUT }); pending--; if (x.ok) responses.push({ node: n, versions: x.value.versions }); });
        }
        while (responses.length < r && pending > 0) yield ctx.wait(5);
        if (responses.length < r) ctx.fail('QUORUM', `Only ${responses.length} of R = ${r} replicas answered.`);
        const used = responses.slice(0, r);
        const merged = reconcile(st, used.flatMap((x) => x.versions));
        const counts = {}; for (const x of used) counts[x.node] = reconcile(st, x.versions).items.length;
        let repaired = null;
        if (st.config.readRepair) {
          const behind = used.filter((x) => { const v = reconcile(st, x.versions); return merged.items.some((it) => !v.items.includes(it)) || v.items.some((it) => !merged.items.includes(it)); }).map((x) => x.node);
          if (behind.length) {
            repaired = behind;
            const version = { items: merged.items, clock: merged.clock, ts: merged.ts, device: 'repair' };
            for (const n of behind) ctx.spawn(function* (c) { const x = yield* xcall(c, n, 'store', { key: KEY, version, context: merged.clock, repair: true }, { timeout: REPLICA_TIMEOUT }); if (x.ok) st.stats.repairs++; });
          }
        }
        return { coordinator: id, r, from: used.map((x) => x.node), counts, items: merged.items, clock: merged.clock, siblings: merged.siblings, repaired };
      },
      store(ctx, p) {
        const st = ctx.state;
        if (p.hintFor) { st.hints[id].push({ target: p.hintFor, version: p.version, context: p.context }); st.stats.hints++; return { hinted: true }; }
        const res = applyWrite(st, id, p.version, p.context || {});
        return { stored: res.kept === 'new', siblings: res.siblings };
      },
      read(ctx) { return { versions: held(ctx.state, id).slice() }; },
    };
  }

  const sc = (SDL.scenarios['kv-quorum'] = {
    id: 'kv-quorum',
    seed: 31,
    productWidth: 640,
    intro: 'Write from the phone and read from the tablet under different R and W. Then set W = 1 and crash Node 1, take two replicas down with sloppy quorums on and off, and partition the ring so both devices keep writing.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'Via the router', x: 90, y: 130, latency: 1, role: 'Writes and reads through the request router, which picks Node 1 as coordinator whenever it is up.', owns: ['What the phone shows'] },
        { id: 'router', label: 'Request router', kind: 'gateway', sub: 'Side A', x: 320, y: 130, latency: 1, role: 'Forwards to the first healthy owner in the preference list: Node 1, then 2, then 3.', ops: [{ name: 'put', desc: 'Route a write.' }, { name: 'get', desc: 'Route a read.' }], owns: ['Nothing durable'] },
        { id: 'tablet', label: 'Maya’s tablet', kind: 'client', sub: 'Talks to Node 3 directly', x: 90, y: 470, latency: 1, role: 'A client-side driver that sends to the nearest replica, Node 3, which coordinates. On the other side of the partition from the phone.', owns: ['What the tablet shows'] },
        { id: 'n1', label: 'Node 1', kind: 'db', sub: 'Replica · side A', x: 560, y: 90, latency: 3, role: 'First owner of the key and the phone’s coordinator. Writes to N = 3 replicas and acknowledges at W; reads R replicas and reconciles.', ops: [{ name: 'coordinatePut', desc: 'Write N, ack at W.' }, { name: 'coordinateGet', desc: 'Read R, reconcile, repair.' }, { name: 'store', desc: 'Store a version or hint.' }, { name: 'read', desc: 'Local versions.' }], owns: ['Versions', 'Hints'] },
        { id: 'n2', label: 'Node 2', kind: 'db', sub: 'Replica · side A', x: 800, y: 90, latency: 3, role: 'Second owner.', ops: [{ name: 'store', desc: 'Store a version.' }, { name: 'read', desc: 'Local versions.' }], owns: ['Versions', 'Hints'] },
        { id: 'n3', label: 'Node 3', kind: 'db', sub: 'Replica · side B', x: 560, y: 470, latency: 3, role: 'Third owner and the tablet’s coordinator. In a partition it is cut off from Nodes 1, 2, and 4 together with the tablet and Node 5.', ops: [{ name: 'coordinatePut', desc: 'Write N, ack at W.' }, { name: 'coordinateGet', desc: 'Read R, reconcile.' }, { name: 'store', desc: 'Store a version.' }, { name: 'read', desc: 'Local versions.' }], owns: ['Versions', 'Hints'] },
        { id: 'n4', label: 'Node 4', kind: 'store', sub: 'Stand-in · side A', x: 1040, y: 130, latency: 3, role: 'Next node on the ring after the owners. Not an owner of this key; takes a hinted write when an owner is unreachable and replays it later.', ops: [{ name: 'store', desc: 'Store a hinted version.' }], owns: ['Hints'] },
        { id: 'n5', label: 'Node 5', kind: 'store', sub: 'Stand-in · side B', x: 800, y: 470, latency: 3, role: 'Second stand-in, on side B with Node 3.', ops: [{ name: 'store', desc: 'Store a hinted version.' }], owns: ['Hints'] },
      ],
      edges: [
        { from: 'maya', to: 'router', latency: 40 },
        { from: 'router', to: 'n1', latency: 2 },
        { from: 'router', to: 'n2', latency: 2, via: [[320, 40], [800, 40]] },
        { from: 'router', to: 'n3', latency: 2 },
        { from: 'tablet', to: 'n3', latency: 30 },
        { from: 'n1', to: 'n2', latency: 2 },
        { from: 'n1', to: 'n3', latency: 2 },
        { from: 'n2', to: 'n3', latency: 2 },
        { from: 'n1', to: 'n4', latency: 2, via: [[560, 20], [1040, 20]] },
        { from: 'n2', to: 'n4', latency: 2 },
        { from: 'n3', to: 'n4', latency: 2 },
        { from: 'n1', to: 'n5', latency: 2 },
        { from: 'n3', to: 'n5', latency: 2 },
        { from: 'n2', to: 'n5', latency: 2 },
      ],
      queues: [],
    },
    modeLabels: { partition: 'Partition: side B (Node 3, Node 5, tablet) cut off', crashed: 'Crashed, disk lost' },
    failures: [
      { id: 'n1-down', node: 'n1', mode: 'down', label: 'Node 1 down', desc: 'The phone’s coordinator is unreachable but its disk is intact. The router uses Node 2.' },
      { id: 'n1-crash', node: 'n1', mode: 'crashed', label: 'Node 1 crashes and loses its disk', desc: 'Whatever only Node 1 held is gone. With W = 1 that can be an acknowledged write.' },
      { id: 'n2-down', node: 'n2', mode: 'down', label: 'Node 2 down', desc: 'One owner short. W = 2 still works with the other two; sloppy quorums add a hint on Node 4.' },
      { id: 'n3-down', node: 'n3', mode: 'down', label: 'Node 3 down', desc: 'The tablet’s nearest node. Writes still reach W elsewhere; the tablet itself gets “unavailable”.' },
      { id: 'n3-slow', node: 'n3', mode: 'slow', params: { factor: 40 }, label: 'Node 3 slow', desc: 'Its acknowledgement is late. W = 2 does not wait for it; a read at R = 1 there is stale meanwhile.' },
      { id: 'n4-crash', node: 'n4', mode: 'crashed', label: 'Node 4 crashes with its hints', desc: 'A stand-in that dies before replaying loses the copies it was holding for others.' },
      { id: 'n5-crash', node: 'n5', mode: 'crashed', label: 'Node 5 crashes with its hints', desc: 'Same for the other stand-in.' },
      { id: 'n4-paused', node: 'n4', mode: 'paused', label: 'Node 4 stops replaying hints', desc: 'Hints pile up; the owner stays behind even after it is back.' },
      { id: 'n1-drop', node: 'n1', mode: 'dropResponse', label: 'Node 1 loses its replies', desc: 'Writes land but the router never hears. The phone must retry.' },
      { id: 'partition', node: 'n3', mode: 'partition', label: 'Network partition: side A | side B', desc: 'Nodes 1, 2, 4 and the phone cannot reach Node 3, Node 5, and the tablet. Both sides keep running.' },
    ],
    switches: Y.switches([
      ['w2', 'W = 2 (off: W = 1 with batched replication)', `The coordinator waits for a second replica before acknowledging. Off: it acknowledges after its own write and replicates ${LAZY_MS} ms later.`],
      ['r2', 'R = 2 (off: R = 1)', 'Reads consult two replicas and reconcile. With W = 2, R + W = 4 > N = 3: every read overlaps every acknowledged write.'],
      ['sloppy', 'Sloppy quorum and hinted handoff', 'An unreachable owner is replaced by the next healthy node on the ring, which stores the write with a hint. Off: the write fails if W owners do not answer.'],
      ['readRepair', 'Read repair', 'When a read finds a replica behind, the coordinator sends it the reconciled version.'],
      ['vclock', 'Vector clocks (off: last writer wins)', 'Concurrent versions are kept as siblings and merged by the app. Off: the later timestamp replaces the other version.'],
    ]),
    presets: Y.presets({ w2: true, r2: true, sloppy: true, readRepair: true, vclock: true }, [
      { id: 'normal', label: 'W = 2, R = 2: read your own write', desc: 'The phone writes through Node 1; two of three acknowledge. The tablet reads through Node 3, which asks one more replica. At least one of the two was in the write set.', run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(460, () => startRefresh(s, 'tablet')); } },
      { id: 'w1-r1-stale', label: 'W = 1, R = 1: the read misses the write', desc: `Node 1 acknowledges alone and replicates ${LAZY_MS} ms later. Node 3 answers the tablet from its own copy: the old cart. R + W = 2, not more than N.`, sw: { w2: false, r2: false }, run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(460, () => startRefresh(s, 'tablet')); } },
      { id: 'w1-eventual', label: 'W = 1, R = 1: eventually consistent', desc: 'Same settings, but the tablet refreshes a second later. The batched replication has landed and Node 3 has the item. Eventual means exactly that.', sw: { w2: false, r2: false }, run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(1800, () => startRefresh(s, 'tablet')); } },
      { id: 'w1-crash', label: 'W = 1: acknowledged, then lost', desc: 'Node 1 acknowledges and crashes, disk and all, before the batch leaves. The phone shows “saved”. No other node ever heard of the item.', sw: { w2: false }, run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(480, () => s.inject('n1', 'crashed')); s.schedule(1800, () => startRefresh(s, 'tablet')); } },
      { id: 'strict-refused', label: 'Two owners down, strict quorum: refused', desc: 'Nodes 2 and 3 are down and sloppy quorums are off. Node 1 cannot reach W = 2 and refuses the write. Consistent and unavailable.', sw: { sloppy: false }, run: (s) => { s.inject('n2', 'down'); s.inject('n3', 'down'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); } },
      { id: 'sloppy-handoff', label: 'Owner down, hint stored and replayed', desc: 'Node 3 is down. Node 1 and 2 acknowledge; Node 4 stores a third copy with a hint for Node 3. When Node 3 returns, the tablet’s first read at R = 1 is stale, then the hint arrives and the next read is right.', sw: { r2: false }, run: (s) => { s.inject('n3', 'down'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(1500, () => s.restore('n3')); s.schedule(1650, () => startRefresh(s, 'tablet')); s.schedule(3500, () => startRefresh(s, 'tablet')); } },
      { id: 'standin-lost', label: 'Stand-ins die with the hints', desc: 'Nodes 2 and 3 are down; the write is acknowledged with W = 2 thanks to hints on Nodes 4 and 5. Both stand-ins crash before replaying, then Node 1 crashes. Nodes 2 and 3 come back to an empty cart: W counted copies that were never on owners.', run: (s) => { s.inject('n2', 'down'); s.inject('n3', 'down'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(1200, () => { s.inject('n4', 'crashed'); s.inject('n5', 'crashed'); }); s.schedule(1600, () => s.inject('n1', 'crashed')); s.schedule(2000, () => { s.restore('n2'); s.restore('n3'); }); s.schedule(3000, () => startRefresh(s, 'tablet')); } },
      { id: 'hint-paused', label: 'Hint replay stalls', desc: 'Node 3 is down during the write and comes back, but Node 4 never replays the hint. Node 3 stays behind: any R = 1 read there is stale until someone repairs it.', sw: { r2: false }, run: (s) => { s.inject('n3', 'down'); s.inject('n4', 'paused'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(1500, () => s.restore('n3')); s.schedule(3000, () => startRefresh(s, 'tablet')); } },
      { id: 'read-repair', label: 'Read repair', desc: 'Sloppy quorums off, Node 3 down during the write: two copies, no hint. Node 3 comes back behind. The tablet’s R = 2 read sees Node 3’s old copy and Node 1’s new one, returns the new one, and repairs Node 3.', sw: { sloppy: false }, run: (s) => { s.inject('n3', 'down'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(1200, () => s.restore('n3')); s.schedule(1500, () => startRefresh(s, 'tablet')); } },
      { id: 'no-repair', label: 'No read repair: a replica stays behind', desc: 'The same read without read repair. The tablet still gets the right answer from R = 2, but Node 3 keeps the old copy indefinitely. Anti-entropy, in a later lab, is the other fix.', sw: { sloppy: false, readRepair: false }, run: (s) => { s.inject('n3', 'down'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(1200, () => s.restore('n3')); s.schedule(1500, () => startRefresh(s, 'tablet')); } },
      { id: 'partition-lww', label: 'Partition, both sides write, last writer wins', desc: 'The phone adds socks on side A (Nodes 1, 2, hint on 4). The tablet adds a hat on side B (Node 3 after a timeout, hint on 5). Both are acknowledged. When the partition heals the hints meet: the later timestamp wins and the socks are gone.', sw: { vclock: false }, run: (s) => { s.inject('n3', 'partition'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(600, () => startAdd(s, 'tablet', 'Hat')); s.schedule(3000, () => s.restore('n3', 'partition')); s.schedule(5000, () => startRefresh(s, 'maya')); s.schedule(5200, () => startRefresh(s, 'tablet')); } },
      { id: 'partition-vclock', label: 'Partition, both sides write, vector clocks', desc: 'The same writes with vector clocks. The two versions have concurrent clocks, so the replicas keep both as siblings. After the heal, both devices read both and merge: socks and hat.', run: (s) => { s.inject('n3', 'partition'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(600, () => startAdd(s, 'tablet', 'Hat')); s.schedule(3000, () => s.restore('n3', 'partition')); s.schedule(5000, () => startRefresh(s, 'maya')); s.schedule(5200, () => startRefresh(s, 'tablet')); } },
    ]),
    initialState: () => {
      const store = {}; const hints = {};
      for (const n of NODES) { store[n] = {}; hints[n] = []; }
      return { config: { w2: true, r2: true, sloppy: true, readRepair: true, vclock: true }, store, hints, acked: [], lost: [], stats: { puts: 0, gets: 0, hints: 0, replayed: 0, repairs: 0, dropped: 0, lostReplication: 0 } };
    },
    initialUI: () => ({
      maya: { cart: [], clock: {}, pending: false, error: '', lastMs: null, lastWrite: null },
      tablet: { cart: [], clock: {}, pending: false, error: '', lastMs: null, lastWrite: null },
    }),
    actions: {
      add(sim, a) { startAdd(sim, a.device, a.item); },
      refresh(sim, a) { startRefresh(sim, a.device); },
      partition(sim, a) { if (a.on) sim.inject('n3', 'partition'); else sim.restore('n3', 'partition'); },
    },
    handlers: Object.assign({
      router: {
        put: function* (ctx, p) { const t = OWNERS.find((n) => !dead(ctx.sim, n)); if (!t) ctx.fail('UNAVAILABLE', 'No owner is up.'); return ctx.must(yield* xcall(ctx, t, 'coordinatePut', p, { timeout: 2200 })); },
        get: function* (ctx, p) { const t = OWNERS.find((n) => !dead(ctx.sim, n)); if (!t) ctx.fail('UNAVAILABLE', 'No owner is up.'); return ctx.must(yield* xcall(ctx, t, 'coordinateGet', p, { timeout: 2200 })); },
      },
    }, Object.fromEntries(NODES.map((n) => [n, replica(n)]))),
    setup(sim) {
      for (const n of NODES) sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(HINT_POLL_MS);
          const st = ctx.state;
          if (!st.hints[n].length || dead(ctx.sim, n) || !ctx.alive()) continue;
          for (const h of st.hints[n].slice()) {
            if (dead(ctx.sim, h.target) || cut(ctx.sim, n, h.target)) continue;
            const r = yield ctx.call(h.target, 'store', { key: KEY, version: h.version, context: h.context }, { timeout: REPLICA_TIMEOUT });
            if (r.ok) { st.hints[n].splice(st.hints[n].indexOf(h), 1); st.stats.replayed++; ctx.log({ op: `hint replayed to ${NAME[h.target]}`, status: 'ok', detail: `${NAME[n]} handed over the version it held for ${NAME[h.target]} and dropped the hint.` }); }
          }
        }
      }, { self: n, quiet: 'all' });
    },
    onFailureChange(sim, ch) {
      if (ch.mode === 'crashed' && ch.active && NODES.includes(ch.node)) { const lostHints = sim.state.hints[ch.node].length; sim.state.store[ch.node] = {}; sim.state.hints[ch.node] = []; sim.note(`${NAME[ch.node]} crashed and its disk is gone${lostHints ? `, with ${lostHints} hint${lostHints === 1 ? '' : 's'} it was holding for other nodes` : ''}.`); }
    },
    consistency(sim) {
      const st = sim.state;
      const ui = sim.ui;
      const t = truth(sim);
      if (st.lost.length) return { key: 'wrong', label: `“${st.lost.join('”, “')}” ${st.lost.length === 1 ? 'was' : 'were'} acknowledged and then discarded: last writer wins kept the version with the later timestamp when the two sides’ writes met.` };
      const gone = st.acked.filter((it) => !t.items.includes(it));
      if (gone.length) return { key: 'wrong', label: `“${gone.join('”, “')}” ${gone.length === 1 ? 'was' : 'were'} acknowledged and ${gone.length === 1 ? 'is' : 'are'} on no node: ${st.stats.lostReplication ? 'the only copy died with the coordinator before replication' : 'the copies that made up the quorum were hints on stand-ins that died, and the last owner copy died too'}.` };
      for (const dev of ['maya', 'tablet']) {
        if (ui[dev].pending) return { key: 'stale', label: `The ${DEVICE[dev]} is waiting.` };
        if (ui[dev].error) return { key: 'stale', label: `The ${DEVICE[dev]}’s last request failed: ${ui[dev].error}` };
      }
      if (partitioned(sim)) return { key: 'stale', label: 'The network is partitioned. Each side serves what it has; the sides will reconcile when it heals.' };
      for (const dev of ['maya', 'tablet']) {
        const missing = t.items.filter((it) => !ui[dev].cart.includes(it));
        if (missing.length) return { key: 'stale', label: `The ${DEVICE[dev]} shows ${ui[dev].cart.length} item${ui[dev].cart.length === 1 ? '' : 's'}; the store has ${t.items.length}. A read with R + W > N would see “${missing.join('”, “')}”.` };
      }
      const pendingHints = NODES.reduce((s, n) => s + st.hints[n].length, 0);
      const downOwners = OWNERS.filter((n) => dead(sim, n));
      if (pendingHints) return { key: 'stale', label: `${pendingHints} hint${pendingHints === 1 ? '' : 's'} waiting on stand-in nodes${downOwners.length ? ` for ${downOwners.map((n) => NAME[n]).join(', ')} to return` : ' (replay stalled)'}. Fewer real owners than N hold the write.` };
      if (downOwners.length) return { key: 'stale', label: `${downOwners.map((n) => NAME[n]).join(' and ')} down: ${N - downOwners.length} of ${N} owner cop${N - downOwners.length === 1 ? 'y' : 'ies'} reachable.` };
      const behind = OWNERS.filter((n) => { const v = reconcile(st, held(st, n)); return t.items.some((it) => !v.items.includes(it)); });
      if (behind.length) return { key: 'stale', label: `${behind.map((n) => NAME[n]).join(', ')} ${behind.length === 1 ? 'is' : 'are'} behind. A read at R = 1 there is stale; R = 2 masks it and, with read repair, fixes it.` };
      const sib = Math.max(...OWNERS.map((n) => held(st, n).length), 0);
      return { key: 'ok', label: `Both devices and all three owners agree on ${t.items.length} item${t.items.length === 1 ? '' : 's'}${sib > 1 ? `; ${sib} siblings stored until the next write` : ''}${st.stats.replayed ? `; ${st.stats.replayed} hint${st.stats.replayed === 1 ? '' : 's'} replayed` : ''}${st.stats.repairs ? `; ${st.stats.repairs} read repair${st.stats.repairs === 1 ? '' : 's'}` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const last = sim.ui.tablet.lastWrite || sim.ui.maya.lastWrite;
      const pendingHints = NODES.reduce((s, n) => s + st.hints[n].length, 0);
      const t = truth(sim);
      return [
        { label: 'N / W / R', value: `${N} / ${W(st)} / ${RQ(st)}`, tone: W(st) + RQ(st) > N ? 'ok' : 'warn' },
        { label: 'Phone / tablet last request', value: `${sim.ui.maya.lastMs == null ? '–' : SDL.fmtMs(sim.ui.maya.lastMs)} / ${sim.ui.tablet.lastMs == null ? '–' : SDL.fmtMs(sim.ui.tablet.lastMs)}` },
        { label: 'Copies acked (last write)', value: last ? `${last.acked.length}${last.hinted.length ? ` (${last.hinted.length} hint)` : ''}` : '–', tone: last && last.acked.filter((n) => !last.hinted.includes(n)).length < 2 ? 'warn' : '' },
        { label: 'Hints pending / replayed', value: `${pendingHints} / ${st.stats.replayed}`, tone: pendingHints ? 'warn' : '' },
        { label: 'Read repairs', value: st.stats.repairs },
        { label: 'Packets dropped by the partition', value: st.stats.dropped, tone: st.stats.dropped ? 'warn' : '' },
        { label: 'Siblings stored', value: Math.max(...OWNERS.map((n) => held(st, n).length), 0) },
        { label: 'Items lost', value: new Set(st.lost.concat(st.acked.filter((it) => !t.items.includes(it)))).size, tone: st.lost.length || st.acked.some((it) => !t.items.includes(it)) ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['tablet', 'Maya’s tablet']], {
          note: 'The phone goes through the router to Node 1; the tablet talks to Node 3 directly. The console shows what each node holds for the key.',
          below: `<div class="ops-console"><p class="ops-title">Replicas of ${KEY}</p><div class="ops-traffic">${Y.btn('partition', 'Partition the network', { arg: { on: true }, cls: 'secondary' })}${Y.btn('partition', 'Heal the partition', { arg: { on: false }, cls: 'secondary' })}</div><div data-ref="reps"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const t = truth(sim);
        for (const dev of ['maya', 'tablet']) {
          const u = sim.ui[dev];
          Y.paint(el, sim, dev, {
            head: `<div><p class="app-title">Cart</p><p class="app-sub">Maya · ${DEVICE[dev]} · via ${dev === 'maya' ? 'router → Node 1' : 'Node 3'}${partitioned(sim) ? ` · side ${SIDE[dev]}` : ''}</p></div>`,
            cart: u.cart.length ? u.cart.map((it) => `<div class="app-card ${st.lost.includes(it) ? 'is-fail' : ''}"><span class="app-kv"><strong>${esc(it)}</strong><span>1</span></span></div>`).join('') : '<p class="app-sub">Your cart is empty.</p>',
            msg: Y.msg(u.error, 'fail') || (u.pending ? '<p class="app-msg"><span class="spinner"></span>Working…</p>' : ''),
            actions: `<div class="app-row">${['Socks', 'Hat', 'Mug'].map((it) => Y.btn('add', `Add ${it.toLowerCase()}`, { arg: { device: dev, item: it }, cls: u.cart.includes(it) ? 'secondary' : '', disabled: u.pending })).join('')}</div><div class="app-row">${Y.btn('refresh', 'Refresh', { arg: { device: dev }, cls: 'secondary', disabled: u.pending })}</div>`,
          }, {});
        }
        const rows = NODES.map((n) => {
          const vs = held(st, n);
          const down = dead(sim, n);
          const v = reconcile(st, vs);
          const owner = OWNERS.includes(n);
          const behind = owner && t.items.some((it) => !v.items.includes(it));
          const tone = down ? 'fail' : behind || st.hints[n].length ? 'warn' : 'ok';
          const what = vs.length ? `${vs.length > 1 ? `${vs.length} siblings: ` : ''}${vs.map((x) => `[${x.items.join(', ') || 'empty'}]${st.config.vclock ? ` ${V.fmt(x.clock)}` : ` t=${x.ts}`}`).join(' | ')}` : owner ? 'nothing yet' : '';
          const hintTxt = st.hints[n].length ? `${st.hints[n].length} hint${st.hints[n].length === 1 ? '' : 's'} for ${st.hints[n].map((h) => NAME[h.target]).join(', ')}` : '';
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name"><strong>${NAME[n]} · ${owner ? 'owner' : 'stand-in'} · side ${SIDE[n]}</strong><span>${down ? (sim.nodes[n].modes.crashed ? 'crashed, disk lost' : 'down') : hintTxt || (behind ? 'behind' : owner ? 'up to date' : 'idle')}</span></div>${what || hintTxt ? `<span class="ops-val">${esc(what)}${what && hintTxt ? ' · ' : ''}${esc(hintTxt)}</span>` : ''}</div>`;
        }).join('');
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="reps"]'), {
          rows: `<div class="ops-shards">${rows}</div>`,
          cfg: `<p class="app-sub">N = ${N}, W = ${W(st)}, R = ${RQ(st)} (R + W ${W(st) + RQ(st) > N ? '>' : '≤'} N) · ${st.config.vclock ? 'vector clocks' : 'last writer wins'} · sloppy quorum ${st.config.sloppy ? 'on' : 'off'} · read repair ${st.config.readRepair ? 'on' : 'off'}${partitioned(sim) ? ' · <strong>partitioned</strong>' : ''} · store knows: ${t.items.join(', ') || 'empty cart'}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
