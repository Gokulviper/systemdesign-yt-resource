/*
 * Explore, hashtags, and search.
 * Posts and their hashtags flow from the posts database, through change data
 * capture, into three index shards; a document is searchable after the next
 * refresh. Queries scatter to every shard and gather. A hashtag page shows a
 * post count kept by a counter: one row per hashtag, which a viral tag turns
 * into a hot key unless the counter is split into shards. Deletes travel the
 * same path as inserts, so an out-of-order delivery can resurrect a deleted
 * post unless writes are versioned.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const SHARDS = ['shardA', 'shardB', 'shardC'];
  const VIRAL = 2000; // posts per second tagged #sunset during a viral moment
  const DOCS = [
    ['maya.k', 'Golden hour over Marina Beach', 'sunset'], ['ana', 'Sunset from the ferry', 'sunset'], ['raj', 'Sunset run', 'sunset'],
    ['lee', 'Flat white, finally', 'coffee'], ['mia', 'Coffee first', 'coffee'], ['omar', 'Pour-over Sunday', 'coffee'],
    ['zoe', 'Trail day', 'hike'], ['kai', 'Summit at 6am', 'hike'],
  ];
  const QUERIES = { sunset: '#sunset', coffee: '#coffee', hike: '#hike', maya: 'maya' };
  const shardOf = (id) => SHARDS[id % 3];

  function startSearch(sim) {
    const u = sim.ui.dev;
    const q = u.query;
    sim.startAction(`Dev: search “${QUERIES[q]}”`, function* (ctx) {
      const st = ctx.state;
      Object.assign(u, { loading: true, error: '', partial: null });
      Y.L(ctx, { displayed: 'pending', committed: ['n/a', 'Searching writes nothing.'], async: 'n/a', retrySafe: 'yes' });
      const t0 = ctx.now();
      const tip = yield ctx.call('gateway', 'suggest', { prefix: QUERIES[q].slice(0, 3) }, { timeout: 800 });
      u.suggest = tip.ok ? tip.value.words : [];
      u.suggestMs = ctx.now() - t0;
      const t1 = ctx.now();
      const r = yield ctx.call('gateway', 'search', { q }, { timeout: 1800 });
      u.took = ctx.now() - t1;
      ctx.recordOutcome(r.ok, ctx.now() - t0);
      u.loading = false;
      if (r.ok) {
        Object.assign(u, { results: r.value.hits, partial: r.value.partial, count: r.value.count, countError: r.value.countError, searchedAt: ctx.now() });
        Y.L(ctx, { displayed: ['yes', `${r.value.hits.length} posts${r.value.partial ? ', marked incomplete' : ''}.`], accepted: 'yes' });
        const deleted = r.value.hits.find((h) => st.deleted[h.id]);
        ctx.explain(`The query went to all three shards in parallel and the hits were merged${r.value.partial ? `, but ${r.value.partial} did not answer in time, so the page says results may be incomplete` : ''}. ${q !== 'maya' ? (r.value.countError ? `The hashtag count could not be read: the counter row is overloaded.` : `The hashtag page header shows ${Y.num(r.value.count)} posts from the ${st.config.shardTags ? 'sharded' : 'single-row'} counter.`) : ''}${deleted ? ` One result, “${deleted.caption}”, was deleted by its author: the index still has it.` : ''}`);
      } else {
        Object.assign(u, { results: [], error: r.error.code === 'SHARD_FAILED' ? 'Search is unavailable right now.' : `Search failed: ${r.error.message}` });
        Y.failed(ctx, 'Shows an error.');
        ctx.explain(r.error.code === 'SHARD_FAILED' ? 'One shard of three did not answer and partial results are off, so the whole search failed.' : `Search failed: ${r.error.message}`);
      }
    }, { self: 'dev' });
  }

  function startPost(sim, tag) {
    const st = sim.state;
    sim.startAction(`maya.k: post “Sunset, take two” with #${tag}`, function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('postsdb', 'insert', { author: 'maya.k', caption: 'Sunset, take two', tag }, { timeout: 900 });
      if (r.ok) Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', 'Waiting to become searchable.'] });
      else Y.failed(ctx);
    }, { self: 'maya' });
  }

  function startDelete(sim) {
    const st = sim.state;
    const id = st.published ? st.published.id : 0;
    sim.startAction(`maya.k: delete “${st.docs[id].caption}”`, function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('postsdb', 'remove', { id }, { timeout: 900 });
      if (r.ok) { Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', 'Waiting to leave the index.'] }); ctx.explain('The post row is gone from the posts database. A delete change follows the same path as an insert: capture, change stream, indexer, shard, refresh. Until it lands, search still returns the post.'); }
      else Y.failed(ctx);
    }, { self: 'maya' });
  }

  function setViral(sim, on) {
    sim.state.viral = on;
    sim.note(on ? `#sunset goes viral: ${Y.num(VIRAL)} posts a second.` : 'The viral moment passes.');
  }

  const sc = (SDL.scenarios['ig-explore'] = {
    id: 'ig-explore',
    seed: 641,
    productWidth: 600,
    intro: 'Search #sunset. Make Maya post a new #sunset photo and search again: it appears after the next refresh. Delete it, lose a shard, or make #sunset go viral and watch the hashtag counter.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'dev', label: 'Dev’s phone', sub: 'Search and explore', kind: 'client', x: 90, y: 90, latency: 1, role: 'Searches hashtags and people; opens hashtag pages.', owns: ['Nothing'] },
        { id: 'maya', label: 'Maya’s phone', sub: 'Posts and deletes', kind: 'client', x: 90, y: 330, latency: 1, role: 'Posts and deletes photos.', owns: ['Nothing'] },
        { id: 'crowd', label: 'Everyone else', sub: 'Viral tagging', kind: 'client', x: 90, y: 540, latency: 1, role: 'Thousands of posts a second with the same hashtag.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Mobile API', kind: 'gateway', x: 300, y: 90, latency: 2, role: 'Routes searches and suggestions.', ops: [{ name: 'search', desc: 'Search.' }, { name: 'suggest', desc: 'Typeahead.' }], owns: ['Nothing durable'] },
        { id: 'typeahead', label: 'Typeahead cache', sub: 'Prefix → tags', kind: 'cache', x: 300, y: 240, latency: 2, role: 'Popular completions per prefix, in memory.', ops: [{ name: 'get', desc: 'Suggestions.' }], owns: ['completions'] },
        { id: 'query', label: 'Query service', sub: 'Scatter-gather', kind: 'service', x: 520, y: 90, latency: 4, role: 'Sends the query to every shard, merges hits, and reads the hashtag count.', ops: [{ name: 'search', desc: 'Scatter, gather, count.' }], owns: ['Merge rules'] },
        { id: 'shardA', label: 'Index shard A', sub: 'A third of posts', kind: 'db', x: 800, y: 40, latency: 18, role: 'Inverted index over a third of the posts.', ops: [{ name: 'query', desc: 'Matching posts.' }], owns: ['index part A'] },
        { id: 'shardB', label: 'Index shard B', sub: 'A third of posts', kind: 'db', x: 800, y: 140, latency: 18, role: 'Inverted index over a third of the posts.', ops: [{ name: 'query', desc: 'Matching posts.' }], owns: ['index part B'] },
        { id: 'shardC', label: 'Index shard C', sub: 'A third of posts', kind: 'db', x: 800, y: 240, latency: 18, role: 'Inverted index over a third of the posts.', ops: [{ name: 'query', desc: 'Matching posts.' }], owns: ['index part C'] },
        { id: 'tagcount', label: 'Hashtag counter', sub: 'One row per tag', kind: 'db', x: 800, y: 380, latency: 4, serviceMs: 1, role: 'posts_count per hashtag. Every tagged post increments one row: about 1,000 a second per tag.', ops: [{ name: 'inc', desc: 'Increment.' }, { name: 'get', desc: 'Read a count.' }], owns: ['count[tag]'] },
        { id: 'tagshards', label: 'Hashtag counter, sharded', sub: '8 sub-counters per tag', kind: 'db', x: 1020, y: 380, latency: 4, serviceMs: 1, servers: 8, role: 'The same count split into eight rows; reads sum them.', ops: [{ name: 'inc', desc: 'Increment one sub-counter.' }, { name: 'get', desc: 'Sum the sub-counters.' }], owns: ['count[tag][i]'] },
        { id: 'postsdb', label: 'Posts DB', sub: 'Source of truth', kind: 'db', x: 300, y: 470, latency: 6, role: 'Posts with captions and hashtags; emits a change per insert and delete.', ops: [{ name: 'insert', desc: 'New post.' }, { name: 'remove', desc: 'Delete a post.' }], owns: ['posts'] },
        { id: 'changes', label: 'Change stream', sub: 'Change data capture', kind: 'queue', x: 520, y: 470, latency: 3, queue: 'changes', role: 'Inserts and deletes waiting to be indexed. May deliver out of order after a rebalance.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['change log'] },
        { id: 'indexer', label: 'Indexer', sub: 'Applies changes', kind: 'worker', x: 800, y: 500, latency: 5, role: 'Writes documents into the right shard; they become searchable at the next refresh.', ops: [{ name: 'consume', desc: 'Index a change.' }], owns: ['Pending, unrefreshed documents'] },
      ],
      edges: [
        { from: 'dev', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'typeahead', latency: 3 },
        { from: 'gateway', to: 'query', latency: 3 },
        { from: 'query', to: 'shardA', latency: 3 }, { from: 'query', to: 'shardB', latency: 3 }, { from: 'query', to: 'shardC', latency: 3 },
        { from: 'query', to: 'tagcount', latency: 4, via: [[640, 90], [640, 380]] },
        { from: 'query', to: 'tagshards', latency: 4, via: [[700, 90], [700, 330], [1020, 330]] },
        { from: 'typeahead', to: 'query', latency: 3, label: 'miss' },
        { from: 'maya', to: 'postsdb', latency: 30 },
        { from: 'crowd', to: 'postsdb', latency: 30 },
        { from: 'postsdb', to: 'changes', latency: 4, label: 'log' },
        { from: 'postsdb', to: 'tagcount', latency: 5, label: '+1', via: [[300, 560], [800, 560]] },
        { from: 'postsdb', to: 'tagshards', latency: 5, via: [[300, 580], [1020, 580]] },
        { from: 'changes', to: 'indexer', latency: 3 },
        { from: 'indexer', to: 'shardC', latency: 4, via: [[940, 500], [940, 240]] },
      ],
      queues: [{ id: 'changes', broker: 'changes', label: 'changes', groups: ['indexer'] }],
    },
    modeLabels: { reorder: 'Delivering out of order' },
    failures: [
      { id: 'b-down', node: 'shardB', mode: 'down', label: 'Index shard B down', desc: 'A third of the index is unreachable.' },
      { id: 'b-slow', node: 'shardB', mode: 'slow', params: { factor: 40 }, label: 'Index shard B slow', desc: 'One shard misses the budget.' },
      { id: 'indexer-paused', node: 'indexer', mode: 'paused', label: 'Indexer paused', desc: 'New and deleted posts stop reaching the index.' },
      { id: 'reorder', node: 'changes', mode: 'reorder', label: 'Change stream out of order', desc: 'A delete can arrive before the insert it undoes.' },
      { id: 'ta-down', node: 'typeahead', mode: 'down', label: 'Typeahead cache down', desc: 'Suggestions fall back to the shards.' },
    ],
    switches: Y.switches([
      ['partial', 'Return partial results', 'If a shard fails or misses 300 ms, return the rest marked incomplete. Off: fail the search.'],
      ['nrt', 'Near-real-time refresh', 'Refresh the index every 0.3 s. Off: every 3 s, cheaper but staler.'],
      ['versioned', 'Versioned index writes', 'Apply a change only if it is newer than what the shard holds. Off: whatever arrives last wins.'],
      ['shardTags', 'Shard hashtag counters', 'Split each hashtag’s count over eight rows. Off: one row per hashtag.'],
    ]),
    presets: Y.presets({ partial: true, nrt: true, versioned: true, shardTags: true }, [
      { id: 'search', label: 'Search #sunset', desc: 'Suggestions from the cache, three hits from three shards, and the hashtag count.', run: (s) => startSearch(s) },
      { id: 'fresh', label: 'Post, then search', desc: 'Maya’s new #sunset post is captured, indexed, and searchable within a second.', run: (s) => { startPost(s, 'sunset'); s.schedule(1200, () => startSearch(s)); } },
      { id: 'fresh-slow', label: 'Post, then search, slow refresh', desc: 'With a 3 s refresh the same search misses the new post.', sw: { nrt: false }, run: (s) => { startPost(s, 'sunset'); s.schedule(1200, () => startSearch(s)); } },
      { id: 'paused', label: 'Indexer paused', desc: 'The new post stays unsearchable until indexing resumes.', run: (s) => { s.inject('indexer', 'paused', true, 4000); startPost(s, 'sunset'); s.schedule(1500, () => startSearch(s)); } },
      { id: 'delete', label: 'Delete a post', desc: 'Maya deletes her sunset photo. The delete follows the same path and the post leaves the results.', run: (s) => { startDelete(s); s.schedule(1200, () => startSearch(s)); } },
      { id: 'delete-reorder', label: 'Post, delete, delivered out of order, versioned', desc: 'The delete reaches the index before the insert. The insert is older, so the shard ignores it: the post stays gone.', run: (s) => { s.inject('changes', 'reorder'); startPost(s, 'sunset'); s.schedule(300, () => startDelete(s)); s.schedule(2500, () => startSearch(s)); } },
      { id: 'delete-reorder-bad', label: 'Same, last write wins', desc: 'The late insert overwrites the delete: a post its author removed is back in search, for ever.', sw: { versioned: false }, run: (s) => { s.inject('changes', 'reorder'); startPost(s, 'sunset'); s.schedule(300, () => startDelete(s)); s.schedule(2500, () => startSearch(s)); } },
      { id: 'shard-down', label: 'Shard down, partial results', desc: 'Two shards answer; the page shows their hits and says results may be incomplete.', run: (s) => { s.inject('shardB', 'down'); startSearch(s); } },
      { id: 'shard-down-bad', label: 'Shard down, all or nothing', desc: 'One shard of three is down, so the search fails outright.', sw: { partial: false }, run: (s) => { s.inject('shardB', 'down'); startSearch(s); } },
      { id: 'viral', label: '#sunset goes viral, sharded counter', desc: `${Y.num(VIRAL)} posts a second increment eight sub-counters. The hashtag page reads their sum in a few milliseconds.`, run: (s) => { setViral(s, true); s.schedule(1500, () => startSearch(s)); s.schedule(5000, () => setViral(s, false)); } },
      { id: 'viral-hot', label: '#sunset goes viral, one counter row', desc: 'Every increment locks the same row. Reads of the count queue behind them and the hashtag page times out.', sw: { shardTags: false }, run: (s) => { setViral(s, true); s.schedule(1500, () => startSearch(s)); s.schedule(5000, () => setViral(s, false)); } },
      { id: 'ta-down', label: 'Typeahead cache down', desc: 'Suggestions need a full scatter-gather and arrive noticeably later.', run: (s) => { s.inject('typeahead', 'down'); startSearch(s); } },
    ]),
    initialState: () => {
      const shards = { shardA: {}, shardB: {}, shardC: {} };
      const docs = {};
      DOCS.forEach(([author, caption, tag], i) => { docs[i] = { id: i, author, caption, tag, ver: 1 }; shards[shardOf(i)][i] = { id: i, author, caption, tag, ver: 1 }; });
      const counts = { sunset: 1240000, coffee: 880000, hike: 310000 };
      return {
        config: { partial: true, nrt: true, versioned: true, shardTags: true },
        docs, shards, pending: [], nextId: DOCS.length, published: null, deleted: {}, searchableAt: null, lastRefresh: 0, holding: false,
        counts, viral: false,
        stats: { incs: 0, incTimeouts: 0, cacheHit: 0, cacheMiss: 0, dropped: 0 },
        seq: { ev: 0 },
      };
    },
    initialUI: () => ({ dev: { query: 'sunset', results: [], partial: null, suggest: [], suggestMs: null, took: null, count: null, countError: false, error: '', loading: false, searchedAt: 0 } }),
    actions: {
      search(sim) { startSearch(sim); },
      post(sim) { startPost(sim, 'sunset'); },
      remove(sim) { startDelete(sim); },
      viral(sim, a) { setViral(sim, !!a.on); },
      set: Y.setAction,
    },
    handlers: {
      gateway: {
        search: function* (ctx, p) { return ctx.must(yield ctx.call('query', 'search', p, { timeout: 1700 })); },
        suggest: function* (ctx, p) {
          const r = yield ctx.call('typeahead', 'get', p, { timeout: 200 });
          if (r.ok) { ctx.state.stats.cacheHit++; return r.value; }
          ctx.state.stats.cacheMiss++;
          const q = ctx.must(yield ctx.call('query', 'search', { q: 'sunset', prefix: p.prefix }, { timeout: 700 }));
          return { words: [...new Set(q.hits.map((h) => '#' + h.tag))].slice(0, 3) };
        },
      },
      typeahead: { get(ctx, p) { const tags = ['#sunset', '#sunday', '#sunrise', '#coffee', '#coffeetime', '#hike', '#hiking']; return { words: tags.filter((t) => t.startsWith(p.prefix)).slice(0, 3) }; } },
      query: {
        search: function* (ctx, p) {
          const st = ctx.state;
          const res = {};
          SHARDS.forEach((sh) => ctx.spawn(function* (c) { res[sh] = yield c.call(sh, 'query', p, { timeout: 1200 }); }));
          const t0 = ctx.now();
          const budget = st.config.partial ? 300 : 1300;
          while (Object.keys(res).length < 3 && ctx.now() - t0 < budget) yield ctx.wait(20);
          const ok = SHARDS.filter((s) => res[s] && res[s].ok);
          const bad = SHARDS.filter((s) => !ok.includes(s)).map((b) => ctx.sim.nodes[b].label);
          if (bad.length && !st.config.partial) ctx.fail('SHARD_FAILED', `${bad.join(', ')} did not answer.`);
          const hits = ok.flatMap((s) => res[s].value.hits).sort((a, b) => b.id - a.id);
          let count = null;
          let countError = false;
          if (p.q !== 'maya' && !p.prefix) {
            const c = yield ctx.call(st.config.shardTags ? 'tagshards' : 'tagcount', 'get', { tag: p.q }, { timeout: 1200 });
            if (c.ok) count = c.value.count; else countError = true;
          }
          return { hits, partial: bad.length ? bad.join(', ') : null, count, countError };
        },
      },
      shardA: shardHandler('shardA'), shardB: shardHandler('shardB'), shardC: shardHandler('shardC'),
      tagcount: counterHandlers(), tagshards: counterHandlers(),
      postsdb: {
        insert: function* (ctx, p) {
          const st = ctx.state;
          const id = st.nextId++;
          st.docs[id] = { id, author: p.author, caption: p.caption, tag: p.tag, ver: 1 };
          if (!p.bulk) st.published = { id, t: ctx.now(), actionId: ctx.actionId };
          emit(ctx, { type: 'post.created', id, ver: 1, doc: st.docs[id] });
          if (!p.bulk) yield ctx.call(st.config.shardTags ? 'tagshards' : 'tagcount', 'inc', { tag: p.tag }, { timeout: 900 });
          return { id };
        },
        remove(ctx, p) {
          const st = ctx.state;
          const doc = st.docs[p.id];
          if (!doc) ctx.fail('NOT_FOUND', 'No such post.');
          doc.ver++;
          doc.deleted = true;
          st.deleted[p.id] = { t: ctx.now(), actionId: ctx.actionId };
          emit(ctx, { type: 'post.deleted', id: p.id, ver: doc.ver });
          return { id: p.id };
        },
      },
    },
    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msgs } = yield ctx.take('changes', 'indexer', 50);
          for (const m of msgs) ctx.state.pending.push(Object.assign({ actionId: m.actionId }, m.payload));
          ctx.ack('changes', 'indexer');
        }
      }, { self: 'indexer' });
      // Periodic refresh: pending changes become visible in their shard.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const st = ctx.state;
          if (ctx.sim.nodes.indexer.modes.paused) continue;
          const every = st.config.nrt ? 300 : 3000;
          if (ctx.now() - st.lastRefresh < every || !st.pending.length) continue;
          st.lastRefresh = ctx.now();
          for (const d of st.pending.splice(0)) {
            const shard = st.shards[shardOf(d.id)];
            const have = shard[d.id];
            if (st.config.versioned && have && d.ver <= have.ver) { st.stats.dropped++; ctx.log({ op: `${d.type} for post ${d.id} skipped (v${d.ver} older than v${have.ver})`, status: 'dup', actionId: d.actionId, detail: 'The shard already holds a newer version of this post; the stale change is ignored.' }); continue; }
            if (d.type === 'post.deleted') { shard[d.id] = { id: d.id, tombstone: true, ver: d.ver }; ctx.log({ op: `post ${d.id} removed from the index`, status: 'ok', actionId: d.actionId, detail: `Tombstoned in ${ctx.sim.nodes[shardOf(d.id)].label} after the refresh.` }); if (st.deleted[d.id]) { st.deleted[d.id].indexedAt = ctx.now(); ctx.sim.setLedger(d.actionId, 'async', 'yes', 'Gone from search.'); } continue; }
            shard[d.id] = Object.assign({}, d.doc, { ver: d.ver });
            if (st.published && d.id === st.published.id) { st.searchableAt = ctx.now(); ctx.sim.setLedger(d.actionId, 'async', 'yes', `Searchable ${((ctx.now() - st.published.t) / 1000).toFixed(1)} s after posting.`); }
            ctx.log({ op: `indexed “${d.doc.caption}”`, status: d.doc.caption === 'Sunset, take two' ? 'ok' : 'note', actionId: d.actionId, detail: `Visible in ${ctx.sim.nodes[shardOf(d.id)].label} after the refresh.` });
          }
        }
      }, { self: 'indexer', quiet: 'all' });
      // Viral tagging: thousands of posts a second, each incrementing the #sunset counter.
      Y.load(sim, 'crowd', (s) => (s.state.viral ? VIRAL : 0), function* (ctx) {
        const st = ctx.state;
        st.stats.incs++;
        const r = yield ctx.call(st.config.shardTags ? 'tagshards' : 'tagcount', 'inc', { tag: 'sunset', bulk: true }, { timeout: 1200, quiet: 'all' });
        if (!r.ok) st.stats.incTimeouts++;
      });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.dev;
      for (const [id] of Object.entries(st.deleted)) {
        const doc = st.shards[shardOf(Number(id))][id];
        const waiting = st.pending.some((d) => d.id === Number(id)) || sim.queueStats('changes').depth;
        if (doc && !doc.tombstone && !waiting) return { key: 'wrong', label: `“${doc.caption}” was deleted by its author, but the index still has it and no change is on its way: the late insert overwrote the delete.` };
      }
      if (u.error) return { key: 'stale', label: 'The search failed because one shard of three was unavailable.' };
      if (u.countError) return { key: 'stale', label: 'Search worked, but the hashtag count could not be read: the counter row is overloaded by viral tagging.' };
      if (st.published && !st.searchableAt && !st.deleted[st.published.id]) return { key: 'stale', label: `Maya’s new post is ${((sim.now - st.published.t) / 1000).toFixed(1)} s old and not searchable yet.` };
      const del = Object.entries(st.deleted).find(([, d]) => !d.indexedAt);
      if (del) return { key: 'stale', label: 'A deleted post is still in the index until the next refresh.' };
      if (u.results.some((h) => st.deleted[h.id])) return { key: 'stale', label: 'Dev’s screen still shows a post that has since left the index; a new search would be right.' };
      if (u.partial) return { key: 'stale', label: `Results are incomplete: ${u.partial} did not answer. The page says so.` };
      if (st.published && !st.deleted[st.published.id] && u.query === 'sunset' && u.searchedAt && !u.results.some((h) => h.id === st.published.id)) return { key: 'stale', label: 'Dev searched before the new post reached the index; his screen is missing it. A new search would show it.' };
      return { key: 'ok', label: 'The index matches the posts database, results are complete, and the hashtag count is readable.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const u = sim.ui.dev;
      const w = sim.queueWait(st.config.shardTags ? 'tagshards' : 'tagcount');
      return [
        { label: 'Search time', value: u.took == null ? 'n/a' : SDL.fmtMs(u.took), tone: u.error ? 'fail' : u.took > 800 ? 'warn' : '' },
        { label: 'Suggestion time', value: u.suggestMs == null ? 'n/a' : SDL.fmtMs(u.suggestMs), tone: u.suggestMs > 200 ? 'warn' : 'ok' },
        { label: 'Post to searchable', value: st.searchableAt ? `${((st.searchableAt - st.published.t) / 1000).toFixed(1)} s` : st.published ? 'not yet' : 'n/a' },
        { label: 'Waiting to be indexed', value: st.pending.length + sim.queueStats('changes').depth },
        { label: '#sunset count', value: Y.num(st.counts.sunset) },
        { label: 'Counter queue', value: SDL.fmtMs(w), tone: w > 500 ? 'fail' : w > 100 ? 'warn' : '' },
        { label: 'Increments timed out', value: Y.num(st.stats.incTimeouts), tone: st.stats.incTimeouts ? 'fail' : '' },
        { label: 'Stale changes dropped', value: st.stats.dropped },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['dev', 'Dev’s phone']], {
          note: 'Search from Dev’s phone. The console posts and deletes as Maya, and makes #sunset go viral.',
          side: `<p class="ops-title">Maya and the crowd</p><div class="ops-traffic">${Y.btn('post', 'maya.k posts “Sunset, take two” #sunset', {})}${Y.btn('remove', 'maya.k deletes her latest sunset post', { cls: 'secondary' })}${Y.btn('viral', '#sunset goes viral: 2,000 posts/s', { arg: { on: true } })}${Y.btn('viral', 'Calm down', { arg: { on: false }, cls: 'secondary' })}</div><div data-ref="idx"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.dev;
        const body = `<div class="app-row"><label for="xq">Search</label><select id="xq" data-field="dev.query">${Object.entries(QUERIES).map(([k, v]) => `<option value="${k}"${k === u.query ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
          ${Y.btn('search', u.loading ? 'Searching…' : 'Search', { disabled: u.loading })}
          ${u.suggest.length ? `<p class="app-sub">Suggestions: ${u.suggest.map(esc).join(', ')}</p>` : ''}
          ${u.count != null && !u.countError ? `<div class="app-card"><strong>${esc(QUERIES[u.query])}</strong><span class="app-sub">${Y.num(u.count)} posts</span></div>` : u.countError ? Y.msg('Post count unavailable right now.', 'warn') : ''}
          ${u.partial ? Y.msg(`Some results may be missing (${u.partial} unavailable).`, 'warn') : ''}${u.error ? Y.msg(u.error, 'fail') : ''}
          <div class="yt-feed">${u.results.map((h) => `<div class="yt-card"><div class="yt-thumb" style="--h:${(h.id * 47 + 20) % 360}"><span aria-hidden="true">◉</span></div><div><strong>${esc(h.author)}</strong><p class="app-sub">${esc(h.caption)}${h.id >= DOCS.length ? ' <span class="yt-tag">New</span>' : ''}${st.deleted[h.id] ? ' <span class="yt-tag">deleted by author</span>' : ''}</p></div></div>`).join('')}</div>`;
        Y.paint(el, sim, 'dev', { head: '<div><p class="app-title">Instagram</p><p class="app-sub">Explore</p></div>', body }, {});
        const c = sim.scenario.consistency(sim);
        const w = sim.queueWait(st.config.shardTags ? 'tagshards' : 'tagcount');
        SDL.ui.paintSections(el.querySelector('[data-ref="idx"]'), {
          rows: `<div class="ops-shards"><div class="ops-row"><div class="ops-name">Index<span>${st.pending.length + sim.queueStats('changes').depth} change${st.pending.length + sim.queueStats('changes').depth === 1 ? '' : 's'} waiting · refresh every ${st.config.nrt ? '0.3' : '3'} s</span></div></div>
            <div class="ops-row" data-tone="${w > 500 ? 'fail' : w > 100 ? 'warn' : ''}"><div class="ops-name">#sunset counter${st.config.shardTags ? ', 8 rows' : ', one row'}<span>${Y.num(st.counts.sunset)} · queue ${Math.round(w)} ms${st.stats.incTimeouts ? ` · ${Y.num(st.stats.incTimeouts)} increments timed out` : ''}</span></div></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  function emit(ctx, payload) {
    const st = ctx.state;
    const ev = { type: payload.type, eventId: 'c' + ++st.seq.ev, payload, actionId: ctx.actionId };
    if (ctx.mode('reorder', 'changes') && payload.type === 'post.created' && !st.holding) {
      st.holding = true;
      ctx.log({ op: `${ev.eventId} delayed in the change stream`, status: 'fault', actionId: ctx.actionId, detail: 'This partition is behind: the next change will be delivered first.' });
      ctx.spawn(function* (c) { yield c.wait(900); c.sim.enqueue('changes', ev); c.state.holding = false; }, { self: 'changes', quiet: true });
    } else ctx.sim.enqueue('changes', ev);
  }
  function shardHandler(id) {
    return {
      query(ctx, p) {
        const docs = Object.values(ctx.state.shards[id]).filter((d) => !d.tombstone);
        return { hits: docs.filter((d) => (p.prefix ? ('#' + d.tag).startsWith(p.prefix) : p.q === 'maya' ? d.author === 'maya.k' : d.tag === p.q)).map((d) => Object.assign({}, d)) };
      },
    };
  }
  function counterHandlers() {
    return {
      inc(ctx, p) { ctx.state.counts[p.tag] = (ctx.state.counts[p.tag] || 0) + 1; return { count: ctx.state.counts[p.tag] }; },
      get(ctx, p) { return { count: ctx.state.counts[p.tag] || 0 }; },
    };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
