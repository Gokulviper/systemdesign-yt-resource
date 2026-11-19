/*
 * Search by place and dates.
 * Maya searches Lake Tahoe for Dec 30 – Jan 2. Listings live in two geo
 * shards (north shore, south shore); each indexed listing carries a bitmap of
 * its nights, so the shard filters out anything not free for the whole stay.
 * The listing database is the source of truth: every booking, block, and
 * unblock is captured from its log, put on a change stream, and applied to the
 * owning shard by an indexer. The search service fans out to the shards the
 * map covers, merges, asks the ranker to order the hits, optionally re-checks
 * the top page against the listing database, and serves page 2 either from a
 * snapshot cursor or by recomputing with an offset. A short-lived query cache
 * with request coalescing absorbs a flood of identical New Year searches.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const DAYS = ['Dec 29', 'Dec 30', 'Dec 31', 'Jan 1', 'Jan 2', 'Jan 3'];
  const STAY = [1, 2, 3];
  const PAGE = 4;
  const SHARD_BUDGET = 400;
  const RANK_BUDGET = 250;
  const CACHE_TTL = 1000;
  const RUSH = 250;
  // id, name, area, shard, nightly price, ranking score, nights already taken
  const LISTINGS = [
    ['cabin', 'Lakeside cabin', 'Tahoe City', 'shardA', 399, 92, []],
    ['granite', 'Granite house', 'Incline Village', 'shardA', 520, 90, []],
    ['ridge', 'Ridge A-frame', 'Carnelian Bay', 'shardA', 349, 88, []],
    ['pine', 'Pine loft', 'Kings Beach', 'shardA', 289, 85, []],
    ['shore', 'Shore studio', 'Tahoe Vista', 'shardA', 199, 70, [2]],
    ['heavenly', 'Heavenly condo', 'South Lake Tahoe', 'shardB', 259, 87, []],
    ['stateline', 'Stateline suite', 'Stateline', 'shardB', 310, 80, []],
    ['meadow', 'Meadow cottage', 'Meyers', 'shardB', 230, 78, []],
    ['emerald', 'Emerald view', 'Emerald Bay', 'shardB', 450, 95, [1, 2]],
    ['camp', 'Camp Richardson cabin', 'Camp Richardson', 'shardB', 180, 65, []],
  ];
  const VIEWS = { north: { label: 'North shore', shards: ['shardA'] }, lake: { label: 'Whole lake', shards: ['shardA', 'shardB'] } };
  const SHARD_NAME = { shardA: 'shard A (north)', shardB: 'shard B (south)' };
  const NAME = Object.fromEntries(LISTINGS.map((l) => [l[0], l[1]]));
  const usd = (n) => '$' + Number(n).toLocaleString('en-US');
  const freeFor = (nights) => STAY.every((d) => !nights[d]);
  const inView = (view, id) => VIEWS[view].shards.includes(LISTINGS.find((l) => l[0] === id)[3]);

  /* ---------------- flows ---------------- */
  function startSearch(sim, page) {
    const u = sim.ui.maya;
    if (u.loading) return;
    page = page || 0;
    const view = u.view;
    sim.startAction(`Maya: search ${VIEWS[view].label}, Dec 30 – Jan 2${page ? ', page 2' : ''}`, function* (ctx) {
      const st = ctx.state;
      Object.assign(u, { loading: true, error: '' });
      Y.L(ctx, { displayed: 'pending', committed: ['n/a', 'Searching writes nothing.'], async: 'n/a', retrySafe: 'yes' });
      const r = yield ctx.call('api', 'search', { view, page, cursor: page ? u.cursor : null }, { timeout: 1600 });
      ctx.recordOutcome(r.ok, r.latency);
      u.loading = false;
      u.took = r.latency;
      st.lat.push(r.latency);
      if (!r.ok) {
        Object.assign(u, { results: [], error: r.error.code === 'SHARD_FAILED' ? 'Search isn’t available right now. Try again in a moment.' : `Search failed: ${r.error.message}`, partial: null, fallback: false, page });
        Y.failed(ctx, 'An error instead of results.');
        ctx.explain(r.error.code === 'SHARD_FAILED'
          ? `${r.error.message} The search waits for every shard, so half the lake being unreachable became no results at all.`
          : `The search failed with ${r.error.code}.`);
        return;
      }
      const v = r.value;
      if (!page) { u.shown = {}; u.cursor = v.cursor; u.view0 = view; }
      u.shown[page] = v.items.map((h) => h.id);
      Object.assign(u, { results: v.items, partial: v.partial, fallback: v.fallback, page, total: v.total, hasMore: v.hasMore, removed: v.removed, shards: v.shards, from: v.from });
      Y.L(ctx, { displayed: ['yes', `${v.items.length} stays${v.partial ? ', marked incomplete' : ''}.`], accepted: 'yes' });
      const booked = v.items.filter((h) => !freeFor(st.db[h.id].nights));
      let why = v.from === 'cursor'
        ? `Page 2 came from the snapshot the first page saved (cursor ${v.cursor || u.cursor}): the same ranked list, so nothing repeats and nothing is skipped${st.rankVer > 1 ? ', even though ranking changed in between' : ''}.`
        : v.from === 'cache'
          ? 'The query cache had this exact search from less than a second ago, so no shard was asked.'
          : `The search went to ${v.shards.map((s) => SHARD_NAME[s]).join(' and ')}: the shards whose map cells the view covers. Each filtered out listings with any of the three nights taken, using the bitmap stored with the listing.`;
      if (v.fallback) why += ' The ranker did not answer in time, so the hits are ordered by price instead: a worse page than usual, but a page.';
      if (v.partial) why += ` ${v.partial} did not answer within ${SHARD_BUDGET} ms, so the page shows the rest and says it may be incomplete.`;
      if (v.removed.length) why += ` The re-check against the listing database removed ${v.removed.map((id) => NAME[id]).join(', ')}: the index still says free, but the nights are gone.`;
      if (booked.length) why += ` ${booked.map((h) => NAME[h.id]).join(', ')} is shown although its nights are taken: the index has not received the change and nothing re-checked it.`;
      if (page && v.from !== 'cursor') {
        const dup = v.items.filter((h) => (u.shown[0] || []).includes(h.id));
        if (dup.length) why += ` Page 2 was recomputed with an offset of ${PAGE} against today’s ranking. ${dup.map((h) => NAME[h.id]).join(', ')} moved down and appears twice; whatever moved up was skipped.`;
      }
      ctx.explain(why);
    }, { self: 'maya' });
  }

  function change(sim, kind) {
    const label = { block: 'Lena: block Dec 31', unblock: 'Lena: unblock Dec 31', book: 'Dev books the cabin, Dec 30 – Jan 2' }[kind];
    sim.startAction(label, function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call('listings', 'update', { id: 'cabin', kind }, { timeout: 1200 });
      ctx.recordOutcome(r.ok, r.latency);
      if (!r.ok) { sim.ui.lena.message = `Couldn’t save: ${r.error.message}`; Y.failed(ctx, r.error.message); return; }
      sim.ui.lena.message = { block: 'Dec 31 is blocked.', unblock: 'Dec 31 is open again.', book: 'Dev booked Dec 30 – Jan 2.' }[kind];
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Listing version ${r.value.ver}.`], async: ['pending', 'Waiting to reach the search index.'] });
      ctx.explain(`The listing database committed version ${r.value.ver}. Change data capture puts it on the change stream with the whole night bitmap, and the indexer writes it to ${SHARD_NAME.shardA}. Until then, search answers from the old bitmap.`);
    }, { self: 'lena' });
  }

  function rerank(sim) {
    sim.state.scores.pine = 93;
    sim.state.rankVer++;
    sim.note('Ranking refresh: new reviews lift Pine loft from 85 to 93. It moves from page 2 to the top of page 1.');
  }

  /** A New Year’s Eve rush: RUSH people run the same search within half a second. */
  function rush(sim) {
    const st = sim.state;
    if (st.flood) return;
    st.flood = { n: 0, done: 0, slow: 0, partial: 0, failed: 0, lat: [] };
    for (let i = 0; i < RUSH; i++) {
      sim.schedule(i * 2, () => sim.spawn(function* (ctx) {
        const f = ctx.state.flood;
        f.n++;
        const r = yield ctx.call('search', 'search', { view: 'lake', page: 0, cursor: null, rush: true }, { timeout: 1500, quiet: 'all' });
        f.done++;
        f.lat.push(r.latency);
        ctx.state.lat.push(r.latency);
        if (!r.ok) f.failed++;
        else if (r.value.partial) f.partial++;
        if (r.latency > 500) f.slow++;
      }, { self: 'api', quiet: 'all' }));
    }
    sim.note(`New Year’s Eve rush: ${RUSH} people search “Lake Tahoe, Dec 30 – Jan 2” within half a second.`);
  }

  /* ---------------- search internals ---------------- */
  /** The ranked hit list for a view: from the query cache, or from the shards and the ranker. */
  function* ranked(ctx, view) {
    const st = ctx.state;
    const cfg = st.config;
    const useCache = cfg.cache && !ctx.sim.nodes.cache.modes.down;
    if (useCache) {
      for (;;) {
        const g = yield ctx.call('cache', 'get', { key: view }, { timeout: 150, quiet: 'all' });
        if (!g.ok) break;
        if (g.value.hit) { st.stats.hits++; return Object.assign({}, g.value.hit, { from: 'cache' }); }
        if (!g.value.wait) break; // a miss: this request fetches and others wait for it
        st.stats.coalesced++;
        while (st.inflight[view]) yield ctx.wait(5);
      }
    }
    st.stats.misses++;
    try {
      const shards = VIEWS[view].shards;
      const res = {};
      for (const sh of shards) {
        st.stats.shardQueries[sh]++;
        ctx.spawn(function* (c) { res[sh] = yield c.call(sh, 'query', { nights: STAY }, { timeout: 1200, quiet: 'all' }); }, { quiet: 'all' });
      }
      const t0 = ctx.now();
      const budget = cfg.partial ? SHARD_BUDGET : 1250;
      while (Object.keys(res).length < shards.length && ctx.now() - t0 < budget) yield ctx.wait(5);
      const ok = shards.filter((s) => res[s] && res[s].ok);
      const bad = shards.filter((s) => !ok.includes(s));
      if (bad.length && !cfg.partial) ctx.fail('SHARD_FAILED', `${bad.map((s) => SHARD_NAME[s]).join(', ')} did not answer.`);
      if (!ok.length) ctx.fail('SHARD_FAILED', 'No shard answered.');
      let hits = ok.flatMap((s) => res[s].value.hits);
      let fallback = false;
      const rk = yield ctx.call('ranker', 'rank', { ids: hits.map((h) => h.id) }, { timeout: RANK_BUDGET, quiet: 'all' });
      if (rk.ok) hits = rk.value.ids.map((id) => hits.find((h) => h.id === id));
      else { fallback = true; hits = hits.slice().sort((a, b) => a.price - b.price); }
      const out = { list: hits, partial: bad.length ? bad.map((s) => SHARD_NAME[s]).join(', ') : null, fallback, shards, from: 'index' };
      if (useCache && !out.partial && !fallback) yield ctx.call('cache', 'put', { key: view, entry: { list: hits, partial: null, fallback: false, shards } }, { timeout: 150, quiet: 'all' });
      return out;
    } finally {
      if (useCache) delete st.inflight[view];
    }
  }

  /** The listing database as the re-check sees it: live, or a lagging copy. */
  const dbView = (st, lagging) => (lagging && st.lagSnap ? st.lagSnap : st.db);

  SDL.scenarios['bnb-search'] = {
    id: 'bnb-search',
    seed: 4409,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Search the whole lake for Dec 30 – Jan 2, then tap “Next page”. Book the cabin or block a night from the console and search again: the index catches up a moment later. Then pause the indexer, reorder its events, take a shard down, or start the New Year’s Eve rush.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'Lake Tahoe · Dec 30 – Jan 2', kind: 'client', x: 90, y: 110, latency: 1, role: 'Searches by map area and dates, then pages through results.', owns: ['What Maya sees'] },
        { id: 'lena', label: 'Lena’s console', sub: 'Lakeside cabin', kind: 'client', x: 90, y: 480, latency: 1, role: 'Blocks and unblocks nights. Dev’s booking of the cabin also arrives here.', owns: ['What Lena sees'] },
        { id: 'api', label: 'API gateway', sub: 'Routing', kind: 'gateway', x: 280, y: 110, latency: 2, role: 'Routes searches to the search service.', ops: [{ name: 'search', desc: 'Search by area and dates.' }], owns: ['Nothing durable'] },
        { id: 'search', label: 'Search service', sub: 'Fan out, merge, page', kind: 'service', x: 500, y: 110, latency: 3, role: 'Sends the query to the shards the map covers, merges, ranks, re-checks the top page, and pages with a snapshot cursor or an offset.', ops: [{ name: 'search', desc: 'One page of results.' }], owns: ['Cursors (page snapshots)'] },
        { id: 'cache', label: 'Query cache', sub: `${CACHE_TTL / 1000} s, coalescing`, kind: 'cache', x: 500, y: 290, latency: 2, role: `Keeps each ranked result list for ${CACHE_TTL / 1000} s. While one request fetches a missing entry, identical requests wait for it instead of asking the shards.`, ops: [{ name: 'get', desc: 'Read or wait.' }, { name: 'put', desc: 'Store a result list.' }], owns: ['Recent result lists'] },
        { id: 'ranker', label: 'Ranker', sub: 'Orders the hits', kind: 'service', x: 720, y: 30, latency: 20, role: 'Scores each listing by reviews, conversion, and price. Has a 250 ms budget.', ops: [{ name: 'rank', desc: 'Order listing ids.' }], owns: ['Model scores'] },
        { id: 'shardA', label: 'Geo shard A', sub: 'North shore', kind: 'db', x: 760, y: 170, latency: 8, serviceMs: 10, servers: 2, role: 'Listings whose map cells are on the north shore, each with a bitmap of free nights.', ops: [{ name: 'query', desc: 'Listings free for the stay.' }, { name: 'apply', desc: 'Index a change.' }], owns: ['index, north shore'] },
        { id: 'shardB', label: 'Geo shard B', sub: 'South shore', kind: 'db', x: 760, y: 330, latency: 8, serviceMs: 10, servers: 2, role: 'Listings on the south shore, each with a bitmap of free nights.', ops: [{ name: 'query', desc: 'Listings free for the stay.' }, { name: 'apply', desc: 'Index a change.' }], owns: ['index, south shore'] },
        { id: 'listings', label: 'Listing database', sub: 'Source of truth', kind: 'db', x: 280, y: 480, latency: 6, role: 'Listings and their nights. Every commit appears in its log. The re-check reads it.', ops: [{ name: 'update', desc: 'Book, block, or unblock.' }, { name: 'check', desc: 'Are these listings free?' }], owns: ['listings', 'nights'] },
        { id: 'cdc', label: 'Change stream', sub: 'Change data capture', kind: 'queue', x: 540, y: 480, latency: 3, queue: 'changes', role: 'Every committed listing change, with its version and full night bitmap.', owns: ['change log'] },
        { id: 'indexer', label: 'Indexer', sub: 'Applies changes', kind: 'worker', x: 980, y: 480, latency: 4, role: 'Reads changes and writes each to the shard that owns the listing.', owns: ['Nothing durable'] },
      ],
      edges: [
        { from: 'maya', to: 'api', latency: 40, label: 'mobile network' },
        { from: 'lena', to: 'listings', latency: 40 },
        { from: 'api', to: 'search', latency: 3 },
        { from: 'search', to: 'cache', latency: 2 },
        { from: 'search', to: 'ranker', latency: 3 },
        { from: 'search', to: 'shardA', latency: 3 },
        { from: 'search', to: 'shardB', latency: 3 },
        { from: 'search', to: 'listings', latency: 4, label: 're-check', via: [[400, 110], [400, 420], [280, 420]] },
        { from: 'listings', to: 'cdc', latency: 3, label: 'log' },
        { from: 'cdc', to: 'indexer', latency: 3 },
        { from: 'indexer', to: 'shardA', latency: 3, via: [[980, 170]] },
        { from: 'indexer', to: 'shardB', latency: 3, via: [[980, 330]] },
      ],
      queues: [{ id: 'changes', broker: 'cdc', label: 'changes', groups: ['indexer'] }],
    },
    modeLabels: { reorder: 'Delivering out of order', stale: 'Ignoring expiry', lag: 'Re-check reads a lagging copy' },
    failures: [
      { id: 'indexer-paused', node: 'indexer', mode: 'paused', label: 'Indexer paused', desc: 'Bookings and blocks stop reaching the index. Search shows nights as free that are gone.' },
      { id: 'reorder', node: 'cdc', mode: 'reorder', label: 'Change stream delivers out of order', desc: 'As after a partition rebalance: an older change arrives after a newer one.' },
      { id: 'b-down', node: 'shardB', mode: 'down', label: 'Geo shard B down', desc: 'The south shore is unsearchable.' },
      { id: 'b-slow', node: 'shardB', mode: 'slow', params: { factor: 60 }, label: 'Geo shard B slow', desc: 'The south shore misses the shard budget on every query.' },
      { id: 'rank-down', node: 'ranker', mode: 'down', label: 'Ranker down', desc: 'Nobody can order the hits; search falls back to price order.' },
      { id: 'cache-stale', node: 'cache', mode: 'stale', label: 'Query cache ignores expiry', desc: 'Entries are served long after their second is up, bookings or not.' },
      { id: 'cache-down', node: 'cache', mode: 'down', label: 'Query cache down', desc: 'Every search goes to the shards.' },
      { id: 'listings-lag', node: 'listings', mode: 'lag', label: 'Re-check reads a lagging replica', desc: 'The re-check sees the listing database as it was when the lag began, so it cannot catch a fresh booking.' },
    ],
    switches: Y.switches([
      ['recheck', 'Re-check the top page', 'Before showing a page, ask the listing database whether those listings are still free. Off: trust the index.'],
      ['versions', 'Versioned index writes', 'A shard applies a change only if its version is newer than what it holds. Off: whatever arrives last wins.'],
      ['partial', 'Partial results', `If a shard misses ${SHARD_BUDGET} ms, show the rest and say so. Off: wait for every shard, and fail if one is down.`],
      ['cursor', 'Snapshot cursor for paging', 'Page 1 saves its ranked list; page 2 reads from it. Off: page 2 re-runs the search and skips the first 4.'],
      ['cache', 'Query cache with coalescing', `Keep each result list for ${CACHE_TTL / 1000} s, and let identical requests wait for one fetch. Off: every search asks the shards.`],
    ]),
    presets: Y.presets({ recheck: true, versions: true, partial: true, cursor: true, cache: true }, [
      { id: 'search', label: 'Search, re-rank, then page 2', desc: 'Eight stays across both shards, four per page. Ranking refreshes before Maya taps “Next page”; the snapshot cursor still gives the other four.', run: (s) => { startSearch(s); s.schedule(700, () => rerank(s)); s.schedule(1500, () => startSearch(s, 1)); } },
      { id: 'lag-index', label: 'Indexer paused, index only', desc: 'Dev books the cabin. The indexer is paused, so the shard still says the nights are free, and Maya is shown a cabin that can’t be booked.', sw: { recheck: false }, run: (s) => { s.inject('indexer', 'paused', null, 5000); change(s, 'book'); s.schedule(800, () => startSearch(s)); } },
      { id: 'lag-recheck', label: 'Indexer paused, re-check', desc: 'Same lag. The search re-checks its top page against the listing database and drops the cabin before Maya sees it.', run: (s) => { s.inject('indexer', 'paused', null, 5000); change(s, 'book'); s.schedule(800, () => startSearch(s)); } },
      { id: 'reorder-bad', label: 'Block and unblock reversed, no versions', desc: 'Lena blocks Dec 31, then reopens it. The block arrives last and wins: the cabin is hidden from New Year searches for good.', sw: { versions: false }, run: (s) => { s.inject('cdc', 'reorder'); change(s, 'block'); s.schedule(150, () => change(s, 'unblock')); s.schedule(2500, () => startSearch(s)); } },
      { id: 'reorder', label: 'Block and unblock reversed, versions', desc: 'Same reorder. The shard already has version 3, so the late version 2 is ignored and the cabin stays searchable.', run: (s) => { s.inject('cdc', 'reorder'); change(s, 'block'); s.schedule(150, () => change(s, 'unblock')); s.schedule(2500, () => startSearch(s)); } },
      { id: 'shard-wait', label: 'Shard down, wait for every shard', desc: 'The south shore shard is down. Waiting for it means Maya gets an error instead of the north shore stays.', sw: { partial: false }, run: (s) => { s.inject('shardB', 'down'); startSearch(s); } },
      { id: 'shard-partial', label: 'Shard down, partial results', desc: 'Same outage. Maya sees the four north shore stays and a banner saying results may be missing.', run: (s) => { s.inject('shardB', 'down'); startSearch(s); } },
      { id: 'rank-down', label: 'Ranker down', desc: 'Both shards answer, the ranker doesn’t. Results come back in price order instead of best match.', run: (s) => { s.inject('ranker', 'down'); startSearch(s); } },
      { id: 'rush-cache', label: 'New Year’s Eve rush, coalesced cache', desc: `${RUSH} identical searches in half a second. One goes to the shards; the rest wait for it or hit the cache.`, run: (s) => { rush(s); s.schedule(300, () => startSearch(s)); } },
      { id: 'rush-nocache', label: 'New Year’s Eve rush, no cache', desc: `Same ${RUSH} searches, each sent to both shards. The shards queue, searches miss the budget, and pages come back incomplete.`, sw: { cache: false }, run: (s) => { rush(s); s.schedule(300, () => startSearch(s)); } },
      { id: 'offset-paging', label: 'Offset paging after a re-rank', desc: 'Same as the first scenario, but page 2 re-runs the search and skips four. Pine loft moved up, so it is never shown, and Heavenly condo appears twice.', sw: { cursor: false }, run: (s) => { startSearch(s); s.schedule(700, () => rerank(s)); s.schedule(1500, () => startSearch(s, 1)); } },
      { id: 'boundary', label: 'Map crosses a shard boundary', desc: 'Maya searches the north shore (one shard), then zooms out to the whole lake. The second search goes to both shards.', run: (s) => { s.ui.maya.view = 'north'; startSearch(s); s.schedule(800, () => { s.ui.maya.view = 'lake'; startSearch(s); }); } },
    ]),
    initialState: () => {
      const db = {};
      const shards = { shardA: {}, shardB: {} };
      const scores = {};
      for (const [id, name, area, shard, price, score, taken] of LISTINGS) {
        const nights = DAYS.map((_, d) => (taken.includes(d) ? 'booked' : ''));
        db[id] = { id, name, area, shard, price, nights, ver: 1 };
        shards[shard][id] = SDL.clone(db[id]);
        scores[id] = score;
      }
      return {
        config: { recheck: true, versions: true, partial: true, cursor: true, cache: true },
        db, shards, scores, rankVer: 1,
        cache: {}, inflight: {}, cursors: {}, changes: [], holding: false, lagSnap: null,
        flood: null, lat: [],
        stats: { shardQueries: { shardA: 0, shardB: 0 }, hits: 0, misses: 0, coalesced: 0, dropped: 0, removed: 0 },
        seq: { ev: 0, cur: 0 },
      };
    },
    initialUI: () => ({
      maya: { view: 'lake', page: 0, results: [], shown: {}, cursor: null, view0: null, partial: null, fallback: false, error: '', loading: false, took: null, total: 0, hasMore: false, removed: [], shards: [], from: '' },
      lena: { message: '' },
    }),
    actions: {
      search(sim) { startSearch(sim, 0); },
      next(sim) { startSearch(sim, 1); },
      change(sim, a) { change(sim, a.kind); },
      rerank(sim) { rerank(sim); },
      rush(sim) { rush(sim); },
      set: Y.setAction,
    },
    handlers: {
      api: { search: function* (ctx, p) { return ctx.must(yield ctx.call('search', 'search', p, { timeout: 1500 })); } },
      search: {
        search: function* (ctx, p) {
          const st = ctx.state;
          const cfg = st.config;
          let r;
          const snap = p.page && cfg.cursor && p.cursor && st.cursors[p.cursor];
          if (snap) r = { list: snap.list, partial: snap.partial, fallback: snap.fallback, shards: snap.shards, from: 'cursor' };
          else r = yield* ranked(ctx, p.view);
          const start = p.page * PAGE;
          let cand = r.list.slice(start, start + PAGE + 2);
          const removed = [];
          if (cfg.recheck && cand.length) {
            const ck = yield ctx.call('listings', 'check', { ids: cand.map((h) => h.id) }, { timeout: 400, quiet: p.rush ? 'all' : false });
            if (ck.ok) {
              for (const h of cand) if (!ck.value.free[h.id]) removed.push(h.id);
              cand = cand.filter((h) => ck.value.free[h.id]);
              st.stats.removed += p.rush ? 0 : removed.length;
            }
          }
          const items = cand.slice(0, PAGE).map((h) => SDL.clone(h));
          let cursor = null;
          if (!p.page && cfg.cursor && !p.rush) {
            cursor = `c${++st.seq.cur}`;
            st.cursors[cursor] = { list: r.list, partial: r.partial, fallback: r.fallback, shards: r.shards };
          }
          return { items, partial: r.partial, fallback: r.fallback, shards: r.shards, total: r.list.length, hasMore: r.list.length > start + PAGE, removed, cursor, from: r.from };
        },
      },
      cache: {
        get(ctx, p) {
          const st = ctx.state;
          const e = st.cache[p.key];
          if (e && (ctx.now() - e.at < CACHE_TTL || ctx.mode('stale'))) return { hit: e };
          if (st.inflight[p.key]) return { wait: true };
          st.inflight[p.key] = true;
          return { miss: true };
        },
        put(ctx, p) { ctx.state.cache[p.key] = Object.assign({ at: ctx.now() }, p.entry); return { ok: true }; },
      },
      ranker: { rank(ctx, p) { const sc = ctx.state.scores; return { ids: p.ids.slice().sort((a, b) => sc[b] - sc[a]) }; } },
      shardA: shardHandler('shardA'),
      shardB: shardHandler('shardB'),
      listings: {
        update(ctx, p) {
          const st = ctx.state;
          const row = st.db[p.id];
          if (p.kind === 'book') {
            if (!freeFor(row.nights)) ctx.fail('NIGHTS_TAKEN', 'Those nights are taken.');
            for (const d of STAY) row.nights[d] = 'booked';
          } else if (p.kind === 'block') {
            if (row.nights[2]) ctx.fail('NIGHTS_TAKEN', 'Dec 31 is not free.');
            row.nights[2] = 'blocked';
          } else if (row.nights[2] === 'blocked') row.nights[2] = '';
          row.ver++;
          st.changes.push({ id: p.id, ver: row.ver, t: ctx.now(), actionId: ctx.actionId, indexedAt: null });
          const ev = { eventId: `l-${++st.seq.ev}`, type: 'listing.changed', payload: { id: p.id, ver: row.ver, nights: row.nights.slice(), shard: row.shard }, actionId: ctx.actionId };
          if (ctx.mode('reorder', 'cdc') && !st.holding) {
            st.holding = true;
            ctx.log({ op: `${ev.eventId} (v${row.ver}) delayed in the change stream`, status: 'fault', actionId: ctx.actionId, detail: 'The capture connector will deliver this change after the one that follows it.' });
            ctx.spawn(function* (c) { yield c.wait(700); c.sim.enqueue('changes', ev); c.state.holding = false; }, { self: 'cdc', quiet: true });
          } else ctx.sim.enqueue('changes', ev);
          return { ver: row.ver };
        },
        check(ctx, p) {
          const db = dbView(ctx.state, ctx.mode('lag'));
          const free = {};
          for (const id of p.ids) free[id] = freeFor(db[id].nights);
          return { free };
        },
      },
    },
    setup(sim) {
      // The indexer applies each change to the shard that owns the listing.
      sim.spawn(function* (ctx) {
        for (;;) {
          if (ctx.mode('paused') || !ctx.sim.queueStats('changes').depth) { yield ctx.wait(20); continue; }
          const { msgs } = yield ctx.take('changes', 'indexer', 10);
          let ok = true;
          for (const m of msgs) {
            if (!ok) break;
            const p = m.payload;
            const r = yield ctx.call(p.shard, 'apply', p, { timeout: 800, actionId: m.actionId });
            if (!r.ok) { ok = false; break; }
            const st = ctx.state;
            if (r.value.dropped) { st.stats.dropped++; ctx.log({ op: `${m.eventId} skipped (v${p.ver} older than v${r.value.have})`, status: 'dup', actionId: m.actionId, detail: 'The shard already holds a newer version of this listing; the late change is ignored.' }); }
            else ctx.log({ op: `indexed ${p.id} v${p.ver}`, status: 'ok', actionId: m.actionId, detail: `${SHARD_NAME[p.shard]} now has Dec 30, Dec 31, Jan 1 as ${STAY.map((d) => p.nights[d] || 'free').join(', ')}.` });
            const ch = st.changes.find((c) => c.ver === p.ver);
            if (ch && !ch.indexedAt) { ch.indexedAt = ctx.now(); ctx.sim.setLedger(ch.actionId, 'async', r.value.dropped ? 'no' : 'yes', r.value.dropped ? 'Ignored: a newer version was already indexed.' : `Searchable ${((ctx.now() - ch.t) / 1000).toFixed(1)} s after the change.`); }
          }
          if (ok) ctx.ack('changes', 'indexer'); else { ctx.nack('changes', 'indexer'); yield ctx.wait(300); }
        }
      }, { self: 'indexer', quiet: 'all' });
      // A lagging replica: the re-check sees the database as it was when the lag began.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(50);
          const st = ctx.state;
          if (ctx.sim.nodes.listings.modes.lag) { if (!st.lagSnap) st.lagSnap = SDL.clone(st.db); } else st.lagSnap = null;
        }
      }, { self: 'listings', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.maya;
      const pending = sim.queueStats('changes').depth + (st.holding ? 1 : 0);
      for (const row of Object.values(st.db)) {
        const doc = st.shards[row.shard][row.id];
        if (doc.ver === row.ver || freeFor(doc.nights) === freeFor(row.nights)) continue;
        if (!pending && !st.changes.some((c) => c.ver === row.ver && !c.indexedAt)) {
          return { key: 'wrong', label: `${row.name} is ${freeFor(row.nights) ? 'free' : 'booked'} for New Year in the listing database, but the index says ${freeFor(doc.nights) ? 'free' : 'unavailable'} (v${doc.ver}, database v${row.ver}). An older change overwrote a newer one, and nothing will fix it: ${freeFor(row.nights) ? 'the cabin is hidden from every New Year search' : 'guests keep finding it'}.` };
        }
      }
      const f = st.flood;
      if (f && f.done === RUSH) {
        const q = st.stats.shardQueries.shardA + st.stats.shardQueries.shardB;
        const lat = f.lat.slice().sort((a, b) => a - b);
        const p99 = SDL.percentile(lat, 99);
        if (f.partial || f.failed || f.slow) return { key: 'stale', label: `${RUSH} identical searches sent ${q} queries to the shards, which queued them. ${[f.failed && `${f.failed} failed because no shard answered within ${SHARD_BUDGET} ms`, f.partial && `${f.partial} came back incomplete`, f.slow && `${f.slow} took over 0.5 s`].filter(Boolean).join(', ')} (p99 ${SDL.fmtMs(p99)}). The shards did the same work ${q / 2} times.` };
        return { key: 'ok', label: `${RUSH} identical searches, ${q} shard quer${q === 1 ? 'y' : 'ies'}: ${st.stats.coalesced} waited for that one fetch, and the rest found it already cached (p99 ${SDL.fmtMs(p99)}).` };
      }
      if (u.error) return { key: 'stale', label: 'Maya got an error, though the north shore shard was up: the search waited for every shard.' };
      const gone = u.results.filter((h) => !freeFor(st.db[h.id].nights));
      if (gone.length) return { key: 'stale', label: `Maya’s results show ${gone.map((h) => h.name).join(', ')}, but those nights are booked. Tapping it ends in “no longer available”. The index has since caught up; a new search would be right.` };
      const lagging = st.changes.filter((c) => !c.indexedAt);
      if (lagging.length && !st.lagSnap) return { key: 'stale', label: `A change to the cabin has not reached the index for ${((sim.now - lagging[0].t) / 1000).toFixed(1)} s. Searches answer from the old night bitmap.` };
      if (u.shown[0] && u.shown[1] && u.view0 === 'lake') {
        const seen = [].concat(u.shown[0], u.shown[1]);
        const dup = u.shown[1].filter((id) => u.shown[0].includes(id));
        const all = Object.values(st.db).filter((r) => inView('lake', r.id) && freeFor(r.nights)).map((r) => r.id);
        const missed = all.filter((id) => !seen.includes(id));
        if (dup.length || missed.length) return { key: 'stale', label: `Pages 1 and 2 overlap and leave a gap: ${dup.map((id) => NAME[id]).join(', ') || 'nothing'} shown twice, ${missed.map((id) => NAME[id]).join(', ') || 'nothing'} never shown. Page 2 was recomputed against a ranking that had changed.` };
      }
      if (u.partial) return { key: 'stale', label: `Maya’s results are incomplete: ${u.partial} did not answer. The page says so.` };
      if (u.fallback) return { key: 'stale', label: 'Every listing shown is free, but in price order: the ranker was unavailable, so the best matches may be on page 2.' };
      if (!u.results.length && !u.loading) return { key: 'ok', label: 'Search Lake Tahoe to start.' };
      return { key: 'ok', label: `The index matches the listing database, and every stay on Maya’s screen is free for Dec 30 – Jan 2${u.shown[1] ? '. Pages 1 and 2 show all eight, once each' : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const u = sim.ui.maya;
      const lat = st.lat.slice().sort((a, b) => a - b);
      const lagging = st.changes.filter((c) => !c.indexedAt);
      const gone = u.results.filter((h) => !freeFor(st.db[h.id].nights)).length;
      const q = st.stats.hits + st.stats.misses;
      return [
        { label: 'Search p99', value: lat.length ? SDL.fmtMs(SDL.percentile(lat, 99)) : '–', tone: lat.length && SDL.percentile(lat, 99) > 500 ? 'warn' : '' },
        { label: 'Index lag', value: lagging.length ? `${((sim.now - lagging[0].t) / 1000).toFixed(1)} s` : '0 s', tone: lagging.length ? 'warn' : '' },
        { label: 'Coverage', value: u.shards.length ? (u.partial ? '50%' : '100%') : '–', tone: u.partial ? 'warn' : '' },
        { label: 'Cache hit rate', value: q ? `${Math.round((st.stats.hits / q) * 100)}%` : '–' },
        { label: 'Shard queries', value: st.stats.shardQueries.shardA + st.stats.shardQueries.shardB },
        { label: 'Unbookable stays shown', value: gone, tone: gone ? 'fail' : 'ok' },
        { label: 'Removed by re-check', value: st.stats.removed },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Maya searches by map area and dates. Lena’s console compares what the listing database and the index say about the Lakeside cabin.',
          side: `<p class="ops-title">Lena’s console · Lakeside cabin</p><div class="ops-traffic">
              ${Y.btn('change', 'Block Dec 31', { arg: { kind: 'block' } })}
              ${Y.btn('change', 'Unblock Dec 31', { arg: { kind: 'unblock' }, cls: 'secondary' })}
              ${Y.btn('change', 'Dev books Dec 30 – Jan 2', { arg: { kind: 'book' }, cls: 'secondary' })}
              ${Y.btn('rerank', 'Ranking refresh', { cls: 'secondary' })}
              ${Y.btn('rush', `New Year’s Eve rush: ${RUSH} searches`, { cls: 'secondary' })}
            </div><div data-ref="index"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.maya;
        const area = `<div class="app-row"><label for="bnb-view">Map</label><select id="bnb-view" data-field="maya.view">${Object.entries(VIEWS).map(([k, v]) => `<option value="${k}"${k === u.view ? ' selected' : ''}>${v.label}</option>`).join('')}</select></div>
          <p class="app-sub">Dec 30 – Jan 2 · 3 nights · 2 guests · map covers ${VIEWS[u.view].shards.map((s) => SHARD_NAME[s]).join(' and ')}</p>
          ${Y.btn('search', u.loading ? 'Searching…' : 'Search', { cls: 'go', disabled: u.loading })}`;
        const notes = `${u.partial ? Y.msg(`Some stays may be missing (${u.partial} unavailable).`, 'warn') : ''}${u.fallback ? Y.msg('Sorted by price: best-match ranking is unavailable.', 'warn') : ''}${u.error ? Y.msg(u.error, 'fail') : ''}`;
        const cards = u.results.map((h) => {
          const taken = !freeFor(st.db[h.id].nights);
          return `<div class="ops-row" data-tone="${taken ? 'fail' : ''}"><div class="ops-name">${esc(h.name)}<span>${esc(h.area)} · ${usd(h.price)} a night${taken ? ' · no longer available' : ''}</span></div></div>`;
        }).join('');
        const pages = Math.max(1, Math.ceil(u.total / PAGE));
        const pager = u.results.length ? `<p class="app-sub">Page ${u.page + 1} of ${pages}${u.from === 'cursor' ? ' · from the saved snapshot' : u.from === 'cache' ? ' · from the cache' : ''}</p>${u.page === 0 && u.hasMore ? Y.btn('next', 'Next page', { cls: 'secondary', disabled: u.loading }) : ''}` : '';
        Y.paint(el, sim, 'maya', {
          head: '<div><p class="app-title">Lake Tahoe</p><p class="app-sub">Stays for New Year</p></div>',
          area, notes,
          results: `<div class="ops-shards">${cards}</div>${u.shown[0] && !u.results.length && !u.error && !u.loading ? '<p class="app-sub">No stays.</p>' : ''}`,
          pager,
        }, {});
        const row = st.db.cabin;
        const doc = st.shards.shardA.cabin;
        const nights = (n) => STAY.map((d) => `${DAYS[d]} ${n[d] || 'free'}`).join(', ');
        const same = row.ver === doc.ver || freeFor(row.nights) === freeFor(doc.nights);
        const c = sim.scenario.consistency(sim);
        const f = st.flood;
        SDL.ui.paintSections(el.querySelector('[data-ref="index"]'), {
          rows: `<div class="ops-shards">
            <div class="ops-row"><div class="ops-name">Listing database · v${row.ver}<span>${esc(nights(row.nights))}</span></div></div>
            <div class="ops-row" data-tone="${same ? '' : 'warn'}"><div class="ops-name">Index, ${SHARD_NAME.shardA} · v${doc.ver}${same ? ' ✓' : ' ✕'}<span>${esc(nights(doc.nights))}</span></div></div>
          </div>`,
          queue: `<p class="app-sub">Waiting to be indexed: <span data-live="depth"></span> · shard queries: <span data-live="q"></span>${f ? ` · rush: ${f.done} of ${RUSH} done` : ''}</p>${Y.msg(sim.ui.lena.message, '')}`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, { depth: String(sim.queueStats('changes').depth), q: String(st.stats.shardQueries.shardA + st.stats.shardQueries.shardB) });
      },
    },
  };

  function shardHandler(id) {
    return {
      query(ctx, p) { return { hits: Object.values(ctx.state.shards[id]).filter((d) => p.nights.every((n) => !d.nights[n])).map((d) => ({ id: d.id, name: d.name, area: d.area, price: d.price })) }; },
      apply(ctx, p) {
        const doc = ctx.state.shards[id][p.id];
        if (ctx.state.config.versions && p.ver <= doc.ver) return { dropped: true, have: doc.ver };
        doc.nights = p.nights.slice();
        doc.ver = p.ver;
        return { dropped: false };
      },
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
