/*
 * Gossip, failure detection, and anti-entropy.
 * Six storage nodes and the request router each keep their own view of who
 * is alive, learned by gossiping heartbeat counters. A fixed timeout or a
 * phi-accrual detector turns silence into "dead". Writes are acknowledged
 * by one owner and replicated to the others it believes alive, so a wrong
 * verdict, a pause, or a partition leaves replicas diverging; an
 * anti-entropy worker compares Merkle trees between replicas and copies
 * what differs. Nothing leaves the ring until Dev, the operator, says so,
 * unless automatic removal is switched on.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const R = Y.ring;

  const KEY = 'cart:maya';
  const KEYS = [...Array(120)].map((_, i) => `cart:u${i}`).concat([KEY]);
  const BASE = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
  const VNODES = 32;
  const N = 3;
  const GOSSIP_MS = 200;
  const TIMEOUT_MS = 1000;
  const PHI_THRESHOLD = 8;
  const HISTORY = 8;
  const LAG_FACTOR = 6;
  const GC_MS = 2500;
  const FLAP_MS = 1200;
  const REPAIR_MS = 800;
  const BUCKETS = 16;
  const AUTO_REMOVE_MS = 1500;
  const REPLICA_TIMEOUT = 500;
  const LOAD_RATE = 30;
  const NAME = { n1: 'Node 1', n2: 'Node 2', n3: 'Node 3', n4: 'Node 4', n5: 'Node 5', n6: 'Node 6', router: 'the router', repair: 'the repair worker' };
  const RING0 = R.create(BASE, VNODES);
  const OWNERS0 = R.owners(RING0, KEY, N);
  const VICTIM = OWNERS0[2];
  const CUT = [VICTIM, BASE.find((n) => !OWNERS0.includes(n))];
  const GOSSIPERS = BASE.concat(['router']);

  const RINGS = {};
  const ringFor = (members) => { const k = members.join(','); if (!RINGS[k]) RINGS[k] = R.create(members, VNODES); return RINGS[k]; };
  const ownersOf = (st, key) => R.owners(ringFor(st.members), key, Math.min(N, st.members.length));
  const crashed = (sim, n) => !!(sim.nodes[n] && sim.nodes[n].modes.crashed);
  const paused = (sim, n) => !!(sim.nodes[n] && sim.nodes[n].modes.gc);
  const flapOff = (sim, n) => !!(sim.nodes[n] && sim.nodes[n].modes.flap) && Math.floor(sim.now / FLAP_MS) % 2 === 1;
  const silent = (sim, n) => crashed(sim, n) || paused(sim, n) || flapOff(sim, n);
  const partitioned = (sim) => !!sim.nodes[VICTIM].modes.partition;
  const cut = (sim, a, b) => partitioned(sim) && CUT.includes(a) !== CUT.includes(b);
  const lagged = (sim) => !!sim.nodes.router.modes.lag;
  const reachable = (sim, from, to) => !silent(sim, to) && !cut(sim, from, to);
  const why = (sim, n) => (crashed(sim, n) ? 'crashed' : paused(sim, n) ? 'paused' : flapOff(sim, n) ? 'flapping (off)' : sim.nodes[n].modes.flap ? 'flapping (on)' : 'up');

  /** A call that respects silence and partitions: the packet is dropped and the caller waits the timeout. */
  function* xcall(ctx, to, op, payload, opts) {
    opts = opts || {};
    if (!reachable(ctx.sim, ctx.self, to)) {
      const timeout = opts.timeout || REPLICA_TIMEOUT;
      yield ctx.wait(timeout);
      return { ok: false, error: { code: 'TIMEOUT', message: `${NAME[to] || to} did not answer within ${timeout} ms.` }, unknown: true, latency: timeout };
    }
    return yield ctx.call(to, op, payload, opts);
  }

  /* ---------- membership views ---------- */
  function phiOf(st, v, peer, now) {
    const e = st.view[v][peer];
    const elapsed = now - e.seen;
    if (!e.gaps.length) return null;
    const mean = e.gaps.reduce((a, b) => a + b, 0) / e.gaps.length;
    return elapsed / (mean * Math.LN10);
  }
  function judge(sim, v, peer) {
    const st = sim.state; const e = st.view[v][peer]; const now = sim.now;
    if (e.hb === 0 && now < TIMEOUT_MS * 2) return 'alive';
    if (st.config.phi) { const phi = phiOf(st, v, peer, now); return (phi == null ? now - e.seen > TIMEOUT_MS * 5 : phi > PHI_THRESHOLD) ? 'dead' : 'alive'; }
    return now - e.seen > TIMEOUT_MS ? 'dead' : 'alive';
  }
  function merge(sim, v, digest) {
    const st = sim.state; const now = sim.now;
    for (const [peer, hb] of Object.entries(digest)) {
      if (peer === v || !st.view[v][peer]) continue;
      const e = st.view[v][peer];
      if (hb > e.hb) { if (e.seen > 0) { e.gaps.push(now - e.seen); if (e.gaps.length > HISTORY) e.gaps.shift(); } e.hb = hb; e.seen = now; }
    }
  }
  function detect(sim, v) {
    const st = sim.state;
    for (const peer of Object.keys(st.view[v])) {
      if (peer === v) continue;
      const e = st.view[v][peer];
      const verdict = judge(sim, v, peer);
      if (verdict === e.state) continue;
      e.state = verdict;
      if (verdict === 'dead') {
        e.deadSince = sim.now;
        const real = crashed(sim, peer) || cut(sim, v, peer);
        if (v === 'router' && !real) st.stats.falseDeaths++;
        if (v === 'router') { st.stats.detections.push({ node: peer, at: sim.now, real }); sim._log({ node: 'router', op: `${NAME[peer]} declared dead`, status: real ? 'warn' : 'fault', detail: `${NAME[peer]} has been silent for ${SDL.fmtMs(sim.now - e.seen)}${st.config.phi ? ` (phi ${phiOf(st, v, peer, sim.now).toFixed(1)} > ${PHI_THRESHOLD})` : ` (> ${TIMEOUT_MS} ms)`}. The router stops sending it requests. ${real ? 'It really crashed.' : `It is ${why(sim, peer)}: a false positive.`}` }); }
      } else {
        if (v === 'router') { st.stats.flaps++; sim._log({ node: 'router', op: `${NAME[peer]} back`, status: 'recovered', detail: `A newer heartbeat from ${NAME[peer]} arrived after ${SDL.fmtMs(sim.now - e.deadSince)} of “dead”. Routing resumes. ${st.members.includes(peer) ? 'Replicas it missed will be caught up by anti-entropy.' : 'It is no longer a ring member and must be added back by the operator.'}` }); }
      }
    }
    if (v === 'router' && st.config.autoRemove) {
      for (const peer of BASE) {
        const e = st.view.router[peer];
        if (st.members.includes(peer) && e.state === 'dead' && sim.now - e.deadSince >= AUTO_REMOVE_MS) { removeNode(sim, peer, 'automatic removal'); }
      }
    }
  }
  function removeNode(sim, node, by) {
    const st = sim.state;
    if (!st.members.includes(node)) return;
    st.members = st.members.filter((n) => n !== node);
    st.stats.removals++;
    const moved = KEYS.filter((k) => R.owners(ringFor(st.members.concat([node]).sort()), k, N).includes(node)).length;
    sim.note(`${NAME[node]} removed from the ring (${by}). ${moved} keys it owned now have a new third owner; anti-entropy will copy them there${crashed(sim, node) ? '' : `. ${NAME[node]} is ${why(sim, node)}, not dead: this removal was ${by === 'automatic removal' ? 'a false positive acted on' : 'the operator’s call'}`}.`);
  }
  function addNode(sim, node) {
    const st = sim.state;
    if (st.members.includes(node)) return;
    st.members = BASE.filter((n) => st.members.includes(n) || n === node);
    sim.note(`${NAME[node]} added back to the ring. It owns ranges again and anti-entropy fills them.`);
  }

  /* ---------- Maya ---------- */
  function startAdd(sim, item) {
    const u = sim.ui.maya;
    sim.startAction(`Maya: add ${item}`, function* (ctx) {
      const st = ctx.state;
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'The write carries the whole cart.'] });
      const items = Y.kv.union([u.cart, [item]]);
      const r = yield ctx.call('router', 'put', { key: KEY, items }, { timeout: 2500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency;
      if (!r.ok) { u.error = r.error.message; Y.failed(ctx, 'The cart shows an error.'); ctx.explain(r.error.code === 'UNAVAILABLE' ? 'The router believes none of the cart’s owners is alive.' : r.error.message); return; }
      const v = r.value;
      u.cart = items; st.acked = { items, ver: v.ver };
      Y.L(ctx, { displayed: ['yes', `${items.length} item${items.length === 1 ? '' : 's'}.`], accepted: ['yes', `${NAME[v.coordinator]} coordinated.`], committed: ['yes', `One copy on ${NAME[v.coordinator]}; replication is asynchronous.`], async: ['pending', `Replicating to ${v.targets.map((n) => NAME[n]).join(', ') || 'nobody'}.`] });
      ctx.explain(`Saved via ${NAME[v.coordinator]}, which the router picked as the first owner it believes alive (${SDL.fmtMs(r.latency)}). It replicates to ${v.targets.length ? v.targets.map((n) => NAME[n]).join(' and ') : 'no one'}${v.skipped.length ? ` and skips ${v.skipped.map((n) => NAME[n]).join(', ')}, which it considers dead` : ''}. Any replica that misses this write is caught up by anti-entropy.`);
    }, { self: 'maya' });
  }
  function startRefresh(sim) {
    const u = sim.ui.maya;
    sim.startAction('Maya: refresh cart', function* (ctx) {
      const st = ctx.state;
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call('router', 'get', { key: KEY }, { timeout: 2500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency;
      if (!r.ok) { u.error = r.error.message; Y.failed(ctx, 'Not refreshed.'); ctx.explain(r.error.code === 'TIMEOUT' ? 'The router sent the read to an owner it believes alive, and got no answer: the detector has not caught up with reality yet.' : r.error.message); return; }
      const v = r.value;
      u.cart = v.items;
      const t = truth(ctx.sim);
      const behind = t.ver > v.ver;
      Y.L(ctx, { displayed: ['yes', `${v.items.length} item${v.items.length === 1 ? '' : 's'}.`], accepted: 'yes', committed: 'n/a', async: 'n/a' });
      ctx.explain(`${NAME[v.coordinator]} answered from its own copy (version ${v.ver}). ${behind ? `That copy is behind: the newest version is ${t.ver}. ${NAME[v.coordinator]} missed a write while it was unreachable or wrongly considered dead, and anti-entropy has not repaired it yet.` : 'It is the newest version.'}`);
    }, { self: 'maya' });
  }

  function truth(sim) {
    const st = sim.state; let best = { ver: 0, items: [] };
    for (const n of BASE) { const v = st.store[n][KEY]; if (v && v.ver > best.ver) best = v; }
    return best;
  }

  /* ---------- storage nodes ---------- */
  function node(id) {
    return {
      put: function* (ctx, p) {
        const st = ctx.state;
        const ver = ++st.ver;
        st.store[id][p.key] = { ver, items: p.items };
        const owners = ownersOf(st, p.key).filter((n) => n !== id);
        const targets = owners.filter((n) => st.view[id][n].state === 'alive');
        const skipped = owners.filter((n) => !targets.includes(n));
        if (skipped.length) st.stats.skippedReplication += skipped.length;
        for (const n of targets) ctx.spawn(function* (c) {
          const r = yield* xcall(c, n, 'replicate', { key: p.key, ver, items: p.items }, { timeout: REPLICA_TIMEOUT, quiet: 'all' });
          if (!r.ok) st.stats.lostReplication++;
        }, { quiet: 'all' });
        return { coordinator: id, ver, targets, skipped };
      },
      replicate(ctx, p) { const st = ctx.state; const cur = st.store[id][p.key]; if (!cur || cur.ver < p.ver) st.store[id][p.key] = { ver: p.ver, items: p.items }; return {}; },
      get(ctx, p) { const v = ctx.state.store[id][p.key]; return { coordinator: id, ver: v ? v.ver : 0, items: v ? v.items : [] }; },
      gossip(ctx, p) { merge(ctx.sim, id, p.digest); return { digest: digestOf(ctx.state, id) }; },
      merkle(ctx, p) { return { hashes: hashes(ctx.state, id, p.keys, p.buckets) }; },
      versions(ctx, p) { const st = ctx.state; return { versions: Object.fromEntries(p.keys.map((k) => [k, st.store[id][k] ? st.store[id][k].ver : 0])) }; },
      sync(ctx, p) { const st = ctx.state; const cur = st.store[id][p.key]; if (!cur || cur.ver < p.ver) { st.store[id][p.key] = { ver: p.ver, items: p.items }; return { applied: true }; } return { applied: false }; },
    };
  }
  const digestOf = (st, v) => Object.fromEntries(Object.entries(st.view[v]).map(([p, e]) => [p, e.hb]));
  function hashes(st, n, keys, buckets) {
    const out = new Array(buckets).fill(0);
    for (const k of keys) { const b = R.hashInt(k) % buckets; const v = st.store[n][k] ? st.store[n][k].ver : 0; out[b] = (out[b] * 31 + v + 7) >>> 0; }
    return out;
  }

  const sc = (SDL.scenarios['kv-membership'] = {
    id: 'kv-membership',
    seed: 43,
    minHopMs: 5,
    productWidth: 700,
    intro: `Crash ${NAME[VICTIM]} and watch the router declare it dead about a second later. Then pause it instead of crashing it, compare the two detectors, partition it away while Maya writes, and let anti-entropy repair what it missed. Nothing leaves the ring until Dev removes it.`,
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'Via the router', x: 90, y: 130, latency: 1, role: 'Writes and reads her cart through the router. Her reads go to owners in turn, so a replica that is behind shows up.', owns: ['What the phone shows'] },
        { id: 'dev', label: 'Dev’s console', kind: 'client', sub: 'Operator', x: 90, y: 470, latency: 1, role: 'Sees every node’s real state and the router’s verdict about it. Removes nodes from the ring and adds them back: membership changes are explicit.', owns: ['Membership decisions'] },
        { id: 'router', label: 'Request router', kind: 'gateway', sub: 'Gossips too', x: 330, y: 300, latency: 1, role: `Keeps its own view from gossip and routes to the first owner it believes alive. Detector: fixed ${TIMEOUT_MS} ms timeout or phi-accrual (threshold ${PHI_THRESHOLD}).`, ops: [{ name: 'put', desc: 'Route a write.' }, { name: 'get', desc: 'Route a read.' }, { name: 'gossip', desc: 'Exchange heartbeats.' }], owns: ['Its view of who is alive'] },
        { id: 'n1', label: 'Node 1', kind: 'db', sub: 'Ring member', x: 700, y: 90, latency: 3, role: 'Stores its ranges, gossips every 200 ms with a random peer, replicates writes to the owners it believes alive.', ops: [{ name: 'put', desc: 'Store and replicate.' }, { name: 'get', desc: 'Local copy.' }, { name: 'gossip', desc: 'Heartbeats.' }, { name: 'merkle', desc: 'Bucket hashes for a range.' }, { name: 'sync', desc: 'Accept a newer version.' }], owns: ['Keys in its ranges', 'Its view'] },
        { id: 'n2', label: 'Node 2', kind: 'db', sub: 'Ring member', x: 880, y: 190, latency: 3, role: 'Same as Node 1.', owns: ['Keys in its ranges', 'Its view'] },
        { id: 'n3', label: 'Node 3', kind: 'db', sub: 'Ring member', x: 880, y: 410, latency: 3, role: 'Same as Node 1.', owns: ['Keys in its ranges', 'Its view'] },
        { id: 'n4', label: 'Node 4', kind: 'db', sub: 'Ring member', x: 700, y: 510, latency: 3, role: 'Same as Node 1.', owns: ['Keys in its ranges', 'Its view'] },
        { id: 'n5', label: 'Node 5', kind: 'db', sub: 'Ring member', x: 520, y: 410, latency: 3, role: 'Same as Node 1.', owns: ['Keys in its ranges', 'Its view'] },
        { id: 'n6', label: 'Node 6', kind: 'db', sub: 'Ring member', x: 520, y: 190, latency: 3, role: 'Same as Node 1.', owns: ['Keys in its ranges', 'Its view'] },
        { id: 'repair', label: 'Anti-entropy', kind: 'worker', sub: 'Merkle trees', x: 1080, y: 300, latency: 2, role: `Every ${REPAIR_MS} ms, for each pair of replicas that share keys: compare ${BUCKETS} bucket hashes, then the versions inside differing buckets, then copy the newer version across. Also fills a new owner after a removal.`, owns: ['Nothing'] },
      ],
      edges: [
        { from: 'maya', to: 'router', latency: 15 },
        { from: 'dev', to: 'router', latency: 15 },
        ...BASE.map((n) => ({ from: 'router', to: n, latency: 2 })),
        { from: 'n1', to: 'n2', latency: 2 }, { from: 'n2', to: 'n3', latency: 2 }, { from: 'n3', to: 'n4', latency: 2 }, { from: 'n4', to: 'n5', latency: 2 }, { from: 'n5', to: 'n6', latency: 2 }, { from: 'n6', to: 'n1', latency: 2 },
        { from: 'n1', to: 'n4', latency: 2 }, { from: 'n2', to: 'n5', latency: 2 }, { from: 'n3', to: 'n6', latency: 2 },
        ...BASE.map((n) => ({ from: 'repair', to: n, latency: 2 })),
      ],
      queues: [],
    },
    modeLabels: { crashed: 'Crashed, disk lost', gc: 'Paused (garbage collection)', flap: 'Flapping', partition: `Partitioned with ${NAME[CUT[1]]}`, lag: `Network congested: gossip ${LAG_FACTOR}× slower` },
    failures: [
      { id: 'victim-crash', node: VICTIM, mode: 'crashed', label: `${NAME[VICTIM]} crashes`, desc: 'Disk and all. It stops gossiping; the detectors notice the silence. Its ranges stay under-replicated until Dev removes it.' },
      { id: 'victim-gc', node: VICTIM, mode: 'gc', label: `${NAME[VICTIM]} pauses for garbage collection`, desc: `Silent for ${GC_MS / 1000} s, then back as if nothing happened. The timeout detector calls it dead; phi-accrual waits longer.` },
      { id: 'victim-flap', node: VICTIM, mode: 'flap', label: `${NAME[VICTIM]} flaps`, desc: `Unresponsive for ${FLAP_MS / 1000} s, back for ${FLAP_MS / 1000} s, and again. Detectors flip, replication to it keeps failing.` },
      { id: 'partition', node: VICTIM, mode: 'partition', label: `Partition: ${NAME[VICTIM]} and ${NAME[CUT[1]]} cut off`, desc: 'Two nodes against four. Each side considers the other dead. The majority side keeps serving Maya; the minority side falls behind.' },
      { id: 'gossip-lag', node: 'router', mode: 'lag', label: 'Network congested: gossip slow', desc: `Heartbeats arrive ${LAG_FACTOR} times less often. A fixed timeout sees deaths everywhere; a detector that measures arrival gaps adapts.` },
      { id: 'repair-paused', node: 'repair', mode: 'paused', label: 'Anti-entropy paused', desc: 'Replicas that missed writes stay behind, and reads that land on them are stale.' },
    ],
    switches: Y.switches([
      ['phi', 'Phi-accrual detector (off: fixed timeout)', `On: a node is dead when the silence is improbable given the gaps between its recent heartbeats (phi > ${PHI_THRESHOLD}). Off: dead after ${TIMEOUT_MS} ms of silence, whatever the network is doing.`],
      ['merkle', 'Merkle trees for anti-entropy (off: compare every key)', `On: replicas exchange ${BUCKETS} bucket hashes and look only inside buckets that differ. Off: they exchange the version of every shared key, every round.`],
      ['autoRemove', `Remove dead nodes automatically after ${AUTO_REMOVE_MS / 1000} s (off: operator confirms)`, 'On: a node the router has considered dead for long enough leaves the ring and its ranges are re-replicated. Off: only Dev removes nodes, as in Dynamo.'],
    ]),
    presets: Y.presets({ phi: false, merkle: true, autoRemove: false }, [
      { id: 'steady', label: 'Gossip converges', desc: 'Every node gossips with a random peer every 200 ms. Within a few rounds every view has a fresh heartbeat for everyone. Maya writes and reads normally.', run: (s) => { s.schedule(300, () => startAdd(s, 'Socks')); s.schedule(1500, () => startRefresh(s)); } },
      { id: 'crash-timeout', label: 'A crash, detected by timeout', desc: `${NAME[VICTIM]} crashes half a second in. Its heartbeat stops climbing; about a second later the router and the other nodes declare it dead and route around it. The ring still lists it, so its ranges have one copy fewer until Dev acts.`, run: (s) => { s.schedule(300, () => startAdd(s, 'Socks')); s.schedule(500, () => s.inject(VICTIM, 'crashed')); s.schedule(2500, () => startAdd(s, 'Hat')); s.schedule(3500, () => startRefresh(s)); } },
      { id: 'crash-remove', label: 'A crash, then the operator removes the node', desc: `Same crash. At three seconds Dev removes ${NAME[VICTIM]} from the ring. Every key it owned gets a new third owner, and anti-entropy copies the data there. Replication factor restored.`, run: (s) => { s.schedule(300, () => startAdd(s, 'Socks')); s.schedule(500, () => s.inject(VICTIM, 'crashed')); s.schedule(3000, () => s.dispatch('remove', { node: VICTIM })); s.schedule(6000, () => startRefresh(s)); } },
      { id: 'gc-timeout', label: 'A GC pause mistaken for death', desc: `${NAME[VICTIM]} stops answering for ${GC_MS / 1000} s. After ${TIMEOUT_MS} ms the timeout detector calls it dead: a false positive. Maya’s write skips it. When it wakes up the heartbeats resume, it is alive again, and anti-entropy gives it the write it missed.`, run: (s) => { s.schedule(500, () => s.inject(VICTIM, 'gc', null, GC_MS)); s.schedule(1800, () => startAdd(s, 'Socks')); s.schedule(5500, () => startRefresh(s)); s.schedule(5900, () => startRefresh(s)); s.schedule(6300, () => startRefresh(s)); } },
      { id: 'gc-phi', label: 'The same pause with phi-accrual', desc: `Heartbeats had been arriving every 200 ms, so ${GC_MS / 1000} s of silence is suspicious but not yet phi > ${PHI_THRESHOLD}. No false death. The price: a write that tries to replicate to the paused node waits for a timeout instead of skipping it.`, sw: { phi: true }, run: (s) => { s.schedule(500, () => s.inject(VICTIM, 'gc', null, GC_MS)); s.schedule(1800, () => startAdd(s, 'Socks')); s.schedule(5500, () => startRefresh(s)); s.schedule(5900, () => startRefresh(s)); s.schedule(6300, () => startRefresh(s)); } },
      { id: 'lag-timeout', label: 'Slow gossip, fixed timeout: deaths everywhere', desc: `The network is congested and heartbeats arrive ${LAG_FACTOR} times less often, so most gaps exceed the ${TIMEOUT_MS} ms timeout. Healthy nodes are declared dead and come back over and over. Writes skip replicas that are fine.`, run: (s) => { s.schedule(1200, () => s.inject('router', 'lag')); s.schedule(2500, () => startAdd(s, 'Socks')); s.schedule(5000, () => startRefresh(s)); } },
      { id: 'lag-phi', label: 'Slow gossip, phi-accrual adapts', desc: 'The same congestion. Phi is measured against the gaps actually observed: as the long gaps enter the history, long silences stop being improbable. At most one early verdict flips while it adapts, then no churn.', sw: { phi: true }, run: (s) => { s.schedule(1200, () => s.inject('router', 'lag')); s.schedule(2500, () => startAdd(s, 'Socks')); s.schedule(5000, () => startRefresh(s)); } },
      { id: 'flapping', label: 'A flapping node', desc: `${NAME[VICTIM]} alternates ${FLAP_MS / 1000} s silent, ${FLAP_MS / 1000} s fine. The router declares it dead, takes it back, declares it dead again. Every “back” is followed by failed replication. The fix is operational: remove it or repair it.`, run: (s) => { s.schedule(300, () => startAdd(s, 'Socks')); s.schedule(400, () => s.inject(VICTIM, 'flap')); s.schedule(3000, () => startAdd(s, 'Hat')); s.schedule(6000, () => startRefresh(s)); } },
      { id: 'partition-repair', label: 'Partition, then anti-entropy heals', desc: `${NAME[VICTIM]} and ${NAME[CUT[1]]} are cut off for two seconds. Maya’s write on the majority side never reaches ${NAME[VICTIM]}. After the heal the repair worker compares bucket hashes, finds the divergent bucket, and copies the newer version across.`, run: (s) => { s.schedule(500, () => s.inject(VICTIM, 'partition')); s.schedule(1000, () => startAdd(s, 'Socks')); s.schedule(2500, () => s.restore(VICTIM, 'partition')); s.schedule(5500, () => startRefresh(s)); s.schedule(5900, () => startRefresh(s)); s.schedule(6300, () => startRefresh(s)); } },
      { id: 'repair-paused', label: 'The same partition, anti-entropy paused', desc: `${NAME[VICTIM]} comes back behind and nothing repairs it. Maya’s reads go to the owners in turn; the one that lands on ${NAME[VICTIM]} shows the old cart.`, run: (s) => { s.inject('repair', 'paused'); s.schedule(500, () => s.inject(VICTIM, 'partition')); s.schedule(1000, () => startAdd(s, 'Socks')); s.schedule(2500, () => s.restore(VICTIM, 'partition')); s.schedule(5500, () => startRefresh(s)); s.schedule(5900, () => startRefresh(s)); s.schedule(6300, () => startRefresh(s)); } },
      { id: 'full-scan', label: 'Anti-entropy without Merkle trees', desc: 'The same partition and repair, but replicas compare the version of every shared key each round instead of a handful of hashes. Same result, many times the messages and comparisons.', sw: { merkle: false }, run: (s) => { s.schedule(500, () => s.inject(VICTIM, 'partition')); s.schedule(1000, () => startAdd(s, 'Socks')); s.schedule(2500, () => s.restore(VICTIM, 'partition')); s.schedule(5500, () => startRefresh(s)); s.schedule(5900, () => startRefresh(s)); s.schedule(6300, () => startRefresh(s)); } },
      { id: 'auto-remove', label: 'Automatic removal acts on a false positive', desc: `A ${(GC_MS + 1000) / 1000} s pause with automatic removal on. The router calls ${NAME[VICTIM]} dead after about a second and removes it from the ring ${AUTO_REMOVE_MS / 1000} s later, re-replicating everything it owned. Then it wakes up: healthy, full of data, and no longer a member. This is why Dynamo leaves removal to the operator.`, sw: { autoRemove: true }, run: (s) => { s.schedule(300, () => startAdd(s, 'Socks')); s.schedule(500, () => s.inject(VICTIM, 'gc', null, GC_MS + 1000)); s.schedule(6000, () => startRefresh(s)); } },
    ]),
    initialState: () => {
      const store = {}; const view = {};
      for (const n of BASE) store[n] = {};
      for (const v of GOSSIPERS) { view[v] = {}; for (const p of GOSSIPERS) view[v][p] = { hb: 0, seen: 0, gaps: [], state: 'alive', deadSince: 0 }; }
      for (const n of BASE) { const owners = R.owners(RING0, `cart:u${0}`, N); void owners; }
      return { config: { phi: false, merkle: true, autoRemove: false }, members: BASE.slice(), store, view, crashedAt: {}, hb: Object.fromEntries(GOSSIPERS.map((v) => [v, 0])), ver: 0, rr: 0, acked: null, stats: { gossip: 0, falseDeaths: 0, flaps: 0, detections: [], skippedReplication: 0, lostReplication: 0, repairRounds: 0, repairMsgs: 0, keysCompared: 0, repaired: 0, removals: 0 } };
    },
    initialUI: () => ({ maya: { cart: [], pending: false, error: '', lastMs: null } }),
    actions: {
      add(sim, a) { startAdd(sim, a.item); },
      refresh(sim) { startRefresh(sim); },
      crash(sim) { sim.inject(VICTIM, 'crashed'); },
      gc(sim) { sim.inject(VICTIM, 'gc', null, GC_MS); },
      partition(sim, a) { if (a.on) sim.inject(VICTIM, 'partition'); else sim.restore(VICTIM, 'partition'); },
      remove(sim, a) { removeNode(sim, a.node || VICTIM, 'operator'); },
      rejoin(sim, a) { addNode(sim, a.node || VICTIM); },
      repairNow(sim) { sim.spawn(function* (ctx) { yield* repairRound(ctx, true); }, { self: 'repair' }); },
    },
    handlers: Object.assign({
      router: {
        put: function* (ctx, p) {
          const st = ctx.state;
          const owners = ownersOf(st, p.key);
          const alive = owners.filter((n) => st.view.router[n].state === 'alive');
          if (!alive.length) ctx.fail('UNAVAILABLE', `The router believes every owner of ${p.key} is dead.`);
          return ctx.must(yield* xcall(ctx, alive[0], 'put', p, { timeout: 2000, quiet: ctx.quiet }));
        },
        get: function* (ctx, p) {
          const st = ctx.state;
          const owners = ownersOf(st, p.key);
          const alive = owners.filter((n) => st.view.router[n].state === 'alive');
          if (!alive.length) ctx.fail('UNAVAILABLE', `The router believes every owner of ${p.key} is dead.`);
          const target = alive[st.rr++ % alive.length];
          return ctx.must(yield* xcall(ctx, target, 'get', p, { timeout: 1200 }));
        },
        gossip(ctx, p) { merge(ctx.sim, 'router', p.digest); return { digest: digestOf(ctx.state, 'router') }; },
      },
    }, Object.fromEntries(BASE.map((n) => [n, node(n)]))),
    setup(sim) {
      for (const v of GOSSIPERS) sim.spawn(function* (ctx) {
        for (;;) {
          const lag = lagged(ctx.sim) ? LAG_FACTOR : 1;
          yield ctx.wait(Math.round(GOSSIP_MS * lag * (0.8 + 0.4 * ctx.rand())));
          const st = ctx.state;
          if (silent(ctx.sim, v)) continue;
          st.hb[v]++; st.view[v][v].hb = st.hb[v]; st.view[v][v].seen = ctx.now();
          detect(ctx.sim, v);
          // Prefer peers believed alive; now and then also probe one believed dead so a recovery is noticed.
          const all = GOSSIPERS.filter((p) => p !== v && (p === 'router' || st.members.includes(p)));
          const livePeers = all.filter((p) => st.view[v][p].state === 'alive');
          const deadPeers = all.filter((p) => st.view[v][p].state !== 'alive');
          const pick = deadPeers.length && (!livePeers.length || ctx.rand() < 0.3) ? deadPeers : livePeers;
          const peer = pick[Math.floor(ctx.rand() * pick.length)];
          st.stats.gossip++;
          // The exchange runs on its own so a peer that never answers does not stall this node's heartbeat.
          ctx.spawn(function* (c) {
            const r = yield* xcall(c, peer, 'gossip', { digest: digestOf(st, v) }, { timeout: 300, quiet: 'all' });
            if (r.ok && !silent(c.sim, v)) { merge(c.sim, v, r.value.digest); detect(c.sim, v); }
          }, { quiet: 'all' });
        }
      }, { self: v, quiet: 'all' });
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(REPAIR_MS);
          if (!ctx.alive()) continue;
          yield* repairRound(ctx, false);
        }
      }, { self: 'repair', quiet: 'all' });
      Y.load(sim, 'router', () => LOAD_RATE, function* (c, i) {
        const key = KEYS[Math.floor(c.rand() * (KEYS.length - 1))];
        yield c.call('router', 'put', { key, items: [`item${i % 7}`] }, { timeout: 2500, quiet: 'all' });
      });
    },
    onFailureChange(sim, ch) {
      if (ch.mode === 'crashed' && ch.active && BASE.includes(ch.node)) { sim.state.store[ch.node] = {}; sim.state.crashedAt[ch.node] = sim.now; sim.note(`${NAME[ch.node]} crashed and its disk is gone.`); }
    },
    consistency(sim) {
      const st = sim.state; const u = sim.ui.maya;
      const t = truth(sim);
      if (st.acked && t.ver < st.acked.ver) return { key: 'wrong', label: `Maya’s acknowledged cart (version ${st.acked.ver}) is on no node: the only copy died with its coordinator before replication.` };
      if (u.pending) return { key: 'stale', label: 'Maya is waiting.' };
      if (u.error) return { key: 'stale', label: `Maya’s last request failed: ${u.error}` };
      const members = st.members;
      const crashedMembers = members.filter((n) => crashed(sim, n));
      const alive = BASE.filter((n) => !crashed(sim, n));
      const excluded = alive.filter((n) => !members.includes(n));
      if (partitioned(sim)) return { key: 'stale', label: `Partition: ${CUT.map((n) => NAME[n]).join(' and ')} are cut off. Each side considers the other dead; the minority side is falling behind.` };
      if (sim.nodes[VICTIM].modes.flap) return { key: 'stale', label: `${NAME[VICTIM]} is flapping: declared dead and taken back ${st.stats.flaps} time${st.stats.flaps === 1 ? '' : 's'} so far. Replication to it keeps failing; it needs removing or fixing.` };
      const falseNow = [];
      for (const v of GOSSIPERS) if (!silent(sim, v)) for (const p of (v === 'router' ? members : members)) if (p !== v && st.view[v][p].state === 'dead' && !crashed(sim, p)) falseNow.push([v, p]);
      if (falseNow.length) { const [v, p] = falseNow[0]; return { key: 'stale', label: `${NAME[v].replace(/^the /, 'The ')} considers ${NAME[p]} dead, but it is ${why(sim, p)}${falseNow.length > 1 ? `; ${falseNow.length} such verdicts across the cluster` : ''}. Writes skip it and it falls behind.` }; }
      const owners = ownersOf(st, KEY);
      const behind = owners.filter((n) => !crashed(sim, n) && (!st.store[n][KEY] ? t.ver > 0 : st.store[n][KEY].ver < t.ver));
      if (u.cart.length !== t.items.length || u.cart.some((it) => !t.items.includes(it))) return { key: 'stale', label: `The phone shows ${u.cart.join(', ') || 'an empty cart'}; the newest version has ${t.items.join(', ') || 'nothing'}. The read landed on a replica that is behind.` };
      if (excluded.length) return { key: 'stale', label: `${excluded.map((n) => NAME[n]).join(', ')} ${excluded.length === 1 ? 'is' : 'are'} up but no longer in the ring${st.config.autoRemove ? ': removed automatically during a pause' : ''}. ${excluded.length === 1 ? 'Its' : 'Their'} data was re-replicated for nothing and ${excluded.length === 1 ? 'it' : 'they'} must be added back.` };
      if (behind.length) return { key: 'stale', label: `${behind.map((n) => NAME[n]).join(', ')} ${behind.length === 1 ? 'holds' : 'hold'} an old version of Maya’s cart${sim.nodes.repair.modes.paused ? ' and anti-entropy is paused' : '; anti-entropy will catch it up within a round'}.` };
      if (crashedMembers.length) return { key: 'stale', label: `${crashedMembers.map((n) => NAME[n]).join(', ')} crashed but still own${crashedMembers.length === 1 ? 's' : ''} ring ranges: ${N - crashedMembers.filter((n) => owners.includes(n)).length} of ${N} copies for keys there until the operator removes ${crashedMembers.length === 1 ? 'it' : 'them'}.` };
      const detectedReal = st.stats.detections.filter((d) => d.real).length;
      return { key: 'ok', label: `All ${members.length} members and the router agree on who is alive; Maya’s cart is at version ${t.ver} on all ${owners.length} owners${st.stats.falseDeaths ? `; ${st.stats.falseDeaths} false death${st.stats.falseDeaths === 1 ? '' : 's'} along the way, repaired by anti-entropy` : ''}${detectedReal ? `; ${detectedReal} real crash detected` : ''}${st.stats.repaired ? `; ${st.stats.repaired} key${st.stats.repaired === 1 ? '' : 's'} repaired` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const first = st.stats.detections[0];
      const deadNow = BASE.filter((n) => st.view.router[n].state === 'dead');
      let behindKeys = 0;
      for (const k of KEYS) { let best = 0; const os = ownersOf(st, k).filter((n) => !crashed(sim, n)); for (const n of os) best = Math.max(best, st.store[n][k] ? st.store[n][k].ver : 0); for (const n of os) if ((st.store[n][k] ? st.store[n][k].ver : 0) < best) behindKeys++; }
      return [
        { label: 'Detector', value: st.config.phi ? `phi-accrual > ${PHI_THRESHOLD}` : `timeout ${TIMEOUT_MS} ms` },
        { label: 'Router considers dead', value: deadNow.length ? deadNow.map((n) => NAME[n]).join(', ') : 'nobody', tone: deadNow.length ? 'warn' : '' },
        { label: 'First detection', value: first ? `${NAME[first.node]} at ${SDL.fmtMs(first.at)}${first.real ? '' : ' (false)'}` : '–' },
        { label: 'False deaths / flaps', value: `${st.stats.falseDeaths} / ${st.stats.flaps}`, tone: st.stats.falseDeaths ? 'warn' : '' },
        { label: 'Ring members', value: `${st.members.length} of ${BASE.length}`, tone: st.members.length < BASE.length ? 'warn' : '' },
        { label: 'Replica copies behind', value: behindKeys, tone: behindKeys > 5 ? 'warn' : '' },
        { label: 'Replication skipped / timed out', value: `${st.stats.skippedReplication} / ${st.stats.lostReplication}`, tone: st.stats.skippedReplication + st.stats.lostReplication ? 'warn' : '' },
        { label: 'Repair: messages / keys compared / repaired', value: `${Y.num(st.stats.repairMsgs)} / ${Y.num(st.stats.keysCompared)} / ${st.stats.repaired}` },
        { label: 'Gossip messages', value: Y.num(st.stats.gossip) },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: `Maya’s cart lives on ${OWNERS0.map((n) => NAME[n]).join(', ')}. Dev’s console shows each node’s real state next to the router’s verdict, and what each node holds of Maya’s cart.`,
          side: `<p class="ops-title">Dev’s console</p><div class="ops-traffic">${Y.btn('crash', `Crash ${NAME[VICTIM]}`, { cls: 'secondary' })}${Y.btn('gc', `Pause ${NAME[VICTIM]} ${GC_MS / 1000} s`, { cls: 'secondary' })}${Y.btn('partition', 'Partition', { arg: { on: true }, cls: 'secondary' })}${Y.btn('partition', 'Heal', { arg: { on: false }, cls: 'secondary' })}${Y.btn('remove', `Remove ${NAME[VICTIM]} from the ring`, { arg: { node: VICTIM } })}${Y.btn('rejoin', `Add ${NAME[VICTIM]} back`, { arg: { node: VICTIM }, cls: 'secondary' })}${Y.btn('repairNow', 'Repair now', { cls: 'secondary' })}</div><div data-ref="nodes"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state; const u = sim.ui.maya;
        const t = truth(sim);
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Cart</p><p class="app-sub">Maya · via the router · detector ${st.config.phi ? 'phi' : 'timeout'}</p></div>`,
          cart: u.cart.length ? u.cart.map((it) => `<div class="app-card"><span class="app-kv"><strong>${esc(it)}</strong><span>1</span></span></div>`).join('') : '<p class="app-sub">Your cart is empty.</p>',
          msg: Y.msg(u.error, 'fail') || (u.pending ? '<p class="app-msg"><span class="spinner"></span>Working…</p>' : ''),
          actions: `<div class="app-row">${['Socks', 'Hat', 'Mug'].map((it) => Y.btn('add', `Add ${it.toLowerCase()}`, { arg: { item: it }, cls: u.cart.includes(it) ? 'secondary' : '', disabled: u.pending })).join('')}</div><div class="app-row">${Y.btn('refresh', 'Refresh', { cls: 'secondary', disabled: u.pending })}</div>`,
        }, {});
        const owners = ownersOf(st, KEY);
        const rows = BASE.map((n) => {
          const real = why(sim, n);
          const e = st.view.router[n];
          const member = st.members.includes(n);
          const verdict = !member ? 'gone' : e.state;
          const phi = phiOf(st, 'router', n, sim.now);
          const silence = sim.now - e.seen;
          const v = st.store[n][KEY];
          const isOwner = owners.includes(n);
          const behind = isOwner && !crashed(sim, n) && (v ? v.ver : 0) < t.ver;
          const tone = crashed(sim, n) ? 'fail' : real !== 'up' || behind || verdict === 'dead' || !member ? 'warn' : 'ok';
          const held = Object.keys(st.store[n]).length;
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name"><strong>${NAME[n]}${isOwner ? ' · owns Maya’s cart' : ''}${partitioned(sim) && CUT.includes(n) ? ' · cut off' : ''}</strong><span>really: ${real} · router says <span class="kv-verdict" data-v="${verdict}">${verdict === 'gone' ? 'removed' : verdict}</span></span></div><span class="ops-val">${member ? `heartbeat ${e.hb}, silent ${SDL.fmtMs(silence)}${st.config.phi ? `, phi ${phi == null ? '–' : phi.toFixed(1)}` : ''} · ` : 'not a member · '}${held} keys${isOwner ? ` · cart v${v ? v.ver : 0}${behind ? ' (behind)' : v && v.ver === t.ver && t.ver ? ' ✓' : ''}` : ''}</span></div>`;
        }).join('');
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="nodes"]'), {
          rows: `<div class="ops-shards">${rows}</div>`,
          cfg: `<p class="app-sub">Gossip every ${GOSSIP_MS} ms${lagged(sim) ? ` (congested: ×${LAG_FACTOR})` : ''} · detector ${st.config.phi ? `phi > ${PHI_THRESHOLD}` : `${TIMEOUT_MS} ms timeout`} · anti-entropy ${sim.nodes.repair.modes.paused ? 'paused' : `every ${REPAIR_MS} ms, ${st.config.merkle ? 'Merkle' : 'full scan'}`} · removal ${st.config.autoRemove ? 'automatic' : 'by operator'} · newest cart: v${t.ver} ${t.items.join(', ') || '(empty)'}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });

  /* ---------- anti-entropy ---------- */
  function* repairRound(ctx, manual) {
    const st = ctx.state; const sim = ctx.sim;
    st.stats.repairRounds++;
    const members = st.members.filter((n) => !crashed(sim, n));
    let repairedThisRound = 0;
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j];
      if (!reachable(sim, 'repair', a) || !reachable(sim, 'repair', b) || cut(sim, a, b)) continue;
      const shared = KEYS.filter((k) => { const o = ownersOf(st, k); return o.includes(a) && o.includes(b); });
      if (!shared.length) continue;
      let candidates;
      if (st.config.merkle) {
        const ha = yield* xcall(ctx, a, 'merkle', { keys: shared, buckets: BUCKETS }, { timeout: 400, quiet: 'all' });
        const hb = yield* xcall(ctx, b, 'merkle', { keys: shared, buckets: BUCKETS }, { timeout: 400, quiet: 'all' });
        st.stats.repairMsgs += 2;
        if (!ha.ok || !hb.ok) continue;
        const diff = []; for (let k = 0; k < BUCKETS; k++) if (ha.value.hashes[k] !== hb.value.hashes[k]) diff.push(k);
        if (!diff.length) continue;
        candidates = shared.filter((k) => diff.includes(R.hashInt(k) % BUCKETS));
      } else {
        candidates = shared;
        st.stats.repairMsgs += 2 * shared.length;
      }
      const va = yield* xcall(ctx, a, 'versions', { keys: candidates }, { timeout: 400, quiet: 'all' });
      const vb = yield* xcall(ctx, b, 'versions', { keys: candidates }, { timeout: 400, quiet: 'all' });
      if (st.config.merkle) st.stats.repairMsgs += 2;
      if (!va.ok || !vb.ok) continue;
      st.stats.keysCompared += candidates.length;
      for (const k of candidates) {
        const x = va.value.versions[k], y = vb.value.versions[k];
        if (x === y) continue;
        const [from, to] = x > y ? [a, b] : [b, a];
        const src = st.store[from][k];
        if (!src) continue;
        const r = yield* xcall(ctx, to, 'sync', { key: k, ver: src.ver, items: src.items }, { timeout: 400, quiet: 'all' });
        st.stats.repairMsgs++;
        if (r.ok && r.value.applied) { st.stats.repaired++; repairedThisRound++; if (k === KEY) ctx.log({ op: `repaired Maya’s cart on ${NAME[to]}`, status: 'ok', detail: `${NAME[to]} held version ${y} of ${KEY}; ${NAME[from]} had ${x}. The newer version was copied over.` }); }
      }
    }
    if (repairedThisRound && repairedThisRound > 1) ctx.log({ op: `anti-entropy repaired ${repairedThisRound} keys`, status: 'ok', detail: `${st.config.merkle ? 'Bucket hashes pointed at the divergent ranges' : 'Every shared key was compared'}; ${repairedThisRound} replica copies were brought up to date${manual ? ' (manual run)' : ''}.` });
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
