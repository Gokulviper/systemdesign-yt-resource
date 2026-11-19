// Home rentals (Airbnb) labs: every guided scenario must reach its documented end state.
// Each row: [preset, ms to run, expected consistency key, optional extra check].
const test = require('node:test');
const assert = require('node:assert/strict');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
require('../assets/js/scenarios/yt-common.js');
require('../assets/js/ui/registry.js');
const SDL = globalThis.SDL;
const load = (id) => { if (!SDL.scenarios[id]) require(`../assets/js/scenarios/${id}.js`); return SDL.scenarios[id]; };
const timeline = (s, re) => s.timeline.some((e) => re.test(e.op));
const bk = (s) => Object.values(s.state.cal);
const status = (s, id) => s.state.cal[id] && s.state.cal[id].status;
const cal = (s) => s.state.db[s.state.leader];
const liveIn = (s) => Object.values(cal(s).bookings).filter((b) => b.status === 'confirmed' || b.status === 'held');
const p99 = (a) => SDL.percentile(a.slice().sort((x, y) => x - y), 99);
const charges = (s, st) => Object.values(s.state.charges).filter((c) => !st || c.status === st);
const rb = (s) => Object.values(s.state.bookings);
const res = (s) => s.ui.maya.results.map((h) => h.id);
const ch = (s) => s.state.charges;
const errCode = (s, code) => s.timeline.some((e) => e.error && e.error.code === code);
const tx = (s) => s.state.bank.transfers;
const rv = (s, who, status) => Object.values(s.state.db.reviews).filter((r) => (!who || r.by === who) && (!status || r.status === status));

