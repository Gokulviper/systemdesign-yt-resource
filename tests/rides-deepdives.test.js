// Ride-hailing deep dives: hot keys, surge, location tracking.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
require('../assets/js/scenarios/rides-hotkeys.js');
require('../assets/js/scenarios/rides-surge.js');
require('../assets/js/scenarios/rides-location.js');
const SDL = globalThis.SDL;
const run = (id, preset, ms, before) => {
  const s = new SDL.Simulator(SDL.scenarios[id]);
  if (before) before(s);
  s.dispatch('preset', { id: preset });
  s.runFor(ms);
  return s;
};

/* ---------- engine capacity model ---------- */
test('capacity model: requests queue once a node is saturated', () => {
  const s = new SDL.Simulator(SDL.scenarios['rides-hotkeys']);
  s.dispatch('setTraffic', { level: 'rush' });
  s.runFor(3000);
  assert.ok(s.queueWait('shardC') > 1000, `shard C wait ${s.queueWait('shardC')}`);
  assert.ok(s.queueWait('shardA') < 50, 'other shards idle');
});

/* ---------- hot keys ---------- */
const hk = (p) => run('rides-hotkeys', p, 5000);
test('hot keys: normal and one flight keep up', () => {
  for (const p of ['normal', 'flight']) {
    const s = hk(p);
    assert.ok(s.queueWait('shardC') < 100, `${p}: ${s.queueWait('shardC')}`);
    assert.equal(s.ui.phone.result.ok, true);
  }
});
test('hot keys: three flights overload the airport shard and searches time out', () => {
  const s = hk('rush');
  assert.ok(s.queueWait('shardC') > 2000);
  assert.equal(s.ui.phone.result.ok, false);
  assert.ok(SDL.snapshot(s).failed > 0);
  assert.equal(SDL.scenarios['rides-hotkeys'].consistency(s).key, 'stale', 'positions are stale too');
});
test('hot keys: coalescing and splitting each fix the overload', () => {
  for (const p of ['fix-coalesce', 'fix-split', 'fix-all']) {
    const s = hk(p);
    assert.ok(s.queueWait('shardC') < 100, `${p}: ${s.queueWait('shardC')}`);
    assert.equal(s.ui.phone.result.ok, true, p);
  }
});
test('hot keys: read-only fixes speed searches but do not cure the write hot key', () => {
  const s = hk('fix-reads');
  assert.equal(s.ui.phone.result.ok, true);
  assert.ok(s.queueWait('shardC') > 1000, `shard C still backed up: ${s.queueWait('shardC')}`);
});
test('hot keys: shedding bounds the queue at the cost of dropped pings', () => {
  const s = hk('fix-shed');
  assert.ok(s.queueWait('shardC') < 300);
  assert.ok(s.state.stats.shed > 0);
  assert.equal(SDL.scenarios['rides-hotkeys'].consistency(s).key, 'stale');
});
test('hot keys: replica serves reads when the airport shard fails', () => {
  const s = run('rides-hotkeys', 'shard-down', 3000);
  assert.equal(s.ui.phone.result.ok, true);
  assert.match(s.ui.phone.result.source, /replica/);
  assert.ok(s.ui.phone.result.count > 0);
});

