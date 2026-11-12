// Distributed key-value store (DynamoDB) labs: every guided scenario must reach its documented end state.
// Each row: [preset, ms to run, expected consistency key, optional extra check].
const test = require('node:test');
const assert = require('node:assert/strict');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
require('../assets/js/scenarios/yt-common.js');
require('../assets/js/ui/registry.js');
const SDL = globalThis.SDL;
const load = (id) => { if (!SDL.scenarios[id]) require(`../assets/js/scenarios/${id}.js`); return SDL.scenarios[id]; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const holds = (s, node, item) => (s.state.store[node]['cart:maya'] || []).some((v) => v.items.includes(item));

const EXPECT = {
  'kv-put': [
    ['normal', 9000, 'ok', (s) => same(s.ui.tablet.cart, ['Socks']) && ['n5', 'n1', 'n2'].every((n) => holds(s, n, 'Socks')) && s.state.stats.gets === 1],
    ['rw-quorum', 9000, 'ok', (s) => same(s.ui.tablet.cart, ['Socks']) && s.ui.tablet.lastMs < 300],
    ['w1-r1-stale', 9000, 'stale', (s) => s.ui.tablet.cart.length === 0 && s.state.acked.includes('Socks') && s.state.stats.lostReplication === 0],
    ['w1-crash', 9000, 'wrong', (s) => s.state.stats.lostReplication === 1 && s.ui.tablet.cart.length === 0 && same(s.ui.maya.cart, ['Socks'])],
    ['one-down', 9000, 'ok', (s) => s.state.stats.hints === 1 && s.state.stats.replayed === 1 && same(s.ui.tablet.cart, ['Socks'])],
    ['two-down-strict', 9000, 'stale', (s) => /W = 2/.test(s.ui.maya.error) && s.state.acked.length === 0 && s.state.stats.hints === 0],
    ['two-down-sloppy', 9000, 'ok', (s) => s.state.stats.hints === 2 && s.state.stats.replayed === 2 && same(s.ui.tablet.cart, ['Socks'])],
    ['offline-lww', 9000, 'wrong', (s) => s.state.lost.includes('Socks') && same(s.ui.maya.cart, ['Hat'])],
    ['offline-vclock', 9000, 'ok', (s) => same(s.ui.maya.cart.slice().sort(), ['Hat', 'Socks']) && (s.state.store.n5['cart:maya'] || []).length === 2],
    ['reply-lost', 9000, 'ok', (s) => s.retries > 0 && s.state.stats.puts === 2 && same(s.ui.tablet.cart, ['Socks']) && (s.state.store.n5['cart:maya'] || []).length === 1],
    ['wrong-map', 9000, 'ok', (s) => s.state.stats.notOwner === 1 && s.state.stats.refreshes === 1 && same(s.ui.tablet.cart, ['Socks'])],
  ],
  'kv-ring': [
    ['steady', 9000, 'ok', (s) => s.state.stats.moved === 0 && same(s.ui.maya.cart, ['Socks']) && s.state.stats.timeouts === 0],
    ['join-vnodes', 9000, 'ok', (s) => s.state.stats.lastMove === 84 && s.state.moving.length === 0 && s.state.stats.misses === 0 && s.state.members.includes('n7')],
    ['join-modulo', 9000, 'ok', (s) => s.state.stats.lastMove === 515 && s.state.moving.length === 0 && s.state.stats.misses === 0],
    ['join-onetoken', 9000, 'stale', (s) => s.state.stats.lastMove > 0 && s.state.stats.lastMove < 60 && s.state.members.includes('n7')],
    ['leave-forward', 9000, 'ok', (s) => s.ui.maya.cart.includes('Mug') && s.state.lost.length === 0 && s.state.stats.forwarded > 0 && !s.state.members.includes('n5')],
    ['leave-noforward', 9000, 'wrong', (s) => s.state.lost.some((l) => l.key === 'cart:maya') && !s.ui.maya.cart.includes('Mug') && s.state.stats.misses > 0],
    ['mover-paused', 9000, 'stale', (s) => s.state.moving.length > 0 && s.state.stats.copied > 0 && same(s.ui.maya.cart, ['Socks'])],
    ['stale-router', 9000, 'stale', (s) => /does not own/.test(s.ui.maya.error) && s.state.stats.redirects > 0],
    ['hot-range', 9000, 'stale', (s) => /did not answer/.test(s.ui.maya.error) && s.state.stats.timeouts > 100],
    ['hot-split', 9000, 'ok', (s) => s.state.stats.splits === 1 && same(s.ui.maya.cart, ['Socks']) && s.ui.maya.lastMs < 1000 && s.state.extraTokens.length > 0],
    ['home-down', 9000, 'stale', (s) => /not accepting/.test(s.ui.maya.error)],
  ],
  'kv-quorum': [
    ['normal', 9000, 'ok', (s) => same(s.ui.tablet.cart, ['Socks']) && s.state.stats.hints === 0],
    ['w1-r1-stale', 9000, 'stale', (s) => s.ui.tablet.cart.length === 0 && s.state.acked.includes('Socks')],
    ['w1-eventual', 9000, 'ok', (s) => same(s.ui.tablet.cart, ['Socks']) && s.state.stats.repairs === 0],
    ['w1-crash', 9000, 'wrong', (s) => s.state.stats.lostReplication === 1 && same(s.ui.maya.cart, ['Socks']) && s.ui.tablet.cart.length === 0],
    ['strict-refused', 9000, 'stale', (s) => /W = 2/.test(s.ui.maya.error) && s.state.acked.length === 0],
    ['sloppy-handoff', 9000, 'ok', (s) => s.state.stats.hints === 1 && s.state.stats.replayed === 1 && s.state.stats.gets === 2 && same(s.ui.tablet.cart, ['Socks'])],
    ['standin-lost', 9000, 'wrong', (s) => s.state.stats.hints === 2 && s.state.stats.replayed === 0 && s.ui.tablet.cart.length === 0 && !holds(s, 'n2', 'Socks') && !holds(s, 'n3', 'Socks')],
    ['hint-paused', 9000, 'stale', (s) => s.state.hints.n4.length === 1 && s.ui.tablet.cart.length === 0],
    ['read-repair', 9000, 'ok', (s) => s.state.stats.repairs === 1 && holds(s, 'n3', 'Socks') && same(s.ui.tablet.cart, ['Socks'])],
    ['no-repair', 9000, 'stale', (s) => s.state.stats.repairs === 0 && !holds(s, 'n3', 'Socks') && same(s.ui.tablet.cart, ['Socks'])],
    ['partition-lww', 9000, 'wrong', (s) => s.state.lost.includes('Socks') && s.state.stats.dropped > 0 && s.state.stats.replayed === 2],
    ['partition-vclock', 9000, 'ok', (s) => same(s.ui.maya.cart.slice().sort(), ['Hat', 'Socks']) && same(s.ui.tablet.cart.slice().sort(), ['Hat', 'Socks']) && s.state.stats.dropped > 0],
  ],
  'kv-conflicts': [
    ['sequential', 9000, 'ok', (s) => s.state.store.n1.length === 1 && same(s.ui.maya.cart.slice().sort(), ['Hat', 'Socks']) && same(s.ui.tablet.cart.slice().sort(), ['Hat', 'Socks'])],
    ['concurrent-lww', 9000, 'wrong', (s) => s.state.lost.length === 1 && s.ui.maya.cart.length === 1 && s.ui.tablet.cart.length === 1],
    ['concurrent-vclock', 9000, 'ok', (s) => s.state.stats.merges >= 2 && s.state.store.n1.length === 1 && same(s.ui.tablet.cart.slice().sort(), ['Hat', 'Mug', 'Socks'])],
    ['skew-lww', 9000, 'wrong', (s) => s.state.lost.includes('Hat') && same(s.ui.tablet.cart, ['Socks'])],
    ['skew-vclock', 9000, 'ok', (s) => s.state.lost.length === 0 && same(s.ui.maya.cart.slice().sort(), ['Hat', 'Socks'])],
    ['stale-context-lww', 9000, 'wrong', (s) => s.state.lost.includes('Socks') && same(s.ui.maya.cart, ['Hat'])],
    ['stale-context-vclock', 9000, 'ok', (s) => s.state.store.n1.length === 2 && same(s.ui.maya.cart.slice().sort(), ['Hat', 'Socks'])],
    ['remove-resurrect', 9000, 'wrong', (s) => s.state.removed.includes('Socks') && s.ui.maya.cart.includes('Socks') && s.ui.maya.cart.includes('Mug')],
    ['remove-tombstone', 9000, 'ok', (s) => same(s.ui.maya.cart.slice().sort(), ['Hat', 'Mug']) && same(s.ui.tablet.cart.slice().sort(), ['Hat', 'Mug'])],
    ['retry-false-sibling', 9000, 'ok', (s) => s.retries > 0 && s.state.store.n1.length === 2 && same(s.ui.tablet.cart, ['Socks'])],
    ['retry-device-clock', 9000, 'ok', (s) => s.retries > 0 && s.state.store.n1.length === 1 && same(s.ui.tablet.cart, ['Socks'])],
  ],
  'kv-storage': [
    ['write-read', 9000, 'ok', (s) => s.ui.maya.lastRead.found === 'memtable' && s.ui.maya.lastRead.probes === 0],
    ['flush-read', 9000, 'ok', (s) => s.state.stats.flushes >= 1 && /^level 0/.test(s.ui.maya.lastRead.found) && s.state.wal.length < 40],
    ['levels-read', 9000, 'ok', (s) => s.state.stats.compactions >= 1 && /^level 1/.test(s.ui.maya.lastRead.found) && s.ui.maya.lastRead.probes === 1],
    ['crash-fsync', 9000, 'ok', (s) => s.state.stats.replayed >= 1 && s.state.stats.walLost === 0 && same(s.ui.maya.cart, ['Socks'])],
    ['crash-nofsync', 9000, 'wrong', (s) => s.state.stats.walLost === 1 && s.ui.maya.cart.length === 0],
    ['read-amplification', 9000, 'stale', (s) => s.ui.maya.lastRead.probes >= 8 && s.ui.maya.lastMs > 100 && same(s.ui.maya.cart, ['Socks'])],
    ['bloom-filters', 9000, 'ok', (s) => s.state.stats.bloomSkips >= 8 && s.ui.maya.lastRead.probes <= 2 && s.state.levels[0].length >= 8],
    ['tombstone', 9000, 'ok', (s) => s.state.stats.tombsDropped >= 1 && s.ui.maya.cart.length === 0 && s.ui.maya.lastRead.found === null],
    ['disk-full', 9000, 'stale', (s) => s.state.stats.stalls > 0 && /stall/.test(s.ui.maya.error) && s.state.stats.flushes === 0],
    ['slow-fsync', 9000, 'stale', (s) => s.ui.maya.lastMs > 100 && same(s.ui.maya.cart, ['Socks'])],
    ['slow-group-commit', 9000, 'ok', (s) => s.ui.maya.lastMs < 100 && same(s.ui.maya.cart, ['Socks'])],
    ['ttl', 9000, 'ok', (s) => s.state.stats.expiredDropped >= 50 && same(s.ui.maya.cart, ['Socks'])],
  ],
  'kv-membership': [
    ['steady', 9000, 'ok', (s) => s.state.stats.falseDeaths === 0 && s.state.stats.detections.length === 0 && same(s.ui.maya.cart, ['Socks'])],
    ['crash-timeout', 9000, 'stale', (s) => s.state.stats.detections[0] && s.state.stats.detections[0].node === 'n1' && s.state.stats.detections[0].real && s.state.stats.detections[0].at - s.state.crashedAt.n1 > 800 && s.state.stats.detections[0].at - s.state.crashedAt.n1 < 2000 && s.state.members.length === 6],
    ['crash-remove', 9000, 'ok', (s) => s.state.members.length === 5 && s.state.stats.repaired > 0 && same(s.ui.maya.cart, ['Socks'])],
    ['gc-timeout', 9000, 'ok', (s) => s.state.stats.falseDeaths >= 1 && s.state.stats.repaired > 0 && same(s.ui.maya.cart, ['Socks'])],
    ['gc-phi', 9000, 'ok', (s) => s.state.stats.falseDeaths === 0 && s.state.stats.lostReplication > 0 && same(s.ui.maya.cart, ['Socks'])],
    ['lag-timeout', 9000, 'stale', (s) => s.state.stats.falseDeaths >= 5],
    ['lag-phi', 9000, 'ok', (s) => s.state.stats.falseDeaths <= 1 && s.state.stats.flaps <= 1 && same(s.ui.maya.cart, ['Socks'])],
    ['flapping', 9000, 'stale', (s) => s.state.stats.flaps >= 2 && s.state.stats.lostReplication > 0],
    ['partition-repair', 9000, 'ok', (s) => s.state.stats.repaired > 0 && s.state.stats.lostReplication > 0 && same(s.ui.maya.cart, ['Socks'])],
    ['repair-paused', 9000, 'stale', (s) => s.state.stats.repaired === 0 && s.ui.maya.cart.length === 0],
    ['full-scan', 9000, 'ok', (s) => s.state.stats.keysCompared > 1000 && s.state.stats.repaired > 0],
    ['auto-remove', 9000, 'stale', (s) => s.state.members.length === 5 && s.state.stats.falseDeaths >= 1 && !s.nodes.n1.modes.crashed && !s.nodes.n1.modes.gc],
  ],
  'kv-admission': [
    ['steady', 9000, 'ok', (s) => s.ui.maya.lastMs < 200 && s.state.bg.failed === 0 && s.state.bg.throttled === 0],
    ['meltdown', 9000, 'stale', (s) => s.ui.maya.lastErr === 'TIMEOUT' && s.queueWait('p1') > 1000 && s.state.bg.failed > 1000],
    ['buckets', 9000, 'stale', (s) => s.queueWait('p1') < 200 && s.state.bg.throttled > 1000 && s.state.bg.failed === 0 && s.ui.maya.lastMs < 200],
    ['fixed-quota', 9000, 'stale', (s) => s.state.bg.throttled > 500 && s.state.bg.failed === 0 && s.state.last.p2.admitted < 300],
    ['adaptive', 9000, 'ok', (s) => s.state.bg.throttled === 0 && s.state.bg.failed === 0 && s.state.last.p1.admitted > 600],
    ['cache', 9000, 'ok', (s) => s.state.cacheStats.hits > 5000 && s.state.last.p1.admitted < 300 && same(s.ui.maya.cart, ['Socks', 'Hat'])],
    ['cache-stale', 9000, 'stale', (s) => s.state.bg.staleDeal > 1000 && s.state.cache['deal:flash'].value.v < s.state.dealVersion],
    ['cache-down', 9000, 'stale', (s) => s.ui.maya.lastErr === 'TIMEOUT' && s.state.cacheStats.hits > 0 && s.queueWait('p1') > 1000],
    ['split-hot-key', 9000, 'stale', (s) => s.state.stats.splits === 1 && s.state.parts.p3 && s.queueWait('p3') > 1000 && s.queueWait('p1') < 100 && same(s.ui.maya.cart, ['Socks'])],
    ['noisy-meltdown', 9000, 'stale', (s) => s.state.stats.splits === 0 && s.queueWait('p1') > 200],
    ['noisy-split', 9000, 'ok', (s) => s.state.stats.splits === 1 && s.queueWait('p1') < 100 && s.queueWait('p3') < 100 && s.ui.maya.lastMs < 200],
    ['admission-down', 9000, 'stale', (s) => s.ui.maya.lastErr === 'TIMEOUT' && s.state.bg.throttled === 0 && s.queueWait('p1') > 1000],
  ],
  'kv-conditional': [
    ['race-plain', 9000, 'wrong', (s) => s.state.told.bought.length === 2 && s.state.stock.r1.qty === 0],
    ['race-conditional', 9000, 'ok', (s) => s.state.told.bought.length === 1 && s.state.told.soldOut.length === 1 && s.state.stock.r1.qty === 0],
    ['race-leaderless', 9000, 'wrong', (s) => s.state.told.bought.length === 2],
    ['partition-leader', 9000, 'ok', (s) => s.ui.maya.status === 'bought' && s.ui.omar.status === 'refused' && s.state.stock.r3.qty === 0 && s.state.stats.caughtUp >= 1],
    ['partition-leaderless', 9000, 'wrong', (s) => s.state.told.bought.length === 2 && s.state.stats.lostReplication > 0],
    ['leader-crash', 9000, 'ok', (s) => s.state.leader === 'r2' && s.state.stats.elections === 1 && s.ui.maya.status === 'bought'],
    ['retry-no-token', 9000, 'wrong', (s) => s.ui.maya.status === 'refused' && s.state.actualBuyers.includes('maya') && s.retries > 0],
    ['retry-token', 9000, 'ok', (s) => s.ui.maya.status === 'bought' && s.state.stats.replays === 1 && s.retries > 0 && s.state.stats.writes === 1],
    ['txn-commit', 9000, 'ok', (s) => s.state.wallet.maya === 20 && s.state.stock.r1.qty === 0 && s.state.stats.txns === 1 && !s.state.locks.stock],
    ['txn-insufficient', 9000, 'ok', (s) => s.state.wallet.omar === 5 && s.ui.omar.status === 'refused' && s.ui.maya.status === 'bought' && s.state.wallet.maya === 20],
    ['txn-in-doubt', 9000, 'stale', (s) => s.state.locks.stock === 't1' && s.nodes.txn.modes.crashed && s.state.stock.r1.qty === 1 && s.state.wallet.maya === 30 && /locked/i.test(s.ui.omar.error)],
    ['txn-recover', 9000, 'ok', (s) => s.state.stats.aborted === 1 && s.state.stats.txns === 1 && s.state.wallet.maya === 20 && s.ui.omar.status === 'refused'],
  ],
  'kv-global': [
    ['lag', 9000, 'ok', (s) => same(s.ui.tablet.cart, ['Socks']) && s.state.lost.length === 0],
    ['concurrent-lww', 9000, 'wrong', (s) => s.state.lost.length === 1 && same(s.state.data.us['cart:maya'].items, s.state.data.eu['cart:maya'].items)],
    ['concurrent-merge', 9000, 'ok', (s) => same(s.ui.maya.cart.slice().sort(), ['Hat', 'Socks']) && same(s.ui.tablet.cart.slice().sort(), ['Hat', 'Socks'])],
    ['skew-lww', 9000, 'wrong', (s) => s.state.lost.includes('Socks') && same(s.ui.maya.cart, ['Hat'])],
    ['link-slow', 9000, 'stale', (s) => s.ui.tablet.cart.length === 0 && s.queueStats('us-out').lag > 1000],
    ['link-recovers', 9000, 'ok', (s) => s.state.maxBacklog >= 2 && same(s.ui.tablet.cart.slice().sort(), ['Hat', 'Socks'])],
    ['failover', 9000, 'ok', (s) => s.state.stats.flips === 1 && same(s.ui.tablet.cart.slice().sort(), ['Hat', 'Socks']) && s.state.routed.maya === 'us'],
    ['no-failover', 9000, 'stale', (s) => /not accepting/.test(s.ui.maya.error) && s.state.stats.flips === 0],
    ['failover-unreplicated-lww', 9000, 'wrong', (s) => s.state.lost.includes('Socks') && same(s.ui.maya.cart, ['Hat']) && s.state.stats.flips === 1],
    ['failover-unreplicated-merge', 9000, 'ok', (s) => same(s.ui.maya.cart.slice().sort(), ['Hat', 'Socks']) && s.state.lost.length === 0],
    ['flip-stale', 9000, 'stale', (s) => s.ui.maya.cart.length === 0 && s.ui.maya.lastRegion === 'eu' && s.state.data.eu['cart:maya'].items.includes('Socks')],
    ['flip-sticky', 9000, 'ok', (s) => same(s.ui.maya.cart, ['Socks']) && s.ui.maya.lastRegion === 'us' && s.state.routed.maya === 'eu'],
  ],
};

for (const [id, rows] of Object.entries(EXPECT)) {
  test(`${id}: every guided scenario reaches its end state`, () => {
    const sc = load(id);
    const presetIds = sc.presets.map((p) => p.id);
    assert.deepEqual(rows.map((r) => r[0]).sort(), presetIds.slice().sort(), 'every preset has an expectation');
    for (const [preset, ms, key, extra] of rows) {
      const s = new SDL.Simulator(sc);
      s.dispatch('preset', { id: preset });
      s.runFor(ms);
      const c = sc.consistency(s);
      assert.equal(c.key, key, `${id}/${preset}: ${c.label}`);
      if (extra) assert.ok(extra(s), `${id}/${preset}: extra check`);
    }
  });
  test(`${id}: replays deterministically`, () => {
    const sc = load(id);
    for (const preset of sc.presets.map((p) => p.id)) {
      const s = new SDL.Simulator(sc);
      s.dispatch('preset', { id: preset });
      s.runFor(6000);
      const before = JSON.stringify(s.timeline.map((e) => [e.t, e.node, e.op, e.status]));
      s.replay();
      s.runFor(6000);
      assert.equal(JSON.stringify(s.timeline.map((e) => [e.t, e.node, e.op, e.status])), before, `${id}/${preset}`);
    }
  });
  test(`${id}: no scenario code errors`, () => {
    const sc = load(id);
    for (const preset of sc.presets.map((p) => p.id)) {
      const s = new SDL.Simulator(sc);
      s.dispatch('preset', { id: preset });
      s.runFor(9000);
      const bug = s.timeline.find((e) => e.error && e.error.code === 'INTERNAL');
      assert.ok(!bug, `${id}/${preset}: ${bug && bug.error.message}`);
    }
  });
}

test('ring helper: virtual nodes balance load and limit movement; modulo moves most keys', () => {
  const R = SDL.yt.ring;
  const nodes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
  const keys = [...Array(600)].map((_, i) => `cart:u${i}`);
  const r = R.create(nodes, 64);
  const d = R.distribution(r, keys);
  const counts = Object.values(d);
  assert.ok(Math.max(...counts) < 1.3 * (600 / 6) && Math.min(...counts) > 0.7 * (600 / 6), `balanced: ${JSON.stringify(d)}`);
  const before = Object.fromEntries(keys.map((k) => [k, R.owners(r, k, 1)[0]]));
  R.add(r, 'n7');
  const moved = keys.filter((k) => before[k] !== R.owners(r, k, 1)[0]).length;
  assert.ok(moved > 50 && moved < 130, `about a seventh moves: ${moved}`);
  const mb = Object.fromEntries(keys.map((k) => [k, R.modulo(nodes, k, 1)[0]]));
  const movedMod = keys.filter((k) => mb[k] !== R.modulo(nodes.concat(['n7']), k, 1)[0]).length;
  assert.ok(movedMod > 400, `modulo moves most: ${movedMod}`);
  assert.equal(R.owners(r, 'cart:maya', 3).length, 3, 'preference list has N distinct nodes');
});

test('vector clock helper: ordering, concurrency, siblings, and replica apply rules', () => {
  const V = SDL.yt.vclock;
  const K = SDL.yt.kv;
  const a = V.inc({}, 'phone');
  const b = V.inc({}, 'tablet');
  assert.equal(V.compare(a, b), 'concurrent');
  assert.equal(V.compare(a, V.inc(a, 'tablet')), 'before');
  assert.equal(V.compare(V.inc(a, 'tablet'), a), 'after');
  assert.equal(V.siblings([{ clock: a }, { clock: b }, { clock: V.merge(a, b) }]).length, 1, 'the merged clock dominates both');
  // A write from an old context keeps the stored version as a sibling; a write from the current context replaces it.
  let rep = K.applyWrite([], { items: ['Socks'], clock: a, ts: 1 }, {}, true).versions;
  rep = K.applyWrite(rep, { items: ['Hat'], clock: b, ts: 2 }, {}, true).versions;
  assert.equal(rep.length, 2, 'two siblings');
  const merged = K.reconcile(rep, true);
  assert.deepEqual(merged.items.slice().sort(), ['Hat', 'Socks']);
  rep = K.applyWrite(rep, { items: merged.items, clock: V.inc(merged.clock, 'phone'), ts: 3 }, merged.clock, true).versions;
  assert.equal(rep.length, 1, 'a write from the merged context collapses the siblings');
  // Last writer wins loses the other side's item.
  const lww = K.applyWrite([{ items: ['Socks'], clock: {}, ts: 1 }], { items: ['Hat'], clock: {}, ts: 2 }, {}, false);
  assert.deepEqual(lww.lost, ['Socks']);
});

test('key-value store path: every page exists and every built lab loads', () => {
  const sys = SDL.SYSTEMS.find((x) => x.id === 'kv');
  for (const id of sys.path) assert.ok(SDL.page(id), `missing page ${id}`);
  assert.equal(sys.path.length, 10);
  for (const p of SDL.PAGES.filter((x) => sys.groups.includes(x.group) && x.status === 'built' && !x.calc)) load(p.id);
});
module.exports = { EXPECT };
