// Ride-hailing deep dives, part 2: matching, trips, payments, realtime, ETA.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
for (const f of ['rides-matching', 'rides-trips', 'rides-payments', 'rides-realtime', 'rides-eta']) require(`../assets/js/scenarios/${f}.js`);
const SDL = globalThis.SDL;
const run = (id, preset, ms, before) => {
  const s = new SDL.Simulator(SDL.scenarios[id]);
  if (before) before(s);
  s.dispatch('preset', { id: preset });
  s.runFor(ms);
  return s;
};
const metric = (s, label) => SDL.scenarios[s.scenario.id].metrics(null, s).find((m) => m.label === label).value;
const cons = (s) => SDL.scenarios[s.scenario.id].consistency(s).key;

/* matching */
test('matching: batched beats greedy on total pickup time, at the cost of waiting', () => {
  const g = run('rides-matching', 'greedy', 6000);
  const b = run('rides-matching', 'batched', 6000);
  assert.equal(metric(g, 'Riders matched'), '4 of 4');
  assert.equal(metric(b, 'Riders matched'), '4 of 4');
  assert.ok(parseInt(metric(b, 'Total pickup time')) < parseInt(metric(g, 'Total pickup time')));
  assert.ok(parseFloat(metric(b, 'Average time to match')) > parseFloat(metric(g, 'Average time to match')));
});
test('matching: low acceptance causes an offer storm', () => {
  const s = run('rides-matching', 'storm', 12000);
  assert.ok(parseFloat(metric(s, 'Offers per match')) > 1.5);
});
test('matching: compare-and-set prevents double dispatch', () => {
  assert.equal(cons(run('rides-matching', 'no-cas', 5000)), 'wrong');
  assert.notEqual(cons(run('rides-matching', 'cas', 5000)), 'wrong');
});
test('matching: fairness spreads trips but costs pickup time', () => {
  const f = run('rides-matching', 'fair', 16000);
  const u = run('rides-matching', 'unfair', 16000);
  const share = (s) => parseInt(metric(s, 'New trips to the 3 least-busy drivers'));
  assert.ok(share(f) > share(u));
  assert.ok(parseInt(metric(f, 'Total pickup time')) > parseInt(metric(u, 'Total pickup time')));
});
test('matching: straight-line fallback picks a driver across the river', () => {
  const ok = run('rides-matching', 'eta-ok', 5000);
  const slow = run('rides-matching', 'eta-slow', 8000);
  assert.ok(parseInt(metric(slow, 'Total pickup time')) > parseInt(metric(ok, 'Total pickup time')));
});
test('matching: batcher stall falls back to greedy', () => {
  assert.equal(metric(run('rides-matching', 'stall', 8000), 'Riders matched'), '4 of 4');
});
test('matching: assignment search is optimal for a small case', () => {
  const st = SDL.scenarios['rides-matching'].initialState();
  st.riders = { A: { x: 4, y: 2 }, B: { x: 2, y: 3 } };
  const plan = SDL.scenarios['rides-matching'].bestAssignment(st, ['A', 'B'], ['D2', 'D3']);
  assert.deepEqual(plan, [['A', 'D2'], ['B', 'D3']]);
});