/* ---------- surge ---------- */
const sg = (p, ms) => run('rides-surge', p, ms || 7000);
test('surge: a normal evening stays at 1.0x', () => {
  const s = sg('normal');
  assert.ok(Object.values(s.state.store.mult).every((m) => m === 1));
});
test('surge: the concert raises stadium surge, drivers respond, then it settles', () => {
  const s = sg('concert', 6000);
  assert.ok(s.state.store.mult.stadium >= 2);
  assert.ok(s.state.stats.moves > 0);
  assert.ok(s.ui.phone.quote.multiplier > 1);
  s.runFor(14000);
  assert.ok(s.state.store.mult.stadium < 1.5, `settled: ${s.state.store.mult.stadium}`);
});
test('surge: smoothing ramps gradually; raw jumps to the cap', () => {
  const a = run('rides-surge', 'concert', 2600);
  const b = run('rides-surge', 'no-smoothing', 2600);
  assert.ok(b.state.store.mult.stadium > a.state.store.mult.stadium);
});
test('surge: price lock charges the quote; no lock overcharges and is flagged', () => {
  const a = sg('lock', 5000);
  assert.equal(a.state.bookings[0].charged, a.state.bookings[0].quoted);
  const b = sg('no-lock', 5000);
  assert.ok(b.state.bookings[0].charged > b.state.bookings[0].quoted);
  assert.equal(SDL.scenarios['rides-surge'].consistency(b).key, 'wrong');
});
test('surge: an expired quote cannot be booked', () => {
  const s = sg('expired', 10000);
  assert.equal(s.state.bookings.length, 0);
  assert.match(s.ui.phone.error, /expired/);
});
test('surge: supply outage, fail-safe holds 1.0x; without it, false surge', () => {
  const a = sg('supply-out', 7000);
  assert.ok(Object.values(a.state.store.mult).every((m) => m === 1));
  const b = sg('false-surge', 7000);
  assert.ok(Object.values(b.state.store.mult).filter((m) => m > 2).length >= 2);
  assert.equal(SDL.scenarios['rides-surge'].consistency(b).key, 'wrong');
});
test('surge: a stalled aggregator is ignored by pricing once stale', () => {
  const s = sg('stalled', 10000);
  assert.ok(s.state.store.mult.stadium > 1, 'store still holds the frozen peak');
  assert.equal(s.ui.phone.quote.multiplier, 1);
  assert.equal(s.ui.phone.quote.stale, true);
});
test('surge: the emergency cap binds during a storm', () => {
  const capped = sg('emergency', 7000);
  const free = sg('storm', 7000);
  assert.ok(Math.max(...Object.values(capped.state.store.mult)) <= 1.5);
  assert.ok(Math.max(...Object.values(free.state.store.mult)) > 2);
});

/* ---------- location ---------- */
const lc = (p) => run('rides-location', p, 9000);
test('location: every ping reaches the index, the rider, and the trail', () => {
  const s = lc('driving');
  assert.ok(s.state.sent.length >= 8);
  assert.equal(Object.keys(s.state.trail).length, s.state.sent.length);
  assert.ok(s.ui.rider.car);
  assert.equal(SDL.scenarios['rides-location'].consistency(s).key, 'ok');
});
test('location: tunnel with buffering backfills; without it, the trail has a gap', () => {
  const a = lc('tunnel');
  assert.equal(Object.keys(a.state.trail).length, a.state.sent.length);
  const b = lc('tunnel-lost');
  assert.ok(b.state.lostOnPhone.length > 0);
  assert.equal(SDL.scenarios['rides-location'].consistency(b).key, 'wrong');
});
test('location: reordering moves the car backwards unless timestamps are checked', () => {
  const a = lc('reorder-bad');
  assert.ok(a.state.stats.backwards > 0);
  assert.ok(a.ui.rider.jumps > 0);
  const b = lc('reorder-ok');
  assert.ok(b.state.stats.rejected > 0);
  assert.equal(b.state.stats.backwards, 0);
  assert.equal(Object.keys(b.state.trail).length, b.state.sent.length, 'trail keeps the late points');
});
test('location: parked driver sends fewer pings and skips unchanged writes', () => {
  const s = lc('parked');
  assert.ok(s.state.sent.length <= 5);
  assert.ok(s.state.stats.skipped >= 1);
});
test('location: geo index down hides the driver from dispatch but not from the rider', () => {
  const s = lc('geo-down');
  assert.equal(s.state.visible, 0);
  assert.ok(s.now - s.ui.rider.lastAt < 2000, 'rider still gets live positions');
  assert.equal(SDL.scenarios['rides-location'].consistency(s).key, 'stale');
});
test('location: stream outage loses trail points; writer stall loses none', () => {
  assert.ok(lc('stream-down').state.lostInStream > 0);
  const w = lc('writer-paused');
  assert.equal(Object.keys(w.state.trail).length, w.state.sent.length);
});
test('deep dives replay deterministically', () => {
  for (const [id, p] of [['rides-hotkeys', 'rush'], ['rides-surge', 'concert'], ['rides-location', 'reorder-bad']]) {
    const s = new SDL.Simulator(SDL.scenarios[id]);
    s.dispatch('preset', { id: p });
    s.runFor(4000);
    const before = JSON.stringify(s.timeline.map((e) => [e.t, e.node, e.op, e.status]));
    s.replay();
    s.runFor(4000);
    assert.equal(JSON.stringify(s.timeline.map((e) => [e.t, e.node, e.op, e.status])), before, id);
  }
});
