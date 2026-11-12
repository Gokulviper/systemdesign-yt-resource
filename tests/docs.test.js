// Collaborative editing (Google Docs) labs: every guided scenario must reach its documented end state.
// Each row: [preset, ms to run, expected consistency key, optional extra check].
const test = require('node:test');
const assert = require('node:assert/strict');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
require('../assets/js/scenarios/yt-common.js');
require('../assets/js/ui/registry.js');
const SDL = globalThis.SDL;
const load = (id) => { if (!SDL.scenarios[id]) require(`../assets/js/scenarios/${id}.js`); return SDL.scenarios[id]; };
const agree = (s) => s.ui.ana.text === s.state.doc.text && s.ui.ben.text === s.state.doc.text;
const count = (hay, needle) => hay.split(needle).length - 1;

const EXPECT = {
  'docs-edit': [
    ['type', 9000, 'ok', (s) => agree(s) && s.state.doc.rev === 2 && s.ui.ben.text.includes('Hire two.') && s.ui.ana.text.includes('Fix sync.')],
    ['apart', 9000, 'ok', (s) => agree(s) && s.state.doc.text.startsWith(' Fix sync.') && s.state.doc.text.endsWith('Hire two.')],
    ['same-spot', 9000, 'ok', (s) => agree(s) && s.state.stats.transformed === 1 && count(s.state.doc.text, 'Hire two.') === 1 && count(s.state.doc.text, 'Fix sync.') === 1],
    ['per-char', 9000, 'ok', (s) => agree(s) && s.state.doc.rev === 10 && s.state.stats.ops === 10],
    ['resend', 9000, 'ok', (s) => agree(s) && s.state.doc.rev === 1 && s.retries === 0 && count(s.state.doc.text, 'Hire two.') === 1],
    ['resend-bad', 9000, 'wrong', (s) => s.state.stats.duplicated === 1 && count(s.state.doc.text, 'Hire two.') === 2],
    ['log-down', 9000, 'stale', (s) => s.ui.ana.status === 'unsaved' && s.state.doc.rev === 0 && s.state.lost.length === 0],
    ['log-down-bad', 9000, 'wrong', (s) => s.state.lost.length === 1 && !s.ui.ben.text.includes('Hire two.') && s.ui.ana.text.includes('Hire two.')],
    ['pubsub-drop', 9000, 'stale', (s) => s.ui.ben.rev === 0 && s.state.doc.rev === 1 && s.state.stats.dropped === 1],
    ['pubsub-heal', 9000, 'ok', (s) => agree(s) && s.state.stats.backfills === 1 && s.state.doc.rev === 2],
    ['pubsub-dup', 9000, 'ok', (s) => agree(s) && s.state.stats.dupsIgnored >= 1],
    ['acl-down', 9000, 'stale', (s) => s.ui.ana.status === 'unsaved' && s.state.doc.rev === 0],
  ],
  'docs-ot': [
    ['same-spot', 9000, 'ok', (s) => agree(s) && s.state.stats.transformed === 1 && s.state.doc.text.includes('Hire two.') && s.state.doc.text.includes('Fix sync.')],
    ['same-spot-lww', 9000, 'wrong', (s) => s.state.stats.lostEdits === 1],
    ['same-spot-lock', 9000, 'ok', (s) => agree(s) && s.state.stats.lockWaits > 0 && s.state.stats.transformed === 0],
    ['same-spot-crdt', 9000, 'ok', (s) => s.state.doc.rev === 2 && s.state.doc.atoms.filter((a) => !a.del).length === 7],
    ['crdt-delete', 9000, 'ok', (s) => s.state.doc.atoms.filter((a) => a.del).length === 4 && s.state.doc.atoms.length > s.state.doc.atoms.filter((a) => !a.del).length],
    ['delete-over-insert', 9000, 'ok', (s) => agree(s) && s.state.doc.text === 'Q3 plan: Hire two.'],
    ['undo', 9000, 'ok', (s) => agree(s) && s.state.doc.rev === 3 && !s.state.doc.text.includes('Hire two.') && s.state.doc.text.includes('Fix sync.')],
    ['rebase', 9000, 'ok', (s) => agree(s) && s.state.stats.rebases === 1 && s.state.stats.transformed === 0],
    ['two-in-flight', 9000, 'wrong', (s) => s.ui.ana.text !== s.state.doc.text && s.state.doc.rev === 2],
    ['bug', 9000, 'wrong', (s) => s.ui.ben.text !== s.state.doc.text || s.ui.ana.text !== s.state.doc.text],
    ['slow-link', 9000, 'ok', (s) => agree(s) && s.state.stats.transformed === 3 && s.state.doc.rev === 4],
    ['reorder', 9000, 'ok', (s) => agree(s) && s.state.stats.backfills >= 1 && s.state.stats.dupsIgnored >= 1],
  ],
  'docs-realtime': [
    ['across', 9000, 'ok', (s) => agree(s) && s.state.doc.rev === 2 && s.state.conns.ana === 'gw1' && s.state.conns.ben === 'gw2'],
    ['crash', 9000, 'ok', (s) => agree(s) && s.state.stats.backfilled === 1 && s.state.conns.ana === 'gw2' && s.state.stats.connectFails === 0],
    ['crash-bad', 9000, 'wrong', (s) => s.state.stats.silentlyMissed === 1 && !s.ui.ana.text.includes('Fix sync.') && s.ui.ana.rev === s.state.doc.rev],
    ['storm', 12000, 'ok', (s) => s.state.stats.connectFails > 200 && s.state.stats.shed > 0 && s.ui.ben.status === 'saved'],
    ['partition-heal', 9000, 'ok', (s) => agree(s) && s.state.stats.gapsHealed === 1 && s.state.stats.dropped === 1],
    ['partition-bad', 9000, 'wrong', (s) => s.state.stats.silentlyMissed === 1 && !s.ui.ben.text.includes('Hire two.')],
    ['flap', 9000, 'ok', (s) => agree(s) && s.state.stats.replayed === 1 && s.state.stats.backfilled >= 1 && s.state.doc.rev === 3],
    ['ghost', 9000, 'stale', (s) => s.ui.ben.link === 'closed' && s.state.present.ben > s.now],
    ['hb-lost', 9000, 'stale', (s) => s.ui.ben.link === 'connected' && s.state.present.ben <= s.now && s.ui.ana.text.includes('Fix sync.')],
  ],
  'docs-offline': [
    ['short', 9000, 'ok', (s) => agree(s) && s.state.stats.resyncs === 0 && s.state.stats.merged === 3 && s.state.doc.rev === 3],
    ['long', 9000, 'ok', (s) => agree(s) && s.state.stats.resyncs === 1 && s.state.stats.reanchored === 2 && s.state.stats.compactions >= 1 && s.state.doc.rev === 8],
    ['long-bad', 9000, 'wrong', (s) => s.ui.ana.text !== s.state.doc.text && s.state.stats.resyncs === 0 && s.state.stats.partialMerges === 1],
    ['long-retention', 9000, 'ok', (s) => agree(s) && s.state.stats.resyncs === 0 && s.state.stats.compactions === 0 && s.state.doc.rev === 8],
    ['resend', 9000, 'ok', (s) => agree(s) && s.state.doc.rev === 2 && s.state.stats.duplicated === 0],
    ['resend-bad', 9000, 'wrong', (s) => s.state.stats.duplicated === 2 && s.state.doc.rev === 4],
    ['restart', 9000, 'ok', (s) => agree(s) && s.state.doc.rev === 2 && s.state.lost.length === 0],
    ['restart-bad', 9000, 'wrong', (s) => s.state.lost.length === 2 && s.state.doc.rev === 0],
    ['conflict', 9000, 'stale', (s) => s.ui.ana.conflicts.length === 1 && s.ui.ana.text === s.state.doc.text && s.state.stats.resyncs === 1],
    ['session-hang', 9000, 'stale', (s) => s.ui.ana.outstanding.length === 1 && s.state.local.queue.length === 1 && s.state.doc.rev === 0],
  ],
  'docs-history': [
    ['open-fresh', 9000, 'ok', (s) => s.ui.ana.opened.tail === 0 && s.ui.ana.opened.snapRev === 4 && s.ui.ana.text === s.state.doc.text],
    ['open-tail', 9000, 'stale', (s) => s.ui.ana.opened.tail === 8 && s.ui.ana.openMs > 350 && s.ui.ana.text === s.state.doc.text],
    ['open-nosnap', 9000, 'ok', (s) => s.ui.ana.opened.source === 'log' && s.ui.ana.text === s.state.doc.text],
    ['restore-forward', 9000, 'ok', (s) => s.state.doc.rev === 6 && s.state.lost.length === 0 && s.state.doc.text.includes('Review Friday.') && s.ui.ben.text === s.state.doc.text],
    ['restore-rewrite', 9000, 'wrong', (s) => s.state.doc.rev === 2 && s.state.lost.length === 3 && !s.state.doc.text.includes('Review Friday.')],
    ['named-kept', 9000, 'ok', (s) => s.state.archive[2] && s.state.archive[2].pinned && s.state.stats.restores === 1 && s.state.doc.text === 'Q3 plan: ship the editor. Fix sync. Add tests.'],
    ['named-lost', 9000, 'wrong', (s) => s.state.lost.includes(2) && s.state.lostVersions === 1],
    ['stale-snap', 9000, 'wrong', (s) => s.state.staleOpens === 1 && s.ui.ana.rev === 4 && s.ui.ana.text !== s.state.doc.text],
    ['stale-snap-verified', 9000, 'ok', (s) => s.state.badSnapshots === 1 && s.ui.ana.text === s.state.doc.text && s.ui.ana.opened.source === 'verified log'],
    ['archive-down', 9000, 'stale', (s) => s.ui.ana.historyPartial && s.ui.ana.history.length >= 1],
  ],
  'docs-sessions': [
    ['normal', 9000, 'ok', (s) => s.state.oplog.rows.length === 2 && s.state.lease.holder === 'sessA' && s.state.stats.takeovers === 0],
    ['crash', 9000, 'ok', (s) => s.state.lease.holder === 'sessB' && s.state.lease.token === 2 && s.state.stats.failoverMs > 1000 && s.state.stats.failoverMs < 4000 && s.state.oplog.rows.length === 3],
    ['crash-long-lease', 9000, 'stale', (s) => s.state.stats.takeovers === 0 && s.ui.ana.outstanding.length === 1 && s.state.lease.until >= 9000],
    ['pause-fenced', 9000, 'ok', (s) => s.state.stats.fenced === 1 && s.state.stats.splitBrain === 0 && s.state.oplog.rows.length === 2 && s.ui.ana.text === s.state.servers.sessB.text],
    ['pause-bad', 9000, 'wrong', (s) => s.state.stats.splitBrain === 1 && s.state.stats.fenced === 0],
    ['coord-down', 9000, 'stale', (s) => s.state.servers.sessA.owner === false && s.state.stats.splitBrain === 0 && s.ui.ana.outstanding.length === 1],
    ['eu-readonly', 9000, 'stale', (s) => s.ui.ben.status === 'unsaved' && s.state.stats.euLocal === 0 && s.state.oplog.rows.length === 1],
    ['eu-bad', 9000, 'wrong', (s) => s.state.stats.euLocal === 1 && s.state.oplog.rows.length === 2],
  ],
  'docs-sharing': [
    ['share', 9000, 'ok', (s) => s.ui.cho.open && s.ui.cho.text === s.state.doc.text && s.ui.cho.received === 1 && s.state.leaks.length === 0],
    ['revoke', 9000, 'ok', (s) => !s.ui.cho.open && s.ui.cho.received === 0 && s.state.stats.dropped === 1 && s.state.stats.refused === 1],
    ['revoke-ttl', 9000, 'wrong', (s) => s.state.leaks.length === 1 && s.ui.cho.received === 1 && !s.state.acl.cho],
    ['acl-down-closed', 9000, 'stale', (s) => s.state.doc.rev === 0 && s.ui.ana.status === 'unsaved' && !s.ui.cho.open && s.state.leaks.length === 0],
    ['acl-down-open', 9000, 'wrong', (s) => s.ui.cho.open && s.state.leaks.some((l) => l.what === 'open' && l.via === 'fail open') && s.state.doc.rev === 1],
    ['link', 9000, 'ok', (s) => !s.ui.cho.open && s.ui.cho.received === 1 && s.state.stats.dropped === 1 && !s.state.link.enabled],
    ['downgrade', 9000, 'ok', (s) => s.state.doc.rev === 1 && s.ui.ben.status === 'readonly' && s.state.acl.ben === 'commenter' && s.ui.ben.text === s.state.doc.text],
    ['per-session', 9000, 'wrong', (s) => s.state.doc.rev === 2 && s.state.acl.ben === 'viewer'],
    ['cache-lost', 9000, 'wrong', (s) => s.state.leaks.some((l) => l.what === 'open' && l.via === 'cache') && s.state.stats.dropped === 1],
    ['meta-down', 9000, 'ok', (s) => !s.state.acl.cho && !s.ui.cho.open && s.state.doc.rev === 1 && s.state.stats.hits >= 1],
  ],
  'docs-hotdoc': [
    ['small', 9000, 'ok', (s) => s.state.doc.rev === 3 && SDL.percentile(s.state.ackMs, 50) < 400],
    ['big-loop', 9000, 'stale', (s) => s.state.doc.rev === 4 && SDL.percentile(s.state.ackMs, 50) > 500 && s.state.stats.pushes === 40000],
    ['big-workers', 9000, 'ok', (s) => s.state.doc.rev === 4 && SDL.percentile(s.state.ackMs, 50) < 400 && s.state.stats.pushes === 40000],
    ['joiners-nocache', 9000, 'stale', (s) => s.state.stats.joinFails > 0 && s.state.stats.replays > 100 && SDL.percentile(s.state.ackMs, 50) > 500],
    ['joiners-cache', 9000, 'ok', (s) => s.state.stats.joinFails === 0 && s.state.stats.replays === 0 && s.state.viewers === 2500 && SDL.percentile(s.state.ackMs, 50) < 400],
    ['slow-nobp', 9000, 'stale', (s) => s.state.stalled && s.state.stats.bufferedOps > 20000 && s.state.stats.resyncs === 0],
    ['slow-bp', 9000, 'ok', (s) => !s.state.stalled && s.state.stats.resyncs === 2000 && s.state.stats.bufferedOps <= 6 * 2000 && s.state.doc.rev === 12],
    ['bot-nolimit', 9000, 'stale', (s) => s.state.stats.limited === 0 && s.state.stats.botOps > 100 && SDL.percentile(s.state.ackMs, 50) > 500],
    ['bot-limit', 9000, 'ok', (s) => s.state.stats.limited > 300 && s.state.stats.botOps < 60 && SDL.percentile(s.state.ackMs, 50) < 500],
  ],
  'docs-comments': [
    ['shift', 9000, 'ok', (s) => s.state.doc.text.slice(s.state.comments.c1.start, s.state.comments.c1.end) === 'ship the editor' && s.state.stats.anchorsMoved === 2],
    ['fixed', 9000, 'wrong', (s) => s.state.doc.text.slice(s.state.comments.c1.start, s.state.comments.c1.end) !== 'ship the editor' && s.state.stats.anchorsMoved === 0],
    ['lost-update', 9000, 'wrong', (s) => s.state.doc.text.slice(s.state.comments.c1.start, s.state.comments.c1.end) !== 'ship the editor' && s.state.stats.anchorsMoved === 1],
    ['orphan', 9000, 'ok', (s) => s.state.comments.c1.orphaned && !s.state.doc.text.includes('ship the editor')],
    ['resolve', 9000, 'ok', (s) => s.state.comments.c1.resolved],
    ['mention', 9000, 'ok', (s) => s.state.notifications.length === 1 && s.state.stats.pushes === 1 && s.ui.ben.inbox.length === 1],
    ['mention-bad', 9000, 'wrong', (s) => s.state.lostEvents === 1 && s.state.notifications.length === 0 && Object.keys(s.state.comments).length === 1],
    ['mention-outbox-down', 9000, 'ok', (s) => s.state.notifications.length === 1 && s.state.notifications[0].t > 1500],
    ['dup', 9000, 'ok', (s) => s.state.notifications.length === 1 && s.state.dupSkipped === 1],
    ['dup-bad', 9000, 'wrong', (s) => s.state.notifications.length === 2 && s.ui.ben.inbox.length === 2],
    ['suggest', 9000, 'ok', (s) => s.state.doc.text.includes('editor (v2)') && s.state.doc.text.startsWith('Draft: ') && s.state.suggestions.s1.state === 'accepted'],
    ['suggest-deleted', 9000, 'ok', (s) => s.state.suggestions.s1.state === 'outdated' && !s.state.doc.text.includes('(v2)') && s.state.stats.refusedAccepts === 1],
    ['push-down', 9000, 'stale', (s) => s.state.notifications.length === 1 && s.state.stats.pushes === 0 && s.ui.ben.inbox.length === 1],
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

test('shared OT helper: transforms converge', () => {
  const T = SDL.yt.ot;
  const t = 'abcdef';
  const a = { pos: 2, ins: 'A' }, b = { pos: 2, ins: 'B' };
  assert.equal(T.apply(T.apply(t, a), T.transform(b, a, false)), T.apply(T.apply(t, b), T.transform(a, b, true)));
  const d = { pos: 1, del: 3 }, i = { pos: 3, ins: 'X' };
  assert.equal(T.apply(T.apply(t, i), T.transform(d, i, false)), 'aXef');
  assert.equal(T.apply(T.apply(t, d), T.transform(i, d, true)), 'aXef');
});

test('docs path: every page exists and the shared YouTube labs are mapped in', () => {
  const sys = SDL.SYSTEMS.find((x) => x.id === 'docs');
  for (const id of sys.path) assert.ok(SDL.page(id), `missing page ${id}`);
  for (const shared of ['auth', 'search']) assert.ok(sys.path.includes(shared), `${shared} mapped`);
  for (const p of SDL.PAGES.filter((x) => sys.groups.includes(x.group) && x.status === 'built' && !x.calc)) load(p.id);
});
module.exports = { EXPECT };