/* trips */
const trip = (s) => s.state.trips['trip-1'];
test('trips: a complete trip yields one receipt and consistent views', () => {
  const s = run('rides-trips', 'happy', 9000);
  assert.equal(trip(s).status, 'COMPLETED');
  assert.deepEqual(s.state.receipts, { 'trip-1': 1 });
  assert.equal(s.ui.rider.status, 'COMPLETED');
  assert.equal(cons(s), 'ok');
});
test('trips: cancellation fees apply only after a match', () => {
  assert.equal(trip(run('rides-trips', 'cancel-free', 6000)).fee, 0);
  assert.equal(trip(run('rides-trips', 'cancel-fee', 6000)).fee, 5);
});
test('trips: optimistic concurrency resolves the cancel/start race; without it, a lost update', () => {
  const ok = run('rides-trips', 'race', 8000);
  assert.ok(!(ok.state.emitted['trip-1'].includes('trip.in_progress') && ok.state.emitted['trip-1'].includes('trip.cancelled')));
  assert.notEqual(cons(ok), 'wrong');
  assert.equal(cons(run('rides-trips', 'race-bad', 8000)), 'wrong');
});
test('trips: duplicates are harmless with dedupe and harmful without', () => {
  const a = run('rides-trips', 'dups', 9000);
  assert.equal(a.state.receipts['trip-1'], 1);
  assert.ok(a.state.dupSkipped > 0);
  const b = run('rides-trips', 'dups-bad', 9000);
  assert.equal(b.state.receipts['trip-1'], 2);
  assert.equal(cons(b), 'wrong');
});
test('trips: out-of-order pushes regress the screen only without version checks', () => {
  const a = run('rides-trips', 'order', 12000);
  assert.equal(a.ui.rider.regressions, 0);
  assert.equal(a.ui.rider.status, 'COMPLETED');
  const b = run('rides-trips', 'order-bad', 12000);
  assert.ok(b.ui.rider.regressions > 0);
});
test('trips: outbox survives a broker outage; dual write loses events', () => {
  const a = run('rides-trips', 'broker-outbox', 12000);
  assert.equal(a.state.receipts['trip-1'], 1);
  assert.equal(cons(a), 'ok');
  const b = run('rides-trips', 'broker-dual', 12000);
  assert.ok(b.state.lost.length > 0);
  assert.equal(cons(b), 'wrong');
});

/* payments */
const captures = (s) => Object.keys(s.state.provider.captures).length;
test('payments: happy path balances and reconciles', () => {
  const s = run('rides-payments', 'happy', 8000);
  assert.equal(s.ui.rider.stage, 'paid');
  assert.equal(captures(s), 1);
  assert.match(metric(s, 'Ledger debits = credits'), /^Yes/);
  assert.equal(cons(s), 'ok');
  assert.ok(s.state.ledger.some((l) => l.account === 'Cash at bank'), 'driver payout ran');
});
test('payments: timeout after charging is safe with idempotency keys only', () => {
  const a = run('rides-payments', 'timeout', 8000);
  assert.equal(captures(a), 1);
  const b = run('rides-payments', 'timeout-bad', 8000);
  assert.equal(captures(b), 2);
  assert.equal(cons(b), 'wrong');
});
test('payments: declined card, then another card succeeds', () => {
  const s = run('rides-payments', 'decline', 9000);
  assert.equal(s.ui.rider.stage, 'paid');
  assert.equal(s.ui.rider.card, 'card-5555');
});
test('payments: duplicate webhooks are ignored with dedupe and break reconciliation without', () => {
  const a = run('rides-payments', 'dup', 8000);
  assert.ok(a.state.stats.dupWebhooks > 0);
  assert.equal(cons(a), 'ok');
  assert.equal(cons(run('rides-payments', 'dup-bad', 8000)), 'wrong');
});
test('payments: refund reverses through the ledger', () => {
  const s = run('rides-payments', 'refund', 9000);
  assert.equal(s.ui.rider.refunded, 5);
  assert.equal(cons(s), 'ok');
});
test('payments: fail closed refuses the ride; fail open allows it', () => {
  assert.equal(run('rides-payments', 'closed', 3000).ui.rider.stage, 'idle');
  assert.equal(run('rides-payments', 'open', 9000).ui.rider.stage, 'paid');
});
test('payments: ledger outage delays but loses nothing', () => {
  const s = run('rides-payments', 'ledger-down', 9000);
  assert.equal(s.ui.rider.stage, 'paid');
  assert.equal(cons(s), 'ok');
});

