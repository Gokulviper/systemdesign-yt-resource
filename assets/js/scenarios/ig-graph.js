/*
 * Follow graph and privacy.
 * Follow edges live in a graph store sharded by the followed account's id;
 * each account's follower count is kept by a counter worker fed from edge
 * events. Maya's account is private, so following her creates a request she
 * must accept. Two rules keep private posts private: fan-out only to active
 * followers, and a read-time check of the edge before a post is shown. A
 * celebrity's shard shows what a hot key does to everyone who shares it.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const ACCOUNTS = {
    maya: { name: 'maya.k', private: true, shard: 'shard1', followers: 1200, hue: 330 },
    celeb: { name: 'priya.rao', private: false, shard: 'shard2', followers: 50000000, hue: 40 },
  };
  const SURGE = 2500; // follows per second at the celebrity during a surge

  const edge = (st, target) => st.edges.dev[target] || 'none';

  function startFollow(sim, target, label) {
    const st = sim.state;
    const cur = edge(st, target);
    const want = cur === 'none' ? (ACCOUNTS[target].private ? 'requested' : 'active') : 'none';
    sim.startAction(label || `Dev: ${want === 'none' ? 'unfollow' : want === 'requested' ? 'request to follow' : 'follow'} ${ACCOUNTS[target].name}`, function* (ctx) {
      const u = ctx.ui.dev;
      u.pending[target] = true;
      Y.L(ctx, { displayed: ['pending', 'The button shows a spinner until the server answers.'], retrySafe: st.config.idem ? ['yes', 'Desired state per (follower, target): a retry changes nothing.'] : ['no', 'Each call inserts an edge and bumps the count.'] });
      const r = yield* ctx.retry({ attempts: 3, baseMs: 200 }, function* () { return yield ctx.call('gateway', 'setFollow', { target, state: want }, { timeout: 900 }); });
      ctx.recordOutcome(r.ok, r.latency);
      delete u.pending[target];
      if (r.ok) {
        u.error = '';
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Edge dev → ${ACCOUNTS[target].name} is “${r.value.state}” on ${ctx.sim.nodes[ACCOUNTS[target].shard].label}.`], async: ['pending', 'Counter update and feed changes.'] });
        ctx.explain(want === 'requested'
          ? `${ACCOUNTS[target].name} is private, so the edge was written as “requested”. Nothing of hers is visible to Dev until she accepts. The edge row lives on the shard that owns her account, so her follower list is one local read.`
          : want === 'active'
            ? `The edge was written as “active” on ${ctx.sim.nodes[ACCOUNTS[target].shard].label} and an event was queued for the counter worker, which keeps follower counts without counting 50 million rows on every profile view.${st.config.backfill ? ' Recent posts by the account were copied into Dev’s feed cache so the feed does not stay empty until the next post.' : ''}`
            : `The edge is gone. ${st.config.removeOnUnfollow ? 'The account’s posts were removed from Dev’s feed cache in the same step' : 'Nothing touched Dev’s feed cache: the posts already fanned out stay there'}; the counter worker will subtract one.`);
      } else {
        u.error = r.error.code === 'TIMEOUT' ? `Couldn’t reach ${ACCOUNTS[target].name}’s account right now. Try again.` : `Couldn’t follow: ${r.error.message}`;
        Y.failed(ctx, 'The button goes back to what it was.');
        ctx.explain(r.error.code === 'TIMEOUT'
          ? `${ctx.sim.nodes[ACCOUNTS[target].shard].label} holds ${ACCOUNTS[target].name}, and ${Y.num(SURGE)} people a second are following her right now. Every write to that shard waits in the same queue, so Dev’s request timed out. Accounts on the other shards are unaffected.`
          : `The follow failed: ${r.error.message}`);
      }
    }, { self: 'dev' });
  }

  function startAccept(sim) {
    const st = sim.state;
    if (edge(st, 'maya') !== 'requested') return;
    sim.startAction('Maya: accept Dev’s request', function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call('gateway', 'accept', { follower: 'dev', target: 'maya' }, { timeout: 1200 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) { Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', 'Edge is now “active”.'], async: ['pending', 'Counter and feed backfill.'] }); ctx.explain(`The edge changed from “requested” to “active”. From now on Maya’s posts fan out to Dev${st.config.backfill ? ', and her recent posts were backfilled into his feed' : ''}.`); }
      else Y.failed(ctx);
    }, { self: 'maya' });
  }

  function startPost(sim, author) {
    const st = sim.state;
    sim.startAction(`${ACCOUNTS[author].name}: post a photo`, function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('gateway', 'post', { author }, { timeout: 1500 });
      if (r.ok) { st.posts[r.value.postId].actionId = ctx.actionId; Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', 'Fanning out to followers.'] }); }
      else Y.failed(ctx);
    }, { self: author === 'maya' ? 'maya' : 'crowd' });
  }

  function setSurge(sim, on) {
    sim.state.surge = on;
    sim.note(on ? `${Y.num(SURGE)} people a second start following ${ACCOUNTS.celeb.name}.` : 'The follower surge is over.');
  }

  const sc = (SDL.scenarios['ig-graph'] = {
    id: 'ig-graph',
    seed: 617,
    productWidth: 620,
    intro: 'Dev follows priya.rao (public) and requests to follow maya.k (private); Maya accepts on her phone. Unfollow, surge the celebrity’s shard, or make the edge cache stale and watch who gets to see a private post.',
    topology: {
      width: 1160, height: 620,
      nodes: [
        { id: 'dev', label: 'Dev’s phone', sub: 'Follows', kind: 'client', x: 90, y: 90, latency: 1, role: 'Follows, unfollows, and reads his feed.', owns: ['What Dev sees'] },
        { id: 'maya', label: 'Maya’s phone', sub: 'Private account', kind: 'client', x: 90, y: 330, latency: 1, role: 'Accepts follow requests and posts.', owns: ['Her posts'] },
        { id: 'crowd', label: 'Everyone else', sub: 'Follower surge', kind: 'client', x: 90, y: 540, latency: 1, role: 'Thousands of people following the celebrity at once.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Mobile API', kind: 'gateway', x: 300, y: 210, latency: 2, role: 'Routes follow, accept, post, and feed calls.', ops: [{ name: 'setFollow', desc: 'Follow, request, or unfollow.' }, { name: 'accept', desc: 'Accept a request.' }, { name: 'post', desc: 'Create a post.' }, { name: 'feed', desc: 'Read a feed.' }], owns: ['Nothing durable'] },
        { id: 'graphsvc', label: 'Graph service', sub: 'Follow rules', kind: 'service', x: 520, y: 90, latency: 4, role: 'Applies privacy rules, writes edges to the right shard, updates the edge cache, backfills and cleans feeds.', ops: [{ name: 'setFollow', desc: 'Change an edge.' }, { name: 'accept', desc: 'Activate a request.' }, { name: 'followers', desc: 'Active followers of an account.' }, { name: 'edge', desc: 'One edge’s state.' }], owns: ['Rules'] },
        { id: 'shard0', label: 'Graph shard 0', sub: 'Accounts a–h', kind: 'db', x: 800, y: 40, latency: 6, serviceMs: 2, role: 'Edges for the accounts it owns, keyed by the followed account.', ops: [{ name: 'set', desc: 'Write an edge.' }, { name: 'get', desc: 'Read an edge.' }, { name: 'count', desc: 'Read a counter.' }], owns: ['edges (a–h)', 'counts'] },
        { id: 'shard1', label: 'Graph shard 1', sub: 'Accounts i–p (maya.k)', kind: 'db', x: 800, y: 150, latency: 6, serviceMs: 2, role: 'Edges for the accounts it owns.', ops: [{ name: 'set', desc: 'Write an edge.' }, { name: 'get', desc: 'Read an edge.' }, { name: 'count', desc: 'Read a counter.' }], owns: ['edges (i–p)', 'counts'] },
        { id: 'shard2', label: 'Graph shard 2', sub: 'Accounts q–z (priya.rao)', kind: 'db', x: 800, y: 260, latency: 6, serviceMs: 2, role: 'Edges for the accounts it owns. A celebrity makes this shard hot.', ops: [{ name: 'set', desc: 'Write an edge.' }, { name: 'get', desc: 'Read an edge.' }, { name: 'count', desc: 'Read a counter.' }], owns: ['edges (q–z)', 'counts'] },
        { id: 'edgecache', label: 'Edge cache', sub: 'is-following lookups', kind: 'cache', x: 520, y: 260, latency: 2, role: 'Caches edge states so fan-out and feed reads do not hit the shards for every check.', ops: [{ name: 'get', desc: 'Cached edge state.' }, { name: 'set', desc: 'Update an entry.' }], owns: ['edge[follower, target]'] },
        { id: 'countq', label: 'Edge events', sub: 'Queue', kind: 'queue', x: 800, y: 400, latency: 3, queue: 'edges', role: '+1 and −1 events for follower counts, written by the shards in the same transaction as the edge.', ops: [], owns: ['event log'] },
        { id: 'counter', label: 'Counter worker', sub: 'Follower counts', kind: 'worker', x: 1020, y: 400, latency: 3, role: 'Applies +1/−1 events to each account’s follower count.', ops: [{ name: 'consume', desc: 'Apply an event.' }], owns: ['Nothing durable'] },
        { id: 'postsdb', label: 'Posts DB', sub: 'Posts by author', kind: 'db', x: 520, y: 450, latency: 6, role: 'Posts. Fan-out asks the graph service who may see each one.', ops: [{ name: 'insert', desc: 'Create a post.' }, { name: 'recent', desc: 'Recent posts by an author.' }], owns: ['posts'] },
        { id: 'feedcache', label: 'Dev’s feed cache', sub: 'Post ids', kind: 'cache', x: 300, y: 450, latency: 3, role: 'Dev’s precomputed feed. Written by fan-out, backfill, and unfollow clean-up.', ops: [{ name: 'push', desc: 'Add post ids.' }, { name: 'removeAuthor', desc: 'Drop an author’s posts.' }, { name: 'read', desc: 'Read the feed.' }], owns: ['feed[dev]'] },
      ],
      edges: [
        { from: 'dev', to: 'gateway', latency: 40 },
        { from: 'maya', to: 'gateway', latency: 40 },
        { from: 'crowd', to: 'gateway', latency: 40 },
        { from: 'gateway', to: 'graphsvc', latency: 4 },
        { from: 'gateway', to: 'postsdb', latency: 4, via: [[300, 330], [420, 330], [420, 450]] },
        { from: 'gateway', to: 'feedcache', latency: 3, label: 'feed' },
        { from: 'graphsvc', to: 'shard0', latency: 4 },
        { from: 'graphsvc', to: 'shard1', latency: 4 },
        { from: 'graphsvc', to: 'shard2', latency: 4 },
        { from: 'graphsvc', to: 'edgecache', latency: 3 },
        { from: 'shard1', to: 'countq', latency: 4, label: 'outbox', via: [[920, 150], [920, 400]] },
        { from: 'shard2', to: 'countq', latency: 4, via: [[920, 260], [920, 400]] },
        { from: 'countq', to: 'counter', latency: 3 },
        { from: 'counter', to: 'shard1', latency: 4, via: [[1020, 150]] },
        { from: 'counter', to: 'shard2', latency: 4, via: [[1020, 260]] },
        { from: 'graphsvc', to: 'postsdb', latency: 4, label: 'backfill' },
        { from: 'postsdb', to: 'graphsvc', latency: 4 },
        { from: 'postsdb', to: 'feedcache', latency: 4, label: 'fan-out' },
        { from: 'graphsvc', to: 'feedcache', latency: 4, via: [[420, 90], [420, 450]] },
      ],
      queues: [{ id: 'edges', broker: 'countq', label: 'edge events', groups: ['counter'] }],
    },
    modeLabels: { stale: 'Serving stale entries' },
    failures: [
      { id: 'shard1-down', node: 'shard1', mode: 'down', label: 'Graph shard 1 down', desc: 'Nobody can follow or unfollow maya.k; other accounts are fine.' },
      { id: 'cache-stale', node: 'edgecache', mode: 'stale', label: 'Edge cache stale', desc: 'Cached edge states stop being updated.' },
      { id: 'counter-paused', node: 'counter', mode: 'paused', label: 'Counter worker paused', desc: 'Follower counts stop changing.' },
      { id: 'shard-drop', node: 'shard2', mode: 'dropResponse', label: 'Shard 2 replies lost', desc: 'Edges are written but the app retries.' },
      { id: 'postsdb-down', node: 'postsdb', mode: 'down', label: 'Posts DB down', desc: 'Nobody can post.' },
    ],
    switches: Y.switches([
      ['idem', 'Follow is desired state', 'One edge row per (follower, target) with a state. Off: each call inserts a row and bumps the count.'],
      ['readFilter', 'Check the edge when reading the feed', 'Before showing a post, confirm Dev still actively follows its author. Off: trust the feed cache.'],
      ['removeOnUnfollow', 'Remove posts on unfollow', 'Unfollowing deletes the account’s posts from Dev’s feed cache. Off: they stay until they age out.'],
      ['backfill', 'Backfill on follow', 'When a follow becomes active, copy the account’s recent posts into Dev’s feed.'],
    ]),
    presets: Y.presets({ idem: true, readFilter: true, removeOnUnfollow: true, backfill: true }, [
      { id: 'follow', label: 'Follow a public account', desc: 'One edge on shard 2, one +1 event, recent posts backfilled into Dev’s feed.', run: (s) => startFollow(s, 'celeb') },
      { id: 'request', label: 'Request, then accept', desc: 'Dev requests to follow private maya.k; she accepts; her recent post appears in Dev’s feed.', run: (s) => { startFollow(s, 'maya'); s.schedule(1500, () => startAccept(s)); } },
      { id: 'unfollow', label: 'Unfollow, posts removed', desc: 'After following and seeing her post, Dev unfollows. Her post leaves his feed in the same step.', run: (s) => { startFollow(s, 'maya'); s.schedule(1500, () => startAccept(s)); s.schedule(3500, () => startFollow(s, 'maya')); } },
      { id: 'unfollow-bad', label: 'Unfollow, nothing cleaned up', desc: 'The edge is gone but the private post already in Dev’s feed cache stays there, and the feed trusts the cache.', sw: { removeOnUnfollow: false, readFilter: false }, run: (s) => { startFollow(s, 'maya'); s.schedule(1500, () => startAccept(s)); s.schedule(3500, () => startFollow(s, 'maya')); } },
      { id: 'unfollow-filter', label: 'Unfollow, nothing cleaned up, read-time check', desc: 'The stale id is still in the cache, but the feed checks the edge before showing the post and drops it.', sw: { removeOnUnfollow: false }, run: (s) => { startFollow(s, 'maya'); s.schedule(1500, () => startAccept(s)); s.schedule(3500, () => startFollow(s, 'maya')); } },
      { id: 'private', label: 'Private post, request not accepted', desc: 'Dev has requested but Maya has not accepted. She posts; fan-out skips him.', run: (s) => { startFollow(s, 'maya'); s.schedule(1500, () => startPost(s, 'maya')); } },
      { id: 'leak', label: 'Stale edge cache, read-time check', desc: 'Dev unfollowed, but the edge cache still says “active”, so fan-out pushes Maya’s new post to him. The feed read checks the shard and hides it.', run: (s) => { startFollow(s, 'maya'); s.schedule(1200, () => startAccept(s)); s.schedule(2500, () => { s.inject('edgecache', 'stale'); startFollow(s, 'maya'); }); s.schedule(4000, () => startPost(s, 'maya')); } },
      { id: 'leak-bad', label: 'Stale edge cache, no read-time check', desc: 'Same, but the feed trusts the cache: Dev sees a private post from someone he no longer follows.', sw: { readFilter: false }, run: (s) => { startFollow(s, 'maya'); s.schedule(1200, () => startAccept(s)); s.schedule(2500, () => { s.inject('edgecache', 'stale'); startFollow(s, 'maya'); }); s.schedule(4000, () => startPost(s, 'maya')); } },
      { id: 'hot', label: 'Follower surge at the celebrity', desc: `${Y.num(SURGE)} follows a second land on shard 2. Dev’s follow of priya.rao times out; his request to maya.k, on shard 1, is instant.`, run: (s) => { setSurge(s, true); s.schedule(800, () => startFollow(s, 'celeb')); s.schedule(1000, () => startFollow(s, 'maya')); s.schedule(6000, () => setSurge(s, false)); } },
      { id: 'counts', label: 'Counter worker paused', desc: 'The edge is written at once; the follower count lags until the worker resumes.', run: (s) => { s.inject('counter', 'paused', true, 4000); startFollow(s, 'celeb'); } },
      { id: 'retry', label: 'Lost reply, desired state', desc: 'The edge is written, the reply is lost, the retry writes the same state: one follower.', run: (s) => { s.inject('shard2', 'dropResponse', true, 600); startFollow(s, 'celeb'); } },
      { id: 'retry-bad', label: 'Lost reply, insert per call', desc: 'Every retry inserts another edge row and another +1: priya.rao gains two followers from one person.', sw: { idem: false }, run: (s) => { s.inject('shard2', 'dropResponse', true, 600); startFollow(s, 'celeb'); } },
    ]),
    initialState: () => ({
      config: { idem: true, readFilter: true, removeOnUnfollow: true, backfill: true },
      edges: { dev: {} }, rows: [], cache: {}, applied: {},
      counts: { maya: 1200, celeb: 50000000 }, surgeCount: 0,
      posts: { P0: { id: 'P0', author: 'maya', caption: 'Chennai mornings', t: -30000 }, P1: { id: 'P1', author: 'celeb', caption: 'Backstage ✨', t: -20000 } },
      feed: [], surge: false,
      stats: { timeouts: 0, filtered: 0, removed: 0, backfilled: 0 },
      seq: { post: 1, ev: 0 },
    }),
    initialUI: () => ({ dev: { pending: {}, error: '', feed: [], hidden: 0 }, maya: { requests: [] } }),
    actions: {
      follow(sim, a) { startFollow(sim, a.target); },
      accept(sim) { startAccept(sim); },
      post(sim, a) { startPost(sim, a.author || 'maya'); },
      surge(sim, a) { setSurge(sim, !!a.on); },
      set: Y.setAction,
    },
    handlers: {
      gateway: {
        setFollow: function* (ctx, p) { return ctx.must(yield ctx.call('graphsvc', 'setFollow', Object.assign({ follower: 'dev' }, p), { timeout: 850 })); },
        accept: function* (ctx, p) { return ctx.must(yield ctx.call('graphsvc', 'accept', p, { timeout: 1100 })); },
        post: function* (ctx, p) { return ctx.must(yield ctx.call('postsdb', 'insert', p, { timeout: 1300 })); },
        feed: function* (ctx) {
          const st = ctx.state;
          const f = ctx.must(yield ctx.call('feedcache', 'read', {}, { timeout: 500 }));
          let ids = f.ids;
          if (st.config.readFilter) {
            const kept = [];
            for (const id of ids) {
              const a = st.posts[id].author;
              if (!ACCOUNTS[a].private) { kept.push(id); continue; }
              const e = ctx.must(yield ctx.call('graphsvc', 'edge', { follower: 'dev', target: a, authoritative: true }, { timeout: 500 }));
              if (e.state === 'active') kept.push(id); else st.stats.filtered++;
            }
            ids = kept;
          }
          return { ids };
        },
      },
      graphsvc: {
        setFollow: function* (ctx, p) {
          const st = ctx.state;
          const acct = ACCOUNTS[p.target];
          const r = ctx.must(yield ctx.call(acct.shard, 'set', Object.assign({ idem: st.config.idem }, p), { timeout: 700 }));
          yield ctx.call('edgecache', 'set', { follower: p.follower, target: p.target, state: p.state }, { timeout: 300 });
          if (p.state === 'active' && r.prev !== 'active' && st.config.backfill) yield* backfill(ctx, p.target);
          if (p.state === 'none' && st.config.removeOnUnfollow) { const x = yield ctx.call('feedcache', 'removeAuthor', { author: p.target }, { timeout: 400 }); if (x.ok) st.stats.removed += x.value.removed; }
          return { state: p.state };
        },
        accept: function* (ctx, p) {
          const st = ctx.state;
          if (edge(st, p.target) !== 'requested') ctx.fail('NO_REQUEST', 'No pending request.');
          ctx.must(yield ctx.call(ACCOUNTS[p.target].shard, 'set', { follower: p.follower, target: p.target, state: 'active', idem: true }, { timeout: 700 }));
          yield ctx.call('edgecache', 'set', { follower: p.follower, target: p.target, state: 'active' }, { timeout: 300 });
          if (st.config.backfill) yield* backfill(ctx, p.target);
          return { state: 'active' };
        },
        followers: function* (ctx, p) {
          // Who may see a post by p.author: the modelled follower (Dev) if the edge is active, checked through the cache.
          const e = ctx.must(yield ctx.call('edgecache', 'get', { follower: 'dev', target: p.author }, { timeout: 300 }));
          let state = e.state;
          if (state == null) { const s = ctx.must(yield ctx.call(ACCOUNTS[p.author].shard, 'get', { follower: 'dev', target: p.author }, { timeout: 600 })); state = s.state; }
          return { users: state === 'active' ? ['dev'] : [], cached: e.state != null };
        },
        edge: function* (ctx, p) {
          if (!p.authoritative) { const e = ctx.must(yield ctx.call('edgecache', 'get', p, { timeout: 300 })); if (e.state != null) return { state: e.state }; }
          return ctx.must(yield ctx.call(ACCOUNTS[p.target].shard, 'get', p, { timeout: 600 }));
        },
      },
      shard0: shardHandler(), shard1: shardHandler(), shard2: shardHandler(),
      edgecache: {
        get(ctx, p) { const v = ctx.state.cache[`${p.follower}/${p.target}`]; return { state: v == null ? null : v }; },
        set(ctx, p) { if (ctx.mode('stale')) return { ignored: true }; ctx.state.cache[`${p.follower}/${p.target}`] = p.state; return { ok: true }; },
      },
      postsdb: {
        insert: function* (ctx, p) {
          const st = ctx.state;
          const id = 'P' + ++st.seq.post;
          st.posts[id] = { id, author: p.author, caption: p.author === 'maya' ? 'Weekend at the lake' : 'On tour', t: ctx.now() };
          const f = yield ctx.call('graphsvc', 'followers', { author: p.author }, { timeout: 800 });
          if (f.ok && f.value.users.includes('dev')) {
            yield ctx.call('feedcache', 'push', { ids: [id], author: p.author }, { timeout: 400 });
            ctx.log({ op: `${id} fanned out to Dev`, status: f.value.cached ? 'note' : 'ok', detail: `The ${f.value.cached ? 'edge cache' : 'graph shard'} said Dev actively follows ${ACCOUNTS[p.author].name}.` });
          } else ctx.log({ op: `${id} not sent to Dev`, status: 'note', detail: `Dev does not actively follow ${ACCOUNTS[p.author].name}.` });
          return { postId: id };
        },
        recent(ctx, p) { return { ids: Object.values(ctx.state.posts).filter((x) => x.author === p.author).map((x) => x.id) }; },
      },
      feedcache: {
        push(ctx, p) { const f = ctx.state.feed; for (const id of p.ids) if (!f.includes(id)) f.push(id); return { ok: true }; },
        removeAuthor(ctx, p) { const st = ctx.state; const before = st.feed.length; st.feed = st.feed.filter((id) => st.posts[id].author !== p.author); return { removed: before - st.feed.length }; },
        read(ctx) { return { ids: ctx.state.feed.slice() }; },
      },
    },
    setup(sim) {
      Y.consumer(sim, 'edges', 'counter', 'counter', function* (ctx, msg) {
        const st = ctx.state;
        const p = msg.payload;
        const r = yield ctx.call(ACCOUNTS[p.target].shard, 'count', { target: p.target, delta: p.delta, eventId: msg.eventId }, { timeout: 800, actionId: msg.actionId });
        if (!r.ok) return false;
        ctx.sim.setLedger(msg.actionId, 'async', 'yes', `${ACCOUNTS[p.target].name} now has ${Y.num(r.value.count)} followers.`);
        return true;
      }, () => true);
      // Dev’s phone refreshes its feed every second (and Maya’s shows pending requests).
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(1000);
          const r = yield ctx.call('gateway', 'feed', {}, { timeout: 1500, quiet: 'all' });
          if (r.ok) { const st = ctx.state; ctx.ui.dev.feed = r.value.ids.map((id) => st.posts[id]).sort((a, b) => b.t - a.t); ctx.ui.dev.hidden = st.feed.length - r.value.ids.length; }
        }
      }, { self: 'dev', quiet: 'all' });
      // The surge: thousands of follows a second at the celebrity's shard.
      Y.load(sim, 'crowd', (s) => (s.state.surge ? SURGE : 0), function* (ctx) {
        const r = yield ctx.call('shard2', 'set', { follower: 'someone', target: 'celeb', state: 'active', idem: true, bulk: true }, { timeout: 900, quiet: 'all' });
        if (r.ok) ctx.state.surgeCount++; else ctx.state.stats.timeouts++;
      });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.dev;
      for (const id of (u.feed || []).map((p) => p.id)) {
        const a = st.posts[id].author;
        if (ACCOUNTS[a].private && edge(st, a) !== 'active') return { key: 'wrong', label: `Dev’s feed shows a private post by ${ACCOUNTS[a].name}, whom he does not follow. A privacy leak.` };
      }
      const depth = sim.queueStats('edges').depth;
      for (const [acct, base] of Object.entries({ maya: 1200, celeb: 50000000 })) {
        const expected = base + (edge(st, acct) === 'active' ? 1 : 0);
        if (st.counts[acct] !== expected && !depth && !sim.nodes.counter.modes.paused && !st.surge) return { key: 'wrong', label: `${ACCOUNTS[acct].name}’s follower count is off by ${st.counts[acct] - expected > 0 ? '+' : ''}${st.counts[acct] - expected}: ${st.counts[acct] - expected > 0 ? 'a retry inserted a second edge row and a second +1' : 'a count event was lost'}.` };
      }
      if (u.error) return { key: 'stale', label: `Dev’s follow failed: ${u.error}` };
      if (depth || sim.nodes.counter.modes.paused) { const lag = Object.keys(ACCOUNTS).find((a) => st.counts[a] !== (a === 'maya' ? 1200 : 50000000) + (edge(st, a) === 'active' ? 1 : 0)); if (lag) return { key: 'stale', label: `${ACCOUNTS[lag].name}’s follower count has not caught up with the edges yet.` }; }
      const leaked = st.feed.filter((id) => ACCOUNTS[st.posts[id].author].private && edge(st, st.posts[id].author) !== 'active');
      if (leaked.length) return { key: 'stale', label: `${leaked.length} private post id${leaked.length > 1 ? 's are' : ' is'} still in Dev’s feed cache after unfollowing. The read-time check hides ${leaked.length > 1 ? 'them' : 'it'}, so Dev sees nothing he should not.` };
      return { key: 'ok', label: 'Edges, counts, caches, and Dev’s feed all agree, and no private post is visible to a non-follower.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const w2 = sim.queueWait('shard2');
      return [
        { label: 'maya.k followers', value: Y.num(st.counts.maya) },
        { label: 'priya.rao followers', value: Y.num(st.counts.celeb) },
        { label: 'Shard 2 queue', value: SDL.fmtMs(w2), tone: w2 > 500 ? 'fail' : w2 > 100 ? 'warn' : '' },
        { label: 'Surge follows timed out', value: Y.num(st.stats.timeouts), tone: st.stats.timeouts ? 'fail' : '' },
        { label: 'Count events waiting', value: sim.queueStats('edges').depth, tone: sim.queueStats('edges').depth ? 'warn' : '' },
        { label: 'Posts hidden at read time', value: st.stats.filtered },
        { label: 'Posts removed on unfollow', value: st.stats.removed },
        { label: 'Posts backfilled', value: st.stats.backfilled },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['dev', 'Dev’s phone'], ['maya', 'Maya’s phone']], {
          note: 'Dev follows from his phone; Maya accepts requests and posts from hers. The console below starts a follower surge at the celebrity.',
          below: `<div class="ops-console"><p class="ops-title">Graph shards</p><div class="ops-traffic">${Y.btn('surge', 'Start follower surge at priya.rao', { arg: { on: true } })}${Y.btn('surge', 'End the surge', { arg: { on: false }, cls: 'secondary' })}</div><div data-ref="shards"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.dev;
        const btn = (t) => {
          const e = edge(st, t);
          const lbl = u.pending[t] ? '<span class="spinner"></span>…' : e === 'active' ? 'Following ✓' : e === 'requested' ? 'Requested' : ACCOUNTS[t].private ? 'Request to follow' : 'Follow';
          return Y.btn('follow', lbl, { arg: { target: t }, cls: e === 'none' ? '' : 'secondary', disabled: !!u.pending[t] });
        };
        const profiles = Object.entries(ACCOUNTS).map(([k, a]) => `<div class="app-card"><span class="app-kv"><strong>${esc(a.name)}${a.private ? ' 🔒' : ''}</strong><span>${Y.num(st.counts[k])} followers</span></span>${btn(k)}</div>`).join('');
        const feed = u.feed.slice(0, 3).map((p) => `<div class="app-card"><strong>${esc(ACCOUNTS[p.author].name)}</strong><div class="yt-thumb" style="--h:${ACCOUNTS[p.author].hue};height:60px"><span aria-hidden="true">◉</span></div><span class="app-sub">${esc(p.caption)}</span></div>`).join('');
        Y.paint(el, sim, 'dev', {
          head: '<div><p class="app-title">Instagram</p><p class="app-sub">Dev</p></div>',
          profiles, msg: Y.msg(u.error, 'fail'),
          feed: `<p class="app-sub">Home feed${u.hidden ? ` · ${u.hidden} hidden by the read-time check` : ''}</p>${feed || '<p class="app-sub">Nothing from accounts you follow yet.</p>'}`,
        }, {});
        const req = edge(st, 'maya') === 'requested';
        Y.paint(el, sim, 'maya', {
          head: '<div><p class="app-title">Instagram</p><p class="app-sub">maya.k 🔒 private</p></div>',
          requests: req ? `<div class="app-card is-hot"><strong>Follow request</strong><span class="app-sub">dev wants to follow you</span>${Y.btn('accept', 'Accept', { cls: 'go' })}</div>` : `<p class="app-sub">No follow requests. ${edge(st, 'maya') === 'active' ? 'dev follows you.' : ''}</p>`,
          post: Y.btn('post', 'Post a photo', { arg: { author: 'maya' }, cls: 'secondary' }),
          mine: `<p class="app-sub">Your posts</p>${Object.values(st.posts).filter((p) => p.author === 'maya').slice(-2).reverse().map((p) => `<div class="app-card"><strong>${esc(p.id)}</strong><span class="app-sub">${esc(p.caption)} · ${st.feed.includes(p.id) ? 'in dev’s feed cache' : 'not in dev’s feed cache'}</span></div>`).join('')}`,
        }, {});
        const c = sim.scenario.consistency(sim);
        const shards = ['shard0', 'shard1', 'shard2'].map((s) => { const w = sim.queueWait(s); return `<div class="ops-row" data-tone="${w > 500 ? 'fail' : w > 100 ? 'warn' : ''}"><div class="ops-name">${esc(sim.nodes[s].label)}<span>${esc(sim.nodes[s].sub)} · queue ${Math.round(w)} ms${s === 'shard2' && st.surge ? ` · ${Y.num(SURGE)} follows/s` : ''}</span></div></div>`; }).join('');
        SDL.ui.paintSections(el.querySelector('[data-ref="shards"]'), {
          rows: `<div class="ops-shards">${shards}</div>`,
          cache: `<p class="app-sub">Edge cache dev → maya.k: ${esc(st.cache['dev/maya'] || 'not cached')} · shard: ${esc(edge(st, 'maya'))}${st.cache['dev/maya'] && st.cache['dev/maya'] !== edge(st, 'maya') ? ' ✕ stale' : ''}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  function* backfill(ctx, target) {
    const st = ctx.state;
    const r = yield ctx.call('postsdb', 'recent', { author: target }, { timeout: 600 });
    if (!r.ok || !r.value.ids.length) return;
    const x = yield ctx.call('feedcache', 'push', { ids: r.value.ids, author: target }, { timeout: 400 });
    if (x.ok) st.stats.backfilled += r.value.ids.length;
  }
  function shardHandler() {
    return {
      set(ctx, p) {
        const st = ctx.state;
        if (p.bulk) return { state: 'active' };
        const prev = edge(st, p.target);
        let delta;
        if (p.idem) { st.edges.dev[p.target] = p.state === 'none' ? undefined : p.state; delta = (p.state === 'active' ? 1 : 0) - (prev === 'active' ? 1 : 0); }
        else {
          // Insert-per-call: a repeated call adds another row and another +1.
          st.edges.dev[p.target] = p.state === 'none' ? undefined : p.state;
          st.rows.push(`${p.follower}/${p.target}/${p.state}`);
          delta = p.state === 'active' ? 1 : prev === 'active' ? -1 : 0;
        }
        // The count event is written in the same transaction as the edge (an outbox), so a lost reply cannot lose it.
        if (delta) ctx.sim.enqueue('edges', { type: 'edge', eventId: 'e' + ++st.seq.ev, payload: { target: p.target, delta }, actionId: ctx.actionId });
        return { state: p.state, prev };
      },
      get(ctx, p) { return { state: edge(ctx.state, p.target) }; },
      count(ctx, p) {
        // Idempotent by event id: a redelivered event (for example after a lost reply) is applied once.
        const st = ctx.state;
        if (st.applied[p.eventId]) return { count: st.counts[p.target], replayed: true };
        st.applied[p.eventId] = true;
        st.counts[p.target] += p.delta;
        return { count: st.counts[p.target] };
      },
    };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
