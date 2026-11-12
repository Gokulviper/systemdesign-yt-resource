/*
 * Product search and indexing.
 * The catalogue is the source of truth; every change is captured from its
 * log (change data capture) and applied to a sharded search index by an
 * indexer. Queries scatter to every shard, gather hits, and ask a ranking
 * service to order them. Filters (in stock, Prime, price) are answered from
 * the index, so they are only as fresh as the index. The seller console
 * changes prices and stock; a bulk feed can flood the indexer.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const SHARDS = ['shardA', 'shardB', 'shardC'];
  const RANK_BUDGET = 250;
  const SHARD_BUDGET = 400;
  const FLOOD = 3000; // bulk catalogue updates in one feed

  // id, title, search term, price, in stock, Prime, popularity (what the ranker likes)
  const PRODUCTS = [
    ['echo', 'Echo Dot (5th gen) smart speaker', 'speaker', 49.99, true, true, 95],
    ['echo-pop', 'Echo Pop compact speaker', 'speaker', 39.99, true, true, 80],
    ['sonos', 'Sonos Roam portable speaker', 'speaker', 179.0, true, false, 70],
    ['jbl', 'JBL Flip 6 Bluetooth speaker', 'speaker', 99.95, false, true, 88],
    ['anker', 'Anker Soundcore mini speaker', 'speaker', 24.99, true, false, 60],
    ['kindle', 'Kindle Paperwhite', 'kindle', 149.99, true, true, 90],
    ['kindle-kids', 'Kindle Kids', 'kindle', 119.99, true, true, 50],
    ['wh1000', 'Sony WH-1000XM5 headphones', 'headphones', 349.99, true, true, 92],
    ['airpods', 'Apple AirPods Pro', 'headphones', 249.0, false, true, 97],
  ];
  const shardOf = (id) => SHARDS[[...id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 3];
  const money = Y.money;

  function matches(doc, p) {
    if (doc.term !== p.term) return false;
    if (p.inStock && !doc.stock) return false;
    if (p.prime && !doc.prime) return false;
    if (p.under && doc.price > p.under) return false;
    return true;
  }

  function startSearch(sim) {
    const u = sim.ui.shopper;
    const q = { term: u.term, inStock: u.inStock, prime: u.prime, under: u.under ? 100 : 0 };
    const filters = [u.inStock && 'in stock', u.prime && 'Prime', u.under && 'under $100'].filter(Boolean);
    sim.startAction(`Shopper: search “${q.term}”${filters.length ? ` (${filters.join(', ')})` : ''}`, function* (ctx) {
      const st = ctx.state;
      Object.assign(u, { loading: true, error: '', partial: null, fallback: false });
      Y.L(ctx, { displayed: 'pending', committed: ['n/a', 'Searching writes nothing.'], async: 'n/a', retrySafe: 'yes' });
      const r = yield ctx.call('gateway', 'search', q, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.loading = false;
      if (r.ok) {
        const v = r.value;
        Object.assign(u, { results: v.hits, partial: v.partial, fallback: v.fallback, took: r.latency, searchedAt: ctx.now(), query: q });
        const stale = v.hits.filter((h) => h.price !== st.catalog[h.id].price || h.stock !== st.catalog[h.id].stock);
        Y.L(ctx, { displayed: ['yes', `${v.hits.length} results${v.partial ? ', marked incomplete' : ''}${v.fallback ? ', text order' : ''}.`], accepted: 'yes' });
        let why = `The query went to all three index shards in parallel; ${v.fallback ? 'the ranking service did not answer within its budget, so the hits were ordered by text match instead' : 'the ranking service ordered the merged hits by relevance and popularity'}.`;
        if (v.partial) why += ` ${v.partial} did not answer within ${SHARD_BUDGET} ms, so the page shows what the other shards had and says so.`;
        if (stale.length) why += ` ${stale.length} result${stale.length > 1 ? 's show' : ' shows'} ${st.config.live ? 'index values that the live catalogue read then corrected' : 'what the index holds, not what the catalogue says'}: the index has not received the latest change.`;
        if (v.liveFixed) why += ` Price and stock on the result cards were re-read from the catalogue at display time, so the cards are right even where the index is behind (the filter that selected them still used the old values).`;
        ctx.explain(why);
      } else {
        Object.assign(u, { results: [], error: r.error.code === 'SHARD_FAILED' ? 'Search is unavailable right now. Please try again.' : r.error.code === 'RANK_FAILED' ? 'Search is unavailable right now (ranking failed).' : `Search failed: ${r.error.message}` });
        Y.failed(ctx, 'Shows an error instead of results.');
        ctx.explain(r.error.code === 'SHARD_FAILED'
          ? 'One shard of three did not answer and partial results are off, so the whole search failed. A third of the catalogue being unreachable turned into no results at all.'
          : r.error.code === 'RANK_FAILED'
            ? 'The ranking service is down and there is no fallback, so a page full of matching products was thrown away because nobody could order it.'
            : `The search failed: ${r.error.message}`);
      }
    }, { self: 'shopper' });
  }

  function startChange(sim, change) {
    const label = change.price != null ? `Seller: change ${PRODUCTS.find((p) => p[0] === change.id)[1].split(' ')[0]} ${PRODUCTS.find((p) => p[0] === change.id)[1].split(' ')[1]} to ${money(change.price)}` : `Seller: mark ${PRODUCTS.find((p) => p[0] === change.id)[1].split(' ').slice(0, 2).join(' ')} ${change.stock ? 'in stock' : 'out of stock'}`;
    sim.startAction(label, function* (ctx) {
      const st = ctx.state;
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call('catalog', 'update', change, { timeout: 1200 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) {
        st.changes.push({ id: change.id, ver: r.value.ver, t: ctx.now(), actionId: ctx.actionId, indexedAt: null });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Row version ${r.value.ver} in the catalogue.`], async: ['pending', 'Waiting to reach the search index.'] });
        ctx.explain(`The catalogue committed version ${r.value.ver}. Change data capture reads the commit from the database log and appends it to the change stream; the indexer applies it to the shard that owns this product. Until then, search shows the old values.`);
      } else Y.failed(ctx);
    }, { self: 'seller' });
  }

  function startFlood(sim) {
    const st = sim.state;
    if (st.flood) return;
    st.flood = { left: FLOOD, t: sim.now };
    sim.note(`Bulk catalogue feed: ${Y.num(FLOOD)} product updates arrive in two seconds.`);
  }

  const sc = (SDL.scenarios['shop-search'] = {
    id: 'shop-search',
    seed: 433,
    productWidth: 620,
    intro: 'Search for speakers, then tick “In stock” and “Under $100”. Change a price or mark a product out of stock from the seller console and search again: the result changes only once the index has caught up. Then reorder events, lose a shard, or flood the indexer.',
    topology: {
      width: 1160, height: 620,
      nodes: [
        { id: 'shopper', label: 'Shopper', sub: 'Search box', kind: 'client', x: 90, y: 90, latency: 1, role: 'Searches with filters and sorting.', owns: ['Nothing'] },
        { id: 'seller', label: 'Seller console', sub: 'Changes products', kind: 'client', x: 90, y: 470, latency: 1, role: 'Changes prices and stock in the catalogue.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Store API', kind: 'gateway', x: 300, y: 90, latency: 2, role: 'Routes searches.', ops: [{ name: 'search', desc: 'Search with filters.' }], owns: ['Nothing durable'] },
        { id: 'query', label: 'Query service', sub: 'Scatter-gather', kind: 'service', x: 520, y: 90, latency: 4, role: 'Sends the query to every shard, merges hits, asks the ranker to order them, and optionally re-reads price and stock from the catalogue.', ops: [{ name: 'search', desc: 'Scatter, gather, rank.' }], owns: ['Merge and timeout rules'] },
        { id: 'ranker', label: 'Ranking service', sub: 'Orders hits', kind: 'service', x: 520, y: 260, latency: 40, serviceMs: 30, role: 'Scores each hit by relevance, popularity, and price. Has a strict time budget.', ops: [{ name: 'rank', desc: 'Order a list of hits.' }], owns: ['Model weights'] },
        { id: 'shardA', label: 'Index shard A', sub: 'A third of products', kind: 'db', x: 800, y: 40, latency: 15, role: 'An inverted index over a third of the catalogue, with price and stock fields for filtering.', ops: [{ name: 'query', desc: 'Matching documents.' }, { name: 'apply', desc: 'Index a change.' }], owns: ['index part A'] },
        { id: 'shardB', label: 'Index shard B', sub: 'A third of products', kind: 'db', x: 800, y: 150, latency: 15, role: 'An inverted index over a third of the catalogue.', ops: [{ name: 'query', desc: 'Matching documents.' }, { name: 'apply', desc: 'Index a change.' }], owns: ['index part B'] },
        { id: 'shardC', label: 'Index shard C', sub: 'A third of products', kind: 'db', x: 800, y: 260, latency: 15, role: 'An inverted index over a third of the catalogue.', ops: [{ name: 'query', desc: 'Matching documents.' }, { name: 'apply', desc: 'Index a change.' }], owns: ['index part C'] },
        { id: 'catalog', label: 'Catalogue DB', sub: 'Source of truth', kind: 'db', x: 300, y: 470, latency: 8, role: 'Products, prices, and stock. Every committed change appears in its log.', ops: [{ name: 'update', desc: 'Change a product.' }, { name: 'read', desc: 'Read live price and stock.' }], owns: ['products'] },
        { id: 'cdc', label: 'Change stream', sub: 'Change data capture', kind: 'queue', x: 520, y: 470, latency: 3, queue: 'changes', role: 'Every committed catalogue change, in commit order, waiting to be indexed. Bulk feeds can take a separate lane.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['change log'] },
        { id: 'indexer', label: 'Indexer', sub: 'Applies changes', kind: 'worker', x: 800, y: 470, latency: 4, serviceMs: 5, role: 'Reads changes and applies each to the shard that owns the product, about 200 a second.', ops: [{ name: 'consume', desc: 'Index a change.' }], owns: ['Nothing durable'] },
        { id: 'bulk', label: 'Bulk feed', sub: 'Nightly catalogue sync', kind: 'service', x: 90, y: 300, latency: 1, role: 'Thousands of routine updates from suppliers.', owns: ['Nothing'] },
      ],
      edges: [
        { from: 'shopper', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'query', latency: 4 },
        { from: 'query', to: 'ranker', latency: 4 },
        { from: 'query', to: 'shardA', latency: 4 },
        { from: 'query', to: 'shardB', latency: 4 },
        { from: 'query', to: 'shardC', latency: 4 },
        { from: 'query', to: 'catalog', latency: 6, label: 'live price', via: [[420, 90], [420, 400], [300, 400]] },
        { from: 'seller', to: 'catalog', latency: 30 },
        { from: 'bulk', to: 'catalog', latency: 10 },
        { from: 'catalog', to: 'cdc', latency: 4, label: 'log' },
        { from: 'cdc', to: 'indexer', latency: 3 },
        { from: 'indexer', to: 'shardC', latency: 4, via: [[950, 470], [950, 260]] },
      ],
      queues: [{ id: 'changes', broker: 'cdc', label: 'changes', groups: ['indexer'] }, { id: 'bulkq', broker: 'cdc', label: 'bulk lane', groups: ['indexer'] }],
    },
    modeLabels: { reorder: 'Delivering out of order' },
    failures: [
      { id: 'b-down', node: 'shardB', mode: 'down', label: 'Index shard B down', desc: 'A third of the catalogue is unsearchable.' },
      { id: 'b-slow', node: 'shardB', mode: 'slow', params: { factor: 40 }, label: 'Index shard B slow', desc: 'One shard misses the time budget on every query.' },
      { id: 'indexer-paused', node: 'indexer', mode: 'paused', label: 'Indexer paused', desc: 'Catalogue changes stop reaching the index.' },
      { id: 'reorder', node: 'cdc', mode: 'reorder', label: 'Change stream delivers out of order', desc: 'As after a rebalance across partitions: an older change arrives after a newer one.' },
      { id: 'rank-down', node: 'ranker', mode: 'down', label: 'Ranking service down', desc: 'Nobody can order the hits.' },
      { id: 'rank-slow', node: 'ranker', mode: 'slow', params: { factor: 20 }, label: 'Ranking service slow', desc: 'Ranking blows its budget on every query.' },
      { id: 'catalog-down', node: 'catalog', mode: 'down', label: 'Catalogue DB down', desc: 'Sellers cannot change anything; live price reads fail and fall back to the index.' },
    ],
    switches: Y.switches([
      ['partial', 'Return partial results', `If a shard fails or misses ${SHARD_BUDGET} ms, return the rest marked incomplete. Off: fail the search.`],
      ['fallback', 'Fall back to text order', `If ranking fails or misses ${RANK_BUDGET} ms, order hits by text match. Off: fail the search.`],
      ['versioned', 'Versioned index writes', 'Apply a change only if its version is newer than what the shard holds. Off: whatever arrives last wins.'],
      ['live', 'Live price and stock on result cards', 'Re-read price and stock from the catalogue for the hits before showing them. Off: show index values.'],
      ['priority', 'Priority lane for seller changes', 'Bulk feeds take a separate lane that the indexer drains only when no seller change is waiting.'],
    ]),
    presets: Y.presets({ partial: true, fallback: true, versioned: true, live: false, priority: true }, [
      { id: 'search', label: 'Search for speakers', desc: 'Five hits from three shards, ordered by the ranking service.', run: (s) => startSearch(s) },
      { id: 'filter', label: 'In stock and under $100', desc: 'Filters are answered from fields stored in the index. Three speakers qualify.', run: (s) => { Object.assign(s.ui.shopper, { inStock: true, under: true }); startSearch(s); } },
      { id: 'price', label: 'Seller changes a price', desc: 'The change is captured from the catalogue log and indexed within a few hundred milliseconds. The next search shows $44.99.', run: (s) => { startChange(s, { id: 'echo', price: 44.99 }); s.schedule(900, () => startSearch(s)); } },
      { id: 'lag', label: 'Indexer paused, out-of-stock item still shown', desc: 'The seller marks the Echo Dot out of stock. With the indexer paused, “In stock” still lists it, and the card says so too.', run: (s) => { s.inject('indexer', 'paused', true, 5000); startChange(s, { id: 'echo', stock: false }); s.schedule(1200, () => { s.ui.shopper.inStock = true; startSearch(s); }); } },
      { id: 'lag-live', label: 'Same lag, live price and stock on cards', desc: 'The index still selects the Echo Dot, but the card re-reads the catalogue and shows “Out of stock”. Honest, if not perfectly filtered.', sw: { live: true }, run: (s) => { s.inject('indexer', 'paused', true, 5000); startChange(s, { id: 'echo', stock: false }); s.schedule(1200, () => { s.ui.shopper.inStock = true; startSearch(s); }); } },
      { id: 'reorder', label: 'Two changes, delivered out of order, versioned', desc: 'The price goes to $39.99 then $44.99; the index receives them reversed. The version check drops the older one.', run: (s) => { s.inject('cdc', 'reorder'); startChange(s, { id: 'echo', price: 39.99 }); s.schedule(150, () => startChange(s, { id: 'echo', price: 44.99 })); s.schedule(2500, () => startSearch(s)); } },
      { id: 'reorder-bad', label: 'Same, last write wins', desc: 'The older change arrives last and is applied. Search says $39.99 for ever; the catalogue says $44.99.', sw: { versioned: false }, run: (s) => { s.inject('cdc', 'reorder'); startChange(s, { id: 'echo', price: 39.99 }); s.schedule(150, () => startChange(s, { id: 'echo', price: 44.99 })); s.schedule(2500, () => startSearch(s)); } },
      { id: 'shard-down', label: 'Shard down, partial results', desc: 'Two shards answer. The page shows their hits and says results may be incomplete.', run: (s) => { s.inject('shardB', 'down'); startSearch(s); } },
      { id: 'shard-down-bad', label: 'Shard down, all or nothing', desc: 'One shard of three is down, so the search fails outright.', sw: { partial: false }, run: (s) => { s.inject('shardB', 'down'); startSearch(s); } },
      { id: 'shard-slow', label: 'Slow shard, partial results', desc: 'The slow shard misses its budget; results arrive on time without it.', run: (s) => { s.inject('shardB', 'slow', { factor: 40 }); startSearch(s); } },
      { id: 'rank-down', label: 'Ranking down, text order', desc: 'The ranker is down. Hits are shown in text-match order: a worse page than usual, but a page.', run: (s) => { s.inject('ranker', 'down'); startSearch(s); } },
      { id: 'rank-down-bad', label: 'Ranking down, no fallback', desc: 'Every shard answered and the search still fails, because nobody could order the hits.', sw: { fallback: false }, run: (s) => { s.inject('ranker', 'down'); startSearch(s); } },
      { id: 'flood', label: 'Bulk feed, priority lane', desc: 'Three thousand routine updates arrive. The seller’s price change takes the priority lane and is indexed in under a second.', run: (s) => { startFlood(s); s.schedule(600, () => startChange(s, { id: 'echo', price: 44.99 })); s.schedule(2200, () => startSearch(s)); } },
      { id: 'flood-bad', label: 'Bulk feed, one queue', desc: 'The seller’s change waits behind thousands of routine updates. Search shows the old price for seconds.', sw: { priority: false }, run: (s) => { startFlood(s); s.schedule(600, () => startChange(s, { id: 'echo', price: 44.99 })); s.schedule(2200, () => startSearch(s)); } },
    ]),
    initialState: () => {
      const catalog = {};
      const shards = { shardA: {}, shardB: {}, shardC: {} };
      for (const [id, title, term, price, stock, prime, pop] of PRODUCTS) {
        catalog[id] = { id, title, term, price, stock, prime, pop, ver: 1 };
        shards[shardOf(id)][id] = Object.assign({}, catalog[id]);
      }
      return {
        config: { partial: true, fallback: true, versioned: true, live: false, priority: true },
        catalog, shards, changes: [], flood: null, holding: false,
        stats: { indexed: 0, bulkIndexed: 0, dropped: 0, reordered: 0 },
        seq: { ev: 0 },
      };
    },
    initialUI: () => ({ shopper: { term: 'speaker', inStock: false, prime: false, under: false, results: [], query: null, partial: null, fallback: false, took: null, searchedAt: 0, loading: false, error: '' } }),
    actions: {
      search(sim) { startSearch(sim); },
      change(sim, a) { startChange(sim, a); },
      flood(sim) { startFlood(sim); },
      set: Y.setAction,
    },
    handlers: {
      gateway: { search: function* (ctx, p) { return ctx.must(yield ctx.call('query', 'search', p, { timeout: 1400 })); } },
      query: {
        search: function* (ctx, p) {
          const st = ctx.state;
          const res = {};
          SHARDS.forEach((sh) => ctx.spawn(function* (c) { res[sh] = yield c.call(sh, 'query', p, { timeout: 1200 }); }));
          const t0 = ctx.now();
          const budget = st.config.partial ? SHARD_BUDGET : 1250;
          while (Object.keys(res).length < 3 && ctx.now() - t0 < budget) yield ctx.wait(10);
          const ok = SHARDS.filter((s) => res[s] && res[s].ok);
          const bad = SHARDS.filter((s) => !ok.includes(s)).map((b) => ctx.sim.nodes[b].label);
          if (bad.length && !st.config.partial) ctx.fail('SHARD_FAILED', `${bad.join(', ')} did not answer.`);
          let hits = ok.flatMap((s) => res[s].value.hits);
          let fallback = false;
          const rk = yield ctx.call('ranker', 'rank', { hits }, { timeout: RANK_BUDGET });
          if (rk.ok) hits = rk.value.hits;
          else if (st.config.fallback) { fallback = true; hits = hits.slice().sort((a, b) => a.title.localeCompare(b.title)); }
          else ctx.fail('RANK_FAILED', rk.error.message);
          let liveFixed = false;
          if (st.config.live && hits.length) {
            const live = yield ctx.call('catalog', 'read', { ids: hits.map((h) => h.id) }, { timeout: 400 });
            if (live.ok) { hits = hits.map((h) => Object.assign({}, h, live.value.rows[h.id], { indexed: { price: h.price, stock: h.stock } })); liveFixed = true; }
          }
          return { hits, partial: bad.length ? bad.join(', ') : null, fallback, liveFixed };
        },
      },
      ranker: { rank(ctx, p) { return { hits: p.hits.slice().sort((a, b) => b.pop - a.pop) }; } },
      shardA: shardHandler('shardA'), shardB: shardHandler('shardB'), shardC: shardHandler('shardC'),
      catalog: {
        update(ctx, p) {
          const st = ctx.state;
          const row = st.catalog[p.id];
          if (p.price != null) row.price = p.price;
          if (p.stock != null) row.stock = p.stock;
          row.ver++;
          const ev = { eventId: 'c-' + ++st.seq.ev, type: 'product.changed', payload: { id: p.id, ver: row.ver, price: row.price, stock: row.stock, bulk: !!p.bulk }, actionId: ctx.actionId };
          const lane = p.bulk && st.config.priority ? 'bulkq' : 'changes';
          if (!p.bulk && ctx.mode('reorder', 'cdc') && !st.holding) {
            // The capture connector republishes this partition late: the next change overtakes this one.
            st.holding = true;
            st.stats.reordered++;
            ctx.log({ op: `${ev.eventId} delayed in the change stream`, status: 'fault', actionId: ctx.actionId, detail: 'The connector will deliver this change after the one that follows it.' });
            ctx.spawn(function* (c) { yield c.wait(700); c.sim.enqueue(lane, ev); c.state.holding = false; }, { self: 'cdc', quiet: true });
          } else ctx.sim.enqueue(lane, ev);
          return { ver: row.ver };
        },
        read(ctx, p) { const rows = {}; for (const id of p.ids) rows[id] = { price: ctx.state.catalog[id].price, stock: ctx.state.catalog[id].stock }; return { rows }; },
      },
    },
    setup(sim) {
      // The indexer drains the change stream, then the bulk lane when nothing urgent waits.
      const apply = function* (ctx, msg, bulk) {
        const st = ctx.state;
        const p = msg.payload;
        if (bulk) { st.stats.bulkIndexed++; yield ctx.wait(5); return true; }
        const sh = shardOf(p.id);
        const r = yield ctx.call(sh, 'apply', p, { timeout: 800, actionId: msg.actionId });
        if (!r.ok) return false;
        st.stats.indexed++;
        if (r.value.dropped) { st.stats.dropped++; ctx.log({ op: `${msg.eventId} skipped (v${p.ver} older than v${r.value.have})`, status: 'dup', actionId: msg.actionId, detail: 'The shard already holds a newer version of this product; the stale change was ignored.' }); }
        else ctx.log({ op: `indexed ${p.id} v${p.ver}`, status: 'ok', actionId: msg.actionId, detail: `${ctx.sim.nodes[sh].label} now says ${money(p.price)}, ${p.stock ? 'in stock' : 'out of stock'}.` });
        const ch = st.changes.find((c) => c.id === p.id && c.ver === p.ver);
        if (ch && !ch.indexedAt) { ch.indexedAt = ctx.now(); ctx.sim.setLedger(ch.actionId, 'async', r.value.dropped ? 'no' : 'yes', r.value.dropped ? 'Dropped: a newer version was already indexed.' : `Searchable ${((ctx.now() - ch.t) / 1000).toFixed(1)} s after the change.`); }
        return true;
      };
      sim.spawn(function* (ctx) {
        for (;;) {
          if (ctx.mode('paused')) { yield ctx.wait(100); continue; }
          if (ctx.sim.queueStats('changes').depth) {
            const { msgs } = yield ctx.take('changes', 'indexer', 10);
            let ok = true;
            for (const m of msgs) if (ok) ok = yield* apply(ctx, m, m.payload.bulk);
            if (ok) ctx.ack('changes', 'indexer'); else { ctx.nack('changes', 'indexer'); yield ctx.wait(300); }
            continue;
          }
          if (ctx.sim.queueStats('bulkq').depth) {
            const { msgs } = yield ctx.take('bulkq', 'indexer', 10);
            for (const m of msgs) yield* apply(ctx, m, true);
            ctx.ack('bulkq', 'indexer');
            continue;
          }
          yield ctx.wait(20);
        }
      }, { self: 'indexer', quiet: 'all' });
      // Bulk feed: FLOOD routine updates over two seconds.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(50);
          const st = ctx.state;
          if (!st.flood || !st.flood.left) continue;
          const n = Math.min(st.flood.left, Math.round(FLOOD / 40));
          st.flood.left -= n;
          for (let i = 0; i < n; i++) ctx.sim.enqueue(st.config.priority ? 'bulkq' : 'changes', { eventId: 'b-' + ++st.seq.ev, type: 'product.changed', payload: { id: 'sku-' + st.seq.ev, ver: 1, bulk: true } });
          if (!st.flood.left) ctx.log({ op: `${Y.num(FLOOD)} bulk updates appended`, status: 'note', detail: `All in the ${st.config.priority ? 'bulk lane' : 'single change stream'}.` });
        }
      }, { self: 'bulk', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.shopper;
      const pending = sim.queueStats('changes').depth + sim.queueStats('bulkq').depth + (st.flood && st.flood.left ? 1 : 0);
      for (const [id, row] of Object.entries(st.catalog)) {
        const doc = st.shards[shardOf(id)][id];
        if (!doc) continue;
        if (doc.ver !== row.ver && (doc.price !== row.price || doc.stock !== row.stock)) {
          const waiting = st.changes.some((c) => c.id === id && c.ver === row.ver && !c.indexedAt);
          if (!waiting) return { key: 'wrong', label: `The index holds ${money(doc.price)} for “${doc.title}”, the catalogue ${money(row.price)}, and no change is on its way. An older update overwrote a newer one: this will never heal by itself.` };
        }
      }
      if (u.error) return { key: 'stale', label: u.error.includes('ranking') ? 'The shopper got an error although every shard answered: ranking failed and there was no fallback.' : 'The shopper got an error because one shard of three was unavailable.' };
      const lagging = st.changes.filter((c) => !c.indexedAt);
      if (lagging.length) return { key: 'stale', label: `${lagging.length} seller change${lagging.length > 1 ? 's have' : ' has'} not reached the index (${((sim.now - lagging[0].t) / 1000).toFixed(1)} s and counting)${pending > 1 ? `; ${Y.num(pending)} updates are queued ahead` : ''}.` };
      const shownStale = u.results.filter((h) => h.price !== st.catalog[h.id].price || h.stock !== st.catalog[h.id].stock);
      if (shownStale.length) return { key: 'stale', label: `The results on the shopper’s screen show old values for ${shownStale.map((h) => h.title.split(' ').slice(0, 2).join(' ')).join(', ')}. A new search would be right.` };
      if (u.partial) return { key: 'stale', label: `Results are incomplete: ${u.partial} did not answer. The page says so.` };
      if (u.fallback) return { key: 'ok', label: 'Results are complete and match the catalogue; they are in text order because ranking was unavailable.' };
      return { key: 'ok', label: 'The index matches the catalogue and the results are complete.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const u = sim.ui.shopper;
      const last = st.changes[st.changes.length - 1];
      return [
        { label: 'Search time', value: u.took == null ? 'n/a' : SDL.fmtMs(u.took), tone: u.error ? 'fail' : u.took > 600 ? 'warn' : 'ok' },
        { label: 'Change to searchable', value: last ? (last.indexedAt ? `${((last.indexedAt - last.t) / 1000).toFixed(1)} s` : 'not yet') : 'n/a', tone: last && !last.indexedAt ? 'warn' : '' },
        { label: 'Waiting to be indexed', value: Y.num(sim.queueStats('changes').depth + sim.queueStats('bulkq').depth) },
        { label: 'Changes indexed', value: Y.num(st.stats.indexed + st.stats.bulkIndexed) },
        { label: 'Stale changes dropped', value: st.stats.dropped },
        { label: 'Results shown', value: u.results.length },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['shopper', 'Shopper']], {
          note: 'Search from the phone. The seller console changes the catalogue and compares what the catalogue and the index say about each product.',
          side: `<p class="ops-title">Seller console</p><div class="ops-traffic">
              ${Y.btn('change', 'Echo Dot: price $44.99', { arg: { id: 'echo', price: 44.99 } })}
              ${Y.btn('change', 'Echo Dot: price $49.99', { arg: { id: 'echo', price: 49.99 }, cls: 'secondary' })}
              ${Y.btn('change', 'Echo Dot: out of stock', { arg: { id: 'echo', stock: false }, cls: 'secondary' })}
              ${Y.btn('change', 'Echo Dot: back in stock', { arg: { id: 'echo', stock: true }, cls: 'secondary' })}
              ${Y.btn('flood', 'Bulk feed: 3,000 updates')}
            </div><div data-ref="index"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.shopper;
        const chip = (field, label, on) => `<label class="app-toggle"><input type="checkbox" data-field="shopper.${field}"${on ? ' checked' : ''}> ${label}</label>`;
        const search = `<div class="app-row"><label for="sq">Search</label><select id="sq" data-field="shopper.term">${[['speaker', 'speakers'], ['kindle', 'kindle'], ['headphones', 'headphones']].map(([k, v]) => `<option value="${k}"${k === u.term ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="app-row">${chip('inStock', 'In stock', u.inStock)}${chip('prime', 'Prime', u.prime)}${chip('under', 'Under $100', u.under)}</div>
          ${Y.btn('search', u.loading ? 'Searching…' : 'Search', { disabled: u.loading })}`;
        const notes = `${u.partial ? Y.msg(`Some results may be missing (${u.partial} unavailable).`, 'warn') : ''}${u.fallback ? Y.msg('Showing results in text order: ranking is unavailable.', 'warn') : ''}${u.error ? Y.msg(u.error, 'fail') : ''}`;
        const results = `<div class="yt-feed">${u.results.map((h) => {
          const live = st.catalog[h.id];
          const stale = h.price !== live.price || h.stock !== live.stock;
          return `<div class="yt-card"><div class="yt-thumb" style="--h:${(h.pop * 7) % 360}"><span aria-hidden="true">◉</span></div>
            <div><strong>${esc(h.title)}</strong><p class="app-price">${money(h.price)}${stale ? ' <span class="yt-tag">stale</span>' : ''}</p>
            <p class="app-sub">${h.stock ? '✓ In stock' : '✕ Out of stock'}${h.prime ? ' · Prime' : ''}${h.indexed && (h.indexed.price !== h.price || h.indexed.stock !== h.stock) ? ` · index said ${money(h.indexed.price)}, ${h.indexed.stock ? 'in stock' : 'out of stock'}` : ''}</p></div></div>`;
        }).join('')}${u.query && !u.results.length && !u.error && !u.loading ? '<p class="app-sub">No results.</p>' : ''}</div>`;
        Y.paint(el, sim, 'shopper', { head: '<div><p class="app-title">Amazon</p><p class="app-sub">Search</p></div>', search, notes, results }, {});
        const c = sim.scenario.consistency(sim);
        const rows = PRODUCTS.filter(([id]) => id === 'echo' || st.changes.some((ch) => ch.id === id)).map(([id]) => {
          const live = st.catalog[id];
          const doc = st.shards[shardOf(id)][id];
          const same = doc.price === live.price && doc.stock === live.stock;
          return `<div class="ops-row" data-tone="${same ? '' : 'warn'}"><div class="ops-name">${esc(live.title)}<span>catalogue ${money(live.price)}, ${live.stock ? 'in stock' : 'out of stock'}, v${live.ver} · index ${money(doc.price)}, ${doc.stock ? 'in stock' : 'out of stock'}, v${doc.ver}${same ? ' ✓' : ' ✕'}</span></div></div>`;
        }).join('');
        const depth = sim.queueStats('changes').depth + sim.queueStats('bulkq').depth;
        SDL.ui.paintSections(el.querySelector('[data-ref="index"]'), {
          title: '<p class="ops-title">Catalogue versus index</p>',
          rows: `<div class="ops-shards">${rows}</div>`,
          queue: `<p class="app-sub">Waiting to be indexed: <span data-live="depth"></span>${st.config.priority ? ' (seller changes first)' : ''}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, { depth: Y.num(depth) });
      },
    },
  });
  function shardHandler(id) {
    return {
      query(ctx, p) { return { hits: Object.values(ctx.state.shards[id]).filter((d) => matches(d, p)).map((d) => Object.assign({}, d)) }; },
      apply(ctx, p) {
        const docs = ctx.state.shards[id];
        const have = docs[p.id];
        if (have && ctx.state.config.versioned && p.ver <= have.ver) return { dropped: true, have: have.ver };
        if (have) Object.assign(have, { price: p.price, stock: p.stock, ver: p.ver });
        return { dropped: false };
      },
    };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
