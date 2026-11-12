// Ride-hailing scenario state-transition tests. Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
require('../assets/js/scenarios/rides.js');
const SDL = globalThis.SDL;
const sc = SDL.scenarios['ride-hailing'];
const make = () => new SDL.Simulator(sc);
const trips = (sim) => Object.values(sim.state.trips);
const preset = (id, ms) => { const s = make(); s.dispatch('preset', { id }); s.runFor(ms); return s; };

test('fleet heartbeats keep the geo index fresh', () => {
  const s = make();
  s.runFor(2000);
  for (const id of ['d2', 'd3', 'd4', 'd5']) assert.ok(s.state.geo[id], `${id} indexed`);
  assert.ok(s.now - s.state.geo.d2.lastSeen < 3000);
});

test('driver online sends continuous pings that reach the geo index and the stream', () => {
  const s = preset('online', 5000);
  assert.equal(s.ui.driver.online, true);
  assert.ok(s.ui.driver.pings >= 5, `pings: ${s.ui.driver.pings}`);
  assert.ok(s.now - s.state.geo.d1.lastSeen < 1000, 'd1 position is fresh');
  assert.ok(s.queues.geo.msgs.length > 5, 'geo stream receives events');
  assert.equal(s.state.drivers.d1.status, 'available');
});

test('full ride: request, match, drive, complete, charged exactly once', () => {
  const s = preset('happy', 20000);
  const all = trips(s);
  assert.equal(all.length, 1);
  const t = all[0];
  assert.equal(t.status, 'COMPLETED');
  assert.equal(t.driver, 'd1');
  assert.equal(s.ui.rider.status, 'COMPLETED');
  assert.equal(s.ui.rider.paid, true);
  assert.equal(Object.keys(s.state.charges).length, 1);
  assert.equal(s.state.drivers.d1.status, 'available');
  assert.ok(s.ui.driver.earnings > 0);
  assert.equal(sc.consistency(s).key, 'ok');
  const req = s.ledger.find((e) => e.label === 'Rider: request ride');
  assert.equal(req.layers.committed, 'yes');
  assert.equal(req.layers.async, 'yes');
});

test('surge rises at the airport under a demand spike and shows in the quote', () => {
  const s = preset('surge', 4000);
  assert.ok((s.state.surge.mult['c7-5'] || 1) > 1, 'airport multiplier above 1');
  assert.ok(s.ui.rider.quote, 'quote shown');
  assert.ok(s.ui.rider.quote.multiplier > 1, `quote multiplier ${s.ui.rider.quote.multiplier}`);
});

test('surge decays after the rush ends', () => {
  const s = preset('surge', 4000);
  s.runFor(9000);
  assert.equal(s.state.surge.mult['c7-5'] || 1, 1);
});

test('hot key: airport shard latency explodes; splitting cells keeps it low', () => {
  const p95 = (s) => SDL.percentile(s.nodes.geoindex.stats.lat.slice().sort((a, b) => a - b), 95);
  const hot = preset('hotkey', 3000);
  const fixed = preset('hotfix', 3000);
  assert.ok(p95(hot) > 150, `hot p95 ${p95(hot)}`);
  assert.ok(p95(fixed) < p95(hot) / 4, `fixed p95 ${p95(fixed)} vs hot ${p95(hot)}`);
});

test('race with compare-and-set: one rider gets Aisha, no double dispatch', () => {
  const s = preset('race', 9000);
  const assigned = trips(s).filter((t) => t.driver === 'd3' && t.status === 'ACCEPTED');
  assert.equal(assigned.length, 1);
  assert.ok(trips(s).some((t) => t.status === 'NO_DRIVERS'), 'the other rider gets no driver');
  assert.notEqual(sc.consistency(s).key, 'wrong');
});

test('race without compare-and-set double-dispatches and is flagged', () => {
  const s = make();
  s.dispatch('setSwitch', { id: 'cas', on: false });
  s.dispatch('preset', { id: 'race' });
  s.runFor(9000);
  const assigned = trips(s).filter((t) => t.driver === 'd3' && t.status === 'ACCEPTED');
  assert.equal(assigned.length, 2);
  assert.equal(sc.consistency(s).key, 'wrong');
});

test('ignored offer expires and goes to the next driver', () => {
  const s = preset('timeout', 12000);
  const t = trips(s)[0];
  assert.equal(t.status, 'ACCEPTED');
  assert.notEqual(t.driver, 'd1');
  assert.ok(Object.values(s.state.offers).some((o) => o.driver === 'd1' && o.status === 'expired'));
  assert.equal(s.ui.driver.offer, null);
  assert.equal(s.state.drivers.d1.status, 'available', 'released after expiry');
});

