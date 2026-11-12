/*
 * Product pages and caching.
 * A product page is served cache-aside: look in the page cache, on a miss
 * read the catalogue replica and fill the cache. The seller changes the
 * price in the catalogue primary; an invalidation event deletes the cached
 * page and replication carries the new row to the replica. Everything that
 * can go wrong in that triangle is here: lost invalidations, a replica that
 * lags behind the invalidation, a lightning deal that stampedes the replica,
 * and the reason checkout never trusts the price the page showed.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const TTL = 3000;
  const CROWD = 600; // page views per second during a lightning deal
  const PRODUCT = { id: 'echo', title: 'Echo Dot (5th gen) smart speaker' };

  const money = Y.money;

  /** Replicate the primary row to the replica a little later; longer while the replica lags. */
  function replicate(ctx) {
    const row = Object.assign({}, ctx.state.db.primary);
    ctx.spawn(function* (c) {
      yield c.wait(150);
      while (c.mode('lag', 'replica')) yield c.wait(200);
      yield c.call('replica', 'apply', row, { timeout: 1000, quiet: true });
    }, { self: 'primary', quiet: true });
  }

  function startView(sim, opts) {
    opts = opts || {};
    sim.startAction(opts.label || 'Shopper: open the product page', function* (ctx) {
      const u = ctx.ui.shopper;
      Object.assign(u, { loading: true, error: '' });
      Y.L(ctx, { displayed: 'pending', committed: ['n/a', 'Reading writes nothing.'], async: 'n/a', retrySafe: 'yes' });
      const r = yield ctx.call('gateway', 'view', { id: PRODUCT.id }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.loading = false;
      if (r.ok) {
        const v = r.value;
        Object.assign(u, { shown: { price: v.price, stock: v.stock, ver: v.ver }, source: v.source, viewMs: r.latency, viewedAt: ctx.now() });
        const live = ctx.state.db.primary;
        const stale = v.price !== live.price || v.stock !== live.stock;
        Y.L(ctx, { displayed: ['yes', `Price ${money(v.price)}, ${v.stock ? 'in stock' : 'out of stock'} (${v.source}).`], accepted: 'yes' });
        ctx.explain(v.source === 'cache hit'
          ? `The page came straight from the cache in ${Math.round(r.latency)} ms. Nothing touched a database.${stale ? ` But the cached page says ${money(v.price)} and the catalogue says ${money(live.price)}: this cache entry is stale.` : ''}`
          : v.source === 'coalesced'
            ? 'The page was not cached and another shopper’s read for the same page was already on its way to the replica. This request waited for that one instead of adding a second database read.'
            : `The page was not cached, so the page service read the catalogue replica and stored the result in the cache${ctx.state.config.ttl ? ` for ${TTL / 1000} s` : ' with no expiry'}.${stale ? ` The replica had not received the seller’s latest change yet, so an old price was just written into the cache.` : ''}`);
      } else {
        Object.assign(u, { error: r.error.code === 'TIMEOUT' ? 'This page is taking too long. Try again.' : `Couldn’t load the page: ${r.error.message}` });
        Y.failed(ctx, 'Shows an error instead of the product.');
        const w = ctx.sim.queueWait('replica');
        ctx.explain(w > 0
          ? `The page missed the cache and queued behind ${Math.round(w)} ms of other reads at the replica, which serves about ${Math.round(1000 / ctx.sim.nodes.replica.serviceMs)} pages a second. The request timed out before its turn came.`
          : `The read failed: ${r.error.message}`);
      }
    }, { self: 'shopper' });
  }

  function startBuy(sim) {
    const u = sim.ui.shopper;
    if (!u.shown || u.loading) return;
    sim.startAction(`Shopper: buy now at ${money(u.shown.price)}`, function* (ctx) {
      const st = ctx.state;
      Object.assign(u, { buying: true, error: '', notice: '' });
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'The order carries an idempotency key.'] });
      const r = yield ctx.call('gateway', 'buy', { id: PRODUCT.id, shownPrice: u.shown.price }, { timeout: 2000 });
      ctx.recordOutcome(r.ok, r.latency);
      u.buying = false;
      if (r.ok) {
        const o = r.value;
        u.orders.push(o);
        const live = st.db.primary.price;
        Object.assign(u, { notice: `Order placed at ${money(o.price)}.` });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Order ${o.id} at ${money(o.price)}.`], async: 'n/a' });
        ctx.explain(o.price === live
          ? (st.config.reprice ? 'Checkout read the price from the catalogue primary, not from the page. It matched what the shopper saw, so the order went through at that price.' : 'Checkout trusted the price shown on the page. It happened to match the catalogue, so this order is fine, but nothing checked.')
          : `Checkout charged ${money(o.price)}, the price the page showed. The seller’s price is ${money(live)}. The page was served from a stale cache and checkout never re-read the catalogue: the shop just sold below the seller’s price.`);
      } else if (r.error.code === 'PRICE_CHANGED') {
        const nv = r.error.detail;
        Object.assign(u, { shown: { price: nv.price, stock: nv.stock, ver: nv.ver }, source: 'primary (re-priced)', notice: `The price changed to ${money(nv.price)} since you opened this page. Review and buy again.` });
        Y.L(ctx, { displayed: ['yes', 'Shows the new price and asks for confirmation.'], accepted: 'no', committed: 'no', async: 'n/a' });
        ctx.explain(`Checkout re-read the catalogue primary and found ${money(nv.price)}, not the ${money(r.error.detail.shown)} on the page. It refused to place the order, sent the current price back so the shopper decides with the right number, and wrote the fresh row into the cache so the next shopper is not misled. The stale page cost a click, not money.`);
      } else {
        Object.assign(u, { error: `Couldn’t place the order: ${r.error.message}` });
        Y.failed(ctx, 'No order.');
      }
    }, { self: 'shopper' });
  }

  function startPrice(sim, price) {
    sim.startAction(`Seller: change the price to ${money(price)}`, function* (ctx) {
      const st = ctx.state;
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call('catalog', 'setPrice', { id: PRODUCT.id, price }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) {
        st.lastChange = { t: ctx.now(), price, actionId: ctx.actionId };
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Row version ${r.value.ver} in the catalogue primary.`], async: ['pending', 'Waiting for the cache to drop the old page and the replica to receive the row.'] });
        ctx.explain(st.config.invalidate
          ? `The catalogue primary now says ${money(price)}. Two things happen next, independently: replication copies the row to the replica, and an invalidation event tells the cache to forget the old page. The next shopper misses the cache and reads the replica. If the invalidation arrives before replication, that read fetches the old price.`
          : `The catalogue primary now says ${money(price)}. No invalidation is sent: the cached page keeps the old price until ${st.config.ttl ? `its ${TTL / 1000} s TTL expires` : 'someone deletes it, and nothing will'}.`);
      } else Y.failed(ctx);
    }, { self: 'seller' });
  }

  function setDeal(sim, on) {
    sim.state.deal = on;
    sim.note(on ? `Lightning deal: about ${CROWD} shoppers a second open this product page.` : 'The lightning deal is over.');
  }

  const sc = (SDL.scenarios['shop-catalog'] = {
    id: 'shop-catalog',
    seed: 421,
    productWidth: 600,
    intro: 'Open the product page twice: a cache miss, then a hit. Change the price from the seller console and open it again. Then lose the invalidation, lag the replica, or start a lightning deal and watch the replica queue.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'shopper', label: 'Shopper', sub: 'Phone', kind: 'client', x: 90, y: 90, latency: 1, role: 'Opens the product page and buys.', owns: ['What the shopper sees'] },
        { id: 'crowd', label: 'Other shoppers', sub: 'Deal traffic', kind: 'client', x: 90, y: 260, latency: 1, role: 'Everyone else opening the same page: hundreds a second during a lightning deal.', owns: ['Nothing'] },
        { id: 'seller', label: 'Seller console', sub: 'Changes prices', kind: 'client', x: 90, y: 480, latency: 1, role: 'The seller edits price and stock.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Store API', kind: 'gateway', x: 300, y: 175, latency: 2, role: 'Routes page views to the page service and purchases to checkout.', ops: [{ name: 'view', desc: 'Product page.' }, { name: 'buy', desc: 'Place an order.' }], owns: ['Nothing durable'] },
        { id: 'pages', label: 'Product page service', sub: 'Cache-aside', kind: 'service', x: 520, y: 90, latency: 3, role: 'Looks in the cache first; on a miss reads the replica and fills the cache.', ops: [{ name: 'get', desc: 'Build or fetch a page.' }], owns: ['In-flight misses (for coalescing)'] },
        { id: 'cache', label: 'Page cache', sub: 'In memory', kind: 'cache', x: 760, y: 40, latency: 2, role: 'Rendered product pages keyed by product. A hit never touches a database.', ops: [{ name: 'get', desc: 'Look up a page.' }, { name: 'set', desc: 'Store a page.' }, { name: 'del', desc: 'Drop a page.' }], owns: ['pages[product]'] },
        { id: 'replica', label: 'Catalogue replica', sub: 'Read copy', kind: 'db', x: 760, y: 190, latency: 6, serviceMs: 25, role: 'An asynchronous copy of the catalogue for page reads. About 40 reads a second.', ops: [{ name: 'read', desc: 'Read a product row.' }, { name: 'apply', desc: 'Apply a replicated row.' }], owns: ['products (copy)'] },
        { id: 'checkout', label: 'Checkout service', sub: 'Places orders', kind: 'service', x: 520, y: 300, latency: 4, role: 'Places orders. Can re-read the price from the primary instead of trusting the page.', ops: [{ name: 'buy', desc: 'Price and place an order.' }], owns: ['orders'] },
        { id: 'catalog', label: 'Catalogue service', sub: 'Seller writes', kind: 'service', x: 300, y: 480, latency: 3, role: 'Writes seller changes to the primary and publishes an invalidation event.', ops: [{ name: 'setPrice', desc: 'Change a price.' }], owns: ['Write rules'] },
        { id: 'primary', label: 'Catalogue primary', sub: 'Source of truth', kind: 'db', x: 760, y: 340, latency: 8, role: 'The catalogue. Every write lands here first; the replica follows.', ops: [{ name: 'write', desc: 'Update a row.' }, { name: 'read', desc: 'Read the live row.' }], owns: ['products'] },
        { id: 'invq', label: 'Invalidation events', sub: 'Cache changes', kind: 'queue', x: 520, y: 480, latency: 3, queue: 'inv', role: 'Carries “product X changed” to the cache invalidator.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['invalidation log'] },
        { id: 'invalidator', label: 'Cache invalidator', sub: 'Deletes pages', kind: 'worker', x: 980, y: 480, latency: 3, role: 'Deletes the cached page for each changed product; optionally again a moment later.', ops: [{ name: 'consume', desc: 'Drop a cached page.' }], owns: ['Nothing durable'] },
      ],
      edges: [
        { from: 'shopper', to: 'gateway', latency: 30 },
        { from: 'crowd', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'pages', latency: 4 },
        { from: 'gateway', to: 'checkout', latency: 4 },
        { from: 'pages', to: 'cache', latency: 3 },
        { from: 'pages', to: 'replica', latency: 4, label: 'miss' },
        { from: 'checkout', to: 'primary', latency: 5, label: 'live price' },
        { from: 'checkout', to: 'cache', latency: 3, label: 'repair' },
        { from: 'seller', to: 'catalog', latency: 30 },
        { from: 'catalog', to: 'primary', latency: 5, via: [[300, 400], [640, 400]] },
        { from: 'primary', to: 'replica', latency: 20, label: 'replication' },
        { from: 'catalog', to: 'invq', latency: 4 },
        { from: 'invq', to: 'invalidator', latency: 4 },
        { from: 'invalidator', to: 'cache', latency: 4, label: 'delete', via: [[1080, 480], [1080, 40]] },
      ],
      queues: [{ id: 'inv', broker: 'invq', label: 'invalidations', groups: ['invalidator'] }],
    },
    modeLabels: { lag: 'Replication lagging', lose: 'Losing events' },
    failures: [
      { id: 'inv-lost', node: 'invq', mode: 'lose', label: 'Invalidation lost', desc: 'The event is acknowledged but never delivered: the cached page is never dropped.' },
      { id: 'replica-lag', node: 'replica', mode: 'lag', label: 'Replica lagging', desc: 'The replica receives writes late; a miss right after a change reads the old row.' },
      { id: 'cache-down', node: 'cache', mode: 'down', label: 'Page cache down', desc: 'Every page view reads the replica.' },
      { id: 'invalidator-paused', node: 'invalidator', mode: 'paused', label: 'Invalidator paused', desc: 'Invalidations queue up; cached pages stay as they are.' },
      { id: 'replica-slow', node: 'replica', mode: 'slow', params: { factor: 8 }, label: 'Replica slow', desc: 'Each read takes eight times longer: misses pile up.' },
      { id: 'primary-down', node: 'primary', mode: 'down', label: 'Catalogue primary down', desc: 'Sellers cannot change anything; checkout cannot re-price.' },
    ],
    switches: Y.switches([
      ['invalidate', 'Invalidate the cache on write', 'Publish an event that deletes the cached page when the catalogue changes. Off: rely on the TTL alone.'],
      ['ttl', `Cache entries expire (${TTL / 1000} s TTL)`, 'A cached page is dropped after a few seconds even if nothing invalidates it. Off: pages stay cached until deleted.',
        (s, on) => { for (const e of Object.values(s.state.cache)) e.exp = on ? s.now + TTL : 0; }],
      ['redelete', 'Delete again after replication', 'Delete the cached page a second time, 600 ms later, in case a miss refilled it from a lagging replica.'],
      ['coalesce', 'Coalesce concurrent misses', 'Many simultaneous misses for one page share a single replica read. Off: every miss reads the replica.'],
      ['reprice', 'Re-read the price at checkout', 'Checkout reads the catalogue primary and refuses if it differs from the page. Off: charge what the page showed.'],
    ]),
    presets: Y.presets({ invalidate: true, ttl: true, redelete: false, coalesce: true, reprice: true }, [
      { id: 'view', label: 'Open the page twice', desc: 'First a cache miss that reads the replica and fills the cache, then a hit that touches no database.', run: (s) => { startView(s); s.schedule(900, () => startView(s)); } },
      { id: 'price', label: 'Seller changes the price', desc: 'The write lands in the primary, an invalidation drops the cached page, replication updates the replica. The next view shows $64.99.', run: (s) => { startView(s); s.schedule(800, () => startPrice(s, 64.99)); s.schedule(1800, () => startView(s)); } },
      { id: 'ttl-only', label: 'No invalidation, TTL only', desc: 'The cached page keeps the old price until its TTL runs out: cheap and simple, but stale for up to 3 s.', sw: { invalidate: false }, run: (s) => { startView(s); s.schedule(800, () => startPrice(s, 64.99)); s.schedule(1500, () => startView(s)); } },
      { id: 'lost', label: 'Invalidation lost, TTL as a safety net', desc: 'The event never arrives. The old page lingers until the TTL expires, then the next view reads the new price.', run: (s) => { s.inject('invq', 'lose'); startView(s); s.schedule(800, () => startPrice(s, 64.99)); s.schedule(1500, () => startView(s)); s.schedule(4500, () => startView(s)); } },
      { id: 'lost-forever', label: 'Invalidation lost, no TTL', desc: 'Nothing ever drops the page. Every shopper sees $49.99 for an item the seller priced at $64.99, indefinitely.', sw: { ttl: false }, run: (s) => { s.inject('invq', 'lose'); startView(s); s.schedule(800, () => startPrice(s, 64.99)); s.schedule(1500, () => startView(s)); s.schedule(4500, () => startView(s)); } },
      { id: 'buy-stale', label: 'Buy from a stale page, no re-pricing', desc: 'Checkout trusts the page. The order is placed at $49.99 for an item priced at $64.99.', sw: { ttl: false, reprice: false }, run: (s) => { s.inject('invq', 'lose'); startView(s); s.schedule(800, () => startPrice(s, 64.99)); s.schedule(1500, () => startView(s)); s.schedule(2500, () => startBuy(s)); } },
      { id: 'buy-reprice', label: 'Buy from a stale page, re-priced', desc: 'Checkout reads the primary, sees $64.99, and sends the shopper back to confirm. The second tap orders at the right price.', sw: { ttl: false }, run: (s) => { s.inject('invq', 'lose'); startView(s); s.schedule(800, () => startPrice(s, 64.99)); s.schedule(1500, () => startView(s)); s.schedule(2500, () => startBuy(s)); s.schedule(3600, () => startBuy(s)); } },
      { id: 'lag', label: 'Replica lags behind the invalidation', desc: 'The cache is dropped, a shopper misses, and the replica still has the old row: the old price is written back into the cache.', run: (s) => { s.inject('replica', 'lag', true, 2000); startView(s); s.schedule(800, () => startPrice(s, 64.99)); s.schedule(1200, () => startView(s)); s.schedule(2800, () => startView(s)); } },
      { id: 'lag-redelete', label: 'Same lag, delete again later', desc: 'A second delete 600 ms after the first clears the refilled page once replication has caught up.', sw: { redelete: true }, run: (s) => { s.inject('replica', 'lag', true, 2000); startView(s); s.schedule(800, () => startPrice(s, 64.99)); s.schedule(1200, () => startView(s)); s.schedule(2800, () => startView(s)); } },
      { id: 'deal', label: 'Lightning deal, coalesced misses', desc: 'Hundreds of views a second. Each time the page expires, one replica read refills it and everyone else waits for that one.', run: (s) => { setDeal(s, true); startPrice(s, 39.99); s.schedule(1500, () => startView(s)); s.schedule(4000, () => startView(s)); s.schedule(6500, () => setDeal(s, false)); } },
      { id: 'deal-stampede', label: 'Lightning deal, no coalescing', desc: 'Every concurrent miss reads the replica: a stampede each time the page expires. Views time out, and replication queues behind the reads, so the cache is refilled with the old price.', sw: { coalesce: false }, run: (s) => { setDeal(s, true); startPrice(s, 39.99); s.schedule(1500, () => startView(s)); s.schedule(4000, () => startView(s)); s.schedule(6500, () => setDeal(s, false)); } },
      { id: 'cache-down', label: 'Cache down during a deal', desc: 'With no cache, every view is a replica read. Forty a second cannot serve six hundred: the page stops loading.', run: (s) => { s.inject('cache', 'down'); setDeal(s, true); s.schedule(1500, () => startView(s)); s.schedule(6500, () => setDeal(s, false)); } },
    ]),
    initialState: () => ({
      config: { invalidate: true, ttl: true, redelete: false, coalesce: true, reprice: true },
      db: { primary: { price: 49.99, stock: true, ver: 1 }, replica: { price: 49.99, stock: true, ver: 1 } },
      cache: {}, inflight: {},
      orders: [], deal: false, lastChange: null,
      stats: { hits: 0, misses: 0, coalesced: 0, replicaReads: 0, deletes: 0, crowdTimeouts: 0, crowdViews: 0 },
      seq: { order: 0, ev: 0 },
    }),
    initialUI: () => ({ shopper: { shown: null, source: '', viewMs: null, viewedAt: 0, loading: false, buying: false, error: '', notice: '', orders: [] } }),
    actions: {
      view(sim) { startView(sim); },
      buy(sim) { startBuy(sim); },
      price(sim, a) { startPrice(sim, a.price); },
      deal(sim, a) { setDeal(sim, !!a.on); },
      set: Y.setAction,
    },
    handlers: {
      gateway: {
        view: function* (ctx, p) { return ctx.must(yield ctx.call('pages', 'get', p, { timeout: 1400 })); },
        buy: function* (ctx, p) { return ctx.must(yield ctx.call('checkout', 'buy', p, { timeout: 1800 })); },
      },
      pages: {
        get: function* (ctx, p) {
          const st = ctx.state;
          const c = yield ctx.call('cache', 'get', { id: p.id }, { timeout: 300 });
          if (c.ok && c.value.page) { st.stats.hits++; return Object.assign({ source: 'cache hit' }, c.value.page); }
          st.stats.misses++;
          if (st.config.coalesce && st.inflight[p.id]) {
            const t0 = ctx.now();
            while (st.inflight[p.id] && ctx.now() - t0 < 1300) yield ctx.wait(10);
            const again = yield ctx.call('cache', 'get', { id: p.id }, { timeout: 300, quiet: true });
            if (again.ok && again.value.page) { st.stats.coalesced++; return Object.assign({ source: 'coalesced' }, again.value.page); }
          }
          st.inflight[p.id] = true;
          const r = yield ctx.call('replica', 'read', { id: p.id }, { timeout: 1300 });
          delete st.inflight[p.id];
          const row = ctx.must(r);
          yield ctx.call('cache', 'set', { id: p.id, page: row }, { timeout: 300 });
          return Object.assign({ source: 'replica read' }, row);
        },
      },
      cache: {
        get(ctx, p) {
          const e = ctx.state.cache[p.id];
          if (e && e.exp && e.exp <= ctx.now()) { delete ctx.state.cache[p.id]; return { page: null }; }
          return { page: e ? e.page : null };
        },
        set(ctx, p) { ctx.state.cache[p.id] = { page: p.page, exp: ctx.state.config.ttl ? ctx.now() + TTL : 0 }; return { stored: true }; },
        del(ctx, p) { const had = !!ctx.state.cache[p.id]; delete ctx.state.cache[p.id]; if (had) ctx.state.stats.deletes++; return { deleted: had }; },
      },
      replica: {
        read(ctx, p) { ctx.state.stats.replicaReads++; return Object.assign({ id: p.id }, ctx.state.db.replica); },
        apply(ctx, row) { if (row.ver >= ctx.state.db.replica.ver) ctx.state.db.replica = row; return { applied: true }; },
      },
      checkout: {
        buy: function* (ctx, p) {
          const st = ctx.state;
          let price = p.shownPrice;
          if (st.config.reprice) {
            const live = ctx.must(yield ctx.call('primary', 'read', { id: p.id }, { timeout: 1000 }));
            if (live.price !== p.shownPrice) {
              // Repair the cache while we are here: the page that misled the shopper must not mislead the next one.
              yield ctx.call('cache', 'set', { id: p.id, page: live }, { timeout: 300 });
              ctx.fail('PRICE_CHANGED', `The price is now ${money(live.price)}.`, Object.assign({ shown: p.shownPrice }, live));
            }
            price = live.price;
          }
          const id = 'O' + ++st.seq.order;
          const order = { id, price, livePrice: st.db.primary.price, t: ctx.now() };
          st.orders.push(order);
          return order;
        },
      },
      catalog: {
        setPrice: function* (ctx, p) {
          const st = ctx.state;
          const w = ctx.must(yield ctx.call('primary', 'write', p, { timeout: 1200 }));
          if (st.config.invalidate) yield ctx.call('invq', 'publish', { id: p.id, ver: w.ver }, { timeout: 600 });
          return w;
        },
      },
      primary: {
        write(ctx, p) {
          const st = ctx.state;
          st.db.primary = Object.assign({}, st.db.primary, { price: p.price, ver: st.db.primary.ver + 1 });
          replicate(ctx);
          return { ver: st.db.primary.ver };
        },
        read(ctx) { return Object.assign({}, ctx.state.db.primary); },
      },
      invq: {
        publish(ctx, p) {
          if (ctx.mode('lose')) { ctx.log({ op: 'event lost', status: 'fault', detail: 'The broker acknowledged the invalidation but it was never written to the log.' }); return { appended: true }; }
          ctx.sim.enqueue('inv', { type: 'product.changed', eventId: 'inv-' + ++ctx.state.seq.ev, payload: p, actionId: ctx.actionId });
          return { appended: true };
        },
      },
    },
    setup(sim) {
      Y.consumer(sim, 'inv', 'invalidator', 'invalidator', function* (ctx, msg) {
        const st = ctx.state;
        const r = yield ctx.call('cache', 'del', { id: msg.payload.id }, { timeout: 500, actionId: msg.actionId });
        if (!r.ok) return false;
        ctx.log({ op: `dropped page ${msg.payload.id}`, status: 'ok', actionId: msg.actionId, detail: r.value.deleted ? 'The cached page is gone; the next view reads the replica.' : 'Nothing was cached for this product.' });
        if (st.config.redelete) {
          ctx.spawn(function* (c) {
            yield c.wait(600);
            const again = yield c.call('cache', 'del', { id: msg.payload.id }, { timeout: 500, actionId: msg.actionId });
            if (again.ok) c.log({ op: `dropped page ${msg.payload.id} again`, status: again.value.deleted ? 'ok' : 'note', actionId: msg.actionId, detail: again.value.deleted ? 'A miss had refilled the cache from the lagging replica. The second delete cleared it.' : 'Nothing had refilled the cache; the second delete was a no-op.' });
          }, { self: 'invalidator' });
        }
        return true;
      }, () => true);
      // Background shoppers: only during a lightning deal, so the other stories stay exact.
      Y.load(sim, 'crowd', (s) => (s.state.deal ? CROWD : 0), function* (ctx) {
        const st = ctx.state;
        st.stats.crowdViews++;
        const r = yield ctx.call('gateway', 'view', { id: PRODUCT.id }, { timeout: 1500, quiet: 'all' });
        if (!r.ok) st.stats.crowdTimeouts++;
      });
      // Mark the seller’s change as fully propagated once cache and replica both agree with the primary.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const st = ctx.state;
          const ch = st.lastChange;
          if (!ch || ch.done) continue;
          const e = st.cache[PRODUCT.id];
          const cacheOk = !e || e.page.ver === st.db.primary.ver;
          if (cacheOk && st.db.replica.ver === st.db.primary.ver) {
            ch.done = true;
            ctx.sim.setLedger(ch.actionId, 'async', 'yes', `Cache and replica agree with the primary ${((ctx.now() - ch.t) / 1000).toFixed(1)} s after the write.`);
          }
        }
      }, { self: 'catalog', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.shopper;
      const live = st.db.primary;
      const bad = st.orders.find((o) => o.price !== o.livePrice);
      if (bad) return { key: 'wrong', label: `Order ${bad.id} was placed at ${money(bad.price)} while the seller’s price was ${money(bad.livePrice)}. The shop sold at a price that no longer existed.` };
      const e = st.cache[PRODUCT.id];
      const cacheStale = e && (!e.exp || e.exp > sim.now) && e.page.price !== live.price;
      if (cacheStale) return { key: 'stale', label: `The cached page says ${money(e.page.price)}; the catalogue says ${money(live.price)}.${e.exp ? ` It expires in ${((e.exp - sim.now) / 1000).toFixed(1)} s.` : ' It has no expiry, so it will stay wrong until something deletes it.'}` };
      if (u.error) return { key: 'stale', label: 'The shopper’s page did not load: the replica could not keep up with cache misses.' };
      if (u.shown && u.shown.price !== live.price) return { key: 'stale', label: `The shopper’s screen shows ${money(u.shown.price)}; the catalogue says ${money(live.price)}. Checkout will catch it${st.config.reprice ? '' : ' only if re-pricing is on'}.` };
      if (st.db.replica.ver !== live.ver) return { key: 'stale', label: 'The replica has not received the latest catalogue row yet. A cache miss right now would cache the old price.' };
      if (sim.queueStats('inv').depth) return { key: 'stale', label: 'An invalidation is still waiting to be applied.' };
      return { key: 'ok', label: 'Page, cache, replica, and catalogue all agree, and every order was placed at the seller’s price.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const u = sim.ui.shopper;
      const w = sim.queueWait('replica');
      const total = st.stats.hits + st.stats.misses;
      return [
        { label: 'Page load', value: u.viewMs == null ? 'n/a' : SDL.fmtMs(u.viewMs), tone: u.error ? 'fail' : u.viewMs > 500 ? 'warn' : 'ok' },
        { label: 'Cache hit ratio', value: total ? `${Math.round((st.stats.hits / total) * 100)}%` : 'n/a' },
        { label: 'Replica reads', value: Y.num(st.stats.replicaReads) },
        { label: 'Misses coalesced', value: Y.num(st.stats.coalesced) },
        { label: 'Replica queue', value: SDL.fmtMs(w), tone: w > 500 ? 'fail' : w > 100 ? 'warn' : '' },
        { label: 'Views timed out', value: Y.num(st.stats.crowdTimeouts), tone: st.stats.crowdTimeouts ? 'fail' : '' },
        { label: 'Pages dropped', value: st.stats.deletes },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['shopper', 'Shopper']], {
          note: 'The phone shows the product page. The seller console changes the catalogue and shows what the cache, the replica, and the primary each believe.',
          side: `<p class="ops-title">Seller console</p><div class="ops-traffic">
              ${Y.btn('price', 'Raise the price to $64.99', { arg: { price: 64.99 } })}
              ${Y.btn('price', 'Deal price $39.99', { arg: { price: 39.99 }, cls: 'secondary' })}
              ${Y.btn('price', 'Back to $49.99', { arg: { price: 49.99 }, cls: 'secondary' })}
              ${Y.btn('deal', 'Start lightning deal', { arg: { on: true } })}
              ${Y.btn('deal', 'End the deal', { arg: { on: false }, cls: 'secondary' })}
            </div><div data-ref="truth"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.shopper;
        const s = u.shown;
        const live = st.db.primary;
        const product = `<div class="yt-card"><div class="yt-thumb" style="--h:200"><span aria-hidden="true">◉</span></div>
          <div><strong>${esc(PRODUCT.title)}</strong>
          ${u.loading ? '<p class="app-sub"><span class="spinner"></span>Loading…</p>' : s ? `<p class="app-price">${money(s.price)}${s.price !== live.price ? ' <span class="yt-tag">stale</span>' : ''}</p><p class="app-sub">${s.stock ? '✓ In stock' : '✕ Out of stock'} · ${esc(u.source)}</p>` : '<p class="app-sub">Tap “Open page”.</p>'}</div></div>`;
        const deal = st.deal ? '<div class="app-card is-hot"><strong>⚡ Lightning deal</strong><span class="app-sub"><span data-live="crowd"></span></span></div>' : '';
        const stage = `${Y.btn('view', s ? 'Reload page' : 'Open page', { cls: s ? 'secondary' : '' })}${s ? Y.btn('buy', u.buying ? 'Placing order…' : `Buy now ${money(s.price)}`, { cls: 'go', disabled: u.buying || u.loading }) : ''}`;
        const orders = u.orders.length ? `<p class="app-sub">Orders</p>${u.orders.slice(-3).reverse().map((o) => `<div class="app-card ${o.price === o.livePrice ? 'is-ok' : 'is-fail'}"><strong>${o.price === o.livePrice ? '✓' : '✕'} ${esc(o.id)} at ${money(o.price)}</strong>${o.price !== o.livePrice ? `<span class="app-sub">Seller’s price was ${money(o.livePrice)}</span>` : ''}</div>`).join('')}` : '';
        Y.paint(el, sim, 'shopper', {
          head: '<div><p class="app-title">Amazon</p><p class="app-sub">Deliver to Chennai</p></div>',
          deal, product, stage, msg: Y.msg(u.error || u.notice, u.error ? 'fail' : u.notice.startsWith('Order') ? 'ok' : 'warn'), orders,
        }, { crowd: `${CROWD} shoppers a second on this page` });
        const e = st.cache[PRODUCT.id];
        const c = sim.scenario.consistency(sim);
        const row = (name, v, tone) => `<div class="ops-row" data-tone="${tone || ''}"><div class="ops-name">${name}<span>${v}</span></div></div>`;
        const cacheTone = !e ? '' : e.page.price !== live.price ? 'fail' : '';
        SDL.ui.paintSections(el.querySelector('[data-ref="truth"]'), {
          title: '<p class="ops-title">What each copy says</p>',
          rows: `<div class="ops-shards">
            ${row('Catalogue primary', `${money(live.price)}, v${live.ver}`)}
            ${row('Catalogue replica', `${money(st.db.replica.price)}, v${st.db.replica.ver}`, st.db.replica.ver !== live.ver ? 'warn' : '')}
            ${row('Page cache', e ? `${money(e.page.price)}, v${e.page.ver}${e.exp ? `, expires in <span data-live="ttl"></span>` : ', no expiry'}` : 'empty (next view misses)', cacheTone)}
            ${row('Shopper’s screen', s ? `${money(s.price)}, v${s.ver}` : 'nothing yet', s && s.price !== live.price ? 'warn' : '')}
          </div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, { ttl: e && e.exp ? `${(Math.max(0, e.exp - sim.now) / 1000).toFixed(1)} s` : '' });
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
