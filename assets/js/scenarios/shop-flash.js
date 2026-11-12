/*
 * Flash sale and hot products.
 * One discounted product, hundreds of shoppers a second. Every purchase locks
 * the same stock row, which has real capacity (one worker, 16 ms per update,
 * so about 57 a second). Nothing is broken: overload emerges when demand
 * exceeds what one row can do.
 *
 * Protections, each a design switch:
 *  room     a waiting room admits shoppers at the rate the stock can absorb
 *  buckets  split the stock over four rows that lock independently
 *  async    accept orders into a queue; a writer drains it in batches
 *  limit    one per customer enforced by a unique key, not read then write
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const PRICE = 299;
  const LIST = 499;
  const STOCK = 300;
  const SALE_MS = 5000;
  const CLIENT_TIMEOUT = 1500;
  const DEMAND = { calm: { label: 'Steady interest', rate: 25 }, crush: { label: 'Sale goes viral', rate: 120 } };
  const BOT_WAVES = 8; // per second, while a bot surge is on
  const BOT_FANOUT = 4; // parallel requests per bot account per wave
  const BOT_ACCOUNTS = 6;
  const ADMIT = (st) => (st.config.buckets ? 180 : 45); // waiting-room admissions per second
  const ms = (v) => `${Math.round(v).toLocaleString('en-US')} ms`;

  const saleOn = (sim) => !!sim.state.sale && sim.now < sim.state.sale.end;
  const stockNode = (st) => (st.config.buckets ? 'buckets' : 'stockdb');

  function startSale(sim, demand, stock) {
    const st = sim.state;
    const n = stock || STOCK;
    Object.assign(st, {
      sale: { start: sim.now, end: sim.now + SALE_MS },
      demand: demand || st.demand,
      stock: n,
      bucket: split(n),
      soldOut: false,
      sold: {}, claims: {}, limitRows: {}, outcomes: {},
      room: { queue: [], admitted: {}, closed: false, next: 0, tokens: 0, turnedAway: 0 },
      stats: { attempts: 0, confirmed: 0, timedOut: 0, ghost: 0, retries: 0, gaveUp: 0, botUnits: 0, humanUnits: 0, shed: 0, batches: 0 },
    });
    sim.note(`Lightning deal starts: ${n} units at $${PRICE}. ${DEMAND[st.demand].label}: about ${DEMAND[st.demand].rate} shoppers a second for ${SALE_MS / 1000} s.`);
  }
  const split = (n) => [0, 1, 2, 3].map((i) => Math.floor(n / 4) + (i < n % 4 ? 1 : 0));

  /** One purchase attempt: through the waiting room if it is on, then to the gateway. */
  function* buyOnce(ctx, account, kind, quiet, onTicket) {
    const st = ctx.state;
    const q = quiet ? 'all' : false;
    let ticket = null;
    const tEnter = ctx.now();
    if (st.config.room) {
      const e = yield ctx.call('gateway', 'enter', { account }, { timeout: 1000, quiet: q });
      if (!e.ok) return e;
      ticket = e.value.ticket;
      if (onTicket) onTicket(ticket);
      while (!st.room.admitted[ticket]) {
        if (st.room.closed) return { ok: false, error: { code: 'SOLD_OUT', message: 'Sold out while you were in line.' } };
        yield ctx.wait(100);
      }
    }
    st.stats.attempts++;
    const t0 = ctx.now();
    const r = yield ctx.call('gateway', 'buy', { account, kind, ticket, deadline: t0 + CLIENT_TIMEOUT }, { timeout: CLIENT_TIMEOUT, quiet: q });
    r.waited = t0 - tEnter;
    if (r.ok && !r.value.queued) st.stats.confirmed++;
    if (!r.ok && r.error.code === 'TIMEOUT') st.stats.timedOut++;
    ctx.recordOutcome(r.ok || ['SOLD_OUT', 'LIMIT'].includes(r.error.code), ctx.now() - t0);
    return r;
  }

  /** A background shopper or bot: one attempt, then retries (with backoff, or immediately in a retry storm). */
  function* attempt(ctx, account, kind) {
    const st = ctx.state;
    for (let a = 1; ; a++) {
      const r = yield* buyOnce(ctx, account, kind, true);
      if (r.ok || ['SOLD_OUT', 'LIMIT'].includes(r.error.code)) return;
      const storm = !!ctx.mode('storm', 'crowd');
      if (a >= (storm ? 5 : 2)) { st.stats.gaveUp++; return; }
      st.stats.retries++;
      yield ctx.wait(storm ? 20 : Math.round(800 + 800 * ctx.rand()));
    }
  }

  function startBuy(sim) {
    const u = sim.ui.you;
    if (!['idle', 'failed', 'soldout', 'limit'].includes(u.stage)) return;
    sim.startAction('You: buy the lightning deal', function* (ctx) {
      const st = ctx.state;
      const v = ctx.ui.you;
      Object.assign(v, { stage: st.config.room ? 'waiting' : 'buying', ticket: null, message: '', tone: '' });
      Y.L(ctx, { displayed: ['pending', st.config.room ? 'Shows your place in line.' : 'Shows “Placing your order…”.'], retrySafe: ['yes', 'One per customer: a repeat finds your existing claim.'] });
      const t0 = ctx.now();
      const r = yield* buyOnce(ctx, 'you', 'human', false, (t) => { v.ticket = t; ctx.ledger('displayed', 'pending', 'Shows your place in the waiting room.'); });
      const took = ctx.now() - t0;
      const rowWait = ctx.sim.queueWait(stockNode(st));
      if (r.ok && r.value.queued) {
        Object.assign(v, { stage: 'queued', message: 'You’re in. We’ll confirm in a moment.', tone: 'work' });
        Y.L(ctx, { displayed: 'yes', accepted: ['yes', 'Your order request is in the intake queue.'], committed: ['pending', 'The writer has not reached it yet.'], async: ['pending', 'Waiting for the batch writer.'] });
        ctx.explain(`Your request was written to the intake queue in ${ms(took)} and you were told “you’re in”. The stock row is only touched by the writer, which takes up to 50 queued orders per transaction. Demand can be far above what one row can do, and nobody waits on a lock.`);
        while (!st.outcomes.you) yield ctx.wait(100);
        const ok = st.outcomes.you === 'confirmed';
        Object.assign(v, { stage: ok ? 'done' : 'soldout', message: ok ? 'Order confirmed. Arriving Friday.' : 'Sorry, the deal sold out before your order was processed.', tone: ok ? 'ok' : 'fail' });
        Y.L(ctx, ok ? { committed: 'yes', async: 'yes' } : { committed: ['no', 'Sold out by the time the writer reached it.'], async: 'yes' });
        return;
      }
      if (r.ok) {
        Object.assign(v, { stage: 'done', message: 'Order placed. Arriving Friday.', tone: 'ok' });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `One unit taken from ${st.config.buckets ? 'a stock bucket' : 'the stock row'}.`], async: 'n/a' });
        ctx.explain(st.config.room
          ? `You waited ${ms(r.waited)} in line, then checkout took ${ms(took - r.waited)}. The waiting room only lets in about ${ADMIT(st)} shoppers a second, which the stock ${st.config.buckets ? 'buckets' : 'row'} can absorb, so nobody behind the room times out.`
          : st.config.buckets
            ? `Your purchase took ${ms(took)}. The stock is split over four rows that lock independently, so the database absorbs about four times the purchases a single row could.`
            : `Your purchase took ${ms(took)}. Demand is below what the one stock row can handle, so its queue stays short.`);
        return;
      }
      const code = r.error.code;
      const stage = code === 'SOLD_OUT' ? 'soldout' : code === 'LIMIT' ? 'limit' : 'failed';
      Object.assign(v, {
        stage,
        message: code === 'SOLD_OUT' ? 'This deal has sold out.' : code === 'LIMIT' ? 'Limit one per customer: you already have one.' : code === 'TIMEOUT' ? 'Something went wrong. Please try again.' : `Couldn’t place the order: ${r.error.message}`,
        tone: 'fail',
      });
      Y.failed(ctx, code === 'TIMEOUT' ? 'Shows an error, but the order may still go through.' : 'No order.');
      if (code === 'TIMEOUT') ctx.ledger('committed', 'unknown', 'Your request is still queued at the stock row; it may commit after you were told it failed.');
      ctx.explain(code === 'TIMEOUT'
        ? `Your phone gave up after ${ms(CLIENT_TIMEOUT)}. The one stock row now has a ${ms(rowWait)} queue: about ${Math.round(rowWait / 18)} purchases ahead of anyone arriving. Nothing is broken: every purchase locks the same row, and demand is about ${DEMAND[st.demand].rate} a second against roughly 57. The database will still process your request later, so you may get an order you were told failed.`
        : code === 'SOLD_OUT'
          ? 'Every unit has been sold. The order service now answers “sold out” without touching the database.'
          : code === 'LIMIT'
            ? 'A purchase-limit row already exists for your account: an earlier attempt of yours went through. The unique key refused a second unit.'
            : `The purchase failed with ${code}.`);
    }, { self: 'you' });
  }

  const sc = (SDL.scenarios['shop-flash'] = {
    id: 'shop-flash',
    seed: 977,
    productWidth: 560,
    intro: 'Start the sale from the console, then tap “Buy now”. With thousands of shoppers on one product, watch the stock row’s queue grow, then turn on each protection in Design switches.',
    topology: {
      width: 1120, height: 620,
      nodes: [
        { id: 'you', label: 'Your phone', sub: 'The deal page', kind: 'client', x: 90, y: 90, latency: 1, role: 'You, trying to buy the lightning deal.', owns: ['What you see'] },
        { id: 'crowd', label: 'Other shoppers', sub: 'Background demand', kind: 'client', x: 90, y: 300, latency: 1, role: 'Everyone else tapping “Buy now”. Each retries once with backoff, or hammers the button in a retry storm.', owns: ['Nothing'] },
        { id: 'bots', label: 'Scalper bots', sub: 'Six accounts', kind: 'client', x: 90, y: 510, latency: 1, role: 'Scripts that fire several purchases at once from each account to beat the limit.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Checks admission', kind: 'gateway', x: 320, y: 300, latency: 2, role: 'Routes purchases. With the waiting room on, refuses any purchase without an admission ticket.', ops: [{ name: 'enter', desc: 'Join the waiting room.' }, { name: 'buy', desc: 'Buy one unit.' }], owns: ['Nothing durable'] },
        { id: 'room', label: 'Waiting room', sub: 'Admits at a fixed rate', kind: 'service', x: 320, y: 90, latency: 3, role: 'Gives each shopper a place in line and admits them at the rate the stock can absorb. Closes the line when the deal sells out.', ops: [{ name: 'enter', desc: 'Issue a ticket.' }], owns: ['The line', 'Admission tickets'] },
        { id: 'orders', label: 'Order service', sub: 'Limit, then stock', kind: 'service', x: 560, y: 300, latency: 3, role: 'Takes a unit (the stock transaction also enforces one per customer), or puts the order in the intake queue.', ops: [{ name: 'buy', desc: 'Limit check, then purchase.' }], owns: ['Sold-out flag'] },
        { id: 'limits', label: 'Purchase history', sub: 'Read-then-write limit', kind: 'db', x: 560, y: 510, latency: 3, role: 'Units bought per customer, used by the limit check when it is not a unique key: read the count, buy, then record. With the unique key on, the limit row is inserted in the stock transaction instead.', ops: [{ name: 'count', desc: 'Read how many this account bought.' }, { name: 'record', desc: 'Write a purchase after the fact.' }], owns: ['bought[sale, account]'] },
        { id: 'intake', label: 'Order intake', sub: 'Queue', kind: 'queue', x: 800, y: 90, latency: 4, queue: 'intake', role: 'Accepts order requests in microseconds, whatever the stock row is doing.', ops: [{ name: 'publish', desc: 'Append an order request.' }], owns: ['intake log'] },
        { id: 'writer', label: 'Batch writer', sub: 'Up to 50 per batch', kind: 'worker', x: 1020, y: 200, latency: 3, role: 'Drains the intake queue in batches: one row lock per batch instead of one per order.', ops: [{ name: 'drain', desc: 'Apply a batch.' }], owns: ['Nothing durable'] },
        { id: 'stockdb', label: 'Stock row', sub: 'One row, ~57 updates/s', kind: 'db', x: 800, y: 330, latency: 3, serviceMs: 16, role: 'The deal’s stock count. Every purchase locks this one row for about 16 ms, so it handles about 57 a second however big the database is.', ops: [{ name: 'buyIf', desc: 'Take one if any are left.' }, { name: 'buyBatch', desc: 'Take one per order in a batch.' }], owns: ['stock[deal]'] },
        { id: 'buckets', label: 'Stock buckets', sub: 'Four rows, ~228 updates/s', kind: 'db', x: 800, y: 530, latency: 3, serviceMs: 16, servers: 4, role: 'The same stock split over four rows. Each locks independently, so four purchases proceed at once. A purchase tries another bucket when its first is empty.', ops: [{ name: 'buyIf', desc: 'Take one from a bucket.' }, { name: 'buyBatch', desc: 'Take one per order in a batch.' }], owns: ['stock[deal, 1..4]'] },
      ],
      edges: [
        { from: 'you', to: 'gateway', latency: 30 },
        { from: 'crowd', to: 'gateway', latency: 30 },
        { from: 'bots', to: 'gateway', latency: 20 },
        { from: 'gateway', to: 'room', latency: 3 },
        { from: 'gateway', to: 'orders', latency: 3 },
        { from: 'orders', to: 'limits', latency: 3 },
        { from: 'orders', to: 'stockdb', latency: 3 },
        { from: 'orders', to: 'buckets', latency: 3, via: [[680, 300], [680, 530]] },
        { from: 'orders', to: 'intake', latency: 3, via: [[560, 90]] },
        { from: 'intake', to: 'writer', latency: 3 },
        { from: 'writer', to: 'stockdb', latency: 3 },
        { from: 'writer', to: 'buckets', latency: 3, via: [[1020, 530]] },
      ],
      queues: [{ id: 'intake', broker: 'intake', label: 'intake', groups: ['writer'] }],
    },
    minHopMs: 5,
    modeLabels: { surge: 'Bot surge', storm: 'Retry storm' },
    failures: [
      { id: 'bots', node: 'bots', mode: 'surge', label: 'Bot surge', desc: `${BOT_ACCOUNTS} accounts fire ${BOT_FANOUT} purchases at once, ${BOT_WAVES} times a second.` },
      { id: 'storm', node: 'crowd', mode: 'storm', label: 'Retry storm', desc: 'Shoppers hammer “Buy now” the moment it fails: up to five tries, 20 ms apart.' },
      { id: 'row-slow', node: 'stockdb', mode: 'slow', params: { factor: 3 }, label: 'Stock row slow', desc: 'Lock contention triples the time per update.' },
      { id: 'row-down', node: 'stockdb', mode: 'down', label: 'Stock database down', desc: 'No purchases at all: checkout fails closed.' },
      { id: 'room-down', node: 'room', mode: 'down', label: 'Waiting room down', desc: 'Nobody can get a ticket while the room is on.' },
      { id: 'writer-paused', node: 'writer', mode: 'paused', label: 'Batch writer paused', desc: 'Orders pile up in the intake queue unconfirmed.' },
      { id: 'limits-down', node: 'limits', mode: 'down', label: 'Purchase history down', desc: 'With the read-then-write check, purchases fail closed.' },
    ],
    switches: Y.switches([
      ['room', 'Waiting room', 'Give everyone a place in line and admit them at the rate the stock can take. Off: everyone hits checkout at once.'],
      ['buckets', 'Split stock into four buckets', 'Four rows that lock independently: about four times the purchase rate.', (s, on) => {
        const st = s.state;
        if (on) st.bucket = split(st.stock);
        else st.stock = st.bucket.reduce((a, b) => a + b, 0);
      }],
      ['async', 'Asynchronous order intake', 'Accept the order into a queue and confirm later; a writer applies orders in batches. Off: every purchase waits on the stock lock.'],
      ['limit', 'Enforce the limit with a unique key', 'The stock transaction also inserts a “sale + account” row; a second insert for the same account fails. Off: read how many the account bought, then buy, then record it.'],
    ]),
    presets: Y.presets({ room: false, buckets: false, async: false, limit: true }, [
      { id: 'calm', label: 'Steady demand', desc: 'About 25 shoppers a second against a row that handles about 57. Your purchase takes a fraction of a second.', run: (s) => { startSale(s, 'calm'); s.schedule(1500, () => startBuy(s)); } },
      { id: 'crush', label: 'Sale goes viral (hot row)', desc: 'About 120 shoppers a second, one stock row. Its queue grows every second; you and hundreds of others time out, and some get orders they were told failed.', run: (s) => { startSale(s, 'crush'); s.schedule(1500, () => startBuy(s)); } },
      { id: 'storm', label: 'Viral sale plus a retry storm', desc: 'Same demand, but every failed shopper taps again at once. The row does no more useful work; the queue and the timeouts get worse.', run: (s) => { s.inject('crowd', 'storm'); startSale(s, 'crush'); s.schedule(1500, () => startBuy(s)); } },
      { id: 'room', label: 'Fix: waiting room', desc: 'Everyone gets a place in line and is admitted about 45 a second. Nobody times out; the line tells you where you stand.', sw: { room: true }, run: (s) => { startSale(s, 'crush'); s.schedule(1500, () => startBuy(s)); } },
      { id: 'buckets', label: 'Fix: four stock buckets', desc: 'Stock split over four rows: about 228 purchases a second. The same crowd gets served without queueing.', sw: { buckets: true }, run: (s) => { startSale(s, 'crush'); s.schedule(1500, () => startBuy(s)); } },
      { id: 'async', label: 'Fix: asynchronous intake', desc: 'Orders go into a queue in milliseconds; a writer applies 50 per row lock. You are told “you’re in”, then confirmed.', sw: { async: true }, run: (s) => { startSale(s, 'crush'); s.schedule(1500, () => startBuy(s)); } },
      { id: 'async-paused', label: 'Intake with the writer paused', desc: 'The queue accepts every order but nothing applies them. You and everyone else wait on “you’re in” with no confirmation.', sw: { async: true }, run: (s) => { s.inject('writer', 'paused'); startSale(s, 'crush'); s.schedule(1500, () => startBuy(s)); } },
      { id: 'bots', label: 'Bots beat the purchase limit', desc: 'Six bot accounts fire four purchases at once. Read-then-write checks all see “0 bought”, so each account walks away with several.', sw: { limit: false }, run: (s) => { s.inject('bots', 'surge'); startSale(s, 'calm', 60); s.schedule(1500, () => startBuy(s)); } },
      { id: 'bots-limited', label: 'Bots against a unique key', desc: 'The first insert for each account wins; the parallel duplicates fail. Six units go to bots, the rest to people.', run: (s) => { s.inject('bots', 'surge'); startSale(s, 'calm', 60); s.schedule(1500, () => startBuy(s)); } },
      { id: 'all', label: 'Everything at once, all protections', desc: 'Viral demand, a retry storm, and bots, with the waiting room, four buckets, and the unique key.', sw: { room: true, buckets: true }, run: (s) => { s.inject('crowd', 'storm'); s.inject('bots', 'surge'); startSale(s, 'crush'); s.schedule(1500, () => startBuy(s)); } },
    ]),
    initialState: () => ({
      config: { room: false, buckets: false, async: false, limit: true },
      sale: null, demand: 'crush',
      stock: STOCK, bucket: split(STOCK), soldOut: false,
      sold: {}, claims: {}, limitRows: {}, outcomes: {},
      room: { queue: [], admitted: {}, closed: false, next: 0, tokens: 0, turnedAway: 0 },
      seq: { order: 0 },
      stats: { attempts: 0, confirmed: 0, timedOut: 0, ghost: 0, retries: 0, gaveUp: 0, botUnits: 0, humanUnits: 0, shed: 0, batches: 0 },
    }),
    initialUI: () => ({ you: { stage: 'idle', ticket: null, message: '', tone: '' } }),
    actions: {
      start(sim, a) { startSale(sim, a.demand || sim.state.demand); },
      demand(sim, a) { sim.state.demand = a.level; sim.note(`Demand set to “${DEMAND[a.level].label}”: about ${DEMAND[a.level].rate} shoppers a second.`); },
      buy(sim) { startBuy(sim); },
      back(sim) { Object.assign(sim.ui.you, { stage: 'idle', ticket: null, message: '', tone: '' }); },
    },
    handlers: {
      gateway: {
        enter: function* (ctx, p) { return ctx.must(yield ctx.call('room', 'enter', p, { timeout: 800 })); },
        buy: function* (ctx, p) {
          const st = ctx.state;
          if (st.config.room && !st.room.admitted[p.ticket]) ctx.fail('NOT_ADMITTED', 'No admission ticket from the waiting room.');
          return ctx.must(yield ctx.call('orders', 'buy', p, { timeout: CLIENT_TIMEOUT }));
        },
      },
      room: {
        enter(ctx) {
          const r = ctx.state.room;
          if (ctx.state.soldOut) ctx.fail('SOLD_OUT', 'The deal has sold out.');
          const ticket = 'T' + ++r.next;
          r.queue.push(ticket);
          return { ticket, position: r.queue.length };
        },
      },
      orders: {
        buy: function* (ctx, p) {
          const st = ctx.state;
          if (st.soldOut) ctx.fail('SOLD_OUT', 'The deal has sold out.');
          if (!st.config.limit) {
            const c = ctx.must(yield ctx.call('limits', 'count', p, { timeout: 600 }));
            if (c.count >= 1) ctx.fail('LIMIT', 'Limit one per customer.');
          }
          if (st.config.async) {
            ctx.must(yield ctx.call('intake', 'publish', p, { timeout: 600 }));
            return { queued: true };
          }
          const v = ctx.must(yield ctx.call(stockNode(st), 'buyIf', p, { timeout: CLIENT_TIMEOUT }));
          if (!st.config.limit) yield ctx.call('limits', 'record', p, { timeout: 600 });
          return v;
        },
      },
      limits: {
        count(ctx, p) { return { count: ctx.state.claims[p.account] || 0 }; },
        record(ctx, p) { const st = ctx.state; st.claims[p.account] = (st.claims[p.account] || 0) + 1; return { recorded: true }; },
      },
      intake: {
        publish(ctx, p) { ctx.sim.enqueue('intake', { type: 'order', eventId: 'rq-' + p.account, payload: p }); return { appended: true }; },
      },
      stockdb: {
        buyIf(ctx, p) { return take(ctx, p, null); },
        buyBatch(ctx, p) { return p.orders.map((o) => tryTake(ctx, o, null)); },
      },
      buckets: {
        buyIf(ctx, p) { return take(ctx, p, Math.floor(ctx.rand() * 4)); },
        buyBatch(ctx, p) { return p.orders.map((o) => tryTake(ctx, o, Math.floor(ctx.rand() * 4))); },
      },
    },
    setup(sim) {
      Y.load(sim, 'crowd', (s) => (saleOn(s) ? DEMAND[s.state.demand].rate : 0), (ctx, n) => attempt(ctx, 'c' + n, 'human'));
      Y.load(sim, 'bots', (s) => (saleOn(s) && s.nodes.bots.modes.surge ? BOT_WAVES : 0), function* (ctx, n) {
        const account = 'bot' + (n % BOT_ACCOUNTS);
        const procs = [];
        for (let i = 0; i < BOT_FANOUT; i++) procs.push(ctx.spawn((c) => attempt(c, account, 'bot'), { quiet: 'all' }));
        yield ctx.join(procs);
      });
      // Waiting room: admit at a fixed rate; close the line once the deal sells out.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const st = ctx.state;
          const r = st.room;
          if (ctx.mode('down')) continue;
          if (st.soldOut && r.queue.length && !r.closed) {
            r.closed = true;
            r.turnedAway = r.queue.length;
            r.queue = [];
            ctx.log({ op: `line closed: sold out (${r.turnedAway} waiting)`, status: 'note', detail: 'Everyone still in line is told the deal sold out, instead of being admitted to find out.' });
          }
          r.tokens = Math.min(r.tokens + ADMIT(st) * 0.1, ADMIT(st) * 0.2);
          while (r.tokens >= 1 && r.queue.length && !r.closed) { r.admitted[r.queue.shift()] = true; r.tokens -= 1; }
        }
      }, { self: 'room', quiet: 'all' });
      // Batch writer: one row lock per batch of up to 50 orders.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msgs } = yield ctx.take('intake', 'writer', 50);
          const st = ctx.state;
          const orders = msgs.map((m) => m.payload);
          const r = yield ctx.call(stockNode(st), 'buyBatch', { orders }, { timeout: 2000, quiet: true });
          if (!r.ok) { ctx.nack('intake', 'writer'); yield ctx.wait(300); continue; }
          st.stats.batches++;
          let ok = 0;
          for (let i = 0; i < orders.length; i++) {
            const o = orders[i];
            st.outcomes[o.account] = r.value[i] ? 'confirmed' : r.value[i] === false ? 'limit' : 'soldout';
            if (r.value[i]) { ok++; if (o.account !== 'you') st.stats.confirmed++; }
          }
          ctx.log({ op: `batch of ${orders.length} applied`, status: 'ok', detail: `${ok} confirmed, ${orders.length - ok} sold out, in one transaction on the ${st.config.buckets ? 'stock buckets' : 'stock row'}. ${st.stock} left.` });
          ctx.ack('intake', 'writer');
        }
      }, { self: 'writer' });
    },
    consistency(sim) {
      const st = sim.state;
      const over = Object.entries(st.sold).filter(([a, n]) => n > 1);
      if (st.stock < 0) return { key: 'wrong', label: `Oversold: stock is ${st.stock}.` };
      if (over.length) {
        const units = over.reduce((a, [, n]) => a + n, 0);
        return { key: 'wrong', label: `Limit one per customer, but ${over.length} account${over.length > 1 ? 's' : ''} bought ${units} units between them. The parallel requests each read “0 bought” before any recorded a purchase.` };
      }
      const backlog = sim.queueStats('intake').depth;
      if (backlog) return { key: 'stale', label: `${backlog} orders accepted into the intake queue but not yet confirmed. Shoppers are waiting on “you’re in”.` };
      if (st.stats.timedOut) return { key: 'stale', label: `Overloaded: ${st.stats.timedOut} of ${st.stats.attempts} purchase attempts timed out waiting for the stock row${st.stats.ghost ? `, and ${st.stats.ghost} of those went through after the shopper was told it failed` : ''}. No unit was sold twice.` };
      const waiting = st.room.queue.length;
      if (!st.sale) return { key: 'ok', label: 'The sale has not started.' };
      const away = st.room.turnedAway;
      return { key: 'ok', label: `Every unit sold at most once, at most one per customer, and nobody timed out${waiting ? `. ${waiting} shoppers still waiting in line, each with a place and an estimate` : ''}${away ? `. The line closed at sell-out and told the ${away} still waiting` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const wait = sim.queueWait(stockNode(st));
      return [
        { label: 'Units left', value: st.stock },
        { label: 'Stock queue', value: ms(wait), tone: wait > 1000 ? 'fail' : wait > 300 ? 'warn' : 'ok' },
        { label: 'Purchase attempts', value: st.stats.attempts },
        { label: 'Timed out', value: st.stats.timedOut, tone: st.stats.timedOut ? 'fail' : 'ok' },
        { label: 'Sold after a timeout', value: st.stats.ghost, tone: st.stats.ghost ? 'warn' : '' },
        { label: 'Retries', value: st.stats.retries },
        { label: 'In the waiting room', value: st.room.queue.length },
        { label: 'Units to bots', value: st.stats.botUnits, tone: Object.values(st.sold).some((n) => n > 1) ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['you', 'Your phone']], {
          side: '<div data-ref="console"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.you;
        const total = st.sale ? Object.values(st.sold).reduce((a, n) => a + n, 0) + st.stock : STOCK;
        const claimed = total ? Math.round(((total - st.stock) / total) * 100) : 0;
        const left = st.sale ? Math.max(0, st.sale.end - sim.now) : SALE_MS;
        const product = `<div class="yt-card"><div class="yt-thumb" style="--h:260"><span aria-hidden="true">▣</span></div>
          <div><strong>Game console, disc edition</strong><p class="app-price">$${PRICE} <span class="app-sub"><s>$${LIST}</s></span></p>
          <p class="app-sub">⚡ Lightning deal: <span data-live="claimed"></span></p></div></div>
          <div class="app-countdown"><i data-live-width="bar"></i></div>`;
        const pos = u.ticket ? st.room.queue.indexOf(u.ticket) + 1 : 0;
        let stage = '';
        if (u.stage === 'idle') stage = Y.btn('buy', 'Buy now', { cls: 'go' });
        if (u.stage === 'waiting') stage = `<div class="app-card is-hot"><strong>⏳ You’re in line</strong><span class="app-sub"><span data-live="pos"></span></span></div>`;
        if (u.stage === 'buying') stage = '<div class="app-card is-work"><strong><span class="spinner"></span>Placing your order…</strong></div>';
        if (u.stage === 'queued') stage = '<div class="app-card is-work"><strong><span class="spinner"></span>You’re in</strong><span class="app-sub">Confirming your order…</span></div>';
        if (u.stage === 'done') stage = '<div class="app-card is-ok"><strong>✓ Order placed</strong><span class="app-sub">Arriving Friday</span></div>';
        if (['failed', 'soldout', 'limit'].includes(u.stage)) stage = `<div class="app-card is-fail"><strong>✕ ${u.stage === 'soldout' ? 'Sold out' : u.stage === 'limit' ? 'Limit reached' : 'Something went wrong'}</strong></div>${Y.btn('back', u.stage === 'failed' ? 'Try again' : 'Back', { cls: 'secondary' })}`;
        Y.paint(el, sim, 'you', {
          head: '<div><p class="app-title">Amazon</p><p class="app-sub">Today’s deals</p></div>',
          product, stage, msg: Y.msg(u.message, u.tone),
        }, {
          claimed: st.stock === 0 && st.sale ? 'sold out' : `${claimed}% claimed`,
          bar: `${claimed}%`,
          pos: pos > 0 ? `Number ${pos.toLocaleString('en-US')} in line, about ${Math.ceil(pos / ADMIT(st))} s` : 'Admitted: checking out…',
        });

        const c = sim.scenario.consistency(sim);
        const wait = sim.queueWait(stockNode(st));
        const rows = st.config.buckets
          ? st.bucket.map((b, i) => `<div class="ops-row" data-tone="${b ? '' : 'fail'}"><div class="ops-name">Bucket ${i + 1}<span>${b} left</span></div></div>`).join('')
          : `<div class="ops-row" data-tone="${wait > 1000 ? 'fail' : wait > 300 ? 'warn' : ''}"><div class="ops-name">Stock row<span>${st.stock} left, queue <span data-live="rowq"></span></span></div></div>`;
        const bots = Object.entries(st.sold).filter(([a]) => a.startsWith('bot'));
        SDL.ui.paintSections(el.querySelector('[data-ref="console"]'), {
          title: '<p class="ops-title">Deal operations</p>',
          sale: `<div class="app-card"><span class="app-kv"><span>Sale</span><span>${st.sale ? (left > 0 ? `<span data-live="saleleft"></span> of demand left` : 'demand over') : 'not started'}</span></span>
            <span class="app-kv"><span>Demand</span><span>${esc(DEMAND[st.demand].label)}, ${DEMAND[st.demand].rate}/s</span></span>
            <span class="app-kv"><span>Attempts / timed out</span><span>${st.stats.attempts} / ${st.stats.timedOut}</span></span>
            <span class="app-kv"><span>Waiting room</span><span>${st.config.room ? (st.room.closed ? `closed, ${st.room.turnedAway} told “sold out”` : `${st.room.queue.length} in line`) : 'off'}</span></span>
            <span class="app-kv"><span>Intake queue</span><span>${st.config.async ? `${sim.queueStats('intake').depth} waiting` : 'off'}</span></span>
            <span class="app-kv"><span>Bot accounts / units</span><span>${bots.length} / ${bots.reduce((a, [, n]) => a + n, 0)}</span></span></div>`,
          stock: `<div class="ops-shards">${rows}</div>`,
          actions: `<div class="app-row">${Y.btn('demand', 'Steady', { arg: { level: 'calm' }, cls: st.demand === 'calm' ? '' : 'secondary' })}${Y.btn('demand', 'Viral', { arg: { level: 'crush' }, cls: st.demand === 'crush' ? '' : 'secondary' })}</div>
            <div class="app-row">${Y.btn('start', st.sale ? 'Restart the sale' : 'Start the sale')}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, { rowq: ms(wait), saleleft: `${(left / 1000).toFixed(1)} s` });
      },
    },
  });

  /** Take one unit for an order, from the single row or from a bucket (trying the others if it is empty). */
  function tryTake(ctx, p, start) {
    const st = ctx.state;
    if (st.stock <= 0) { st.soldOut = true; return null; }
    if (st.config.limit && st.limitRows[p.account]) return false; // unique key on (sale, account), same transaction
    if (start != null) {
      let i = start;
      for (let k = 0; k < 4 && st.bucket[i] <= 0; k++) i = (i + 1) % 4;
      st.bucket[i]--;
    }
    st.stock--;
    st.sold[p.account] = (st.sold[p.account] || 0) + 1;
    if (st.config.limit) st.limitRows[p.account] = true;
    if (p.kind === 'bot') st.stats.botUnits++;
    else st.stats.humanUnits++;
    if (p.deadline && ctx.now() > p.deadline) st.stats.ghost++;
    if (st.stock === 0) st.soldOut = true;
    return 'F' + ++st.seq.order;
  }
  function take(ctx, p, start) {
    const id = tryTake(ctx, p, start);
    if (id === false) ctx.fail('LIMIT', 'Limit one per customer: this account already has one.');
    if (!id) ctx.fail('SOLD_OUT', 'No units left.');
    return { order: id };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
