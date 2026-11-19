// Notification platform labs: every guided scenario must reach its documented end state.
// Each row: [preset, ms to run, expected consistency key, optional extra check].
const test = require('node:test');
const assert = require('node:assert/strict');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
require('../assets/js/scenarios/yt-common.js');
require('../assets/js/ui/registry.js');
const SDL = globalThis.SDL;
const load = (id) => { if (!SDL.scenarios[id]) require(`../assets/js/scenarios/${id}.js`); return SDL.scenarios[id]; };
const seen = (s) => s.ui.phone.pushes.length + (s.ui.phone.dismissed ? s.ui.phone.dismissed.length : 0);

const EXPECT = {
  'nt-send': [
    ['order', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.ui.phone.emails.length === 1 && s.ui.phone.inbox.length === 1],
    ['otp', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.ui.phone.sms.length === 1 && s.ui.phone.pushes[0].ms < 3000],
    ['promo', 9000, 'ok', (s) => s.ui.phone.pushes.length === 0 && s.ui.phone.emails.length === 1 && s.state.stats.suppressed === 1],
    ['apns-down', 9000, 'ok', (s) => s.state.dead.length === 1 && s.ui.phone.pushes.length === 0 && s.ui.phone.inbox.length === 1],
    ['apns-down-noinbox', 9000, 'stale', (s) => s.state.dead.length === 1 && s.ui.phone.inbox.length === 0 && s.ui.phone.emails.length === 1],
    ['workers-paused', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.ui.phone.pushes[0].ms > 4000],
    ['outbox-queue-down', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.state.stats.accepted === 1 && s.state.lost.length === 0],
    ['dual-write-loss', 9000, 'wrong', (s) => s.state.lost.length === 1 && s.state.stats.accepted === 1 && s.ui.phone.pushes.length === 0],
    ['crash-dup', 9000, 'wrong', (s) => s.ui.phone.pushes.length === 2],
    ['crash-dedupe', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.state.stats.dupSkipped === 1],
    ['registry-down', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.state.stats.retries > 0 && s.ui.phone.pushes[0].ms > 3000],
  ],
  'nt-delivery': [
    ['clean', 9000, 'ok', (s) => seen(s) === 1 && s.state.stats.providerCalls === 1],
    ['retry-no-key', 9000, 'wrong', (s) => s.state.stats.requests === 2 && seen(s) === 2],
    ['retry-key', 9000, 'ok', (s) => s.state.stats.requests === 1 && seen(s) === 1],
    ['crash-no-dedupe', 9000, 'wrong', (s) => s.state.stats.providerCalls === 2 && seen(s) === 2],
    ['crash-dedupe', 9000, 'ok', (s) => s.state.stats.providerCalls === 2 && s.state.stats.collapsed === 1 && seen(s) === 1],
    ['dropped-reply', 9000, 'ok', (s) => s.state.stats.providerCalls === 2 && s.state.stats.collapsed === 1 && seen(s) === 1],
    ['dedupe-down', 9000, 'ok', (s) => seen(s) === 1 && s.state.stats.providerCalls === 1 && s.ui.phone.dismissed[0].ms > 2000],
    ['late-dup', 9000, 'wrong', (s) => s.state.lateDups === 1 && seen(s) === 2 && s.state.stats.collapsed === 0],
    ['poison-dlq', 9000, 'ok', (s) => s.state.dead.length === 1 && seen(s) === 1],
    ['poison-blocks', 9000, 'stale', (s) => s.state.dead.length === 0 && seen(s) === 0 && s.state.stats.retries > 10],
    ['immediate-retries', 9000, 'stale', (s) => s.state.dead.length === 1 && seen(s) === 0],
    ['backoff', 9000, 'ok', (s) => s.state.dead.length === 0 && seen(s) === 1 && s.state.stats.retries === 3],
  ],
  'nt-tokens': [
    ['one-device', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1],
    ['two-devices', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.ui.tablet.pushes.length === 1],
    ['rotate-by-token', 9000, 'wrong', (s) => s.ui.phone.pushes.length === 2 && s.ui.phone.pushes[0].token !== s.ui.phone.pushes[1].token],
    ['rotate-by-device', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && Object.keys(s.state.rows).length === 1],
    ['uninstall-prune', 9000, 'ok', (s) => s.state.stats.pruned === 1 && s.state.stats.deadSends === 1 && s.ui.tablet.pushes.length === 3],
    ['uninstall-ignored', 5500, 'stale', (s) => s.state.stats.gone410 >= 7 && s.state.stats.pruned === 0 && s.state.rows['maya|phone']],
    ['uninstall-silent', 9000, 'stale', (s) => s.state.stats.deadSends === 4 && s.state.stats.gone410 === 0 && s.state.rows['maya|phone']],
    ['uninstall-sweep', 9000, 'ok', (s) => s.state.stats.swept === 1 && s.state.stats.deadSends === 2 && s.ui.tablet.pushes.length === 4],
    ['shared-no-unregister', 9000, 'wrong', (s) => s.state.leaks.length === 1 && s.ui.tablet.pushes[0].viewer === 'omar'],
    ['shared-unregister', 9000, 'ok', (s) => s.state.leaks.length === 0 && s.ui.phone.pushes.length === 1 && s.ui.tablet.pushes.length === 0],
    ['cache-stale', 9000, 'wrong', (s) => s.state.leaks.length === 1 && s.state.stats.hits >= 1],
    ['cache-invalidate', 9000, 'ok', (s) => s.state.leaks.length === 0 && s.ui.tablet.pushes.length === 1],
  ],
  'nt-priority': [
    ['otp-alone', 9000, 'ok', (s) => s.state.otps[0].ms < 500],
    ['otp-behind-flood', 9000, 'stale', (s) => s.state.otps[0].ms > 3000 && s.state.otps[0].lane === 'txn'],
    ['otp-with-lanes', 9000, 'ok', (s) => s.state.otps[0].ms < 500 && s.state.otps[0].lane === 'crit'],
    ['mistagged-otp', 9000, 'stale', (s) => s.state.otps[0].lane === 'mkt'],
    ['cap-off', 9000, 'stale', (s) => s.ui.phone.pushes.length === 6],
    ['cap-digest', 9000, 'ok', (s) => s.ui.phone.pushes.length === 3 && s.state.stats.digested === 4 && s.state.stats.digests === 1],
    ['limiter-down', 9000, 'stale', (s) => s.state.stats.failOpen === 6 && s.ui.phone.pushes.length === 6],
    ['quiet-defer', 9000, 'ok', (s) => s.state.deferred.length === 2 && s.ui.phone.pushes.length === 0],
    ['quiet-critical', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.ui.phone.pushes[0].at === 'night' && s.ui.phone.pushes[0].cls === 'critical'],
    ['wrong-tz', 9000, 'stale', (s) => s.ui.phone.pushes.length === 2 && s.state.deferred.length === 0],
    ['shed-under-load', 9000, 'ok', (s) => s.state.stats.shed > 0 && s.state.otps[0].ms < 1000],
  ],
  'nt-providers': [
    ['steady', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.ui.phone.sms.length === 1 && s.state.stats.timeouts === 0],
    ['apns-down-no-breaker', 9000, 'stale', (s) => s.state.stats.timeouts > 20 && s.state.stats.fastFails === 0 && s.ui.phone.inbox.length === 0],
    ['apns-down-breaker', 9000, 'ok', (s) => s.ui.phone.inbox.length === 1 && s.ui.phone.sms.length === 1 && s.state.stats.fastFails > 0],
    ['apns-slow-shared', 9000, 'stale', (s) => s.state.stats.timeouts === 0 && (s.ui.phone.sms.length === 0 || s.ui.phone.sms[0].ms > 3000)],
    ['apns-slow-isolated', 9000, 'ok', (s) => s.ui.phone.sms.length === 1 && s.ui.phone.sms[0].ms < 1000],
    ['fcm-429-no-bucket', 9000, 'stale', (s) => s.state.stats.burstDead > 0],
    ['fcm-429-bucket', 9000, 'ok', (s) => s.state.stats.burstDead === 0 && s.state.stats.burstDone === 120],
    ['smsA-down-no-fallback', 9000, 'stale', (s) => s.ui.phone.sms.length === 0],
    ['smsA-down-fallback', 9000, 'ok', (s) => s.ui.phone.sms.length === 1 && s.ui.phone.sms[0].provider === 'smsB' && s.state.cost > 0],
    ['async-failure', 9000, 'stale', (s) => s.ui.phone.sms.length === 1 && s.ui.phone.sms[0].provider === 'smsB' && s.ui.phone.sms[0].ms > 3000],
    ['receipts-out-of-order', 9000, 'wrong', (s) => s.ui.phone.sms.length === 2],
    ['receipts-state-machine', 9000, 'ok', (s) => s.ui.phone.sms.length === 1 && s.state.stats.ignored >= 1],
  ],
  'nt-campaign': [
    ['paced', 12000, 'ok', (s) => s.state.stats.sent === 1200 && s.state.stats.dups === 0 && s.state.stats.openFails === 0],
    ['unpaced-herd', 9000, 'stale', (s) => s.state.stats.openFails > 0 && s.state.stats.sent === 1200],
    ['crash-no-checkpoint', 12000, 'wrong', (s) => s.state.stats.dups > 0 && s.state.sentTo.maya === 2],
    ['crash-checkpoint', 9000, 'ok', (s) => s.state.stats.crashes === 1 && s.state.stats.dups === 0],
    ['optout-at-fanout', 9000, 'wrong', (s) => s.ui.phone.pushes.length === 1 && s.ui.phone.pushes[0].optedOut],
    ['optout-at-send', 9000, 'ok', (s) => s.ui.phone.pushes.length === 0 && s.state.stats.suppressed === 1],
    ['cancel-drains', 9000, 'ok', (s) => s.state.stats.dropped > 0 && s.state.stats.afterCancel === 0],
    ['cancel-ignores-queue', 9000, 'wrong', (s) => s.state.stats.afterCancel > 0],
    ['dup-rows', 9000, 'ok', (s) => s.state.stats.dupRowsSkipped > 0 && s.state.stats.dups === 0],
    ['checkpoints-down', 9000, 'ok', (s) => s.state.stats.commitFails > 0 && s.state.stats.dups === 0],
  ],
  'nt-schedule': [
    ['two-zones', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.ui.omar.pushes.length === 1 && s.ui.phone.pushes[0].local.startsWith('09') && s.ui.omar.pushes[0].local.startsWith('09')],
    ['leader-crash', 9000, 'ok', (s) => s.state.lease.holder === 'schedB' && s.ui.phone.pushes.length === 1 && s.ui.omar.pushes.length === 1],
    ['split-brain-no-fence', 9000, 'wrong', (s) => s.ui.phone.pushes.length === 2 && s.state.stats.fenced === 0],
    ['split-brain-fenced', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.state.stats.fenced === 1],
    ['late-send', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.state.scheds[0].shownAt - s.state.scheds[0].at > 1000],
    ['late-skip', 9000, 'ok', (s) => s.ui.phone.pushes.length === 0 && s.state.stats.skipped === 1],
    ['no-ttl-stale-push', 9000, 'wrong', (s) => s.ui.phone.pushes.length === 1 && s.ui.phone.pushes[0].expired],
    ['ttl-drops', 9000, 'ok', (s) => s.ui.phone.pushes.length === 0 && s.state.stats.expired === 1],
    ['no-collapse', 9000, 'stale', (s) => s.ui.phone.pushes.length === 2],
    ['collapse', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.state.stats.replaced === 1],
  ],
  'nt-inbox': [
    ['socket-and-push', 9000, 'ok', (s) => s.state.stats.socket === 1 && s.state.stats.push === 1 && s.ui.phone.badge === 1 && s.ui.tablet.badge === 1],
    ['socket-drop', 9000, 'ok', (s) => s.state.stats.socket === 0 && s.state.stats.push === 2 && s.ui.phone.badge === 1],
    ['offline-catchup', 9000, 'ok', (s) => s.ui.tablet.badge === 3 && s.state.stats.catchUps >= 1],
    ['read-no-sync', 9000, 'stale', (s) => s.ui.phone.badge === 2 && s.ui.tablet.badge === 0],
    ['read-sync', 9000, 'ok', (s) => s.ui.phone.badge === 0 && s.state.stats.syncs === 2],
    ['counter-drift', 9000, 'wrong', (s) => s.state.counter === 3 && s.state.stats.lostDecr === 3 && s.ui.phone.badge === 3],
    ['derived-count', 9000, 'ok', (s) => s.ui.phone.badge === 0 && s.ui.tablet.badge === 0],
    ['lost-read', 9000, 'stale', (s) => s.ui.tablet.badge === 0 && s.ui.phone.badge === 1],
    ['offset-skips', 9000, 'wrong', (s) => s.ui.phone.view.ids.length === 4],
    ['cursor', 9000, 'ok', (s) => s.ui.phone.view.ids.length === 6],
  ],
  'nt-prefs': [
    ['toggle-off', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.ui.phone.pushes[0].cat === 'orders'],
    ['optout-cache-stale', 9000, 'wrong', (s) => s.ui.phone.pushes.length === 2 && s.state.stats.hits > 0],
    ['invalidate-on-write', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1],
    ['check-at-enqueue-only', 9000, 'wrong', (s) => s.ui.phone.pushes.length === 1],
    ['unsubscribe-twice', 9000, 'ok', (s) => s.ui.email.inbox.length === 1 && s.state.db.maya.marketing.email === false],
    ['prefsdb-down', 9000, 'stale', (s) => s.ui.phone.pushes.length === 1 && s.ui.phone.pushes[0].cat === 'orders'],
    ['delete-purges', 9000, 'ok', (s) => s.ui.phone.pushes.length === 0 && s.state.stats.purged === 2 && !s.state.db.maya],
    ['delete-leaves-queue', 9000, 'wrong', (s) => s.ui.phone.pushes.length === 2 && s.ui.phone.pushes.every((n) => n.afterDelete)],
    ['critical-ignores-optout', 9000, 'ok', (s) => s.ui.phone.pushes.length === 1 && s.ui.phone.pushes[0].cat === 'security'],
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

test('notification platform path: every page exists and every built lab loads', () => {
  const sys = SDL.SYSTEMS.find((x) => x.id === 'nt');
  for (const id of sys.path) assert.ok(SDL.page(id), `missing page ${id}`);
  assert.equal(sys.path.length, 12);
  for (const p of SDL.PAGES.filter((x) => sys.groups.includes(x.group) && x.status === 'built' && !x.calc)) load(p.id);
});
module.exports = { EXPECT };
