/*
 * Search and indexing. New videos flow through an index pipeline into three
 * shards; a new document becomes searchable only after the next refresh.
 * Queries scatter to every shard and gather the top results; a typeahead
 * cache answers prefix suggestions without touching the shards.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const SHARDS = ['shardA', 'shardB', 'shardC'];
  const DOCS = [
    ['Raft consensus explained', 'raft'], ['Raft vs Paxos', 'raft'], ['Building Raft in Go', 'raft'], ['Kafka for beginners', 'kafka'],
    ['Kafka exactly-once', 'kafka'], ['Kafka vs Pulsar', 'kafka'], ['Sourdough at home', 'bread'], ['Rye bread basics', 'bread'],
  ];
  const QUERIES = { raft: 'raft', kafka: 'kafka', bread: 'bread', new: 'raft' };
  const shardOf = (id) => SHARDS[id % 3];

  function startSearch(sim) {
    const term = QUERIES[sim.ui.viewer.query];
    sim.startAction(`Viewer: search “${term}”`, function* (ctx) {
      const u = ctx.ui.viewer;
      Y.L(ctx, { displayed: 'pending', committed: ['n/a', 'Searching writes nothing.'], async: 'n/a', retrySafe: 'yes' });
      const t0 = ctx.now();
      const tip = yield ctx.call('gateway', 'suggest', { prefix: term.slice(0, 2) }, { timeout: 800 });
      u.suggest = tip.ok ? tip.value.words : [];
      u.suggestMs = ctx.now() - t0;
      const t1 = ctx.now();
      const r = yield ctx.call('gateway', 'search', { term }, { timeout: 1500 });
      u.took = ctx.now() - t1;
      ctx.recordOutcome(r.ok, ctx.now() - t0);
      if (r.ok) {
        Object.assign(u, { results: r.value.hits, partial: r.value.partial, error: null });
        Y.L(ctx, { displayed: ['yes', `${r.value.hits.length} results${r.value.partial ? ', marked incomplete' : ''}.`], accepted: 'yes' });
        const fresh = ctx.state.published && r.value.hits.some((h) => h.id === ctx.state.published.id);
        ctx.explain(`The query went to all three shards in parallel and the top hits were merged${r.value.partial ? `, but ${r.value.partial} did not answer, so the results are incomplete and say so` : ''}.${ctx.state.published ? ` The video published at T+${Math.round(ctx.state.published.t)} ms is ${fresh ? 'searchable' : 'not searchable yet: it has not reached a refreshed index'}.` : ''}`);
      } else { Object.assign(u, { results: [], error: `Search failed: ${r.error.message}` }); Y.failed(ctx, 'Shows an error.'); }
    }, { self: 'viewer' });
  }
  function startPublish(sim) {
    const st = sim.state;
    sim.startAction('Creator: publish “Raft deep dive, part 2”', function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('meta', 'publish', { title: 'Raft deep dive, part 2', term: 'raft' }, { timeout: 800 });
      if (r.ok) { st.published = { id: r.value.id, t: ctx.now(), actionId: ctx.actionId }; Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', 'Waiting to become searchable.'] }); }
      else Y.failed(ctx);
    }, { self: 'creator' });
  }

  const sc = (SDL.scenarios.search = {
    id: 'search',
    seed: 167,
    productWidth: 440,
    intro: 'Search for “raft”. Then publish a new Raft video from the creator side and search again: it appears only after the index refreshes. Take a shard down to see partial results.',
    topology: {
      width: 1100, height: 540,
      nodes: [
        { id: 'viewer', label: 'YouTube app', sub: 'Search box', kind: 'client', x: 100, y: 90, latency: 1, role: 'Shows suggestions as you type and results when you search.', owns: ['Nothing'] },
        { id: 'creator', label: 'Creator', sub: 'Publishes', kind: 'client', x: 100, y: 420, latency: 1, role: 'Publishes new videos.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Viewer traffic', kind: 'gateway', x: 320, y: 90, latency: 2, role: 'Routes searches and suggestions.', ops: [{ name: 'search', desc: 'Full search.' }, { name: 'suggest', desc: 'Typeahead.' }], owns: ['Nothing durable'] },
        { id: 'typeahead', label: 'Typeahead cache', sub: 'Prefix → words', kind: 'cache', x: 320, y: 270, latency: 2, role: 'Popular completions per prefix, served from memory.', ops: [{ name: 'get', desc: 'Suggestions for a prefix.' }], owns: ['completions'] },
        { id: 'query', label: 'Query service', sub: 'Scatter-gather', kind: 'service', x: 540, y: 90, latency: 4, role: 'Sends each query to every shard and merges the top results.', ops: [{ name: 'search', desc: 'Scatter, gather, merge.' }], owns: ['Merge rules'] },
        { id: 'shardA', label: 'Index shard A', sub: 'A third of videos', kind: 'db', x: 800, y: 50, latency: 20, role: 'An inverted index over one third of the videos.', ops: [{ name: 'query', desc: 'Matching documents.' }], owns: ['index part A'] },
        { id: 'shardB', label: 'Index shard B', sub: 'A third of videos', kind: 'db', x: 800, y: 170, latency: 20, role: 'An inverted index over one third of the videos.', ops: [{ name: 'query', desc: 'Matching documents.' }], owns: ['index part B'] },
        { id: 'shardC', label: 'Index shard C', sub: 'A third of videos', kind: 'db', x: 800, y: 290, latency: 20, role: 'An inverted index over one third of the videos.', ops: [{ name: 'query', desc: 'Matching documents.' }], owns: ['index part C'] },
        { id: 'meta', label: 'Video metadata', sub: 'Emits changes', kind: 'db', x: 320, y: 420, latency: 6, role: 'The source of truth for titles; emits a change event per publish.', ops: [{ name: 'publish', desc: 'New video.' }], owns: ['videos'] },
        { id: 'changes', label: 'Change stream', sub: 'Index feed', kind: 'queue', x: 540, y: 420, latency: 3, queue: 'changes', role: 'Video changes waiting to be indexed.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['change log'] },
        { id: 'indexer', label: 'Indexer', sub: 'Builds index', kind: 'worker', x: 800, y: 420, latency: 5, role: 'Writes documents into the right shard; they become searchable at the next refresh.', ops: [{ name: 'consume', desc: 'Index a document.' }], owns: ['Pending, unrefreshed documents'] },
      ],
      edges: [
        { from: 'viewer', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'typeahead', latency: 3 },
        { from: 'gateway', to: 'query', latency: 3 },
        { from: 'query', to: 'shardA', latency: 3 },
        { from: 'query', to: 'shardB', latency: 3 },
        { from: 'query', to: 'shardC', latency: 3 },
        { from: 'typeahead', to: 'query', latency: 3, label: 'miss' },
        { from: 'creator', to: 'meta', latency: 30 },
        { from: 'meta', to: 'changes', latency: 4 },
        { from: 'changes', to: 'indexer', latency: 3 },
        { from: 'indexer', to: 'shardC', latency: 4, via: [[930, 420], [930, 290]] },
      ],
      queues: [{ id: 'changes', broker: 'changes', label: 'changes', groups: ['indexer'] }],
    },
    failures: [
      { id: 'b-down', node: 'shardB', mode: 'down', label: 'Index shard B down', desc: 'A third of the index is unreachable.' },
      { id: 'b-slow', node: 'shardB', mode: 'slow', params: { factor: 60 }, label: 'Index shard B slow', desc: 'One shard drags every query down.' },
      { id: 'indexer-paused', node: 'indexer', mode: 'paused', label: 'Indexer stalled', desc: 'New videos stop reaching the index.' },
      { id: 'ta-down', node: 'typeahead', mode: 'down', label: 'Typeahead cache down', desc: 'Suggestions fall back to the shards.' },
    ],
    switches: Y.switches([
      ['partial', 'Return partial results', 'If a shard fails or misses 300 ms, return the rest marked incomplete. Off: fail the search.'],
      ['nrt', 'Near-real-time refresh', 'Refresh the index every 0.3 s. Off: every 3 s, cheaper but staler.'],
      ['typeahead', 'Typeahead cache', 'Off: every keystroke runs a full scatter-gather query.'],
    ]),
    presets: Y.presets({ partial: true, nrt: true, typeahead: true }, [
      { id: 'search', label: 'Search', desc: 'Suggestions from the cache, then results from three shards.', run: (s) => startSearch(s) },
      { id: 'fresh', label: 'Publish, then search', desc: 'With near-real-time refresh, the new video is searchable within a second.', run: (s) => { startPublish(s); s.schedule(1200, () => { s.ui.viewer.query = 'new'; startSearch(s); }); } },
      { id: 'fresh-slow', label: 'Publish, then search, slow refresh', desc: 'With a 3 s refresh the same search misses the new video.', sw: { nrt: false }, run: (s) => { startPublish(s); s.schedule(1200, () => { s.ui.viewer.query = 'new'; startSearch(s); }); } },
      { id: 'lag', label: 'Indexer stalled', desc: 'The new video stays unsearchable until indexing resumes.', run: (s) => { s.inject('indexer', 'paused', true, 4000); startPublish(s); s.schedule(1500, () => { s.ui.viewer.query = 'new'; startSearch(s); }); } },
      { id: 'shard-down', label: 'Shard down, partial results', desc: 'Results from two shards, clearly marked incomplete.', run: (s) => { s.inject('shardB', 'down'); startSearch(s); } },
      { id: 'shard-down-bad', label: 'Shard down, all or nothing', desc: 'The search fails because one shard of three is down.', sw: { partial: false }, run: (s) => { s.inject('shardB', 'down'); startSearch(s); } },
      { id: 'shard-slow', label: 'Slow shard, partial results', desc: 'The slow shard misses its budget; results arrive on time without it.', run: (s) => { s.inject('shardB', 'slow', { factor: 60 }); startSearch(s); } },
      { id: 'no-typeahead', label: 'No typeahead cache', desc: 'Suggestions need a full scatter-gather and arrive noticeably later.', sw: { typeahead: false }, run: (s) => startSearch(s) },
    ]),
    initialState: () => {
      const shards = { shardA: [], shardB: [], shardC: [] };
      DOCS.forEach(([title, term], i) => shards[shardOf(i)].push({ id: i, title, term }));
      return { config: { partial: true, nrt: true, typeahead: true }, shards, pending: [], nextId: DOCS.length, published: null, searchableAt: null, lastRefresh: 0 };
    },
    initialUI: () => ({ viewer: { query: 'raft', results: [], partial: null, suggest: [], suggestMs: null, took: null, error: null } }),
    actions: { search(sim) { startSearch(sim); }, publish(sim) { startPublish(sim); }, set: Y.setAction },
    handlers: {
      gateway: {
        search: function* (ctx, p) { return ctx.must(yield ctx.call('query', 'search', p, { timeout: 1400 })); },
        suggest: function* (ctx, p) {
          if (ctx.state.config.typeahead) { const r = yield ctx.call('typeahead', 'get', p, { timeout: 200 }); if (r.ok) { ctx.count('cacheHit'); return r.value; } }
          ctx.count('cacheMiss');
          const q = ctx.must(yield ctx.call('query', 'search', { term: p.prefix, prefix: true }, { timeout: 700 }));
          return { words: q.hits.slice(0, 3).map((h) => h.title.toLowerCase()) };
        },
      },
      typeahead: { get(ctx, p) { return { words: DOCS.filter(([t]) => t.toLowerCase().startsWith(p.prefix)).slice(0, 3).map(([t]) => t.toLowerCase()) }; } },
      query: {
        search: function* (ctx, p) {
          const st = ctx.state;
          const res = {};
          SHARDS.forEach((sh) => ctx.spawn(function* (c) { res[sh] = yield c.call(sh, 'query', p, { timeout: 1200 }); }));
          const t0 = ctx.now();
          const budget = st.config.partial ? 300 : 1300;
          while (Object.keys(res).length < 3 && ctx.now() - t0 < budget) yield ctx.wait(20);
          const ok = SHARDS.filter((s) => res[s] && res[s].ok);
          const bad = SHARDS.filter((s) => !ok.includes(s));
          if (bad.length && !st.config.partial) ctx.fail('SHARD_FAILED', `${bad.map((b) => ctx.sim.nodes[b].label).join(', ')} did not answer.`);
          return { hits: ok.flatMap((s) => res[s].value.hits).sort((a, b) => b.id - a.id), partial: bad.length ? bad.map((b) => ctx.sim.nodes[b].label).join(', ') : null };
        },
      },
      shardA: shardHandler('shardA'), shardB: shardHandler('shardB'), shardC: shardHandler('shardC'),
      meta: {
        publish(ctx, p) {
          const st = ctx.state;
          const id = st.nextId++;
          ctx.sim.enqueue('changes', { type: 'video.published', payload: { id, title: p.title, term: p.term }, actionId: ctx.actionId });
          return { id };
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
      // Periodic refresh: pending documents become visible in their shard.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const st = ctx.state;
          if (ctx.sim.nodes.indexer.modes.paused) continue;
          const every = st.config.nrt ? 300 : 3000;
          if (ctx.now() - st.lastRefresh < every || !st.pending.length) continue;
          st.lastRefresh = ctx.now();
          for (const d of st.pending.splice(0)) {
            st.shards[shardOf(d.id)].push({ id: d.id, title: d.title, term: d.term });
            if (st.published && d.id === st.published.id) { st.searchableAt = ctx.now(); ctx.sim.setLedger(d.actionId, 'async', 'yes', `Searchable ${((ctx.now() - st.published.t) / 1000).toFixed(1)} s after publishing.`); }
            ctx.log({ op: `indexed “${d.title}”`, status: 'ok', detail: `Visible in ${ctx.sim.nodes[shardOf(d.id)].label} after the refresh.` });
          }
        }
      }, { self: 'indexer', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.viewer;
      if (u.error) return { key: 'wrong', label: 'The viewer got an error because one shard of three was unavailable.' };
      if (st.published && !st.searchableAt) return { key: 'stale', label: `The new video was published ${((sim.now - st.published.t) / 1000).toFixed(1)} s ago and is not searchable yet.` };
      if (u.partial) return { key: 'stale', label: `Results are incomplete: ${u.partial} did not answer. The page says so.` };
      return { key: 'ok', label: 'Every published video is searchable and results are complete.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const u = sim.ui.viewer;
      return [
        { label: 'Search time', value: u.took == null ? 'n/a' : SDL.fmtMs(u.took), tone: u.took > 800 ? 'warn' : '' },
        { label: 'Suggestion time', value: u.suggestMs == null ? 'n/a' : SDL.fmtMs(u.suggestMs), tone: u.suggestMs > 200 ? 'warn' : 'ok' },
        { label: 'Publish to searchable', value: st.searchableAt ? `${((st.searchableAt - st.published.t) / 1000).toFixed(1)} s` : st.published ? 'not yet' : 'n/a' },
        { label: 'Waiting to be indexed', value: st.pending.length + sim.queueStats('changes').depth },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['viewer', 'Your phone']], { note: 'Pick a search and run it. The creator button publishes a new video that matches “raft”.', below: '<p><button class="btn" data-act="publish">Creator: publish “Raft deep dive, part 2”</button></p>' });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const u = sim.ui.viewer;
        const body = `<div class="app-row"><label for="qs">Search</label><select id="qs" data-field="viewer.query">${Object.entries({ raft: 'raft', kafka: 'kafka', bread: 'bread', new: 'raft (after publishing)' }).map(([k, v]) => `<option value="${k}"${k === u.query ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
          ${Y.btn('search', 'Search')}
          ${u.suggest.length ? `<p class="app-sub">Suggestions: ${u.suggest.map(esc).join(', ')}</p>` : ''}
          ${u.partial ? Y.msg(`Some results may be missing (${u.partial} unavailable).`, 'warn') : ''}${u.error ? Y.msg(u.error, 'fail') : ''}
          <div class="yt-feed">${u.results.map((h, i) => `<div class="yt-card"><div class="yt-thumb" style="--h:${(h.id * 53) % 360}">▶</div><div><strong>${esc(h.title)}</strong>${h.id >= DOCS.length ? '<span class="yt-tag">New</span>' : ''}</div></div>`).join('')}</div>`;
        Y.paint(el, sim, 'viewer', { head: '<div><p class="app-title">YouTube</p><p class="app-sub">Search</p></div>', body }, {});
      },
    },
  });
  function shardHandler(id) {
    return { query(ctx, p) { return { hits: ctx.state.shards[id].filter((d) => (p.prefix ? d.title.toLowerCase().startsWith(p.term) : d.term === p.term)) }; } };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