const EXPECT = {
  'bnb-book': [
    ['instant', 9000, 'ok', (s) => status(s, 'B1') === 'confirmed' && s.state.idx.cabin.length === 3 && s.state.threads.B1 && s.ui.lena.notes.length === 1 && !s.ui.dev.results.includes('cabin')],
    ['race', 9000, 'ok', (s) => bk(s).length === 1 && s.ui.dev.stage === 'failed' && s.state.stats.refused === 1 && Object.values(s.state.auths).length === 1],
    ['race-bad', 9000, 'wrong', (s) => bk(s).filter((b) => b.status === 'confirmed').length === 2 && Object.values(s.state.auths).filter((a) => a.status === 'captured').length === 2],
    ['index-lag', 9000, 'stale', (s) => s.ui.dev.results.includes('cabin') && s.ui.dev.stage === 'results' && /just booked/.test(s.ui.dev.message) && s.state.idx.cabin.length === 0],
    ['declined', 9000, 'ok', (s) => status(s, 'B1') === 'released' && s.ui.maya.stage === 'failed'],
    ['crash-hold', 9000, 'ok', (s) => status(s, 'B1') === 'released' && status(s, 'B2') === 'confirmed' && s.ui.maya.stage === 'confirmed'],
    ['dual-write-bus-down', 9000, 'wrong', (s) => status(s, 'B1') === 'confirmed' && s.state.lost.includes('B1') && s.ui.lena.notes.length === 0],
    ['outbox-bus-down', 9000, 'ok', (s) => status(s, 'B1') === 'confirmed' && s.ui.lena.notes.length === 1 && s.state.idx.cabin.length === 3],
    ['request-accepted', 9000, 'ok', (s) => status(s, 'B1') === 'confirmed' && Object.values(s.state.auths)[0].status === 'captured'],
    ['request-expires', 9000, 'ok', (s) => status(s, 'B1') === 'expired' && Object.values(s.state.auths)[0].status === 'voided' && s.state.idx.cabin.length === 0],
  ],
  'bnb-calendar': [
    ['overlap-unique', 9000, 'ok', (s) => liveIn(s).length === 1 && s.ui.dev.stage === 'failed' && s.state.stats.refused === 1],
    ['overlap-check-insert', 9000, 'wrong', (s) => liveIn(s).length === 2 && s.ui.maya.stage === 'booked' && s.ui.dev.stage === 'booked'],
    ['hot-lock', 9000, 'ok', (s) => s.state.rush.length === 30 && s.state.rush.every((r) => r.ok) && p99(s.state.rush.map((r) => r.ms)) > 800],
    ['hot-unique', 9000, 'ok', (s) => s.state.rush.length === 30 && s.state.rush.every((r) => r.ok) && p99(s.state.rush.map((r) => r.ms)) < 400],
    ['host-block', 9000, 'ok', (s) => liveIn(s).length === 1 && /Couldn’t block/.test(s.ui.lena.message)],
    ['expiry-paused', 9000, 'stale', (s) => s.ui.dev.stage === 'failed' && liveIn(s).length === 1 && liveIn(s)[0].status === 'held'],
    ['retry-no-key', 9000, 'stale', (s) => liveIn(s).length === 1 && s.ui.maya.stage === 'failed' && timeline(s, /reply for B1 lost/)],
    ['retry-key', 9000, 'ok', (s) => liveIn(s).length === 1 && s.ui.maya.stage === 'booked' && timeline(s, /same booking B1/)],
    ['failover-async', 9000, 'wrong', (s) => s.state.leader === 'replica' && s.state.lostInFailover.includes('B1') && s.ui.dev.stage === 'booked'],
    ['failover-sync', 9000, 'ok', (s) => s.state.leader === 'replica' && !s.state.lostInFailover.length && s.ui.dev.stage === 'failed'],
    ['utc-nights', 9000, 'wrong', (s) => liveIn(s).length === 2 && cal(s).rows.some((r) => r.k === 'T24')],
    ['replica-lag', 9000, 'stale', (s) => s.ui.dev.stage === 'failed' && s.ui.dev.view && s.ui.dev.view.taken[3] === false],
  ],
  'bnb-reserve': [
    ['instant', 9000, 'ok', (s) => rb(s)[0].status === 'confirmed' && charges(s, 'captured').length === 1 && s.ui.lena.notes.length === 1],
    ['lost-reply-blind', 9000, 'wrong', (s) => charges(s, 'captured').length === 2 && s.state.stats.blindRetries === 1],
    ['lost-reply-records', 9000, 'ok', (s) => charges(s, 'captured').length === 1 && s.state.stats.replays === 1],
    ['psp-timeout', 9000, 'ok', (s) => rb(s)[0].status === 'confirmed' && charges(s).length === 1 && s.state.stats.unknown === 1 && s.state.stats.recovered === 1],
    ['declined', 9000, 'ok', (s) => rb(s)[0].status === 'released' && charges(s).length === 0],
    ['crash-no-recovery', 9000, 'wrong', (s) => rb(s)[0].status === 'charging' && charges(s, 'captured').length === 1],
    ['crash-recovery', 9000, 'ok', (s) => rb(s)[0].status === 'confirmed' && charges(s, 'captured').length === 1 && s.state.stats.recovered === 1],
    ['request-expires', 9000, 'ok', (s) => rb(s)[0].status === 'expired' && charges(s, 'voided').length === 1],
    ['accept-race-blind', 9000, 'wrong', (s) => s.state.told.lena === 'accepted' && s.state.told.maya === 'expired'],
    ['accept-race-cas', 9000, 'ok', (s) => rb(s)[0].status === 'expired' && /Too late/.test(s.ui.lena.message) && charges(s, 'voided').length === 1],
    ['risk-open', 9000, 'wrong', (s) => rb(s).some((b) => b.who === 'fraud' && b.status === 'confirmed' && b.unchecked)],
    ['risk-closed', 9000, 'stale', (s) => rb(s).length === 0 && s.ui.maya.stage === 'failed' && s.ui.fraud.stage === 'failed'],
  ],
  'bnb-search': [
    ['search', 9000, 'ok', (s) => s.ui.maya.shown[0].length === 4 && s.ui.maya.shown[1].length === 4 && !s.ui.maya.shown[1].some((id) => s.ui.maya.shown[0].includes(id)) && s.ui.maya.from === 'cursor'],
    ['lag-index', 9000, 'stale', (s) => res(s).includes('cabin') && s.state.stats.removed === 0],
    ['lag-recheck', 9000, 'ok', (s) => !res(s).includes('cabin') && s.state.stats.removed === 1],
    ['reorder-bad', 9000, 'wrong', (s) => s.state.shards.shardA.cabin.nights[2] === 'blocked' && s.state.db.cabin.nights[2] === '' && !res(s).includes('cabin')],
    ['reorder', 9000, 'ok', (s) => s.state.stats.dropped === 1 && res(s).includes('cabin')],
    ['shard-wait', 9000, 'stale', (s) => !!s.ui.maya.error && res(s).length === 0],
    ['shard-partial', 9000, 'stale', (s) => !!s.ui.maya.partial && res(s).length === 4 && res(s).every((id) => s.state.db[id].shard === 'shardA')],
    ['rank-down', 9000, 'stale', (s) => s.ui.maya.fallback && s.ui.maya.results.every((h, i, a) => !i || a[i - 1].price <= h.price)],
    ['rush-cache', 9000, 'ok', (s) => s.state.stats.shardQueries.shardA === 1 && s.state.stats.shardQueries.shardB === 1 && s.state.flood.done === 250],
    ['rush-nocache', 9000, 'stale', (s) => s.state.stats.shardQueries.shardA > 200 && s.state.flood.done === 250],
    ['offset-paging', 9000, 'stale', (s) => s.ui.maya.shown[1].includes('heavenly') && s.ui.maya.shown[0].includes('heavenly') && ![].concat(s.ui.maya.shown[0], s.ui.maya.shown[1]).includes('pine')],
    ['boundary', 9000, 'ok', (s) => s.ui.maya.shards.length === 2 && s.state.stats.shardQueries.shardB === 1 && s.state.stats.shardQueries.shardA === 2],
  ],
  'bnb-pricing': [
    ['pay', 9000, 'ok', (s) => ch(s).length === 1 && ch(s)[0].charged === 152607 && ch(s)[0].cur === 'EUR'],
    ['raise-quote', 9000, 'ok', (s) => ch(s)[0].nightly[0] === 399 && s.state.prices.nightly[0] === 449],
    ['raise-reprice', 9000, 'wrong', (s) => ch(s)[0].nightly[0] === 449 && ch(s)[0].how === 'reprice'],
    ['expired', 9000, 'ok', (s) => s.state.requotes === 1 && ch(s).length === 1 && ch(s)[0].quoteId === 'Q2'],
    ['fx-unlocked', 9000, 'wrong', (s) => ch(s)[0].rate === 0.95 && ch(s)[0].charged > ch(s)[0].shown],
    ['fx-locked', 9000, 'ok', (s) => ch(s)[0].absorbed > 0 && ch(s)[0].charged === ch(s)[0].shown],
    ['fx-stale', 9000, 'stale', (s) => s.state.refused.includes('FX_STALE') && ch(s).length === 0],
    ['tax-closed', 9000, 'stale', (s) => s.state.refused.includes('TAX_DOWN') && ch(s).length === 0],
    ['tax-open', 9000, 'wrong', (s) => ch(s)[0].taxMissing && ch(s)[0].taxOwed === 13470],
    ['batch-bad', 9000, 'wrong', (s) => s.state.prices.nightly[0] === 1 && s.ui.maya.quote.nightly[0] === 1],
    ['batch-guard', 9000, 'ok', (s) => s.state.rejected.length === 1 && s.state.prices.nightly[0] === 399 && s.ui.maya.quote.nightly[0] === 399],
    ['index-lag', 9000, 'stale', (s) => !!s.ui.maya.flagged && s.state.index.from === 399 && s.ui.maya.quote.nightly[0] === 449],
    ['rounding', 9000, 'wrong', (s) => ch(s)[0].charged - ch(s)[0].linesSum === 1 && ch(s)[0].charged === ch(s)[0].shown],
  ],
  'bnb-channels': [
    ['omar-poll', 9000, 'ok', (s) => s.ui.maya.stage === 'failed' && s.state.imported.nights.includes(2)],
    ['both-window', 9000, 'wrong', (s) => s.state.cal.bookings[2] === 'maya' && s.state.sf.bookings[2] === 'omar'],
    ['fast-window', 9000, 'wrong', (s) => s.state.cal.bookings[2] === 'maya' && s.state.config.fastPoll],
    ['push-recheck', 9000, 'ok', (s) => s.ui.maya.stage === 'failed' && errCode(s, 'OTHER_SITE') && !s.state.cal.bookings[2]],
    ['empty-replace', 9000, 'wrong', (s) => s.state.erased.includes(2) && s.state.cal.bookings[2] === 'maya'],
    ['empty-keep', 9000, 'stale', (s) => s.state.imported.nights.includes(2) && s.ui.maya.stage === 'failed' && s.state.rejected.length > 0],
    ['truncated', 9000, 'stale', (s) => s.state.imported.nights.includes(2) && /END:VCALENDAR/.test(s.state.rejected[0])],
    ['hook-lost', 9000, 'ok', (s) => s.state.stats.lost === 1 && s.state.imported.nights.includes(2)],
    ['reorder-noseq', 9000, 'wrong', (s) => s.state.sfChanged.reorderFreed && s.state.cal.bookings[2] === 'maya'],
    ['reorder-seq', 9000, 'ok', (s) => s.state.stats.ignored === 1 && s.ui.maya.stage === 'failed'],
    ['importer-paused', 9000, 'stale', (s) => !s.state.imported.nights.includes(2) && s.now - s.state.lastSync > 6000],
  ],
  'bnb-payouts': [
    ['payout', 9000, 'ok', (s) => tx(s).length === 1 && s.state.payout.status === 'paid' && s.state.journal.some((e) => /^payout/.test(e.kind))],
    ['two-noclaim', 9000, 'wrong', (s) => tx(s).length === 2],
    ['two-claim', 9000, 'ok', (s) => tx(s).length === 1 && s.state.stats.claimsLost >= 1],
    ['crash-nokey', 9000, 'wrong', (s) => tx(s).length === 2 && s.state.payout.tries === 2],
    ['crash-key', 9000, 'ok', (s) => tx(s).length === 1 && s.state.stats.deduped === 1],
    ['bank-timeout', 9000, 'ok', (s) => s.state.stats.unknown === 1 && s.state.payout.status === 'paid' && !s.state.flags.length],
    ['bank-reject', 9000, 'stale', (s) => s.state.payout.status === 'held' && s.state.payout.reason === 'rejected' && !tx(s).length],
    ['cancel-separate', 9000, 'wrong', (s) => s.state.bank.refunds[0].amt === 49476 && tx(s)[0].amt === 130659 && s.state.receivable === 0],
    ['cancel-atomic', 9000, 'ok', (s) => s.state.receivable === 38703 && tx(s)[0].amt === 130659],
    ['partial', 9000, 'ok', (s) => tx(s)[0].amt === 53253 && s.state.bank.refunds[0].amt === 98952],
    ['takeover-nohold', 9000, 'wrong', (s) => tx(s).length === 1 && tx(s)[0].to !== 'Lena ·· 4021'],
    ['takeover-hold', 9000, 'ok', (s) => tx(s).length === 1 && tx(s)[0].to === 'Lena ·· 4021'],
    ['failover', 9000, 'stale', (s) => s.state.flags.length === 1 && s.state.payout.status === 'paid' && tx(s).length === 1],
  ],
  'bnb-reviews': [
    ['both', 9000, 'ok', (s) => rv(s, null, 'published').length === 2 && s.state.agg.count === 48],
    ['simul-rtw', 9000, 'stale', (s) => rv(s, null, 'hidden').length === 2 && s.state.raced >= 1],
    ['simul-atomic', 9000, 'ok', (s) => rv(s, null, 'published').length === 2],
    ['late-blind', 9000, 'wrong', (s) => s.state.broken && s.state.broken.who === 'lena'],
    ['late-cas', 9000, 'ok', (s) => !rv(s, 'lena').length && errCode(s, 'WINDOW_CLOSED') && rv(s, 'maya', 'published').length === 1],
    ['only-maya', 9000, 'ok', (s) => rv(s, 'maya', 'published').length === 1 && s.state.db.closed],
    ['sched-paused', 9000, 'stale', (s) => rv(s, 'maya', 'hidden').length === 1 && !s.state.db.closed],
    ['dup-nodedupe', 9000, 'wrong', (s) => s.state.agg.count === 49],
    ['dup-dedupe', 9000, 'ok', (s) => s.state.stats.dupSkipped === 1 && s.state.agg.count === 48],
    ['replica-lag', 9000, 'wrong', (s) => rv(s, 'maya').length === 2],
    ['moderation', 9000, 'ok', (s) => rv(s, 'maya', 'removed').length === 1 && s.state.agg.count === 47],
    ['agg-paused', 9000, 'stale', (s) => s.state.agg.count === 47 && rv(s, null, 'published').length === 2],
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
  test(`${id}: every guided scenario holds its end state from any start time`, () => {
    // Background loops tick on their own schedule: a story must not depend on where in a tick it starts.
    const sc = load(id);
    for (const [preset, ms, key] of rows) {
      for (const offset of [37, 131, 263, 419]) {
        const s = new SDL.Simulator(sc);
        s.runFor(offset);
        s.dispatch('preset', { id: preset });
        s.runFor(ms);
        assert.equal(sc.consistency(s).key, key, `${id}/${preset} at +${offset} ms: ${sc.consistency(s).label}`);
      }
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

test('home rentals path: every page exists and every built lab loads', () => {
  const sys = SDL.SYSTEMS.find((x) => x.id === 'bnb');
  for (const id of sys.path) assert.ok(SDL.page(id), `missing page ${id}`);
  assert.equal(sys.path.length, 14);
  for (const p of SDL.PAGES.filter((x) => sys.groups.includes(x.group) && x.status === 'built' && !x.calc)) load(p.id);
});
module.exports = { EXPECT };
