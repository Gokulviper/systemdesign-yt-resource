// E-commerce (Amazon) labs: every guided scenario must reach its documented end state.
// Each row: [preset, ms to run, expected consistency key, optional extra check].
const test = require('node:test');
const assert = require('node:assert/strict');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
require('../assets/js/scenarios/yt-common.js');
require('../assets/js/ui/registry.js');
const SDL = globalThis.SDL;
const load = (id) => { if (!SDL.scenarios[id]) require(`../assets/js/scenarios/${id}.js`); return SDL.scenarios[id]; };
const status = (s, o) => s.state.orders[o] && s.state.orders[o].status;

const EXPECT = {
  'shop-order': [
    ['happy', 9000, 'ok', (s) => status(s, 'O1') === 'SHIPPED' && Object.keys(s.state.captures).length === 1 && s.ui.shopper.track['order.shipped']],
    ['search-down', 9000, 'stale', (s) => s.ui.shopper.degraded && status(s, 'O1') === 'CONFIRMED'],
    ['last-unit', 9000, 'ok', (s) => s.state.sold.length === 1 && status(s, 'O2') === 'CANCELLED'],
    ['last-unit-bad', 9000, 'wrong', (s) => s.state.stock.onHand === -1],
    ['double', 9000, 'ok', (s) => Object.keys(s.state.orders).length === 1 && Object.keys(s.state.charges).length === 1],
    ['double-bad', 9000, 'wrong', (s) => Object.keys(s.state.charges).length === 2],
    ['declined', 9000, 'ok', (s) => status(s, 'O1') === 'CANCELLED' && s.state.stock.holds.O1 === 'released' && s.state.stock.onHand === 1],
    ['timeout', 9000, 'ok', (s) => s.retries > 0 && Object.keys(s.state.charges).length === 1],
    ['paused', 9000, 'stale', (s) => !s.ui.shopper.track['order.confirmed']],
    ['dual', 9000, 'wrong', (s) => s.state.lost.length === 1 && s.ui.warehouse.picks.length === 0],
    ['region', 9000, 'ok', (s) => s.ui.shopper.region === 'B' && status(s, 'O1') === 'SHIPPED'],
    ['region-bad', 9000, 'wrong', (s) => s.state.regionErrors >= 2],
  ],
  'shop-inventory': [
    ['buy', 9000, 'ok', (s) => s.state.inv.onHand === 0 && s.ui.shopperA.stage === 'done'],
    ['race', 9000, 'ok', (s) => s.ui.shopperB.stage === 'soldout' && s.state.sold.length === 1],
    ['race-bad', 9000, 'wrong', (s) => s.state.sold.length === 2 && s.state.inv.onHand === -1],
    ['abandon', 9000, 'ok', (s) => s.ui.shopperB.stage === 'done' && s.state.inv.holds.H1.status === 'expired'],
    ['expiry-paused', 9000, 'stale', (s) => s.ui.shopperB.stage === 'soldout' && s.state.inv.onHand === 1],
    ['expiry-lazy', 9000, 'ok', (s) => s.ui.shopperB.stage === 'done'],
    ['slow-pay', 9000, 'ok', (s) => s.ui.shopperA.stage === 'failed' && s.ui.shopperB.stage === 'done' && s.state.stats.voided === 1],
    ['slow-pay-bad', 9000, 'wrong', (s) => s.state.sold.length === 2],
    ['restock-dup', 9000, 'ok', (s) => s.state.inv.onHand === 6 && s.state.dupSkipped === 1],
    ['restock-dup-bad', 9000, 'wrong', (s) => s.state.inv.onHand === 11],
    ['replica-lag', 9000, 'stale', (s) => s.ui.shopperB.stage === 'soldout' && s.state.sold.length === 1],
    ['no-holds', 9000, 'ok', (s) => s.ui.shopperB.stage === 'failed' && s.state.stats.voided === 1],
  ],
  'shop-checkout': [
    ['happy', 9000, 'ok', (s) => status(s, 'O1') === 'SHIPPED' && s.state.emails.length === 2 && Object.keys(s.state.captures).length === 1],
    ['double', 9000, 'ok', (s) => Object.keys(s.state.orders).length === 1],
    ['double-bad', 9000, 'wrong', (s) => Object.keys(s.state.orders).length === 2],
    ['decline', 9000, 'ok', (s) => status(s, 'O1') === 'CANCELLED' && s.state.reservations.O1 === 'released'],
    ['decline-bad', 9000, 'wrong', (s) => s.state.reservations.O1 === 'held'],
    ['crash', 9000, 'ok', (s) => status(s, 'O1') === 'SHIPPED' && s.ui.shopper.stage === 'placed'],
    ['crash-bad', 9000, 'wrong', (s) => status(s, 'O1') === 'RUNNING'],
    ['tax-down', 9000, 'ok', (s) => Object.keys(s.state.orders).length === 0 && s.ui.shopper.stage === 'failed'],
    ['dual', 9000, 'wrong', (s) => status(s, 'O1') === 'CONFIRMED' && !s.state.shipments.O1],
    ['outbox', 9000, 'ok', (s) => status(s, 'O1') === 'SHIPPED'],
    ['dup', 9000, 'ok', (s) => s.state.shipments.O1 === 1 && s.state.dupSkipped > 0],
    ['dup-bad', 9000, 'wrong', (s) => s.state.shipments.O1 === 2 && Object.keys(s.state.captures).length === 1],
  ],
  'shop-flash': [
    ['calm', 9000, 'ok', (s) => s.ui.you.stage === 'done' && s.state.stats.timedOut === 0],
    ['crush', 9000, 'stale', (s) => s.ui.you.stage === 'failed' && s.state.stats.ghost > 0 && s.state.stock === 0],
    ['storm', 9000, 'stale', (s) => s.state.stats.retries > 600],
    ['room', 9000, 'ok', (s) => s.ui.you.stage === 'done' && s.state.room.turnedAway > 0],
    ['buckets', 9000, 'ok', (s) => s.ui.you.stage === 'done' && s.state.bucket.every((b) => b === 0)],
    ['async', 9000, 'ok', (s) => s.ui.you.stage === 'done' && s.state.stats.batches > 0],
    ['async-paused', 9000, 'stale', (s) => s.ui.you.stage === 'queued' && s.state.stock === 300],
    ['bots', 9000, 'wrong', (s) => s.state.stats.botUnits > 6],
    ['bots-limited', 9000, 'ok', (s) => s.state.stats.botUnits === 6 && s.ui.you.stage === 'done'],
    ['all', 9000, 'ok', (s) => s.ui.you.stage === 'done' && s.state.stats.botUnits <= 6],
  ],
  'shop-cart': [
    ['add', 6000, 'ok', (s) => s.ui.tablet.shown.echo === 1],
    ['ryw-bad', 6000, 'stale', (s) => s.ui.phone.missing === 'echo'],
    ['ryw', 6000, 'ok', (s) => s.ui.phone.shown.echo === 1 && s.state.stats.primaryReads > 0],
    ['concurrent', 6000, 'ok', (s) => s.state.stats.conflicts === 1 && s.ui.phone.shown.kindle === 1],
    ['concurrent-bad', 6000, 'wrong', (s) => Object.keys(s.state.db.primary.items).length === 1],
    ['merge', 6000, 'ok', (s) => s.ui.phone.shown.echo === 1 && s.ui.phone.shown.kindle === 1],
    ['merge-bad', 6000, 'wrong', (s) => !s.state.db.primary.items.echo],
    ['retry', 6000, 'ok', (s) => s.state.stats.dups === 1 && s.state.db.primary.items.echo === 1],
    ['retry-bad', 6000, 'wrong', (s) => s.state.db.primary.items.echo === 2],
    ['failover', 6000, 'ok', (s) => s.state.leader === 'standby' && s.ui.tablet.shown.kindle === 1],
    ['failover-bad', 6000, 'wrong', (s) => s.state.leader === 'standby' && !s.state.db.standby.items.kindle],
  ],
  'shop-regions': [
    ['normal', 9000, 'ok', (s) => s.ui.shopperB.lastOrder === 'A-2' && s.state.db.homedb.orders['A-2'] && s.state.db.standbyB.orders['A-2']],
    ['failover', 9000, 'ok', (s) => s.state.belief.B === 'B' && s.ui.shopperA.orders.includes('A-1')],
    ['failover-async', 9000, 'wrong', (s) => s.state.belief.B === 'B' && s.ui.shopperA.orders.length === 0],
    ['no-failover', 9000, 'wrong', (s) => s.state.regionErrors === 2 && s.state.belief.B === 'A'],
    ['partition', 9000, 'stale', (s) => s.state.belief.B === 'A' && s.ui.shopperB.cart.echo === 1 && s.state.stats.refused === 1],
    ['partition-bad', 9000, 'wrong', (s) => s.state.db.homedb.writable && s.state.db.standbyB.writable],
    ['cart', 9000, 'ok', (s) => s.ui.shopperA.cart.echo === 1 && s.ui.shopperA.cart.kindle === 1 && !s.state.db.homedb.writable],
    ['cart-bad', 9000, 'wrong', (s) => !s.ui.shopperA.cart.echo],
  ],
  'shop-catalog': [
    ['view', 9000, 'ok', (s) => s.state.stats.replicaReads === 1 && s.state.stats.hits === 1 && s.ui.shopper.source === 'cache hit'],
    ['price', 9000, 'ok', (s) => s.ui.shopper.shown.price === 64.99 && s.state.stats.deletes === 1],
    ['ttl-only', 9000, 'stale', (s) => s.ui.shopper.shown.price === 49.99 && s.state.db.primary.price === 64.99 && s.state.stats.deletes === 0],
    ['lost', 9000, 'ok', (s) => s.ui.shopper.shown.price === 64.99 && s.state.stats.deletes === 0],
    ['lost-forever', 9000, 'stale', (s) => s.state.cache.echo.page.price === 49.99 && !s.state.cache.echo.exp],
    ['buy-stale', 9000, 'wrong', (s) => s.state.orders.length === 1 && s.state.orders[0].price === 49.99],
    ['buy-reprice', 9000, 'ok', (s) => s.state.orders.length === 1 && s.state.orders[0].price === 64.99 && s.state.cache.echo.page.price === 64.99],
    ['lag', 9000, 'stale', (s) => s.ui.shopper.shown.price === 49.99 && s.state.stats.deletes === 1],
    ['lag-redelete', 9000, 'ok', (s) => s.ui.shopper.shown.price === 64.99 && s.state.stats.deletes === 2],
    ['deal', 9000, 'ok', (s) => s.state.stats.coalesced > 100 && s.state.stats.replicaReads < 10 && s.state.stats.crowdTimeouts === 0],
    ['deal-stampede', 9000, 'stale', (s) => s.state.stats.coalesced === 0 && s.state.stats.crowdTimeouts > 50],
    ['cache-down', 9000, 'stale', (s) => !!s.ui.shopper.error && s.state.stats.crowdTimeouts > 1000],
  ],
  'shop-search': [
    ['search', 9000, 'ok', (s) => s.ui.shopper.results.length === 5 && s.ui.shopper.results[0].id === 'echo'],
    ['filter', 9000, 'ok', (s) => s.ui.shopper.results.length === 3 && s.ui.shopper.results.every((h) => h.stock && h.price <= 100)],
    ['price', 9000, 'ok', (s) => hit(s, 'echo').price === 44.99],
    ['lag', 9000, 'stale', (s) => hit(s, 'echo').stock === true && !s.state.catalog.echo.stock],
    ['lag-live', 9000, 'ok', (s) => hit(s, 'echo').stock === false],
    ['reorder', 9000, 'ok', (s) => s.state.stats.dropped === 1 && indexed(s, 'echo').price === 44.99],
    ['reorder-bad', 9000, 'wrong', (s) => indexed(s, 'echo').price === 39.99 && s.state.catalog.echo.price === 44.99],
    ['shard-down', 9000, 'stale', (s) => s.ui.shopper.partial === 'Index shard B' && s.ui.shopper.results.length > 0],
    ['shard-down-bad', 9000, 'stale', (s) => !!s.ui.shopper.error && s.ui.shopper.results.length === 0],
    ['shard-slow', 9000, 'stale', (s) => s.ui.shopper.partial === 'Index shard B' && s.ui.shopper.took < 700],
    ['rank-down', 9000, 'ok', (s) => s.ui.shopper.fallback && s.ui.shopper.results.length === 5],
    ['rank-down-bad', 9000, 'stale', (s) => /ranking/.test(s.ui.shopper.error)],
    ['flood', 9000, 'ok', (s) => hit(s, 'echo').price === 44.99 && s.state.stats.bulkIndexed > 500],
    ['flood-bad', 9000, 'stale', (s) => hit(s, 'echo').price === 49.99 && s.state.changes[0].indexedAt > 3000],
  ],
  'shop-notifications': [
    ['order', 9000, 'ok', (s) => s.ui.phone.pushes.length === 4 && s.ui.phone.sms.length === 4 && s.ui.phone.inbox.length === 4],
    ['dup', 9000, 'ok', (s) => s.state.dupSkipped === 4 && s.ui.phone.pushes.length === 4],
    ['dup-bad', 9000, 'wrong', (s) => s.ui.phone.pushes.length === 8 && s.ui.phone.sms.length === 8],
    ['reorder', 9000, 'ok', (s) => s.state.stats.held === 1 && seqs(s.ui.phone.pushes) === '4321'],
    ['reorder-bad', 9000, 'wrong', (s) => seqs(s.ui.phone.pushes) === '4231'],
    ['email-down', 9000, 'ok', (s) => s.ui.phone.emails.length === 4 && s.state.stats.retries >= 2 && seqs(s.ui.phone.emails) === '4321'],
    ['push-down', 9000, 'stale', (s) => s.ui.phone.pushes.length === 0 && s.ui.phone.inbox.length === 4 && s.state.dead.length >= 1],
    ['poison', 9000, 'stale', (s) => s.state.dead.length === 1 && s.ui.phone.pushes.length === 3 && s.ui.phone.inbox.length === 4],
    ['poison-bad', 9000, 'stale', (s) => s.state.dead.length === 0 && s.ui.phone.inbox.length === 1 && s.queueStats('sends').depth > 0],
    ['optout', 9000, 'ok', (s) => s.ui.phone.sms.length === 1 && s.ui.phone.pushes.length === 4],
    ['optout-bad', 9000, 'wrong', (s) => s.ui.phone.sms.length === 4 && s.ui.phone.sms.filter((x) => x.optedOut).length === 3],
  ],
};
const hit = (s, id) => s.ui.shopper.results.find((h) => h.id === id);
const indexed = (s, id) => Object.values(s.state.shards).map((sh) => sh[id]).find(Boolean);
const seqs = (list) => list.map((x) => x.seq).join('');

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

test('amazon path: every page exists and the shared payments lab is mapped in', () => {
  const sys = SDL.SYSTEMS.find((x) => x.id === 'shop');
  for (const id of sys.path) assert.ok(SDL.page(id), `missing page ${id}`);
  assert.ok(sys.path.includes('rides-payments'));
  for (const p of SDL.PAGES.filter((x) => sys.groups.includes(x.group) && x.status === 'built' && !x.calc)) load(p.id);
});
module.exports = { EXPECT };
