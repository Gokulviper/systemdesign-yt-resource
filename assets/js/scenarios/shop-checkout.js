/*
 * Checkout and order saga.
 * Placing an order is a sequence of steps owned by different services: quote
 * tax, create the order (unique per idempotency key), reserve stock, authorise
 * the card, confirm. The order service orchestrates them as a saga: each
 * completed step is written to the orders database so a restarted service can
 * resume, and a failed step runs compensations (release stock). Confirmation
 * writes the order status and its event in one transaction (the outbox); a
 * relay publishes events to the broker. The warehouse ships and captures the
 * payment; the email worker tells the shopper.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const PRICE = 49.99;
  const STEPS = ['reserve', 'authorize', 'confirm'];
  const STEP_LABEL = { reserve: 'Stock reserved', authorize: 'Card authorised', confirm: 'Confirmed', ship: 'Shipped' };

  /* ---------- the saga, used both for new orders and for recovery ---------- */
  function* runSaga(ctx, orderId) {
    const st = ctx.state;
    st.live[orderId] = true;
    const done = st.config.persist ? ctx.must(yield ctx.call('ordersdb', 'sagaGet', { orderId }, { timeout: 800 })).steps : (st.mem[orderId] = st.mem[orderId] || []);
    for (const step of STEPS) {
      if (done.includes(step)) continue;
      if (step === 'reserve') {
        const r = yield ctx.call('inventory', 'reserve', { orderId }, { timeout: 900 });
        if (!r.ok) { yield* cancel(ctx, orderId, r.error.code === 'SOLD_OUT' ? 'sold out' : r.error.code, false); ctx.must(r); }
      }
      if (step === 'authorize') {
        const r = yield ctx.call('payments', 'authorize', { orderId, key: 'auth-' + orderId, amount: st.orders[orderId].total }, { timeout: 1200 });
        if (!r.ok) { yield* cancel(ctx, orderId, r.error.code === 'DECLINED' ? 'card declined' : r.error.code, true); ctx.must(r); }
        if (ctx.mode('crash')) {
          // The process dies here: the card is authorised, the order is not confirmed.
          st.live[orderId] = false;
          st.mem[orderId] = [];
          ctx.sim.restore('orders', 'crash');
          ctx.sim.inject('orders', 'crashed', null, 1200);
          ctx.log({ op: `crashed while running ${orderId}`, status: 'fault', detail: 'The card was authorised, but the confirm step never ran. Whatever the process held in memory is gone.' });
          ctx.fail('UNAVAILABLE', 'The order service crashed mid-checkout.');
        }
      }
      if (step === 'confirm') {
        ctx.must(yield ctx.call('ordersdb', 'confirm', { orderId, outbox: st.config.outbox }, { timeout: 900 }));
        if (!st.config.outbox) yield* publishDirect(ctx, { type: 'order.confirmed', orderId });
      }
      yield* record(ctx, orderId, step, done);
    }
    st.live[orderId] = false;
    return { orderId, status: st.orders[orderId].status };
  }
  function* record(ctx, orderId, step, done) {
    if (ctx.state.config.persist) ctx.must(yield ctx.call('ordersdb', 'step', { orderId, step }, { timeout: 800, quiet: true }));
    else done.push(step);
  }
  function* cancel(ctx, orderId, why, reserved) {
    const st = ctx.state;
    if (reserved && st.config.compensate) {
      yield ctx.call('inventory', 'release', { orderId }, { timeout: 900 });
      ctx.log({ op: `compensation: released stock for ${orderId}`, status: 'ok', detail: 'The reservation is undone because a later step failed.' });
    }
    yield ctx.call('ordersdb', 'cancel', { orderId, why }, { timeout: 900 });
    st.live[orderId] = false;
  }
  /** Dual write: the order is already committed; this publish can fail on its own. */
  function* publishDirect(ctx, ev) {
    const st = ctx.state;
    const eventId = `ev-${ev.type}-${ev.orderId}`;
    const r = yield ctx.call('events', 'publish', Object.assign({ eventId }, ev), { timeout: 600 });
    if (!r.ok) {
      st.lost.push(eventId);
      ctx.log({ op: `${ev.type} for ${ev.orderId} lost`, status: 'err', error: r.error, detail: 'The database commit succeeded but the publish failed. Nothing records that this event still needs sending.' });
    }
  }

  function newSession(sim) {
    const st = sim.state;
    const key = 'chk-' + ++st.seq.session;
    Object.assign(sim.ui.shopper, { key, stage: 'cart', order: null, track: {}, message: '', tone: '' });
  }

  function startPlace(sim, label) {
    const u = sim.ui.shopper;
    if (u.stage === 'placed') return;
    const key = u.key;
    sim.startAction(label || 'Shopper: place your order', function* (ctx) {
      const v = ctx.ui.shopper;
      v.stage = 'placing';
      Y.L(ctx, { displayed: ['pending', 'Shows “Placing your order…”.'], retrySafe: ctx.state.config.idem ? ['yes', `Every attempt carries idempotency key ${key}.`] : ['no', 'No idempotency key: every request is a new order.'] });
      const r = yield ctx.call('gateway', 'place', { key }, { timeout: 4500 });
      ctx.recordOutcome(r.ok, r.latency);
      if (v.key !== key) return;
      if (r.ok) {
        ctx.state.orderAction[r.value.orderId] = ctx.state.orderAction[r.value.orderId] || ctx.actionId;
        const confirmed = r.value.status === 'CONFIRMED' || r.value.status === 'SHIPPED';
        Object.assign(v, { stage: 'placed', order: r.value.orderId, message: r.value.replayed ? `Same order ${r.value.orderId}: this tap was recognised as a repeat.` : `Order ${r.value.orderId} placed. We’ll email you when it ships.`, tone: 'ok' });
        v.track = Object.assign({}, v.track, { reserve: true, authorize: confirmed, confirm: confirmed });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: r.value.replayed ? ['yes', 'The key already had an order; nothing new was created.'] : ['yes', ctx.state.config.outbox ? 'Order CONFIRMED and its event in the outbox, in one transaction.' : 'Order CONFIRMED; the event was published separately.'], async: r.value.replayed ? 'n/a' : ['pending', 'Warehouse and email are driven by the event.'] });
        ctx.explain(r.value.replayed
          ? 'The second tap carried the same idempotency key. The orders table has a unique index on it, so the order service found the existing order and returned it instead of starting another saga.'
          : `The saga ran tax, reserve, authorise, confirm. ${ctx.state.config.outbox ? 'The confirm step wrote the order status and the order.confirmed event in one transaction; the relay will publish it even if the broker is briefly down.' : 'The confirm step committed, then published the event in a separate call: a dual write.'}`);
      } else {
        const code = r.error.code;
        const msg = { DECLINED: 'Your card was declined. Nothing was charged; try another card.', SOLD_OUT: 'This item sold out. You weren’t charged.', TAX_UNAVAILABLE: 'We couldn’t calculate tax right now. Nothing was charged; please try again.' }[code] || 'Something went wrong. Check “Your orders” before trying again.';
        Object.assign(v, { stage: 'failed', message: msg, tone: 'fail' });
        Y.failed(ctx, 'Shows an error.');
        ctx.explain({
          DECLINED: ctx.state.config.compensate ? 'The authorise step failed, so the saga ran its compensation: the stock reserved in the previous step was released, and the order was cancelled.' : 'The authorise step failed and the order was cancelled, but no compensation ran. The unit reserved for this order stays reserved forever.',
          TAX_UNAVAILABLE: 'Tax is quoted before any step with side effects. The tax service was down, so the checkout failed closed: no order, no reservation, no authorisation.',
        }[code] || (ctx.state.config.persist
          ? 'The order service crashed after authorising the card. The saga log in the orders database says which steps finished, so when the service restarts the recovery job resumes the saga from the confirm step.'
          : 'The order service crashed after authorising the card. The saga’s progress lived only in memory, so nothing knows whether the card was authorised: the order is stuck in RUNNING with money held.'));
      }
    }, { self: 'shopper' });
  }

  const sc = (SDL.scenarios['shop-checkout'] = {
    id: 'shop-checkout',
    seed: 421,
    productWidth: 560,
    intro: 'Tap “Place your order” and follow the saga: tax, reserve, authorise, confirm, then the warehouse ships and captures. Then double-tap, decline the card, or crash the order service mid-checkout.',
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'shopper', label: 'Shopper', sub: 'Checkout page', kind: 'client', x: 90, y: 70, latency: 1, role: 'Places orders with an idempotency key per checkout session.', ops: [{ name: 'push', desc: 'Receive an email or push.' }], owns: ['What the shopper sees'] },
        { id: 'gateway', label: 'API gateway', sub: 'Store API', kind: 'gateway', x: 300, y: 70, latency: 2, role: 'Forwards checkout calls.', ops: [{ name: 'place', desc: 'Place an order.' }], owns: ['Nothing durable'] },
        { id: 'orders', label: 'Order service', sub: 'Saga orchestrator', kind: 'service', x: 520, y: 70, latency: 4, role: 'Runs the checkout saga, records each finished step, runs compensations, and resumes interrupted sagas after a restart.', ops: [{ name: 'place', desc: 'Start or replay an order.' }], owns: ['Saga logic'] },
        { id: 'payments', label: 'Payment service', sub: 'Authorise, capture', kind: 'service', x: 760, y: 70, latency: 40, role: 'Authorises at checkout and captures at shipment, each with an idempotency key.', ops: [{ name: 'authorize', desc: 'Hold the amount on the card.' }, { name: 'capture', desc: 'Take the money.' }], owns: ['Authorisations', 'Captures'] },
        { id: 'tax', label: 'Tax service', sub: 'Quotes', kind: 'service', x: 300, y: 210, latency: 6, role: 'Quotes tax for the cart. Read-only, so it runs first.', ops: [{ name: 'quote', desc: 'Quote tax.' }], owns: ['Tax rules'] },
        { id: 'inventory', label: 'Inventory service', sub: 'Reservations', kind: 'service', x: 760, y: 210, latency: 5, role: 'Reserves and releases stock per order (see the inventory lab).', ops: [{ name: 'reserve', desc: 'Reserve for an order.' }, { name: 'release', desc: 'Compensation: undo a reservation.' }], owns: ['Reservations'] },
        { id: 'ordersdb', label: 'Orders DB', sub: 'Orders, saga log, outbox', kind: 'db', x: 520, y: 350, latency: 8, role: 'Orders with a unique idempotency key, the saga log, and the outbox table, all in one database.', ops: [{ name: 'create', desc: 'Create an order (unique key).' }, { name: 'step', desc: 'Record a finished saga step.' }, { name: 'confirm', desc: 'Confirm, writing the event to the outbox.' }, { name: 'ship', desc: 'Mark shipped.' }], owns: ['orders', 'saga_log', 'outbox'] },
        { id: 'relay', label: 'Outbox relay', sub: 'Polls the outbox', kind: 'worker', x: 760, y: 350, latency: 3, role: 'Publishes outbox rows to the broker and retries until the broker accepts them.', ops: [{ name: 'run', desc: 'Publish pending events.' }], owns: ['Nothing durable'] },
        { id: 'events', label: 'Order events', sub: 'Broker', kind: 'queue', x: 1000, y: 350, latency: 4, queue: 'orderEvents', role: 'order.confirmed and order.shipped, delivered at least once.', ops: [{ name: 'publish', desc: 'Append an event.' }], owns: ['order event log'] },
        { id: 'email', label: 'Email worker', sub: 'Consumer', kind: 'worker', x: 520, y: 490, latency: 4, role: 'Emails the shopper on confirmation and shipment.', ops: [{ name: 'consume', desc: 'Send an email.' }], owns: ['Sent emails'] },
        { id: 'warehouse', label: 'Warehouse', sub: 'Fulfilment consumer', kind: 'worker', x: 1000, y: 490, latency: 4, role: 'Picks, packs, and ships confirmed orders, then captures the payment.', ops: [{ name: 'consume', desc: 'Ship an order.' }], owns: ['Shipments'] },
      ],
      edges: [
        { from: 'shopper', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'orders', latency: 4 },
        { from: 'orders', to: 'tax', latency: 4 },
        { from: 'orders', to: 'payments', latency: 25 },
        { from: 'orders', to: 'inventory', latency: 4 },
        { from: 'orders', to: 'ordersdb', latency: 4 },
        { from: 'orders', to: 'events', latency: 6, label: 'dual write', via: [[880, 140]] },
        { from: 'ordersdb', to: 'relay', latency: 4, label: 'outbox' },
        { from: 'relay', to: 'events', latency: 4 },
        { from: 'events', to: 'warehouse', latency: 4 },
        { from: 'events', to: 'email', latency: 4 },
        { from: 'warehouse', to: 'ordersdb', latency: 5, label: 'mark shipped' },
        { from: 'warehouse', to: 'payments', latency: 25, label: 'capture', via: [[1100, 490], [1100, 70]] },
        { from: 'email', to: 'shopper', latency: 40, label: 'email', via: [[90, 490]] },
      ],
      queues: [
        { id: 'outbox', broker: 'ordersdb', label: 'outbox', groups: ['relay'] },
        { id: 'orderEvents', broker: 'events', label: 'order-events', groups: ['warehouse', 'email'] },
      ],
    },
    modeLabels: { crash: 'Will crash mid-checkout', decline: 'Declining cards' },
    failures: [
      { id: 'decline', node: 'payments', mode: 'decline', label: 'Card declined', desc: 'The authorise step fails after stock was reserved.' },
      { id: 'crash', node: 'orders', mode: 'crash', label: 'Order service crashes mid-saga', desc: 'The next order dies after the card is authorised.' },
      { id: 'tax-down', node: 'tax', mode: 'down', label: 'Tax service unavailable', desc: 'No quote, no order.' },
      { id: 'broker-down', node: 'events', mode: 'down', label: 'Broker unavailable', desc: 'Events cannot be published.' },
      { id: 'dup', node: 'events', mode: 'duplicate', label: 'Broker delivers twice', desc: 'Every event reaches consumers twice.' },
      { id: 'relay-paused', node: 'relay', mode: 'paused', label: 'Outbox relay paused', desc: 'Orders confirm; nothing is published.' },
      { id: 'warehouse-down', node: 'warehouse', mode: 'down', label: 'Warehouse consumer down', desc: 'Orders wait to ship.' },
      { id: 'reply-lost', node: 'gateway', mode: 'dropResponse', label: 'Checkout reply lost', desc: 'The order is placed but the phone never hears back.' },
      { id: 'inv-down', node: 'inventory', mode: 'down', label: 'Inventory unavailable', desc: 'Reservations fail; the saga stops before payment.' },
    ],
    switches: Y.switches([
      ['idem', 'Idempotency key on place order', 'A unique key per checkout session. Off: every tap or retry creates a new order.'],
      ['persist', 'Persist saga progress', 'Record each finished step in the orders database. Off: progress lives in the service’s memory.'],
      ['compensate', 'Run compensations', 'When a step fails, undo the earlier ones (release the stock). Off: just cancel the order.'],
      ['outbox', 'Transactional outbox', 'Write the event with the order in one transaction. Off: commit, then publish separately.'],
      ['dedupe', 'Consumers skip duplicate events', 'Warehouse and email remember event IDs. Off: a redelivered event is acted on again.'],
    ]),
    presets: Y.presets({ idem: true, persist: true, compensate: true, outbox: true, dedupe: true }, [
      { id: 'happy', label: 'Place an order', desc: 'Tax, reserve, authorise, confirm; the warehouse ships and captures; two emails.', run: (s) => startPlace(s) },
      { id: 'double', label: 'Double tap, one key', desc: 'Two requests 60 ms apart with the same key: one order.', run: (s) => { startPlace(s, 'Shopper: place order (tap 1)'); s.schedule(60, () => startPlace(s, 'Shopper: place order (tap 2)')); } },
      { id: 'double-bad', label: 'Double tap, no key', desc: 'Two orders, two authorisations, two parcels.', sw: { idem: false }, run: (s) => { startPlace(s, 'Shopper: place order (tap 1)'); s.schedule(60, () => startPlace(s, 'Shopper: place order (tap 2)')); } },
      { id: 'decline', label: 'Card declined, compensated', desc: 'The stock reserved a moment earlier is released.', run: (s) => { s.inject('payments', 'decline'); startPlace(s); } },
      { id: 'decline-bad', label: 'Card declined, no compensation', desc: 'The order is cancelled but its unit stays reserved forever.', sw: { compensate: false }, run: (s) => { s.inject('payments', 'decline'); startPlace(s); } },
      { id: 'crash', label: 'Crash mid-saga, resumed', desc: 'The service dies after authorising. On restart, the saga log says “authorised”, so recovery confirms the order.', run: (s) => { s.inject('orders', 'crash'); startPlace(s); } },
      { id: 'crash-bad', label: 'Crash mid-saga, progress in memory', desc: 'Nothing remembers how far the saga got: money held, order stuck.', sw: { persist: false }, run: (s) => { s.inject('orders', 'crash'); startPlace(s); } },
      { id: 'tax-down', label: 'Tax service down', desc: 'The first step fails before any side effect: no order, nothing to undo.', run: (s) => { s.inject('tax', 'down'); startPlace(s); } },
      { id: 'dual', label: 'Broker down, dual write', desc: 'The order commits, the publish fails, the event is gone: it never ships.', sw: { outbox: false }, run: (s) => { s.inject('events', 'down', null, 2000); startPlace(s); } },
      { id: 'outbox', label: 'Broker down, outbox', desc: 'The event waits in the outbox and is published when the broker returns.', run: (s) => { s.inject('events', 'down', null, 2000); startPlace(s); } },
      { id: 'dup', label: 'Duplicate delivery, deduplicated', desc: 'Every event arrives twice; each consumer acts once.', run: (s) => { s.inject('events', 'duplicate'); startPlace(s); } },
      { id: 'dup-bad', label: 'Duplicate delivery, no dedupe', desc: 'Two parcels and two emails. The capture is safe only because it has its own key.', sw: { dedupe: false }, run: (s) => { s.inject('events', 'duplicate'); startPlace(s); } },
    ]),
    initialState: () => ({
      config: { idem: true, persist: true, compensate: true, outbox: true, dedupe: true },
      orders: {}, keys: {}, sagaLog: {}, mem: {}, live: {}, recovering: {}, orphaned: {},
      reservations: {}, stock: 5, auths: {}, captures: {}, shipments: {}, emails: [], lost: [], orderAction: {},
      seq: { order: 0, session: 1 },
    }),
    initialUI: () => ({ shopper: { key: 'chk-1', stage: 'cart', order: null, track: {}, message: '', tone: '', banner: null } }),
    actions: {
      place(sim) { startPlace(sim); },
      newCheckout(sim) { newSession(sim); },
      set: Y.setAction,
    },
    handlers: {
      shopper: {
        push(ctx, p) {
          const u = ctx.ui.shopper;
          if (p.key !== u.key) return { ignored: true };
          if (p.type === 'order.confirmed') {
            if (u.stage !== 'placed') Object.assign(u, { stage: 'placed', order: p.orderId, message: `Good news: order ${p.orderId} is confirmed, even though checkout showed an error.`, tone: 'ok' });
            u.track = Object.assign({}, u.track, { reserve: true, authorize: true, confirm: true });
            u.banner = { title: 'Order confirmed', body: `${p.orderId}: Echo Dot, arriving Thursday`, tone: 'ok', t: ctx.now() };
          }
          if (p.type === 'order.shipped') {
            u.track = Object.assign({}, u.track, { ship: true });
            u.message = `${p.orderId} has shipped.`;
            u.banner = { title: 'Shipped', body: `${p.orderId} is on its way`, tone: 'ok', t: ctx.now() };
          }
          return { shown: p.type };
        },
      },
      gateway: { place: function* (ctx, p) { return ctx.must(yield ctx.call('orders', 'place', p, { timeout: 4200 })); } },
      orders: {
        place: function* (ctx, p) {
          const st = ctx.state;
          const q = yield ctx.call('tax', 'quote', { subtotal: PRICE }, { timeout: 600 });
          if (!q.ok) ctx.fail('TAX_UNAVAILABLE', 'Tax could not be quoted.');
          const o = ctx.must(yield ctx.call('ordersdb', 'create', { key: p.key, unique: st.config.idem, total: q.value.total }, { timeout: 800 }));
          if (o.replayed) return { orderId: o.orderId, status: o.status, replayed: true };
          st.orderAction[o.orderId] = ctx.actionId;
          return yield* runSaga(ctx, o.orderId);
        },
      },
      tax: { quote(ctx, p) { const tax = Math.round(p.subtotal * 0.08 * 100) / 100; return { tax, total: Math.round((p.subtotal + tax) * 100) / 100 }; } },
      inventory: {
        reserve(ctx, p) {
          const st = ctx.state;
          if (st.reservations[p.orderId]) return { reserved: true, replayed: true };
          const held = Object.values(st.reservations).filter((r) => r === 'held').length;
          if (held >= st.stock) ctx.fail('SOLD_OUT', 'No stock left.');
          st.reservations[p.orderId] = 'held';
          return { reserved: true };
        },
        release(ctx, p) { if (ctx.state.reservations[p.orderId] === 'held') ctx.state.reservations[p.orderId] = 'released'; return { released: true }; },
      },
      payments: {
        authorize(ctx, p) {
          const st = ctx.state;
          if (ctx.mode('decline')) ctx.fail('DECLINED', 'The card was declined.');
          if (st.auths[p.key]) return Object.assign({ replayed: true }, st.auths[p.key]);
          st.auths[p.key] = { orderId: p.orderId, amount: p.amount, status: 'authorized' };
          return st.auths[p.key];
        },
        capture(ctx, p) {
          const st = ctx.state;
          if (st.captures[p.key]) return Object.assign({ replayed: true }, st.captures[p.key]);
          const a = st.auths['auth-' + p.orderId];
          if (!a) ctx.fail('NO_AUTH', 'Nothing to capture.');
          a.status = 'captured';
          st.captures[p.key] = { orderId: p.orderId, amount: a.amount };
          return st.captures[p.key];
        },
      },
      ordersdb: {
        create(ctx, p) {
          const st = ctx.state;
          if (p.unique && st.keys[p.key]) { const id = st.keys[p.key]; return { orderId: id, status: st.orders[id].status, replayed: true }; }
          const id = 'O' + ++st.seq.order;
          st.orders[id] = { id, key: p.key, status: 'RUNNING', total: p.total, why: '' };
          st.sagaLog[id] = [];
          if (p.unique) st.keys[p.key] = id;
          ctx.ledger('committed', 'pending', `Order ${id} created as RUNNING.`);
          return { orderId: id, status: 'RUNNING' };
        },
        step(ctx, p) { ctx.state.sagaLog[p.orderId].push(p.step); return { steps: ctx.state.sagaLog[p.orderId] }; },
        sagaGet(ctx, p) { return { steps: ctx.state.sagaLog[p.orderId].slice() }; },
        confirm(ctx, p) {
          const st = ctx.state;
          st.orders[p.orderId].status = 'CONFIRMED';
          if (p.outbox) ctx.sim.enqueue('outbox', { type: 'order.confirmed', eventId: `ev-order.confirmed-${p.orderId}`, payload: { type: 'order.confirmed', orderId: p.orderId }, actionId: ctx.actionId });
          return { status: 'CONFIRMED' };
        },
        cancel(ctx, p) { const o = ctx.state.orders[p.orderId]; o.status = 'CANCELLED'; o.why = p.why; return { status: 'CANCELLED' }; },
        ship(ctx, p) {
          const st = ctx.state;
          st.orders[p.orderId].status = 'SHIPPED';
          if (st.reservations[p.orderId] === 'held') st.reservations[p.orderId] = 'shipped';
          if (p.outbox) ctx.sim.enqueue('outbox', { type: 'order.shipped', eventId: `ev-order.shipped-${p.orderId}`, payload: { type: 'order.shipped', orderId: p.orderId }, actionId: st.orderAction[p.orderId] });
          return { status: 'SHIPPED' };
        },
      },
      events: { publish(ctx, p) { ctx.sim.enqueue('orderEvents', { type: p.type, eventId: p.eventId, payload: p, actionId: ctx.state.orderAction[p.orderId] }); return { appended: true }; } },
    },
    setup(sim) {
      // Outbox relay: publish each row, and keep retrying while the broker is down.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('outbox', 'relay');
          const r = yield ctx.call('events', 'publish', Object.assign({ eventId: msg.eventId }, msg.payload), { timeout: 600 });
          if (!r.ok) { ctx.log({ op: `${msg.eventId} not published yet`, status: 'retry', error: r.error, detail: 'The row stays in the outbox; the relay tries again.' }); ctx.nack('outbox', 'relay'); yield ctx.wait(400); continue; }
          ctx.ack('outbox', 'relay');
        }
      }, { self: 'relay' });
      const dedupe = (s) => s.state.config.dedupe;
      Y.consumer(sim, 'orderEvents', 'warehouse', 'warehouse', function* (ctx, msg) {
        const st = ctx.state;
        const id = msg.payload.orderId;
        if (msg.type !== 'order.confirmed') return true;
        yield ctx.wait(500); // pick and pack
        st.shipments[id] = (st.shipments[id] || 0) + 1;
        ctx.log({ op: `parcel ${st.shipments[id]} for ${id} shipped`, status: st.shipments[id] > 1 ? 'dup' : 'ok', actionId: msg.actionId, detail: st.shipments[id] > 1 ? 'A second parcel for the same order.' : 'Picked, packed, and handed to the carrier.' });
        const c = yield ctx.call('payments', 'capture', { orderId: id, key: 'cap-' + id }, { timeout: 1200 });
        if (c.ok && c.value.replayed) ctx.log({ op: `capture for ${id} replayed`, status: 'dup', detail: 'The capture key matched, so the card was not charged again.' });
        ctx.must(yield ctx.call('ordersdb', 'ship', { orderId: id, outbox: st.config.outbox }, { timeout: 900 }));
        if (!st.config.outbox) yield* publishDirect(ctx, { type: 'order.shipped', orderId: id });
        ctx.sim.setLedger(msg.actionId, 'async', 'yes', 'Shipped and captured.');
        return true;
      }, dedupe);
      Y.consumer(sim, 'orderEvents', 'email', 'email', function* (ctx, msg) {
        const st = ctx.state;
        const id = msg.payload.orderId;
        st.emails.push({ orderId: id, type: msg.type });
        yield ctx.call('shopper', 'push', { type: msg.type, orderId: id, key: st.orders[id].key }, { timeout: 800, actionId: msg.actionId });
        return true;
      }, dedupe);
      // Recovery: resume sagas that were running when the order service died.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(600);
          const st = ctx.state;
          if (ctx.sim.nodes.orders.modes.crashed) continue;
          for (const o of Object.values(st.orders)) {
            if (o.status !== 'RUNNING' || st.live[o.id] || st.recovering[o.id]) continue;
            if (!st.config.persist) {
              if (!st.orphaned[o.id]) { st.orphaned[o.id] = true; ctx.log({ op: `${o.id} cannot be recovered`, status: 'err', detail: 'The order is RUNNING but there is no saga log. Recovery cannot tell whether stock was reserved or the card authorised, so it leaves the order alone.' }); }
              continue;
            }
            st.recovering[o.id] = true;
            ctx.log({ op: `resuming ${o.id}`, status: 'recovered', actionId: st.orderAction[o.id], detail: `The saga log says: ${st.sagaLog[o.id].join(', ') || 'nothing'} done. Continuing from there.` });
            ctx.spawn(function* (c) {
              const r = yield* runSaga(c, o.id);
              c.sim.setLedger(st.orderAction[o.id], 'committed', 'yes', `Recovered: ${o.id} is ${r.status}.`);
            }, { actionId: st.orderAction[o.id] });
          }
        }
      }, { self: 'orders', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const orders = Object.values(st.orders);
      const perKey = {};
      for (const o of orders) perKey[o.key] = (perKey[o.key] || 0) + 1;
      const many = Object.entries(perKey).find(([, n]) => n > 1);
      if (many) return { key: 'wrong', label: `Checkout ${many[0]} produced ${many[1]} orders. The shopper wanted one item and pays ${many[1]} times.` };
      const stuck = orders.find((o) => o.status === 'RUNNING' && st.orphaned[o.id] && st.auths['auth-' + o.id]);
      if (stuck) return { key: 'wrong', label: `$${st.auths['auth-' + stuck.id].amount} is authorised on the card for ${stuck.id}, but the order is stuck in RUNNING. Nobody will confirm or cancel it.` };
      const leaked = orders.find((o) => o.status === 'CANCELLED' && st.reservations[o.id] === 'held');
      if (leaked) return { key: 'wrong', label: `${leaked.id} was cancelled (${leaked.why}) but its unit is still reserved. That stock can never be sold.` };
      if (st.lost.length) return { key: 'wrong', label: `${st.lost[0]} was lost by a dual write. The order is confirmed, but the warehouse will never hear about it.` };
      const twice = Object.entries(st.shipments).find(([, n]) => n > 1);
      if (twice) return { key: 'wrong', label: `${twice[0]} was shipped ${twice[1]} times. The capture had its own key, so the card was charged once, but two parcels left the warehouse.` };
      const seen = {};
      for (const e of st.emails) { const k = e.orderId + e.type; if (seen[k]) return { key: 'wrong', label: `The shopper got the ${e.type} email for ${e.orderId} twice.` }; seen[k] = true; }
      const pending = sim.queueStats('outbox').depth + sim.queueStats('orderEvents').depth;
      const running = orders.filter((o) => o.status === 'RUNNING').length;
      const unshipped = orders.filter((o) => o.status === 'CONFIRMED').length;
      if (pending || running || unshipped) return { key: 'stale', label: `Still flowing: ${running} order${running === 1 ? '' : 's'} running, ${unshipped} confirmed and waiting to ship, ${pending} event${pending === 1 ? '' : 's'} not yet delivered.` };
      return { key: 'ok', label: orders.length ? 'Every checkout made at most one order, and stock, money, parcels, and emails all match its status.' : 'No order was created and nothing was reserved or charged.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const orders = Object.values(st.orders);
      const by = (s) => orders.filter((o) => o.status === s).length;
      const held = Object.values(st.auths).filter((a) => a.status === 'authorized').length;
      return [
        { label: 'Orders', value: orders.length, tone: orders.length > Object.keys(st.keys).length && st.config.idem ? 'fail' : '' },
        { label: 'Running / confirmed / shipped', value: `${by('RUNNING')} / ${by('CONFIRMED')} / ${by('SHIPPED')}` },
        { label: 'Cancelled', value: by('CANCELLED') },
        { label: 'Units reserved', value: Object.values(st.reservations).filter((r) => r === 'held').length },
        { label: 'Authorised, not yet captured', value: held },
        { label: 'Captured', value: Object.keys(st.captures).length },
        { label: 'Outbox rows waiting', value: sim.queueStats('outbox').depth, tone: sim.queueStats('outbox').depth ? 'warn' : '' },
        { label: 'Events lost', value: st.lost.length, tone: st.lost.length ? 'fail' : 'ok' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['shopper', 'Shopper phone']], {
          note: 'The phone is the checkout page. The console shows each order’s saga as the orders database records it.',
          below: '<div class="ops-console" data-ref="console"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.shopper;
        const total = Math.round(PRICE * 1.08 * 100) / 100;
        const cart = `<div class="yt-card"><div class="yt-thumb" style="--h:200"><span aria-hidden="true">◉</span></div><div><strong>Echo Dot (5th gen)</strong><p class="app-sub">Qty 1, free delivery Thursday</p></div></div>
          <div class="app-card"><span class="app-kv"><span>Items</span><span>$${PRICE}</span></span><span class="app-kv"><span>Estimated tax</span><span>$${(total - PRICE).toFixed(2)}</span></span><span class="app-kv"><span><strong>Order total</strong></span><span><strong>$${total}</strong></span></span><span class="app-kv"><span>Checkout session</span><span>${esc(u.key)}</span></span></div>`;
        let stage = '';
        if (u.stage === 'cart') stage = Y.btn('place', 'Place your order', { cls: 'go' });
        if (u.stage === 'placing') stage = '<div class="app-card is-work"><strong><span class="spinner"></span>Placing your order…</strong></div>';
        if (u.stage === 'placed' || u.stage === 'failed') {
          const steps = ['reserve', 'authorize', 'confirm', 'ship'];
          const t = u.track || {};
          stage = u.stage === 'placed'
            ? `<div class="app-card is-ok"><strong>✓ Order ${esc(u.order)}</strong><div class="app-steps" aria-hidden="true">${steps.map((s) => `<span class="${t[s] ? 'done' : ''}"></span>`).join('')}</div>
               <span class="app-sub">${steps.map((s) => `${t[s] ? '✓' : '○'} ${STEP_LABEL[s]}`).join(' · ')}</span></div>${Y.btn('newCheckout', 'Start a new checkout', { cls: 'secondary' })}`
            : `<div class="app-card is-fail"><strong>✕ Order not placed</strong></div><div class="app-row">${Y.btn('place', 'Try again')}${Y.btn('newCheckout', 'New checkout', { cls: 'secondary' })}</div>`;
        }
        Y.paint(el, sim, 'shopper', { head: '<div><p class="app-title">Amazon</p><p class="app-sub">Checkout (1 item)</p></div>', cart, stage, msg: Y.msg(u.message, u.tone) }, {}, u.banner);
        const chip = (ok, label) => `<span class="chip ${ok === true ? 'chip-ok' : ok === false ? 'chip-fail' : 'chip-muted'}">${ok === true ? '✓' : ok === false ? '✕' : '○'} ${label}</span>`;
        const rows = Object.values(st.orders).slice(-4).reverse().map((o) => {
          const log = st.config.persist ? st.sagaLog[o.id] : (st.mem[o.id] || []);
          const res = st.reservations[o.id];
          const auth = st.auths['auth-' + o.id];
          return `<tr><th>${esc(o.id)}<br><span class="ledger-t">${esc(o.key)}</span></th><td><span class="chip ${o.status === 'CANCELLED' ? 'chip-fail' : o.status === 'RUNNING' ? 'chip-work' : 'chip-ok'}">${esc(o.status)}</span></td>
            <td>${chip(log.includes('reserve') || res ? true : null, 'stock')} ${chip(auth ? true : o.status === 'CANCELLED' && o.why === 'card declined' ? false : null, 'card')} ${chip(o.status === 'CONFIRMED' || o.status === 'SHIPPED' ? true : null, 'confirm')} ${chip(st.shipments[o.id] ? true : null, `ship${st.shipments[o.id] > 1 ? ' ×' + st.shipments[o.id] : ''}`)}</td>
            <td>${esc(res || '–')}</td></tr>`;
        }).join('');
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="console"]'), {
          title: '<p class="ops-title">Orders database and saga log</p>',
          table: `<div class="table-scroll"><table class="ledger"><thead><tr><th>Order</th><th>Status</th><th>Saga steps</th><th>Stock</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">No orders yet.</td></tr>'}</tbody></table></div>`,
          queues: `<div class="app-card"><span class="app-kv"><span>Outbox rows waiting</span><span>${sim.queueStats('outbox').depth}</span></span><span class="app-kv"><span>Events waiting for consumers</span><span>${sim.queueStats('orderEvents').depth}</span></span><span class="app-kv"><span>Emails sent</span><span>${st.emails.length}</span></span></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        });
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
