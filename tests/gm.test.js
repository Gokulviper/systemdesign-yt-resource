// Email (Gmail) labs: every guided scenario must reach its documented end state.
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
const devCopies = (s) => Object.values(s.state.boxes.dev).length;
const omarGot = (s) => s.ui.omar.box.length;
const inMaya = (s) => s.state.box.maya.filter((m) => m.subject === 'Contract draft').length;
const mb = (s) => Object.values(s.state.blobs).filter((b) => !b.deleted).reduce((n, b) => n + b.size, 0);
const omarBox = (s) => s.state.dest.omar.box.filter((m) => !m.spam);

const EXPECT = {
  'gm-send': [
    ['happy-path', 9000, 'ok', (s) => devCopies(s) === 1 && omarGot(s) === 1 && s.ui.dev.order.length === 1 && Object.values(s.state.boxes.maya).length === 1 && Object.values(s.state.boxes.maya)[0].thread === 's1' && s.ui.maya.order.length === 1 && s.ui.dev.results.length === 1],
    ['lost-reply-no-key', 9000, 'wrong', (s) => devCopies(s) === 2 && Object.keys(s.state.sent).length === 2 && timeline(s, /reply for s1 lost/)],
    ['lost-reply-with-key', 9000, 'ok', (s) => devCopies(s) === 1 && Object.keys(s.state.sent).length === 1 && timeline(s, /same message/)],
    ['dual-write-queue-down', 9000, 'wrong', (s) => s.state.local[0].state === 'sent' && omarGot(s) === 0 && s.state.stats.queueFails === 1 && !s.state.sent.s1.queued],
    ['outbox-queue-down', 9000, 'ok', (s) => omarGot(s) === 1 && s.state.stats.queueFails === 0],
    ['omar-server-down', 9000, 'stale', (s) => omarGot(s) === 1 && s.state.stats.deferred >= 2],
    ['push-lost', 9000, 'stale', (s) => devCopies(s) === 1 && s.ui.dev.order.length === 0 && timeline(s, /hint for Dev lost/)],
    ['dev-offline', 9000, 'ok', (s) => devCopies(s) === 1 && s.ui.dev.order.length === 1 && s.ui.dev.cursor === 1],
    ['spam-filter-down', 9000, 'stale', (s) => Object.values(s.state.boxes.maya).length === 1 && s.state.deliveries.find((d) => d.kind === 'inbound').latency > 2500],
    ['store-down-at-send', 9000, 'ok', (s) => devCopies(s) === 1 && s.state.local[0].tries >= 2 && s.ui.dev.order.length === 1],
    ['index-backlog', 9000, 'stale', (s) => s.ui.dev.order.length === 1 && s.ui.dev.results.length === 0],
  ],
  'gm-inbound': [
    ['normal', 9000, 'ok', (s) => inMaya(s) === 1 && s.state.box.maya.length === 2 && s.state.stats.deferredLegit === 0],
    ['memory-250-crash', 9000, 'wrong', (s) => s.state.msgs['omar-1'].got250 && inMaya(s) === 0 && s.state.lost.includes('omar-1')],
    ['durable-crash', 9000, 'ok', (s) => inMaya(s) === 1 && s.state.msgs['omar-1'].spooled === 2 && s.state.stats.dupDropped === 1],
    ['slow-dot-no-dedupe', 9000, 'wrong', (s) => inMaya(s) >= 2 && s.state.msgs['omar-1'].spooled >= 2],
    ['slow-dot-dedupe', 9000, 'ok', (s) => inMaya(s) === 1 && s.state.stats.dupDropped >= 1 && s.state.msgs['omar-1'].got250],
    ['worker-crash', 9000, 'ok', (s) => inMaya(s) === 1 && s.state.msgs['omar-1'].spooled === 1 && s.state.stats.dupDropped === 1],
    ['flood-421', 9000, 'stale', (s) => inMaya(s) === 1 && s.state.msgs['omar-1'].tempfailed >= 1 && s.state.stats.tempfails > 100 && s.state.lost.length === 0],
    ['flood-accept-drop', 9000, 'wrong', (s) => s.state.msgs['omar-1'].got250 && inMaya(s) === 0 && s.state.stats.tempfails === 0],
    ['backscatter', 9000, 'wrong', (s) => s.state.backscatter.length === 1 && s.state.backscatter[0].to === 'victim@example.net'],
    ['rcpt-reject', 9000, 'ok', (s) => s.state.msgs['botnet-1'].rejected && s.state.backscatter.length === 0],
    ['replica-down', 9000, 'ok', (s) => inMaya(s) === 1 && s.state.stats.deferredLegit === 0],
  ],
  'gm-outbound': [
    ['normal', 9000, 'ok', (s) => omarBox(s).length === 1 && s.state.sent.s1.tDone - s.state.sent.s1.t >= 2000],
    ['undo-in-window', 9000, 'ok', (s) => omarBox(s).length === 0 && s.state.sent.s1.state === 'cancelled'],
    ['undo-client-side', 9000, 'wrong', (s) => omarBox(s).length === 1 && s.ui.maya.hidden.s1],
    ['destination-down', 9000, 'stale', (s) => omarBox(s).length === 1 && s.state.sent.s1.tries >= 2],
    ['give-up-bounce', 9000, 'ok', (s) => omarBox(s).length === 0 && s.state.bounces.length === 1 && s.state.sent.s1.state === 'bounced'],
    ['user-unknown', 9000, 'ok', (s) => s.state.bounces.length === 1 && s.state.sent.s1.tries === 0],
    ['throttle-paced', 9000, 'ok', (s) => s.state.dest.slow.box.length === 12 && !s.state.dest.slow.everBlocked && s.state.stats.deferred >= 1],
    ['throttle-hammer', 9000, 'stale', (s) => s.state.dest.slow.everBlocked && s.state.stats.deferred > 50],
    ['crash-after-handoff', 9000, 'wrong', (s) => omarBox(s).length === 2 && omarBox(s)[0].msgId === omarBox(s)[1].msgId],
    ['compromised-limited', 9000, 'stale', (s) => s.state.sentToday === 20 && s.state.stats.limited > 30 && !s.state.dest.omar.markSpam],
    ['compromised-unlimited', 9000, 'wrong', (s) => s.state.dest.omar.markSpam && omarBox(s).some((m) => m.filed)],
    ['scheduled-phone-off', 9000, 'ok', (s) => omarBox(s).length === 1 && s.nodes.maya.modes.down && s.state.sent.s1.tDone - s.state.sent.s1.t >= 3000],
  ],
  'gm-sync': [
    ['normal', 9000, 'ok', (s) => s.state.hidSeq === 2 && ['phone', 'laptop', 'tablet'].every((d) => s.state.dev[d].cursor === 2)],
    ['push-lost-no-poll', 9000, 'stale', (s) => s.state.dev.phone.cursor === 0 && s.state.dev.laptop.cursor === 1 && s.state.stats.hintsLost === 1],
    ['push-lost-poll', 9000, 'ok', (s) => s.state.stats.hintsLost === 1 && s.state.dev.phone.cursor === 1 && s.state.dev.tablet.cursor === 1],
    ['watch-expired', 9000, 'stale', (s) => s.state.stats.noWatch >= 3 && s.state.dev.phone.cursor === 0],
    ['retention-full-sync', 9000, 'ok', (s) => s.state.stats.gone === 1 && s.state.stats.fullSyncs === 1 && s.state.dev.tablet.cursor === 2],
    ['retention-naive', 9000, 'wrong', (s) => s.state.stats.gone === 1 && s.state.stats.fullSyncs === 0 && s.state.dev.tablet.msgs.m1.labels.includes('INBOX')],
    ['draft-lww', 9000, 'wrong', (s) => s.state.conflicts === 0 && !s.state.drafts.d1.lines.includes('Venue: Room 4')],
    ['draft-versioned', 9000, 'ok', (s) => s.state.conflicts === 1 && s.state.drafts.d1.lines.includes('Venue: Room 4') && s.state.drafts.d2.lines.includes('Bring the slides')],
    ['outbox-flaky-ids', 9000, 'ok', (s) => Object.keys(s.state.sent).length === 2 && s.state.dev.phone.outbox.length === 0 && timeline(s, /same message/)],
    ['outbox-flaky-no-ids', 9000, 'wrong', (s) => Object.keys(s.state.sent).length === 4],
    ['delete-while-offline', 9000, 'ok', (s) => s.state.box.m1.deleted && s.state.dev.phone.msgs.m1.deleted],
  ],
  'gm-labels': [
    ['normal', 9000, 'ok', (s) => s.state.msgs.m4.thread === s.state.msgs.m5.thread && !s.state.msgs.m4.labels.includes('UNREAD') && s.state.dev.laptop.badge === 3],
    ['async-counter-lost', 9000, 'wrong', (s) => s.state.ctr === 2 && s.state.stats.lostDeltas === 1],
    ['txn-counter', 9000, 'ok', (s) => s.state.count === 3 && s.state.dev.phone.badge === 3],
    ['reply-before-original', 9000, 'ok', (s) => s.state.msgs.m4.thread === s.state.msgs.m5.thread && s.state.stats.rethreaded === 1],
    ['subject-only', 9000, 'wrong', (s) => s.state.msgs.m4.thread === s.state.msgs.m1.thread],
    ['full-set-race', 9000, 'wrong', (s) => s.state.msgs.m3.labels.includes('INBOX')],
    ['label-ops', 9000, 'ok', (s) => s.state.msgs.m3.labels.length === 0],
    ['bulk-crash-no-checkpoint', 9000, 'stale', (s) => s.state.jobs[0].state === 'lost' && s.state.jobs[0].done === 6],
    ['bulk-checkpoint', 9000, 'ok', (s) => s.state.jobs[0].state === 'done' && Object.values(s.state.msgs).filter((m) => m.id.startsWith('f') && m.labels.includes('INBOX')).length === 0],
    ['duplicate-event-async', 9000, 'wrong', (s) => s.state.ctr === 4],
    ['laptop-closed', 9000, 'ok', (s) => s.state.dev.laptop.badge === 2 && s.state.dev.laptop.hid === s.state.hidSeq],
  ],
  'gm-spam': [
    ['normal', 9000, 'ok', (s) => Object.values(s.state.box).filter((m) => m.folder === 'inbox').length === 2 && Object.values(s.state.box).some((m) => m.kind === 'spammer' && m.folder === 'spam')],
    ['spoof-no-dmarc', 9000, 'wrong', (s) => Object.values(s.state.box).some((m) => m.kind === 'spoof' && m.folder === 'inbox')],
    ['spoof-dmarc', 9000, 'ok', (s) => s.state.stats.rejected === 1 && Object.keys(s.state.box).length === 0],
    ['classifier-down-open', 9000, 'wrong', (s) => s.state.stats.unfiltered === 2],
    ['classifier-down-451', 9000, 'stale', (s) => s.state.stats.tempfails >= 2 && Object.values(s.state.box).some((m) => m.kind === 'omar' && m.folder === 'inbox') && !Object.values(s.state.box).some((m) => m.kind === 'spammer')],
    ['dns-timeout', 9000, 'stale', (s) => s.state.stats.tempfails >= 1 && Object.values(s.state.box).some((m) => m.kind === 'omar' && m.folder === 'inbox')],
    ['new-domain-wave', 9000, 'stale', (s) => s.state.rep['deals-xyz.example'] === 'bad' && Object.values(s.state.box).filter((m) => m.kind === 'wave' && m.folder === 'spam').length >= 10],
    ['finch-not-spam', 9000, 'ok', (s) => s.state.allow['finch.news'] && Object.values(s.state.box).filter((m) => m.kind === 'promo' && m.folder === 'inbox').length === 2],
    ['compromised-fast-path', 9000, 'wrong', (s) => Object.values(s.state.box).some((m) => m.kind === 'stolen' && m.folder === 'inbox')],
    ['compromised-full', 9000, 'ok', (s) => Object.values(s.state.box).some((m) => m.kind === 'stolen' && m.folder === 'spam')],
  ],
  'gm-search': [
    ['normal', 9000, 'ok', (s) => s.state.view.ids.includes('m10') && s.state.view.shards === 1],
    ['just-arrived-no-merge', 9000, 'stale', (s) => !s.state.view.ids.includes('m10') && s.state.view.ids.length === 3],
    ['just-arrived-merge', 9000, 'ok', (s) => s.state.view.merged.includes('m10')],
    ['deleted-via-cache', 9000, 'wrong', (s) => s.state.view.from === 'cache' && s.state.view.ids.includes('m1') && s.state.lostInvalidations === 1],
    ['deleted-post-filter', 9000, 'ok', (s) => s.state.view.filtered === 1 && !s.state.view.ids.includes('m1')],
    ['deleted-history-key', 9000, 'ok', (s) => s.state.view.from === 'index' && !s.state.view.ids.includes('m1') && s.state.lostInvalidations === 1],
    ['user-other-shard-down', 9000, 'stale', (s) => s.state.view.ids.length === 3 && !s.state.view.partial.length],
    ['spread-shard-down', 9000, 'stale', (s) => s.state.view.partial.includes('s3') && !s.state.view.ids.includes('m6')],
    ['spread-slow-shard', 9000, 'stale', (s) => s.state.view.ms > 120 && s.state.view.shards === 3 && s.state.view.ids.length === 3],
    ['duplicate-index-event', 9000, 'ok', (s) => s.state.view.ids.filter((x) => x === 'm10').length === 1 && s.state.dupApplied >= 1],
    ['extractor-slow', 9000, 'stale', (s) => s.state.view.q === 'indemnity' && s.state.view.ids.length === 0 && s.state.msgs.m10.extracted],
  ],
  'gm-fanout': [
    ['normal', 9000, 'ok', (s) => mb(s) === 10 && s.state.blobs.deck.refs === 60],
    ['copy-per-recipient', 9000, 'ok', (s) => mb(s) === 600],
    ['shard-down', 9000, 'stale', (s) => s.state.stats.requeued > 0 && Object.keys(s.state.jobs.j1.done).length === 60],
    ['crash-no-tracking', 9000, 'wrong', (s) => s.state.stats.crashes === 1],
    ['crash-tracking', 9000, 'ok', (s) => s.state.stats.crashes === 1 && s.state.stats.skipped >= 5],
    ['gc-race', 9000, 'wrong', (s) => s.state.blobs.deck.deleted],
    ['gc-ref-first', 9000, 'ok', (s) => !s.state.blobs.deck.deleted && s.state.blobs.deck.refs === 60],
    ['flood-no-isolation', 9000, 'stale', (s) => s.state.personal[0].t - s.state.personal[0].t0 > 400],
    ['flood-isolation', 9000, 'ok', (s) => s.state.personal[0].t - s.state.personal[0].t0 < 100 && s.state.support.done === s.state.support.sent],
    ['duplicate-delivery', 9000, 'ok', (s) => s.state.stats.skipped > 0 && s.state.box.maya.length === 1],
  ],
  'gm-durability': [
    ['normal', 9000, 'ok', (s) => ['pri', 'repB', 'repC'].every((z) => Object.keys(s.state.zones[z].msgs).length === 5)],
    ['zone-down-sync', 9000, 'ok', (s) => s.state.primary === 'repB' && s.state.failovers.length === 1 && Object.keys(s.state.zones.repB.msgs).length === 5],
    ['async-primary-crash', 9000, 'wrong', (s) => s.state.crashLost.length === 1],
    ['sync-primary-crash', 9000, 'ok', (s) => s.state.primary === 'repB' && !s.state.crashLost.length],
    ['bad-push-replicas-only', 9000, 'wrong', (s) => s.state.restore.state === 'impossible'],
    ['bad-push-offline', 9000, 'stale', (s) => s.state.restore.source === 'backup' && !s.state.restore.lost.length],
    ['bad-push-canary', 9000, 'stale', (s) => s.state.canary.state === 'restored' && Object.keys(s.state.zones.pri.msgs).length === 5],
    ['bad-push-delayed', 9000, 'ok', (s) => s.state.restore.source === 'delayed' && s.state.emptyMs < 1500],
    ['backup-stuck-bad-push', 9000, 'wrong', (s) => s.state.restore.lost.length === 2],
    ['partition', 9000, 'stale', (s) => s.state.tempfails >= 1 && s.state.acked.o1 != null],
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

test('email path: every page exists and every built lab loads', () => {
  const sys = SDL.SYSTEMS.find((x) => x.id === 'gm');
  for (const id of sys.path) assert.ok(SDL.page(id), `missing page ${id}`);
  assert.equal(sys.path.length, 12);
  for (const p of SDL.PAGES.filter((x) => sys.groups.includes(x.group) && x.status === 'built' && !x.calc)) load(p.id);
});
module.exports = { EXPECT };
