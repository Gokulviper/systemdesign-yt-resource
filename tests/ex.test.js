// Stock exchange (Nasdaq) labs: every guided scenario must reach its documented end state.
// Each row: [preset, ms to run, expected consistency key, optional extra check].
const test = require('node:test');
const assert = require('node:assert/strict');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
require('../assets/js/scenarios/yt-common.js');
require('../assets/js/ui/registry.js');
const SDL = globalThis.SDL;
const load = (id) => { if (!SDL.scenarios[id]) require(`../assets/js/scenarios/${id}.js`); return SDL.scenarios[id]; };
const pos = (s, who) => s.state.clearing.positions[who];

const EXPECT = {
  'ex-trade': [
    ['market-buy', 9000, 'ok', (s) => s.state.trades.length === 1 && s.state.trades[0].px === 5010 && pos(s, 'maya').acme === 100 && pos(s, 'dev').acme === 0 && s.ui.maya.orders[0].status === 'filled' && s.ui.dev.orders[0].status === 'filled'],
    ['rest-fill', 9000, 'ok', (s) => s.state.trades.length === 1 && s.state.trades[0].buyer === 'quill' && s.ui.dev.orders[0].status === 'filled' && s.state.stats.reports === 1],
    ['partial', 9000, 'ok', (s) => s.state.trades.length === 2 && s.ui.maya.orders[0].filled === 150 && s.ui.maya.orders[0].avgPx === 5013],
    ['cancel-race', 9000, 'ok', (s) => s.state.trades.length === 1 && s.ui.dev.orders[0].status === 'filled' && s.timeline.some((e) => e.error && e.error.code === 'TOO_LATE')],
    ['retry', 9000, 'ok', (s) => s.retries > 0 && Object.keys(s.state.broker.orders).length === 2 && pos(s, 'maya').acme === 100],
    ['retry-bad', 9000, 'wrong', (s) => s.state.stats.dupOrders === 1 && pos(s, 'maya').acme === 200],
    ['md-down', 9000, 'stale', (s) => s.state.trades.length === 1 && s.ui.price.last == null && s.ui.dev.orders[0].status === 'filled'],
    ['push-lost', 9000, 'ok', (s) => s.state.stats.pushesLost > 0 && s.ui.dev.orders[0].status === 'filled'],
    ['push-lost-bad', 9000, 'stale', (s) => s.state.stats.pushesLost > 0 && s.ui.dev.orders[0].status === 'resting' && s.state.broker.orders.B1.status === 'filled'],
    ['ack-first-crash', 9000, 'wrong', (s) => s.state.stats.journalLost === 1 && s.state.stats.lostOrders === 1 && s.state.trades[0].seller === 'quill'],
    ['journal-first-crash', 9000, 'ok', (s) => s.state.stats.rebuilds === 1 && s.state.stats.lostOrders === 0 && s.state.trades[0].seller === 'dev'],
    ['seq-down', 9000, 'stale', (s) => s.state.trades.length === 0 && /unavailable/i.test(s.ui.maya.error)],
    ['clearing-lag', 9000, 'ok', (s) => s.state.stats.clearingRetries > 0 && pos(s, 'maya').acme === 100],
  ],
  'ex-matching': [
    ['rest', 9000, 'ok', (s) => s.ui.trader.orders[0].status === 'resting' && SDL.yt.book.best(s.state.book).bid === 5000],
    ['walk', 9000, 'ok', (s) => s.ui.trader.orders[0].filled === 500 && s.ui.trader.orders[0].status === 'partial' && Object.values(s.state.orders).find((o) => o.owner === 'trader').swept === 2 && SDL.yt.book.best(s.state.book).bid === 5035],
    ['market', 9000, 'ok', (s) => s.ui.trader.orders[0].filled === 1000 && s.ui.trader.orders[0].status === 'partial' && s.state.book.asks.length === 0],
    ['fok', 9000, 'ok', (s) => s.ui.trader.orders[0].status === 'cancelled' && s.state.stats.fills === 0],
    ['ioc', 9000, 'ok', (s) => s.ui.trader.orders[0].filled === 300 && s.ui.trader.orders[0].status === 'partial' && !Object.values(s.state.orders).some((o) => o.owner === 'trader' && s.state.book.byId[o.id])],
    ['priority', 9000, 'ok', (s) => s.ui.trader.orders[0].filled === 50 && Object.values(s.state.orders).filter((o) => o.owner === 'quill' && o.px === 5020 && o.side === 'sell').pop().status === 'filled'],
    ['prorata', 9000, 'ok', (s) => s.ui.trader.orders[0].filled === 87 && Object.values(s.state.orders).filter((o) => o.owner === 'quill' && o.px === 5020 && o.side === 'sell').pop().filled === 263],
    ['stp', 9000, 'ok', (s) => s.state.stats.stpCancels === 1 && s.state.stats.fills === 0 && SDL.yt.book.best(s.state.book).bid === 5020 && SDL.yt.book.best(s.state.book).ask === 5030],
    ['stp-off', 9000, 'wrong', (s) => s.state.stats.selfTrades === 1 && s.ui.trader.tape[0].self],
    ['float', 9000, 'wrong', (s) => s.state.stats.priorityViolations === 1 && Math.round(SDL.yt.book.best(s.state.book).bid) === Math.round(SDL.yt.book.best(s.state.book).ask)],
    ['sweep', 9000, 'ok', (s) => s.ui.trader.orders[0].filled === 300 && s.state.stats.collarStops === 1 && s.state.stats.outsideCollar === 0],
    ['sweep-bad', 9000, 'stale', (s) => s.ui.trader.orders[0].filled === 400 && s.state.stats.outsideCollar === 1 && s.state.last === 6000],
    ['flood', 9000, 'stale', (s) => s.ui.trader.orders[0].status === 'unknown' && Object.values(s.state.orders).some((o) => o.owner === 'trader' && o.status === 'resting') && s.state.stats.floodDone + s.state.stats.floodTimeouts > 3000 && s.queueWait('engine') > 1000],
    ['crash', 9000, 'ok', (s) => s.state.stats.rebuilds === 1 && Object.values(s.state.orders).some((o) => o.owner === 'trader' && s.state.book.byId[o.id]) && s.ui.trader.book.seq === s.state.seq],
  ],
  'ex-sequencer': [
    ['steady', 9000, 'ok', (s) => s.state.cores.primary.seq === 21 && s.state.cores.standby.seq === 21 && s.state.stats.failovers === 0],
    ['crash-hot', 9000, 'ok', (s) => s.state.stats.failovers === 1 && s.state.stats.promotionMs < 300 && s.ui.me.orders.length === 2 && s.ui.me.orders[1].core === 'standby' && s.ui.me.orders[1].seq === 22 && s.state.cores.primary.role === 'standby'],
    ['crash-cold', 9000, 'stale', (s) => s.state.stats.promotionMs > 2000 && s.state.stats.replayed === 60 && s.ui.me.orders.length === 0 && /unavailable/i.test(s.ui.me.error)],
    ['crash-snapshot', 9000, 'ok', (s) => s.state.stats.promotionMs < 300 && s.state.stats.fromSnapshot === 60 && s.ui.me.orders[0].core === 'standby'],
    ['ack-first-crash', 9000, 'wrong', (s) => s.state.stats.journalLost >= 1 && s.ui.me.orders[0].seq === 21 && !s.state.cores.standby.orders['me-1']],
    ['journal-first-crash', 9000, 'ok', (s) => s.state.stats.failovers === 1 && !!s.state.cores.standby.orders['me-1']],
    ['dup', 9000, 'ok', (s) => s.state.stats.dupSkipped === 21 && s.state.stats.dupApplied === 0],
    ['dup-bad', 9000, 'wrong', (s) => s.state.stats.dupApplied === 21],
    ['partition', 9000, 'ok', (s) => s.state.stats.fenced >= 1 && s.state.stats.conflicts === 0 && s.ui.me.orders[0].core === 'standby' && s.state.stats.failovers === 1],
    ['partition-bad', 9000, 'wrong', (s) => s.state.stats.conflicts >= 1 && s.ui.me.orders[0].core === 'primary' && s.ui.me.orders[0].epoch === 1],
    ['lag', 9000, 'stale', (s) => s.state.cores.standby.seq === 0 && s.state.cores.primary.seq === 21],
  ],
  'ex-marketdata': [
    ['normal', 9000, 'ok', (s) => Object.values(s.state.consumers).every((c) => c.seq === s.state.truth.seq) && s.state.consumers.retail.lag > s.state.consumers.quill.lag && s.state.stats.lost.A === 0],
    ['loss-a', 9000, 'ok', (s) => s.state.stats.lost.A > 100 && s.state.stats.arbFilled > 50 && s.state.stats.snapshots === 0],
    ['loss-both', 9000, 'ok', (s) => s.state.stats.lost.B > 20 && s.state.stats.retransmits > 50 && s.state.stats.snapshots === 0],
    ['loss-snapshot', 9000, 'ok', (s) => s.state.stats.snapshots > 30 && s.state.stats.retransmits === 0],
    ['nocheck', 9000, 'wrong', (s) => Object.values(s.state.consumers).every((c) => c.unchecked > 0)],
    ['reorder', 9000, 'ok', (s) => s.state.stats.arbFilled > 100 && s.state.stats.retransmits === 0 && s.state.stats.lost.A === 0],
    ['reorder-bad', 9000, 'wrong', (s) => s.state.consumers.quill.unchecked > 0 && s.state.stats.lost.A === 0],
    ['slow-broker', 9000, 'stale', (s) => s.state.truth.seq - s.state.consumers.finch.seq > 300 && s.ui.maya.seq < 400 && s.state.consumers.quill.seq === s.state.truth.seq],
    ['slow-broker-conflate', 9000, 'ok', (s) => s.state.stats.conflated > 1000 && s.ui.maya.seq === s.state.truth.seq],
    ['pub-down', 9000, 'stale', (s) => s.state.stats.unpublished > 50 && s.state.consumers.quill.seq + s.state.stats.unpublished === s.state.truth.seq],
    ['restart', 9000, 'ok', (s) => s.state.stats.snapshots === 1 && s.state.consumers.retail.seq === s.state.truth.seq],
  ],
  'ex-risk': [
    ['normal', 9000, 'ok', (s) => s.state.accounts.maya.cash === 1998000 && s.state.accounts.maya.shares === 100 && s.state.accounts.maya.reserved === 0],
    ['fat-finger', 9000, 'ok', (s) => s.state.stats.rejected.risk === 1 && s.state.stats.fills === 0 && /99%/.test(s.ui.quill.orders[0].reason)],
    ['fat-finger-bad', 9000, 'wrong', (s) => s.state.stats.erroneous === 1 && s.ui.quill.orders[0].fillPx === 50],
    ['reserve', 9000, 'ok', (s) => s.state.stats.fills === 1 && s.state.stats.rejected.risk === 1 && s.state.accounts.maya.cash === 994000],
    ['reserve-bad', 9000, 'wrong', (s) => s.state.stats.fills === 2 && s.state.accounts.maya.cash === -512000],
    ['risk-down-closed', 9000, 'stale', (s) => s.state.stats.rejected.riskDown === 2 && s.state.stats.fills === 0],
    ['risk-down-open', 9000, 'wrong', (s) => s.state.stats.unchecked === 2 && s.state.accounts.maya.cash === -512000],
    ['runaway', 9000, 'ok', (s) => s.state.stats.rejected.rate > 15000 && s.state.accounts.maya.shares === 100 && s.state.stats.timeouts === 0],
    ['runaway-bad', 9000, 'stale', (s) => s.state.stats.rejected.rate === 0 && s.state.stats.timeouts > 5000 && s.ui.maya.orders[0].status === 'rejected'],
    ['kill', 9000, 'ok', (s) => s.state.stats.killed === 1 && s.state.stats.rejected.session > 5000 && s.state.sessions.quill === 'disabled' && s.state.accounts.maya.shares === 100],
    ['retry', 9000, 'ok', (s) => s.state.stats.dupes === 1 && s.state.stats.fills === 1 && s.retries > 0],
  ],
  'ex-halt': [
    ['normal', 9000, 'ok', (s) => s.state.prints.length === 1 && s.state.prints[0].px === 5020 && s.state.stats.halts === 0],
    ['panic', 9000, 'ok', (s) => s.state.stats.halts === 1 && s.state.stats.auctions === 1 && s.state.stats.auctionVolume === 200 && s.state.lastUncross.px === 4700 && s.ui.maya.orders[0].status === 'filled' && s.state.phase === 'open'],
    ['panic-noluld', 9000, 'wrong', (s) => s.state.stats.halts === 0 && s.state.stats.outsideBand === 2 && s.state.prints.some((p) => p.px === 4700)],
    ['halt-reject', 9000, 'ok', (s) => s.state.stats.halts === 1 && s.state.stats.rejectedHalted === 1 && s.ui.maya.orders[0].status === 'rejected'],
    ['reopen-noauction', 9000, 'stale', (s) => s.state.stats.reopensWithoutAuction === 1 && s.state.stats.auctions === 0 && s.state.stats.reopenGap < -1.5 && s.ui.maya.orders[0].status === 'filled'],
    ['rally', 9000, 'ok', (s) => s.state.stats.halts === 0 && s.state.prints[s.state.prints.length - 1].px === 5300],
    ['rally-stale', 9000, 'wrong', (s) => s.state.stats.wrongHalts === 1 && s.state.cachedRef === 5000],
    ['bands-down', 9000, 'stale', (s) => s.state.stats.bandsFrozen === 1 && s.state.prints.length === 1],
    ['opening', 9000, 'ok', (s) => s.state.stats.auctions === 1 && s.state.lastUncross.px === 4990 && s.state.lastUncross.vol === 400 && s.ui.maya.orders[0].status === 'filled'],
  ],
  'ex-settle': [
    ['normal', 9000, 'ok', (s) => s.state.clearing.booked.T1 === 1 && s.state.clearing.positions.maya.acme === 100 && s.state.clearing.settled.T1 === 1 && s.state.stats.instructions === 2 && s.state.recon.breaks.length === 0 && s.state.csd['S1-maya'].acme === 100 && s.state.csd['S1-maya'].cash === -502000],
    ['redeliver', 9000, 'ok', (s) => s.state.stats.captureCrashes === 1 && s.state.stats.dupSkipped === 1 && s.state.clearing.booked.T1 === 1 && s.state.clearing.positions.maya.acme === 100],
    ['redeliver-bad', 9000, 'wrong', (s) => s.state.stats.captureCrashes === 1 && s.state.clearing.booked.T1 === 2 && s.state.clearing.positions.maya.acme === 200 && s.ui.maya.acme === 100 && s.state.recon.breaks.some((b) => b.kind === 'double')],
    ['dual-write', 9000, 'wrong', (s) => s.state.stats.lostPublish === 1 && !s.state.clearing.booked.T1 && s.ui.maya.acme === 100 && s.state.recon.breaks.some((b) => b.kind === 'missing')],
    ['dual-write-repair', 9000, 'ok', (s) => s.state.stats.lostPublish === 1 && s.state.stats.repaired === 1 && s.state.clearing.booked.T1 === 1 && s.state.clearing.positions.maya.acme === 100],
    ['outbox', 9000, 'ok', (s) => s.state.stats.relayRetries > 0 && s.state.stats.lostPublish === 0 && s.state.clearing.booked.T1 === 1],
    ['dup', 9000, 'ok', (s) => s.state.stats.dupSkipped >= 1 && s.state.clearing.booked.T1 === 1 && s.state.clearing.positions.maya.acme === 100],
    ['clearing-down', 9000, 'ok', (s) => s.state.stats.bookRetries > 3 && s.state.clearing.booked.T1 === 1 && s.state.clearing.positions.maya.acme === 100],
    ['dropcopy-down', 9000, 'stale', (s) => s.state.clearing.booked.T1 === 1 && s.state.dropcopy.length === 0 && (!s.state.recon || s.state.recon.error)],
    ['netting', 9000, 'ok', (s) => s.state.stats.instructions === 2 && s.state.csd['S1-maya'].acme === 200 && s.state.csd['S1-maya'].cash === -1006000 && s.state.clearing.positions.maya.acme === 200 && s.state.clearing.positions.maya.cash === 1494000],
    ['gross', 9000, 'ok', (s) => s.state.stats.instructions === 6 && s.state.clearing.positions.maya.acme === 200 && s.state.clearing.positions.maya.cash === 1494000],
    ['burst', 9000, 'stale', (s) => s.state.journal.length === 901 && s.queueStats('trades').depth > 300 && s.ui.maya.orders[0].status === 'filled' && !s.state.clearing.booked[s.ui.maya.orders[0].tradeId]],
    ['burst-batch', 9000, 'ok', (s) => s.state.journal.length === 901 && s.state.stats.batches > 5 && Object.keys(s.state.clearing.booked).length === 901 && s.state.clearing.booked[s.ui.maya.orders[0].tradeId] === 1 && s.state.stats.doubleBooked === 0],
  ],
  'ex-hotsymbol': [
    ['normal', 9000, 'ok', (s) => s.ui.maya.orders[0].status === 'filled' && s.ui.maya.orders[0].ms < 150 && s.state.stats.timeouts === 0 && s.state.map.MEME === 'p1'],
    ['flood', 9000, 'stale', (s) => s.ui.maya.orders[0].code === 'TIMEOUT' && s.ui.maya.orders[0].symbol === 'ACME' && s.state.stats.timeouts > 1000 && s.state.map.MEME === 'p1'],
    ['flood-isolate', 9000, 'stale', (s) => s.ui.maya.orders[0].status === 'filled' && s.ui.maya.orders[0].ms < 150 && s.state.map.MEME === 'p5' && s.state.stats.moves === 1 && s.state.stats.priorityViolations === 0 && s.queueWait('p5') > 300 && s.queueWait('p1') < 100],
    ['flood-shed', 9000, 'ok', (s) => s.ui.maya.orders[0].status === 'filled' && s.ui.maya.orders[1].code === 'BUSY' && s.ui.maya.orders[1].ms < 200 && s.state.stats.shed > 1000 && s.state.stats.timeouts < 500],
    ['flood-fair', 9000, 'ok', (s) => s.ui.maya.orders[0].status === 'filled' && s.ui.maya.orders[1].status === 'filled' && s.ui.maya.orders[1].symbol === 'MEME' && s.state.stats.fairRefused > 1000 && s.state.stats.timeouts === 0],
    ['flood-auto', 9000, 'ok', (s) => s.state.stats.autoMoves === 1 && s.state.map.MEME === 'p5' && s.ui.maya.orders[0].status === 'filled' && s.ui.maya.orders[0].ms < 150 && s.ui.maya.orders[1].status === 'filled' && s.state.stats.priorityViolations === 0],
    ['move-drain', 9000, 'ok', (s) => s.state.stats.moves === 1 && s.state.stats.priorityViolations === 0 && s.state.stats.resubmitted === 0 && s.ui.maya.orders[0].partition === 'p5' && !s.state.books.p1.MEME && s.state.books.p5.MEME],
    ['move-nodrain', 9000, 'wrong', (s) => s.state.stats.priorityViolations > 100 && s.state.stats.resubmitted > 100 && s.state.stats.notOwner > 100 && s.ui.maya.orders[0].status === 'filled'],
    ['stale-map', 9000, 'stale', (s) => s.ui.maya.orders[0].code === 'WRONG_PARTITION' && s.state.map.MEME === 'p5' && s.state.routerMap.MEME === 'p5' && s.state.stats.notOwner > 0],
    ['p1-down', 9000, 'stale', (s) => s.ui.maya.orders[0].code === 'UNAVAILABLE' && s.state.stats.fills > 1000],
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

test('order book helper: price-time priority, pro-rata, FOK, and self-trade prevention', () => {
  const B = SDL.yt.book;
  const b = B.create();
  B.rest(b, { id: 'a', owner: 'x', side: 'sell', px: 100, qty: 60, remaining: 60, tif: 'gtc' });
  B.rest(b, { id: 'b', owner: 'y', side: 'sell', px: 100, qty: 40, remaining: 40, tif: 'gtc' });
  B.rest(b, { id: 'c', owner: 'y', side: 'sell', px: 99, qty: 10, remaining: 10, tif: 'gtc' });
  assert.equal(B.best(b).ask, 99, 'best ask is the lowest price regardless of arrival');
  const r = B.match(b, { id: 't', owner: 'z', side: 'buy', px: 100, qty: 50, tif: 'gtc' }, {});
  assert.deepEqual(r.fills.map((f) => [f.makerId, f.qty]), [['c', 10], ['a', 40]], 'price first, then time');
  assert.equal(B.match(b, { id: 'f', owner: 'z', side: 'buy', px: 100, qty: 500, tif: 'fok' }).status, 'cancelled');
  const p = B.match(b, { id: 'p', owner: 'z', side: 'buy', px: 100, qty: 30, tif: 'gtc' }, { prorata: true });
  assert.deepEqual(p.fills.map((f) => [f.makerId, f.qty]), [['a', 10], ['b', 20]], 'pro-rata splits by resting size');
  const s = B.match(b, { id: 's', owner: 'y', side: 'buy', px: 100, qty: 5, tif: 'gtc' }, { stp: true });
  assert.ok(s.stp.includes('b') && s.fills.length === 1 && s.fills[0].makerId === 'a', 'self-trade prevention cancels the resting own order');
});

test('exchange path: every page exists and the shared labs are mapped in', () => {
  const sys = SDL.SYSTEMS.find((x) => x.id === 'ex');
  for (const id of sys.path) assert.ok(SDL.page(id), `missing page ${id}`);
  for (const shared of ['rides-payments', 'auth']) assert.ok(sys.path.includes(shared), `${shared} mapped`);
  for (const p of SDL.PAGES.filter((x) => sys.groups.includes(x.group) && x.status === 'built' && !x.calc)) load(p.id);
});
module.exports = { EXPECT };
