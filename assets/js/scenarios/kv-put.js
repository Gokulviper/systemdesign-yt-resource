/*
 * Distributed key-value store: a cart that never loses an item.
 * Maya's cart is one key. A request router hashes it onto a ring of six
 * storage nodes and sends the request to a coordinator, one of the three
 * replicas that own the key. The coordinator writes to all three and answers
 * once W of them have acknowledged; reads ask R replicas and reconcile what
 * comes back. Versions carry either a timestamp (last writer wins) or a vector
 * clock, which is what decides whether an item added on a tablet that was
 * offline survives the reconnect.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const R = Y.ring;
  const V = Y.vclock;

  const NODES = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
  const KEY = 'cart:maya';
  const N = 3;
  const VNODES = 64;
  const RING = R.create(NODES, VNODES);
  const OWNERS = R.owners(RING, KEY, N); // the preference list for Maya's cart
  const STANDINS = R.owners(RING, KEY, NODES.length).slice(N); // who takes a hint when an owner is down
  const LAZY_MS = 300; // with W = 1 the coordinator batches replication
  const HINT_POLL_MS = 500;
  const DEVICE = { maya: 'phone', tablet: 'tablet' };
  const NAME = {}; NODES.forEach((n, i) => { NAME[n] = `Node ${i + 1}`; });

  const union = Y.kv.union;
  const W = (st) => (st.config.w2 ? 2 : 1);
  const RQ = (st) => (st.config.r2 ? 2 : 1);
  const offline = (sim) => !!sim.nodes.tablet.modes.offline;
  const dead = (sim, n) => !!(sim.nodes[n].modes.down || sim.nodes[n].modes.crashed);

  /** Replace what a replica holds for the key with the versions a write leaves behind. */
  function applyWrite(st, node, incoming, context) {
    const rep = st.store[node];
    const res = Y.kv.applyWrite(rep[KEY], incoming, context, st.config.vclock);
    rep[KEY] = res.versions;
    for (const it of res.lost) if (!st.lost.includes(it)) st.lost.push(it);
    st.stats.overwritten += res.lost.length;
    return res;
  }
  /** Reconcile the versions several replicas returned into one cart. */
  const reconcile = (st, responses) => Y.kv.reconcile(responses.flatMap((r) => r.versions), st.config.vclock);
  /** Every version on every live replica, reconciled: what the store as a whole knows. */
  function truth(sim) {
    const st = sim.state;
    const resp = NODES.map((n) => ({ versions: st.store[n][KEY] || [] }));
    const hinted = NODES.flatMap((n) => st.hints[n].map((h) => ({ versions: [h.version] })));
    return reconcile(st, resp.concat(hinted));
  }

  /* ---------- the devices ---------- */
  function startAdd(sim, dev, item) {
    const st = sim.state;
    const u = sim.ui[dev];
    sim.startAction(`Maya (${DEVICE[dev]}): add ${item}`, function* (ctx) {
      u.pending = true; u.error = '';
      const items = union([u.cart, [item]]);
      if (dev === 'tablet' && offline(ctx.sim)) {
        u.cart = items; u.queued.push(item); u.pending = false;
        Y.L(ctx, { displayed: ['yes', 'Shown at once from the local copy.'], accepted: ['no', 'The tablet is offline; the write waits in a local queue.'], committed: 'no', async: 'n/a', retrySafe: ['yes', 'The whole cart is sent when the tablet reconnects.'] });
        ctx.explain(`The tablet is offline, so “${item}” is only in its local copy of the cart. When it reconnects it will send the cart it knows about, with the version it last read as context. Whether that overwrites what the phone added in the meantime is decided by the versioning rule.`);
        return;
      }
      yield* put(ctx, dev, items, `Added “${item}”.`);
    }, { self: dev });
  }
  function* put(ctx, dev, items, what) {
    const st = ctx.state;
    const u = ctx.ui[dev];
    u.pending = true; u.error = '';
    Y.L(ctx, {
      displayed: ['pending', 'The cart shows a spinner until the coordinator answers.'],
      retrySafe: ['yes', 'A put carries the whole cart and the version it was based on, so sending it twice stores the same thing.'],
    });
    const payload = { key: KEY, items, context: u.clock, device: dev };
    const r = yield* ctx.retry({ attempts: 2, baseMs: 200, retryable: (x) => x.error && x.error.code === 'TIMEOUT' }, function* () {
      return yield ctx.call('router', 'put', payload, { timeout: 1500 });
    });
    ctx.recordOutcome(r.ok, r.latency);
    u.pending = false; u.lastMs = r.latency;
    if (r.ok) {
      const v = r.value;
      u.cart = v.items; u.clock = v.clock; u.queued = [];
      u.lastWrite = { acked: v.acked, hinted: v.hinted, coordinator: v.coordinator, siblings: v.siblings, w: v.w };
      st.acked = union([st.acked, items]);
      Y.L(ctx, {
        displayed: ['yes', `${v.items.length} item${v.items.length === 1 ? '' : 's'} in the cart.`],
        accepted: ['yes', `${NAME[v.coordinator]} coordinated the write.`],
        committed: v.acked.length >= 2 ? ['yes', `${v.acked.length} replicas acknowledged${v.hinted.length ? `, ${v.hinted.length} of them a stand-in holding a hint` : ''}.`] : ['pending', `Only ${NAME[v.coordinator]} has it. Replication to the other two is batched and runs in the background.`],
        async: v.acked.length >= N ? 'yes' : ['pending', 'Remaining replicas, hint replay.'],
      });
      const sib = v.siblings > 1 ? ` The store now holds ${v.siblings} concurrent versions (siblings) of the cart; the app merged them by union, which is why nothing is missing.` : '';
      ctx.explain(`${what} ${NAME[v.coordinator]} wrote the cart to ${v.acked.map((n) => NAME[n] + (v.hinted.includes(n) ? ' (stand-in)' : '')).join(' and ')} and answered after ${v.w} acknowledgement${v.w === 1 ? '' : 's'} in ${SDL.fmtMs(r.latency)}.${r.attempts > 1 ? ' The first attempt timed out and the retry stored the same cart again, which is safe.' : ''}${sib}`);
    } else {
      u.error = r.error.message;
      Y.failed(ctx, 'The cart shows an error and keeps its previous contents.');
      const why = {
        QUORUM: 'Fewer than W replicas answered and sloppy quorums are off, so the coordinator refused the write rather than pretend it was durable. The cart is unchanged everywhere: honest, but unavailable.',
        UNAVAILABLE: 'Nothing in the preference list would take the write.',
        TIMEOUT: 'The router never heard back. The write may or may not have landed; a retry with the same context is safe.',
        NOT_OWNER: 'The router sent the request to a node that does not own the key and could not refresh its map from the metadata service.',
      }[r.error.code];
      ctx.explain(why || r.error.message);
    }
    return r;
  }
  function startRefresh(sim, dev) {
    const st = sim.state;
    const u = sim.ui[dev];
    sim.startAction(`Maya (${DEVICE[dev]}): refresh cart`, function* (ctx) {
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'A read changes nothing.'] });
      const r = yield ctx.call('router', 'get', { key: KEY, device: dev }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency;
      if (!r.ok) { u.error = r.error.message; Y.failed(ctx, 'The cart could not be refreshed.'); ctx.explain(r.error.message); return; }
      const v = r.value;
      const before = u.cart.slice();
      u.cart = v.items; u.clock = v.clock; u.queued = [];
      const t = truth(ctx.sim);
      const missing = t.items.filter((it) => !v.items.includes(it));
      Y.L(ctx, { displayed: ['yes', `${v.items.length} item${v.items.length === 1 ? '' : 's'}.`], accepted: 'yes', committed: 'n/a', async: v.repaired ? ['yes', `Read repair sent the newest version to ${v.repaired.map((n) => NAME[n]).join(', ')}.`] : 'n/a' });
      const fromTxt = v.from.map((n) => `${NAME[n]} (${v.counts[n]} item${v.counts[n] === 1 ? '' : 's'})`).join(' and ');
      if (missing.length) ctx.explain(`${NAME[v.coordinator]} read ${fromTxt} with R = ${v.r} and returned ${v.items.length} item${v.items.length === 1 ? '' : 's'}. Another replica already has “${missing.join('”, “')}”: with W = ${W(st)} and R = ${v.r}, R + W is ${W(st) + v.r}, not more than N = ${N}, so a read can miss a write that was acknowledged moments ago.`);
      else ctx.explain(`${NAME[v.coordinator]} read ${fromTxt} with R = ${v.r}${v.siblings > 1 ? `, found ${v.siblings} siblings and merged them by union` : ''}${v.repaired ? `, and repaired ${v.repaired.map((n) => NAME[n]).join(', ')}, which ${v.repaired.length === 1 ? 'was' : 'were'} behind` : ''}. ${before.length === v.items.length ? 'Nothing changed.' : `The ${DEVICE[dev]} now shows ${v.items.length} item${v.items.length === 1 ? '' : 's'}.`}`);
    }, { self: dev });
  }
  function startSync(sim) {
    const u = sim.ui.tablet;
    if (!u.queued.length) return;
    const items = u.cart.slice();
    const queued = u.queued.slice();
    sim.startAction(`Maya (tablet): back online, sync ${queued.length} queued item${queued.length === 1 ? '' : 's'}`, function* (ctx) {
      yield* put(ctx, 'tablet', items, `The tablet sent the cart it knew about (${items.join(', ')}) with the version it read before going offline as context.`);
    }, { self: 'tablet' });
  }

  /* ---------- the store ---------- */
  function* writeReplicas(ctx, coordinator, version, context) {
    const st = ctx.state;
    const sim = ctx.sim;
    const w = W(st);
    const targets = OWNERS.slice();
    const acked = [];
    const hinted = [];
    const failed = [];
    const chosen = [];
    let pending = 0;
    const attempt = (node, hintFor) => {
      pending++;
      ctx.spawn(function* (c) {
        const r = yield c.call(node, 'store', { key: KEY, version, context, hintFor }, { timeout: 600 });
        pending--;
        if (r.ok) { acked.push(node); if (hintFor) hinted.push(node); return; }
        failed.push(node);
        if (!st.config.sloppy || hintFor) return;
        // Sloppy quorum: the next healthy node on the ring takes the write and a hint naming the replica it stands in for.
        const standin = STANDINS.find((s) => !chosen.includes(s) && !failed.includes(s) && !dead(sim, s));
        if (!standin) return;
        chosen.push(standin);
        c.log({ op: `hint for ${NAME[node]} → ${NAME[standin]}`, status: 'warn', detail: `${NAME[node]} did not answer. ${NAME[standin]} stores the write with a hint and will hand it to ${NAME[node]} when it is back.` });
        attempt(standin, node);
      });
    };
    // The coordinator's own copy is a local write.
    const local = applyWrite(st, coordinator, version, context);
    acked.push(coordinator);
    if (w === 1) {
      // Acknowledge now; replicate in a batch shortly. A crash in between loses the only copy.
      const actionId = ctx.actionId;
      ctx.spawn(function* (c) {
        yield c.wait(LAZY_MS);
        if (dead(sim, coordinator)) { st.stats.lostReplication++; c.log({ op: 'replication batch lost', status: 'lost', detail: `${NAME[coordinator]} went down before the batched replication left. It was the only copy of the acknowledged write.` }); return; }
        for (const t of targets.filter((x) => x !== coordinator)) attempt(t);
        while (pending > 0) yield c.wait(10);
        sim.setLedger(actionId, 'async', 'yes', `Replicated to ${acked.filter((x) => x !== coordinator).map((n) => NAME[n]).join(', ')} ${LAZY_MS} ms after the acknowledgement.`);
        if (acked.length >= 2) sim.setLedger(actionId, 'committed', 'yes', `${acked.length} replicas now hold the write.`);
      }, { actionId });
      return { acked: acked.slice(), hinted, w, siblings: local.siblings || 1 };
    }
    for (const t of targets.filter((x) => x !== coordinator)) attempt(t);
    while (acked.length < w && pending > 0) yield ctx.wait(5);
    if (acked.length < w) ctx.fail('QUORUM', `Only ${acked.length} of W = ${w} replicas acknowledged (${failed.map((n) => NAME[n]).join(', ')} unavailable).`);
    // Keep waiting for the rest in the background so the ledger can report full replication.
    const actionId = ctx.actionId;
    ctx.spawn(function* (c) { while (pending > 0) yield c.wait(10); if (acked.length >= N) sim.setLedger(actionId, 'async', 'yes', `All ${N} copies written${hinted.length ? ` (${hinted.length} as hints)` : ''}.`); }, { actionId });
    return { acked: acked.slice(), hinted: hinted.slice(), w, siblings: local.siblings || 1 };
  }

  function coordinator(id) {
    return {
      coordinatePut: function* (ctx, p) {
        const st = ctx.state;
        if (!OWNERS.includes(id)) ctx.fail('NOT_OWNER', `${NAME[id]} does not own ${KEY}.`);
        const context = p.context || {};
        let clock = {};
        if (st.config.vclock) {
          // One entry per writer (device): the coordinator advances the writer's own counter from the context it sent.
          // Two devices writing from the same context get concurrent clocks; a retry of one write gets the same clock.
          clock = Object.assign({}, context);
          clock[p.device] = (context[p.device] || 0) + 1;
        }
        const version = { items: p.items, clock, ts: ctx.now(), writer: id, device: p.device };
        st.stats.puts++;
        const res = yield* writeReplicas(ctx, id, version, context);
        const view = reconcile(st, [{ versions: st.store[id][KEY] }]);
        return Object.assign({ coordinator: id, items: view.items, clock: view.clock }, res, { siblings: view.siblings || res.siblings });
      },
      coordinateGet: function* (ctx, p) {
        const st = ctx.state;
        if (!OWNERS.includes(id)) ctx.fail('NOT_OWNER', `${NAME[id]} does not own ${KEY}.`);
        const r = RQ(st);
        st.stats.gets++;
        const order = [id].concat(OWNERS.filter((n) => n !== id));
        const responses = [{ node: id, versions: (st.store[id][KEY] || []).slice() }];
        let pending = 0;
        for (const n of order.slice(1)) {
          pending++;
          ctx.spawn(function* (c) { const x = yield c.call(n, 'read', { key: KEY }, { timeout: 600 }); pending--; if (x.ok) responses.push({ node: n, versions: x.value.versions }); });
        }
        while (responses.length < r && pending > 0) yield ctx.wait(5);
        if (responses.length < r) ctx.fail('QUORUM', `Only ${responses.length} of R = ${r} replicas answered.`);
        const used = responses.slice(0, r);
        const merged = reconcile(st, used);
        const counts = {}; for (const x of used) counts[x.node] = reconcile(st, [x]).items.length;
        // Read repair: any replica that returned something older than the reconciled version gets it now.
        let repaired = null;
        if (st.config.readRepair) {
          const behind = used.filter((x) => { const v = reconcile(st, [x]); return v.items.length !== merged.items.length || v.items.some((it) => !merged.items.includes(it)); }).map((x) => x.node);
          if (behind.length) {
            repaired = behind;
            const version = { items: merged.items, clock: merged.clock, ts: merged.ts, writer: id, device: 'repair' };
            for (const n of behind) ctx.spawn(function* (c) { const x = yield c.call(n, 'store', { key: KEY, version, context: merged.clock, repair: true }, { timeout: 600 }); if (x.ok) st.stats.repairs++; });
          }
        }
        return { coordinator: id, r, from: used.map((x) => x.node), counts, items: merged.items, clock: merged.clock, siblings: merged.siblings, repaired };
      },
      store(ctx, p) {
        const st = ctx.state;
        if (p.hintFor) {
          st.hints[id].push({ target: p.hintFor, key: p.key, version: p.version, context: p.context });
          st.stats.hints++;
          return { hinted: true };
        }
        const res = applyWrite(st, id, p.version, p.context || {});
        return { stored: res.kept === 'new', siblings: res.siblings || 1 };
      },
      read(ctx) { return { versions: (ctx.state.store[id][KEY] || []).slice() }; },
    };
  }

  const sc = (SDL.scenarios['kv-put'] = {
    id: 'kv-put',
    seed: 11,
    productWidth: 640,
    intro: 'Add an item from the phone and refresh the tablet. Then take the tablet offline, add on both devices, and bring it back under last-writer-wins and under vector clocks. Lower W to one and crash the coordinator.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'Cart app', x: 90, y: 130, latency: 1, role: 'Adds items and refreshes the cart. Keeps the version (vector clock) it last read and sends it back as context with every write.', owns: ['What the phone shows', 'Last read version'] },
        { id: 'tablet', label: 'Maya’s tablet', kind: 'client', sub: 'Same account', x: 90, y: 430, latency: 1, role: 'Same cart, second device. Can go offline: edits queue locally and are sent when it reconnects.', owns: ['What the tablet shows', 'Offline queue'] },
        { id: 'router', label: 'Request router', kind: 'gateway', sub: 'Hash → preference list', x: 330, y: 280, latency: 1, role: 'Hashes the key onto the ring, looks up the three owners, and forwards to the first healthy one, the coordinator. Refreshes its copy of the ring from the metadata service when a node says it is not an owner.', ops: [{ name: 'put', desc: 'Route a write.' }, { name: 'get', desc: 'Route a read.' }], owns: ['A cached copy of the ring'] },
        { id: 'meta', label: 'Metadata service', kind: 'service', sub: 'Who owns what', x: 330, y: 80, latency: 2, role: 'The authority on the ring: which node holds which tokens. Routers cache it; nodes gossip it.', ops: [{ name: 'getRing', desc: 'Current ring.' }], owns: ['The ring'] },
        { id: 'n1', label: 'Node 1', kind: 'db', sub: `${VNODES} tokens`, x: 800, y: 80, latency: 3, role: 'A storage node. Holds the keys whose hash falls just before its tokens on the ring, and coordinates writes and reads for them.', ops: [{ name: 'coordinatePut', desc: 'Write to N replicas, ack at W.' }, { name: 'coordinateGet', desc: 'Read R replicas, reconcile.' }, { name: 'store', desc: 'Store a version (or a hint).' }, { name: 'read', desc: 'Return local versions.' }], owns: ['Versions of its keys', 'Hints for others'] },
        { id: 'n2', label: 'Node 2', kind: 'db', sub: `${VNODES} tokens`, x: 990, y: 190, latency: 3, role: 'Storage node.', ops: [{ name: 'store', desc: 'Store a version.' }, { name: 'read', desc: 'Return local versions.' }], owns: ['Versions', 'Hints'] },
        { id: 'n3', label: 'Node 3', kind: 'db', sub: `${VNODES} tokens`, x: 990, y: 400, latency: 3, role: 'Storage node.', ops: [{ name: 'store', desc: 'Store a version.' }, { name: 'read', desc: 'Return local versions.' }], owns: ['Versions', 'Hints'] },
        { id: 'n4', label: 'Node 4', kind: 'db', sub: `${VNODES} tokens`, x: 800, y: 510, latency: 3, role: 'Storage node.', ops: [{ name: 'store', desc: 'Store a version.' }, { name: 'read', desc: 'Return local versions.' }], owns: ['Versions', 'Hints'] },
        { id: 'n5', label: 'Node 5', kind: 'db', sub: `${VNODES} tokens`, x: 610, y: 400, latency: 3, role: 'Storage node.', ops: [{ name: 'store', desc: 'Store a version.' }, { name: 'read', desc: 'Return local versions.' }], owns: ['Versions', 'Hints'] },
        { id: 'n6', label: 'Node 6', kind: 'db', sub: `${VNODES} tokens`, x: 610, y: 190, latency: 3, role: 'Storage node.', ops: [{ name: 'store', desc: 'Store a version.' }, { name: 'read', desc: 'Return local versions.' }], owns: ['Versions', 'Hints'] },
      ],
      edges: [
        { from: 'maya', to: 'router', latency: 40, label: 'HTTPS' },
        { from: 'tablet', to: 'router', latency: 40, label: 'HTTPS' },
        { from: 'router', to: 'meta', latency: 2 },
        ...NODES.map((n) => ({ from: 'router', to: n, latency: 2 })),
        ...NODES.map((n, i) => ({ from: n, to: NODES[(i + 1) % NODES.length], latency: 1 })),
      ],
      queues: [],
    },
    modeLabels: { offline: 'Offline (airplane mode)', wrongMap: 'Stale ring: routes to a non-owner', crashed: 'Crashed, disk lost' },
    failures: [
      { id: 'rep1-down', node: OWNERS[0], mode: 'down', label: `${NAME[OWNERS[0]]} (first replica) down`, desc: 'The usual coordinator is unreachable but its disk is intact. The router forwards to the next owner; the write still needs W acknowledgements.' },
      { id: 'rep1-crash', node: OWNERS[0], mode: 'crashed', label: `${NAME[OWNERS[0]]} crashes and loses its disk`, desc: 'Everything only this node held is gone. With W = 2 another replica has every acknowledged write; with W = 1 it may have been the only copy.' },
      { id: 'rep2-down', node: OWNERS[1], mode: 'down', label: `${NAME[OWNERS[1]]} (second replica) down`, desc: 'With W = 2 the coordinator and the third replica suffice. With sloppy quorums on, a stand-in takes a hint for it.' },
      { id: 'rep3-down', node: OWNERS[2], mode: 'down', label: `${NAME[OWNERS[2]]} (third replica) down`, desc: 'Together with the second replica down, W = 2 cannot be met without a stand-in.' },
      { id: 'rep3-slow', node: OWNERS[2], mode: 'slow', params: { factor: 40 }, label: `${NAME[OWNERS[2]]} slow`, desc: 'The third acknowledgement arrives late. W = 2 hides it; W = 3 would wait for it.' },
      { id: 'coord-drop', node: OWNERS[0], mode: 'dropResponse', label: `${NAME[OWNERS[0]]} loses its replies`, desc: 'The write lands on the replicas but the router never hears. The device retries with the same context.' },
      { id: 'router-wrong', node: 'router', mode: 'wrongMap', label: 'Router has a stale ring', desc: 'The router sends the request to a node that does not own the key. The node says so; the router refreshes from the metadata service and retries.' },
      { id: 'meta-down', node: 'meta', mode: 'down', label: 'Metadata service down', desc: 'Routers keep working from their cached ring. A router that needs a refresh cannot get one.' },
      { id: 'tablet-offline', node: 'tablet', mode: 'offline', label: 'Tablet offline', desc: 'Edits on the tablet queue locally and are sent when it reconnects.' },
    ],
    switches: Y.switches([
      ['w2', 'W = 2: acknowledge after two replicas', `Off: W = 1. The coordinator acknowledges after its own write and replicates in a batch ${LAZY_MS} ms later. Faster, and a crash in between loses the only copy.`],
      ['r2', 'R = 2: read two replicas and reconcile', 'Off: R = 1, the coordinator answers from its own copy. With W = 2 and R = 2, R + W > N, so every read sees the latest acknowledged write.'],
      ['sloppy', 'Sloppy quorum and hinted handoff', 'When an owner is down, the next healthy node on the ring stores the write with a hint and replays it when the owner returns. Off: a write that cannot reach W owners is refused.'],
      ['vclock', 'Vector clocks (off: last writer wins)', 'Every version carries a counter per device that wrote it, advanced from the version that device had last read. Concurrent versions are kept as siblings and merged by the app. Off: the version with the latest timestamp replaces everything else.'],
      ['readRepair', 'Read repair', 'When a read finds a replica behind, the coordinator sends it the reconciled version in the background.'],
    ]),
    presets: Y.presets({ w2: true, r2: true, sloppy: true, vclock: true, readRepair: true }, [
      { id: 'normal', label: 'Add from the phone, refresh the tablet', desc: `The router hashes the key to ${OWNERS.map((n) => NAME[n]).join(', ')}. ${NAME[OWNERS[0]]} coordinates, writes three copies, acknowledges at W = 2. The tablet reads R = 2 copies and sees the item.`, run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(1500, () => startRefresh(s, 'tablet')); } },
      { id: 'rw-quorum', label: 'R + W > N: read your own write at once', desc: 'The tablet refreshes the instant the phone’s write is acknowledged. The router picks a different coordinator for the read, which asks two replicas; at least one of them was in the write quorum, so the item is there.', run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(460, () => startRefresh(s, 'tablet')); } },
      { id: 'w1-r1-stale', label: 'W = 1, R = 1: the read misses the write', desc: `The phone’s write is acknowledged by one node and replicated ${LAZY_MS} ms later. The tablet reads one copy from a different coordinator and sees the old cart. R + W = 2, not more than N = 3.`, sw: { w2: false, r2: false }, run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(460, () => startRefresh(s, 'tablet')); } },
      { id: 'w1-crash', label: 'W = 1: acknowledged, then lost', desc: `${NAME[OWNERS[0]]} acknowledges the write and crashes, losing its disk, before the batched replication leaves. The phone says “saved”; no other node ever heard of the item. The tablet’s read proves it.`, sw: { w2: false }, run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(480, () => s.inject(OWNERS[0], 'crashed')); s.schedule(1800, () => startRefresh(s, 'tablet')); } },
      { id: 'one-down', label: 'One replica down, hinted handoff', desc: `${NAME[OWNERS[1]]} is down. The coordinator and ${NAME[OWNERS[2]]} acknowledge; ${NAME[STANDINS[0]]} stores a third copy with a hint. When ${NAME[OWNERS[1]]} returns, the hint is replayed and the store is back to three real copies.`, run: (s) => { s.inject(OWNERS[1], 'down'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(2500, () => s.restore(OWNERS[1])); s.schedule(4500, () => startRefresh(s, 'tablet')); } },
      { id: 'two-down-strict', label: 'Two replicas down, strict quorum: refused', desc: 'Sloppy quorums off. Only the coordinator can take the write, W = 2 cannot be met, and the write is refused. Nothing is lost and nothing is saved: the store chose consistency over availability.', sw: { sloppy: false }, run: (s) => { s.inject(OWNERS[1], 'down'); s.inject(OWNERS[2], 'down'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); } },
      { id: 'two-down-sloppy', label: 'Two replicas down, sloppy quorum: written', desc: `The same failure with sloppy quorums on. ${STANDINS.slice(0, 2).map((n) => NAME[n]).join(' and ')} take the write with hints and the phone is told “saved”. The hints flow back when the owners return.`, run: (s) => { s.inject(OWNERS[1], 'down'); s.inject(OWNERS[2], 'down'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(2500, () => { s.restore(OWNERS[1]); s.restore(OWNERS[2]); }); s.schedule(5000, () => startRefresh(s, 'tablet')); } },
      { id: 'offline-lww', label: 'Tablet offline, last writer wins: Socks vanish', desc: 'The tablet goes offline and Maya adds a hat on it while the phone adds socks. When the tablet reconnects it sends the cart it knows, with a later timestamp. Last writer wins keeps the hat and throws away the socks.', sw: { vclock: false }, run: (s) => { s.inject('tablet', 'offline'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(900, () => startAdd(s, 'tablet', 'Hat')); s.schedule(2000, () => s.restore('tablet')); s.schedule(3800, () => startRefresh(s, 'maya')); } },
      { id: 'offline-vclock', label: 'Tablet offline, vector clocks: both items survive', desc: 'The same story with vector clocks. The tablet’s write carries an old context, so the coordinator keeps both versions as siblings instead of choosing. The next read returns both and the app merges them: socks and hat.', run: (s) => { s.inject('tablet', 'offline'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(900, () => startAdd(s, 'tablet', 'Hat')); s.schedule(2000, () => s.restore('tablet')); s.schedule(3800, () => startRefresh(s, 'maya')); } },
      { id: 'reply-lost', label: 'Coordinator’s reply lost, safe retry', desc: 'The write lands on all three replicas but the reply to the router is lost. The phone times out and sends the same cart with the same context again. The second write is the same version, so nothing is doubled.', run: (s) => { s.inject(OWNERS[0], 'dropResponse', true, 1000); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(3500, () => startRefresh(s, 'tablet')); } },
      { id: 'wrong-map', label: 'Router with a stale ring', desc: 'The router sends the write to a node that does not own the key. The node answers “not owner”, the router fetches the ring from the metadata service, and the write goes to a real owner.', run: (s) => { s.inject('router', 'wrongMap'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(2000, () => startRefresh(s, 'tablet')); } },
    ]),
    initialState: () => {
      const store = {}; const hints = {};
      for (const n of NODES) { store[n] = {}; hints[n] = []; }
      return { config: { w2: true, r2: true, sloppy: true, vclock: true, readRepair: true }, store, hints, acked: [], lost: [], routerFresh: true, rr: 0, stats: { puts: 0, gets: 0, hints: 0, replayed: 0, repairs: 0, overwritten: 0, lostReplication: 0, notOwner: 0, refreshes: 0 } };
    },
    initialUI: () => ({
      maya: { cart: [], clock: {}, pending: false, error: '', queued: [], lastMs: null, lastWrite: null },
      tablet: { cart: [], clock: {}, pending: false, error: '', queued: [], lastMs: null, lastWrite: null },
    }),
    actions: {
      add(sim, a) { startAdd(sim, a.device, a.item); },
      refresh(sim, a) { startRefresh(sim, a.device); },
      offline(sim, a) { if (a.on) sim.inject('tablet', 'offline'); else sim.restore('tablet', 'offline'); },
    },
    handlers: Object.assign({
      router: {
        put: function* (ctx, p) { return yield* route(ctx, 'coordinatePut', p); },
        get: function* (ctx, p) { return yield* route(ctx, 'coordinateGet', p); },
      },
      meta: { getRing(ctx) { ctx.state.stats.refreshes++; return { owners: OWNERS.slice() }; } },
    }, Object.fromEntries(NODES.map((n) => [n, coordinator(n)]))),
    setup(sim) {
      // Hint replay: every node checks whether the replicas it holds hints for are back.
      for (const n of NODES) sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(HINT_POLL_MS);
          const st = ctx.state;
          if (!st.hints[n].length || dead(ctx.sim, n)) continue;
          for (const h of st.hints[n].slice()) {
            if (dead(ctx.sim, h.target)) continue;
            const r = yield ctx.call(h.target, 'store', { key: h.key, version: h.version, context: h.context }, { timeout: 600 });
            if (r.ok) { st.hints[n].splice(st.hints[n].indexOf(h), 1); st.stats.replayed++; ctx.log({ op: `hint replayed to ${NAME[h.target]}`, status: 'ok', detail: `${NAME[n]} handed the version it was holding for ${NAME[h.target]} back to it and dropped the hint.` }); }
          }
        }
      }, { self: n, quiet: 'all' });
    },
    onFailureChange(sim, ch) {
      if (ch.node === 'tablet' && ch.mode === 'offline' && !ch.active) startSync(sim);
      if (ch.mode === 'crashed' && ch.active && NODES.includes(ch.node)) { sim.state.store[ch.node] = {}; sim.state.hints[ch.node] = []; sim.note(`${NAME[ch.node]} crashed and its disk is gone. Whatever only it held is lost.`); }
    },
    consistency(sim) {
      const st = sim.state;
      const ui = sim.ui;
      const t = truth(sim);
      if (st.lost.length) return { key: 'wrong', label: `“${st.lost.join('”, “')}” ${st.lost.length === 1 ? 'was' : 'were'} acknowledged and then overwritten: last writer wins kept the version with the later timestamp and discarded the other device’s item.` };
      const gone = st.acked.filter((it) => !t.items.includes(it));
      if (gone.length) return { key: 'wrong', label: `“${gone.join('”, “')}” ${gone.length === 1 ? 'was' : 'were'} acknowledged to the phone and ${gone.length === 1 ? 'is' : 'are'} on no replica: the only copy died with the coordinator before replication.` };
      for (const dev of ['maya', 'tablet']) {
        if (ui[dev].pending) return { key: 'stale', label: `The ${DEVICE[dev]} is waiting for the store.` };
        if (ui[dev].error) return { key: 'stale', label: `The ${DEVICE[dev]}’s last request failed: ${ui[dev].error}` };
      }
      if (offline(sim) && ui.tablet.queued.length) return { key: 'stale', label: `The tablet is offline with ${ui.tablet.queued.length} queued item${ui.tablet.queued.length === 1 ? '' : 's'}. Nothing on the servers knows about ${ui.tablet.queued.length === 1 ? 'it' : 'them'} yet.` };
      const pendingHints = NODES.reduce((s, n) => s + st.hints[n].length, 0);
      const downOwners = OWNERS.filter((n) => dead(sim, n));
      for (const dev of ['maya', 'tablet']) {
        const missing = t.items.filter((it) => !ui[dev].cart.includes(it));
        if (missing.length) return { key: 'stale', label: `The ${DEVICE[dev]} shows ${ui[dev].cart.length} item${ui[dev].cart.length === 1 ? '' : 's'}; the store has ${t.items.length}. Refresh with R + W > N and it will see “${missing.join('”, “')}”.` };
      }
      if (pendingHints) return { key: 'stale', label: `${pendingHints} hint${pendingHints === 1 ? '' : 's'} waiting on stand-in nodes for ${downOwners.length ? downOwners.map((n) => NAME[n]).join(', ') + ' to return' : 'replay'}. The write is durable on fewer real owners than N.` };
      if (downOwners.length) return { key: 'stale', label: `${downOwners.map((n) => NAME[n]).join(' and ')} down: the cart has ${N - downOwners.length} live cop${N - downOwners.length === 1 ? 'y' : 'ies'}.` };
      const behind = OWNERS.filter((n) => { const v = reconcile(st, [{ versions: st.store[n][KEY] || [] }]); return t.items.some((it) => !v.items.includes(it)); });
      if (behind.length) return { key: 'stale', label: `${behind.map((n) => NAME[n]).join(', ')} ${behind.length === 1 ? 'is' : 'are'} behind the others. A read that includes ${behind.length === 1 ? 'it' : 'them'} with R = 2 still returns the latest version and repairs ${behind.length === 1 ? 'it' : 'them'}.` };
      const sib = Math.max(...OWNERS.map((n) => (st.store[n][KEY] || []).length));
      return { key: 'ok', label: `Both devices and all three replicas agree on ${t.items.length} item${t.items.length === 1 ? '' : 's'}${sib > 1 ? `; ${sib} siblings are stored and will collapse on the next write` : ''}${st.stats.replayed ? `; ${st.stats.replayed} hint${st.stats.replayed === 1 ? '' : 's'} replayed` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const last = sim.ui.maya.lastWrite || sim.ui.tablet.lastWrite;
      const pendingHints = NODES.reduce((s, n) => s + st.hints[n].length, 0);
      const sib = Math.max(...OWNERS.map((n) => (st.store[n][KEY] || []).length), 0);
      return [
        { label: 'Writes / reads', value: `${st.stats.puts} / ${st.stats.gets}` },
        { label: 'Phone’s last request', value: sim.ui.maya.lastMs == null ? '–' : SDL.fmtMs(sim.ui.maya.lastMs) },
        { label: 'Replicas acked (last write)', value: last ? `${last.acked.length} of ${N}${last.hinted.length ? ` (${last.hinted.length} hint)` : ''}` : '–', tone: last && last.acked.length < 2 ? 'warn' : '' },
        { label: 'Hints pending', value: pendingHints, tone: pendingHints ? 'warn' : '' },
        { label: 'Hints replayed', value: st.stats.replayed },
        { label: 'Siblings stored', value: sib, tone: sib > 1 ? 'warn' : '' },
        { label: 'Read repairs', value: st.stats.repairs },
        { label: 'Items lost', value: new Set(st.lost.concat(st.acked.filter((it) => !truth(sim).items.includes(it)))).size, tone: st.lost.length || st.stats.lostReplication ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['tablet', 'Maya’s tablet']], {
          note: `One account, two devices, one key: <code>${KEY}</code>. The console shows the ring and what each node holds for that key.`,
          below: `<div class="ops-console kv-console"><p class="ops-title">The ring and Maya’s key</p><div data-ref="ring"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const t = truth(sim);
        for (const dev of ['maya', 'tablet']) {
          const u = sim.ui[dev];
          const off = dev === 'tablet' && offline(sim);
          const cartHtml = u.cart.length ? u.cart.map((it) => `<div class="app-card ${st.lost.includes(it) ? 'is-fail' : ''}"><span class="app-kv"><strong>${esc(it)}</strong><span>${u.queued.includes(it) ? 'queued offline' : '1'}</span></span></div>`).join('') : '<p class="app-sub">Your cart is empty.</p>';
          const btns = ['Socks', 'Hat', 'Mug'].map((it) => Y.btn('add', `Add ${it.toLowerCase()}`, { arg: { device: dev, item: it }, cls: u.cart.includes(it) ? 'secondary' : '', disabled: u.pending })).join('');
          Y.paint(el, sim, dev, {
            head: `<div><p class="app-title">Cart</p><p class="app-sub">Maya · ${DEVICE[dev]}${off ? ' · offline' : ''} · version ${esc(V.fmt(u.clock))}</p></div>`,
            cart: cartHtml,
            msg: Y.msg(u.error, 'fail') || (u.pending ? '<p class="app-msg"><span class="spinner"></span>Saving…</p>' : ''),
            actions: `<div class="app-row">${btns}</div><div class="app-row">${Y.btn('refresh', 'Refresh', { arg: { device: dev }, cls: 'secondary', disabled: u.pending || off })}${dev === 'tablet' ? Y.btn('offline', off ? 'Go online' : 'Go offline', { arg: { on: !off }, cls: 'secondary' }) : ''}</div>`,
          }, {});
        }
        // Ring: six nodes on a circle, the key's position, and the three owners highlighted.
        const cx = 110, cy = 110, rad = 86;
        const angle = (p) => p * Math.PI * 2 - Math.PI / 2;
        const keyPos = R.hash(KEY);
        const dots = NODES.map((n, i) => {
          const a = angle((i + 0.5) / NODES.length);
          const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a);
          const role = OWNERS.indexOf(n) === 0 ? 'coord' : OWNERS.includes(n) ? 'owner' : st.hints[n].length ? 'standin' : '';
          const down = dead(sim, n);
          return `<g class="kv-node ${role} ${down ? 'is-down' : ''}"><circle cx="${x}" cy="${y}" r="15"></circle><text x="${x}" y="${y + 4}" text-anchor="middle">${i + 1}</text></g>`;
        });
        const ka = angle((NODES.indexOf(OWNERS[0]) + 0.5) / NODES.length - 0.09);
        const ring = `<svg class="kv-ring" viewBox="0 0 220 220" role="img" aria-label="Hash ring with six nodes"><circle cx="${cx}" cy="${cy}" r="${rad}" class="kv-ring-track"></circle>${dots.join('')}<g class="kv-key"><circle cx="${cx + rad * Math.cos(ka)}" cy="${cy + rad * Math.sin(ka)}" r="5"></circle><text x="${cx}" y="${cy - 6}" text-anchor="middle">${esc(KEY)}</text><text x="${cx}" y="${cy + 12}" text-anchor="middle" class="kv-sub">hash ${keyPos.toFixed(3)} → ${OWNERS.map((n) => n.replace('n', '')).join(', ')}</text></g></svg>`;
        const rows = NODES.map((n) => {
          const vs = st.store[n][KEY] || [];
          const role = OWNERS.indexOf(n) === 0 ? 'coordinator' : OWNERS.includes(n) ? 'replica' : '';
          const down = dead(sim, n);
          const v = reconcile(st, [{ versions: vs }]);
          const behind = OWNERS.includes(n) && t.items.some((it) => !v.items.includes(it));
          const tone = down ? 'fail' : behind || st.hints[n].length ? 'warn' : 'ok';
          const what = vs.length ? `${vs.length > 1 ? `${vs.length} siblings: ` : ''}${vs.map((x) => `[${x.items.join(', ') || 'empty'}]${st.config.vclock ? ` ${V.fmt(x.clock)}` : ` t=${x.ts}`}`).join(' | ')}` : OWNERS.includes(n) ? 'nothing yet' : 'not an owner of this key';
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name"><strong>${NAME[n]}${role ? ` · ${role}` : ''}</strong><span>${down ? 'down' : st.hints[n].length ? `holding ${st.hints[n].length} hint${st.hints[n].length === 1 ? '' : 's'} for ${st.hints[n].map((h) => NAME[h.target]).join(', ')}` : behind ? 'behind' : OWNERS.includes(n) ? 'up to date' : ''}</span></div><span class="ops-val">${esc(what)}</span></div>`;
        }).join('');
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="ring"]'), {
          ring,
          rows: `<div class="ops-shards">${rows}</div>`,
          cfg: `<p class="app-sub">N = ${N}, W = ${W(st)}, R = ${RQ(st)} · ${st.config.vclock ? 'vector clocks' : 'last writer wins'} · sloppy quorum ${st.config.sloppy ? 'on' : 'off'} · store knows: ${t.items.length ? t.items.join(', ') : 'empty cart'}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });

  /** The router: find the owners, send to the first healthy one, refresh the ring on “not owner”. */
  function* route(ctx, op, p) {
    const st = ctx.state;
    const sim = ctx.sim;
    let owners = OWNERS.slice();
    // Reads may be coordinated by any owner: the router spreads them round-robin. Writes go to the first healthy owner.
    if (op === 'coordinateGet') { const k = ++st.rr % owners.length; owners = owners.slice(k).concat(owners.slice(0, k)); }
    if (ctx.mode('wrongMap') && st.routerFresh) owners = NODES.filter((n) => !OWNERS.includes(n)).slice(0, 1).concat(owners);
    for (let attempt = 0; attempt < 2; attempt++) {
      const target = owners.find((n) => !dead(sim, n)) || owners[0];
      const r = yield ctx.call(target, op, p, { timeout: 1200 });
      if (r.ok) return r.value;
      if (r.error.code !== 'NOT_OWNER') ctx.fail(r.error.code, r.error.message);
      st.stats.notOwner++;
      const m = yield ctx.call('meta', 'getRing', {}, { timeout: 300 });
      if (!m.ok) ctx.fail('NOT_OWNER', `${NAME[target]} does not own the key and the metadata service is unavailable, so the router cannot refresh its ring.`);
      owners = m.value.owners;
      st.routerFresh = false;
      ctx.log({ op: 'ring refreshed', status: 'retry', detail: `The metadata service says ${KEY} belongs to ${owners.map((n) => NAME[n]).join(', ')}. Retrying there.` });
    }
    ctx.fail('NOT_OWNER', 'No owner would take the request.');
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
