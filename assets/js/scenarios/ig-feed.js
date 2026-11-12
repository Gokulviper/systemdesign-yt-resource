/*
 * Home feed and fan-out.
 * Dev follows 300 accounts. Under fan-out on write, every new post is copied
 * into each follower's feed cache and a feed read is one cache lookup. Under
 * fan-out on read, a feed read walks the following list and pulls recent
 * posts from the posts database. Hybrid does the first for ordinary accounts
 * and the second for accounts with millions of followers. A ranking service
 * orders the result under a deadline, and pages are cut by offset or by
 * cursor, which matters when a new post arrives between two pages.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const FOLLOWING = 300;
  const PAGE = 5;
  const RANK_BUDGET = 200;
  const MS_PER_MILLION = 400;
  const PULL_MS_PER_AUTHOR = 3; // reading one author's recent posts from the posts database
  const ACCOUNTS = {
    maya: { name: 'maya.k', followers: 1200, hue: 330 },
    celeb: { name: 'priya.rao', followers: 50000000, hue: 40 },
    others: { name: 'friends', followers: 800, hue: 190 },
  };
  const CAPTIONS = ['Weekend hike', 'Coffee first', 'New kicks', 'Sunset run', 'Book club', 'Street food', 'Rainy day', 'Studio session', 'Market finds', 'Late train'];

  function startPost(sim, author, caption) {
    const st = sim.state;
    sim.startAction(`${ACCOUNTS[author].name}: post a photo`, function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('postsdb', 'insert', { author, caption: caption || 'New post' }, { timeout: 800 });
      if (r.ok) {
        st.posts[r.value.id].actionId = ctx.actionId;
        Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', 'Reaching followers’ feeds.'] });
        yield ctx.call('fanq', 'publish', { postId: r.value.id, author }, { timeout: 600 });
      } else Y.failed(ctx);
    }, { self: 'creators' });
  }

  function startOpen(sim) {
    sim.startAction('Dev: open the feed', function* (ctx) {
      const u = ctx.ui.dev;
      Object.assign(u, { loading: true, error: '', page: 1 });
      Y.L(ctx, { displayed: 'pending', committed: ['n/a', 'Reading writes nothing.'], async: 'n/a', retrySafe: 'yes' });
      const t0 = ctx.now();
      const r = yield ctx.call('gateway', 'feed', { user: 'dev', offset: 0, cursor: null }, { timeout: 2500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.loading = false;
      if (!r.ok) { Object.assign(u, { error: `Couldn’t load the feed: ${r.error.message}`, items: [] }); Y.failed(ctx, 'Shows an error.'); return; }
      const v = r.value;
      Object.assign(u, { items: v.items, cursor: v.cursor, ms: ctx.now() - t0, source: v.source, fallback: v.fallback, openedAt: ctx.now() });
      Y.L(ctx, { displayed: ['yes', `${v.items.length} posts in ${Math.round(ctx.now() - t0)} ms.`], accepted: 'yes' });
      ctx.explain(`${v.source === 'cache' ? 'One read of Dev’s feed cache gave the candidate post ids' : v.source === 'cache+pull' ? 'Dev’s feed cache gave most candidates; the celebrity account was pulled from the posts database because it is not fanned out' : `Dev follows ${FOLLOWING} accounts, so the feed service read the following list and pulled recent posts for every one of them from the posts database: ${Math.round(ctx.now() - t0)} ms`}. ${v.fallback ? `The ranking service missed its ${RANK_BUDGET} ms budget, so the posts are in chronological order instead.` : 'The ranking service then ordered them.'}`);
    }, { self: 'dev' });
  }

  function startMore(sim) {
    const u = sim.ui.dev;
    if (!u.items.length || u.loading) return;
    sim.startAction(`Dev: load page ${u.page + 1}`, function* (ctx) {
      const st = ctx.state;
      const v = ctx.ui.dev;
      v.loading = true;
      Y.L(ctx, { displayed: 'pending', committed: 'n/a', async: 'n/a', retrySafe: 'yes' });
      const r = yield ctx.call('gateway', 'feed', { user: 'dev', offset: v.items.length, cursor: st.config.cursor ? v.cursor : null }, { timeout: 2500 });
      ctx.recordOutcome(r.ok, r.latency);
      v.loading = false;
      if (!r.ok) { v.error = `Couldn’t load more: ${r.error.message}`; Y.failed(ctx); return; }
      const seen = new Set(v.items.map((x) => x.id));
      const dups = r.value.items.filter((x) => seen.has(x.id));
      v.items = v.items.concat(r.value.items);
      v.cursor = r.value.cursor;
      v.page++;
      v.dups += dups.length;
      v.ms = r.latency;
      Y.L(ctx, { displayed: ['yes', `${r.value.items.length} more posts${dups.length ? `, ${dups.length} already shown` : ''}.`], accepted: 'yes' });
      ctx.explain(st.config.cursor
        ? `Page ${v.page} asked for posts older than the last one Dev saw (a cursor). New posts that arrived meanwhile go above, not into this page, so nothing repeats or disappears.`
        : dups.length
          ? `Page ${v.page} asked for items ${v.items.length - r.value.items.length} to ${v.items.length} by position. A new post arrived since page 1, pushing everything down one place: the last post of page 1 is now the first of page 2, shown twice. Had a post been deleted instead, one would have been skipped.`
          : `Page ${v.page} was cut by position. Nothing changed between the pages, so it happened to be right; offsets only break when the list moves.`);
    }, { self: 'dev' });
  }

  const sc = (SDL.scenarios['ig-feed'] = {
    id: 'ig-feed',
    seed: 613,
    productWidth: 600,
    intro: 'Open Dev’s feed, then load more. Make Maya or the celebrity post from the console and open the feed again. Turn fan-out on write off to see what pulling costs, or make the celebrity post with hybrid off.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'dev', label: 'Dev’s phone', sub: `Follows ${FOLLOWING}`, kind: 'client', x: 90, y: 90, latency: 1, role: 'Opens the home feed and pages through it.', owns: ['What Dev sees'] },
        { id: 'creators', label: 'Accounts Dev follows', sub: 'Maya, friends, a celebrity', kind: 'client', x: 90, y: 440, latency: 1, role: 'Maya (1,200 followers), 298 friends, and priya.rao (50M followers).', owns: ['Their posts'] },
        { id: 'gateway', label: 'API gateway', sub: 'Mobile API', kind: 'gateway', x: 300, y: 90, latency: 2, role: 'Routes feed reads.', ops: [{ name: 'feed', desc: 'A page of the home feed.' }], owns: ['Nothing durable'] },
        { id: 'feedsvc', label: 'Feed service', sub: 'Assembles a page', kind: 'service', x: 520, y: 90, latency: 4, role: 'Gets candidate post ids from the cache or by pulling, asks the ranker to order them, and cuts a page by offset or cursor.', ops: [{ name: 'feed', desc: 'Build a page.' }], owns: ['Page rules'] },
        { id: 'ranker', label: 'Ranking service', sub: `${RANK_BUDGET} ms budget`, kind: 'service', x: 520, y: 260, latency: 15, serviceMs: 15, role: 'Scores candidates by predicted interest. Slow or down, the feed falls back to chronological order.', ops: [{ name: 'rank', desc: 'Order candidates.' }], owns: ['Model'] },
        { id: 'feedcache', label: 'Feed cache', sub: 'Per user, post ids', kind: 'cache', x: 800, y: 40, latency: 3, role: 'The precomputed list of post ids for each user, written by fan-out.', ops: [{ name: 'read', desc: 'Read a feed.' }, { name: 'push', desc: 'Add a post id.' }], owns: ['feed[user]'] },
        { id: 'graph', label: 'Follow graph', sub: 'Following lists', kind: 'db', x: 800, y: 170, latency: 6, role: 'Who Dev follows and who follows each author.', ops: [{ name: 'following', desc: 'Accounts a user follows.' }, { name: 'followers', desc: 'Followers of an author.' }], owns: ['edges'] },
        { id: 'postsdb', label: 'Posts DB', sub: 'Sharded by author', kind: 'db', x: 800, y: 300, latency: 6, role: 'Posts by author. Pulling a feed reads it once per followed account.', ops: [{ name: 'insert', desc: 'Create a post.' }, { name: 'recent', desc: 'Recent posts by authors.' }], owns: ['posts'] },
        { id: 'fanq', label: 'Fan-out jobs', sub: 'Queue', kind: 'queue', x: 300, y: 440, latency: 4, queue: 'fan', role: 'One job per new post. May deliver a job twice.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['job log'] },
        { id: 'fanout', label: 'Fan-out workers', sub: 'Write feed caches', kind: 'worker', x: 520, y: 440, latency: 4, role: 'Writes a post id into every follower’s feed cache. Work grows with followers.', ops: [{ name: 'consume', desc: 'Fan one post out.' }], owns: ['Nothing durable'] },
        { id: 'celebcache', label: 'Celebrity posts', sub: 'Recent posts, big accounts', kind: 'cache', x: 1020, y: 170, latency: 3, role: 'Recent posts of accounts that are never fanned out, so pulling them at read time is one cheap read.', ops: [{ name: 'recent', desc: 'Recent celebrity posts.' }, { name: 'add', desc: 'Record a post.' }], owns: ['recent[author]'] },
      ],
      edges: [
        { from: 'dev', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'feedsvc', latency: 4 },
        { from: 'feedsvc', to: 'ranker', latency: 4 },
        { from: 'feedsvc', to: 'feedcache', latency: 4 },
        { from: 'feedsvc', to: 'graph', latency: 4 },
        { from: 'feedsvc', to: 'postsdb', latency: 5, label: 'pull' },
        { from: 'feedsvc', to: 'celebcache', latency: 5, via: [[640, 20], [1020, 20]] },
        { from: 'creators', to: 'postsdb', latency: 30, via: [[90, 560], [800, 560]] },
        { from: 'creators', to: 'fanq', latency: 30 },
        { from: 'fanq', to: 'fanout', latency: 4 },
        { from: 'fanout', to: 'graph', latency: 4 },
        { from: 'fanout', to: 'feedcache', latency: 4, via: [[700, 440], [700, 40]] },
        { from: 'fanout', to: 'celebcache', latency: 5, via: [[1020, 440]] },
      ],
      queues: [{ id: 'fan', broker: 'fanq', label: 'fan-out', groups: ['fanout'] }],
    },
    failures: [
      { id: 'fanout-paused', node: 'fanout', mode: 'paused', label: 'Fan-out workers paused', desc: 'New posts stop reaching feed caches.' },
      { id: 'cache-down', node: 'feedcache', mode: 'down', label: 'Feed cache down', desc: 'Feeds must be pulled.' },
      { id: 'rank-slow', node: 'ranker', mode: 'slow', params: { factor: 30 }, label: 'Ranking slow', desc: 'Every ranking call blows its budget.' },
      { id: 'rank-down', node: 'ranker', mode: 'down', label: 'Ranking down', desc: 'Nothing can be ranked.' },
      { id: 'dup', node: 'fanq', mode: 'duplicate', label: 'Fan-out jobs delivered twice', desc: 'Every job is processed twice.' },
      { id: 'graph-slow', node: 'graph', mode: 'slow', params: { factor: 30 }, label: 'Follow graph slow', desc: 'Pulls and fan-out wait on it.' },
      { id: 'postsdb-slow', node: 'postsdb', mode: 'slow', params: { factor: 10 }, label: 'Posts DB slow', desc: 'Pulling a feed becomes very slow.' },
    ],
    switches: Y.switches([
      ['push', 'Fan-out on write', 'Copy each new post id into every follower’s feed cache. Off: build every feed by pulling from the posts database.'],
      ['hybrid', 'Hybrid: pull celebrities', 'Accounts over 1 million followers are not fanned out; their recent posts are pulled from a small cache at read time.'],
      ['deadline', 'Ranking deadline', `Give the ranker ${RANK_BUDGET} ms; past that, show chronological order. Off: wait for the ranker.`],
      ['cursor', 'Cursor pagination', 'Page 2 asks for posts older than the last one shown. Off: ask for items 5 to 10 by position.'],
    ]),
    presets: Y.presets({ push: true, hybrid: true, deadline: true, cursor: true }, [
      { id: 'open', label: 'Open the feed, fan-out on write', desc: 'One cache read, one ranking call: a page in well under 300 ms.', run: (s) => startOpen(s) },
      { id: 'pull', label: 'Open the feed, fan-out on read', desc: `No cache: the feed service pulls recent posts for all ${FOLLOWING} accounts Dev follows. Correct, complete, and slow.`, sw: { push: false }, run: (s) => startOpen(s) },
      { id: 'celebrity', label: 'Celebrity posts, hybrid', desc: 'priya.rao’s post goes into a small celebrity cache, not 50 million feed caches. Maya’s post right after is in Dev’s feed in a second.', run: (s) => { startPost(s, 'celeb', 'Backstage ✨'); s.schedule(300, () => startPost(s, 'maya', 'Golden hour')); s.schedule(2500, () => startOpen(s)); } },
      { id: 'celebrity-bad', label: 'Celebrity posts, fan-out on write', desc: '50 million feed-cache writes take about 20 s, and Maya’s post waits behind them. Dev’s feed has neither.', sw: { hybrid: false }, run: (s) => { startPost(s, 'celeb', 'Backstage ✨'); s.schedule(300, () => startPost(s, 'maya', 'Golden hour')); s.schedule(2500, () => startOpen(s)); } },
      { id: 'rank-slow', label: 'Ranking slow, with a deadline', desc: 'The ranker misses its budget; the feed shows posts in chronological order on time.', run: (s) => { s.inject('ranker', 'slow', { factor: 30 }); startOpen(s); } },
      { id: 'rank-slow-bad', label: 'Ranking slow, no deadline', desc: 'The feed waits for the ranker: a second-long spinner for a perfectly ordered page.', sw: { deadline: false }, run: (s) => { s.inject('ranker', 'slow', { factor: 30 }); startOpen(s); } },
      { id: 'rank-down', label: 'Ranking down', desc: 'The ranker fails fast and the feed falls back to chronological order.', run: (s) => { s.inject('ranker', 'down'); startOpen(s); } },
      { id: 'dup', label: 'Fan-out jobs delivered twice', desc: 'Each job runs twice. The feed cache is a set of post ids, so the second run changes nothing.', run: (s) => { s.inject('fanq', 'duplicate'); startPost(s, 'maya', 'Golden hour'); s.schedule(1500, () => startOpen(s)); } },
      { id: 'offset-bad', label: 'New post between pages, offset paging', desc: 'Dev reads page 1, Maya posts, Dev loads page 2 by position: the last post of page 1 appears again.', sw: { cursor: false }, run: (s) => { startOpen(s); s.schedule(1000, () => startPost(s, 'maya', 'Golden hour')); s.schedule(2500, () => startMore(s)); } },
      { id: 'cursor', label: 'New post between pages, cursor paging', desc: 'Page 2 asks for posts older than the last one shown. The new post waits at the top; nothing repeats.', run: (s) => { startOpen(s); s.schedule(1000, () => startPost(s, 'maya', 'Golden hour')); s.schedule(2500, () => startMore(s)); } },
      { id: 'fanout-paused', label: 'Fan-out workers paused', desc: 'Maya posts; the job waits in the queue; Dev’s feed does not have it.', run: (s) => { s.inject('fanout', 'paused'); startPost(s, 'maya', 'Golden hour'); s.schedule(2500, () => startOpen(s)); } },
      { id: 'cache-down', label: 'Feed cache down', desc: 'The feed service pulls instead. Nothing is lost, but every feed open costs hundreds of database reads.', run: (s) => { s.inject('feedcache', 'down'); startOpen(s); } },
    ]),
    initialState: () => {
      const posts = {};
      const feed = [];
      for (let i = 0; i < 12; i++) { const id = 'P' + (i + 1); posts[id] = { id, author: 'others', caption: CAPTIONS[i % CAPTIONS.length], t: -60000 + i * 5000, friend: `friend_${(i * 37) % 298}` }; feed.push(id); }
      return {
        config: { push: true, hybrid: true, deadline: true, cursor: true },
        posts, feeds: { dev: feed }, celebRecent: [], seq: { post: 12 },
        stats: { fanWrites: 0, dupSkipped: 0, pulls: 0, pullReads: 0, rankFallbacks: 0 },
      };
    },
    initialUI: () => ({ dev: { items: [], page: 0, cursor: null, ms: null, source: '', fallback: false, loading: false, error: '', dups: 0, openedAt: 0 } }),
    actions: {
      open(sim) { startOpen(sim); },
      more(sim) { startMore(sim); },
      post(sim, a) { startPost(sim, a.author, a.caption); },
      set: Y.setAction,
    },
    handlers: {
      gateway: { feed: function* (ctx, p) { return ctx.must(yield ctx.call('feedsvc', 'feed', p, { timeout: 2400 })); } },
      feedsvc: {
        feed: function* (ctx, p) {
          const st = ctx.state;
          let ids;
          let source;
          if (st.config.push) {
            const c = yield ctx.call('feedcache', 'read', { user: p.user }, { timeout: 500 });
            if (c.ok) { ids = c.value.ids.slice(); source = 'cache'; }
          }
          if (!ids) {
            st.stats.pulls++;
            const f = ctx.must(yield ctx.call('graph', 'following', { user: p.user }, { timeout: 1000 }));
            const r = ctx.must(yield ctx.call('postsdb', 'recent', { authors: f.authors, pull: true }, { timeout: 2000 }));
            ids = r.ids;
            source = 'pull';
          } else if (st.config.hybrid) {
            const cc = yield ctx.call('celebcache', 'recent', { authors: ['celeb'] }, { timeout: 400 });
            if (cc.ok && cc.value.ids.length) { ids = ids.concat(cc.value.ids); source = 'cache+pull'; }
          }
          ids = [...new Set(ids)];
          let ordered = ids.slice().sort((a, b) => st.posts[b].t - st.posts[a].t);
          let fallback = false;
          const rk = yield ctx.call('ranker', 'rank', { ids: ordered }, { timeout: st.config.deadline ? RANK_BUDGET : 2000 });
          if (rk.ok) ordered = rk.value.ids; else { fallback = true; st.stats.rankFallbacks++; }
          let page;
          if (p.cursor) { const i = ordered.indexOf(p.cursor); page = ordered.slice(i + 1, i + 1 + PAGE); }
          else page = ordered.slice(p.offset, p.offset + PAGE);
          return { items: page.map((id) => st.posts[id]), cursor: page.length ? page[page.length - 1] : p.cursor, source, fallback };
        },
      },
      ranker: {
        rank(ctx, p) {
          // Newest first, but a followed friend's post gets a small boost over strangers and old celebrity posts a small penalty.
          const st = ctx.state;
          const score = (id) => st.posts[id].t + (st.posts[id].author === 'maya' ? 3000 : 0) - (st.posts[id].author === 'celeb' ? 2000 : 0);
          return { ids: p.ids.slice().sort((a, b) => score(b) - score(a)) };
        },
      },
      feedcache: {
        read(ctx, p) { return { ids: ctx.state.feeds[p.user] }; },
        push(ctx, p) { const f = ctx.state.feeds[p.user]; if (f.includes(p.postId)) { ctx.state.stats.dupSkipped++; return { added: false }; } f.push(p.postId); return { added: true }; },
      },
      graph: {
        following() { return { authors: ['maya', 'celeb', 'others'], count: FOLLOWING }; },
        followers(ctx, p) { return { count: ACCOUNTS[p.author].followers, users: ['dev'] }; },
      },
      postsdb: {
        insert(ctx, p) { const st = ctx.state; const id = 'P' + ++st.seq.post; st.posts[id] = { id, author: p.author, caption: p.caption, t: ctx.now() }; return { id }; },
        recent: function* (ctx, p) {
          const st = ctx.state;
          if (p.pull) { st.stats.pullReads += FOLLOWING; yield ctx.wait(FOLLOWING * PULL_MS_PER_AUTHOR); }
          return { ids: Object.values(st.posts).filter((x) => p.authors.includes(x.author)).map((x) => x.id) };
        },
      },
      celebcache: {
        recent(ctx) { return { ids: ctx.state.celebRecent.slice() }; },
        add(ctx, p) { if (!ctx.state.celebRecent.includes(p.postId)) ctx.state.celebRecent.push(p.postId); return { ok: true }; },
      },
      fanq: { publish(ctx, p) { ctx.sim.enqueue('fan', { type: 'post.created', eventId: 'fan-' + p.postId, payload: p, actionId: ctx.actionId }); return { appended: true }; } },
    },
    setup(sim) {
      Y.consumer(sim, 'fan', 'fanout', 'fanout', function* (ctx, msg) {
        const st = ctx.state;
        const p = msg.payload;
        if (!st.config.push) { ctx.log({ op: `no fan-out for ${p.postId}`, status: 'note', actionId: msg.actionId, detail: 'Fan-out on write is off: feeds pull at read time.' }); ctx.sim.setLedger(msg.actionId, 'async', 'n/a', 'Pulled at read time.'); return true; }
        const g = yield ctx.call('graph', 'followers', { author: p.author }, { timeout: 1000, actionId: msg.actionId });
        if (!g.ok) return false;
        if (st.config.hybrid && g.value.count > 1e6) {
          const r = yield ctx.call('celebcache', 'add', { postId: p.postId }, { timeout: 500, actionId: msg.actionId });
          ctx.log({ op: `${p.postId} recorded in the celebrity cache`, status: 'note', actionId: msg.actionId, detail: `${ACCOUNTS[p.author].name} has ${Y.num(g.value.count)} followers. One write instead of ${Y.num(g.value.count)}; every follower’s feed read pulls it.` });
          ctx.sim.setLedger(msg.actionId, 'async', 'yes', 'In the celebrity cache: pulled at read time.');
          return r.ok;
        }
        const work = (g.value.count / 1e6) * MS_PER_MILLION;
        if (work > 100) ctx.log({ op: `writing ${Y.num(g.value.count)} feed caches for ${p.postId}`, status: 'note', actionId: msg.actionId, detail: `About ${(work / 1000).toFixed(0)} s of writes. Every post behind it waits.` });
        yield ctx.wait(Math.max(1, work));
        for (const u of g.value.users) {
          const r = yield ctx.call('feedcache', 'push', { user: u, postId: p.postId }, { timeout: 600, actionId: msg.actionId });
          if (!r.ok) return false;
          if (!r.value.added) ctx.log({ op: `${p.postId} already in Dev’s feed`, status: 'dup', actionId: msg.actionId, detail: 'The feed cache is a set: the duplicate job changed nothing.' });
        }
        st.stats.fanWrites += g.value.count;
        ctx.sim.setLedger(msg.actionId, 'async', 'yes', `In ${Y.num(g.value.count)} feed caches ${((ctx.now() - st.posts[p.postId].t) / 1000).toFixed(1)} s after posting.`);
        return true;
      }, () => false); // no consumer-side dedupe: the feed cache's set semantics absorb duplicates
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.dev;
      if (u.dups) return { key: 'wrong', label: `${u.dups} post${u.dups > 1 ? 's appear' : ' appears'} twice in Dev’s feed: page 2 was cut by position after a new post shifted the list.` };
      const ids = u.items.map((x) => x.id);
      if (new Set(ids).size !== ids.length) return { key: 'wrong', label: 'A post appears twice in Dev’s feed.' };
      const feedIds = new Set(st.feeds.dev.concat(st.celebRecent));
      if (u.error) return { key: 'stale', label: 'Dev’s feed did not load.' };
      const missing = Object.values(st.posts).filter((p) => p.t >= 0 && sim.now - p.t > 2500 && st.config.push && !feedIds.has(p.id));
      if (missing.length) return { key: 'stale', label: `${missing.map((p) => p.id).join(', ')} posted ${((sim.now - missing[0].t) / 1000).toFixed(1)} s ago and not in Dev’s feed cache yet${sim.queueStats('fan').depth ? ` (${sim.queueStats('fan').depth} fan-out job${sim.queueStats('fan').depth > 1 ? 's' : ''} waiting)` : ''}.` };
      if (u.ms != null && u.ms > 700) return { key: 'stale', label: `The feed took ${Math.round(u.ms)} ms to load: correct, but far over the 300 ms target.` };
      if (u.fallback) return { key: 'ok', label: 'The feed is complete and in chronological order: ranking missed its deadline, so the page shipped without it.' };
      return { key: 'ok', label: 'The feed is complete, in ranked order, with no post repeated or skipped.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const u = sim.ui.dev;
      return [
        { label: 'Feed load', value: u.ms == null ? 'n/a' : SDL.fmtMs(u.ms), tone: u.error ? 'fail' : u.ms > 700 ? 'fail' : u.ms > 300 ? 'warn' : 'ok' },
        { label: 'Source', value: u.source || 'n/a' },
        { label: 'Fan-out backlog', value: sim.queueStats('fan').depth, tone: sim.queueStats('fan').depth ? 'warn' : '' },
        { label: 'Feed-cache writes', value: Y.num(st.stats.fanWrites) },
        { label: 'Posts DB reads for pulls', value: Y.num(st.stats.pullReads) },
        { label: 'Ranking fallbacks', value: st.stats.rankFallbacks },
        { label: 'Duplicate jobs ignored', value: st.stats.dupSkipped },
        { label: 'Posts shown', value: u.items.length },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['dev', 'Dev’s phone']], {
          note: 'Open the feed and load more pages. The console makes accounts Dev follows post.',
          side: `<p class="ops-title">Accounts Dev follows</p><div class="ops-traffic">
            ${Y.btn('post', 'maya.k posts', { arg: { author: 'maya', caption: 'Golden hour' } })}
            ${Y.btn('post', 'a friend posts', { arg: { author: 'others', caption: 'Lunch!' }, cls: 'secondary' })}
            ${Y.btn('post', 'priya.rao (50M) posts', { arg: { author: 'celeb', caption: 'Backstage ✨' } })}
          </div><div data-ref="fan"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.dev;
        const seen = new Set();
        const items = u.items.map((p) => {
          const dup = seen.has(p.id); seen.add(p.id);
          return `<div class="app-card ${dup ? 'is-fail' : ''}"><strong>${esc(p.author === 'others' ? p.friend || 'a friend' : ACCOUNTS[p.author].name)}</strong><div class="yt-thumb" style="--h:${ACCOUNTS[p.author].hue};height:70px"><span aria-hidden="true">◉</span></div><span class="app-sub">${esc(p.caption)}${p.t >= 0 ? ' · new' : ''}${dup ? ' · ✕ shown twice' : ''}</span></div>`;
        }).join('');
        Y.paint(el, sim, 'dev', {
          head: `<div><p class="app-title">Instagram</p><p class="app-sub">Home${u.source ? ` · ${esc(u.source)}${u.fallback ? ', chronological' : ''}` : ''}</p></div>`,
          open: u.loading ? '<div class="app-card is-work"><strong><span class="spinner"></span>Loading…</strong></div>' : Y.btn('open', u.items.length ? 'Refresh feed' : 'Open feed', { cls: u.items.length ? 'secondary' : '' }),
          msg: Y.msg(u.error, 'fail'),
          items, more: u.items.length && !u.loading ? Y.btn('more', 'Load more', { cls: 'secondary' }) : '',
        }, {});
        const q = sim.queueStats('fan');
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="fan"]'), {
          q: `<div class="ops-row" data-tone="${q.depth ? 'warn' : ''}"><div class="ops-name">Fan-out queue<span>${q.depth} job${q.depth === 1 ? '' : 's'} waiting · ${Y.num(st.stats.fanWrites)} feed-cache writes</span></div></div>
              <div class="ops-row"><div class="ops-name">Dev’s feed cache<span>${st.feeds.dev.length} post ids${st.celebRecent.length ? ` + ${st.celebRecent.length} in the celebrity cache` : ''}</span></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