/* realtime */
test('realtime: socket delivery, then crash with jitter recovers cleanly', () => {
  const a = run('rides-realtime', 'deliver', 2000);
  assert.equal(a.ui.rider.messages[0].via, 'WebSocket');
  const b = run('rides-realtime', 'crash', 8000);
  assert.equal(b.ui.rider.link, 'connected');
  assert.notEqual(b.ui.rider.server, 'gw2');
  assert.equal(b.state.stats.connectFails, 0);
  assert.equal(cons(b), 'ok');
});
test('realtime: reconnect storm causes mass failures and long queues; jitter avoids them', () => {
  const s = new SDL.Simulator(SDL.scenarios['rides-realtime']);
  s.dispatch('preset', { id: 'storm' });
  let peak = 0;
  for (let t = 500; t <= 6000; t += 250) { s.advanceTo(t); peak = Math.max(peak, s.queueWait('gw1'), s.queueWait('gw3')); }
  assert.ok(s.state.stats.connectFails > 100, `fails ${s.state.stats.connectFails}`);
  assert.ok(peak > 1000, `peak queue ${peak}`);
  s.runFor(20000);
  assert.equal(s.ui.rider.link, 'connected');
  assert.equal(cons(s), 'ok');
  const j = run('rides-realtime', 'crash', 20000);
  assert.ok(j.state.stats.connectFails < 10);
});
test('realtime: ghost sockets are swept, so connections match phones', () => {
  const s = run('rides-realtime', 'storm', 25000);
  const total = ['gw1', 'gw2', 'gw3'].reduce((a, g) => a + Object.keys(s.state.servers[g].conns).length, 0);
  assert.equal(total, 301);
});
test('realtime: backgrounded app gets push; push outage falls back to inbox sync', () => {
  assert.equal(run('rides-realtime', 'background', 5000).ui.rider.messages[0].via, 'push notification');
  const s = run('rides-realtime', 'inbox', 8000);
  assert.equal(s.ui.rider.messages[0].via, 'synced on reconnect');
  assert.equal(s.state.inbox.length, 0);
});
test('realtime: stale registry entries cost a dead-path attempt', () => {
  const s = run('rides-realtime', 'stale', 5000);
  assert.ok(s.state.stats.deadPath > 0);
});

/* ETA */
const eta = (s) => s.ui.rider.result;
test('eta: normal ETA is exact; rush hour is absorbed by the cache', () => {
  const a = run('rides-eta', 'normal', 3000);
  assert.equal(eta(a).minutes, eta(a).actual);
  const b = run('rides-eta', 'rush', 5000);
  assert.ok(SDL.snapshot(b).cacheHitRate > 0.8);
  assert.equal(eta(b).source, 'cache');
});
test('eta: without the cache, rush hour saturates routing and falls back', () => {
  const s = run('rides-eta', 'rush-nocache', 5000);
  assert.equal(eta(s).source, 'fallback');
  assert.ok(s.queueWait('router') > 500);
});
test('eta: traffic-aware routing avoids the jam; free-flow, stale cache, and stale traffic do not', () => {
  const ok = eta(run('rides-eta', 'jam', 5000));
  assert.ok(Math.abs(ok.minutes - ok.actual) / ok.actual < 0.15);
  for (const p of ['jam-blind', 'jam-cache', 'stale-traffic']) {
    const r = eta(run('rides-eta', p, 5000));
    assert.ok(r.actual > r.minutes * 1.5, `${p}: ${r.minutes} vs ${r.actual}`);
  }
});
test('eta: closures reroute; a stale map routes through the closed road', () => {
  const ok = eta(run('rides-eta', 'closure', 3000));
  assert.equal(ok.minutes, ok.actual);
  const bad = run('rides-eta', 'closure-stale', 3000);
  assert.ok(eta(bad).actual > eta(bad).minutes * 2);
  assert.equal(cons(bad), 'stale');
});
test('eta: Dijkstra finds the fast road', () => {
  const speeds = {};
  const r = SDL.scenarios['rides-eta'].route('0,2', '7,2', new Proxy(speeds, { get: (_, k) => (String(k).startsWith('h-') && String(k).endsWith('-2') ? 50 : 25) }), []);
  assert.equal(r.path.length, 7);
  assert.ok(r.path.every((id) => id.endsWith('-2') && id.startsWith('h-')));
});

test('part 2 deep dives replay deterministically', () => {
  for (const [id, p] of [['rides-matching', 'storm'], ['rides-trips', 'race'], ['rides-payments', 'timeout'], ['rides-realtime', 'crash'], ['rides-eta', 'jam']]) {
    const s = new SDL.Simulator(SDL.scenarios[id]);
    s.dispatch('preset', { id: p });
    s.runFor(4000);
    const before = JSON.stringify(s.timeline.map((e) => [e.t, e.node, e.op, e.status]));
    s.replay();
    s.runFor(4000);
    assert.equal(JSON.stringify(s.timeline.map((e) => [e.t, e.node, e.op, e.status])), before, id);
  }
});
