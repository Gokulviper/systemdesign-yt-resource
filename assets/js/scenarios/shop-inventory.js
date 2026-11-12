/*
 * Inventory and reservations.
 * Two shoppers want the last unit. Checkout first writes a hold in the
 * inventory database (a reservation that expires), then authorises the card,
 * then claims the hold, which decrements stock. Available stock is on hand
 * minus active holds. An expiry worker releases abandoned holds; a warehouse
 * system sends restock events; the product page reads a replica.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const PRICE = 49.99;
  const HOLD_MS = 4000;
  const NAME = { shopperA: 'A', shopperB: 'B' };

  const activeHeld = (st, now) => Object.values(st.inv.holds).filter((h) => h.status === 'held' && (!st.config.lazy || h.exp > now));
  const available = (st, now) => st.inv.onHand - activeHeld(st, now).reduce((a, h) => a + h.qty, 0);
  const snapshot = (st, now) => ({ onHand: st.inv.onHand, available: available(st, now), t: now });

  /** Copy the primary’s numbers to the read replica a moment after every write (asynchronous replication). */
  function replicate(ctx) {
    ctx.spawn(function* (c) {
      yield c.wait(80);
      while (c.mode('lag', 'replica')) yield c.wait(200);
      yield c.call('replica', 'apply', snapshot(c.state, c.now()), { timeout: 1000, quiet: true });
    }, { self: 'invdb', quiet: true });
  }

  function insertHold(ctx, p) {
    const st = ctx.state;
    const id = 'H' + ++st.seq.hold;
    st.inv.holds[id] = { id, owner: p.owner, qty: p.qty, exp: ctx.now() + HOLD_MS, status: 'held' };
    replicate(ctx);
    return { holdId: id, exp: ctx.now() + HOLD_MS };
  }

  function startView(sim, who) {
    sim.spawn(function* (ctx) {
      const r = yield ctx.call('gateway', 'view', {}, { timeout: 800, quiet: true });
      if (r.ok) ctx.ui[who].shown = r.value.available;
    }, { self: who, quiet: true });
  }

  function startBuy(sim, who) {
    const u = sim.ui[who];
    if (!['browse', 'soldout', 'failed', 'done'].includes(u.stage)) return;
    if (!sim.state.config.holds) return startPay(sim, who);
    sim.startAction(`Shopper ${NAME[who]}: buy now`, function* (ctx) {
      const v = ctx.ui[who];
      Object.assign(v, { stage: 'reserving', message: '', tone: '' });
      Y.L(ctx, { displayed: ['pending', 'Shows “Reserving…”.'], retrySafe: ['yes', 'A hold belongs to one checkout session; a repeat returns the same hold.'] });
      const r = yield ctx.call('gateway', 'reserve', { who, qty: 1 }, { timeout: 2000 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) {
        Object.assign(v, { stage: 'held', holdId: r.value.holdId, exp: r.value.exp, message: `Reserved for you. Pay within ${HOLD_MS / 1000} s.`, tone: 'work' });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Hold ${r.value.holdId} written in the inventory database; it expires in ${HOLD_MS / 1000} s.`], async: ['pending', 'Waiting for payment.'] });
        ctx.explain(r.value.racy
          ? 'The inventory service read “1 available”, then wrote a hold. Between the read and the write, the other shopper did the same. Both holds were accepted for one unit: a read-then-write race.'
          : `The hold was written with one conditional update: “reserve if available ≥ 1”. The database checks and writes in one step, so two shoppers can never both get the last unit. The unit is now set aside for ${HOLD_MS / 1000} s.`);
      } else {
        Object.assign(v, { stage: 'soldout', message: r.error.code === 'SOLD_OUT' ? 'Sorry, this item just sold out.' : `Couldn’t reserve: ${r.error.message}`, tone: 'fail' });
        Y.failed(ctx, 'Shows “sold out”. Nothing was charged.');
        const expired = Object.values(ctx.state.inv.holds).some((h) => h.status === 'held' && h.exp <= ctx.now());
        ctx.explain(expired && !ctx.state.config.lazy
          ? 'The only unit is still blocked by a hold that expired seconds ago. The expiry worker is paused, so nothing has released it. The shopper is turned away from an item that is sitting on the shelf.'
          : 'The conditional update found nothing available, so no hold was created and the shopper was told before entering card details.');
      }
      startView(ctx.sim, who);
    }, { self: who });
  }

  function startPay(sim, who) {
    const u = sim.ui[who];
    const holds = sim.state.config.holds;
    if (holds && u.stage !== 'held') return;
    sim.startAction(holds ? `Shopper ${NAME[who]}: pay $${PRICE}` : `Shopper ${NAME[who]}: buy now (no hold)`, function* (ctx) {
      const v = ctx.ui[who];
      Object.assign(v, { stage: 'paying', message: '', tone: '' });
      Y.L(ctx, { displayed: ['pending', 'Shows “Authorising your card…”.'], retrySafe: ['yes', 'The authorisation carries an idempotency key.'] });
      const r = yield ctx.call('gateway', 'pay', { who, holdId: v.holdId }, { timeout: 9000 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) {
        Object.assign(v, { stage: 'done', message: 'Order placed. Arriving Thursday.', tone: 'ok' });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', 'The hold was claimed: on-hand stock went down by one.'], async: 'yes' });
        ctx.explain(holds
          ? 'Payment was authorised, then the hold was claimed in the inventory database. Claiming turns the reservation into a sale and lowers on-hand stock.'
          : 'Without a hold, stock is only taken after the card is authorised. This shopper was first, so the conditional decrement succeeded.');
      } else {
        const code = r.error.code;
        Object.assign(v, { stage: 'failed', message: code === 'HOLD_EXPIRED' ? 'Your reservation expired before payment finished. You weren’t charged.' : code === 'SOLD_OUT' ? 'Sold out while you were paying. Your card authorisation was released.' : `Payment failed: ${r.error.message}`, tone: 'fail' });
        Y.failed(ctx, 'No order. Any card authorisation was voided.');
        ctx.explain(code === 'HOLD_EXPIRED'
          ? 'The card took longer to authorise than the hold lasts. By then the hold had expired and the unit was sold to someone else. The claim checked the hold, refused, and the authorisation was voided. Annoying, but nobody was sold a unit that does not exist.'
          : code === 'SOLD_OUT'
            ? 'With no hold, both shoppers entered payment for the last unit. The second decrement found no stock, so the authorisation was voided. Correct, but the shopper learned it only after paying: holds tell them earlier.'
            : `The payment failed with ${code}.`);
      }
      startView(ctx.sim, who);
    }, { self: who });
  }

  function leave(sim, who) {
    const u = sim.ui[who];
    if (u.stage !== 'held') return;
    Object.assign(u, { stage: 'browse', holdId: null, message: 'You left checkout. The hold stays until it expires.', tone: '' });
    sim.note(`Shopper ${NAME[who]} left checkout without paying. Their hold stays until it expires.`);
  }

  function restock(sim, qty) {
    sim.spawn(function* (ctx) {
      const st = ctx.state;
      const eventId = 'rs-' + ++st.seq.restock;
      st.units += qty;
      ctx.log({ op: `${qty} units arrive at the warehouse`, status: 'note', detail: `The warehouse system publishes ${eventId}: +${qty}.` });
      yield ctx.call('wmsq', 'publish', { eventId, qty }, { timeout: 800 });
    }, { self: 'wms' });
  }

  const sc = (SDL.scenarios['shop-inventory'] = {
    id: 'shop-inventory',
    seed: 311,
    productWidth: 580,
    intro: 'Tap “Buy now” on shopper A: a hold sets the last unit aside, then “Pay” claims it. Then race both phones, walk away from a hold, or slow the card processor down.',
    topology: {
      width: 1160, height: 620,
      nodes: [
        { id: 'shopperA', label: 'Shopper A', sub: 'Phone', kind: 'client', x: 90, y: 90, latency: 1, role: 'Reserves, pays, or walks away.', owns: ['What A sees'] },
        { id: 'shopperB', label: 'Shopper B', sub: 'Phone', kind: 'client', x: 90, y: 300, latency: 1, role: 'Wants the same last unit.', owns: ['What B sees'] },
        { id: 'gateway', label: 'API gateway', sub: 'Store API', kind: 'gateway', x: 300, y: 195, latency: 2, role: 'Routes checkout calls and product-page reads.', ops: [{ name: 'reserve', desc: 'Start checkout.' }, { name: 'pay', desc: 'Pay for a hold.' }, { name: 'view', desc: 'Read availability for the product page.' }], owns: ['Nothing durable'] },
        { id: 'checkout', label: 'Checkout service', sub: 'Reserve, pay, claim', kind: 'service', x: 520, y: 90, latency: 4, role: 'Reserves stock, authorises the card, then claims the hold. Voids the authorisation if the claim fails.', ops: [{ name: 'reserve', desc: 'Ask inventory for a hold.' }, { name: 'pay', desc: 'Authorise, then claim.' }], owns: ['Checkout sessions'] },
        { id: 'payments', label: 'Payment service', sub: 'Card authorisation', kind: 'service', x: 740, y: 40, latency: 90, role: 'Authorises and voids card payments (see the payments lab for the full money path).', ops: [{ name: 'authorize', desc: 'Authorise the card.' }, { name: 'void', desc: 'Release an authorisation.' }], owns: ['Authorisations'] },
        { id: 'inventory', label: 'Inventory service', sub: 'Holds and stock', kind: 'service', x: 520, y: 300, latency: 3, role: 'Turns checkout requests into database operations: reserve, claim, decrement, restock.', ops: [{ name: 'reserve', desc: 'Create a hold.' }, { name: 'claim', desc: 'Turn a hold into a sale.' }, { name: 'decrement', desc: 'Take stock without a hold.' }], owns: ['Reservation rules'] },
        { id: 'invdb', label: 'Inventory DB', sub: 'Stock + holds, one database', kind: 'db', x: 760, y: 300, latency: 8, role: 'Stock rows and hold rows live in one database, so reserving, claiming, and expiring are each one transaction.', ops: [{ name: 'reserveIf', desc: 'Create a hold only if enough is available (atomic).' }, { name: 'read', desc: 'Read availability.' }, { name: 'insertHold', desc: 'Create a hold unconditionally.' }, { name: 'claim', desc: 'Claim a hold.' }, { name: 'expire', desc: 'Release expired holds.' }, { name: 'restock', desc: 'Add units.' }], owns: ['stock[sku]', 'holds'] },
        { id: 'replica', label: 'Read replica', sub: 'Product pages', kind: 'db', x: 760, y: 500, latency: 4, role: 'An asynchronous copy for product-page availability. Never used to decide a sale.', ops: [{ name: 'get', desc: 'Read availability.' }, { name: 'apply', desc: 'Apply replicated changes.' }], owns: ['stock (copy)'] },
        { id: 'sweeper', label: 'Hold expiry worker', sub: 'Every 0.5 s', kind: 'worker', x: 980, y: 190, latency: 3, role: 'Releases holds whose time is up, so abandoned checkouts give their units back.', ops: [{ name: 'run', desc: 'Expire holds.' }], owns: ['Nothing durable'] },
        { id: 'wms', label: 'Warehouse system', sub: 'Receives stock', kind: 'service', x: 300, y: 500, latency: 4, role: 'Announces units received at the warehouse.', ops: [{ name: 'publish', desc: 'Send a restock event.' }], owns: ['What is physically on the shelf'] },
        { id: 'wmsq', label: 'Restock events', sub: 'At least once', kind: 'queue', x: 520, y: 500, latency: 4, queue: 'restocks', role: 'Delivers restock events to the inventory service. May deliver one twice.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['restock log'] },
      ],
      edges: [
        { from: 'shopperA', to: 'gateway', latency: 30 },
        { from: 'shopperB', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'checkout', latency: 4 },
        { from: 'gateway', to: 'replica', latency: 6, label: 'page reads', via: [[410, 195], [410, 590], [760, 590]] },
        { from: 'checkout', to: 'payments', latency: 25 },
        { from: 'checkout', to: 'inventory', latency: 4 },
        { from: 'inventory', to: 'invdb', latency: 4 },
        { from: 'invdb', to: 'replica', latency: 20, label: 'replication' },
        { from: 'sweeper', to: 'invdb', latency: 4 },
        { from: 'wms', to: 'wmsq', latency: 10 },
        { from: 'wmsq', to: 'inventory', latency: 4 },
      ],
      queues: [{ id: 'restocks', broker: 'wmsq', label: 'restocks', groups: ['inventory'] }],
    },
    modeLabels: { lag: 'Replication lagging' },
    failures: [
      { id: 'sweeper-paused', node: 'sweeper', mode: 'paused', label: 'Expiry worker paused', desc: 'Abandoned holds are never released.' },
      { id: 'pay-slow', node: 'payments', mode: 'slow', params: { factor: 60 }, label: 'Card authorisation very slow', desc: 'Authorising takes longer than a hold lasts.' },
      { id: 'restock-dup', node: 'wmsq', mode: 'duplicate', label: 'Restock events delivered twice', desc: 'At-least-once delivery repeats an event.' },
      { id: 'replica-lag', node: 'replica', mode: 'lag', label: 'Replica lagging', desc: 'Product pages show old availability.' },
      { id: 'db-slow', node: 'invdb', mode: 'slow', params: { factor: 20 }, label: 'Inventory DB slow', desc: 'Lock contention: every reservation waits.' },
      { id: 'db-down', node: 'invdb', mode: 'down', label: 'Inventory DB unavailable', desc: 'No reservations: checkout fails closed.' },
      { id: 'pay-down', node: 'payments', mode: 'down', label: 'Payment service unavailable', desc: 'Holds are created but cannot be paid for; they expire.' },
    ],
    switches: Y.switches([
      ['atomic', 'Atomic conditional reserve', 'Check and write in one statement: “reserve if available ≥ 1”. Off: read the stock, then write a hold.'],
      ['holds', 'Reserve stock at checkout', 'Set the unit aside before payment. Off: take stock only after the card is authorised.'],
      ['checkHold', 'Check the hold before claiming', 'Refuse a claim whose hold has expired. Off: a late payment claims stock regardless.'],
      ['lazy', 'Ignore expired holds when checking stock', 'Treat a hold past its expiry time as released, even if the worker has not got to it.'],
      ['dedupe', 'Deduplicate restock events', 'Apply each restock event ID once. Off: a repeated event adds the units again.'],
    ]),
    presets: Y.presets({ atomic: true, holds: true, checkHold: true, lazy: false, dedupe: true }, [
      { id: 'buy', label: 'Buy the last unit', desc: 'Hold, authorise, claim. Stock goes from 1 to 0.', run: (s) => { startBuy(s, 'shopperA'); s.schedule(600, () => startPay(s, 'shopperA')); } },
      { id: 'race', label: 'Two shoppers, one unit', desc: 'Both tap Buy within 20 ms. The atomic reserve gives the unit to A and tells B it sold out.', run: (s) => { startBuy(s, 'shopperA'); s.schedule(20, () => startBuy(s, 'shopperB')); s.schedule(700, () => startPay(s, 'shopperA')); } },
      { id: 'race-bad', label: 'Same race, read then write', desc: 'Both read “1 available” before either writes. Both get a hold, both pay: one unit, two orders.', sw: { atomic: false }, run: (s) => { startBuy(s, 'shopperA'); s.schedule(20, () => startBuy(s, 'shopperB')); s.schedule(700, () => startPay(s, 'shopperA')); s.schedule(720, () => startPay(s, 'shopperB')); } },
      { id: 'abandon', label: 'Abandoned checkout', desc: 'A reserves and walks away. The hold expires after 4 s and B buys the unit.', run: (s) => { startBuy(s, 'shopperA'); s.schedule(800, () => leave(s, 'shopperA')); s.schedule(5000, () => startBuy(s, 'shopperB')); s.schedule(5600, () => startPay(s, 'shopperB')); } },
      { id: 'expiry-paused', label: 'Expiry worker paused', desc: 'A’s abandoned hold is never released. B is told “sold out” while the unit sits on the shelf.', run: (s) => { s.inject('sweeper', 'paused'); startBuy(s, 'shopperA'); s.schedule(800, () => leave(s, 'shopperA')); s.schedule(5000, () => startBuy(s, 'shopperB')); } },
      { id: 'expiry-lazy', label: 'Worker paused, expired holds ignored', desc: 'The availability check skips holds past their expiry time, so B can buy even though the worker is paused.', sw: { lazy: true }, run: (s) => { s.inject('sweeper', 'paused'); startBuy(s, 'shopperA'); s.schedule(800, () => leave(s, 'shopperA')); s.schedule(5000, () => startBuy(s, 'shopperB')); s.schedule(5600, () => startPay(s, 'shopperB')); } },
      { id: 'slow-pay', label: 'Payment slower than the hold', desc: 'A’s card takes 5 s; the hold expires at 4 s and B buys the unit. A’s late claim is refused and voided.', run: (s) => { s.inject('payments', 'slow', { factor: 60 }, 1500); startBuy(s, 'shopperA'); s.schedule(300, () => startPay(s, 'shopperA')); s.schedule(4700, () => startBuy(s, 'shopperB')); s.schedule(5000, () => startPay(s, 'shopperB')); } },
      { id: 'slow-pay-bad', label: 'Same, claim without checking', desc: 'A’s late claim decrements stock anyway: two paid orders for one unit.', sw: { checkHold: false }, run: (s) => { s.inject('payments', 'slow', { factor: 60 }, 1500); startBuy(s, 'shopperA'); s.schedule(300, () => startPay(s, 'shopperA')); s.schedule(4700, () => startBuy(s, 'shopperB')); s.schedule(5000, () => startPay(s, 'shopperB')); } },
      { id: 'restock-dup', label: 'Restock delivered twice, deduplicated', desc: 'Five units arrive; the event is delivered twice and applied once.', run: (s) => { s.inject('wmsq', 'duplicate'); restock(s, 5); } },
      { id: 'restock-dup-bad', label: 'Restock twice, no deduplication', desc: 'The database now believes in five units that do not exist.', sw: { dedupe: false }, run: (s) => { s.inject('wmsq', 'duplicate'); restock(s, 5); } },
      { id: 'replica-lag', label: 'Product page reads a lagging replica', desc: 'A buys the last unit. B’s product page still says “in stock”; the reservation, which reads the primary, says no.', run: (s) => { s.inject('replica', 'lag'); startBuy(s, 'shopperA'); s.schedule(600, () => startPay(s, 'shopperA')); s.schedule(1500, () => startView(s, 'shopperB')); s.schedule(1800, () => startBuy(s, 'shopperB')); } },
      { id: 'no-holds', label: 'No holds: stock taken after payment', desc: 'Both shoppers pay. The second decrement finds nothing, so B’s authorisation is voided after the fact.', sw: { holds: false }, run: (s) => { startBuy(s, 'shopperA'); s.schedule(20, () => startBuy(s, 'shopperB')); } },
    ]),
    initialState: () => ({
      config: { atomic: true, holds: true, checkHold: true, lazy: false, dedupe: true },
      inv: { onHand: 1, holds: {} },
      replica: { onHand: 1, available: 1, t: 0 },
      units: 1, sold: [], auths: {},
      seq: { hold: 0, auth: 0, restock: 0 },
      stats: { voided: 0, expired: 0 },
    }),
    initialUI: () => {
      const phone = () => ({ stage: 'browse', holdId: null, exp: 0, shown: 1, message: '', tone: '' });
      return { shopperA: phone(), shopperB: phone() };
    },
    actions: {
      buy(sim, a) { startBuy(sim, a.who); },
      pay(sim, a) { startPay(sim, a.who); },
      leave(sim, a) { leave(sim, a.who); },
      back(sim, a) { Object.assign(sim.ui[a.who], { stage: 'browse', holdId: null, message: '', tone: '' }); startView(sim, a.who); },
      view(sim, a) { startView(sim, a.who); },
      restock(sim) { restock(sim, 5); },
      set: Y.setAction,
    },
    handlers: {
      gateway: {
        reserve: function* (ctx, p) { return ctx.must(yield ctx.call('checkout', 'reserve', p, { timeout: 1800 })); },
        pay: function* (ctx, p) { return ctx.must(yield ctx.call('checkout', 'pay', p, { timeout: 8800 })); },
        view: function* (ctx) { return ctx.must(yield ctx.call('replica', 'get', {}, { timeout: 600 })); },
      },
      checkout: {
        reserve: function* (ctx, p) { return ctx.must(yield ctx.call('inventory', 'reserve', { owner: p.who, qty: p.qty }, { timeout: 1600 })); },
        pay: function* (ctx, p) {
          const st = ctx.state;
          const auth = ctx.must(yield ctx.call('payments', 'authorize', { owner: p.who, amount: PRICE }, { timeout: 8000 }));
          const c = st.config.holds
            ? yield ctx.call('inventory', 'claim', { holdId: p.holdId, owner: p.who }, { timeout: 1500 })
            : yield ctx.call('inventory', 'decrement', { owner: p.who, qty: 1 }, { timeout: 1500 });
          if (!c.ok) {
            yield ctx.call('payments', 'void', { authId: auth.authId }, { timeout: 1500 });
            ctx.must(c);
          }
          return { order: c.value.order };
        },
      },
      inventory: {
        reserve: function* (ctx, p) {
          if (ctx.state.config.atomic) return ctx.must(yield ctx.call('invdb', 'reserveIf', p, { timeout: 1400 }));
          const s = ctx.must(yield ctx.call('invdb', 'read', {}, { timeout: 1400 }));
          if (s.available < p.qty) ctx.fail('SOLD_OUT', 'Nothing available.');
          yield ctx.wait(40); // builds the hold record; the read is already out of date
          return Object.assign(ctx.must(yield ctx.call('invdb', 'insertHold', p, { timeout: 1400 })), { racy: true });
        },
        claim: function* (ctx, p) { return ctx.must(yield ctx.call('invdb', 'claim', { holdId: p.holdId, check: ctx.state.config.checkHold }, { timeout: 1400 })); },
        decrement: function* (ctx, p) { return ctx.must(yield ctx.call('invdb', 'decrementIf', p, { timeout: 1400 })); },
      },
      invdb: {
        read(ctx) { return snapshot(ctx.state, ctx.now()); },
        reserveIf(ctx, p) {
          const st = ctx.state;
          const avail = available(st, ctx.now());
          if (avail < p.qty) ctx.fail('SOLD_OUT', `Available is ${avail}.`);
          return insertHold(ctx, p);
        },
        insertHold,
        claim(ctx, p) {
          const st = ctx.state;
          const h = st.inv.holds[p.holdId];
          if (!h) ctx.fail('NO_HOLD', 'Unknown hold.');
          const live = h.status === 'held' && h.exp > ctx.now();
          if (p.check && !live) {
            if (h.status === 'held') h.status = 'expired';
            ctx.fail('HOLD_EXPIRED', `Hold ${h.id} expired before payment finished.`);
          }
          st.inv.onHand -= h.qty;
          h.status = 'claimed';
          st.sold.push({ owner: h.owner, holdId: h.id });
          replicate(ctx);
          return { order: 'O' + st.sold.length, late: !live };
        },
        decrementIf(ctx, p) {
          const st = ctx.state;
          if (available(st, ctx.now()) < p.qty) ctx.fail('SOLD_OUT', 'Nothing left.');
          st.inv.onHand -= p.qty;
          st.sold.push({ owner: p.owner });
          replicate(ctx);
          return { order: 'O' + st.sold.length };
        },
        expire(ctx) {
          const st = ctx.state;
          const due = Object.values(st.inv.holds).filter((h) => h.status === 'held' && h.exp <= ctx.now());
          for (const h of due) h.status = 'expired';
          st.stats.expired += due.length;
          if (due.length) replicate(ctx);
          return { released: due.map((h) => h.id) };
        },
        restock(ctx, p) { ctx.state.inv.onHand += p.qty; replicate(ctx); return { onHand: ctx.state.inv.onHand }; },
      },
      replica: {
        get(ctx) { return ctx.state.replica; },
        apply(ctx, p) { ctx.state.replica = p; return { applied: true }; },
      },
      payments: {
        authorize(ctx, p) { const st = ctx.state; const id = 'au' + ++st.seq.auth; st.auths[id] = { owner: p.owner, amount: p.amount, status: 'authorized' }; return { authId: id }; },
        void(ctx, p) { const a = ctx.state.auths[p.authId]; if (a) a.status = 'voided'; ctx.state.stats.voided++; return { voided: true }; },
      },
      wmsq: { publish(ctx, p) { ctx.sim.enqueue('restocks', { type: 'restock', eventId: p.eventId, payload: p }); return { appended: true }; } },
    },
    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(500);
          if (ctx.mode('paused')) continue;
          const r = yield ctx.call('invdb', 'expire', {}, { timeout: 1000, quiet: 'all' });
          if (r.ok && r.value.released.length) ctx.log({ op: `released ${r.value.released.join(', ')}`, status: 'ok', detail: 'The hold expired; its unit is available again.' });
        }
      }, { self: 'sweeper', quiet: 'all' });
      Y.consumer(sim, 'restocks', 'inventory', 'inventory', function* (ctx, msg) {
        const r = yield ctx.call('invdb', 'restock', { qty: msg.payload.qty }, { timeout: 1000 });
        if (r.ok) ctx.log({ op: `applied ${msg.eventId}${msg.duplicate ? ' (redelivered)' : ''}`, status: msg.duplicate ? 'dup' : 'ok', detail: `+${msg.payload.qty} units. On hand is now ${r.value.onHand}.` });
        return r.ok;
      }, (s) => s.state.config.dedupe);
    },
    consistency(sim) {
      const st = sim.state;
      const now = sim.now;
      const shelf = st.units - st.sold.length;
      if (st.sold.length > st.units) return { key: 'wrong', label: `Oversold: ${st.sold.length} paid orders for ${st.units} unit${st.units > 1 ? 's' : ''}. Someone will get a cancellation email.` };
      const avail = available(st, now);
      if (avail < 0) return { key: 'wrong', label: `Available stock is ${avail}: more holds than units. Every hold holder believes the item is theirs.` };
      if (st.inv.onHand > shelf) return { key: 'wrong', label: `Phantom stock: the database says ${st.inv.onHand} on hand, but only ${shelf} are on the shelf. Shoppers will buy units that do not exist.` };
      const stuck = !st.config.lazy && Object.values(st.inv.holds).find((h) => h.status === 'held' && h.exp < now - 300);
      if (stuck) return { key: 'stale', label: `Hold ${stuck.id} expired ${((now - stuck.exp) / 1000).toFixed(1)} s ago but still blocks its unit. Shoppers see “sold out” while it sits on the shelf.` };
      if (st.replica.available !== avail) return { key: 'stale', label: `Product pages read a replica that says ${st.replica.available} available; the primary says ${avail}. Reservations read the primary, so no sale is wrong.` };
      return { key: 'ok', label: 'Every unit is sold at most once, and the stock count matches the shelf.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const now = sim.now;
      const held = activeHeld(st, now).length;
      const over = Math.max(0, st.sold.length - st.units);
      return [
        { label: 'On hand (database)', value: st.inv.onHand, tone: st.inv.onHand < 0 ? 'fail' : '' },
        { label: 'Active holds', value: held },
        { label: 'Available', value: available(st, now), tone: available(st, now) < 0 ? 'fail' : '' },
        { label: 'Units on the shelf', value: Math.max(0, st.units - st.sold.length) },
        { label: 'Oversold units', value: over, tone: over ? 'fail' : 'ok' },
        { label: 'Holds expired', value: st.stats.expired },
        { label: 'Authorisations voided', value: st.stats.voided },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['shopperA', 'Shopper A'], ['shopperB', 'Shopper B']], {
          note: 'Both phones are looking at the same product with one unit left. The console below shows the inventory database.',
          below: '<div class="ops-console" data-ref="console"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const now = sim.now;
        for (const who of ['shopperA', 'shopperB']) {
          const u = sim.ui[who];
          const a = { who };
          const mine = u.stage === 'held' || u.stage === 'paying';
          const stock = mine ? 'Reserved for you' : u.shown > 1 ? 'In stock' : u.shown === 1 ? 'Only 1 left in stock' : 'Currently unavailable';
          const product = `<div class="yt-card"><div class="yt-thumb" style="--h:200"><span aria-hidden="true">◉</span></div>
            <div><strong>Echo Dot (5th gen) smart speaker</strong><p class="app-price">$${PRICE}</p>
            <p class="app-sub">${mine || u.shown > 0 ? '✓' : '✕'} ${stock}</p></div></div>`;
          let stage = '';
          if (u.stage === 'browse') stage = `${Y.btn('buy', 'Buy now', { arg: a })}${Y.btn('view', 'Refresh page', { arg: a, cls: 'secondary' })}`;
          if (u.stage === 'reserving') stage = '<div class="app-card is-work"><strong><span class="spinner"></span>Reserving…</strong></div>';
          if (u.stage === 'held') stage = `<div class="app-card is-hot"><strong>⏱ Reserved for you</strong><span class="app-sub">Hold ${esc(u.holdId)}: <span data-live="left-${who}"></span></span>
            <div class="app-countdown"><i data-live-width="bar-${who}"></i></div></div>
            ${Y.btn('pay', `Pay $${PRICE}`, { arg: a, cls: 'go' })}${Y.btn('leave', 'Leave checkout', { arg: a, cls: 'secondary' })}`;
          if (u.stage === 'paying') stage = '<div class="app-card is-work"><strong><span class="spinner"></span>Authorising your card…</strong></div>';
          if (u.stage === 'done') stage = `<div class="app-card is-ok"><strong>✓ Order placed</strong><span class="app-sub">Arriving Thursday</span></div>${Y.btn('back', 'Keep shopping', { arg: a, cls: 'secondary' })}`;
          if (u.stage === 'soldout' || u.stage === 'failed') stage = `<div class="app-card is-fail"><strong>✕ ${u.stage === 'soldout' ? 'Sold out' : 'No order'}</strong></div>${Y.btn('back', 'Back to product', { arg: a, cls: 'secondary' })}`;
          const left = Math.max(0, u.exp - now);
          Y.paint(el, sim, who, {
            head: '<div><p class="app-title">Amazon</p><p class="app-sub">Deliver to Chennai</p></div>',
            product, stage, msg: Y.msg(u.message, u.tone),
          }, { [`left-${who}`]: left > 0 ? `${(left / 1000).toFixed(1)} s left` : 'expired', [`bar-${who}`]: `${(left / HOLD_MS) * 100}%` });
        }
        const holds = Object.values(st.inv.holds).slice(-4).reverse();
        const tone = (h) => (h.status === 'held' && h.exp <= now ? 'fail' : h.status === 'held' ? 'warn' : '');
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="console"]'), {
          title: '<p class="ops-title">Inventory database: Echo Dot</p>',
          stock: `<div class="app-card"><span class="app-kv"><span>On hand</span><span>${st.inv.onHand}</span></span>
            <span class="app-kv"><span>Held by active holds</span><span>${activeHeld(st, now).length}</span></span>
            <span class="app-kv"><span>Available to sell</span><span>${available(st, now)}</span></span>
            <span class="app-kv"><span>Units physically on the shelf</span><span>${Math.max(0, st.units - st.sold.length)}</span></span>
            <span class="app-kv"><span>Paid orders</span><span>${st.sold.length}${st.sold.length > st.units ? ` for ${st.units} unit${st.units > 1 ? 's' : ''} ✕` : ''}</span></span></div>`,
          holds: `<div class="ops-shards">${holds.map((h) => `<div class="ops-row" data-tone="${tone(h)}"><div class="ops-name">${esc(h.id)}: shopper ${NAME[h.owner]}<span>${h.status === 'held' ? (h.exp > now ? `held, <span data-live="hold-${h.id}"></span> left` : 'held past expiry') : esc(h.status)}</span></div></div>`).join('') || '<p class="app-sub">No holds yet.</p>'}</div>`,
          actions: `<div class="app-row">${Y.btn('restock', 'Warehouse: receive 5 units', { cls: 'secondary' })}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, Object.fromEntries(holds.map((h) => [`hold-${h.id}`, `${(Math.max(0, h.exp - now) / 1000).toFixed(1)} s`])));
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