test('driver answering the offer manually is assigned', () => {
  const s = make();
  s.dispatch('preset', { id: 'timeout' });
  s.runFor(2500);
  assert.ok(s.ui.driver.offer, 'offer on the driver phone');
  s.dispatch('accept');
  s.runFor(1500);
  assert.equal(trips(s)[0].driver, 'd1');
  assert.equal(s.ui.driver.trip.status, 'ACCEPTED');
});

test('location service down: everyone goes stale and the rider gets no driver', () => {
  const s = preset('stale', 14000);
  const t = trips(s)[0];
  assert.equal(t.status, 'NO_DRIVERS');
  assert.ok(s.state.stats.staleSkipped > 0);
  assert.equal(s.ui.rider.status, 'NO_DRIVERS');
  assert.ok(s.ui.rider.quote === null);
});

test('surge store down: base fare fallback, or refusal when the switch is off', () => {
  const a = preset('surge-down', 1500);
  assert.equal(a.ui.rider.quote.surgeFallback, true);
  assert.equal(a.ui.rider.quote.multiplier, 1);
  const b = make();
  b.dispatch('setSwitch', { id: 'baseFareFallback', on: false });
  b.dispatch('preset', { id: 'surge-down' });
  b.runFor(1500);
  assert.equal(b.ui.rider.quote, null);
  assert.equal(b.ui.rider.tone, 'fail');
});

test('lost reply on trip create: one trip, dispatched once', () => {
  const s = preset('lost-trip', 9000);
  const mine = trips(s).filter((t) => t.rider === 'rA');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'ACCEPTED');
  assert.equal(s.ui.rider.tripId, mine[0].id);
});

test('lost reply without idempotency double-books and is flagged', () => {
  const s = make();
  s.dispatch('setSwitch', { id: 'idempotentCreate', on: false });
  s.dispatch('preset', { id: 'lost-trip' });
  s.runFor(9000);
  assert.ok(trips(s).filter((t) => t.rider === 'rA').length >= 2);
  assert.equal(sc.consistency(s).key, 'wrong');
});

test('payment provider down: trip completes, charge retried, charged once', () => {
  const s = preset('payment', 12000);
  assert.ok(trips(s)[0].status === 'COMPLETED', `status ${trips(s)[0].status}`);
  assert.equal(Object.keys(s.state.charges).length, 0, 'not yet charged while provider is down');
  assert.equal(sc.consistency(s).key, 'stale');
  s.runFor(10000);
  assert.equal(Object.keys(s.state.charges).length, 1);
  assert.equal(s.ui.rider.paid, true);
  assert.equal(sc.consistency(s).key, 'ok');
});

test('trip event broker down: rider updates wait, then arrive in order', () => {
  const s = make();
  s.dispatch('preset', { id: 'events-down' });
  s.runFor(3500);
  const t = trips(s)[0];
  assert.ok(['ACCEPTED', 'ARRIVED', 'IN_PROGRESS'].includes(t.status), `db status ${t.status}`);
  assert.equal(s.ui.rider.status, 'REQUESTED', 'rider has heard nothing yet');
  assert.equal(sc.consistency(s).key, 'stale');
  s.runFor(12000);
  assert.equal(s.ui.rider.status, s.state.trips[t.id].status);
});

test('rate limit rejects rider calls at the gateway', () => {
  const s = make();
  s.dispatch('inject', { node: 'gateway', mode: 'reject', params: { code: 'RATE_LIMITED', message: 'Too many requests.' } });
  s.dispatch('estimate');
  s.runFor(1500);
  assert.equal(s.ui.rider.quote, null);
  assert.match(s.ui.rider.message, /Too many requests/);
  assert.equal(s.nodes.pricing.stats.req, 0, 'never reached pricing');
});

test('replay of a ride reproduces the same timeline', () => {
  const s = make();
  s.dispatch('preset', { id: 'happy' });
  s.runFor(6000);
  s.dispatch('inject', { node: 'notify', mode: 'paused' });
  s.runFor(2000);
  s.dispatch('restore', { node: 'notify' });
  s.runFor(8000);
  const before = JSON.stringify(s.timeline.map((e) => [e.t, e.node, e.op, e.status]));
  s.replay();
  s.runFor(16000);
  assert.equal(JSON.stringify(s.timeline.map((e) => [e.t, e.node, e.op, e.status])), before);
});
