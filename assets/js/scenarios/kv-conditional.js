/*
 * Conditional writes, idempotency tokens, and transactions.
 * Two shoppers, one mug left. A plain read-modify-write lets both buy it.
 * A conditional put ("set stock to 0 only if it is 1") fixes that when one
 * leader serializes the checks and replicates with a majority; a leaderless
 * store that checks the condition at whichever replica is nearest cannot,
 * and a partition makes it worse. A dropped reply shows why a retry needs a
 * client token, and a two-item transaction (stock and wallet) shows what a
 * coordinator crash between prepare and commit leaves behind.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const REPLICAS = ['r1', 'r2', 'r3'];
  const PRICE = 10;
  const STOCK0 = 1;
  const HEARTBEAT_MS = 200;
  const ELECTION_MS = 600;
  const THINK_MS = 150;
  const REPLICA_TIMEOUT = 500;
  const NAME = { r1: 'Replica 1', r2: 'Replica 2', r3: 'Replica 3', wallet: 'the wallet partition', txn: 'the transaction coordinator', api: 'the checkout API' };
  const USER = { maya: 'Maya', omar: 'Omar' };
  const NEAREST = { maya: 'r1', omar: 'r3' };
  const SIDE = { maya: 'A', api: 'A', r1: 'A', r2: 'A', wallet: 'A', txn: 'A', omar: 'B', r3: 'B' };

  const dead = (sim, n) => !!(sim.nodes[n].modes.down || sim.nodes[n].modes.crashed);
  const partitioned = (sim) => !!sim.nodes.r3.modes.partition;
  const cut = (sim, a, b) => partitioned(sim) && SIDE[a] !== SIDE[b];
  const majority = Math.floor(REPLICAS.length / 2) + 1;

  function* xcall(ctx, to, op, payload, opts) {
    opts = opts || {};
    if (cut(ctx.sim, ctx.self, to)) {
      const timeout = opts.timeout || REPLICA_TIMEOUT;
      if (opts.quiet !== 'all') ctx.log({ op: `${op} → ${NAME[to] || to} dropped`, status: 'lost', detail: `The partition separates ${ctx.self} from ${NAME[to] || to}.` });
      yield ctx.wait(timeout);
      return { ok: false, error: { code: 'TIMEOUT', message: `${NAME[to] || to} did not answer within ${timeout} ms.` }, unknown: true, latency: timeout };
    }
    return yield ctx.call(to, op, payload, opts);
  }

  /* ---------- shoppers ---------- */
  function startBuy(sim, user) {
    const u = sim.ui[user];
    sim.startAction(`${USER[user]}: buy the mug`, function* (ctx) {
      const st = ctx.state;
      u.pending = true; u.error = ''; u.status = 'pending';
      const token = `${user}-${++st.tokenSeq}`;
      Y.L(ctx, { displayed: 'pending', retrySafe: st.config.tokens ? ['yes', 'The request carries an idempotency token; a retry returns the first outcome.'] : ['no', 'A retry is a second purchase attempt.'] });
      const payload = { user, token: st.config.tokens ? token : null, attempt: 0 };
      const entry = user === 'maya' ? 'api' : 'r3';
      const r = yield* ctx.retry({ attempts: 2, baseMs: 200, jitter: 0, retryable: (x) => x.error && x.error.code === 'TIMEOUT' }, function* (attempt) {
        payload.attempt = attempt;
        if (attempt > 1) ctx.log({ op: 'retrying the purchase', status: 'warn', detail: `${USER[user]}'s phone never heard back. ${st.config.tokens ? 'It retries with the same token, so the server can recognise the request.' : 'It retries without a token: to the server this is a brand-new purchase.'}` });
        return user === 'maya' ? yield ctx.call('api', 'buy', payload, { timeout: 1200 }) : yield* xcall(ctx, 'r3', 'buyVia', payload, { timeout: 1200 });
      });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency;
      if (r.ok) {
        u.status = 'bought'; st.told.bought.push(user);
        const v = r.value;
        Y.L(ctx, { displayed: ['yes', 'Order confirmed.'], accepted: 'yes', committed: ['yes', v.how], async: 'n/a' });
        ctx.explain(`${USER[user]} bought the mug${v.replayed ? ' (the server recognised the token and returned the outcome of the first attempt instead of trying again)' : ''}. ${v.how}${v.leaderless ? ' Nobody checked whether another replica had already sold it.' : ''}`);
        return;
      }
      u.error = r.error.message;
      u.status = r.error.code === 'CONDITION' || r.error.code === 'INSUFFICIENT' ? 'refused' : 'error';
      if (r.error.code === 'CONDITION') st.told.soldOut.push(user);
      Y.failed(ctx, r.error.code === 'CONDITION' ? 'The phone shows “sold out”.' : 'The phone shows an error.');
      ctx.explain({
        CONDITION: `The store refused: stock was not 1 when the write was checked. ${USER[user]} sees “sold out”${st.actualBuyers.includes(user) ? '. But the first attempt did go through: the mug is reserved under this name and the phone says otherwise' : ''}.`,
        INSUFFICIENT: `The wallet prepare failed: ${USER[user]} has $${st.wallet[user]}, the mug costs $${PRICE}. The coordinator aborted, so the stock reservation was released too. Both or neither.`,
        LOCKED: 'The mug is locked by a transaction that is neither committed nor aborted: its coordinator crashed after prepare. Until the coordinator recovers and decides, nobody can buy it.',
        UNAVAILABLE: `${r.error.message} Correct and unavailable: a minority side cannot decide.`,
        TIMEOUT: 'No answer. The purchase may or may not have happened.',
      }[r.error.code] || r.error.message);
    }, { self: user });
  }

  /* ---------- the write paths ---------- */
  function* buy(ctx, p, entry) {
    const st = ctx.state;
    if (p.token && st.results[p.token]) { st.stats.replays++; const r = st.results[p.token]; if (r.ok) return Object.assign({}, r.value, { replayed: true }); ctx.fail(r.error.code, r.error.message); }
    let result;
    try {
      if (st.config.atomic && dead(ctx.sim, 'txn')) ctx.fail(st.locks.stock ? 'LOCKED' : 'UNAVAILABLE', st.locks.stock ? `The mug is locked by transaction ${st.locks.stock}, and the coordinator that owns it is down.` : 'The transaction coordinator is down.');
      const v = st.config.atomic ? ctx.must(yield* xcall(ctx, 'txn', 'buy', p, { timeout: 1100 })) : yield* buyStockOnly(ctx, p, entry);
      result = { ok: true, value: v };
    } catch (e) {
      result = { ok: false, error: { code: e.code || 'INTERNAL', message: e.message } };
    }
    if (p.token && (result.ok || ['CONDITION', 'INSUFFICIENT'].includes(result.error.code))) st.results[p.token] = result;
    if (!result.ok) ctx.fail(result.error.code, result.error.message);
    return result.value;
  }
  function* buyStockOnly(ctx, p, entry) {
    const st = ctx.state;
    if (st.config.leader) {
      const leader = st.leader;
      if (!leader || dead(ctx.sim, leader)) ctx.fail('UNAVAILABLE', 'No leader is available; an election is in progress.');
      if (st.config.conditional) return ctx.must(yield* xcall(ctx, leader, 'conditionalDecrement', { user: p.user }, { timeout: 900 }));
      const cur = ctx.must(yield* xcall(ctx, leader, 'read', {}, { timeout: 900 }));
      if (cur.qty < 1) ctx.fail('CONDITION', 'Sold out.');
      yield ctx.wait(THINK_MS);
      return ctx.must(yield* xcall(ctx, leader, 'write', { user: p.user, qty: cur.qty - 1 }, { timeout: 900 }));
    }
    const coord = entry === 'api' ? NEAREST[p.user] : entry;
    if (dead(ctx.sim, coord)) ctx.fail('UNAVAILABLE', `${NAME[coord]} is down.`);
    if (st.config.conditional) return ctx.must(yield* xcall(ctx, coord, 'localConditionalDecrement', { user: p.user }, { timeout: 900 }));
    const cur = ctx.must(yield* xcall(ctx, coord, 'read', {}, { timeout: 900 }));
    if (cur.qty < 1) ctx.fail('CONDITION', 'Sold out.');
    yield ctx.wait(THINK_MS);
    return ctx.must(yield* xcall(ctx, coord, 'localWrite', { user: p.user, qty: cur.qty - 1 }, { timeout: 900 }));
  }

  function replica(id) {
    const apply = (st, qty, user, ver) => { st.stock[id] = { qty, ver }; if (user && !st.actualBuyers.includes(user) && qty < (st.applied[id] == null ? STOCK0 : st.applied[id])) st.actualBuyers.push(user); st.applied[id] = qty; };
    return {
      read(ctx) { return ctx.state.stock[id]; },
      /* leader path: serialize at the leader, replicate to a majority */
      conditionalDecrement: function* (ctx, p) {
        const st = ctx.state;
        if (st.leader !== id) ctx.fail('NOT_LEADER', `${NAME[id]} is not the leader.`);
        if (st.locks.stock) ctx.fail('LOCKED', 'The mug is locked by an in-doubt transaction.');
        // The check and the reservation happen in one step at the leader: a concurrent request sees the reserved value.
        const avail = st.stock[id].qty - (st.reserved[id] || 0);
        if (avail < 1) { st.stats.refused++; ctx.fail('CONDITION', 'Sold out.'); }
        st.reserved[id] = (st.reserved[id] || 0) + 1;
        try { return yield* replicateWrite(ctx, id, avail - 1, p.user, apply); } finally { st.reserved[id]--; }
      },
      write: function* (ctx, p) {
        const st = ctx.state;
        if (st.leader !== id) ctx.fail('NOT_LEADER', `${NAME[id]} is not the leader.`);
        return yield* replicateWrite(ctx, id, p.qty, p.user, apply);
      },
      accept(ctx, p) { apply(ctx.state, p.qty, p.user, p.ver); return { acked: true }; },
      heartbeat(ctx, p) { const st = ctx.state; st.lastBeat[id] = ctx.now(); if (p.term >= st.term) { st.term = p.term; st.leader = p.leader; } if (p.stock && p.stock.ver > st.stock[id].ver) { apply(st, p.stock.qty, p.stock.user, p.stock.ver); st.stats.caughtUp++; } return {}; },
      /* leaderless path: check locally, acknowledge, replicate afterwards */
      localConditionalDecrement: function* (ctx, p) {
        const st = ctx.state;
        const cur = st.stock[id];
        if (cur.qty < 1) { st.stats.refused++; ctx.fail('CONDITION', 'Sold out.'); }
        apply(st, cur.qty - 1, p.user, cur.ver + 1);
        st.stats.writes++;
        ctx.spawn(function* (c) { for (const n of REPLICAS.filter((x) => x !== id)) { const r = yield* xcall(c, n, 'replicate', { qty: cur.qty - 1, ver: cur.ver + 1, user: p.user }, { timeout: REPLICA_TIMEOUT, quiet: 'all' }); if (!r.ok) st.stats.lostReplication++; } }, { quiet: 'all' });
        return { how: `${NAME[id]} checked its own copy (stock ${cur.qty}), wrote stock ${cur.qty - 1}, acknowledged, and is replicating to the other two in the background.`, leaderless: true };
      },
      localWrite: function* (ctx, p) {
        const st = ctx.state; const cur = st.stock[id];
        apply(st, p.qty, p.user, cur.ver + 1); st.stats.writes++;
        ctx.spawn(function* (c) { for (const n of REPLICAS.filter((x) => x !== id)) { const r = yield* xcall(c, n, 'replicate', { qty: p.qty, ver: cur.ver + 1, user: p.user }, { timeout: REPLICA_TIMEOUT, quiet: 'all' }); if (!r.ok) st.stats.lostReplication++; } }, { quiet: 'all' });
        return { how: `${NAME[id]} wrote stock ${p.qty} from a read made ${THINK_MS} ms earlier and acknowledged.`, leaderless: true };
      },
      replicate(ctx, p) { const st = ctx.state; if (p.ver > st.stock[id].ver || p.qty < st.stock[id].qty) apply(st, Math.min(p.qty, st.stock[id].qty), p.user, Math.max(p.ver, st.stock[id].ver)); return {}; },
      buyVia: function* (ctx, p) { return yield* buy(ctx, p, id); },
      /* two-phase commit participant */
      prepare(ctx, p) {
        const st = ctx.state;
        if (st.leader !== id) ctx.fail('NOT_LEADER', `${NAME[id]} is not the leader.`);
        if (st.locks.stock && st.locks.stock !== p.txnId) ctx.fail('LOCKED', 'The mug is locked by an in-doubt transaction.');
        if (st.stock[id].qty < 1) ctx.fail('CONDITION', 'Sold out.');
        st.locks.stock = p.txnId;
        return { prepared: true };
      },
      commit: function* (ctx, p) { const st = ctx.state; const r = yield* replicateWrite(ctx, id, st.stock[id].qty - 1, p.user, apply); st.locks.stock = null; return r; },
      abort(ctx, p) { const st = ctx.state; if (st.locks.stock === p.txnId) st.locks.stock = null; return {}; },
    };
  }
  function* replicateWrite(ctx, id, qty, user, apply) {
    const st = ctx.state;
    const ver = st.stock[id].ver + 1;
    const acks = [id]; let pending = 0;
    for (const n of REPLICAS.filter((x) => x !== id)) {
      pending++;
      ctx.spawn(function* (c) { const r = yield* xcall(c, n, 'accept', { qty, ver, user }, { timeout: REPLICA_TIMEOUT }); pending--; if (r.ok) acks.push(n); });
    }
    while (acks.length < majority && pending > 0) yield ctx.wait(5);
    if (acks.length < majority) ctx.fail('UNAVAILABLE', `The leader could not reach a majority (${acks.length} of ${REPLICAS.length}).`);
    apply(st, qty, user, ver);
    st.lastWriter = user;
    st.stats.writes++;
    return { how: `${NAME[id]}, the leader, checked the condition, replicated stock ${qty} to ${acks.filter((x) => x !== id).map((n) => NAME[n]).join(', ')} (a majority), and acknowledged.`, acks: acks.slice() };
  }

  /* ---------- transaction coordinator ---------- */
  const txnHandlers = {
    buy: function* (ctx, p) {
      const st = ctx.state;
      const txnId = `t${++st.txnSeq}`;
      const leader = st.leader;
      if (!leader || dead(ctx.sim, leader)) ctx.fail('UNAVAILABLE', 'No leader is available.');
      st.txnLog.push({ id: txnId, user: p.user, state: 'preparing' });
      const log = st.txnLog[st.txnLog.length - 1];
      const ps = yield* xcall(ctx, leader, 'prepare', { txnId, user: p.user }, { timeout: 800 });
      if (!ps.ok) { log.state = 'aborted'; ctx.fail(ps.error.code, ps.error.message); }
      const pw = yield ctx.call('wallet', 'prepare', { txnId, user: p.user, amount: PRICE }, { timeout: 800 });
      if (!pw.ok) { log.state = 'aborted'; yield* xcall(ctx, leader, 'abort', { txnId }, { timeout: 800 }); ctx.fail(pw.error.code, pw.error.message); }
      log.state = 'prepared';
      if (ctx.mode('crashAfterPrepare')) {
        ctx.log({ op: 'coordinator crashes', status: 'fault', detail: 'Both participants are prepared and hold locks. The coordinator dies before it logs a decision. The stock and the wallet are now in doubt.' });
        ctx.sim.inject('txn', 'crashed');
        yield ctx.wait(60000);
      }
      log.state = 'committing';
      ctx.must(yield* xcall(ctx, leader, 'commit', { txnId, user: p.user }, { timeout: 900 }));
      ctx.must(yield ctx.call('wallet', 'commit', { txnId, user: p.user, amount: PRICE }, { timeout: 800 }));
      log.state = 'committed';
      st.stats.txns++;
      return { how: `Transaction ${txnId}: the leader and the wallet both prepared (locks taken, conditions checked), then both committed. Stock 0 and $${PRICE} charged, together.` };
    },
  };
  const walletHandlers = {
    prepare(ctx, p) {
      const st = ctx.state;
      if (st.locks.wallet[p.user] && st.locks.wallet[p.user] !== p.txnId) ctx.fail('LOCKED', `${USER[p.user]}'s wallet is locked.`);
      if (st.wallet[p.user] < p.amount) ctx.fail('INSUFFICIENT', `Insufficient funds: $${st.wallet[p.user]} available, $${p.amount} needed.`);
      st.locks.wallet[p.user] = p.txnId;
      return { prepared: true };
    },
    commit(ctx, p) { const st = ctx.state; st.wallet[p.user] -= p.amount; st.charged.push(p.user); st.locks.wallet[p.user] = null; return {}; },
    abort(ctx, p) { const st = ctx.state; if (st.locks.wallet[p.user] === p.txnId) st.locks.wallet[p.user] = null; return {}; },
  };

  const sc = (SDL.scenarios['kv-conditional'] = {
    id: 'kv-conditional',
    seed: 53,
    minHopMs: 5,
    productWidth: 640,
    intro: 'Have Maya and Omar buy the last mug at the same moment with plain writes, then with a conditional put through the leader, then leaderless. Partition Omar’s side away, drop a reply with and without a token, and crash the transaction coordinator after prepare.',
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'Via the checkout API', x: 90, y: 120, latency: 1, role: 'Buys through the checkout API, which talks to the leader (or, leaderless, to Replica 1).', owns: ['What Maya sees'] },
        { id: 'omar', label: 'Omar’s phone', kind: 'client', sub: 'Nearest replica: 3', x: 90, y: 470, latency: 1, role: 'A client-side driver that sends to the nearest replica, Replica 3, which forwards to the leader or, leaderless, decides itself. On the far side of the partition.', owns: ['What Omar sees'] },
        { id: 'api', label: 'Checkout API', kind: 'gateway', sub: 'Idempotency tokens', x: 330, y: 120, latency: 1, role: 'Remembers the outcome of every token it has answered, so a retried request gets the same answer instead of a second purchase.', ops: [{ name: 'buy', desc: 'Buy the mug.' }], owns: ['Token → outcome'] },
        { id: 'r1', label: 'Replica 1', kind: 'db', sub: 'Leader at the start', x: 620, y: 90, latency: 2, role: 'Holds the stock. As leader it checks conditions, replicates each write to a majority, and acknowledges. Leaderless, it decides on its own copy.', ops: [{ name: 'conditionalDecrement', desc: 'Check, replicate, apply.' }, { name: 'accept', desc: 'Follower applies.' }, { name: 'prepare', desc: '2PC prepare: lock and check.' }, { name: 'commit', desc: '2PC commit.' }], owns: ['Stock (qty, version)', 'Lock'] },
        { id: 'r2', label: 'Replica 2', kind: 'db', sub: 'Follower', x: 620, y: 290, latency: 2, role: 'Follower; becomes leader if Replica 1 stops sending heartbeats.', owns: ['Stock (qty, version)'] },
        { id: 'r3', label: 'Replica 3', kind: 'db', sub: 'Follower · side B', x: 620, y: 490, latency: 2, role: 'Follower nearest to Omar. In a partition it is cut off from the leader together with Omar.', ops: [{ name: 'buyVia', desc: 'Omar’s entry point.' }, { name: 'localConditionalDecrement', desc: 'Leaderless check.' }], owns: ['Stock (qty, version)'] },
        { id: 'wallet', label: 'Wallet partition', kind: 'db', sub: 'Balances', x: 900, y: 120, latency: 2, role: `Maya has $30, Omar $5; the mug costs $${PRICE}. A 2PC participant: prepare locks and checks the balance, commit charges.`, ops: [{ name: 'prepare', desc: 'Lock and check funds.' }, { name: 'commit', desc: 'Charge.' }, { name: 'abort', desc: 'Release.' }], owns: ['Balances', 'Locks'] },
        { id: 'txn', label: 'Transaction coordinator', kind: 'service', sub: 'Two-phase commit', x: 900, y: 470, latency: 2, role: 'Prepares the stock on the leader and the wallet, logs the decision, commits both. If it crashes between prepare and the decision, both participants stay locked until it recovers and aborts.', ops: [{ name: 'buy', desc: 'Prepare both, commit both.' }], owns: ['Transaction log'] },
      ],
      edges: [
        { from: 'maya', to: 'api', latency: 15 },
        { from: 'omar', to: 'r3', latency: 15 },
        { from: 'api', to: 'r1', latency: 2 },
        { from: 'api', to: 'r2', latency: 2 },
        { from: 'api', to: 'txn', latency: 2, via: [[330, 560], [900, 560]] },
        { from: 'r1', to: 'r2', latency: 2 }, { from: 'r2', to: 'r3', latency: 2 }, { from: 'r1', to: 'r3', latency: 2, via: [[520, 290]] },
        { from: 'txn', to: 'r1', latency: 2, via: [[760, 300]] }, { from: 'txn', to: 'wallet', latency: 2 },
      ],
      queues: [],
    },
    modeLabels: { partition: 'Partition: Replica 3 and Omar cut off', crashAfterPrepare: 'Will crash after prepare', crashed: 'Crashed' },
    failures: [
      { id: 'leader-crash', node: 'r1', mode: 'crashed', label: 'Replica 1 (leader) crashes', desc: `Heartbeats stop; after ${ELECTION_MS} ms Replica 2 takes over. Requests in between fail with “no leader”.` },
      { id: 'r3-down', node: 'r3', mode: 'down', label: 'Replica 3 down', desc: 'The leader still has a majority with Replica 2. Omar’s nearest replica is gone, so Omar gets “unavailable”.' },
      { id: 'txn-crash', node: 'txn', mode: 'crashAfterPrepare', label: 'Coordinator crashes after prepare', desc: 'The next transaction prepares both participants and then dies. Locks stay held until the coordinator is restored.' },
      { id: 'api-drop', node: 'api', mode: 'dropResponse', label: 'Checkout API loses its replies', desc: 'Purchases go through but Maya never hears. Her phone retries.' },
      { id: 'partition', node: 'r3', mode: 'partition', label: 'Partition: Replica 3 and Omar | the rest', desc: 'Omar can reach only Replica 3. With a leader, Replica 3 cannot forward; leaderless, it decides alone.' },
    ],
    switches: Y.switches([
      ['leader', 'Leader-based replication (off: leaderless)', 'One leader serializes every write and replicates to a majority before acknowledging; followers take over on a crash. Off: whichever replica a client reaches decides on its own copy and replicates afterwards.'],
      ['conditional', 'Conditional write (off: read, then write)', 'The decrement carries its condition: stock must be 1. Off: the client reads the stock, thinks, then writes stock − 1.'],
      ['tokens', 'Idempotency tokens', 'Each purchase carries a token. A retry with the same token returns the first outcome instead of trying again.'],
      ['atomic', 'Transaction: stock and wallet together', 'The purchase goes through the coordinator: prepare the stock and the wallet, then commit both or neither.'],
    ]),
    presets: Y.presets({ leader: true, conditional: true, tokens: true, atomic: false }, [
      { id: 'race-plain', label: 'Read, think, write: both buy the last mug', desc: `Both shoppers read stock 1, spend ${THINK_MS} ms deciding, and write stock 0. Two confirmations for one mug. Nothing checked that the stock was still 1 at write time.`, sw: { conditional: false }, run: (s) => { s.schedule(300, () => startBuy(s, 'maya')); s.schedule(300, () => startBuy(s, 'omar')); } },
      { id: 'race-conditional', label: 'Conditional put through the leader', desc: 'The same race. The leader checks “stock is 1” and applies the decrement in one step, so the second request finds stock 0 and is refused. One mug, one buyer.', run: (s) => { s.schedule(300, () => startBuy(s, 'maya')); s.schedule(300, () => startBuy(s, 'omar')); } },
      { id: 'race-leaderless', label: 'Conditional put, leaderless', desc: 'Maya’s request is checked at Replica 1, Omar’s at Replica 3. Each replica still has stock 1 when it looks, so each says yes. The condition was evaluated twice, on two copies, and nobody serialized them.', sw: { leader: false }, run: (s) => { s.schedule(300, () => startBuy(s, 'maya')); s.schedule(300, () => startBuy(s, 'omar')); } },
      { id: 'partition-leader', label: 'Partition: the minority side cannot decide', desc: 'Replica 3 and Omar are cut off. Maya buys through the leader with a majority. Omar’s request reaches Replica 3, which cannot reach the leader and says “unavailable”. After the heal Omar is told “sold out”. Consistent, briefly unavailable.', run: (s) => { s.schedule(200, () => s.inject('r3', 'partition')); s.schedule(300, () => startBuy(s, 'maya')); s.schedule(700, () => startBuy(s, 'omar')); s.schedule(3000, () => s.restore('r3', 'partition')); s.schedule(3600, () => startBuy(s, 'omar')); } },
      { id: 'partition-leaderless', label: 'Partition, leaderless: always writable, twice sold', desc: 'Same partition without a leader. Maya buys via Replica 1. Omar buys via Replica 3, which still shows stock 1 and happily agrees. Both confirmed, well before anyone was racing.', sw: { leader: false }, run: (s) => { s.schedule(200, () => s.inject('r3', 'partition')); s.schedule(300, () => startBuy(s, 'maya')); s.schedule(1200, () => startBuy(s, 'omar')); s.schedule(3000, () => s.restore('r3', 'partition')); } },
      { id: 'leader-crash', label: 'Leader crash and election', desc: `Replica 1 crashes. Maya’s purchase fails with “no leader”. Heartbeats stop and after ${ELECTION_MS} ms Replica 2 becomes leader. Maya’s retry goes through it.`, run: (s) => { s.schedule(200, () => s.inject('r1', 'crashed')); s.schedule(300, () => startBuy(s, 'maya')); s.schedule(2000, () => startBuy(s, 'maya')); } },
      { id: 'retry-no-token', label: 'Lost reply, retry without a token', desc: 'The API loses its reply. Maya’s purchase went through, but her phone times out and retries as a brand-new purchase, which is refused: stock is 0. Maya is told “sold out” and owns the mug.', sw: { tokens: false }, run: (s) => { s.inject('api', 'dropResponse'); s.schedule(300, () => startBuy(s, 'maya')); s.schedule(1200, () => s.restore('api')); } },
      { id: 'retry-token', label: 'Lost reply, retry with a token', desc: 'Same lost reply. The retry carries the same token; the API finds the first outcome and returns it. Maya is told what actually happened.', run: (s) => { s.inject('api', 'dropResponse'); s.schedule(300, () => startBuy(s, 'maya')); s.schedule(1200, () => s.restore('api')); } },
      { id: 'txn-commit', label: 'Transaction: stock and wallet together', desc: 'The coordinator prepares the stock on the leader and Maya’s wallet, then commits both. Stock 0 and $10 charged, atomically.', sw: { atomic: true }, run: (s) => { s.schedule(300, () => startBuy(s, 'maya')); } },
      { id: 'txn-insufficient', label: 'Transaction aborts on the wallet', desc: 'Omar has $5. The stock prepare succeeds and locks the mug; the wallet prepare fails; the coordinator aborts and the stock lock is released. Maya buys it a second later.', sw: { atomic: true }, run: (s) => { s.schedule(300, () => startBuy(s, 'omar')); s.schedule(1300, () => startBuy(s, 'maya')); } },
      { id: 'txn-in-doubt', label: 'Coordinator crashes after prepare', desc: 'Both participants are prepared when the coordinator dies, before it logs a decision. The mug and Maya’s wallet stay locked. Omar is told the item is locked. Nobody can resolve it except the coordinator.', sw: { atomic: true }, run: (s) => { s.inject('txn', 'crashAfterPrepare'); s.schedule(300, () => startBuy(s, 'maya')); s.schedule(2000, () => startBuy(s, 'omar')); } },
      { id: 'txn-recover', label: 'Coordinator recovers and aborts', desc: 'Same crash. When the coordinator is restored it reads its log, finds a prepared transaction with no decision, and aborts it: locks released, nothing charged. Maya retries and buys; Omar gets “sold out”.', sw: { atomic: true }, run: (s) => { s.inject('txn', 'crashAfterPrepare'); s.schedule(300, () => startBuy(s, 'maya')); s.schedule(2500, () => { s.restore('txn', 'crashAfterPrepare'); s.restore('txn', 'crashed'); }); s.schedule(3500, () => startBuy(s, 'maya')); s.schedule(4500, () => startBuy(s, 'omar')); } },
    ]),
    initialState: () => ({
      config: { leader: true, conditional: true, tokens: true, atomic: false },
      stock: Object.fromEntries(REPLICAS.map((r) => [r, { qty: STOCK0, ver: 0 }])), applied: {},
      leader: 'r1', term: 1, lastBeat: {}, reserved: {}, lastWriter: null, wallet: { maya: 30, omar: 5 }, charged: [], locks: { stock: null, wallet: {} },
      results: {}, tokenSeq: 0, txnSeq: 0, txnLog: [], actualBuyers: [], told: { bought: [], soldOut: [] },
      stats: { writes: 0, refused: 0, replays: 0, elections: 0, txns: 0, lostReplication: 0, aborted: 0, caughtUp: 0 },
    }),
    initialUI: () => ({ maya: { status: 'idle', pending: false, error: '', lastMs: null }, omar: { status: 'idle', pending: false, error: '', lastMs: null } }),
    actions: {
      buy(sim, a) { startBuy(sim, a.user); },
      partition(sim, a) { if (a.on) sim.inject('r3', 'partition'); else sim.restore('r3', 'partition'); },
      restoreTxn(sim) { sim.restore('txn'); },
    },
    handlers: Object.assign({
      api: { buy: function* (ctx, p) { return yield* buy(ctx, p, 'api'); } },
      wallet: walletHandlers,
      txn: txnHandlers,
    }, Object.fromEntries(REPLICAS.map((r) => [r, replica(r)]))),
    setup(sim) {
      // Leader heartbeats and follower elections.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(HEARTBEAT_MS);
          const st = ctx.state;
          const leader = st.leader;
          if (leader && !dead(ctx.sim, leader)) {
            const stock = Object.assign({ user: st.lastWriter }, st.stock[leader]);
            for (const n of REPLICAS.filter((x) => x !== leader)) ctx.spawn(function* (c) { yield* xcall(c, n, 'heartbeat', { term: st.term, leader, stock }, { timeout: 300, quiet: 'all' }); }, { self: leader, quiet: 'all' });
            st.lastBeat[leader] = ctx.now();
            continue;
          }
          // The leader is gone: the lowest alive replica on the majority side takes over after the election timeout.
          const since = ctx.now() - Math.max(...REPLICAS.map((r) => st.lastBeat[r] || 0), 0);
          if (since < ELECTION_MS) continue;
          const next = REPLICAS.find((r) => !dead(ctx.sim, r) && SIDE[r] === 'A');
          if (!next) continue;
          st.leader = next; st.term++; st.stats.elections++;
          ctx.sim._log({ node: next, op: `${NAME[next]} elected leader (term ${st.term})`, status: 'recovered', detail: `No heartbeat from ${NAME[leader]} for ${SDL.fmtMs(since)}. ${NAME[next]} took over; writes resume through it.` });
          st.lastBeat[next] = ctx.now();
        }
      }, { self: 'r2', quiet: 'all' });
    },
    onFailureChange(sim, ch) {
      const st = sim.state;
      if (ch.node === 'txn' && ch.mode === 'crashed' && !ch.active) {
        const doubt = st.txnLog.filter((t) => t.state === 'prepared');
        sim.spawn(function* (ctx) {
          for (const t of doubt) {
            yield* xcall(ctx, st.leader, 'abort', { txnId: t.id }, { timeout: 800 });
            yield ctx.call('wallet', 'abort', { txnId: t.id, user: t.user }, { timeout: 800 });
            t.state = 'aborted'; st.stats.aborted++;
            ctx.log({ op: `recovery: ${t.id} aborted`, status: 'warn', detail: `The log shows ${t.id} prepared with no decision recorded. Presumed abort: both participants release their locks. ${USER[t.user]} was never charged and can buy again.` });
          }
        }, { self: 'txn' });
      }
      if (ch.node === 'r1' && ch.mode === 'crashed' && ch.active && st.leader === 'r1') st.leader = null;
    },
    consistency(sim) {
      const st = sim.state; const ui = sim.ui;
      const bought = st.told.bought;
      if (bought.length > STOCK0) return { key: 'wrong', label: `Oversold: ${bought.map((u) => USER[u]).join(' and ')} were both told they bought the last mug. ${st.config.leader ? 'Two read-modify-writes raced; nothing checked the stock at write time.' : 'Two replicas each checked their own copy and each said yes.'}` };
      const liar = st.told.soldOut.find((u) => st.actualBuyers.includes(u));
      if (liar) return { key: 'wrong', label: `${USER[liar]} was told “sold out”, but the first attempt went through: the mug is reserved under that name. The retry was treated as a new purchase.` };
      if (st.config.atomic) {
        const chargedNotBought = st.charged.filter((u) => !st.actualBuyers.includes(u));
        const boughtNotCharged = st.actualBuyers.filter((u) => !st.charged.includes(u));
        if (chargedNotBought.length || boughtNotCharged.length) return { key: 'wrong', label: `Atomicity broken: ${chargedNotBought.length ? `${USER[chargedNotBought[0]]} was charged without getting the mug` : `${USER[boughtNotCharged[0]]} got the mug without being charged`}.` };
      }
      for (const u of ['maya', 'omar']) if (ui[u].pending) return { key: 'stale', label: `${USER[u]} is waiting.` };
      if (st.locks.stock) return { key: 'stale', label: `The mug is locked by transaction ${st.locks.stock}, whose coordinator ${dead(sim, 'txn') ? 'has crashed' : 'has not decided'}. In doubt: nobody can buy until it commits or aborts.` };
      if (partitioned(sim)) return { key: 'stale', label: 'The network is partitioned. Omar’s side cannot reach the leader.' };
      if (!st.leader || dead(sim, st.leader)) return { key: 'stale', label: 'No leader: an election is in progress and writes are refused.' };
      for (const u of ['maya', 'omar']) if (ui[u].status === 'error') return { key: 'stale', label: `${USER[u]}'s last attempt failed: ${ui[u].error}` };
      const live = REPLICAS.filter((r) => !dead(sim, r));
      const qtys = new Set(live.map((r) => st.stock[r].qty));
      if (qtys.size > 1) return { key: 'stale', label: `Replicas disagree on the stock (${live.map((r) => `${NAME[r]}: ${st.stock[r].qty}`).join(', ')}). Replication is still in flight.` };
      const qty = st.stock[live[0]].qty;
      return { key: 'ok', label: `Stock ${qty} on every replica${bought.length ? `; ${USER[bought[0]]} bought the mug` : ''}${st.told.soldOut.length ? `; ${st.told.soldOut.map((u) => USER[u]).join(' and ')} told “sold out”` : ''}${st.charged.length ? `; $${PRICE} charged to ${st.charged.map((u) => USER[u]).join(', ')}` : ''}${st.stats.replays ? '; one retry answered from the token store' : ''}${st.stats.elections ? `; leader now ${NAME[st.leader]}` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      return [
        { label: 'Stock on R1 / R2 / R3', value: REPLICAS.map((r) => (dead(sim, r) ? '×' : st.stock[r].qty)).join(' / '), tone: new Set(REPLICAS.filter((r) => !dead(sim, r)).map((r) => st.stock[r].qty)).size > 1 ? 'warn' : '' },
        { label: 'Leader', value: st.config.leader ? (st.leader ? NAME[st.leader] : 'none (election)') : 'none (leaderless)' },
        { label: 'Told “bought” / “sold out”', value: `${st.told.bought.map((u) => USER[u]).join(', ') || '–'} / ${st.told.soldOut.map((u) => USER[u]).join(', ') || '–'}`, tone: st.told.bought.length > STOCK0 ? 'fail' : '' },
        { label: 'Wallets Maya / Omar', value: `$${st.wallet.maya} / $${st.wallet.omar}` },
        { label: 'Locks (stock / wallets)', value: `${st.locks.stock || '–'} / ${Object.entries(st.locks.wallet).filter(([, v]) => v).map(([u]) => USER[u]).join(', ') || '–'}`, tone: st.locks.stock ? 'warn' : '' },
        { label: 'Writes / refused / token replays', value: `${st.stats.writes} / ${st.stats.refused} / ${st.stats.replays}` },
        { label: 'Transactions committed / aborted', value: `${st.stats.txns} / ${st.stats.aborted}` },
        { label: 'Elections', value: st.stats.elections },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['omar', 'Omar’s phone']], {
          note: 'One mug left. Maya buys through the checkout API; Omar’s phone talks to Replica 3, the one nearest to him. The console shows every replica, the wallet, and the transaction log.',
          below: `<div class="ops-console"><p class="ops-title">Stock replicas, wallet, and transactions</p><div class="ops-traffic">${Y.btn('partition', 'Partition Omar’s side', { arg: { on: true }, cls: 'secondary' })}${Y.btn('partition', 'Heal', { arg: { on: false }, cls: 'secondary' })}${Y.btn('restoreTxn', 'Restore the coordinator', { cls: 'secondary' })}</div><div data-ref="rows"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const u of ['maya', 'omar']) {
          const ui = sim.ui[u];
          const tone = ui.status === 'bought' ? 'ok' : ui.status === 'refused' ? 'warn' : ui.status === 'error' ? 'fail' : '';
          Y.paint(el, sim, u, {
            head: `<div><p class="app-title">Checkout</p><p class="app-sub">${USER[u]} · wallet $${st.wallet[u]} · via ${u === 'maya' ? 'the checkout API' : 'Replica 3'}</p></div>`,
            item: `<div class="app-card ${ui.status === 'bought' ? 'is-ok' : ''}"><span class="app-kv"><strong>Enamel mug</strong><span>$${PRICE}</span></span><p class="app-sub">${ui.status === 'bought' ? 'Order confirmed. It’s yours.' : ui.status === 'refused' ? 'Sold out.' : 'Last one in stock.'}</p></div>`,
            msg: ui.status === 'error' ? Y.msg(ui.error, 'fail') : ui.pending ? '<p class="app-msg"><span class="spinner"></span>Buying…</p>' : ui.lastMs != null ? `<p class="app-msg" data-tone="${tone}">${ui.status === 'bought' ? 'Bought' : ui.status === 'refused' ? 'Refused' : 'Done'} in ${SDL.fmtMs(ui.lastMs)}.</p>` : '',
            actions: `<div class="app-row">${Y.btn('buy', ui.status === 'bought' ? 'Buy again' : 'Buy now', { arg: { user: u }, disabled: ui.pending })}</div>`,
          }, {});
        }
        const rows = REPLICAS.map((r) => {
          const s = st.stock[r]; const down = dead(sim, r);
          const role = st.config.leader ? (st.leader === r ? 'leader' : 'follower') : 'coordinator for ' + (NEAREST.maya === r ? 'Maya' : NEAREST.omar === r ? 'Omar' : 'nobody');
          return `<div class="ops-row" data-tone="${down ? 'fail' : st.locks.stock && st.leader === r ? 'warn' : 'ok'}"><div class="ops-name"><strong>${NAME[r]} · ${role}${partitioned(sim) && SIDE[r] === 'B' ? ' · cut off' : ''}</strong><span>${down ? 'crashed' : `stock ${s.qty}, version ${s.ver}`}</span></div>${st.locks.stock && st.leader === r ? `<span class="ops-val">locked by ${st.locks.stock}</span>` : ''}</div>`;
        }).join('');
        const walletRow = `<div class="ops-row" data-tone="${Object.values(st.locks.wallet).some(Boolean) ? 'warn' : 'ok'}"><div class="ops-name"><strong>Wallet partition</strong><span>Maya $${st.wallet.maya} · Omar $${st.wallet.omar}</span></div>${Object.entries(st.locks.wallet).filter(([, v]) => v).map(([u, t]) => `<span class="ops-val">${USER[u]}'s wallet locked by ${t}</span>`).join('')}</div>`;
        const txnRow = `<div class="ops-row" data-tone="${dead(sim, 'txn') ? 'fail' : st.txnLog.some((t) => t.state === 'prepared') ? 'warn' : 'ok'}"><div class="ops-name"><strong>Transaction coordinator</strong><span>${dead(sim, 'txn') ? 'crashed' : st.config.atomic ? 'in use' : 'idle (switch off)'}</span></div>${st.txnLog.length ? `<span class="ops-val">${esc(st.txnLog.map((t) => `${t.id} ${USER[t.user]}: ${t.state}`).join(' · '))}</span>` : ''}</div>`;
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="rows"]'), {
          rows: `<div class="ops-shards">${rows}${walletRow}${txnRow}</div>`,
          cfg: `<p class="app-sub">${st.config.leader ? 'Leader-based, majority of 2' : 'Leaderless, acknowledge at 1'} · ${st.config.conditional ? 'conditional writes' : 'read then write'} · tokens ${st.config.tokens ? 'on' : 'off'} · ${st.config.atomic ? 'two-phase commit with the wallet' : 'stock only'}.</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
