/*
 * Stock exchange: place an order end to end.
 * Maya and Dev trade ACME through their broker. The broker sends each order to
 * the exchange gateway, which checks risk and hands the message to the
 * sequencer. The sequencer stamps it with the next sequence number, writes it
 * to the journal, and only then lets the single-threaded matching engine apply
 * it. Fills come back as execution reports, go out to everyone as market data,
 * and flow through trade capture into clearing. Prices are integer cents.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const B = Y.book;

  const NAMES = { maya: 'Maya', dev: 'Dev', quill: 'Quill Capital' };
  const REF_PX = 5020; // reference price used by risk for market orders
  const JOURNAL_BATCH_MS = 600; // how long the sequencer waits to batch journal writes when it acks first
  const px = (c) => '$' + (c / 100).toFixed(2);

  const view = (o) => ({ id: o.id, side: o.side, type: o.type, px: o.px, qty: o.qty, filled: o.filled, avgPx: o.avgPx, status: o.status, reason: o.reason || '', exchangeId: o.exchangeId || null });
  const upsert = (list, v) => { const i = list.findIndex((x) => x.id === v.id); if (i >= 0) list[i] = v; else list.push(v); };

  function startOrder(sim, account, order) {
    const st = sim.state;
    const label = `${NAMES[account]}: ${order.side} ${order.qty} ACME ${order.type === 'market' ? 'at market' : `limit ${px(order.px)}`}`;
    sim.startAction(label, function* (ctx) {
      const u = ctx.ui[account];
      const tap = { account, side: order.side, qty: order.qty, brokerOrders: [] };
      st.taps.push(tap);
      const clientOrderId = `${account}-${st.taps.length}`;
      u.pending = true; u.error = '';
      Y.L(ctx, {
        displayed: ['pending', 'The ticket shows “Sending…” until the broker answers.'],
        retrySafe: st.config.clientOrderId ? ['yes', 'The broker deduplicates by (account, client order id): a retry returns the same order.'] : ['no', 'Every submit creates a new exchange order.'],
      });
      const r = yield* ctx.retry({ attempts: 2, baseMs: 150 }, function* () {
        return yield ctx.call('broker', 'submit', Object.assign({ account, clientOrderId, tap: st.taps.length - 1 }, order), { timeout: 900 });
      });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false;
      if (r.ok) {
        const o = r.value;
        u.ackMs = r.latency;
        upsert(u.orders, o);
        const ex = st.orders[o.exchangeId];
        Y.L(ctx, {
          displayed: ['yes', `Status “${o.status}”, ${o.filled} of ${o.qty} filled.`],
          accepted: ['yes', `The exchange sequenced it as #${ex ? ex.seq : '?'}.`],
          committed: ex && ex.journaled ? ['yes', `Journal entry #${ex.seq} was written before the ack.`] : ['pending', 'Acknowledged before the journal write: durable only once the batch lands.'],
          async: ['pending', 'Market data, execution reports to the other side, trade capture, clearing.'],
        });
        const fills = ex ? ex.fills : [];
        if (o.status === 'filled') ctx.explain(`${fills.length} fill${fills.length === 1 ? '' : 's'} at an average of ${px(o.avgPx)}: ${fills.map((f) => `${f.qty} @ ${px(f.px)} from ${NAMES[f.makerOwner]}`).join(', ')}. The order went broker → gateway → risk → sequencer → journal → engine and back in ${Math.round(r.latency)} ms; the engine itself took microseconds, the rest is network and the journal write.`);
        else if (o.status === 'resting') ctx.explain(`Nothing crosses ${px(o.px)}, so the order rests in the book at sequence #${ex.seq}. It keeps its place in the price-time queue until it fills or is cancelled.`);
        else if (o.status === 'partial') ctx.explain(`${o.filled} of ${o.qty} filled; the rest ${o.px != null ? `rests at ${px(o.px)}` : 'was cancelled: a market order never rests'}.`);
        else ctx.explain(`The order was ${o.status}: ${o.reason}.`);
      } else {
        u.error = r.error.code === 'TIMEOUT' ? 'No answer from the broker. Your order may or may not have been sent.' : r.error.code === 'UNAVAILABLE' ? 'Exchange unavailable. Nothing was sent; try again.' : `Rejected: ${r.error.message}`;
        Y.failed(ctx, 'The ticket shows an error.');
        ctx.explain(r.error.code === 'UNAVAILABLE' ? 'The sequencer is the single door into the matching engine. While it is down there is no trading at all: an exchange prefers no trading to two versions of the book.' : `The order failed with ${r.error.code}: ${r.error.message}`);
      }
    }, { self: account });
  }

  function startCancel(sim, account) {
    const st = sim.state;
    const o = Object.values(st.broker.orders).find((x) => x.account === account && ['resting', 'partial'].includes(x.status));
    if (!o) return;
    sim.startAction(`${NAMES[account]}: cancel ${o.side} ${o.qty} @ ${px(o.px)}`, function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'Cancelling a cancelled order changes nothing.'] });
      const r = yield ctx.call('broker', 'cancel', { id: o.id }, { timeout: 900 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok && !r.value.tooLate) { Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', 'Cancel sequenced and journaled.'], async: 'n/a' }); ctx.explain('The cancel is a message like any other: sequenced, journaled, then applied. The resting order left the book.'); }
      else if (r.ok) { Y.L(ctx, { displayed: ['yes', 'The phone shows “Too late: filled”.'], accepted: ['no', 'The order was already filled when the cancel was sequenced.'], committed: 'n/a', async: 'n/a' }); ctx.explain('The cancel lost the race: a buy was sequenced ahead of it and consumed the order. The sequencer decides who was first, not the clocks on the phones. The fill stands.'); }
      else Y.failed(ctx);
    }, { self: account });
  }

  function startQuill(sim, order) {
    const st = sim.state;
    sim.startAction(`Quill: ${order.side} ${order.qty} ACME limit ${px(order.px)}`, function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'Member sessions carry a client order id.'] });
      const id = 'Q' + ++st.quillSeq;
      const r = yield ctx.call('gateway', 'newOrder', { orderId: id, owner: 'quill', side: order.side, px: order.px, qty: order.qty, tif: 'gtc' }, { timeout: 900 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) { ctx.ui.quill.msg = `${id}: ${r.value.status}, ${r.value.filled} filled${r.value.filled ? ` @ ${px(r.value.avgPx)}` : ''}`; Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: r.value.journaled ? 'yes' : 'pending', async: 'pending' }); ctx.explain(`Quill is a direct member: no broker in the path. Its order was sequenced as #${r.value.seq} and ${r.value.status}.`); }
      else { ctx.ui.quill.msg = `${id}: ${r.error.message}`; Y.failed(ctx); }
    }, { self: 'quill' });
  }

  /** Rebuild the matching core from the journal after a crash: deterministic replay. */
  function rebuild(sim) {
    const st = sim.state;
    const t0 = sim.now;
    const book = B.create();
    const entries = st.journal.slice().sort((a, b) => a.seq - b.seq);
    for (const e of entries) {
      if (e.type === 'order') B.match(book, Object.assign({}, e.order, { id: e.order.orderId || e.order.id, tif: e.order.tif || 'gtc' }), {});
      else if (e.type === 'cancel') B.remove(book, e.orderId);
    }
    let lost = 0;
    for (const o of Object.values(st.orders)) {
      const wasResting = ['resting', 'partial'].includes(o.status);
      if (wasResting && !book.byId[o.id]) { o.status = 'lost'; lost++; }
    }
    st.book = book;
    st.seq = entries.length ? entries[entries.length - 1].seq : st.seq;
    st.stats.rebuilds++;
    st.stats.lostOrders += lost;
    sim.note(`Matching core restarted: replayed ${entries.length} journal entries into an empty book (${sim.now - t0} ms). ${lost ? `${lost} acknowledged order${lost === 1 ? ' was' : 's were'} never journaled and ${lost === 1 ? 'is' : 'are'} gone.` : 'Every acknowledged order came back.'}`);
  }

  const sc = (SDL.scenarios['ex-trade'] = {
    id: 'ex-trade',
    seed: 911,
    productWidth: 620,
    intro: 'Dev rests a sell at $50.10 on his phone, Maya buys at market on hers, and the fill reaches both screens, the tape, and clearing. Then lose a reply, lose a push, or crash the matching core before the journal write.',
    topology: {
      width: 1160, height: 680,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'Finch broker app', kind: 'client', x: 90, y: 90, latency: 1, role: 'Retail trader. Sends orders to her broker and shows execution reports and prices.', owns: ['What Maya sees'] },
        { id: 'dev', label: 'Dev’s phone', sub: 'Finch broker app', kind: 'client', x: 90, y: 300, latency: 1, role: 'Retail trader with 100 ACME to sell.', owns: ['What Dev sees'] },
        { id: 'quill', label: 'Quill Capital', sub: 'Market maker, direct member', kind: 'client', x: 90, y: 510, latency: 1, role: 'Quotes both sides of ACME through its own exchange session; no broker in the path.', owns: ['Its quotes'] },
        { id: 'broker', label: 'Finch brokerage', sub: 'Order management', kind: 'service', x: 320, y: 195, latency: 4, role: 'Keeps each customer’s orders, deduplicates by client order id, forwards to the exchange, pushes execution reports to phones, and answers status polls.', ops: [{ name: 'submit', desc: 'New customer order.' }, { name: 'cancel', desc: 'Cancel a resting order.' }, { name: 'status', desc: 'Poll order states.' }, { name: 'execReport', desc: 'Fill or cancel from the exchange.' }], owns: ['Customer orders', 'client order id → order'] },
        { id: 'gateway', label: 'Order entry gateway', sub: 'Member sessions', kind: 'gateway', x: 540, y: 300, latency: 1, role: 'Terminates member sessions, validates messages, calls pre-trade risk, forwards to the sequencer, routes execution reports back to the owning session.', ops: [{ name: 'newOrder', desc: 'Validate, risk-check, sequence.' }, { name: 'cancel', desc: 'Cancel request.' }, { name: 'report', desc: 'Execution report to the owner.' }], owns: ['Sessions'] },
        { id: 'risk', label: 'Pre-trade risk', sub: 'Limits and buying power', kind: 'service', x: 540, y: 480, latency: 1, role: 'Rejects fat fingers and orders beyond buying power before they reach the sequencer.', ops: [{ name: 'check', desc: 'Size and buying-power check.' }], owns: ['Limits per account'] },
        { id: 'sequencer', label: 'Sequencer', sub: 'Defines the order of events', kind: 'service', x: 760, y: 300, latency: 1, role: 'Stamps every message with the next sequence number, journals it, then hands it to the engine. The one place where “before” and “after” are decided.', ops: [{ name: 'submit', desc: 'Sequence, journal, apply.' }], owns: ['Sequence counter'] },
        { id: 'journal', label: 'Journal', sub: 'Append-only log', kind: 'store', x: 760, y: 480, latency: 6, role: 'The durable truth: every sequenced message. The engine’s book can be rebuilt from it; trade capture reads trades from it.', ops: [{ name: 'append', desc: 'Durable write.' }], owns: ['Sequenced messages', 'trades'] },
        { id: 'engine', label: 'Matching engine', sub: 'ACME, single thread, in memory', kind: 'worker', x: 980, y: 300, latency: 1, serviceMs: 1, role: 'Applies messages in sequence order to the in-memory book: price-time priority, fills, rests, cancels. No locks, no database, no I/O on the hot path.', ops: [{ name: 'process', desc: 'Apply one sequenced message.' }], owns: ['The order book (in memory)'] },
        { id: 'mdpub', label: 'Market data publisher', sub: 'Book changes to everyone', kind: 'service', x: 980, y: 120, latency: 1, role: 'Turns each book change into a feed message with the sequence number.', ops: [{ name: 'publish', desc: 'Publish a book change.' }], owns: ['Nothing durable'] },
        { id: 'feed', label: 'Market data feed', sub: 'Multicast', kind: 'queue', x: 760, y: 120, latency: 1, queue: 'md', role: 'The feed every member and broker listens to. One copy of each message, delivered to all.', ops: [], owns: ['Feed messages'] },
        { id: 'tradecap', label: 'Trade capture', sub: 'Reads trades from the journal', kind: 'worker', x: 980, y: 480, latency: 2, role: 'Consumes trades from the journal and books them at clearing, idempotently by trade id.', ops: [{ name: 'consume', desc: 'Book one trade.' }], owns: ['Nothing durable'] },
        { id: 'clearing', label: 'Clearing', sub: 'Positions and cash', kind: 'db', x: 980, y: 620, latency: 8, role: 'Positions and cash per account, settled T+1. Books each trade once.', ops: [{ name: 'book', desc: 'Apply a trade to two accounts.' }], owns: ['positions', 'booked trade ids'] },
      ],
      edges: [
        { from: 'maya', to: 'broker', latency: 40, label: 'HTTPS' },
        { from: 'dev', to: 'broker', latency: 40 },
        { from: 'quill', to: 'gateway', latency: 1, label: 'member session', via: [[320, 510], [430, 510], [430, 300]] },
        { from: 'broker', to: 'gateway', latency: 3, label: 'FIX' },
        { from: 'gateway', to: 'risk', latency: 1 },
        { from: 'gateway', to: 'sequencer', latency: 1 },
        { from: 'sequencer', to: 'journal', latency: 1, label: 'append' },
        { from: 'sequencer', to: 'engine', latency: 1 },
        { from: 'engine', to: 'mdpub', latency: 1 },
        { from: 'mdpub', to: 'feed', latency: 1 },
        { from: 'feed', to: 'broker', latency: 2, label: 'feed' },
        { from: 'engine', to: 'gateway', latency: 1, label: 'exec reports', via: [[980, 390], [650, 390]] },
        { from: 'journal', to: 'tradecap', latency: 2, label: 'trades' },
        { from: 'tradecap', to: 'clearing', latency: 3 },
      ],
      queues: [
        { id: 'md', broker: 'feed', label: 'market data', groups: ['broker'] },
        { id: 'trades', broker: 'journal', label: 'trades', groups: ['tradecap'] },
      ],
    },
    modeLabels: { pushLoss: 'Losing pushes to phones' },
    failures: [
      { id: 'broker-drop', node: 'broker', mode: 'dropResponse', label: 'Broker replies lost', desc: 'The broker does the work but phones never hear back and retry.' },
      { id: 'push-loss', node: 'broker', mode: 'pushLoss', label: 'Pushes to phones lost', desc: 'Execution reports reach the broker but not the phone.' },
      { id: 'md-down', node: 'mdpub', mode: 'down', label: 'Market data publisher down', desc: 'Trading continues; nobody sees the new prices.' },
      { id: 'seq-crash', node: 'sequencer', mode: 'crashed', label: 'Sequencer crash', desc: 'No trading until it restarts and the book is rebuilt from the journal.' },
      { id: 'seq-down', node: 'sequencer', mode: 'down', label: 'Sequencer unavailable', desc: 'Every order is rejected with UNAVAILABLE.' },
      { id: 'journal-slow', node: 'journal', mode: 'slow', params: { factor: 30 }, label: 'Journal slow', desc: 'With journal-then-ack, every ack waits for the disk.' },
      { id: 'engine-slow', node: 'engine', mode: 'slow', params: { factor: 60 }, label: 'Engine slow', desc: 'Messages queue in front of the single thread.' },
      { id: 'clearing-down', node: 'clearing', mode: 'down', label: 'Clearing down', desc: 'Trades wait in the journal; positions lag.' },
      { id: 'risk-down', node: 'risk', mode: 'down', label: 'Risk service down', desc: 'The gateway fails closed: orders are rejected.' },
    ],
    switches: Y.switches([
      ['clientOrderId', 'Client order ids at the broker', 'The broker maps (account, client order id) to one order, so a retried submit returns the existing order. Off: every submit becomes a new exchange order.'],
      ['ackAfterJournal', 'Journal before acknowledging', `The sequencer writes each message to the journal before the engine applies it and before anyone is told. Off: acknowledge first and batch the journal write ${JOURNAL_BATCH_MS} ms later.`],
      ['statusPoll', 'Phones poll order status', 'Every second each phone asks the broker for its orders, so a lost push is repaired. Off: the phone trusts pushes alone.'],
    ]),
    presets: Y.presets({ clientOrderId: true, ackAfterJournal: true, statusPoll: true }, [
      { id: 'market-buy', label: 'Dev rests, Maya buys at market', desc: 'Dev’s sell at $50.10 rests; Maya’s market buy fills against it. Both phones, the tape, and clearing agree.', run: (s) => { startOrder(s, 'dev', { side: 'sell', type: 'limit', px: 5010, qty: 100 }); s.schedule(1500, () => startOrder(s, 'maya', { side: 'buy', type: 'market', qty: 100 })); } },
      { id: 'rest-fill', label: 'Dev rests, Quill lifts the offer', desc: 'Dev’s order sits in the book until the market maker buys it. Dev learns of the fill from an execution report, not from a reply.', run: (s) => { startOrder(s, 'dev', { side: 'sell', type: 'limit', px: 5010, qty: 100 }); s.schedule(2000, () => startQuill(s, { side: 'buy', px: 5010, qty: 100 })); } },
      { id: 'partial', label: 'Partial fill across two levels', desc: 'Maya buys 150: 100 from Dev at $50.10, 50 from Quill at $50.20. One order, two fills, one average price.', run: (s) => { startOrder(s, 'dev', { side: 'sell', type: 'limit', px: 5010, qty: 100 }); s.schedule(1500, () => startOrder(s, 'maya', { side: 'buy', type: 'market', qty: 150 })); } },
      { id: 'cancel-race', label: 'Cancel arrives after the fill', desc: 'Dev cancels just as Maya buys. The sequencer puts the buy first, so the cancel is too late and the fill stands.', run: (s) => { startOrder(s, 'dev', { side: 'sell', type: 'limit', px: 5010, qty: 100 }); s.schedule(1500, () => startOrder(s, 'maya', { side: 'buy', type: 'market', qty: 100 })); s.schedule(1700, () => startCancel(s, 'dev')); } },
      { id: 'retry', label: 'Lost reply, client order id', desc: 'The broker’s reply to Maya is lost; her phone retries; the broker recognises the client order id and returns the same order. One order, 100 shares.', run: (s) => { startOrder(s, 'dev', { side: 'sell', type: 'limit', px: 5010, qty: 100 }); s.schedule(1500, () => { s.inject('broker', 'dropResponse', true, 700); startOrder(s, 'maya', { side: 'buy', type: 'market', qty: 100 }); }); } },
      { id: 'retry-bad', label: 'Lost reply, no client order id', desc: 'Same lost reply, but the retry becomes a second exchange order. Maya tapped once and bought 200 shares.', sw: { clientOrderId: false }, run: (s) => { startOrder(s, 'dev', { side: 'sell', type: 'limit', px: 5010, qty: 100 }); s.schedule(1500, () => { s.inject('broker', 'dropResponse', true, 700); startOrder(s, 'maya', { side: 'buy', type: 'market', qty: 100 }); }); } },
      { id: 'md-down', label: 'Market data publisher down', desc: 'The fill happens and both phones get their execution reports, but the price card still shows the old quote: trading and seeing are separate paths.', run: (s) => { s.inject('mdpub', 'down'); startOrder(s, 'dev', { side: 'sell', type: 'limit', px: 5010, qty: 100 }); s.schedule(1500, () => startOrder(s, 'maya', { side: 'buy', type: 'market', qty: 100 })); } },
      { id: 'push-lost', label: 'Push lost, status poll repairs it', desc: 'Dev’s execution report never reaches his phone. His next status poll fetches the truth from the broker.', run: (s) => { startOrder(s, 'dev', { side: 'sell', type: 'limit', px: 5010, qty: 100 }); s.schedule(1500, () => { s.inject('broker', 'pushLoss', true, 1200); startOrder(s, 'maya', { side: 'buy', type: 'market', qty: 100 }); }); } },
      { id: 'push-lost-bad', label: 'Push lost, no status poll', desc: 'Dev’s phone still shows his order resting while the broker and the exchange know it filled.', sw: { statusPoll: false }, run: (s) => { startOrder(s, 'dev', { side: 'sell', type: 'limit', px: 5010, qty: 100 }); s.schedule(1500, () => { s.inject('broker', 'pushLoss', true, 1200); startOrder(s, 'maya', { side: 'buy', type: 'market', qty: 100 }); }); } },
      { id: 'ack-first-crash', label: 'Ack before the journal, then crash', desc: 'Dev’s order is acknowledged, the sequencer crashes before the batched journal write, and the rebuilt book does not contain it. An acknowledged order is gone.', sw: { ackAfterJournal: false }, run: (s) => { startOrder(s, 'dev', { side: 'sell', type: 'limit', px: 5010, qty: 100 }); s.schedule(650, () => s.inject('sequencer', 'crashed', true, 1500)); s.schedule(3500, () => startOrder(s, 'maya', { side: 'buy', type: 'market', qty: 100 })); } },
      { id: 'journal-first-crash', label: 'Journal before the ack, then crash', desc: 'Same crash. The order was in the journal before Dev heard “accepted”, so the replay rebuilds it and Maya’s buy fills against it.', run: (s) => { startOrder(s, 'dev', { side: 'sell', type: 'limit', px: 5010, qty: 100 }); s.schedule(650, () => s.inject('sequencer', 'crashed', true, 1500)); s.schedule(3500, () => startOrder(s, 'maya', { side: 'buy', type: 'market', qty: 100 })); } },
      { id: 'seq-down', label: 'Sequencer unavailable', desc: 'There is exactly one door into the book. While it is closed, every order is rejected and nothing trades.', run: (s) => { s.inject('sequencer', 'down', true, 2500); startOrder(s, 'maya', { side: 'buy', type: 'market', qty: 100 }); } },
      { id: 'clearing-lag', label: 'Clearing down during a fill', desc: 'The trade is done the moment the engine matched it. Clearing catches up when it returns; until then positions at clearing lag the tape.', run: (s) => { s.inject('clearing', 'down', true, 3500); startOrder(s, 'dev', { side: 'sell', type: 'limit', px: 5010, qty: 100 }); s.schedule(1200, () => startOrder(s, 'maya', { side: 'buy', type: 'market', qty: 100 })); } },
    ]),
    initialState: () => {
      const book = B.create();
      B.rest(book, { id: 'Q1', owner: 'quill', side: 'sell', px: 5020, qty: 300, remaining: 300, tif: 'gtc', seq: 1 });
      B.rest(book, { id: 'Q2', owner: 'quill', side: 'buy', px: 4990, qty: 300, remaining: 300, tif: 'gtc', seq: 2 });
      return {
        config: { clientOrderId: true, ackAfterJournal: true, statusPoll: true },
        book, seq: 2, quillSeq: 2,
        journal: [
          { seq: 1, type: 'order', order: { orderId: 'Q1', owner: 'quill', side: 'sell', px: 5020, qty: 300, tif: 'gtc' } },
          { seq: 2, type: 'order', order: { orderId: 'Q2', owner: 'quill', side: 'buy', px: 4990, qty: 300, tif: 'gtc' } },
        ],
        orders: {
          Q1: { id: 'Q1', owner: 'quill', side: 'sell', px: 5020, qty: 300, filled: 0, avgPx: 0, status: 'resting', seq: 1, journaled: true, fills: [] },
          Q2: { id: 'Q2', owner: 'quill', side: 'buy', px: 4990, qty: 300, filled: 0, avgPx: 0, status: 'resting', seq: 2, journaled: true, fills: [] },
        },
        broker: { seq: 0, orders: {}, byClient: {} },
        taps: [], trades: [], tradeSeq: 0,
        md: { last: null, bid: 4990, ask: 5020, seq: 2 },
        clearing: { positions: { maya: { acme: 0, cash: 2500000 }, dev: { acme: 100, cash: 100000 }, quill: { acme: 5000, cash: 100000000 } }, booked: {} },
        stats: { dupOrders: 0, pushesLost: 0, polls: 0, rebuilds: 0, lostOrders: 0, mdPublished: 0, mdFailed: 0, clearingRetries: 0, journalLost: 0, reports: 0 },
        evSeq: 0,
      };
    },
    initialUI: () => ({
      maya: { pending: false, error: '', orders: [], ackMs: null },
      dev: { pending: false, error: '', orders: [], ackMs: null },
      quill: { msg: 'Quoting $49.90 × $50.20, 300 each side.' },
      price: { last: null, bid: 4990, ask: 5020, seq: 2 },
    }),
    actions: {
      order(sim, a) { startOrder(sim, a.account, { side: a.side, type: a.type, px: a.px, qty: a.qty }); },
      cancel(sim, a) { startCancel(sim, a.account); },
      quill(sim, a) { startQuill(sim, { side: a.side, px: a.px, qty: a.qty }); },
    },
    handlers: {
      maya: { push(ctx, p) { upsert(ctx.ui.maya.orders, p.order); return { ok: true }; } },
      dev: { push(ctx, p) { upsert(ctx.ui.dev.orders, p.order); return { ok: true }; } },
      broker: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          const key = `${p.account}/${p.clientOrderId}`;
          const existing = st.config.clientOrderId && st.broker.byClient[key] && st.broker.orders[st.broker.byClient[key]];
          if (existing && existing.status !== 'rejected') {
            ctx.log({ op: 'duplicate submit recognised', status: 'dup', detail: `Client order id ${p.clientOrderId} already maps to ${existing.id} (${existing.status}). Returning its state instead of sending another order.` });
            return view(existing);
          }
          const id = 'B' + ++st.broker.seq;
          const o = { id, account: p.account, side: p.side, type: p.type, px: p.type === 'market' ? null : p.px, qty: p.qty, filled: 0, avgPx: 0, status: 'sent', clientOrderId: p.clientOrderId, tap: p.tap };
          st.broker.orders[id] = o;
          st.broker.byClient[key] = id;
          const tap = st.taps[p.tap];
          tap.brokerOrders.push(id);
          if (tap.brokerOrders.length > 1) { st.stats.dupOrders++; ctx.log({ op: 'second order for one tap', status: 'warn', detail: `No client order id: the retry of ${tap.brokerOrders[0]} became a new order ${id}.` }); }
          const r = yield ctx.call('gateway', 'newOrder', { orderId: id, owner: p.account, side: p.side, px: o.px, qty: p.qty, tif: 'gtc' }, { timeout: 800 });
          if (!r.ok) { o.status = 'rejected'; o.reason = r.error.message; ctx.must(r); }
          Object.assign(o, { exchangeId: id, status: r.value.status, filled: r.value.filled, avgPx: r.value.avgPx, reason: r.value.reason });
          yield* pushTo(ctx, o);
          return view(o);
        },
        cancel: function* (ctx, p) {
          const st = ctx.state;
          const o = st.broker.orders[p.id];
          const r = yield ctx.call('gateway', 'cancel', { orderId: o.exchangeId, owner: o.account }, { timeout: 800 });
          if (r.ok) { o.status = 'cancelled'; yield* pushTo(ctx, o); return { tooLate: false }; }
          if (r.error.code === 'TOO_LATE') { const ex = st.orders[o.exchangeId]; Object.assign(o, { status: ex.status, filled: ex.filled, avgPx: ex.avgPx, reason: 'too late to cancel: already filled' }); yield* pushTo(ctx, o); return { tooLate: true }; }
          ctx.must(r);
        },
        status(ctx, p) { ctx.state.stats.polls++; return { orders: Object.values(ctx.state.broker.orders).filter((o) => o.account === p.account).map(view) }; },
        execReport: function* (ctx, p) {
          const st = ctx.state;
          const o = st.broker.orders[p.orderId];
          if (!o) return { ignored: true };
          Object.assign(o, { status: p.status, filled: p.filled, avgPx: p.avgPx });
          st.stats.reports++;
          yield* pushTo(ctx, o);
          return { ok: true };
        },
      },
      gateway: {
        newOrder: function* (ctx, p) {
          if (p.qty <= 0) ctx.fail('INVALID', 'Quantity must be positive.');
          ctx.must(yield ctx.call('risk', 'check', p, { timeout: 400 }));
          return ctx.must(yield ctx.call('sequencer', 'submit', { type: 'order', order: p }, { timeout: 700 }));
        },
        cancel: function* (ctx, p) { return ctx.must(yield ctx.call('sequencer', 'submit', { type: 'cancel', orderId: p.orderId, owner: p.owner }, { timeout: 700 })); },
        report: function* (ctx, p) {
          if (p.owner === 'quill') { ctx.ui.quill.msg = `${p.orderId}: ${p.status}, ${p.filled} filled @ ${px(p.avgPx)}`; return { routed: 'quill session' }; }
          ctx.must(yield ctx.call('broker', 'execReport', p, { timeout: 400 }));
          return { routed: 'broker session' };
        },
      },
      risk: {
        check(ctx, p) {
          const st = ctx.state;
          if (p.qty > 10000) ctx.fail('RISK', `Order size ${p.qty} is over the per-order limit.`);
          const pos = st.clearing.positions[p.owner];
          const notional = (p.px == null ? REF_PX : p.px) * p.qty;
          if (p.side === 'buy' && notional > pos.cash) ctx.fail('RISK', `Buying power ${px(pos.cash)} is below ${px(notional)}.`);
          return { ok: true, notional };
        },
      },
      sequencer: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          const seq = ++st.seq;
          const entry = Object.assign({ seq, t: ctx.now() }, p);
          if (st.config.ackAfterJournal) {
            ctx.must(yield ctx.call('journal', 'append', { entry }, { timeout: 500 }));
            entry.journaled = true;
          } else {
            const actionId = ctx.actionId;
            ctx.spawn(function* (c) {
              yield c.wait(JOURNAL_BATCH_MS);
              if (c.mode('crashed')) { st.stats.journalLost++; c.log({ op: `journal write #${seq} lost`, status: 'lost', detail: 'The sequencer crashed before the batched journal write went out. The message was acknowledged but never made durable.' }); return; }
              const r = yield c.call('journal', 'append', { entry }, { timeout: 500 });
              if (r.ok) { const o = p.type === 'order' && st.orders[p.order.orderId]; if (o) o.journaled = true; c.sim.setLedger(actionId, 'committed', 'yes', `Journal entry #${seq} written ${JOURNAL_BATCH_MS} ms after the ack.`); }
            }, { actionId });
          }
          const r = ctx.must(yield ctx.call('engine', 'process', { entry }, { timeout: 400 }));
          return Object.assign({ seq, journaled: !!entry.journaled }, r);
        },
      },
      journal: {
        append(ctx, p) {
          const st = ctx.state;
          st.journal.push(Object.assign({}, p.entry, { journaled: true }));
          if (p.entry.type === 'order' && st.orders[p.entry.order.orderId]) st.orders[p.entry.order.orderId].journaled = true;
          return { seq: p.entry.seq };
        },
      },
      engine: {
        process(ctx, p) {
          const st = ctx.state;
          const e = p.entry;
          let result;
          if (e.type === 'order') {
            const o = e.order;
            const rec = { id: o.orderId, owner: o.owner, side: o.side, px: o.px, qty: o.qty, filled: 0, avgPx: 0, status: 'new', seq: e.seq, journaled: !!e.journaled, fills: [] };
            st.orders[rec.id] = rec;
            const res = B.match(st.book, { id: rec.id, owner: o.owner, side: o.side, px: o.px, qty: o.qty, tif: o.tif || 'gtc', seq: e.seq }, {});
            const reports = [];
            for (const f of res.fills) {
              const trade = { id: 'T' + ++st.tradeSeq, px: f.px, qty: f.qty, buyer: f.side === 'buy' ? f.takerOwner : f.makerOwner, seller: f.side === 'buy' ? f.makerOwner : f.takerOwner, taker: rec.id, maker: f.makerId, seq: e.seq, t: ctx.now() };
              st.trades.push(trade);
              rec.fills.push(f);
              applyFill(rec, f.qty, f.px);
              const m = st.orders[f.makerId];
              applyFill(m, f.qty, f.px);
              m.status = m.filled === m.qty ? 'filled' : 'partial';
              reports.push({ orderId: m.id, owner: m.owner, status: m.status, filled: m.filled, avgPx: m.avgPx });
              ctx.sim.enqueue('trades', { type: 'trade', eventId: trade.id, payload: trade, actionId: ctx.actionId });
              st.md.last = f.px;
            }
            rec.status = res.status;
            rec.reason = res.reason;
            result = { id: rec.id, status: rec.status, filled: rec.filled, avgPx: rec.avgPx, reason: rec.reason };
            if (reports.length) ctx.spawn(function* (c) { for (const rp of reports) yield c.call('gateway', 'report', rp, { timeout: 600 }); });
            ctx.log({ op: `#${e.seq} ${rec.side} ${rec.qty} ${rec.px == null ? 'market' : px(rec.px)} → ${res.status}`, status: 'ok', detail: res.fills.length ? `${res.fills.length} fill${res.fills.length === 1 ? '' : 's'}: ${res.fills.map((f) => `${f.qty} @ ${px(f.px)} vs ${f.makerId}`).join(', ')}.` : res.reason || 'Rests in the book.' });
          } else {
            const o = st.orders[e.orderId];
            if (!o || o.status === 'lost') ctx.fail('UNKNOWN', 'No such order in the book.');
            if (o.status === 'filled' || o.status === 'cancelled') ctx.fail('TOO_LATE', `Order ${o.id} is already ${o.status}.`);
            B.remove(st.book, o.id);
            o.status = 'cancelled';
            result = { id: o.id, status: 'cancelled', filled: o.filled, avgPx: o.avgPx };
          }
          const best = B.best(st.book);
          st.md.bid = best.bid; st.md.ask = best.ask; st.md.seq = e.seq;
          const snap = Object.assign({}, st.md);
          ctx.spawn(function* (c) { const r = yield c.call('mdpub', 'publish', snap, { timeout: 300 }); if (r.ok) st.stats.mdPublished++; else st.stats.mdFailed++; });
          return result;
        },
      },
      mdpub: { publish(ctx, p) { ctx.sim.enqueue('md', { type: 'md', eventId: 'md' + ++ctx.state.evSeq, payload: p, actionId: ctx.actionId }); return { ok: true }; } },
      clearing: {
        book(ctx, p) {
          const st = ctx.state;
          const t = p.trade;
          if (st.clearing.booked[t.id]) return { duplicate: true };
          st.clearing.booked[t.id] = true;
          const b = st.clearing.positions[t.buyer], s = st.clearing.positions[t.seller];
          b.acme += t.qty; b.cash -= t.qty * t.px;
          s.acme -= t.qty; s.cash += t.qty * t.px;
          return { booked: t.id };
        },
      },
    },
    setup(sim) {
      Y.consumer(sim, 'md', 'broker', 'broker', function* (ctx, msg) { Object.assign(ctx.ui.price, msg.payload); return true; });
      Y.consumer(sim, 'trades', 'tradecap', 'tradecap', function* (ctx, msg) {
        const r = yield ctx.call('clearing', 'book', { trade: msg.payload }, { timeout: 800, actionId: msg.actionId });
        if (!r.ok) { ctx.state.stats.clearingRetries++; return false; }
        ctx.sim.setLedger(msg.actionId, 'async', 'yes', `Trade ${msg.payload.id} booked at clearing.`);
        return true;
      }, () => true);
      for (const who of ['maya', 'dev']) sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(1000);
          if (!ctx.state.config.statusPoll) continue;
          const r = yield ctx.call('broker', 'status', { account: who }, { timeout: 800, quiet: 'all' });
          if (r.ok) for (const o of r.value.orders) upsert(ctx.ui[who].orders, o);
        }
      }, { self: who, quiet: 'all' });
    },
    onFailureChange(sim, ch) { if (ch.node === 'sequencer' && ch.mode === 'crashed' && !ch.active) rebuild(sim); },
    consistency(sim) {
      const st = sim.state;
      const ui = sim.ui;
      for (const tap of st.taps) {
        const live = tap.brokerOrders.map((id) => st.broker.orders[id]).filter((o) => o.status !== 'rejected');
        if (live.length > 1) { const filled = live.reduce((s, o) => s + o.filled, 0); return { key: 'wrong', label: `${NAMES[tap.account]} tapped once and the broker sent ${live.length} orders: ${filled} shares ${tap.side === 'buy' ? 'bought' : 'sold'} for a ${tap.qty}-share tap.` }; }
      }
      const lost = Object.values(st.broker.orders).find((o) => o.exchangeId && st.orders[o.exchangeId] && st.orders[o.exchangeId].status === 'lost');
      if (lost) return { key: 'wrong', label: `${NAMES[lost.account]}’s order ${lost.id} was acknowledged but never journaled. After the restart the book does not have it: an accepted order vanished.` };
      for (const who of ['maya', 'dev']) {
        if (ui[who].pending) return { key: 'stale', label: `${NAMES[who]}’s phone is waiting for the broker.` };
        if (ui[who].error) return { key: 'stale', label: `${NAMES[who]}’s order failed: ${ui[who].error}` };
        for (const v of ui[who].orders) { const o = st.broker.orders[v.id]; if (o && (o.status !== v.status || o.filled !== v.filled)) return { key: 'stale', label: `${NAMES[who]}’s phone shows ${v.id} “${v.status}”, the broker knows it is “${o.status}” with ${o.filled} filled: an execution report never reached the phone.` }; }
      }
      if (sim.nodes.sequencer.modes.crashed) return { key: 'stale', label: 'The sequencer is down: no trading until it restarts and replays the journal.' };
      const unj = Object.values(st.orders).filter((o) => !o.journaled && o.status !== 'lost');
      if (unj.length) return { key: 'stale', label: `${unj.length} acknowledged message${unj.length === 1 ? ' is' : 's are'} not in the journal yet. A crash now would lose ${unj.length === 1 ? 'it' : 'them'}.` };
      if (ui.price.seq !== st.md.seq || ui.price.last !== st.md.last) return { key: 'stale', label: `The phones show ${ui.price.last == null ? 'no last trade' : `last ${px(ui.price.last)}`} at feed #${ui.price.seq}; the book is at #${st.md.seq}${st.md.last != null ? `, last ${px(st.md.last)}` : ''}. Market data is behind.` };
      const unbooked = st.trades.filter((t) => !st.clearing.booked[t.id]).length;
      if (unbooked) return { key: 'stale', label: `${unbooked} trade${unbooked === 1 ? '' : 's'} not yet booked at clearing. The fill is final; positions lag.` };
      return { key: 'ok', label: 'Phones, broker, book, feed, and clearing all agree, and every acknowledged message is in the journal.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const ack = (sim.ui.maya.ackMs != null ? sim.ui.maya.ackMs : sim.ui.dev.ackMs);
      const w = sim.queueWait('engine');
      return [
        { label: 'Order to ack', value: ack == null ? '–' : SDL.fmtMs(ack), tone: ack > 600 ? 'warn' : '' },
        { label: 'Sequence number', value: st.seq },
        { label: 'Trades', value: st.trades.length },
        { label: 'Last trade', value: st.md.last == null ? '–' : px(st.md.last) },
        { label: 'Engine queue', value: SDL.fmtMs(w), tone: w > 200 ? 'warn' : '' },
        { label: 'Journal entries', value: st.journal.length, tone: st.stats.journalLost ? 'fail' : '' },
        { label: 'Pushes lost', value: st.stats.pushesLost, tone: st.stats.pushesLost ? 'warn' : '' },
        { label: 'Trades awaiting clearing', value: sim.queueStats('trades').depth, tone: sim.queueStats('trades').depth ? 'warn' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['dev', 'Dev’s phone']], {
          note: 'Both phones use the Finch broker app. Dev holds 100 ACME; Maya has $25,000. The market maker below quotes both sides and can lift Dev’s offer.',
          below: `<div class="ops-console"><p class="ops-title">Quill Capital (market maker) and the ACME book</p><div class="ops-traffic">${Y.btn('quill', 'Buy 100 @ $50.10 (lift Dev’s offer)', { arg: { side: 'buy', px: 5010, qty: 100 } })}${Y.btn('quill', 'Sell 100 @ $50.00', { arg: { side: 'sell', px: 5000, qty: 100 }, cls: 'secondary' })}</div><div data-ref="book"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const pr = sim.ui.price;
        const priceCard = `<div class="app-card"><span class="app-kv"><strong>ACME</strong><span>${pr.last == null ? 'no trades yet' : `last ${px(pr.last)}`}</span></span><span class="app-sub">bid ${pr.bid == null ? '–' : px(pr.bid)} × ask ${pr.ask == null ? '–' : px(pr.ask)} · feed #${pr.seq}</span></div>`;
        const orderCard = (o) => `<div class="app-card ${o.status === 'filled' ? 'is-ok' : o.status === 'rejected' || o.status === 'lost' ? 'is-fail' : ''}"><span class="app-kv"><strong>${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.qty} ${o.px == null ? 'market' : '@ ' + px(o.px)}</strong><span>${esc(o.status)}</span></span><span class="app-sub">${o.filled ? `${o.filled} filled @ ${px(o.avgPx)}` : o.reason ? esc(o.reason) : 'working'}</span></div>`;
        for (const who of ['maya', 'dev']) {
          const u = sim.ui[who];
          const pos = st.clearing.positions[who];
          const own = Object.values(st.broker.orders).filter((o) => o.account === who);
          const net = own.reduce((s, o) => s + (o.side === 'buy' ? o.filled : -o.filled), 0);
          const base = who === 'maya' ? 0 : 100;
          const ticket = who === 'maya'
            ? `${Y.btn('order', u.pending ? '<span class="spinner"></span>Sending…' : 'Buy 100 at market', { arg: { account: 'maya', side: 'buy', type: 'market', qty: 100 }, disabled: u.pending })}${Y.btn('order', 'Buy 150 at market', { arg: { account: 'maya', side: 'buy', type: 'market', qty: 150 }, cls: 'secondary', disabled: u.pending })}`
            : `${Y.btn('order', u.pending ? '<span class="spinner"></span>Sending…' : 'Sell 100 limit $50.10', { arg: { account: 'dev', side: 'sell', type: 'limit', px: 5010, qty: 100 }, disabled: u.pending })}${Y.btn('cancel', 'Cancel resting order', { arg: { account: 'dev' }, cls: 'secondary', disabled: !own.some((o) => ['resting', 'partial'].includes(o.status)) })}`;
          Y.paint(el, sim, who, {
            head: `<div><p class="app-title">Finch</p><p class="app-sub">${NAMES[who]} · ACME ${base + net} sh · clearing ${pos.acme} sh, ${px(pos.cash)}</p></div>`,
            price: priceCard, ticket, msg: Y.msg(u.error, 'fail'),
            orders: u.orders.length ? `<p class="app-sub">Orders${u.ackMs != null ? ` · last ack ${Math.round(u.ackMs)} ms` : ''}</p>${u.orders.slice(-3).reverse().map(orderCard).join('')}` : '<p class="app-sub">No orders yet.</p>',
          }, {});
        }
        const row = (side, l) => `<div class="ops-row"><div class="ops-name">${side === 'sell' ? 'Ask' : 'Bid'} ${px(l.px)}<span>${l.qty} sh · ${l.n} order${l.n === 1 ? '' : 's'}</span></div></div>`;
        const asks = B.levels(st.book, 'sell', 3).reverse().map((l) => row('sell', l)).join('');
        const bids = B.levels(st.book, 'buy', 3).map((l) => row('buy', l)).join('');
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="book"]'), {
          msg: `<p class="app-sub">${esc(sim.ui.quill.msg)}</p>`,
          book: `<div class="ops-shards">${asks || '<p class="app-sub">no asks</p>'}${bids || '<p class="app-sub">no bids</p>'}</div>`,
          tape: `<p class="app-sub">Tape: ${st.trades.slice(-3).map((t) => `${t.id} ${t.qty} @ ${px(t.px)} (${NAMES[t.buyer]} ← ${NAMES[t.seller]})`).join(' · ') || 'no trades yet'} · journal ${st.journal.length} entries · seq #${st.seq}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  function applyFill(o, qty, p) { o.avgPx = Math.round((o.avgPx * o.filled + p * qty) / (o.filled + qty)); o.filled += qty; }
  function* pushTo(ctx, o) {
    const st = ctx.state;
    if (ctx.mode('pushLoss', 'broker')) { st.stats.pushesLost++; ctx.log({ op: `push to ${NAMES[o.account]} lost`, status: 'lost', detail: `The execution report for ${o.id} (${o.status}) never reached the phone.` }); return; }
    yield ctx.call(o.account, 'push', { order: view(o) }, { timeout: 300 });
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
