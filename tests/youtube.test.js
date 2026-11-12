// YouTube labs: every guided scenario must reach its documented end state.
// Each row: [preset, ms to run, expected consistency key, optional extra check].
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
require('../assets/js/engine/sim.js');
require('../assets/js/engine/metrics.js');
require('../assets/js/scenarios/yt-common.js');
const SDL = globalThis.SDL;
const load = (id) => { if (!SDL.scenarios[id]) require(`../assets/js/scenarios/${id}.js`); return SDL.scenarios[id]; };

const EXPECT = {
  likes: [
    ['like', 9000, 'ok', (s) => s.state.rows.you.liked === true && s.state.count === 12481],
    ['A', 9000, 'ok', (s) => s.ui.viewer.liked === false],
    ['B', 9000, 'ok', (s) => s.ui.viewer.liked === false && !s.state.rows.you],
    ['C', 9000, 'ok', (s) => s.state.rows.you.liked === true],
    ['C-bad', 9000, 'wrong'],
    ['D', 9000, 'ok', (s) => s.state.count === 12481],
    ['E', 9000, 'ok', (s) => s.state.dupSkipped > 0],
    ['E-bad', 9000, 'wrong'],
    ['F', 12000, 'ok'],
    ['G', 9000, 'ok', (s) => s.state.rows.you.liked === false],
    ['G-bad', 9000, 'wrong'],
    ['H', 9000, 'stale'],
    ['H-fix', 9000, 'ok'],
  ],
  comments: [
    ['post', 8000, 'ok'], ['reply', 8000, 'ok', (s) => s.state.alerts === 1], ['dup', 8000, 'ok'], ['dup-bad', 8000, 'wrong'],
    ['spam', 8000, 'ok', (s) => Object.values(s.state.comments).some((c) => c.status === 'hidden')],
    ['mod-down', 9000, 'ok'], ['mod-open', 9000, 'wrong'], ['db-down', 8000, 'ok', (s) => Object.keys(s.state.comments).length === 2],
    ['notify-out', 9000, 'ok', (s) => s.state.alerts === 1], ['edit', 5000, 'ok'], ['edit-bad', 5000, 'wrong'],
  ],
  views: [
    ['watch', 12000, 'ok'], ['resend', 12000, 'ok', (s) => s.state.stats.dups > 0], ['resend-bad', 12000, 'wrong'],
    ['bots', 12000, 'ok', (s) => s.state.stats.bots > 0], ['bots-bad', 12000, 'wrong'],
    ['outage', 14000, 'ok'], ['outage-bad', 14000, 'wrong', (s) => s.state.lost > 0],
    ['viral', 16000, 'ok'], ['viral-split', 16000, 'ok'], ['stall', 12000, 'ok'],
  ],
  upload: [
    ['upload', 9000, 'ok'], ['drop', 9000, 'ok', (s) => s.state.wasted === 0], ['drop-restart', 9000, 'ok', (s) => s.state.wasted > 0],
    ['corrupt', 9000, 'ok'], ['corrupt-bad', 9000, 'wrong'], ['complete', 9000, 'ok'], ['complete-bad', 9000, 'wrong'],
    ['store-down', 9000, 'ok'], ['backlog', 9000, 'ok'],
  ],
  processing: [
    ['job', 14000, 'ok'], ['crash', 14000, 'ok'], ['crash-bad', 14000, 'wrong'], ['poison', 14000, 'stale', (s) => s.state.stats.dead === 1],
    ['poison-bad', 14000, 'wrong'], ['burst', 16000, 'ok'], ['burst-fixed', 14000, 'stale'], ['all-or-nothing', 14000, 'ok'],
  ],
  storage: [
    ['publish', 8000, 'ok'], ['partial-first', 8000, 'ok'], ['partial-gate', 8000, 'stale'], ['partial-bad', 8000, 'wrong'],
    ['orphans', 8000, 'ok', (s) => s.state.freed > 0], ['orphans-bad', 8000, 'stale'], ['abandoned', 8000, 'ok'], ['abandoned-bad', 8000, 'stale'], ['obj-down', 8000, 'ok'],
  ],
  streaming: [
    ['play', 20000, 'ok'], ['weak', 20000, 'ok'], ['weak-fixed', 20000, 'stale'], ['cdn', 20000, 'ok'], ['cdn-bad', 20000, 'wrong'],
    ['missing', 20000, 'ok'], ['missing-bad', 20000, 'wrong'], ['cold', 20000, 'ok'], ['manifest', 20000, 'ok'],
  ],
  cdn: [
    ['normal', 6000, 'ok'], ['viral', 14000, 'ok'], ['viral-stampede', 14000, 'stale', (s) => Object.values(s.state.regions).reduce((a, r) => a + r.errors, 0) > 100],
    ['viral-noshield', 14000, 'ok'], ['outage', 6000, 'ok'], ['outage-bad', 6000, 'wrong'], ['purge', 6000, 'ok'],
  ],
  subscriptions: [
    ['subscribe', 6000, 'ok'], ['retry', 6000, 'ok'], ['retry-bad', 6000, 'wrong'], ['small', 6000, 'ok'],
    ['celebrity', 6000, 'ok'], ['celebrity-bad', 6000, 'stale'], ['paused', 8000, 'ok'], ['graph-down', 6000, 'ok'],
  ],
  feed: [
    ['open', 4000, 'ok'], ['reco-slow', 4000, 'stale'], ['reco-slow-bad', 4000, 'stale'], ['ranker-down', 4000, 'stale'],
    ['ranker-down-bad', 4000, 'wrong'], ['ranker-slow', 4000, 'stale'], ['stale', 4000, 'stale'], ['subs-down', 4000, 'stale'],
  ],
  search: [
    ['search', 4000, 'ok'], ['fresh', 4000, 'ok'], ['fresh-slow', 2000, 'stale'], ['lag', 3000, 'stale'],
    ['shard-down', 4000, 'stale'], ['shard-down-bad', 4000, 'wrong'], ['shard-slow', 4000, 'stale'], ['no-typeahead', 4000, 'ok'],
  ],
  notifications: [
    ['publish', 10000, 'ok'], ['burst', 14000, 'ok'], ['burst-bad', 14000, 'wrong'], ['dup', 10000, 'ok'],
    ['dup-bad', 10000, 'wrong'], ['push-down', 14000, 'ok', (s) => s.state.inbox.length === 1], ['email-down', 14000, 'ok'],
  ],
  history: [
    ['continue', 12000, 'ok'], ['no-flush', 12000, 'stale'], ['load', 10000, 'ok'], ['load-bad', 10000, 'stale'],
    ['edits', 3000, 'ok', (s) => s.state.playlist.items.join('') === 'DAC'], ['edits-bad', 3000, 'wrong'], ['down', 12000, 'stale'],
  ],
  live: [
    ['live', 9000, 'ok'], ['standard', 12000, 'ok', (s) => s.state.latency > 6000], ['ingest', 9000, 'ok'], ['ingest-bad', 9000, 'wrong'],
    ['overload', 12000, 'ok', (s) => s.state.renditions === 2], ['overload-bad', 12000, 'stale'], ['hype', 9000, 'ok'], ['hype-bad', 4000, 'stale'],
  ],
  analytics: [
    ['normal', 14000, 'ok'], ['late', 14000, 'ok'], ['late-bad', 14000, 'stale'], ['outage', 14000, 'ok'],
    ['outage-bad', 14000, 'wrong'], ['dup', 14000, 'ok'], ['dup-bad', 9000, 'stale'],
  ],
  auth: [
    ['signin', 3000, 'ok'], ['auth-down', 3000, 'ok'], ['auth-down-bad', 3000, 'wrong'], ['expiry', 9000, 'ok'], ['expiry-bad', 9000, 'wrong'],
    ['spam', 5000, 'ok', (s) => s.state.burst.limited > 0], ['limiter-open', 5000, 'stale'], ['limiter-closed', 5000, 'wrong'],
    ['revoke', 3000, 'wrong'], ['revoke-introspect', 3000, 'ok'],
  ],
  'yt-apis': [['post', 4000, 'ok'], ['post-bad', 4000, 'wrong'], ['cursor', 4000, 'ok'], ['offset', 4000, 'wrong']],
  'yt-consistency': [['edit', 4000, 'ok'], ['no-ryw', 4000, 'wrong'], ['ryw', 4000, 'ok'], ['no-invalidate', 4000, 'stale'], ['invalidate', 4000, 'ok'], ['quorum', 4000, 'ok']],
  'yt-sharding': [
    ['video', 6000, 'ok'], ['channel', 6000, 'stale'], ['add-consistent', 6000, 'ok', (s) => s.state.moved < 600],
    ['add-modulo', 6000, 'ok', (s) => s.state.moved > 1400], ['shard-down', 6000, 'stale'],
  ],
  'yt-architecture': [['watch', 4000, 'ok'], ['upload', 4000, 'ok'], ['outage', 4000, 'stale'], ['outage-bad', 4000, 'wrong']],
  'yt-reliability': [
    ['normal', 6000, 'ok'], ['cascade', 6000, 'wrong'], ['timeouts', 6000, 'stale', (s) => s.state.mine && s.state.mine.ok],
    ['storm', 6000, 'stale', (s) => s.state.retriesUsed > 100], ['breaker', 6000, 'stale', (s) => s.state.breaker.state !== 'closed' || s.state.fallbacks > 0], ['critical', 6000, 'wrong'],
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
    const s = new SDL.Simulator(sc);
    s.dispatch('preset', { id: sc.presets[1].id });
    s.runFor(4000);
    const before = JSON.stringify(s.timeline.map((e) => [e.t, e.node, e.op, e.status]));
    s.replay();
    s.runFor(4000);
    assert.equal(JSON.stringify(s.timeline.map((e) => [e.t, e.node, e.op, e.status])), before);
  });
}
module.exports = { EXPECT };
