// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
require('../assets/js/scenarios/sandbox.js');
const SDL = globalThis.SDL;

const make = () => new SDL.Simulator(SDL.scenarios.sandbox);
const last = (sim) => sim.ledger[sim.ledger.length - 1];

test('rng is deterministic per seed', () => {
  const a = SDL.createRng(42), b = SDL.createRng(42), c = SDL.createRng(43);
  const sa = [a(), a(), a()], sb = [b(), b(), b()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, [c(), c(), c()]);
});

test('scheduler runs events in time order, ties in insertion order', () => {
  const sim = make();
  const order = [];
  sim.schedule(20, () => order.push('b'));
  sim.schedule(10, () => order.push('a'));
  sim.schedule(20, () => order.push('c'));
  sim.runUntilIdle();
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('advanceTo never runs future events hidden behind a cancelled one (regression)', () => {
  const sim = make();
  const ev = sim.schedule(10, () => {});
  let ran = false;
  sim.schedule(3000, () => (ran = true));
  sim.cancel(ev);
  sim.advanceTo(900);
  assert.equal(sim.now, 900);
  assert.equal(ran, false);
});

test('step executes exactly one event', () => {
  const sim = make();
  let n = 0;
  sim.schedule(5, () => n++);
  sim.schedule(6, () => n++);
  assert.equal(sim.step(), true);
  assert.equal(n, 1);
  assert.equal(sim.now, 5);
});

test('healthy add commits, projects, and pushes', () => {
  const sim = make();
  sim.dispatch('add');
  sim.runUntilIdle();
  assert.equal(sim.state.db.total, 1);
  assert.equal(sim.state.read.total, 1);
  assert.equal(sim.ui.displayed, 1);
  assert.equal(sim.ui.status, 'saved');
  const e = last(sim);
  assert.equal(e.layers.committed, 'yes');
  assert.equal(e.layers.async, 'yes');
  assert.equal(e.layers.displayed, 'yes');
  assert.equal(sim.retries, 0);
  const ops = sim.timeline.map((e) => `${e.node}:${e.op}`);
  assert.ok(ops.includes('gateway:receive add'), 'arrivals are logged');
  assert.ok(ops.indexOf('gateway:receive add') < ops.indexOf('db:commit'), 'timeline is in causal order');
  assert.equal(SDL.scenarios.sandbox.consistency(sim).key, 'ok');
});

test('same actions produce an identical timeline (determinism)', () => {
  const run = () => {
    const sim = make();
    sim.dispatch('inject', { node: 'db', mode: 'dropResponse', duration: 2500 });
    sim.dispatch('add');
    sim.runFor(6000);
    return JSON.stringify(sim.timeline.map((e) => [e.t, e.node, e.op, e.status]));
  };
  assert.equal(run(), run());
});

test('database down: bounded retries, nothing committed, honest failure', () => {
  const sim = make();
  sim.dispatch('inject', { node: 'db', mode: 'down' });
  sim.dispatch('add');
  sim.runUntilIdle();
  assert.equal(sim.state.db.total, 0);
  assert.equal(sim.retries, 2, 'three attempts means two retries');
  assert.equal(sim.ui.status, 'failed');
  const e = last(sim);
  assert.equal(e.layers.committed, 'no');
  assert.equal(e.layers.accepted, 'yes', 'counter service accepted before the DB failed');
  assert.equal(sim.nodeStatus('db').key, 'failed');
  const s = SDL.snapshot(sim);
  assert.equal(s.failed, 1);
});

test('reply lost after commit: unknown outcome, never double counts', () => {
  const sim = make();
  sim.dispatch('inject', { node: 'db', mode: 'dropResponse' });
  sim.dispatch('add');
  sim.runUntilIdle();
  assert.equal(sim.ui.status, 'unknown');
  assert.equal(sim.state.db.total, 1, 'three attempts, one key, one increment');
  assert.equal(last(sim).layers.committed, 'yes', 'ledger shows the truth the client cannot see');
  assert.equal(last(sim).layers.displayed, 'unknown');
  sim.dispatch('restore', { node: 'db', mode: 'dropResponse' });
  sim.dispatch('retryLast');
  sim.runUntilIdle();
  assert.equal(sim.ui.status, 'saved');
  assert.equal(sim.state.db.total, 1);
  assert.match(sim.ui.message, /original result/);
});

test('timed failure auto-restores and a late retry succeeds idempotently', () => {
  const sim = make();
  sim.dispatch('preset', { id: 'lost-reply' });
  sim.runUntilIdle();
  assert.equal(Object.keys(sim.nodes.db.modes).length, 0);
  assert.equal(sim.ui.status, 'saved');
  assert.equal(sim.state.db.total, 1);
  assert.ok(sim.retries >= 1);
});

test('broker down: commit succeeds, projection waits, then catches up', () => {
  const sim = make();
  sim.dispatch('inject', { node: 'broker', mode: 'down' });
  sim.dispatch('add');
  sim.runFor(3000);
  assert.equal(sim.state.db.total, 1);
  assert.equal(sim.state.read.total, 0);
  assert.equal(sim.ui.status, 'saved');
  assert.equal(last(sim).layers.async, 'pending');
  assert.equal(SDL.scenarios.sandbox.consistency(sim).key, 'stale');
  sim.dispatch('restore', { node: 'broker' });
  sim.runFor(3000);
  assert.equal(sim.state.read.total, 1);
  assert.equal(last(sim).layers.async, 'yes');
});

test('paused consumer: depth and lag grow, then drain on resume', () => {
  const sim = make();
  sim.dispatch('inject', { node: 'projector', mode: 'paused' });
  sim.dispatch('burst');
  sim.runFor(2000);
  const st = sim.queueStats('events');
  assert.ok(sim.now <= 2000, 'clock never passes the requested time and idles when no work is pending');
  assert.ok(st.lag < 2000, 'lag is bounded by elapsed time');
  assert.equal(sim.state.db.total, 5);
  assert.equal(st.depth, 5);
  assert.ok(st.lag > 0);
  assert.equal(sim.nodeStatus('projector').key, 'degraded');
  sim.dispatch('restore', { node: 'projector' });
  sim.runUntilIdle();
  assert.equal(sim.queueStats('events').depth, 0);
  assert.equal(sim.state.read.total, 5);
});

test('duplicate delivery: idempotent consumer keeps the count right', () => {
  const sim = make();
  sim.dispatch('inject', { node: 'broker', mode: 'duplicate' });
  sim.dispatch('add');
  sim.runUntilIdle();
  assert.equal(sim.queues.events.msgs.length, 2);
  assert.equal(sim.state.read.total, 1);
  assert.ok(sim.timeline.some((e) => e.op === 'duplicate skipped'));
});

test('duplicate delivery without dedupe overcounts and is flagged incorrect', () => {
  const sim = make();
  sim.dispatch('preset', { id: 'no-dedupe' });
  sim.runUntilIdle();
  assert.equal(sim.state.db.total, 1);
  assert.equal(sim.state.read.total, 2);
  assert.equal(SDL.scenarios.sandbox.consistency(sim).key, 'wrong');
});

test('replay reproduces the run exactly', () => {
  const sim = make();
  sim.dispatch('add');
  sim.runFor(150);
  sim.dispatch('inject', { node: 'projector', mode: 'paused' });
  sim.runFor(100);
  sim.dispatch('add');
  sim.runFor(900);
  sim.dispatch('restore', { node: 'projector' });
  sim.runUntilIdle();
  const before = JSON.stringify(sim.timeline.map((e) => [e.t, e.node, e.op, e.status]));
  const stateBefore = JSON.stringify(sim.state);
  const n = sim.replay();
  assert.equal(n, 4);
  sim.runUntilIdle();
  assert.equal(JSON.stringify(sim.timeline.map((e) => [e.t, e.node, e.op, e.status])), before);
  assert.equal(JSON.stringify(sim.state), stateBefore);
});

test('reset returns to a clean initial state', () => {
  const sim = make();
  sim.dispatch('inject', { node: 'db', mode: 'down' });
  sim.dispatch('add');
  sim.runUntilIdle();
  sim.reset();
  assert.equal(sim.now, 0);
  assert.equal(sim.timeline.length, 0);
  assert.equal(sim.ledger.length, 0);
  assert.equal(sim.activeFailures().length, 0);
  assert.equal(sim.state.db.total, 0);
  assert.equal(sim.actionLog.length, 0);
});

test('slow database causes timeouts that the metrics reflect', () => {
  const sim = make();
  sim.dispatch('inject', { node: 'db', mode: 'slow', params: { factor: 30 } });
  sim.dispatch('add');
  sim.runUntilIdle();
  const s = SDL.snapshot(sim);
  assert.equal(s.total, 1);
  assert.ok(s.p50 > 1000, 'latency reflects the retries and timeouts');
  assert.ok(sim.timeline.some((e) => e.status === 'timeout'));
});

test('percentile helper', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(SDL.percentile(xs, 50), 5);
  assert.equal(SDL.percentile(xs, 95), 10);
  assert.equal(SDL.percentile([], 50), null);
});
