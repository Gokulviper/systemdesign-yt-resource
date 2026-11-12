/*
 * Order book and matching engine.
 * One instrument, one single-threaded engine, a live ladder drawn from the
 * feed. Every order goes gateway → sequencer → journal → engine; the engine
 * applies price-time priority (or pro-rata), self-trade prevention, and a
 * collar for market orders. Prices are integer cents at the gateway unless the
 * learner turns that off, in which case two prices that print the same can
 * differ by a few billionths of a cent and the book stops making sense.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const B = Y.book;

  const NAMES = { trader: 'You', nova: 'Nova Securities', quill: 'Quill Capital' };
  const FLOOD = 1500; // quote messages per second during a flood
  const COLLAR = 0.05;
  const QUOTE_LADDER = [[-1, 300], [-2, 200], [-3, 500], [1, 300], [2, 200], [3, 500]]; // ticks from $50.00 (negative = bids at 49.90…; positive = asks at 50.10 + …), see quotes()
  const disp = (px) => '$' + (Math.round(px) / 100).toFixed(2);

  /** Quill’s quotes in dollars: asks at 50.20, 50.30, 50.40 and bids at 49.90, 49.80, 49.70, built by repeated tick addition. */
  function quotes() {
    const out = [];
    let a = 50.1, b = 50.0;
    for (const [k, qty] of QUOTE_LADDER) {
      if (k > 0) { a += 0.1; out.push({ side: 'sell', px: a, qty }); } else { b -= 0.1; out.push({ side: 'buy', px: b, qty }); }
    }
    return out;
  }
  /** Gateway price normalisation: integer cents, or raw float cents when the switch is off. */
  const toTicks = (st, dollars) => (st.config.intTicks ? Math.round(dollars * 100) : dollars * 100);

  function startOrder(sim, owner, o, opts) {
    opts = opts || {};
    const st = sim.state;
    const tif = o.type === 'ioc' || o.type === 'fok' ? o.type : 'gtc';
    const label = `${NAMES[owner]}: ${o.side} ${o.qty} ${o.type === 'market' ? 'at market' : `${o.type.toUpperCase() === 'LIMIT' ? 'limit' : o.type.toUpperCase()} $${Number(o.px).toFixed(2)}`}`;
    return sim.startAction(label, function* (ctx) {
      const u = ctx.ui.trader;
      const clientOrderId = `${owner}-${++st.clientSeq}`;
      if (owner === 'trader') { u.pending = true; u.error = ''; }
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'Client order ids: the exchange rejects a replayed message.'] });
      const r = yield ctx.call('gateway', 'newOrder', { clientOrderId, owner, side: o.side, dollars: o.type === 'market' ? null : Number(o.px), qty: Number(o.qty), tif }, { timeout: 1200 });
      ctx.recordOutcome(r.ok, r.latency);
      if (owner === 'trader') u.pending = false;
      if (r.ok) {
        const v = r.value;
        if (owner === 'trader') { u.ackMs = r.latency; u.orders.push({ id: v.id, side: o.side, type: o.type, px: v.px, qty: Number(o.qty), filled: v.filled, avgPx: v.avgPx, status: v.status, reason: v.reason }); }
        Y.L(ctx, { displayed: 'yes', accepted: ['yes', `Sequence #${v.seq}.`], committed: ['yes', 'Journaled before the engine applied it.'], async: ['pending', 'Feed update to the ladder.'] });
        const ex = st.orders[v.id];
        if (v.status === 'filled' || v.status === 'partial') ctx.explain(`${v.filled} filled in ${ex.fills.length} fill${ex.fills.length === 1 ? '' : 's'} at an average of ${disp(v.avgPx)}${ex.swept > 1 ? `, sweeping ${ex.swept} price levels` : ''}${v.status === 'partial' ? `; ${Number(o.qty) - v.filled} ${tif === 'gtc' && o.type !== 'market' ? `rest at ${disp(v.px)}` : `cancelled (${v.reason})`}` : ''}.${ex.stp.length ? ` Self-trade prevention cancelled ${ex.stp.length} of ${NAMES[owner]}’s own resting order${ex.stp.length === 1 ? '' : 's'} instead of trading with ${ex.stp.length === 1 ? 'it' : 'them'}.` : ''}${ex.selfFills ? ` ${ex.selfFills} fill${ex.selfFills === 1 ? '' : 's'} matched ${NAMES[owner]}’s own resting order: a wash trade.` : ''}`);
        else if (v.status === 'resting') ctx.explain(`Nothing on the other side crosses ${disp(v.px)}, so the order rests at sequence #${v.seq}. At one price, earlier sequence numbers fill first.${ex.stp.length ? ` Self-trade prevention first cancelled ${NAMES[owner]}’s own resting order at that price.` : ''}`);
        else ctx.explain(`Cancelled: ${v.reason}. ${tif === 'fok' ? 'Fill-or-kill checks the whole quantity before touching the book, so nothing traded.' : tif === 'ioc' ? 'Immediate-or-cancel takes what is there and never rests.' : 'A market order never rests.'}`);
      } else {
        if (owner === 'trader') { u.error = r.error.code === 'TIMEOUT' ? 'No answer in time. The order may be in the book: check before resending.' : `Rejected: ${r.error.message}`; if (r.error.code === 'TIMEOUT') u.orders.push({ id: clientOrderId, side: o.side, type: o.type, px: o.px == null ? null : toTicks(st, Number(o.px)), qty: Number(o.qty), filled: 0, avgPx: 0, status: 'unknown', reason: 'no reply' }); }
        Y.failed(ctx, 'The terminal shows an error.');
        ctx.explain(r.error.code === 'TIMEOUT' ? `The engine is a single thread and ${Y.num(FLOOD)} quote messages a second are queued in front of this order. It was sequenced and will be applied in its turn, but the gateway gave up waiting: the terminal must query the order’s state, not resend.` : `Rejected: ${r.error.message}`);
      }
      if (opts.then) opts.then();
    }, { self: owner });
  }

  function startCancelAll(sim, owner, keep) {
    const st = sim.state;
    const ids = Object.values(st.orders).filter((o) => o.owner === owner && ['resting', 'partial'].includes(o.status) && (!keep || !keep(o))).map((o) => o.id);
    if (!ids.length) return;
    sim.startAction(`${NAMES[owner]}: cancel ${ids.length} resting order${ids.length === 1 ? '' : 's'}`, function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const procs = ids.map((id) => ctx.spawn(function* (c) { return yield c.call('gateway', 'cancel', { orderId: id, owner }, { timeout: 1200 }); }));
      yield ctx.join(procs);
      Y.L(ctx, { accepted: 'yes', committed: 'yes', async: 'pending' });
    }, { self: owner });
  }

  /** Quill cancels everything and re-enters its six quotes: a clean book for each scenario. */
  function startRequote(sim) {
    const st = sim.state;
    sim.startAction('Quill: requote both sides', function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const ids = Object.values(st.orders).filter((o) => o.owner === 'quill' && ['resting', 'partial'].includes(o.status)).map((o) => o.id);
      yield ctx.join(ids.map((id) => ctx.spawn(function* (c) { return yield c.call('gateway', 'cancel', { orderId: id, owner: 'quill' }, { timeout: 1200, quiet: true }); })));
      yield ctx.join(quotes().map((q) => ctx.spawn(function* (c) { return yield c.call('gateway', 'newOrder', { clientOrderId: `quill-${++st.clientSeq}`, owner: 'quill', side: q.side, dollars: q.px, qty: q.qty, tif: 'gtc' }, { timeout: 1200, quiet: true }); })));
      Y.L(ctx, { accepted: 'yes', committed: 'yes', async: 'pending' });
      ctx.explain(st.config.intTicks ? 'Six quotes entered as integer cents: $49.70 to $50.40.' : 'Six quotes entered as floating-point dollars built by adding 0.1 repeatedly. The fourth step gives 50.400000000000006, which the gateway did not round, so it is not equal to a typed 50.40.');
    }, { self: 'quill' });
  }

  function setFlood(sim, on) { sim.state.flood = on; sim.note(on ? `Quill starts sending ${Y.num(FLOOD)} quote updates a second.` : 'The quote flood is over.'); }

  function rebuild(sim) {
    const st = sim.state;
    const book = B.create();
    for (const e of st.journal) {
      if (e.type === 'order') B.match(book, { id: e.id, owner: e.owner, side: e.side, px: e.px, qty: e.qty, tif: e.tif, seq: e.seq }, e.opts || {});
      else B.remove(book, e.orderId);
    }
    st.book = book;
    st.stats.rebuilds++;
    sim.note(`Engine restarted: replayed ${st.journal.length} journal entries and rebuilt the same book (deterministic replay).`);
    publish(sim, null);
  }

  function publish(sim, ctxOrNull, trades) {
    const st = sim.state;
    const snap = { seq: st.seq, bids: B.levels(st.book, 'buy', 5), asks: B.levels(st.book, 'sell', 5), last: st.last, trades: trades || [] };
    const go = function* (c) { const r = yield c.call('mdpub', 'publish', snap, { timeout: 300, quiet: true }); if (!r.ok) st.stats.mdFailed++; };
    if (ctxOrNull) ctxOrNull.spawn(go); else sim.spawn(go, { self: 'engine', quiet: true });
  }

  const sc = (SDL.scenarios['ex-matching'] = {
    id: 'ex-matching',
    seed: 1203,
    productWidth: 600,
    intro: 'Enter a limit, market, IOC, or FOK order against Quill’s quotes and read the ladder. Then switch to pro-rata, turn self-trade prevention off, or let the gateway stop rounding prices to cents.',
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'trader', label: 'Your terminal', kind: 'client', sub: 'Member session', x: 90, y: 120, latency: 1, role: 'Sends your orders and draws the ladder from the feed.', owns: ['What you see'] },
        { id: 'nova', label: 'Nova Securities', kind: 'client', sub: 'Another member', x: 90, y: 300, latency: 1, role: 'A second member whose orders test priority against yours.', owns: ['Its orders'] },
        { id: 'quill', label: 'Quill Capital', kind: 'client', sub: 'Market maker', x: 90, y: 470, latency: 1, role: 'Quotes six levels and can flood the engine with quote updates.', owns: ['Its quotes'] },
        { id: 'gateway', label: 'Order entry gateway', kind: 'gateway', sub: 'Validates, normalises prices', x: 330, y: 300, latency: 1, role: 'Validates each message, converts dollars to integer ticks, rejects replays by client order id, forwards to the sequencer.', ops: [{ name: 'newOrder', desc: 'Validate and forward.' }, { name: 'cancel', desc: 'Cancel request.' }, { name: 'report', desc: 'Execution report to the owner.' }], owns: ['Sessions'] },
        { id: 'sequencer', label: 'Sequencer', kind: 'service', sub: 'Stamps and journals', x: 560, y: 300, latency: 1, role: 'Assigns the next sequence number, appends to the journal, then hands the message to the engine.', ops: [{ name: 'submit', desc: 'Sequence, journal, apply.' }], owns: ['Sequence counter'] },
        { id: 'journal', label: 'Journal', kind: 'store', sub: 'Append-only log', x: 560, y: 470, latency: 5, role: 'Every sequenced message. The book is rebuilt from it after a crash.', ops: [{ name: 'append', desc: 'Durable write.' }], owns: ['Sequenced messages'] },
        { id: 'engine', label: 'Matching engine', kind: 'worker', sub: 'Single thread, in memory', x: 790, y: 300, latency: 1, serviceMs: 1, role: 'Applies each message to the book: price-time (or pro-rata) matching, self-trade prevention, collars. One thread per instrument: no locks, every outcome reproducible.', ops: [{ name: 'process', desc: 'Apply one message.' }], owns: ['The book'] },
        { id: 'mdpub', label: 'Market data publisher', kind: 'service', sub: 'Book snapshots and trades', x: 790, y: 120, latency: 1, role: 'Publishes the top five levels and each trade with the sequence number.', ops: [{ name: 'publish', desc: 'Publish a book change.' }], owns: ['Nothing durable'] },
        { id: 'tape', label: 'Feed', kind: 'queue', sub: 'Book and tape', x: 560, y: 120, latency: 1, queue: 'feed', role: 'The feed your terminal draws from.', ops: [], owns: ['Feed messages'] },
      ],
      edges: [
        { from: 'trader', to: 'gateway', latency: 1, via: [[200, 120], [200, 300]] },
        { from: 'nova', to: 'gateway', latency: 1 },
        { from: 'quill', to: 'gateway', latency: 1, via: [[200, 470], [200, 300]] },
        { from: 'gateway', to: 'sequencer', latency: 1 },
        { from: 'sequencer', to: 'journal', latency: 1, label: 'append' },
        { from: 'sequencer', to: 'engine', latency: 1 },
        { from: 'engine', to: 'mdpub', latency: 1 },
        { from: 'engine', to: 'gateway', latency: 1, label: 'exec reports', via: [[790, 390], [440, 390]] },
        { from: 'mdpub', to: 'tape', latency: 1 },
        { from: 'tape', to: 'trader', latency: 2, label: 'feed' },
      ],
      queues: [{ id: 'feed', broker: 'tape', label: 'feed', groups: ['trader'] }],
    },
    modeLabels: { replay: 'Replaying messages' },
    failures: [
      { id: 'engine-slow', node: 'engine', mode: 'slow', params: { factor: 80 }, label: 'Engine slow', desc: 'Every message waits behind the one before it.' },
      { id: 'engine-crash', node: 'engine', mode: 'crashed', label: 'Engine crash', desc: 'On restart the book is rebuilt from the journal.' },
      { id: 'gateway-replay', node: 'gateway', mode: 'replay', label: 'Gateway replays messages', desc: 'Each order is forwarded twice; the sequencer must reject the second copy.' },
      { id: 'tape-paused', node: 'trader', mode: 'paused', label: 'Terminal stops reading the feed', desc: 'The ladder freezes while the book moves.' },
      { id: 'journal-slow', node: 'journal', mode: 'slow', params: { factor: 30 }, label: 'Journal slow', desc: 'Acks wait for the disk.' },
      { id: 'mdpub-down', node: 'mdpub', mode: 'down', label: 'Publisher down', desc: 'Trades happen; the ladder goes stale.' },
    ],
    switches: Y.switches([
      ['prorata', 'Pro-rata allocation', 'At one price, fills are shared in proportion to resting size. Off: price-time priority, earliest first.'],
      ['stp', 'Self-trade prevention', 'A member’s order never trades with that member’s own resting order; the resting one is cancelled instead. Off: wash trades happen.'],
      ['intTicks', 'Integer ticks at the gateway', 'Prices are converted to whole cents before sequencing. Off: floating-point dollars go straight into the book.'],
      ['collar', 'Collar on market orders', `A market order stops filling more than ${COLLAR * 100}% away from the last trade; the rest is cancelled. Off: it sweeps whatever is there.`],
    ]),
    presets: Y.presets({ prorata: false, stp: true, intTicks: true, collar: true }, [
      { id: 'rest', label: 'Limit order rests', desc: 'Buy 100 at $50.00: nobody sells that low, so it rests and becomes the best bid.', run: (s) => { startRequote(s); s.schedule(1200, () => startOrder(s, 'trader', { side: 'buy', type: 'limit', px: 50.0, qty: 100 })); } },
      { id: 'walk', label: 'Limit order walks the book', desc: 'Buy 600 at $50.35: 300 at $50.20, 200 at $50.30, and the last 100 rest at $50.35 as the new best bid.', run: (s) => { startRequote(s); s.schedule(1200, () => startOrder(s, 'trader', { side: 'buy', type: 'limit', px: 50.35, qty: 600 })); } },
      { id: 'market', label: 'Market order, more than the book holds', desc: 'Buy 1,200 at market: 1,000 fill across three levels; the rest is cancelled, because a market order never rests.', run: (s) => { startRequote(s); s.schedule(1200, () => startOrder(s, 'trader', { side: 'buy', type: 'market', qty: 1200 })); } },
      { id: 'fok', label: 'Fill-or-kill with too little depth', desc: 'FOK buy 1,200 at $50.30: only 500 shares are available at or below the limit, so nothing trades.', run: (s) => { startRequote(s); s.schedule(1200, () => startOrder(s, 'trader', { side: 'buy', type: 'fok', px: 50.3, qty: 1200 })); } },
      { id: 'ioc', label: 'Immediate-or-cancel', desc: 'IOC buy 400 at $50.20: 300 fill, 100 are cancelled rather than rest.', run: (s) => { startRequote(s); s.schedule(1200, () => startOrder(s, 'trader', { side: 'buy', type: 'ioc', px: 50.2, qty: 400 })); } },
      { id: 'priority', label: 'Same price, earlier first', desc: 'Your sell joins Quill’s 300 at $50.20 behind it. Nova buys 350: Quill gets 300, you get 50.', run: (s) => { startRequote(s); s.schedule(1200, () => startOrder(s, 'trader', { side: 'sell', type: 'limit', px: 50.2, qty: 100 })); s.schedule(2400, () => startOrder(s, 'nova', { side: 'buy', type: 'limit', px: 50.2, qty: 350 })); } },
      { id: 'prorata', label: 'Same price, pro-rata', desc: 'Same orders under pro-rata: Nova’s 350 is split 263 to Quill and 87 to you, by resting size rather than by arrival.', sw: { prorata: true }, run: (s) => { startRequote(s); s.schedule(1200, () => startOrder(s, 'trader', { side: 'sell', type: 'limit', px: 50.2, qty: 100 })); s.schedule(2400, () => startOrder(s, 'nova', { side: 'buy', type: 'limit', px: 50.2, qty: 350 })); } },
      { id: 'stp', label: 'Self-trade prevented', desc: 'Quill buys 100 at $50.20 while its own 300 rests there. Prevention cancels the resting ask; the buy rests as the new best bid.', run: (s) => { startRequote(s); s.schedule(1200, () => startOrder(s, 'quill', { side: 'buy', type: 'limit', px: 50.2, qty: 100 })); } },
      { id: 'stp-off', label: 'Self-trade allowed', desc: 'Same order with prevention off: Quill trades with itself. A wash trade prints on the tape.', sw: { stp: false }, run: (s) => { startRequote(s); s.schedule(1200, () => startOrder(s, 'quill', { side: 'buy', type: 'limit', px: 50.2, qty: 100 })); } },
      { id: 'float', label: 'Floating-point prices', desc: 'Without rounding, Quill’s $50.40 is 50.400000000000006 and yours is 50.4. Your later sell sorts ahead of Quill’s 500, Nova’s buy at $50.40 fills you and skips Quill, and Nova’s remainder rests as a bid at $50.40 under an ask that prints as $50.40.', sw: { intTicks: false }, run: (s) => { startRequote(s); s.schedule(1200, () => startOrder(s, 'trader', { side: 'sell', type: 'limit', px: 50.4, qty: 100 })); s.schedule(2400, () => startOrder(s, 'nova', { side: 'buy', type: 'limit', px: 50.4, qty: 650 })); } },
      { id: 'sweep', label: 'Thin book, market order with a collar', desc: 'Quill pulls its asks and leaves 500 at $60.00. Your market buy of 400 takes 300 at $50.20 and stops: $60 is 19% away, so the last 100 are cancelled.', run: (s) => { startRequote(s); s.schedule(1200, () => { startCancelAll(s, 'quill', (o) => o.side === 'buy' || Math.round(o.px) === 5020); startOrder(s, 'quill', { side: 'sell', type: 'limit', px: 60.0, qty: 500 }); }); s.schedule(2600, () => startOrder(s, 'trader', { side: 'buy', type: 'market', qty: 400 })); } },
      { id: 'sweep-bad', label: 'Thin book, market order, no collar', desc: 'Same book without a collar: the last 100 fill at $60.00. Legal, and the kind of print that makes headlines.', sw: { collar: false }, run: (s) => { startRequote(s); s.schedule(1200, () => { startCancelAll(s, 'quill', (o) => o.side === 'buy' || Math.round(o.px) === 5020); startOrder(s, 'quill', { side: 'sell', type: 'limit', px: 60.0, qty: 500 }); }); s.schedule(2600, () => startOrder(s, 'trader', { side: 'buy', type: 'market', qty: 400 })); } },
      { id: 'flood', label: 'Quote flood on the single thread', desc: `Quill sends ${Y.num(FLOOD)} quote updates a second. Your order is sequenced but waits in the engine’s queue; the gateway times out and the terminal does not know whether it is in the book.`, run: (s) => { startRequote(s); s.schedule(900, () => setFlood(s, true)); s.schedule(2400, () => startOrder(s, 'trader', { side: 'buy', type: 'limit', px: 50.0, qty: 100 })); s.schedule(12000, () => setFlood(s, false)); } },
      { id: 'crash', label: 'Engine crash and deterministic replay', desc: 'Your order rests, the engine crashes, and the restarted engine replays the journal into the same book. Nothing is lost because the journal was written first.', run: (s) => { startRequote(s); s.schedule(1200, () => startOrder(s, 'trader', { side: 'buy', type: 'limit', px: 50.0, qty: 100 })); s.schedule(2200, () => s.inject('engine', 'crashed', true, 1500)); } },
    ]),
    initialState: () => {
      // The book opens with Quill's six quotes already sequenced and journaled (integer cents).
      const st = {
        config: { prorata: false, stp: true, intTicks: true, collar: true },
        book: B.create(), seq: 0, clientSeq: 0, orders: {}, journal: [], seen: {}, trades: [], last: 5020, flood: false,
        stats: { fills: 0, selfTrades: 0, stpCancels: 0, priorityViolations: 0, outsideCollar: 0, collarStops: 0, replaysRejected: 0, rebuilds: 0, mdFailed: 0, floodDone: 0, floodTimeouts: 0 },
      };
      for (const q of quotes()) {
        const seq = ++st.seq;
        const id = 'O' + seq;
        const px = Math.round(q.px * 100);
        const clientOrderId = `quill-${++st.clientSeq}`;
        st.journal.push({ seq, t: 0, type: 'order', clientOrderId, owner: 'quill', side: q.side, px, qty: q.qty, tif: 'gtc', flood: false, id, opts: { prorata: false, stp: true } });
        st.seen[`quill/${clientOrderId}`] = id;
        st.orders[id] = { id, owner: 'quill', side: q.side, px, qty: q.qty, tif: 'gtc', filled: 0, avgPx: 0, status: 'resting', seq, fills: [], stp: [], selfFills: 0, swept: 0 };
        B.rest(st.book, { id, owner: 'quill', side: q.side, px, qty: q.qty, remaining: q.qty, tif: 'gtc', seq });
      }
      return st;
    },
    initialUI: () => ({
      trader: { pending: false, error: '', orders: [], ackMs: null, book: { seq: 6, bids: [{ px: 4990, qty: 300, n: 1 }, { px: 4980, qty: 200, n: 1 }, { px: 4970, qty: 500, n: 1 }], asks: [{ px: 5020, qty: 300, n: 1 }, { px: 5030, qty: 200, n: 1 }, { px: 5040, qty: 500, n: 1 }], last: 5020 }, tape: [] },
      ticket: { side: 'buy', type: 'limit', px: '50.00', qty: '100' },
    }),
    actions: {
      submit(sim) { const t = sim.ui.ticket; startOrder(sim, 'trader', { side: t.side, type: t.type, px: t.px, qty: t.qty }); },
      nova(sim, a) { startOrder(sim, 'nova', a); },
      quill(sim, a) { startOrder(sim, 'quill', a); },
      requote(sim) { startRequote(sim); },
      pull(sim) { startCancelAll(sim, 'quill', (o) => o.side === 'buy' || Math.round(o.px) === 5020); startOrder(sim, 'quill', { side: 'sell', type: 'limit', px: 60.0, qty: 500 }); },
      flood(sim, a) { setFlood(sim, !!a.on); },
      set: Y.setAction,
    },
    handlers: {
      gateway: {
        newOrder: function* (ctx, p) {
          const st = ctx.state;
          if (!(p.qty > 0)) ctx.fail('INVALID', 'Quantity must be positive.');
          if (p.dollars != null && !(p.dollars > 0)) ctx.fail('INVALID', 'Price must be positive.');
          const msg = { type: 'order', clientOrderId: p.clientOrderId, owner: p.owner, side: p.side, px: p.dollars == null ? null : toTicks(st, p.dollars), qty: p.qty, tif: p.tif, flood: !!p.flood };
          const r = ctx.must(yield ctx.call('sequencer', 'submit', msg, { timeout: 1000 }));
          if (ctx.mode('replay')) {
            const d = yield ctx.call('sequencer', 'submit', msg, { timeout: 1000 });
            ctx.log({ op: 'message replayed', status: d.ok ? 'warn' : 'dup', detail: d.ok ? 'The second copy was accepted: a duplicate order.' : `The second copy was rejected: ${d.error.message}` });
          }
          return r;
        },
        cancel: function* (ctx, p) { return ctx.must(yield ctx.call('sequencer', 'submit', { type: 'cancel', orderId: p.orderId, owner: p.owner }, { timeout: 1000 })); },
        report: function* (ctx, p) { return ctx.must(yield ctx.call('trader', 'report', p, { timeout: 400 })); },
      },
      trader: {
        report(ctx, p) { const o = ctx.ui.trader.orders.find((x) => x.id === p.orderId); if (o) Object.assign(o, { status: p.status, filled: p.filled, avgPx: p.avgPx, reason: p.reason || o.reason }); return { ok: true }; },
      },
      sequencer: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          if (p.type === 'order') {
            const k = `${p.owner}/${p.clientOrderId}`;
            if (st.seen[k]) { st.stats.replaysRejected++; ctx.fail('DUPLICATE', `Client order id ${p.clientOrderId} was already sequenced as ${st.seen[k]}.`); }
          }
          const seq = ++st.seq;
          const entry = Object.assign({ seq, t: ctx.now() }, p, p.type === 'order' ? { id: 'O' + seq, opts: { prorata: st.config.prorata, stp: st.config.stp } } : {});
          if (p.type === 'order') st.seen[`${p.owner}/${p.clientOrderId}`] = entry.id;
          ctx.must(yield ctx.call('journal', 'append', { entry }, { timeout: 600 }));
          return ctx.must(yield ctx.call('engine', 'process', { entry }, { timeout: 400 }));
        },
      },
      journal: { append(ctx, p) { ctx.state.journal.push(p.entry); return { seq: p.entry.seq }; } },
      engine: {
        process(ctx, p) {
          const st = ctx.state;
          const e = p.entry;
          if (e.type === 'cancel') {
            const o = st.orders[e.orderId];
            if (!o) ctx.fail('UNKNOWN', 'No such order.');
            if (!['resting', 'partial'].includes(o.status)) ctx.fail('TOO_LATE', `Order is already ${o.status}.`);
            B.remove(st.book, o.id);
            o.status = 'cancelled';
            publish(ctx.sim, ctx);
            return { id: o.id, status: 'cancelled' };
          }
          const rec = { id: e.id, owner: e.owner, side: e.side, px: e.px, qty: e.qty, tif: e.tif, filled: 0, avgPx: 0, status: 'new', seq: e.seq, fills: [], stp: [], selfFills: 0, swept: 0 };
          st.orders[rec.id] = rec;
          const opts = { prorata: st.config.prorata, stp: st.config.stp };
          if (st.config.collar && e.px == null) opts.collar = { ref: st.last, pct: COLLAR };
          // Snapshot the opposite side so time-priority violations can be detected after the match.
          const before = (e.side === 'buy' ? st.book.asks : st.book.bids).map((m) => ({ id: m.id, px: m.px, seq: m.seq, remaining: m.remaining }));
          const res = B.match(st.book, { id: rec.id, owner: e.owner, side: e.side, px: e.px, qty: e.qty, tif: e.tif, seq: e.seq }, opts);
          const levels = new Set();
          const newTrades = [];
          for (const f of res.fills) {
            const m = st.orders[f.makerId];
            levels.add(f.px);
            rec.avgPx = Math.round((rec.avgPx * rec.filled + f.px * f.qty) / (rec.filled + f.qty)); rec.filled += f.qty;
            if (m) { m.avgPx = Math.round((m.avgPx * m.filled + f.px * f.qty) / (m.filled + f.qty)); m.filled += f.qty; m.status = m.filled >= m.qty ? 'filled' : 'partial'; }
            const trade = { id: 'T' + (st.trades.length + 1), px: f.px, qty: f.qty, maker: f.makerOwner, taker: e.owner, seq: e.seq, self: f.makerOwner === e.owner, outside: Math.abs(f.px - st.last) > st.last * COLLAR };
            st.trades.push(trade);
            st.stats.fills++;
            if (trade.self) { st.stats.selfTrades++; rec.selfFills++; }
            if (trade.outside) st.stats.outsideCollar++;
            // Time priority: an earlier order at the same displayed price must not still be waiting while a later one filled.
            if (!st.config.prorata) for (const b of before) { if (b.id !== f.makerId && Math.round(b.px) === Math.round(f.px) && b.seq < (m ? m.seq : Infinity) && st.book.byId[b.id] && st.book.byId[b.id].remaining > 0) { st.stats.priorityViolations++; ctx.log({ op: 'priority violated', status: 'warn', detail: `${f.makerId} (#${m.seq}) filled at ${disp(f.px)} while ${b.id} (#${b.seq}) at the same displayed price still waits. Their prices differ by ${Math.abs(b.px - f.px).toExponential(1)} cents.` }); break; } }
            rec.fills.push(f);
            newTrades.push(trade);
            st.last = f.px;
          }
          for (const id of res.stp) { const m = st.orders[id]; if (m) m.status = 'cancelled'; rec.stp.push(id); st.stats.stpCancels++; }
          const reports = res.fills.map((f) => st.orders[f.makerId]).filter((m) => m && m.owner === 'trader').map((m) => ({ orderId: m.id, status: m.status, filled: m.filled, avgPx: m.avgPx }));
          for (const id of res.stp) { const m = st.orders[id]; if (m && m.owner === 'trader') reports.push({ orderId: m.id, status: 'cancelled', filled: m.filled, avgPx: m.avgPx, reason: 'self-trade prevention' }); }
          if (reports.length) ctx.spawn(function* (c) { for (const rp of reports) yield c.call('gateway', 'report', rp, { timeout: 600 }); });
          if (res.reason && /collar/.test(res.reason)) st.stats.collarStops++;
          rec.swept = levels.size;
          rec.status = res.status; rec.reason = res.reason;
          if (!e.flood) ctx.log({ op: `#${e.seq} ${e.owner} ${e.side} ${e.qty} ${e.px == null ? 'market' : disp(e.px)} ${e.tif !== 'gtc' ? e.tif.toUpperCase() + ' ' : ''}→ ${res.status}`, status: 'ok', detail: res.fills.length ? `${res.fills.map((f) => `${f.qty} @ ${disp(f.px)} vs ${f.makerId}`).join(', ')}${res.remaining ? `; ${res.remaining} ${res.status === 'partial' && e.tif === 'gtc' && e.px != null ? 'rest' : 'cancelled'}` : ''}.` : res.reason || 'Rests in the book.' });
          if (!e.flood) publish(ctx.sim, ctx, newTrades);
          return { id: rec.id, seq: e.seq, px: rec.px, status: rec.status, filled: rec.filled, avgPx: rec.avgPx, reason: rec.reason };
        },
      },
      mdpub: { publish(ctx, p) { ctx.sim.enqueue('feed', { type: 'book', eventId: 'f' + p.seq + '-' + ctx.sim.now, payload: p }); return { ok: true }; } },
    },
    setup(sim) {
      Y.consumer(sim, 'feed', 'trader', 'trader', function* (ctx, msg) {
        const u = ctx.ui.trader;
        if (msg.payload.seq >= u.book.seq) u.book = msg.payload;
        for (const t of msg.payload.trades) u.tape.unshift(t);
        u.tape = u.tape.slice(0, 6);
        return true;
      });
      Y.load(sim, 'quill', (s) => (s.state.flood ? FLOOD : 0), function* (ctx, i) {
        const st = ctx.state;
        const r = yield ctx.call('gateway', 'newOrder', { clientOrderId: `flood-${i}`, owner: 'quill', side: 'buy', dollars: 49.0, qty: 10, tif: 'ioc', flood: true }, { timeout: 1000, quiet: 'all' });
        if (r.ok) st.stats.floodDone++; else st.stats.floodTimeouts++;
      });
    },
    onFailureChange(sim, ch) { if (ch.node === 'engine' && ch.mode === 'crashed' && !ch.active) rebuild(sim); },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.trader;
      if (st.stats.selfTrades) return { key: 'wrong', label: `${st.stats.selfTrades} wash trade${st.stats.selfTrades === 1 ? '' : 's'}: a member traded with its own resting order and a fake print went to the tape.` };
      if (st.stats.priorityViolations) return { key: 'wrong', label: 'Time priority was violated: a later order at the same displayed price filled while an earlier one waited. Two floating-point prices print the same and are not equal.' };
      const best = B.best(st.book);
      if (best.bid != null && best.ask != null && Math.round(best.bid) >= Math.round(best.ask)) return { key: 'wrong', label: `The ladder shows bid ${disp(best.bid)} and ask ${disp(best.ask)} that never trade: the prices differ by ${(best.ask - best.bid).toExponential(1)} cents.` };
      for (const side of ['buy', 'sell']) { const lv = B.levels(st.book, side); for (let i = 1; i < lv.length; i++) if (Math.round(lv[i].px) === Math.round(lv[i - 1].px)) return { key: 'wrong', label: `Two ${side === 'buy' ? 'bid' : 'ask'} levels both print as ${disp(lv[i].px)}: floating-point prices split one level in two.` }; }
      if (u.pending) return { key: 'stale', label: 'Your order is in flight.' };
      const unknown = u.orders.find((o) => o.status === 'unknown');
      if (unknown) { const ex = Object.values(st.orders).find((o) => o.owner === 'trader' && o.seq && !u.orders.some((x) => x.id === o.id)); return { key: 'stale', label: `Your terminal does not know what happened to ${unknown.id}; the exchange ${ex ? `has it as #${ex.seq}, ${ex.status}` : 'will apply it when the engine gets to it'}. Query, do not resend.` }; }
      if (u.error) return { key: 'stale', label: `Your order failed: ${u.error}` };
      if (sim.nodes.engine.modes.crashed) return { key: 'stale', label: 'The engine is down. The journal has every message; the book comes back on restart.' };
      if (st.stats.outsideCollar) return { key: 'stale', label: `${st.stats.outsideCollar} trade${st.stats.outsideCollar === 1 ? '' : 's'} printed more than ${COLLAR * 100}% from the last price. Legal, harmful, and exactly what a collar prevents.` };
      if (u.book.seq < st.seq) return { key: 'stale', label: `Your ladder is at #${u.book.seq}; the book is at #${st.seq}.` };
      return { key: 'ok', label: 'The ladder matches the book, every fill respected price-time priority, and nothing traded with itself.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const u = sim.ui.trader;
      const w = sim.queueWait('engine');
      const depth = st.book.bids.length + st.book.asks.length;
      return [
        { label: 'Order to ack', value: u.ackMs == null ? '–' : SDL.fmtMs(u.ackMs), tone: u.ackMs > 500 ? 'warn' : '' },
        { label: 'Engine queue', value: SDL.fmtMs(w), tone: w > 300 ? 'fail' : w > 50 ? 'warn' : '' },
        { label: 'Resting orders', value: depth },
        { label: 'Fills', value: st.stats.fills },
        { label: 'Last trade', value: disp(st.last) },
        { label: 'Self-trades prevented', value: st.stats.stpCancels },
        { label: 'Replays rejected', value: st.stats.replaysRejected },
        { label: 'Flood messages applied', value: Y.num(st.stats.floodDone), tone: st.stats.floodTimeouts ? 'warn' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [], {
          note: 'Your terminal: the ladder on the left is drawn from the feed; the ticket on the right sends to the gateway. Nova and Quill are other members.',
          below: `<div class="ops-console"><p class="ops-title">ACME ladder</p><div data-ref="ladder"></div></div>
            <div class="ops-console"><p class="ops-title">Order ticket</p>
              <div class="ops-traffic">
                <label class="field-inline">Side <select data-field="ticket.side"><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
                <label class="field-inline">Type <select data-field="ticket.type"><option value="limit">Limit</option><option value="market">Market</option><option value="ioc">IOC</option><option value="fok">FOK</option></select></label>
                <label class="field-inline">Price <input data-field="ticket.px" type="number" step="0.01" min="0.01" value="50.00" style="width:5.5em"></label>
                <label class="field-inline">Qty <input data-field="ticket.qty" type="number" step="100" min="1" value="100" style="width:5em"></label>
                ${Y.btn('submit', 'Send order', { cls: 'go' })}
              </div>
              <div data-ref="mine"></div>
            </div>
            <div class="ops-console"><p class="ops-title">Other members</p><div class="ops-traffic">${Y.btn('nova', 'Nova buys 350 @ $50.20', { arg: { side: 'buy', type: 'limit', px: 50.2, qty: 350 }, cls: 'secondary' })}${Y.btn('quill', 'Quill buys 100 @ $50.20', { arg: { side: 'buy', type: 'limit', px: 50.2, qty: 100 }, cls: 'secondary' })}${Y.btn('requote', 'Quill requotes', { cls: 'secondary' })}${Y.btn('pull', 'Quill pulls asks (leaves $50.20 and $60)', { cls: 'secondary' })}${Y.btn('flood', 'Start quote flood', { arg: { on: true } })}${Y.btn('flood', 'Stop flood', { arg: { on: false }, cls: 'secondary' })}</div><div data-ref="recon"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.trader;
        const maxQ = Math.max(1, ...u.book.bids.map((l) => l.qty), ...u.book.asks.map((l) => l.qty));
        const row = (side, l) => `<div class="ops-row" data-tone="${side === 'sell' ? 'fail' : 'ok'}"><div class="ops-name">${side === 'sell' ? 'Ask' : 'Bid'} ${disp(l.px)}<span>${l.qty} sh · ${l.n} order${l.n === 1 ? '' : 's'}</span></div><span class="cap-track" style="flex:1;max-width:40%"><i style="width:${(l.qty / maxQ) * 100}%"></i></span></div>`;
        SDL.ui.paintSections(el.querySelector('[data-ref="ladder"]'), {
          ladder: `<div class="ops-shards">${u.book.asks.slice().reverse().map((l) => row('sell', l)).join('') || '<p class="app-sub">no asks</p>'}<p class="app-sub">last ${disp(u.book.last)} · feed #${u.book.seq}${u.book.seq < st.seq ? ` · book at #${st.seq}` : ''}</p>${u.book.bids.map((l) => row('buy', l)).join('') || '<p class="app-sub">no bids</p>'}</div>`,
          tape: `<p class="app-sub">Tape: ${u.tape.map((t) => `${t.qty} @ ${disp(t.px)} (${NAMES[t.taker]} ← ${NAMES[t.maker]})${t.self ? ' ✕ self' : ''}`).join(' · ') || 'no trades yet'}</p>`,
        }, {});
        const mine = u.orders.slice(-3).reverse().map((o) => `<div class="app-card ${o.status === 'filled' ? 'is-ok' : o.status === 'unknown' ? 'is-fail' : ''}"><span class="app-kv"><strong>${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.qty} ${o.px == null ? 'market' : disp(o.px)}${o.type !== 'limit' && o.type !== 'market' ? ' ' + o.type.toUpperCase() : ''}</strong><span>${esc(o.status)}</span></span><span class="app-sub">${o.filled ? `${o.filled} filled @ ${disp(o.avgPx)}` : ''}${o.reason ? ` ${esc(o.reason)}` : ''}</span></div>`).join('');
        SDL.ui.paintSections(el.querySelector('[data-ref="mine"]'), {
          msg: u.pending ? '<p class="app-sub"><span class="spinner"></span>Sending…</p>' : Y.msg(u.error, 'fail'),
          mine: mine ? `<p class="app-sub">Your orders${u.ackMs != null ? ` · last ack ${Math.round(u.ackMs)} ms` : ''}</p>${mine}` : '<p class="app-sub">No orders yet.</p>',
        }, {});
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="recon"]'), {
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
