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
