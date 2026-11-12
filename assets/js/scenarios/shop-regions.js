/*
 * Multi-region and failover.
 * Two regions. Carts are active-active: each region writes its own copy and
 * replicates to the other asynchronously. Orders and stock have one home
 * region (A): region B forwards order writes across the inter-region link
 * and keeps a copy for failover. A failover controller in B promotes that
 * copy when A stops answering; a witness at a third site tells a real outage
 * from a cut link.
 *
 * Design switches:
 *  failover  the load balancer moves traffic and B's copy is promoted when A fails
 *  sync      an order is confirmed only once B's copy has it
 *  quorum    promote only if the witness also cannot reach A
 *  merge     carts reconcile item by item instead of last writer wins
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const SKU = { echo: 'Echo Dot', kindle: 'Kindle' };
  const PRICE = 49.99;
  const SHOPPER = { shopperA: { name: 'Priya', home: 'A', city: 'Mumbai' }, shopperB: { name: 'Wei', home: 'B', city: 'Singapore' } };
  const API = { A: 'apiA', B: 'apiB' };
  const CART = { A: 'cartA', B: 'cartB' };
  const REPL_MS = 300;
  const other = (r) => (r === 'A' ? 'B' : 'A');
  const down = (sim, id) => { const m = sim.nodes[id].modes; return !!(m.down || m.crashed); };
  const orderDb = (st, region) => (st.belief[region] === 'A' ? 'homedb' : 'standbyB');
  const regionOf = (id) => (['apiA', 'cartA', 'homedb'].includes(id) ? 'A' : 'B');
  const copy = (o) => JSON.parse(JSON.stringify(o));

  /** Call a node, crossing the inter-region link when it lives in the other region. */
  function* reach(ctx, from, to, op, payload, timeout) {
    if (from === regionOf(to)) return yield ctx.call(to, op, payload, { timeout });
    return yield ctx.call('wan', 'fwd', { to, op, payload, timeout: timeout - 80 }, { timeout });
  }

  function startAction(sim, who, kind, sku) {
    const u = sim.ui[who];
    if (u.busy) return;
    const me = SHOPPER[who];
    const label = kind === 'cart' ? `${me.name}: add ${SKU[sku]} to cart` : kind === 'buy' ? `${me.name}: buy now` : `${me.name}: your orders`;
    sim.startAction(label, function* (ctx) {
      const st = ctx.state;
      const v = ctx.ui[who];
      Object.assign(v, { busy: true, message: '', tone: '' });
      Y.L(ctx, { displayed: ['pending', 'Shows a spinner.'], retrySafe: kind === 'orders' ? ['yes', 'A read.'] : ['yes', 'Carries an idempotency key.'] });
      const t0 = ctx.now();
      const r = yield ctx.call('glb', 'route', { who, op: kind, payload: { who, user: me.name, sku } }, { timeout: 2500 });
      ctx.recordOutcome(r.ok, ctx.now() - t0);
      v.busy = false;
      const took = Math.round(ctx.now() - t0);
      if (!r.ok) {
        Y.failed(ctx, 'Shows an error.');
        const code = r.error.code;
        Object.assign(v, { message: code === 'SOLD_OUT' ? 'Sorry, sold out.' : code === 'HOME_UNREACHABLE' ? 'We can’t take orders right now. Your cart is saved.' : `Something went wrong (${code}).`, tone: 'fail' });
        if (code === 'HOME_UNREACHABLE') st.stats.refused++;
        ctx.explain(code === 'HOME_UNREACHABLE'
          ? `Orders and stock live in region A, and region B cannot reach it. The witness can still see A, so this is a cut link, not an outage, and B refuses to promote its copy. ${me.name} cannot order for now, but carts keep working in both regions. Consistency is chosen over availability for orders only.`
          : code === 'UNAVAILABLE' && !st.config.failover
            ? `Region ${v.region} is down and the load balancer keeps sending ${me.name} there. Region ${other(v.region)} is healthy and could have served this request.`
            : code === 'SOLD_OUT' ? 'The home region’s stock count says nothing is left.' : `Failed with ${code}: ${r.error.message}`);
        return;
      }
      const val = r.value;
      v.region = val.region;
      v.took = took;
      if (kind === 'cart') {
        st.cartIntent[me.name] = st.cartIntent[me.name] || {};
        st.cartIntent[me.name][sku] = (st.cartIntent[me.name][sku] || 0) + 1;
        v.cart = val.items;
        Object.assign(v, { message: 'Added to cart.', tone: 'ok' });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Written to region ${val.region}’s cart store.`], async: ['pending', `Replicates to region ${other(val.region)} in about ${REPL_MS} ms.`] });
        ctx.explain(`Carts are written in whichever region serves the shopper (${val.region} here, ${took} ms) and copied to the other region in the background. A cart never waits for the other side of the world.`);
      } else if (kind === 'buy') {
        st.confirmed.push({ id: val.order, who: me.name });
        v.lastOrder = val.order;
        Object.assign(v, { message: `Order ${val.order} placed.`, tone: 'ok' });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Order ${val.order} written in ${val.db === 'homedb' ? 'region A (home)' : 'region B (promoted)'}.`], async: st.config.sync ? ['yes', 'Region B’s copy confirmed it before the shopper was told.'] : ['pending', 'Copied to region B in the background.'] });
        ctx.explain(val.region === 'A' && val.db === 'homedb'
          ? `Region A is the home of orders and stock, so this order was written locally in ${took} ms${st.config.sync ? ', after region B’s copy acknowledged it (that round trip is the cost of losing nothing)' : '. Region B gets a copy about 0.3 s later'}.`
          : val.db === 'homedb'
            ? `${me.name} is served by region B, but orders live in region A, so the write crossed the inter-region link: ${took} ms instead of a local write.`
            : `Region B’s copy has been promoted, so it now takes orders itself (${took} ms).`);
      } else {
        v.orders = val.orders;
        if (val.items) v.cart = val.items;
        const mine = st.confirmed.filter((o) => o.who === me.name);
        const lost = mine.filter((o) => !val.orders.includes(o.id));
        Object.assign(v, { message: lost.length ? `We can’t find order ${lost[0].id}.` : val.orders.length ? '' : 'You have no orders.', tone: lost.length ? 'fail' : '' });
        Y.L(ctx, { displayed: lost.length ? ['yes', `Missing ${lost.map((o) => o.id).join(', ')}.`] : 'yes', committed: 'n/a', accepted: 'yes', async: 'n/a' });
        ctx.explain(lost.length
          ? `Order ${lost[0].id} was confirmed in region A, but it was still waiting to be copied when A went down. Region B’s copy was promoted without it, so the order is gone. That gap is the recovery point objective of asynchronous replication.`
          : `Read from ${val.db === 'homedb' ? 'region A, the home region' : 'region B’s copy'} via region ${val.region}.`);
      }
    }, { self: who });
  }

  /** The cart store handlers, shared by both regions. */
  function cartHandlers() {
    return {
      add(ctx, p) {
        const st = ctx.state;
        const store = st.carts[ctx.self];
        const c = (store[p.user] = store[p.user] || { items: {}, t: 0 });
        const prev = c.items[p.sku];
        c.items[p.sku] = { qty: (prev ? prev.qty : 0) + 1, t: ctx.now() };
        c.t = ctx.now();
        st.cartRepl.push({ from: ctx.self, to: ctx.self === 'cartA' ? 'cartB' : 'cartA', user: p.user, cart: copy(c), t: ctx.now() });
        return { items: flat(c) };
      },
      get(ctx, p) { const c = ctx.state.carts[ctx.self][p.user]; return { items: c ? flat(c) : {} }; },
      merge(ctx, p) {
        const st = ctx.state;
        const store = st.carts[ctx.self];
        const mine = store[p.user];
        if (!mine) { store[p.user] = copy(p.cart); return { kept: 'theirs' }; }
        if (st.config.merge) {
          for (const [sku, it] of Object.entries(p.cart.items)) if (!mine.items[sku] || it.t > mine.items[sku].t) mine.items[sku] = copy(it);
          mine.t = Math.max(mine.t, p.cart.t);
          return { kept: 'both' };
        }
        if (p.cart.t > mine.t) {
          const dropped = Object.keys(mine.items).filter((k) => !p.cart.items[k]);
          store[p.user] = copy(p.cart);
          if (dropped.length) ctx.log({ op: `last writer wins: dropped ${dropped.map((k) => SKU[k]).join(', ')}`, status: 'err', detail: `The incoming cart was written later, so it replaced this region’s cart whole.` });
          return { kept: 'theirs', dropped };
        }
        return { kept: 'mine' };
      },
    };
  }
  const flat = (c) => Object.fromEntries(Object.entries(c.items).map(([k, it]) => [k, it.qty]));

  /** Order database handlers, shared by the home database and B's copy. */
  function orderHandlers() {
    return {
      ping() { return { alive: true }; },
      place: function* (ctx, p) {
        const st = ctx.state;
        const d = st.db[ctx.self];
        if (!d.writable) ctx.fail('READ_ONLY', 'This copy is not the primary.');
        if (d.stock <= 0) ctx.fail('SOLD_OUT', 'No stock left.');
        d.stock--;
        const id = `${regionOf(ctx.self)}-${++st.seq.order}`;
        d.orders[id] = { id, who: p.user, sku: p.sku, t: ctx.now() };
        if (ctx.self === 'homedb' && st.belief.B === 'A') {
          if (st.config.sync) ctx.must(yield* reach(ctx, 'A', 'standbyB', 'apply', { order: d.orders[id], stock: d.stock }, 900));
          else st.orderRepl.push({ order: copy(d.orders[id]), stock: d.stock, t: ctx.now() });
        }
        return { order: id, db: ctx.self };
      },
      apply(ctx, p) {
        const d = ctx.state.db[ctx.self];
        d.orders[p.order.id] = copy(p.order);
        d.stock = p.stock;
        return { applied: true };
      },
      list(ctx, p) { return { orders: Object.values(ctx.state.db[ctx.self].orders).filter((o) => o.who === p.user).map((o) => o.id) }; },
    };
  }

  /** Regional API handlers: the same code runs in both regions. */
  function apiHandlers(region) {
    return {
      cart: function* (ctx, p) { return Object.assign(ctx.must(yield ctx.call(CART[region], 'add', p, { timeout: 600 })), { region }); },
      buy: function* (ctx, p) {
        const st = ctx.state;
        const target = orderDb(st, region);
        const r = yield* reach(ctx, region, target, 'place', p, 1500);
        if (!r.ok && r.error.code === 'UNAVAILABLE' && regionOf(target) !== region) ctx.fail('HOME_UNREACHABLE', 'Cannot reach the home region for orders.');
        return Object.assign(ctx.must(r), { region });
      },
      orders: function* (ctx, p) {
        const st = ctx.state;
        const target = orderDb(st, region);
        const r = yield* reach(ctx, region, target, 'list', p, 1500);
        const c = yield ctx.call(CART[region], 'get', p, { timeout: 600 });
        return Object.assign(ctx.must(r), { region, db: target, items: c.ok ? c.value.items : null });
      },
    };
  }

  function regionOutage(sim, on) {
    for (const id of ['cartA', 'homedb']) on ? sim.inject(id, 'down') : sim.restore(id, 'down');
    const st = sim.state;
    if (!on && st.belief.B === 'B') {
      st.db.homedb.writable = false;
      st.belief.A = 'B';
      sim.note('Region A is back. Region B was promoted while it was gone, so A’s order database rejoins as a copy and stops taking writes (fenced).');
    }
  }

  const sc = (SDL.scenarios['shop-regions'] = {
    id: 'shop-regions',
    seed: 733,
    productWidth: 580,
    intro: 'Priya is served by region A, Wei by region B. Add to cart and buy on both phones, then take region A down, or cut the link between the regions.',
    topology: {
      width: 1180, height: 630,
      nodes: [
        { id: 'shopperA', label: 'Priya', sub: 'Mumbai, region A', kind: 'client', x: 90, y: 130, latency: 1, role: 'A shopper nearest region A.', owns: ['What Priya sees'] },
        { id: 'shopperB', label: 'Wei', sub: 'Singapore, region B', kind: 'client', x: 90, y: 490, latency: 1, role: 'A shopper nearest region B.', owns: ['What Wei sees'] },
        { id: 'glb', label: 'Global load balancer', sub: 'Nearest healthy region', kind: 'gateway', x: 280, y: 310, latency: 3, role: 'Sends each shopper to the nearest region. With failover on, health checks move traffic away from a region that is down.', ops: [{ name: 'route', desc: 'Pick a region and forward.' }], owns: ['Region health'] },
        { id: 'apiA', label: 'Region A', sub: 'Shop API', kind: 'service', x: 480, y: 130, latency: 4, role: 'The shop API in region A. Writes carts locally; orders are local because A is the home region.', ops: [{ name: 'cart', desc: 'Add to cart.' }, { name: 'buy', desc: 'Place an order.' }, { name: 'orders', desc: 'List orders.' }], owns: ['Nothing durable'] },
        { id: 'apiB', label: 'Region B', sub: 'Shop API', kind: 'service', x: 480, y: 490, latency: 4, role: 'The same code in region B. Writes carts locally; sends orders to the home region across the link unless B has been promoted.', ops: [{ name: 'cart', desc: 'Add to cart.' }, { name: 'buy', desc: 'Place an order.' }, { name: 'orders', desc: 'List orders.' }], owns: ['Nothing durable'] },
        { id: 'cartA', label: 'Carts (A)', sub: 'Active-active', kind: 'db', x: 700, y: 50, latency: 4, role: 'Region A’s copy of every cart. Takes writes locally and exchanges changes with region B.', ops: [{ name: 'add', desc: 'Add an item.' }, { name: 'merge', desc: 'Apply the other region’s cart.' }], owns: ['cart[user] (A)'] },
        { id: 'homedb', label: 'Orders + stock (A)', sub: 'Home region, primary', kind: 'db', x: 700, y: 210, latency: 6, role: 'The single writer for orders and stock. One home avoids two regions selling the same unit.', ops: [{ name: 'place', desc: 'Take stock, write the order.' }, { name: 'list', desc: 'Read orders.' }, { name: 'ping', desc: 'Health check.' }], owns: ['orders', 'stock'] },
        { id: 'standbyB', label: 'Orders + stock (B)', sub: 'Copy; promoted on failure', kind: 'db', x: 700, y: 410, latency: 6, role: 'Region B’s copy of orders and stock. Becomes the primary if region A fails.', ops: [{ name: 'apply', desc: 'Apply a replicated order.' }, { name: 'place', desc: 'Take orders once promoted.' }, { name: 'list', desc: 'Read orders.' }], owns: ['orders (copy)', 'stock (copy)'] },
        { id: 'cartB', label: 'Carts (B)', sub: 'Active-active', kind: 'db', x: 700, y: 570, latency: 4, role: 'Region B’s copy of every cart.', ops: [{ name: 'add', desc: 'Add an item.' }, { name: 'merge', desc: 'Apply the other region’s cart.' }], owns: ['cart[user] (B)'] },
        { id: 'wan', label: 'Inter-region link', sub: '~70 ms each way', kind: 'gateway', x: 920, y: 310, latency: 35, role: 'Every cross-region call and all replication crosses this link. If it is cut, both regions are up but cannot see each other.', ops: [{ name: 'fwd', desc: 'Carry a call to the other region.' }], owns: ['Nothing'] },
        { id: 'witness', label: 'Witness', sub: 'Third site', kind: 'service', x: 1090, y: 130, latency: 20, role: 'A tie-breaker in a third location that can reach both regions directly. Answers “can you see region A?”.', ops: [{ name: 'canSee', desc: 'Check region A from outside.' }], owns: ['Nothing durable'] },
        { id: 'monitor', label: 'Failover controller', sub: 'In region B', kind: 'worker', x: 1090, y: 490, latency: 3, role: 'Pings region A every 0.3 s across the link. After two misses it promotes B’s copy, after asking the witness if quorum is on.', ops: [{ name: 'check', desc: 'Health check A.' }], owns: ['Promotion decision'] },
      ],
      edges: [
        { from: 'shopperA', to: 'glb', latency: 20 },
        { from: 'shopperB', to: 'glb', latency: 20 },
        { from: 'glb', to: 'apiA', latency: 15 },
        { from: 'glb', to: 'apiB', latency: 15 },
        { from: 'apiA', to: 'cartA', latency: 3 },
        { from: 'apiA', to: 'homedb', latency: 3 },
        { from: 'apiB', to: 'cartB', latency: 3 },
        { from: 'apiB', to: 'standbyB', latency: 3 },
        { from: 'apiA', to: 'wan', latency: 3, via: [[600, 130], [600, 310]] },
        { from: 'apiB', to: 'wan', latency: 3, via: [[600, 490], [600, 310]] },
        { from: 'wan', to: 'homedb', latency: 35 },
        { from: 'wan', to: 'standbyB', latency: 35 },
        { from: 'wan', to: 'cartA', latency: 35, via: [[920, 50]] },
        { from: 'wan', to: 'cartB', latency: 35, via: [[920, 570]] },
        { from: 'monitor', to: 'wan', latency: 3 },
        { from: 'monitor', to: 'witness', latency: 20 },
        { from: 'monitor', to: 'standbyB', latency: 3, via: [[1090, 410]] },
        { from: 'witness', to: 'homedb', latency: 20, via: [[1090, 210]] },
      ],
    },
    failures: [
      { id: 'region', node: 'apiA', mode: 'down', label: 'Region A outage', desc: 'The whole region: API, cart store, and the home order database.' },
      { id: 'partition', node: 'wan', mode: 'down', label: 'Link between regions cut', desc: 'Both regions are up but cannot see each other.' },
      { id: 'wan-slow', node: 'wan', mode: 'slow', params: { factor: 8 }, label: 'Link congested', desc: 'Cross-region calls and replication slow down.' },
      { id: 'witness-down', node: 'witness', mode: 'down', label: 'Witness down', desc: 'With quorum on, B can never promote itself.' },
      { id: 'b-down', node: 'apiB', mode: 'down', label: 'Region B API down', desc: 'Wei is moved to region A if failover is on.' },
    ],
    onFailureChange(sim, f) {
      if (f.node === 'apiA' && f.mode === 'down') regionOutage(sim, f.active);
    },
    switches: Y.switches([
      ['failover', 'Regional failover', 'Health checks move shoppers away from a failed region, and B’s copy of orders is promoted when A stops answering. Off: traffic keeps going to the failed region.'],
      ['sync', 'Synchronous order replication', 'Confirm an order only once region B’s copy has it: one extra round trip, nothing lost. Off: copy it about 0.3 s later.'],
      ['quorum', 'Promote only with the witness', 'Before promoting, ask a third site whether it can see region A. Off: two missed pings are enough.'],
      ['merge', 'Merge carts item by item', 'When regions exchange carts, keep every item and the newest version of each. Off: the cart written last replaces the other whole.'],
    ]),
    presets: Y.presets({ failover: true, sync: true, quorum: true, merge: true }, [
      { id: 'normal', label: 'Normal day', desc: 'Priya orders in the home region: a local write. Wei’s order crosses the link to region A, so it takes longer.', run: (s) => { startAction(s, 'shopperA', 'buy', 'echo'); s.schedule(600, () => startAction(s, 'shopperB', 'buy', 'echo')); } },
      { id: 'failover', label: 'Region A fails, synchronous orders', desc: 'Priya orders, then region A goes down. Traffic moves to B, B’s copy is promoted, and Priya’s order is still there.', run: (s) => { startAction(s, 'shopperA', 'buy', 'echo'); s.schedule(800, () => s.inject('apiA', 'down')); s.schedule(2500, () => startAction(s, 'shopperA', 'orders')); } },
      { id: 'failover-async', label: 'Region A fails, asynchronous orders', desc: 'Priya’s order is confirmed, and region A fails 0.15 s later, before the copy shipped. After failover the order does not exist.', sw: { sync: false }, run: (s) => { startAction(s, 'shopperA', 'buy', 'echo'); s.schedule(260, () => s.inject('apiA', 'down')); s.schedule(2500, () => startAction(s, 'shopperA', 'orders')); } },
      { id: 'no-failover', label: 'Region A fails, no failover', desc: 'The load balancer keeps sending Priya to region A. Every request fails though region B is healthy.', sw: { failover: false }, run: (s) => { s.schedule(300, () => s.inject('apiA', 'down')); s.schedule(1000, () => startAction(s, 'shopperA', 'cart', 'echo')); s.schedule(2200, () => startAction(s, 'shopperA', 'buy', 'echo')); } },
      { id: 'partition', label: 'Link cut, promotion needs the witness', desc: 'The witness can still see A, so B is not promoted. Wei can fill a cart but cannot order: one region keeps selling, no unit is sold twice.', sw: { sync: false }, run: (s) => { s.state.db.homedb.stock = 1; s.state.db.standbyB.stock = 1; s.schedule(200, () => s.inject('wan', 'down')); s.schedule(1200, () => startAction(s, 'shopperB', 'cart', 'echo')); s.schedule(1500, () => startAction(s, 'shopperA', 'buy', 'echo')); s.schedule(1600, () => startAction(s, 'shopperB', 'buy', 'echo')); } },
      { id: 'partition-bad', label: 'Link cut, promotion without a witness (split brain)', desc: 'B sees A “disappear” and promotes itself while A is still selling. The last unit is sold in both regions.', sw: { sync: false, quorum: false }, run: (s) => { s.state.db.homedb.stock = 1; s.state.db.standbyB.stock = 1; s.schedule(200, () => s.inject('wan', 'down')); s.schedule(1500, () => startAction(s, 'shopperA', 'buy', 'echo')); s.schedule(1600, () => startAction(s, 'shopperB', 'buy', 'echo')); } },
      { id: 'cart', label: 'Cart edited in both regions, merged', desc: 'Priya adds an Echo Dot in A; A fails before it replicates; Priya adds a Kindle in B. When A returns, the carts merge: both items.', run: (s) => { startAction(s, 'shopperA', 'cart', 'echo'); s.schedule(150, () => s.inject('apiA', 'down')); s.schedule(1500, () => startAction(s, 'shopperA', 'cart', 'kindle')); s.schedule(3500, () => s.restore('apiA', 'down')); s.schedule(4500, () => startAction(s, 'shopperA', 'orders')); } },
      { id: 'cart-bad', label: 'Same, last writer wins', desc: 'When A returns, region B’s cart is newer and replaces A’s whole. The Echo Dot Priya added is gone in both regions.', sw: { merge: false }, run: (s) => { startAction(s, 'shopperA', 'cart', 'echo'); s.schedule(150, () => s.inject('apiA', 'down')); s.schedule(1500, () => startAction(s, 'shopperA', 'cart', 'kindle')); s.schedule(3500, () => s.restore('apiA', 'down')); s.schedule(4500, () => startAction(s, 'shopperA', 'orders')); } },
    ]),
    initialState: () => ({
      config: { failover: true, sync: true, quorum: true, merge: true },
      db: { homedb: { orders: {}, stock: 5, writable: true }, standbyB: { orders: {}, stock: 5, writable: false } },
      belief: { A: 'A', B: 'A' },
      carts: { cartA: {}, cartB: {} },
      cartRepl: [], orderRepl: [],
      confirmed: [], cartIntent: {},
      regionErrors: 0,
      seq: { order: 0 },
      stats: { refused: 0, promotions: 0, misses: 0, witnessSaid: null },
    }),
    initialUI: () => {
      const phone = (region) => ({ region, busy: false, cart: {}, orders: null, lastOrder: null, took: 0, message: '', tone: '' });
      return { shopperA: phone('A'), shopperB: phone('B') };
    },
    actions: {
      cart(sim, a) { startAction(sim, a.who, 'cart', a.sku); },
      buy(sim, a) { startAction(sim, a.who, 'buy', 'echo'); },
      orders(sim, a) { startAction(sim, a.who, 'orders'); },
    },
    handlers: {
      glb: {
        route: function* (ctx, p) {
          const st = ctx.state;
          let region = SHOPPER[p.who].home;
          if (st.config.failover && down(ctx.sim, API[region]) && !down(ctx.sim, API[other(region)])) region = other(region);
          ctx.ui[p.who].region = region;
          const r = yield ctx.call(API[region], p.op, p.payload, { timeout: 2200 });
          if (!r.ok && down(ctx.sim, API[region])) st.regionErrors++;
          return ctx.must(r);
        },
      },
      apiA: apiHandlers('A'),
      apiB: apiHandlers('B'),
      cartA: cartHandlers(),
      cartB: cartHandlers(),
      homedb: orderHandlers(),
      standbyB: orderHandlers(),
      wan: {
        fwd: function* (ctx, p) { return ctx.must(yield ctx.call(p.to, p.op, p.payload, { timeout: p.timeout })); },
      },
      witness: {
        canSee: function* (ctx) { const r = yield ctx.call('homedb', 'ping', {}, { timeout: 200 }); return { aAlive: r.ok }; },
      },
    },
    setup(sim) {
      // Background replication across the link: carts both ways, orders from A to B.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const st = ctx.state;
          for (const e of st.cartRepl.slice()) {
            if (ctx.now() - e.t < REPL_MS || down(ctx.sim, e.from) || down(ctx.sim, e.to)) continue;
            const r = yield ctx.call('wan', 'fwd', { to: e.to, op: 'merge', payload: { user: e.user, cart: e.cart }, timeout: 400 }, { timeout: 500, quiet: true });
            if (r.ok) st.cartRepl.splice(st.cartRepl.indexOf(e), 1);
          }
          if (st.belief.B !== 'A') { st.orderRepl = []; continue; }
          for (const e of st.orderRepl.slice()) {
            if (ctx.now() - e.t < REPL_MS || down(ctx.sim, 'homedb')) continue;
            const r = yield ctx.call('wan', 'fwd', { to: 'standbyB', op: 'apply', payload: { order: e.order, stock: e.stock }, timeout: 400 }, { timeout: 500, quiet: true });
            if (r.ok) st.orderRepl.splice(st.orderRepl.indexOf(e), 1);
          }
        }
      }, { self: 'wan', quiet: 'all' });
      // Failover controller in region B.
      sim.spawn(function* (ctx) {
        let misses = 0;
        for (;;) {
          yield ctx.wait(300);
          const st = ctx.state;
          if (st.belief.B === 'B' || !st.config.failover) { misses = 0; continue; }
          const r = yield ctx.call('wan', 'fwd', { to: 'homedb', op: 'ping', payload: {}, timeout: 200 }, { timeout: 280, quiet: 'all' });
          if (r.ok) { misses = 0; continue; }
          st.stats.misses = ++misses;
          if (misses < 2) continue;
          if (st.config.quorum) {
            const w = yield ctx.call('witness', 'canSee', {}, { timeout: 400, quiet: true });
            st.stats.witnessSaid = w.ok ? (w.value.aAlive ? 'alive' : 'gone') : 'unreachable';
            if (!w.ok || w.value.aAlive) {
              if (misses === 2) ctx.log({ op: w.ok ? 'not promoting: witness sees A' : 'not promoting: no witness', status: 'note', detail: w.ok ? 'Region B cannot reach A, but the witness can. The link is cut; A is alive and still the primary.' : 'Without a majority, B must not promote itself.' });
              continue;
            }
          }
          st.belief.B = 'B';
          st.db.standbyB.writable = true;
          st.stats.promotions++;
          ctx.log({ op: 'region B promoted', status: 'recovered', detail: `Region A missed ${misses} health checks${st.config.quorum ? ' and the witness cannot see it either' : ''}. B’s copy of orders and stock is now the primary${st.orderRepl.length ? `; ${st.orderRepl.length} order${st.orderRepl.length > 1 ? 's were' : ' was'} never copied` : ''}.` });
        }
      }, { self: 'monitor', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const both = st.db.homedb.writable && st.db.standbyB.writable;
      const ids = new Set(st.confirmed.map((o) => o.id));
      if (both && Object.keys(st.db.homedb.orders).some((id) => !st.db.standbyB.orders[id]) && Object.keys(st.db.standbyB.orders).some((id) => !st.db.homedb.orders[id])) {
        return { key: 'wrong', label: `Split brain: both regions are taking orders. Region A sold ${Object.keys(st.db.homedb.orders).length} and region B sold ${Object.keys(st.db.standbyB.orders).length} from the same stock: the last unit went to two shoppers.` };
      }
      const live = st.belief.B === 'B' ? st.db.standbyB : st.db.homedb;
      const lost = [...ids].filter((id) => !live.orders[id]);
      if (lost.length) return { key: 'wrong', label: `Order ${lost.join(', ')} was confirmed, then lost in failover: it had not been copied to region B when A went down.` };
      if (st.regionErrors) return { key: 'wrong', label: `${st.regionErrors} request${st.regionErrors > 1 ? 's' : ''} failed in region A while region B was healthy and could have served ${st.regionErrors > 1 ? 'them' : 'it'}.` };
      if (!st.cartRepl.length) {
        for (const [user, want] of Object.entries(st.cartIntent)) {
          for (const store of ['cartA', 'cartB']) {
            const c = st.carts[store][user];
            const gone = Object.keys(want).filter((k) => !(c && c.items[k]));
            if (gone.length) return { key: 'wrong', label: `${user} added ${gone.map((k) => SKU[k]).join(', ')}, but after the regions reconciled ${store === 'cartA' ? 'region A' : 'region B'}’s cart no longer has it: the newer cart replaced the older one whole.` };
          }
        }
      }
      if (st.stats.refused) return { key: 'stale', label: `The regions cannot see each other. Region B refused ${st.stats.refused} order${st.stats.refused > 1 ? 's' : ''} rather than risk selling stock twice; carts still work everywhere.` };
      if (st.cartRepl.length) return { key: 'stale', label: `${st.cartRepl.length} cart change${st.cartRepl.length > 1 ? 's are' : ' is'} waiting to reach the other region.` };
      const carts = Object.keys(st.cartIntent).map((u) => `${u}’s cart has ${Object.keys(st.cartIntent[u]).map((k) => SKU[k]).join(' and ')} in both regions`).join('; ');
      if (carts) return { key: 'ok', label: `The regions reconciled item by item: ${carts}.` };
      return { key: 'ok', label: st.belief.B === 'B' ? 'Region B took over. Every confirmed order survived and nothing was sold twice.' : 'One home for orders, carts in both regions, every confirmed order in place.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      return [
        { label: 'Orders primary', value: st.db.homedb.writable && st.db.standbyB.writable ? 'A and B ✕' : st.belief.B === 'B' ? 'Region B' : 'Region A' },
        { label: 'Orders not yet copied', value: st.orderRepl.length, tone: st.orderRepl.length ? 'warn' : 'ok' },
        { label: 'Cart changes in flight', value: st.cartRepl.length },
        { label: 'Missed health checks', value: st.stats.misses },
        { label: 'Requests to a dead region', value: st.regionErrors, tone: st.regionErrors ? 'fail' : 'ok' },
        { label: 'Orders refused (no home)', value: st.stats.refused },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['shopperA', 'Priya, Mumbai'], ['shopperB', 'Wei, Singapore']], {
          note: 'Each phone is served by its nearest region. The console below shows both regions.',
          below: '<div class="ops-console" data-ref="console"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const who of Object.keys(SHOPPER)) {
          const u = sim.ui[who];
          const me = SHOPPER[who];
          const a = (sku) => ({ who, sku });
          const lines = Object.entries(u.cart).filter(([, n]) => n > 0);
          Y.paint(el, sim, who, {
            head: `<div><p class="app-title">Amazon</p><p class="app-sub">Hello, ${esc(me.name)}: region ${u.region}${u.took ? `, ${u.took} ms` : ''}</p></div>`,
            product: `<div class="yt-card"><div class="yt-thumb" style="--h:200"><span aria-hidden="true">◉</span></div>
              <div><strong>Echo Dot smart speaker</strong><p class="app-price">$${PRICE}</p></div></div>`,
            actions: `<div class="app-row">${Y.btn('cart', 'Add Echo Dot', { arg: a('echo'), cls: 'secondary', disabled: u.busy })}${Y.btn('cart', 'Add Kindle', { arg: a('kindle'), cls: 'secondary', disabled: u.busy })}</div>
              <div class="app-row">${Y.btn('buy', 'Buy now', { arg: { who }, disabled: u.busy })}${Y.btn('orders', 'Orders and cart', { arg: { who }, cls: 'secondary', disabled: u.busy })}</div>`,
            cart: `<div class="app-card"><strong>🛒 Cart</strong><span class="app-sub">${lines.length ? esc(lines.map(([k, n]) => `${SKU[k]}${n > 1 ? ` ×${n}` : ''}`).join(', ')) : 'Empty'}</span>
              ${u.orders ? `<span class="app-sub">Orders: ${u.orders.length ? esc(u.orders.join(', ')) : 'none'}</span>` : ''}</div>`,
            msg: u.busy ? '<p class="app-msg"><span class="spinner"></span>Working…</p>' : Y.msg(u.message, u.tone),
          });
        }
        const dbRow = (id, label) => {
          const d = st.db[id];
          const isDown = down(sim, id);
          const role = isDown ? 'down' : d.writable ? 'primary' : 'copy';
          return `<div class="ops-row" data-tone="${isDown ? 'fail' : st.db.homedb.writable && st.db.standbyB.writable ? 'fail' : ''}"><div class="ops-name">${label}<span>${role}, stock ${d.stock}, orders ${Object.keys(d.orders).join(', ') || 'none'}</span></div></div>`;
        };
        const cartRow = (id, label) => {
          const users = Object.entries(st.carts[id]);
          return `<div class="ops-row" data-tone="${down(sim, id) ? 'fail' : ''}"><div class="ops-name">${label}<span>${down(sim, id) ? 'down' : users.length ? esc(users.map(([u, c]) => `${u}: ${Object.keys(c.items).map((k) => SKU[k]).join(', ')}`).join('; ')) : 'empty'}</span></div></div>`;
        };
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="console"]'), {
          title: '<p class="ops-title">Regions</p>',
          rows: `<div class="ops-shards">${dbRow('homedb', 'Orders + stock, region A')}${dbRow('standbyB', 'Orders + stock, region B')}${cartRow('cartA', 'Carts, region A')}${cartRow('cartB', 'Carts, region B')}</div>`,
          link: `<p class="app-sub">Link between regions: ${down(sim, 'wan') ? '✕ cut' : '✓ up'}. Waiting to copy: ${st.orderRepl.length} order${st.orderRepl.length === 1 ? '' : 's'}, ${st.cartRepl.length} cart change${st.cartRepl.length === 1 ? '' : 's'}.${st.stats.witnessSaid ? ` Witness last said region A is ${st.stats.witnessSaid}.` : ''}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        });
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
