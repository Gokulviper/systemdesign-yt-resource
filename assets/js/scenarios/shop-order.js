/*
 * End-to-end order. The whole store on one diagram: a global load balancer in
 * front of two regional store APIs; search, carts, inventory, and orders behind
 * them; the payment service and an external card processor; an order-events
 * broker feeding the warehouse and the notifier. One unit of the product is
 * left, so every shortcut in checkout shows up as an oversell, a double charge,
 * or an order nobody ships. The deep-dive labs take each piece further.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const ITEM = { sku: 'echo-dot', title: 'Echo Dot (5th gen) smart speaker', price: 49.99 };
  const BEST = [ITEM, { sku: 'kindle', title: 'Kindle Paperwhite', price: 149.99 }];

  const region = (sim) => (sim.state.config.failover && sim.nodes.apiA.modes.down ? 'B' : 'A');
  const api = (sim) => (region(sim) === 'A' ? 'apiA' : 'apiB');

  function startSearch(sim) {
    sim.startAction('Shopper: search “echo dot”', function* (ctx) {
      Y.L(ctx, { committed: ['n/a', 'Searching is a read.'], async: 'n/a', retrySafe: ['yes', 'Read-only.'] });
      const r = yield ctx.call('glb', 'search', { q: 'echo dot' }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      const u = ctx.ui.shopper;
      if (!r.ok) { Object.assign(u, { message: `Search failed: ${r.error.message}`, tone: 'fail' }); Y.failed(ctx, 'Shows an error.'); return; }
      Object.assign(u, { results: r.value.items, degraded: !!r.value.degraded, region: r.value.region, message: r.value.degraded ? 'Search is having trouble. Showing best sellers instead.' : '', tone: r.value.degraded ? 'warn' : '' });
      Y.L(ctx, { displayed: 'yes', accepted: 'yes' });
      ctx.explain(r.value.degraded
        ? 'The search service is down, so the store API answered from a cached best-seller list. Shoppers can still buy; they just cannot search. Degrading beats an error page.'
        : `The load balancer sent the shopper to region ${r.value.region}. Its store API asked the search service, which answers from a sharded index built from the catalogue (see the search lab).`);
    }, { self: 'shopper' });
  }

  function startAdd(sim) {
    sim.startAction('Shopper: add to cart', function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'The request sets quantity = 1, so a retry changes nothing.'], async: 'n/a' });
      const r = yield ctx.call('glb', 'add', { sku: ITEM.sku, qty: 1 }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      const u = ctx.ui.shopper;
      if (!r.ok) { Object.assign(u, { message: `Couldn’t add to cart: ${r.error.message}`, tone: 'fail' }); Y.failed(ctx); return; }
      Object.assign(u, { cart: r.value.qty, message: 'Added to cart.', tone: 'ok' });
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', 'The cart store, replicated to both regions.'] });
      ctx.explain('Carts are written to a store replicated across regions, so the cart survives a regional failover. Adding to the cart reserves nothing: stock is only set aside at checkout.');
    }, { self: 'shopper' });
  }

  function startPlace(sim, label) {
    const u = sim.ui.shopper;
    if (!u.cart || u.stage === 'placed') return;
    const key = u.key;
    sim.startAction(label || 'Shopper: place your order', function* (ctx) {
      const v = ctx.ui.shopper;
      v.stage = 'placing';
      Y.L(ctx, { displayed: ['pending', 'Shows “Placing your order…”.'], retrySafe: ctx.state.config.idem ? ['yes', `Idempotency key ${key}.`] : ['no', 'No idempotency key.'] });
      const r = yield ctx.call('glb', 'place', { key }, { timeout: 5000 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) {
        ctx.state.orderAction[r.value.orderId] = ctx.state.orderAction[r.value.orderId] || ctx.actionId;
        Object.assign(v, { stage: 'placed', order: r.value.orderId, region: r.value.region, message: r.value.replayed ? `Same order ${r.value.orderId} (repeat tap recognised).` : `Order ${r.value.orderId} placed.`, tone: 'ok' });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: r.value.replayed ? ['yes', 'Existing order returned.'] : ['yes', 'Order confirmed.'], async: r.value.replayed ? 'n/a' : ['pending', 'Warehouse and notifications follow the event.'] });
        ctx.explain(r.value.replayed
          ? 'The repeat request carried the same idempotency key, so the order service returned the existing order instead of charging again.'
          : `${ctx.state.config.reserve ? 'Checkout reserved the last unit, then' : 'Checkout checked the stock (no reservation), then'} authorised the card through the payment service and the external processor, then confirmed the order and ${ctx.state.config.outbox ? 'wrote its event to the outbox' : 'published its event directly'}. The warehouse and the notifier react to that event.`);
      } else {
        const code = r.error.code;
        Object.assign(v, { stage: 'cart', message: { SOLD_OUT: 'Sorry, this item just sold out. You weren’t charged.', DECLINED: 'Your card was declined. Nothing was charged.' }[code] || `Couldn’t place the order: ${r.error.message}`, tone: 'fail' });
        Y.failed(ctx, 'Shows an error; nothing charged.');
        ctx.explain({
          SOLD_OUT: 'Someone else reserved the last unit first. Because the reservation is a conditional update, the second checkout is refused before any card is touched.',
          DECLINED: 'The processor declined the card. The order service released the reservation it had just made (a compensation) and cancelled the order, so the unit is back on sale.',
        }[code] || `The order failed with ${code}.`);
      }
    }, { self: 'shopper' });
  }

  function startRival(sim) {
    const st = sim.state;
    const key = 'other-' + ++st.seq.rival;
    sim.spawn(function* (ctx) {
      ctx.log({ op: 'another shopper checks out the same item', status: 'note', detail: `Checkout ${key} from someone else’s phone.` });
      const r = yield ctx.call(api(ctx.sim), 'place', { key }, { timeout: 5000 });
      ctx.log({ op: r.ok ? `other shopper got ${r.value.orderId}` : `other shopper refused: ${r.error.code}`, status: r.ok ? 'ok' : 'err' });
    }, { self: 'glb' });
  }

  function startShip(sim, orderId) {
    const o = sim.state.orders[orderId];
    if (!o || o.status !== 'CONFIRMED') return;
    sim.startAction(`Warehouse: ship ${orderId}`, function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'Shipping is a state change from CONFIRMED; the capture has its own key.'] });
      const r = yield ctx.call('glb', 'ship', { orderId }, { timeout: 3000 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) { Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', 'Order SHIPPED; payment captured.'], async: ['pending', 'Shipping notification.'] }); ctx.explain('Shipping captures the authorised payment: money is taken when the goods leave, not when the order is placed. The order.shipped event tells the shopper.'); } else Y.failed(ctx, r.error.message);
    }, { self: 'warehouse' });
  }

  /* Region routing at the global load balancer. */
  const route = (op, timeout) => function* (ctx, p) {
    const target = api(ctx.sim);
    const r = yield ctx.call(target, op, p, { timeout });
    if (!r.ok && r.error.code === 'UNAVAILABLE' && target === 'apiA') ctx.state.regionErrors++;
    return Object.assign({ region: region(ctx.sim) }, ctx.must(r));
  };
  const regional = {
    search: function* (ctx, p) {
      const r = yield ctx.call('search', 'query', p, { timeout: 600 });
      if (r.ok) return r.value;
      if (!ctx.state.config.fallback) ctx.must(r);
      ctx.state.degraded = true;
      return { items: BEST, degraded: true };
    },
    add: function* (ctx, p) { return ctx.must(yield ctx.call('cart', 'put', p, { timeout: 800 })); },
    place: function* (ctx, p) { return ctx.must(yield ctx.call('orders', 'place', p, { timeout: 4500 })); },
    ship: function* (ctx, p) { return ctx.must(yield ctx.call('orders', 'ship', p, { timeout: 2500 })); },
  };

  function* publish(ctx, type, orderId) {
    const st = ctx.state;
    const eventId = `ev-${type}-${orderId}`;
    if (st.config.outbox) { ctx.sim.enqueue('outbox', { type, eventId, payload: { type, orderId }, actionId: st.orderAction[orderId] }); return; }
    const r = yield ctx.call('events', 'publish', { type, orderId, eventId }, { timeout: 600 });
    if (!r.ok) { st.lost.push(eventId); ctx.log({ op: `${type} for ${orderId} lost`, status: 'err', error: r.error, detail: 'The order committed but the publish failed, and nothing will retry it.' }); }
  }

  const sc = (SDL.scenarios['shop-order'] = {
    id: 'shop-order',
    seed: 509,
    productWidth: 600,
    intro: 'Search, add the Echo Dot to your cart, and place the order. Then ship it from the warehouse console. Only one unit is left, so try the other shopper, a double tap, or a region outage.',
    topology: {
      width: 1160, height: 620,
      nodes: [
        { id: 'shopper', label: 'Shopper app', sub: 'Phone', kind: 'client', x: 90, y: 100, latency: 1, role: 'Searches, adds to cart, places orders, receives notifications.', ops: [{ name: 'push', desc: 'Receive a notification.' }], owns: ['What the shopper sees'] },
        { id: 'warehouse', label: 'Warehouse console', sub: 'Pick, pack, ship', kind: 'client', x: 90, y: 460, latency: 1, role: 'Shows confirmed orders to ship.', ops: [{ name: 'pick', desc: 'Add an order to the pick list.' }], owns: ['Pick list'] },
        { id: 'glb', label: 'Global load balancer', sub: 'DNS + health checks', kind: 'gateway', x: 290, y: 280, latency: 3, role: 'Sends each request to a healthy region.', ops: [{ name: 'search', desc: 'Route.' }, { name: 'add', desc: 'Route.' }, { name: 'place', desc: 'Route.' }, { name: 'ship', desc: 'Route.' }], owns: ['Region health'] },
        { id: 'apiA', label: 'Store API, region A', sub: 'Stateless', kind: 'service', x: 510, y: 170, latency: 3, role: 'Search, cart, checkout, and shipping endpoints. Falls back to best sellers if search is down.', ops: [{ name: 'search', desc: 'Search.' }, { name: 'add', desc: 'Add to cart.' }, { name: 'place', desc: 'Place an order.' }], owns: ['Nothing durable'] },
        { id: 'apiB', label: 'Store API, region B', sub: 'Stateless', kind: 'service', x: 510, y: 390, latency: 3, role: 'The same API in the second region.', ops: [{ name: 'search', desc: 'Search.' }, { name: 'add', desc: 'Add to cart.' }, { name: 'place', desc: 'Place an order.' }], owns: ['Nothing durable'] },
        { id: 'search', label: 'Search', sub: 'Index + ranking', kind: 'service', x: 750, y: 50, latency: 6, role: 'Queries the product index (see the search lab).', ops: [{ name: 'query', desc: 'Search products.' }], owns: ['Search index'] },
        { id: 'cart', label: 'Cart store', sub: 'Replicated, both regions', kind: 'db', x: 750, y: 160, latency: 4, role: 'One cart per shopper, readable and writable in both regions (see the cart lab).', ops: [{ name: 'put', desc: 'Set a quantity.' }], owns: ['carts'] },
        { id: 'inventory', label: 'Inventory', sub: 'Stock + holds', kind: 'db', x: 750, y: 275, latency: 6, role: 'Reserves stock with a conditional update (see the inventory lab).', ops: [{ name: 'reserve', desc: 'Reserve if available.' }, { name: 'check', desc: 'Read availability.' }, { name: 'decrement', desc: 'Take one unit.' }, { name: 'release', desc: 'Undo a reservation.' }], owns: ['stock', 'holds'] },
        { id: 'orders', label: 'Order service', sub: 'Saga + outbox', kind: 'service', x: 750, y: 410, latency: 5, role: 'Creates orders (unique per idempotency key), runs the checkout saga, and writes events to its outbox (see the checkout lab).', ops: [{ name: 'place', desc: 'Place an order.' }, { name: 'ship', desc: 'Mark shipped and capture.' }], owns: ['orders', 'outbox'] },
        { id: 'payments', label: 'Payment service', sub: 'Idempotent', kind: 'service', x: 990, y: 410, latency: 4, role: 'Authorises and captures through the processor, retrying with the same idempotency key (see the payments lab).', ops: [{ name: 'authorize', desc: 'Authorise.' }, { name: 'capture', desc: 'Capture.' }], owns: ['Payment intents'] },
        { id: 'processor', label: 'Card processor', sub: 'External', kind: 'service', x: 990, y: 260, latency: 120, role: 'Moves money on cards. Deduplicates by idempotency key.', ops: [{ name: 'authorize', desc: 'Authorise.' }, { name: 'capture', desc: 'Capture.' }], owns: ['Charges'] },
        { id: 'events', label: 'Order events', sub: 'Broker', kind: 'queue', x: 750, y: 550, latency: 4, queue: 'orderEvents', role: 'order.confirmed and order.shipped for the warehouse and the notifier.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['event log'] },
        { id: 'notifier', label: 'Notifier', sub: 'Push and email', kind: 'worker', x: 300, y: 560, latency: 4, role: 'Tells the shopper about their order (see the notifications lab).', ops: [{ name: 'consume', desc: 'Send a notification.' }], owns: ['Sent notifications'] },
      ],
      edges: [
        { from: 'shopper', to: 'glb', latency: 30 },
        { from: 'warehouse', to: 'glb', latency: 20 },
        { from: 'glb', to: 'apiA', latency: 8 },
        { from: 'glb', to: 'apiB', latency: 14 },
        { from: 'apiA', to: 'search', latency: 3 }, { from: 'apiB', to: 'search', latency: 12 },
        { from: 'apiA', to: 'cart', latency: 3 }, { from: 'apiB', to: 'cart', latency: 3 },
        { from: 'apiA', to: 'orders', latency: 4 }, { from: 'apiB', to: 'orders', latency: 12 },
        { from: 'orders', to: 'inventory', latency: 3 },
        { from: 'orders', to: 'payments', latency: 4 },
        { from: 'payments', to: 'processor', latency: 40, label: 'HTTPS' },
        { from: 'orders', to: 'events', latency: 5, label: 'outbox' },
        { from: 'events', to: 'notifier', latency: 4 },
        { from: 'events', to: 'warehouse', latency: 8 },
        { from: 'notifier', to: 'shopper', latency: 40, label: 'push' },
      ],
      queues: [
        { id: 'outbox', broker: 'orders', label: 'outbox', groups: ['relay'] },
        { id: 'orderEvents', broker: 'events', label: 'order-events', groups: ['notifier', 'warehouse'] },
      ],
    },
    modeLabels: { decline: 'Declining cards' },
    failures: [
      { id: 'regionA', node: 'apiA', mode: 'down', label: 'Region A outage', desc: 'The store API in region A stops answering.' },
      { id: 'search-down', node: 'search', mode: 'down', label: 'Search unavailable', desc: 'Searches fail or fall back to best sellers.' },
      { id: 'cart-down', node: 'cart', mode: 'down', label: 'Cart store unavailable', desc: 'Items cannot be added.' },
      { id: 'inv-slow', node: 'inventory', mode: 'slow', params: { factor: 30 }, label: 'Inventory slow', desc: 'Checkout waits on reservations.' },
      { id: 'decline', node: 'processor', mode: 'decline', label: 'Card declined', desc: 'The processor refuses the authorisation.' },
      { id: 'proc-timeout', node: 'processor', mode: 'dropResponse', label: 'Processor reply lost', desc: 'The authorisation happens but the answer never arrives.' },
      { id: 'proc-down', node: 'processor', mode: 'down', label: 'Processor unavailable', desc: 'No card can be authorised.' },
      { id: 'events-down', node: 'events', mode: 'down', label: 'Broker unavailable', desc: 'Events cannot be published.' },
      { id: 'notifier-paused', node: 'notifier', mode: 'paused', label: 'Notifier paused', desc: 'The shopper is not told.' },
      { id: 'payments-down', node: 'payments', mode: 'down', label: 'Payment service unavailable', desc: 'Checkout cannot authorise.' },
    ],
    switches: Y.switches([
      ['reserve', 'Reserve stock at checkout', 'A conditional reservation before payment. Off: check the stock, pay, then take a unit.'],
      ['idem', 'Idempotency key on place order', 'Off: a repeat tap is a second order and a second charge.'],
      ['outbox', 'Transactional outbox', 'Off: confirm, then publish the event separately (a dual write).'],
      ['fallback', 'Search falls back to best sellers', 'Off: when search is down, the shopper gets an error.'],
      ['failover', 'Regional failover', 'Route around an unhealthy region. Off: region A users get errors.'],
    ]),
    presets: Y.presets({ reserve: true, idem: true, outbox: true, fallback: true, failover: true }, (function () {
      const journey = (s, extra) => { startSearch(s); s.schedule(400, () => startAdd(s)); s.schedule(900, () => startPlace(s)); if (extra) extra(s); };
      const ship = (s, t) => s.schedule(t || 3200, () => startShip(s, 'O1'));
      return [
        { id: 'happy', label: 'Search to doorstep', desc: 'Search, add to cart, place the order, then the warehouse ships and the payment is captured.', run: (s) => journey(s, ship) },
        { id: 'search-down', label: 'Search down, best sellers instead', desc: 'Search fails; the API answers from a cached list. The shopper can still buy.', run: (s) => { s.inject('search', 'down'); journey(s); } },
        { id: 'last-unit', label: 'Someone else wants the last unit', desc: 'You reserve first; the other shopper is told it sold out before paying.', run: (s) => journey(s, (x) => { x.schedule(1000, () => startRival(x)); ship(x); }) },
        { id: 'last-unit-bad', label: 'Last unit, no reservation', desc: 'Both checkouts see one in stock, both pay, both take it: oversold.', sw: { reserve: false }, run: (s) => journey(s, (x) => x.schedule(1000, () => startRival(x))) },
        { id: 'double', label: 'Double tap, one key', desc: 'Two taps, one order, one charge.', run: (s) => journey(s, (x) => x.schedule(960, () => startPlace(x, 'Shopper: place order (second tap)'))) },
        { id: 'double-bad', label: 'Double tap, no key', desc: 'With plenty of stock (a restock of 9 units), nothing stops the second order: two orders and two charges for one item.', sw: { idem: false }, run: (s) => { s.state.stock.onHand += 9; s.state.units += 9; s.note('The warehouse restocks 9 more units, so stock no longer limits orders.'); journey(s, (x) => x.schedule(960, () => startPlace(x, 'Shopper: place order (second tap)'))); } },
        { id: 'declined', label: 'Card declined', desc: 'The order is cancelled and the reserved unit goes back on sale.', run: (s) => { s.inject('processor', 'decline'); journey(s); } },
        { id: 'timeout', label: 'Processor reply lost', desc: 'The first authorisation’s reply is lost; the retry carries the same key, so the card is charged once.', run: (s) => { s.schedule(900, () => s.inject('processor', 'dropResponse', null, 500)); journey(s); } },
        { id: 'paused', label: 'Notifier paused', desc: 'The order is fine, but the shopper hears nothing until the notifier resumes.', run: (s) => { s.inject('notifier', 'paused'); journey(s); } },
        { id: 'dual', label: 'Broker down at confirmation, dual write', desc: 'The publish fails after the commit: the warehouse never hears about the order.', sw: { outbox: false }, run: (s) => { s.schedule(900, () => s.inject('events', 'down', null, 2500)); journey(s); } },
        { id: 'region', label: 'Region A down, failover', desc: 'The load balancer sends everything to region B. Carts, stock, and orders are shared, so the journey continues.', run: (s) => { s.inject('apiA', 'down'); journey(s, ship); } },
        { id: 'region-bad', label: 'Region A down, no failover', desc: 'Traffic keeps going to the dead region: every request fails.', sw: { failover: false }, run: (s) => { s.inject('apiA', 'down'); journey(s); } },
      ];
    })()),
    initialState: () => ({
      config: { reserve: true, idem: true, outbox: true, fallback: true, failover: true },
      carts: {}, stock: { onHand: 1, holds: {} }, units: 1, sold: [],
      orders: {}, keys: {}, charges: {}, captures: {}, lost: [], orderAction: {}, notified: [],
      degraded: false, regionErrors: 0, seq: { order: 0, rival: 0 },
    }),
    initialUI: () => ({
      shopper: { key: 'chk-1', results: null, degraded: false, cart: 0, stage: 'shop', order: null, track: {}, region: 'A', message: '', tone: '', banner: null },
      warehouse: { picks: [] },
    }),
    actions: {
      search(sim) { startSearch(sim); },
      add(sim) { startAdd(sim); },
      place(sim) { startPlace(sim); },
      ship(sim, a) { startShip(sim, a.orderId); },
      rival(sim) { startRival(sim); },
      set: Y.setAction,
    },
    handlers: {
      shopper: {
        push(ctx, p) {
          const u = ctx.ui.shopper;
          if (p.key !== u.key) return { ignored: true };
          u.track = Object.assign({}, u.track, { [p.type]: true });
          u.banner = { title: p.type === 'order.confirmed' ? 'Order confirmed' : 'Shipped', body: `${p.orderId}: Echo Dot`, tone: 'ok', t: ctx.now() };
          ctx.state.notified.push(p.orderId + p.type);
          return { shown: true };
        },
      },
      warehouse: { pick(ctx, p) { const w = ctx.ui.warehouse; if (!w.picks.includes(p.orderId)) w.picks.push(p.orderId); return { listed: true }; } },
      glb: { search: route('search', 1300), add: route('add', 1300), place: route('place', 4800), ship: route('ship', 2800) },
      apiA: regional,
      apiB: regional,
      search: { query() { return { items: [ITEM] }; } },
      cart: { put(ctx, p) { ctx.state.carts.shopper = p.qty; return { qty: p.qty }; } },
      inventory: {
        reserve(ctx, p) {
          const s = ctx.state.stock;
          const held = Object.values(s.holds).filter((h) => h === 'held').length;
          if (s.onHand - held < 1) ctx.fail('SOLD_OUT', 'Nothing available.');
          s.holds[p.orderId] = 'held';
          return { reserved: true };
        },
        check(ctx) { const s = ctx.state.stock; return { available: s.onHand - Object.values(s.holds).filter((h) => h === 'held').length }; },
        decrement(ctx, p) {
          const st = ctx.state;
          if (st.stock.holds[p.orderId] === 'held') st.stock.holds[p.orderId] = 'claimed';
          st.stock.onHand -= 1;
          st.sold.push(p.orderId);
          return { onHand: st.stock.onHand };
        },
        release(ctx, p) { if (ctx.state.stock.holds[p.orderId] === 'held') ctx.state.stock.holds[p.orderId] = 'released'; return { released: true }; },
      },
      orders: {
        place: function* (ctx, p) {
          const st = ctx.state;
          if (st.config.idem && st.keys[p.key]) { const id = st.keys[p.key]; return { orderId: id, status: st.orders[id].status, replayed: true }; }
          const id = 'O' + ++st.seq.order;
          st.orders[id] = { id, key: p.key, status: 'RUNNING' };
          if (st.config.idem) st.keys[p.key] = id;
          if (p.key.startsWith('chk')) st.orderAction[id] = ctx.actionId;
          if (st.config.reserve) {
            const r = yield ctx.call('inventory', 'reserve', { orderId: id }, { timeout: 1500 });
            if (!r.ok) { st.orders[id].status = 'CANCELLED'; ctx.must(r); }
          } else {
            const c = ctx.must(yield ctx.call('inventory', 'check', {}, { timeout: 1500 }));
            if (c.available < 1) { st.orders[id].status = 'CANCELLED'; ctx.fail('SOLD_OUT', 'Nothing available.'); }
          }
          const a = yield ctx.call('payments', 'authorize', { orderId: id, key: 'auth-' + id, amount: ITEM.price }, { timeout: 2500 });
          if (!a.ok) {
            if (st.config.reserve) yield ctx.call('inventory', 'release', { orderId: id }, { timeout: 1000 });
            st.orders[id].status = 'CANCELLED';
            ctx.must(a);
          }
          ctx.must(yield ctx.call('inventory', 'decrement', { orderId: id }, { timeout: 1500 }));
          st.orders[id].status = 'CONFIRMED';
          yield* publish(ctx, 'order.confirmed', id);
          return { orderId: id, status: 'CONFIRMED' };
        },
        ship: function* (ctx, p) {
          const st = ctx.state;
          ctx.must(yield ctx.call('payments', 'capture', { orderId: p.orderId, key: 'cap-' + p.orderId }, { timeout: 2000 }));
          st.orders[p.orderId].status = 'SHIPPED';
          yield* publish(ctx, 'order.shipped', p.orderId);
          return { status: 'SHIPPED' };
        },
      },
      payments: {
        authorize: function* (ctx, p) {
          return ctx.must(yield* ctx.retry({ attempts: 3, baseMs: 150 }, function* () { return yield ctx.call('processor', 'authorize', p, { timeout: 600 }); }));
        },
        capture: function* (ctx, p) { return ctx.must(yield* ctx.retry({ attempts: 3, baseMs: 150 }, function* () { return yield ctx.call('processor', 'capture', p, { timeout: 600 }); })); },
      },
      processor: {
        authorize(ctx, p) {
          const st = ctx.state;
          if (ctx.mode('decline')) ctx.fail('DECLINED', 'The card was declined.');
          if (st.charges[p.key]) return Object.assign({ replayed: true }, st.charges[p.key]);
          st.charges[p.key] = { orderId: p.orderId, amount: p.amount };
          return st.charges[p.key];
        },
        capture(ctx, p) { const st = ctx.state; if (!st.captures[p.key]) st.captures[p.key] = { orderId: p.orderId }; return st.captures[p.key]; },
      },
      events: { publish(ctx, p) { ctx.sim.enqueue('orderEvents', { type: p.type, eventId: p.eventId, payload: p, actionId: ctx.state.orderAction[p.orderId] }); return { appended: true }; } },
    },
    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('outbox', 'relay');
          const r = yield ctx.call('events', 'publish', Object.assign({ eventId: msg.eventId }, msg.payload), { timeout: 600, quiet: true });
          if (!r.ok) { ctx.nack('outbox', 'relay'); yield ctx.wait(400); continue; }
          ctx.ack('outbox', 'relay');
        }
      }, { self: 'orders' });
      Y.consumer(sim, 'orderEvents', 'notifier', 'notifier', function* (ctx, msg) {
        const o = ctx.state.orders[msg.payload.orderId];
        if (o.key.startsWith('chk')) yield ctx.call('shopper', 'push', { type: msg.type, orderId: o.id, key: o.key }, { timeout: 800, actionId: msg.actionId });
        ctx.sim.setLedger(msg.actionId, 'async', 'yes', `${msg.type} delivered to the shopper.`);
        return true;
      }, () => true);
      Y.consumer(sim, 'orderEvents', 'warehouse', 'warehouse', function* (ctx, msg) {
        if (msg.type === 'order.confirmed') yield ctx.call('warehouse', 'pick', { orderId: msg.payload.orderId }, { timeout: 600, quiet: true });
        return true;
      }, () => true);
    },
    consistency(sim) {
      const st = sim.state;
      if (st.regionErrors) return { key: 'wrong', label: `${st.regionErrors} request${st.regionErrors > 1 ? 's' : ''} failed because traffic still went to region A, which is down. Region B was healthy the whole time.` };
      if (st.sold.length > st.units) return { key: 'wrong', label: `Oversold: ${st.sold.length} paid orders for ${st.units} unit. One shopper will get a cancellation email after being charged.` };
      const perKey = {};
      for (const o of Object.values(st.orders)) if (o.status !== 'CANCELLED') perKey[o.key] = (perKey[o.key] || 0) + 1;
      const many = Object.entries(perKey).find(([, n]) => n > 1);
      if (many) return { key: 'wrong', label: `Checkout ${many[0]} produced ${many[1]} orders and ${many[1]} card charges for one item.` };
      if (st.lost.length) return { key: 'wrong', label: `${st.lost[0]} was lost. The shopper was charged, but the warehouse will never ship the order.` };
      if (st.degraded && sim.nodes.search.modes.down) return { key: 'stale', label: 'Search is down; shoppers see a cached best-seller list instead of results.' };
      const pending = sim.queueStats('outbox').depth + sim.queueStats('orderEvents').depth;
      const mine = Object.values(st.orders).find((o) => o.key === sim.ui.shopper.key && o.status === 'CONFIRMED');
      if (pending || (mine && !st.notified.includes(mine.id + 'order.confirmed'))) return { key: 'stale', label: `The order is confirmed, but ${pending} event${pending === 1 ? ' is' : 's are'} still on the way: the shopper${mine && !st.notified.includes(mine.id + 'order.confirmed') ? ' has not been told yet' : ' will hear shortly'}.` };
      return { key: 'ok', label: 'One order per checkout, no unit sold twice, every event delivered.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const ok = sim.ledger.filter((e) => e.layers.displayed === 'yes').length;
      const bad = sim.ledger.filter((e) => e.layers.displayed === 'no').length;
      return [
        { label: 'Serving region', value: region(sim) },
        { label: 'Stock on hand', value: st.stock.onHand, tone: st.stock.onHand < 0 ? 'fail' : '' },
        { label: 'Orders confirmed', value: Object.values(st.orders).filter((o) => o.status === 'CONFIRMED' || o.status === 'SHIPPED').length },
        { label: 'Card charges', value: Object.keys(st.charges).length },
        { label: 'Events waiting', value: sim.queueStats('outbox').depth + sim.queueStats('orderEvents').depth },
        { label: 'Actions that worked / failed', value: `${ok} / ${bad}`, tone: bad ? 'warn' : '' },
        { label: 'Retries', value: sim.retries },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['shopper', 'Shopper phone']], { side: '<div data-ref="console"></div>' });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.shopper;
        const results = u.results
          ? u.results.map((it) => `<div class="yt-card"><div class="yt-thumb" style="--h:${it.sku === 'kindle' ? 30 : 200}"><span aria-hidden="true">◉</span></div><div><strong>${esc(it.title)}</strong><p class="app-price">$${it.price}</p>${it.sku === ITEM.sku ? '<p class="app-sub">✓ In stock: only a few left</p>' : ''}</div></div>`).join('') + (u.results.some((it) => it.sku === ITEM.sku) ? Y.btn('add', u.cart ? 'In your cart ✓' : 'Add to cart', { cls: 'secondary', disabled: !!u.cart }) : '')
          : '<p class="app-sub">Try searching for “echo dot”.</p>';
        const t = u.track;
        let order = '';
        if (u.cart && u.stage !== 'placed') order = `<div class="app-card"><span class="app-kv"><span>Cart</span><span>${u.cart} item, $${ITEM.price}</span></span></div>${u.stage === 'placing' ? '<div class="app-card is-work"><strong><span class="spinner"></span>Placing your order…</strong></div>' : Y.btn('place', 'Place your order', { cls: 'go' })}`;
        if (u.stage === 'placed') order = `<div class="app-card is-ok"><strong>✓ Order ${esc(u.order)}</strong><div class="app-steps" aria-hidden="true"><span class="done"></span><span class="${t['order.confirmed'] ? 'done' : ''}"></span><span class="${t['order.shipped'] ? 'done' : ''}"></span></div>
          <span class="app-sub">✓ Placed · ${t['order.confirmed'] ? '✓' : '○'} Confirmation sent · ${t['order.shipped'] ? '✓' : '○'} Shipped</span></div>`;
        Y.paint(el, sim, 'shopper', {
          head: `<div><p class="app-title">Amazon</p><p class="app-sub">Served by region ${region(sim)}</p></div>`,
          search: Y.btn('search', 'Search “echo dot”'),
          results, order, msg: Y.msg(u.message, u.tone),
        }, {}, u.banner);
        const w = sim.ui.warehouse;
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="console"]'), {
          title: '<p class="ops-title">Warehouse console</p>',
          picks: `<div class="ops-shards">${w.picks.map((id) => {
            const o = st.orders[id];
            return `<div class="ops-row" data-tone="${o.status === 'SHIPPED' ? '' : 'warn'}"><div class="ops-name">${esc(id)}<span>${o.status === 'SHIPPED' ? 'shipped ✓' : 'to pick and pack'}</span></div>${o.status === 'CONFIRMED' ? Y.btn('ship', `Ship ${id}`, { arg: { orderId: id } }) : ''}</div>`;
          }).join('') || '<p class="app-sub">No orders to ship yet. Confirmed orders appear here when their event arrives.</p>'}</div>`,
          stock: `<div class="app-card"><span class="app-kv"><span>Echo Dot on hand</span><span>${st.stock.onHand}</span></span><span class="app-kv"><span>Reserved</span><span>${Object.values(st.stock.holds).filter((h) => h === 'held').length}</span></span></div>`,
          other: `<p class="app-sub">Somewhere else, another shopper wants the same item:</p>${Y.btn('rival', 'Another shopper checks out', { cls: 'secondary' })}`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        });
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
