// Photo sharing (Instagram) labs: every guided scenario must reach its documented end state.
// Each row: [preset, ms to run, expected consistency key, optional extra check].
const test = require('node:test');
const assert = require('node:assert/strict');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
require('../assets/js/scenarios/yt-common.js');
require('../assets/js/ui/registry.js');
const SDL = globalThis.SDL;
const load = (id) => { if (!SDL.scenarios[id]) require(`../assets/js/scenarios/${id}.js`); return SDL.scenarios[id]; };
const inFeed = (s, id) => s.ui.dev.feed.some((p) => p.id === id);

const EXPECT = {
  'ig-post': [
    ['post', 9000, 'ok', (s) => inFeed(s, 'P1') && s.ui.dev.loaded.P1 === 'ok' && s.ui.maya.shareMs < 600],
    ['like', 9000, 'ok', (s) => s.state.posts.P1.likeRows === 1 && s.ui.maya.activities.length === 1],
    ['double-like', 9000, 'ok', (s) => s.state.posts.P1.likeRows === 1 && s.ui.maya.activities.length === 1],
    ['double-like-bad', 9000, 'wrong', (s) => s.state.posts.P1.likeRows === 2 && s.ui.maya.activities.length === 2],
    ['no-preupload', 9000, 'ok', (s) => s.ui.maya.shareMs > 1000 && inFeed(s, 'P1')],
    ['blobs-down', 9000, 'ok', (s) => Object.keys(s.state.posts).length === 0 && /upload/.test(s.ui.maya.error)],
    ['fanout-paused', 9000, 'stale', (s) => !inFeed(s, 'P1') && s.queueStats('fan').depth === 1],
    ['cache-down', 9000, 'ok', (s) => inFeed(s, 'P1') && s.state.stats.pulls > 0],
    ['cache-down-bad', 9000, 'stale', (s) => !!s.ui.dev.feedError && s.state.stats.feedErrors > 0],
    ['celebrity', 9000, 'ok', (s) => inFeed(s, 'P1') && inFeed(s, 'P2') && s.state.stats.fanWrites === 1200],
    ['celebrity-bad', 9000, 'stale', (s) => !inFeed(s, 'P2') && s.queueStats('fan').depth === 2],
    ['cdn-down', 9000, 'stale', (s) => inFeed(s, 'P1') && s.ui.dev.loaded.P1 === 'failed'],
  ],
  'ig-feed': [
    ['open', 9000, 'ok', (s) => s.ui.dev.items.length === 5 && s.ui.dev.ms < 300 && s.ui.dev.source === 'cache'],
    ['pull', 9000, 'stale', (s) => s.ui.dev.source === 'pull' && s.ui.dev.ms > 700 && s.state.stats.pullReads === 300],
    ['celebrity', 9000, 'ok', (s) => s.ui.dev.items.some((p) => p.author === 'celeb') && s.ui.dev.items.some((p) => p.author === 'maya') && s.state.stats.fanWrites === 1200],
    ['celebrity-bad', 9000, 'stale', (s) => !s.ui.dev.items.some((p) => p.author === 'maya') && s.queueStats('fan').depth === 2],
    ['rank-slow', 9000, 'ok', (s) => s.ui.dev.fallback && s.ui.dev.ms < 700],
    ['rank-slow-bad', 9000, 'stale', (s) => !s.ui.dev.fallback && s.ui.dev.ms > 700],
    ['rank-down', 9000, 'ok', (s) => s.ui.dev.fallback],
    ['dup', 9000, 'ok', (s) => s.state.stats.dupSkipped === 1 && s.state.feeds.dev.filter((id) => id === 'P13').length === 1],
    ['offset-bad', 9000, 'wrong', (s) => s.ui.dev.dups === 1 && s.ui.dev.items.length === 10],
    ['cursor', 9000, 'ok', (s) => s.ui.dev.dups === 0 && s.ui.dev.items.length === 10],
    ['fanout-paused', 9000, 'stale', (s) => !s.state.feeds.dev.includes('P13')],
    ['cache-down', 9000, 'stale', (s) => s.ui.dev.source === 'pull' && s.ui.dev.items.length === 5],
  ],
  'ig-graph': [
    ['follow', 9000, 'ok', (s) => s.state.edges.dev.celeb === 'active' && s.state.counts.celeb === 50000001 && inFeed(s, 'P1')],
    ['request', 9000, 'ok', (s) => s.state.edges.dev.maya === 'active' && s.state.counts.maya === 1201 && inFeed(s, 'P0')],
    ['unfollow', 9000, 'ok', (s) => !s.state.edges.dev.maya && s.state.counts.maya === 1200 && s.ui.dev.feed.length === 0 && s.state.stats.removed === 1],
    ['unfollow-bad', 9000, 'wrong', (s) => !s.state.edges.dev.maya && inFeed(s, 'P0')],
    ['unfollow-filter', 9000, 'stale', (s) => !s.state.edges.dev.maya && !inFeed(s, 'P0') && s.state.feed.includes('P0')],
    ['private', 9000, 'ok', (s) => s.state.edges.dev.maya === 'requested' && s.ui.dev.feed.length === 0 && Object.keys(s.state.posts).length === 3],
    ['leak', 9000, 'stale', (s) => s.state.feed.includes('P2') && !inFeed(s, 'P2') && s.state.cache['dev/maya'] === 'active'],
    ['leak-bad', 9000, 'wrong', (s) => inFeed(s, 'P2')],
    ['hot', 9000, 'stale', (s) => s.state.stats.timeouts > 1000 && s.state.edges.dev.maya === 'requested' && /priya/.test(s.ui.dev.error)],
    ['counts', 9000, 'ok', (s) => s.state.counts.celeb === 50000001],
    ['retry', 9000, 'ok', (s) => s.state.counts.celeb === 50000001 && s.retries > 0],
    ['retry-bad', 9000, 'wrong', (s) => s.state.counts.celeb === 50000002],
  ],
  'ig-dm': [
    ['chat', 9000, 'ok', (s) => s.ui.maya.threads.dm.length === 2 && s.state.messages.m1.seenBy.includes('maya') && s.ui.dev.threads.dm.length === 2],
    ['offline', 9000, 'ok', (s) => s.ui.maya.threads.dm.length === 1 && s.state.stats.synced === 1 && s.state.stats.pushes === 1],
    ['offline-stays', 9000, 'stale', (s) => s.ui.maya.threads.dm.length === 0 && s.state.inbox.maya.length === 1],
    ['push-down', 9000, 'ok', (s) => s.ui.maya.threads.dm.length === 1 && s.state.stats.pushes === 0 && s.state.stats.synced === 1],
    ['retry', 9000, 'ok', (s) => s.ui.maya.threads.dm.length === 1 && Object.keys(s.state.messages).length === 1],
    ['retry-bad', 9000, 'wrong', (s) => s.ui.maya.threads.dm.length === 2 && Object.keys(s.state.messages).length === 2],
    ['group', 9000, 'ok', (s) => ['dev', 'maya', 'sam'].every((w) => s.ui[w].threads.trip.length === 3)],
    ['group-bad', 9000, 'wrong', (s) => s.ui.maya.threads.trip.slice().sort((a, b) => a.sentAt - b.sentAt)[0].from === 'sam'],
    ['db-down', 9000, 'ok', (s) => s.ui.dev.threads.dm[0].state === 'failed' && s.ui.maya.threads.dm.length === 0],
    ['db-down-bad', 9000, 'wrong', (s) => s.state.lost.length === 1 && s.ui.maya.threads.dm.length === 1],
    ['db-slow', 9000, 'ok', (s) => s.ui.maya.threads.dm.length === 1 && s.state.messages.m1.deliveredAt - s.state.messages.m1.t > 300],
  ],
  'ig-stories': [
    ['post-view', 9000, 'ok', (s) => s.state.seen.S1 && s.state.seen.S1.includes('dev') && s.ui.dev.media === 'ok'],
    ['expire', 9000, 'ok', (s) => s.state.stats.expired === 1 && s.ui.dev.tray.length === 0 && Object.keys(s.state.stories).length === 0],
    ['sweeper-paused', 9000, 'stale', (s) => s.ui.dev.tray.length === 0 && Object.keys(s.state.stories).length === 1 && s.state.stats.hiddenAtRead > 0],
    ['sweeper-paused-bad', 9000, 'wrong', (s) => s.ui.dev.tray.length === 1],
    ['view-twice', 9000, 'ok', (s) => s.state.seen.S1.length === 1],
    ['hot', 9000, 'stale', (s) => !!s.ui.dev.viewError && s.state.stats.crowdTimeouts > 100],
    ['hot-sharded', 9000, 'ok', (s) => s.ui.dev.media === 'ok' && s.state.stats.crowdTimeouts === 0 && s.ui.dev.viewMs < 400],
    ['tray-stale', 9000, 'stale', (s) => s.ui.dev.tray.length === 0 && Object.keys(s.state.stories).length === 1],
    ['tray-nocache', 9000, 'ok', (s) => s.ui.dev.tray.length === 1 && s.state.stats.trayFromDb > 0],
    ['cdn-down', 9000, 'stale', (s) => s.ui.dev.media === 'failed' && s.state.seen.S1.includes('dev')],
  ],
  'ig-media': [
    ['share', 9000, 'ok', (s) => s.ui.maya.shareMs < 200 && s.state.posts.P1.readyAt - s.state.posts.P1.t >= 400 && s.ui.dev.loaded.P1 === 'ok'],
    ['no-placeholder', 9000, 'ok', (s) => s.ui.dev.loaded.P1 === 'ok' && !s.state.config.placeholder],
    ['resume', 9000, 'ok', (s) => s.state.stats.chunks === 4 && s.state.stats.wasted === 0 && s.ui.dev.loaded.P1 === 'ok'],
    ['restart', 9000, 'ok', (s) => s.state.stats.wasted >= 1 && s.state.stats.chunks > 4 && s.ui.dev.loaded.P1 === 'ok'],
    ['workers-down', 9000, 'stale', (s) => !s.state.posts.P1.ready && s.ui.dev.feed.length === 1 && s.ui.dev.loaded.P1 === undefined],
    ['dedupe', 9000, 'ok', (s) => s.state.stats.dedupeHits === 1 && s.state.stats.chunks === 4 && Object.keys(s.state.posts).length === 2 && s.state.posts.P2.readyAt === s.state.posts.P2.t],
    ['dedupe-off', 9000, 'ok', (s) => s.state.stats.chunks === 8 && s.state.stats.jobs === 2],
    ['complete-twice', 9000, 'ok', (s) => Object.keys(s.state.media).length === 1 && s.state.stats.jobs === 1],
    ['complete-twice-bad', 9000, 'wrong', (s) => Object.keys(s.state.media).length === 2 && s.state.stats.jobs === 2],
    ['viral', 9000, 'ok', (s) => s.state.stats.coalesced > 100 && s.state.stats.originReads < 10 && s.state.stats.crowdTimeouts === 0],
    ['viral-stampede', 9000, 'stale', (s) => s.state.stats.coalesced === 0 && s.state.stats.originReads > 50 && s.state.stats.crowdTimeouts > 0],
  ],
  'ig-activity': [
    ['like', 9000, 'ok', (s) => s.state.activity.length === 1 && s.state.stats.pushes === 1 && s.ui.maya.entries[0].text === 'dev liked your photo'],
    ['double', 9000, 'ok', (s) => s.state.stats.events === 1 && s.state.stats.pushes === 1],
    ['burst', 9000, 'ok', (s) => s.state.activity.length === 1 && s.state.activity[0].count === 13 && s.state.stats.pushes === 1 && /dev and 12 others/.test(s.state.activity[0].text)],
    ['burst-noagg', 9000, 'stale', (s) => s.state.activity.length === 13 && s.state.stats.pushes === 3 && s.state.stats.suppressed === 10],
    ['burst-spam', 9000, 'wrong', (s) => s.state.stats.pushes === 13],
    ['dup', 9000, 'ok', (s) => s.state.activity[0].count === 13 && s.state.dupSkipped === 13],
    ['dup-bad', 9000, 'wrong', (s) => s.state.activity[0].count === 26],
    ['agg-paused', 9000, 'stale', (s) => s.state.activity.length === 0 && s.queueStats('likes').depth === 5],
    ['push-down', 9000, 'stale', (s) => s.state.activity.length === 1 && s.state.stats.pushes === 0 && s.ui.maya.entries.length === 1],
  ],
  'ig-explore': [
    ['search', 9000, 'ok', (s) => s.ui.dev.results.length === 3 && s.ui.dev.count === 1240000 && s.ui.dev.suggestMs < 200],
    ['fresh', 9000, 'ok', (s) => s.ui.dev.results.length === 4 && s.state.searchableAt - s.state.published.t < 1000],
    ['fresh-slow', 9000, 'stale', (s) => s.ui.dev.results.length === 3 && s.state.searchableAt > s.ui.dev.searchedAt],
    ['paused', 9000, 'stale', (s) => s.ui.dev.results.length === 3 && s.state.searchableAt > 4000],
    ['delete', 9000, 'ok', (s) => s.ui.dev.results.length === 2 && s.state.shards.shardA[0].tombstone],
    ['delete-reorder', 9000, 'ok', (s) => s.state.stats.dropped === 1 && s.ui.dev.results.length === 3],
    ['delete-reorder-bad', 9000, 'wrong', (s) => s.ui.dev.results.length === 4 && s.state.docs[8].deleted],
    ['shard-down', 9000, 'stale', (s) => s.ui.dev.partial === 'Index shard B' && s.ui.dev.results.length === 2],
    ['shard-down-bad', 9000, 'stale', (s) => !!s.ui.dev.error],
    ['viral', 9000, 'ok', (s) => s.state.stats.incTimeouts === 0 && s.ui.dev.count > 1240000 && !s.ui.dev.countError],
    ['viral-hot', 9000, 'stale', (s) => s.ui.dev.countError && s.state.stats.incTimeouts > 1000],
    ['ta-down', 9000, 'ok', (s) => s.ui.dev.suggestMs > 200 && s.state.stats.cacheMiss === 1],
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

test('instagram path: every page exists and the shared YouTube labs are mapped in', () => {
  const sys = SDL.SYSTEMS.find((x) => x.id === 'ig');
  for (const id of sys.path) assert.ok(SDL.page(id), `missing page ${id}`);
  for (const shared of ['likes', 'comments', 'cdn', 'auth']) assert.ok(sys.path.includes(shared), `${shared} mapped`);
  for (const p of SDL.PAGES.filter((x) => sys.groups.includes(x.group) && x.status === 'built' && !x.calc)) load(p.id);
});
module.exports = { EXPECT };
