// Photo backup labs: every guided scenario must reach its documented end state.
// Each row: [preset, ms to run, expected consistency key, optional extra check].
const test = require('node:test');
const assert = require('node:assert/strict');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
require('../assets/js/scenarios/yt-common.js');
require('../assets/js/ui/registry.js');
const SDL = globalThis.SDL;
const load = (id) => { if (!SDL.scenarios[id]) require(`../assets/js/scenarios/${id}.js`); return SDL.scenarios[id]; };
const local = (s) => Object.values(s.state.local);
const view = (s, d) => Object.entries(s.state.dev[d].base).filter(([, b]) => b.state === 'active').map(([id]) => id).sort();
const live = (s) => Object.values(s.state.items).filter((x) => x.state === 'active').map((x) => x.id).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const timeline = (s, re) => s.timeline.some((e) => re.test(e.op));

const EXPECT = {
  'gp-backup': [
    ['happy-path', 9000, 'ok', (s) => local(s)[0].state === 'backed' && s.ui.laptop.loaded.m1 === 'ok' && same(s.ui.laptop.results, ['m1']) && s.ui.omar.loaded.m1 === 'ok'],
    ['drop-and-resume', 9000, 'ok', (s) => local(s)[0].state === 'backed' && local(s)[0].sent <= 44 && s.state.stats.restarts === 0],
    ['no-resume', 9000, 'stale', (s) => local(s)[0].state === 'backed' && local(s)[0].sent >= 56 && s.state.stats.restarts === 1],
    ['lost-ack-idempotent', 9000, 'ok', (s) => s.state.stats.creates === 1 && Object.keys(s.state.items).length === 3 && timeline(s, /same item/)],
    ['lost-ack-duplicate', 9000, 'wrong', (s) => s.state.stats.creates === 2 && s.state.usedMB === 16],
    ['battery-bytes-first', 9000, 'ok', (s) => s.state.stats.creates === 0 && local(s)[0].state !== 'backed'],
    ['metadata-first', 9000, 'wrong', (s) => s.state.items.m1 && !s.state.items.m1.blob && s.ui.laptop.items.includes('m1')],
    ['thumbs-down', 9000, 'stale', (s) => local(s)[0].state === 'backed' && !s.state.items.m1.thumb && same(s.ui.laptop.results, ['m1'])],
    ['ml-backlog', 9000, 'stale', (s) => local(s)[0].state === 'backed' && s.state.items.m1.thumb && same(s.ui.laptop.results, [])],
    ['holiday-surge-jitter', 9000, 'ok', (s) => s.state.surge.done === s.state.surge.n && s.state.stats.shed > 0 && local(s)[0].state === 'backed'],
    ['holiday-surge-sync-retry', 9000, 'stale', (s) => s.state.surge.done < s.state.surge.n && s.state.surge.retries > 1500],
  ],
  'gp-sync': [
    ['delta-sync', 9000, 'ok', (s) => s.state.items.p2.state === 'trashed' && !view(s, 'phone').includes('p2') && !view(s, 'tablet').includes('p2') && s.state.dev.phone.trash.includes('p2')],
    ['hint-lost', 9000, 'ok', (s) => s.state.items.p2.state === 'trashed' && !view(s, 'phone').includes('p2') && s.state.stats.gone === 0],
    ['free-up-space', 9000, 'ok', (s) => Object.keys(s.state.dev.phone.files).length === 0 && live(s).length === 8 && view(s, 'tablet').length === 8],
    ['free-up-space-as-delete', 9000, 'wrong', (s) => live(s).length === 0 && s.state.stats.scanDeletes === 8],
    ['two-way-resurrects', 9000, 'wrong', (s) => s.state.items.p2.state === 'trashed' && Object.values(s.state.items).some((x) => x.state === 'active' && x.hash === 'h2') && s.state.stats.resurrected >= 1],
    ['no-tombstones', 9000, 'wrong', (s) => !s.state.items.p2 && view(s, 'phone').includes('p2')],
    ['cursor-expired-resync', 9000, 'ok', (s) => s.state.stats.gone === 1 && same(view(s, 'tablet'), live(s)) && live(s).length === 9],
    ['cursor-expired-naive', 9000, 'wrong', (s) => s.state.stats.gone === 1 && view(s, 'tablet').includes('p2') && !same(view(s, 'tablet'), live(s))],
    ['reinstall', 9000, 'ok', (s) => s.state.stats.matched === 8 && s.state.stats.uploads === 0 && same(view(s, 'tablet'), live(s))],
    ['edit-conflict-versioned', 9000, 'ok', (s) => s.state.stats.conflicts === 1 && s.state.items.p1.edits.includes('Crop') && Object.values(s.state.items).some((x) => x.edits.includes('Warm filter') && x.id !== 'p1')],
    ['edit-conflict-lww', 9000, 'wrong', (s) => s.state.stats.conflicts === 0 && same(s.state.items.p1.edits, ['Warm filter'])],
  ],
  'gp-quota': [
    ['dedupe-hit', 9000, 'ok', (s) => s.state.stats.attached === 1 && s.state.stats.sentMB === 0 && s.state.index['h-sunset'].refs.length === 2],
    ['reserve-two-devices', 9000, 'ok', (s) => s.state.users.maya.used === 14700 && s.state.jobs.some((j) => j.state === 'full')],
    ['check-then-charge', 9000, 'wrong', (s) => s.state.users.maya.used === 15300],
    ['aborted-reservation-expires', 9000, 'ok', (s) => s.state.stats.expired === 1 && s.state.users.maya.reserved === 0 && s.state.users.maya.used === 14700],
    ['aborted-reservation-leaks', 9000, 'stale', (s) => s.state.users.maya.reserved === 600 && s.state.jobs.some((j) => j.dev === 'tablet' && j.state === 'full')],
    ['gc-race', 9000, 'wrong', (s) => !s.state.blobs['h-sunset'] && Object.values(s.state.items).some((x) => x.hash === 'h-sunset')],
    ['gc-grace', 9000, 'ok', (s) => s.state.stats.revived === 1 && s.state.blobs['h-sunset'] && s.state.stats.gcDeleted === 0],
    ['global-dedupe-leak', 9000, 'wrong', (s) => s.state.leaks.length === 1 && s.state.stats.sentMB === 0],
    ['per-user-dedupe', 9000, 'ok', (s) => s.state.leaks.length === 0 && s.state.stats.sentMB === 2 && s.state.copies['h-ticket'] === 2],
  ],
  'gp-storage': [
    ['tier-down', 9000, 'ok', (s) => s.state.photos.ramen.tier === 'warm' && s.state.photos.ramen.hot.length === 0 && s.state.photos.ramen.stripe.length === 6 && s.state.opens[0].ok],
    ['one-chunk-lost', 9000, 'ok', (s) => s.state.opens[0].via === 'rebuilt' && s.state.stats.repaired >= 1 && s.state.photos.lake.stripe[0].srv !== 's1'],
    ['two-lost', 9000, 'ok', (s) => s.state.opens[0].via === 'rebuilt' && s.state.stats.repaired >= 2],
    ['rack-packed', 9000, 'wrong', (s) => s.state.photos.lake.stripe.filter((c) => c.gone).length === 3 && !s.state.opens[0].ok],
    ['rack-aware', 9000, 'ok', (s) => s.state.opens[0].ok && s.state.opens[0].via === 'rebuilt' && s.state.photos.lake.stripe.every((c) => !c.gone)],
    ['bit-rot-no-checksum', 9000, 'wrong', (s) => s.state.damaged.length === 1 && s.state.stats.caught === 0],
    ['scrub-catches', 9000, 'ok', (s) => s.state.stats.caught >= 1 && s.state.opens[0].ok && !s.state.opens[0].damaged],
    ['mover-flip-first', 9000, 'wrong', (s) => s.state.photos.ramen.tier === 'warm' && s.state.photos.ramen.hot.length === 0 && !s.state.opens[0].ok],
    ['mover-crash-verified', 9000, 'ok', (s) => s.state.stats.moverCrashes === 1 && s.state.photos.ramen.tier === 'warm' && s.state.opens[0].ok],
    ['no-degraded-reads', 9000, 'stale', (s) => s.state.opens[0].via === 'waited' && s.state.opens[0].ms > 600 && s.state.stats.degradedReads === 0],
  ],
  'gp-delete': [
    ['trash-restore', 9000, 'ok', (s) => s.state.items.beach.state === 'active' && s.state.copies.blob.beach && s.state.stats.tasks === 0],
    ['permanent-delete', 9000, 'ok', (s) => s.state.items.beach.state === 'deleted' && ['blob', 'thumbs', 'cdn', 'index', 'faces', 'albums'].every((t) => !s.state.copies[t].beach) && s.ui.laptop.results.length === 1],
    ['fire-and-forget-index-down', 9000, 'wrong', (s) => s.state.items.beach.state === 'deleted' && s.state.copies.index.beach && s.ui.laptop.results.some((r) => r.id === 'beach')],
    ['ledger-retries', 9000, 'ok', (s) => s.state.stats.retries >= 1 && !s.state.copies.index.beach && s.ui.laptop.results.length === 1],
    ['restore-purge-race', 9000, 'wrong', (s) => s.state.items.beach.state === 'active' && !s.state.copies.blob.beach],
    ['restore-guarded', 9000, 'ok', (s) => s.state.stats.refused === 1 && s.state.items.beach.state === 'deleted'],
    ['duplicate-task', 9000, 'ok', (s) => s.state.items.beach.state === 'deleted' && s.state.stats.purgeCalls > s.state.stats.tasks],
    ['account-delete-backup-wait', 9000, 'stale', (s) => Object.values(s.state.items).every((i) => i.state === 'deleted') && Object.keys(s.state.copies.backups).length === 4],
    ['account-delete-shred', 9000, 'ok', (s) => s.state.keyDestroyed && Object.keys(s.state.copies.backups).length === 0],
  ],
  'gp-search': [
    ['searchable', 9000, 'ok', (s) => JSON.stringify(s.ui.laptop.results) === '["n1"]' && s.state.stats.freshWait < 500],
    ['workers-down', 9000, 'stale', (s) => s.ui.laptop.results.length === 0 && s.state.items.n1.labelledAt == null],
    ['backfill-starves-fresh', 9000, 'stale', (s) => s.ui.laptop.results.length === 0 && s.state.stats.freshWait > 2000],
    ['fresh-lane', 9000, 'ok', (s) => s.ui.laptop.results.includes('n1') && s.state.stats.freshWait < 1000],
    ['swap-without-dual-write', 9000, 'wrong', (s) => s.state.alias === 'v2' && s.ui.laptop.results.length === 0 && s.state.idx1.n1],
    ['dual-write-swap', 9000, 'ok', (s) => s.state.alias === 'v2' && s.ui.laptop.index === 'v2' && s.ui.laptop.results.includes('n1')],
    ['delete-during-backfill', 9000, 'wrong', (s) => s.state.alias === 'v2' && s.ui.laptop.results.includes('b1') && s.state.items.b1.state === 'deleted'],
    ['face-optout-no-purge', 9000, 'wrong', (s) => !s.state.faceOn && Object.keys(s.state.emb).length === 20],
    ['face-optout-purge', 9000, 'ok', (s) => !s.state.faceOn && Object.keys(s.state.emb).length === 0],
  ],
  'gp-sharing': [
    ['album-share', 9000, 'ok', (s) => s.state.members.includes('omar') && same(s.ui.omar.album, ['a1', 'a2', 'a3', 'a4']) && Object.values(s.ui.omar.loaded).every((x) => x === 'ok')],
    ['omar-contributes', 9000, 'ok', (s) => s.state.album.find((x) => x.id === 'o1').owner === 'omar' && s.ui.maya.album.includes('o1') && s.state.usage.omar === 1 && s.state.usage.maya === 4],
    ['link-view', 9000, 'ok', (s) => s.ui.lena.open && Object.values(s.ui.lena.gps).every((g) => g === null) && s.state.stats.expired >= 1],
    ['revoke-long-urls', 9000, 'wrong', (s) => s.ui.lena.open && s.state.reads.some((r) => r.who === 'lena' && r.since > 5000)],
    ['revoke-short-ttl', 9000, 'ok', (s) => !s.ui.lena.open && s.ui.lena.denied === 'NOT_FOUND' && s.state.reads.every((r) => r.since <= 1900)],
    ['remove-member-stale-acl', 9000, 'wrong', (s) => s.state.leaks.length === 1 && s.state.leaks[0].photo === 'a5' && !s.ui.omar.open],
    ['remove-member-invalidate', 9000, 'ok', (s) => s.state.leaks.length === 0 && s.ui.omar.denied === 'FORBIDDEN' && s.state.reads.length === 0],
    ['location-leak', 9000, 'wrong', (s) => Object.keys(s.state.exposed).sort().join() === 'a1,a3'],
    ['viral-link', 9000, 'ok', (s) => s.state.stats.crowdViews >= 500 && s.state.stats.aclReads <= 3 && s.state.stats.blobReads <= 8],
    ['viral-sig-in-key', 9000, 'stale', (s) => s.state.stats.blobReads > 500 && s.state.stats.cdnMisses > s.state.stats.cdnHits],
  ],
  'gp-timeline': [
    ['scroll-by-taken', 9000, 'ok', (s) => s.ui.laptop.done && s.ui.laptop.shown.length === 81 && s.ui.laptop.shown[80] === 'g1' && s.state.stats.repeats === 0],
    ['sort-by-upload', 9000, 'wrong', (s) => s.ui.laptop.shown[0] === 'g1'],
    ['offset-with-deletes', 9000, 'wrong', (s) => s.ui.laptop.done && live(s).filter((id) => !s.ui.laptop.shown.includes(id)).length === 6],
    ['cursor', 9000, 'ok', (s) => s.ui.laptop.done && live(s).every((id) => s.ui.laptop.shown.includes(id)) && live(s).length === 75],
    ['burst-no-tiebreak', 9000, 'wrong', (s) => same(live(s).filter((id) => !s.ui.laptop.shown.includes(id)), ['k01', 'k02', 'k03', 'k04'])],
    ['burst-tiebreak', 9000, 'ok', (s) => s.ui.laptop.shown.slice(6, 16).join() === 'k10,k09,k08,k07,k06,k05,k04,k03,k02,k01'],
    ['summary-lag', 9000, 'stale', (s) => s.ui.laptop.scrub['2026-03'] === 40 && s.ui.laptop.shown.filter((id) => s.state.items[id].taken.startsWith('2026-03')).length === 52],
    ['cold-cache-stampede', 9000, 'stale', (s) => s.state.stats.renders > 300 && s.state.stats.coalesced === 0],
    ['coalesced', 9000, 'ok', (s) => s.state.stats.renders <= 200 && s.state.stats.coalesced > 0 && s.ui.laptop.done],
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

test('photo backup path: every page exists and every built lab loads', () => {
  const sys = SDL.SYSTEMS.find((x) => x.id === 'gp');
  for (const id of sys.path) assert.ok(SDL.page(id), `missing page ${id}`);
  assert.equal(sys.path.length, 13);
  for (const p of SDL.PAGES.filter((x) => sys.groups.includes(x.group) && x.status === 'built' && !x.calc)) load(p.id);
});
module.exports = { EXPECT };
