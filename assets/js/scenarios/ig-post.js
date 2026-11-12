/*
 * End-to-end: post to feed.
 * Maya picks a photo; the app uploads it to the object store while she writes
 * the caption. “Share” creates the post, which is fanned out into each
 * follower's feed cache. Dev's phone refreshes its feed every second and
 * loads images through the CDN. A like becomes an activity on Maya's phone.
 * A celebrity account with 50 million followers shows why fan-out on write
 * cannot be the only model. The deep-dive labs take each piece further.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const ACCOUNTS = {
    maya: { name: 'maya.k', followers: 1200, hue: 330 },
    celeb: { name: 'priya.rao', followers: 50000000, hue: 40 },
  };
  const MS_PER_MILLION = 400; // feed-cache writes: about 2,500 per millisecond
  const UPLOAD_MS = 900; // a 2 MB photo on a mobile connection

  function startPick(sim) {
    const u = sim.ui.maya;
    if (u.photo) return;
    Object.assign(u, { photo: 'sunset', mediaId: null, uploading: false, caption: 'Golden hour over Marina Beach' });
    if (sim.state.config.preUpload) uploadNow(sim);
    else sim.note('Photo picked. Upload before share is off, so nothing happens until Maya taps Share.');
  }

  function uploadNow(sim) {
    const u = sim.ui.maya;
    u.uploading = true;
    sim.spawn(function* (ctx) {
      const r = yield ctx.call('gateway', 'upload', { bytes: 2e6 }, { timeout: 4000 });
      const v = ctx.ui.maya;
      v.uploading = false;
      if (r.ok) { v.mediaId = r.value.mediaId; ctx.log({ op: 'photo uploaded in the background', status: 'ok', detail: `${r.value.mediaId} is in the object store before Maya has finished typing.` }); }
      else v.uploadError = r.error.message;
    }, { self: 'maya' });
  }

  function startShare(sim) {
    const u = sim.ui.maya;
    if (!u.photo || u.sharing) return;
    sim.startAction('Maya: share the photo', function* (ctx) {
      const st = ctx.state;
      const v = ctx.ui.maya;
      const t0 = ctx.now();
      Object.assign(v, { sharing: true, error: '' });
      Y.L(ctx, { displayed: ['pending', 'Shows “Sharing…”.'], retrySafe: ['yes', 'The post carries a client id; a retry returns the same post.'] });
      let mediaId = v.mediaId;
      if (!mediaId) {
        if (v.uploading) { while (ctx.ui.maya.uploading) yield ctx.wait(20); mediaId = ctx.ui.maya.mediaId; }
        if (!mediaId) {
          const up = yield ctx.call('gateway', 'upload', { bytes: 2e6 }, { timeout: 4000 });
          if (!up.ok) {
            Object.assign(v, { sharing: false, error: 'Couldn’t upload your photo. Check your connection and try again.' });
            Y.failed(ctx, 'Shows an error; nothing was posted.');
            ctx.explain('The object store refused the upload, so no post was created. The failure is clean: there is no post without a photo, and Maya keeps her draft.');
            return;
          }
          mediaId = up.value.mediaId;
          v.mediaId = mediaId;
        }
      }
      const r = yield ctx.call('gateway', 'post', { author: 'maya', mediaId, caption: v.caption, clientId: v.clientId }, { timeout: 2500 });
      ctx.recordOutcome(r.ok, ctx.now() - t0);
      v.sharing = false;
      if (r.ok) {
        Object.assign(v, { shareMs: ctx.now() - t0, photo: null, mediaId: null, posted: r.value.postId });
        st.posts[r.value.postId].actionId = ctx.actionId;
        Y.L(ctx, { displayed: ['yes', `Shared in ${Math.round(ctx.now() - t0)} ms.`], accepted: 'yes', committed: ['yes', `${r.value.postId} in the posts database.`], async: ['pending', 'Fanning out to followers’ feeds.'] });
        ctx.explain(st.config.preUpload
          ? `The photo was already in the object store, so Share only had to create the post row: ${Math.round(ctx.now() - t0)} ms. The post service wrote the row and queued one fan-out job; Maya’s 1,200 followers get it in their feed caches in a moment.`
          : `Share had to upload the 2 MB photo first, then create the post: ${Math.round(ctx.now() - t0)} ms with a spinner. Uploading while the caption is typed hides that time.`);
      } else {
        v.error = `Couldn’t share: ${r.error.message}`;
        Y.failed(ctx, 'Shows an error.');
      }
    }, { self: 'maya' });
  }

  function startCelebPost(sim) {
    sim.startAction('priya.rao (50M followers): post a photo', function* (ctx) {
      const st = ctx.state;
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('gateway', 'post', { author: 'celeb', mediaId: 'm-celeb', caption: 'Backstage ✨', clientId: 'celeb-' + ++st.seq.client }, { timeout: 2500 });
      if (r.ok) { st.posts[r.value.postId].actionId = ctx.actionId; Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', 'Reaching followers’ feeds.'] }); }
      else Y.failed(ctx);
    }, { self: 'celeb' });
  }

  function startLike(sim, postId, label) {
    sim.startAction(label || 'Dev: like the photo', function* (ctx) {
      const st = ctx.state;
      const u = ctx.ui.dev;
      u.liked[postId] = true; // optimistic heart
      Y.L(ctx, { displayed: ['yes', 'Optimistic: the heart fills at once.'], retrySafe: st.config.idemLike ? ['yes', 'Desired state: liked = true.'] : ['no', 'Each tap adds a like.'] });
      const r = yield ctx.call('gateway', 'like', { postId, user: 'dev' }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) {
        Y.L(ctx, { accepted: 'yes', committed: ['yes', `Like stored; ${r.value.likes} like${r.value.likes === 1 ? '' : 's'} on the post.`], async: r.value.changed ? ['pending', 'Activity for Maya.'] : ['n/a', 'Already liked: no new activity.'] });
        ctx.explain(r.value.changed
          ? 'The like is a row keyed by (post, user), so it exists once however many times Dev taps. Storing it also produced an activity event; Maya’s phone shows it when the activity service delivers it.'
          : st.config.idemLike ? 'Dev had already liked this post. The write changed nothing and no second activity was created.' : 'Each tap inserted another like row and another activity: the count is now wrong and Maya is told twice.');
      } else { delete u.liked[postId]; Y.failed(ctx, 'The heart empties again.'); }
    }, { self: 'dev' });
  }

  const sc = (SDL.scenarios['ig-post'] = {
    id: 'ig-post',
    seed: 611,
    productWidth: 620,
    intro: 'On Maya’s phone, pick a photo and share it. Dev’s feed refreshes every second; like the photo there and watch the activity reach Maya. Then make the celebrity post, pause the fan-out, or take the CDN down.',
    topology: {
      width: 1160, height: 620,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'Posts', kind: 'client', x: 90, y: 90, latency: 1, role: 'Picks a photo, uploads it in the background, shares, and receives activity.', ops: [{ name: 'activity', desc: 'Show an activity.' }], owns: ['Draft post'] },
        { id: 'dev', label: 'Dev’s phone', sub: 'Follows Maya and priya.rao', kind: 'client', x: 90, y: 330, latency: 1, role: 'Refreshes the home feed every second, loads images through the CDN, likes.', owns: ['What Dev sees'] },
        { id: 'celeb', label: 'priya.rao', sub: '50M followers', kind: 'client', x: 90, y: 540, latency: 1, role: 'A celebrity account, posting from the console.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Mobile API', kind: 'gateway', x: 300, y: 210, latency: 2, role: 'Routes uploads, posts, feed reads, and likes.', ops: [{ name: 'upload', desc: 'Upload media.' }, { name: 'post', desc: 'Create a post.' }, { name: 'feed', desc: 'Read the home feed.' }, { name: 'like', desc: 'Like a post.' }], owns: ['Nothing durable'] },
        { id: 'media', label: 'Upload service', sub: 'Chunked uploads', kind: 'service', x: 520, y: 40, latency: 4, role: 'Receives the photo, stores the original, and returns a media id (see the media lab).', ops: [{ name: 'upload', desc: 'Store a photo.' }], owns: ['Upload sessions'] },
        { id: 'blobs', label: 'Object store', sub: 'Originals + renditions', kind: 'store', x: 760, y: 40, latency: 10, role: 'Durable storage for every photo.', ops: [{ name: 'put', desc: 'Store bytes.' }, { name: 'get', desc: 'Read bytes.' }], owns: ['media'] },
        { id: 'cdn', label: 'CDN', sub: 'Edge cache', kind: 'cdn', x: 980, y: 40, latency: 8, role: 'Serves images near the viewer; misses go to the object store (see the CDN lab).', ops: [{ name: 'get', desc: 'Fetch an image.' }], owns: ['Cached images'] },
        { id: 'posts', label: 'Post service', sub: 'Create, feed, like', kind: 'service', x: 520, y: 210, latency: 4, role: 'Creates posts (unique per client id), builds the feed from the cache, stores likes, and emits activity.', ops: [{ name: 'create', desc: 'Create a post.' }, { name: 'feed', desc: 'Build the feed.' }, { name: 'like', desc: 'Store a like.' }], owns: ['Feed assembly rules'] },
        { id: 'postsdb', label: 'Posts DB', sub: 'Sharded by author', kind: 'db', x: 760, y: 210, latency: 8, role: 'Posts, likes, comments. Time-sorted ids.', ops: [{ name: 'insert', desc: 'Insert a post.' }, { name: 'recent', desc: 'Recent posts by authors.' }, { name: 'setLike', desc: 'Store a like.' }], owns: ['posts', 'likes'] },
        { id: 'graph', label: 'Follow graph', sub: 'Who follows whom', kind: 'db', x: 760, y: 330, latency: 6, role: 'Follower and following lists (see the graph lab).', ops: [{ name: 'followers', desc: 'Followers of an account.' }, { name: 'following', desc: 'Accounts a user follows.' }], owns: ['edges'] },
        { id: 'fanq', label: 'Fan-out jobs', sub: 'Queue', kind: 'queue', x: 520, y: 450, latency: 4, queue: 'fan', role: 'One job per new post.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['job log'] },
        { id: 'fanout', label: 'Fan-out workers', sub: 'Write feed caches', kind: 'worker', x: 760, y: 450, latency: 4, role: 'Looks up followers and writes the post id into each one’s feed cache. Work grows with the follower count.', ops: [{ name: 'consume', desc: 'Fan one post out.' }], owns: ['Nothing durable'] },
        { id: 'feedcache', label: 'Feed cache', sub: 'Per user, post ids', kind: 'cache', x: 980, y: 330, latency: 3, role: 'A ready-made list of post ids per user. Lost entries are rebuilt by pulling.', ops: [{ name: 'push', desc: 'Add a post id.' }, { name: 'read', desc: 'Read a feed.' }], owns: ['feed[user]'] },
        { id: 'activity', label: 'Activity service', sub: 'Likes → notifications', kind: 'worker', x: 300, y: 450, latency: 5, role: 'Turns likes and comments into activity entries and pushes them (see the activity lab).', ops: [{ name: 'notify', desc: 'Deliver an activity.' }], owns: ['activity[user]'] },
      ],
      edges: [
        { from: 'maya', to: 'gateway', latency: 40 },
        { from: 'dev', to: 'gateway', latency: 40 },
        { from: 'celeb', to: 'gateway', latency: 40 },
        { from: 'gateway', to: 'media', latency: 4 },
        { from: 'media', to: 'blobs', latency: 6 },
        { from: 'cdn', to: 'blobs', latency: 30, label: 'miss' },
        { from: 'dev', to: 'cdn', latency: 25, label: 'images', via: [[200, 300], [200, 10], [980, 10]] },
        { from: 'gateway', to: 'posts', latency: 4 },
        { from: 'posts', to: 'postsdb', latency: 4 },
        { from: 'posts', to: 'feedcache', latency: 5, via: [[640, 150], [980, 150]] },
        { from: 'posts', to: 'graph', latency: 5 },
        { from: 'posts', to: 'fanq', latency: 4 },
        { from: 'fanq', to: 'fanout', latency: 4 },
        { from: 'fanout', to: 'graph', latency: 4 },
        { from: 'fanout', to: 'feedcache', latency: 4 },
        { from: 'posts', to: 'activity', latency: 5, via: [[420, 330]] },
        { from: 'activity', to: 'maya', latency: 40, label: 'push', via: [[150, 450]] },
      ],
      queues: [{ id: 'fan', broker: 'fanq', label: 'fan-out', groups: ['fanout'] }],
    },
    failures: [
      { id: 'blobs-down', node: 'blobs', mode: 'down', label: 'Object store down', desc: 'Uploads fail; nothing can be posted.' },
      { id: 'fanout-paused', node: 'fanout', mode: 'paused', label: 'Fan-out paused', desc: 'New posts stop reaching feeds.' },
      { id: 'cache-down', node: 'feedcache', mode: 'down', label: 'Feed cache down', desc: 'Feeds must be rebuilt by pulling, or fail.' },
      { id: 'cdn-down', node: 'cdn', mode: 'down', label: 'CDN down', desc: 'Posts appear but images never load.' },
      { id: 'postsdb-down', node: 'postsdb', mode: 'down', label: 'Posts DB down', desc: 'Nothing can be posted or liked.' },
      { id: 'gateway-slow', node: 'gateway', mode: 'slow', params: { factor: 40 }, label: 'API gateway slow', desc: 'Everything takes longer.' },
      { id: 'graph-slow', node: 'graph', mode: 'slow', params: { factor: 30 }, label: 'Follow graph slow', desc: 'Fan-out and pulls wait on follower lookups.' },
    ],
    switches: Y.switches([
      ['preUpload', 'Upload before share', 'Start uploading the photo as soon as it is picked. Off: upload when Share is tapped.'],
      ['hybrid', 'Hybrid fan-out', 'Accounts over 1 million followers are not fanned out; feeds pull their posts at read time.'],
      ['pullFallback', 'Rebuild feeds by pulling', 'If the feed cache is unavailable, build the feed from the graph and the posts database. Off: the feed fails.'],
      ['idemLike', 'Likes are desired state', 'A like is one row per (post, user). Off: every tap inserts a like and an activity.'],
    ]),
    presets: Y.presets({ preUpload: true, hybrid: true, pullFallback: true, idemLike: true }, [
      { id: 'post', label: 'Pick, share, appear', desc: 'The photo uploads while Maya types. Share takes a few hundred milliseconds; Dev sees the post on the next refresh.', run: (s) => { startPick(s); s.schedule(1500, () => startShare(s)); } },
      { id: 'like', label: 'Dev likes it', desc: 'The heart fills at once; the like is stored and Maya gets “dev liked your photo”.', run: (s) => { startPick(s); s.schedule(1500, () => startShare(s)); s.schedule(3500, () => startLike(s, 'P1')); } },
      { id: 'double-like', label: 'Double tap, one like', desc: 'Two taps 60 ms apart. The like is desired state, so one row, one count, one activity.', run: (s) => { startPick(s); s.schedule(1500, () => startShare(s)); s.schedule(3500, () => startLike(s, 'P1')); s.schedule(3560, () => startLike(s, 'P1', 'Dev: like (second tap)')); } },
      { id: 'double-like-bad', label: 'Double tap, two likes', desc: 'Each tap inserts a like: the post shows 2 likes from one person and Maya is told twice.', sw: { idemLike: false }, run: (s) => { startPick(s); s.schedule(1500, () => startShare(s)); s.schedule(3500, () => startLike(s, 'P1')); s.schedule(3560, () => startLike(s, 'P1', 'Dev: like (second tap)')); } },
      { id: 'no-preupload', label: 'Upload when Share is tapped', desc: 'Share has to move 2 MB first: over a second of spinner before the post exists.', sw: { preUpload: false }, run: (s) => { startPick(s); s.schedule(1500, () => startShare(s)); } },
      { id: 'blobs-down', label: 'Object store down', desc: 'The upload fails, so Share fails cleanly. No post is created without its photo.', sw: { preUpload: false }, run: (s) => { s.inject('blobs', 'down'); startPick(s); s.schedule(1500, () => startShare(s)); } },
      { id: 'fanout-paused', label: 'Fan-out paused', desc: 'The post is stored but never reaches Dev’s feed cache. Dev keeps refreshing and sees nothing new.', run: (s) => { s.inject('fanout', 'paused'); startPick(s); s.schedule(1500, () => startShare(s)); } },
      { id: 'cache-down', label: 'Feed cache down, rebuilt by pulling', desc: 'Dev’s feed is built from the follow graph and the posts database instead: slower, but complete.', run: (s) => { s.inject('feedcache', 'down'); startPick(s); s.schedule(1500, () => startShare(s)); } },
      { id: 'cache-down-bad', label: 'Feed cache down, no fallback', desc: 'Every feed read fails. Dev sees an error where the feed should be.', sw: { pullFallback: false }, run: (s) => { s.inject('feedcache', 'down'); startPick(s); s.schedule(1500, () => startShare(s)); } },
      { id: 'celebrity', label: 'Celebrity posts, hybrid fan-out', desc: 'priya.rao’s post is not fanned out; Dev’s feed pulls it at read time. Maya’s post right after is unaffected.', run: (s) => { startCelebPost(s); startPick(s); s.schedule(1500, () => startShare(s)); } },
      { id: 'celebrity-bad', label: 'Celebrity posts, fan-out on write', desc: '50 million feed-cache writes take about 20 s. Maya’s post queues behind them and Dev sees neither for a long time.', sw: { hybrid: false }, run: (s) => { startCelebPost(s); startPick(s); s.schedule(1500, () => startShare(s)); } },
      { id: 'cdn-down', label: 'CDN down', desc: 'The post reaches Dev’s feed, but the image request fails: a grey placeholder where the photo should be.', run: (s) => { s.inject('cdn', 'down'); startPick(s); s.schedule(1500, () => startShare(s)); } },
    ]),
    initialState: () => ({
      config: { preUpload: true, hybrid: true, pullFallback: true, idemLike: true },
      posts: {}, likes: {}, clientIds: {}, feeds: { dev: [] }, media: {}, cdnCache: {},
      activity: [], follows: { dev: ['maya', 'celeb'] },
      stats: { pulls: 0, feedErrors: 0, imageFails: 0, fanWrites: 0 },
      seq: { post: 0, media: 0, client: 0, act: 0 },
    }),
    initialUI: () => ({
      maya: { photo: null, mediaId: null, uploading: false, uploadError: '', caption: '', sharing: false, shareMs: null, posted: null, error: '', clientId: 'c-1', banner: null, activities: [] },
      dev: { feed: [], loaded: {}, liked: {}, feedError: '', feedMs: null, source: '' },
    }),
    actions: {
      pick(sim) { startPick(sim); },
      share(sim) { startShare(sim); },
      like(sim, a) { startLike(sim, a.postId); },
      celeb(sim) { startCelebPost(sim); },
      set: Y.setAction,
    },
    handlers: {
      gateway: {
        upload: function* (ctx, p) { return ctx.must(yield ctx.call('media', 'upload', p, { timeout: 3800 })); },
        post: function* (ctx, p) { return ctx.must(yield ctx.call('posts', 'create', p, { timeout: 2300 })); },
        feed: function* (ctx, p) { return ctx.must(yield ctx.call('posts', 'feed', p, { timeout: 1400 })); },
        like: function* (ctx, p) { return ctx.must(yield ctx.call('posts', 'like', p, { timeout: 1300 })); },
      },
      media: {
        upload: function* (ctx, p) {
          yield ctx.wait(UPLOAD_MS); // bytes moving over the mobile connection
          const id = 'm' + ++ctx.state.seq.media;
          ctx.must(yield ctx.call('blobs', 'put', { id, bytes: p.bytes }, { timeout: 2000 }));
          return { mediaId: id };
        },
      },
      blobs: {
        put(ctx, p) { ctx.state.media[p.id] = { bytes: p.bytes }; return { stored: true }; },
        get(ctx, p) { if (!ctx.state.media[p.id] && p.id !== 'm-celeb') ctx.fail('NOT_FOUND', 'No such media.'); return { bytes: 2e5 }; },
      },
      cdn: {
        get: function* (ctx, p) {
          const st = ctx.state;
          if (st.cdnCache[p.id]) return { hit: true };
          ctx.must(yield ctx.call('blobs', 'get', p, { timeout: 800 }));
          st.cdnCache[p.id] = true;
          return { hit: false };
        },
      },
      posts: {
        create: function* (ctx, p) {
          const st = ctx.state;
          if (st.clientIds[p.clientId]) return { postId: st.clientIds[p.clientId], replayed: true };
          const r = ctx.must(yield ctx.call('postsdb', 'insert', p, { timeout: 1500 }));
          st.clientIds[p.clientId] = r.postId;
          yield ctx.call('fanq', 'publish', { postId: r.postId, author: p.author }, { timeout: 600 });
          return { postId: r.postId };
        },
        feed: function* (ctx, p) {
          const st = ctx.state;
          let ids;
          let source = 'feed cache';
          const c = yield ctx.call('feedcache', 'read', { user: p.user }, { timeout: 500 });
          if (c.ok) ids = c.value.ids.slice();
          else {
            if (!st.config.pullFallback) ctx.must(c);
            st.stats.pulls++;
            source = 'pulled from the graph and posts database';
            const f = ctx.must(yield ctx.call('graph', 'following', { user: p.user }, { timeout: 800 }));
            const r = ctx.must(yield ctx.call('postsdb', 'recent', { authors: f.authors }, { timeout: 800 }));
            ids = r.ids;
          }
          if (st.config.hybrid && c.ok) {
            const big = st.follows[p.user].filter((a) => ACCOUNTS[a].followers > 1e6);
            if (big.length) { const r = yield ctx.call('postsdb', 'recent', { authors: big }, { timeout: 800 }); if (r.ok) ids = ids.concat(r.value.ids); }
          }
          ids = [...new Set(ids)].sort((a, b) => st.posts[b].t - st.posts[a].t);
          return { posts: ids.map((id) => Object.assign({ likes: Object.keys(st.likes[id] || {}).length, likeRows: st.posts[id].likeRows }, st.posts[id])), source };
        },
        like: function* (ctx, p) {
          const st = ctx.state;
          const r = ctx.must(yield ctx.call('postsdb', 'setLike', p, { timeout: 1000 }));
          if (r.changed) {
            const post = st.posts[p.postId];
            yield ctx.call('activity', 'notify', { user: post.author, text: `${p.user} liked your photo`, actId: 'a' + ++st.seq.act }, { timeout: 800 });
          }
          return r;
        },
      },
      postsdb: {
        insert(ctx, p) {
          const st = ctx.state;
          const id = 'P' + ++st.seq.post;
          st.posts[id] = { id, author: p.author, mediaId: p.mediaId, caption: p.caption, t: ctx.now(), likeRows: 0 };
          return { postId: id };
        },
        recent(ctx, p) { return { ids: Object.values(ctx.state.posts).filter((x) => p.authors.includes(x.author)).map((x) => x.id) }; },
        setLike(ctx, p) {
          const st = ctx.state;
          const post = st.posts[p.postId];
          if (!post) ctx.fail('NOT_FOUND', 'No such post.');
          st.likes[p.postId] = st.likes[p.postId] || {};
          const had = !!st.likes[p.postId][p.user];
          st.likes[p.postId][p.user] = true;
          if (st.config.idemLike && had) return { changed: false, likes: post.likeRows };
          post.likeRows++;
          return { changed: true, likes: post.likeRows };
        },
      },
      graph: {
        followers(ctx, p) { return { count: ACCOUNTS[p.author].followers, users: ['dev'] }; },
        following(ctx, p) { return { authors: ctx.state.follows[p.user] }; },
      },
      feedcache: {
        push(ctx, p) { const f = ctx.state.feeds[p.user]; if (!f.includes(p.postId)) f.push(p.postId); return { ok: true }; },
        read(ctx, p) { return { ids: ctx.state.feeds[p.user] }; },
      },
      fanq: { publish(ctx, p) { ctx.sim.enqueue('fan', { type: 'post.created', eventId: 'fan-' + p.postId, payload: p, actionId: ctx.actionId }); return { appended: true }; } },
      activity: {
        notify: function* (ctx, p) {
          ctx.state.activity.push(p);
          return ctx.must(yield ctx.call('maya', 'activity', p, { timeout: 600 }));
        },
      },
      maya: {
        activity(ctx, p) {
          const u = ctx.ui.maya;
          u.activities.unshift({ text: p.text, t: ctx.now() });
          u.banner = { title: 'Activity', body: p.text, tone: 'ok', t: ctx.now() };
          return { shown: true };
        },
      },
    },
    setup(sim) {
      Y.consumer(sim, 'fan', 'fanout', 'fanout', function* (ctx, msg) {
        const st = ctx.state;
        const p = msg.payload;
        const g = yield ctx.call('graph', 'followers', { author: p.author }, { timeout: 1000, actionId: msg.actionId });
        if (!g.ok) return false;
        if (st.config.hybrid && g.value.count > 1e6) {
          ctx.log({ op: `skip fan-out for ${p.postId}`, status: 'note', actionId: msg.actionId, detail: `${ACCOUNTS[p.author].name} has ${Y.num(g.value.count)} followers: too many caches to write. Feeds pull this account at read time instead.` });
          ctx.sim.setLedger(msg.actionId, 'async', 'yes', 'Not fanned out: pulled at read time.');
          return true;
        }
        const work = (g.value.count / 1e6) * MS_PER_MILLION;
        if (work > 100) ctx.log({ op: `writing ${Y.num(g.value.count)} feed caches for ${p.postId}`, status: 'note', actionId: msg.actionId, detail: `About ${(work / 1000).toFixed(0)} s of writes. Every post behind it in the queue waits.` });
        yield ctx.wait(Math.max(1, work));
        for (const u of g.value.users) {
          const r = yield ctx.call('feedcache', 'push', { user: u, postId: p.postId }, { timeout: 600, actionId: msg.actionId });
          if (!r.ok) return false;
        }
        st.stats.fanWrites += g.value.count;
        ctx.sim.setLedger(msg.actionId, 'async', 'yes', `In ${Y.num(g.value.count)} feed caches ${((ctx.now() - st.posts[p.postId].t) / 1000).toFixed(1)} s after posting.`);
        return true;
      }, () => true);
      // Dev’s phone refreshes the feed every second and loads images through the CDN.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(1000);
          const st = ctx.state;
          const u = ctx.ui.dev;
          const t0 = ctx.now();
          const r = yield ctx.call('gateway', 'feed', { user: 'dev' }, { timeout: 1500, quiet: 'all' });
          u.feedMs = ctx.now() - t0;
          if (!r.ok) { st.stats.feedErrors++; u.feedError = 'Couldn’t refresh feed. Pull down to try again.'; continue; }
          u.feedError = '';
          u.source = r.value.source;
          for (const post of r.value.posts) {
            if (!u.feed.some((x) => x.id === post.id)) {
              ctx.log({ op: `${post.id} appears in Dev’s feed`, status: 'ok', detail: `${((ctx.now() - post.t) / 1000).toFixed(1)} s after ${ACCOUNTS[post.author].name} posted (${r.value.source}).` });
              u.loaded[post.id] = 'loading';
              ctx.spawn(function* (c) {
                const img = yield c.call('cdn', 'get', { id: post.mediaId }, { timeout: 1500, quiet: 'all' });
                c.ui.dev.loaded[post.id] = img.ok ? 'ok' : 'failed';
                if (!img.ok) c.state.stats.imageFails++;
              }, { self: 'dev', quiet: 'all' });
            }
          }
          u.feed = r.value.posts;
        }
      }, { self: 'dev', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.dev;
      for (const post of Object.values(st.posts)) {
        const distinct = Object.keys(st.likes[post.id] || {}).length;
        if (post.likeRows > distinct) return { key: 'wrong', label: `${post.id} shows ${post.likeRows} likes from ${distinct} person. Repeated taps were stored as separate likes, and Maya was told ${post.likeRows} times.` };
      }
      if (u.feedError) return { key: 'stale', label: 'Dev’s feed cannot load: the feed cache is down and there is no fallback.' };
      const late = Object.values(st.posts).filter((p) => sim.now - p.t > 2500 && !u.feed.some((x) => x.id === p.id));
      if (late.length) return { key: 'stale', label: `${late.map((p) => p.id).join(', ')} posted ${((sim.now - late[0].t) / 1000).toFixed(1)} s ago and still not in Dev’s feed${sim.queueStats('fan').depth ? ` (${sim.queueStats('fan').depth} fan-out job${sim.queueStats('fan').depth > 1 ? 's' : ''} waiting)` : ''}.` };
      const broken = u.feed.filter((p) => u.loaded[p.id] === 'failed');
      if (broken.length) return { key: 'stale', label: `${broken.length} post${broken.length > 1 ? 's are' : ' is'} in Dev’s feed without an image: the CDN request failed.` };
      if (!Object.keys(st.posts).length && sim.ui.maya.error) return { key: 'ok', label: 'Nothing was posted: the upload failed cleanly and Maya kept her draft. No post exists without its photo.' };
      if (sim.queueStats('fan').depth && !sim.nodes.feedcache.modes.down) return { key: 'stale', label: 'A post is still being fanned out.' };
      return { key: 'ok', label: 'Every post reached every follower’s feed, every like counted once, and every activity was delivered once.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const m = sim.ui.maya;
      const d = sim.ui.dev;
      const lags = Object.values(st.posts).map((p) => { const e = sim.timeline.find((x) => x.op === `${p.id} appears in Dev’s feed`); return e ? e.t - p.t : null; }).filter((x) => x != null);
      return [
        { label: 'Share time', value: m.shareMs == null ? 'n/a' : SDL.fmtMs(m.shareMs), tone: m.shareMs > 1000 ? 'warn' : m.shareMs ? 'ok' : '' },
        { label: 'Post to feed', value: lags.length ? `${(Math.max(...lags) / 1000).toFixed(1)} s` : 'n/a', tone: lags.some((l) => l > 3000) ? 'fail' : '' },
        { label: 'Fan-out backlog', value: sim.queueStats('fan').depth, tone: sim.queueStats('fan').depth ? 'warn' : '' },
        { label: 'Feed-cache writes', value: Y.num(st.stats.fanWrites) },
        { label: 'Feed refresh', value: d.feedMs == null ? 'n/a' : SDL.fmtMs(d.feedMs), tone: d.feedError ? 'fail' : d.feedMs > 500 ? 'warn' : '' },
        { label: 'Feeds pulled (cache miss)', value: st.stats.pulls },
        { label: 'Images failed', value: st.stats.imageFails, tone: st.stats.imageFails ? 'fail' : '' },
        { label: 'Activities delivered', value: st.activity.length },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['dev', 'Dev’s phone']], {
          note: 'Maya posts; Dev follows her and sees the post on his next refresh. The button below makes a 50-million-follower account post.',
          below: `<div class="ops-console"><p class="ops-title">Celebrity account</p><div class="ops-traffic">${Y.btn('celeb', 'priya.rao (50M followers) posts', { cls: 'secondary' })}</div><div data-ref="fan"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const m = sim.ui.maya;
        const d = sim.ui.dev;
        const photo = (hue, state) => `<div class="yt-thumb" style="--h:${hue};height:120px;${state === 'ok' || state === 'own' ? '' : 'filter:blur(6px);opacity:.6'}"><span aria-hidden="true">${state === 'failed' ? '✕' : state === 'loading' ? '…' : '◉'}</span></div>`;
        let compose;
        if (m.sharing) compose = '<div class="app-card is-work"><strong><span class="spinner"></span>Sharing…</strong></div>';
        else if (m.photo) compose = `${photo(200, 'own')}<p class="app-sub">${m.uploading ? '<span class="spinner"></span>Uploading in the background…' : m.mediaId ? '✓ Uploaded, ready to share' : m.uploadError ? '✕ Upload failed' : 'Not uploaded yet'}</p><div class="app-card"><span class="app-sub">Caption</span><strong>${esc(m.caption)}</strong></div>${Y.btn('share', 'Share', { cls: 'go' })}`;
        else compose = `${Y.btn('pick', 'Pick a photo', {})}`;
        const mine = Object.values(st.posts).filter((p) => p.author === 'maya').slice(-1).map((p) => `<div class="app-card is-ok"><strong>✓ Posted ${esc(p.id)}</strong><span class="app-sub">♥ ${p.likeRows} like${p.likeRows === 1 ? '' : 's'} · ${esc(p.caption)}</span></div>`).join('');
        const acts = m.activities.slice(0, 3).map((a) => `<div class="app-card">♥ ${esc(a.text)}</div>`).join('');
        Y.paint(el, sim, 'maya', {
          head: '<div><p class="app-title">Instagram</p><p class="app-sub">maya.k · 1,200 followers</p></div>',
          compose, msg: Y.msg(m.error, 'fail'), mine, acts: acts ? `<p class="app-sub">Activity</p>${acts}` : '',
        }, {}, m.banner);
        const feed = d.feed.slice(0, 3).map((p) => `<div class="app-card"><strong>${esc(ACCOUNTS[p.author].name)}</strong>${photo(ACCOUNTS[p.author].hue, d.loaded[p.id])}<span class="app-sub">${esc(p.caption)} · ${p.likeRows} like${p.likeRows === 1 ? '' : 's'}</span>${Y.btn('like', d.liked[p.id] ? '♥ Liked' : '♡ Like', { arg: { postId: p.id }, cls: d.liked[p.id] ? '' : 'secondary' })}</div>`).join('');
        Y.paint(el, sim, 'dev', {
          head: `<div><p class="app-title">Instagram</p><p class="app-sub">Home${d.source ? ` · ${esc(d.source)}` : ''}</p></div>`,
          msg: Y.msg(d.feedError, 'fail'),
          feed: feed || '<p class="app-sub">Nothing new yet. The feed refreshes every second.</p>',
        }, {});
        const q = sim.queueStats('fan');
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="fan"]'), {
          q: `<div class="ops-row" data-tone="${q.depth ? 'warn' : ''}"><div class="ops-name">Fan-out queue<span>${q.depth} job${q.depth === 1 ? '' : 's'} waiting · ${Y.num(st.stats.fanWrites)} feed-cache writes so far</span></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
