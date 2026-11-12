/*
 * Trade capture, clearing, and exactly-once booking.
 * A fill is final the moment the engine journals it. Everything after that
 * is bookkeeping that must happen exactly once: trade capture reads the
 * journal’s outbox, books each trade at clearing by trade id, a drop copy
 * records every fill independently, reconciliation compares the two, and
 * settlement nets each member’s trades into one instruction per cycle.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const NAMES = { maya: 'Maya', quill: 'Quill Capital', nova: 'Nova Securities' };
  const ASK = 5020, BID = 5010; // Quill’s quotes, in cents, infinite depth
  const RECON_MS = 2000;
  const SETTLE_MS = 3000;
  const BURST = 300; // background trades per second
  const BATCH = 100;
  const px = (c) => '$' + (c / 100).toFixed(2);
  const money = (c) => (c < 0 ? '−' : '') + px(Math.abs(c));

  function startOrder(sim, o) {
    const st = sim.state;
    sim.startAction(`Maya: ${o.side} ${Y.num(o.qty)} at market`, function* (ctx) {
      const u = ctx.ui.maya;
      const id = `maya-${++st.clientSeq}`;
      const rec = { id, side: o.side, qty: o.qty, status: 'sending', tradeId: null, px: null };
      u.orders.push(rec); u.pending++;
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'The gateway deduplicates by client order id.'] });
      const r = yield ctx.call('gateway', 'newOrder', { clientOrderId: id, owner: 'maya', side: o.side, qty: o.qty, actionId: ctx.actionId }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending--;
      if (!r.ok) {
        rec.status = 'rejected'; rec.reason = r.error.message;
        Y.failed(ctx, 'The order did not trade.');
        ctx.explain(`${r.error.message} Nothing was journaled, so there is nothing to capture, book, or settle.`);
        return;
      }
      rec.status = 'filled'; rec.tradeId = r.value.tradeId; rec.px = r.value.px;
      if (o.side === 'buy') { u.acme += o.qty; u.cash -= o.qty * r.value.px; } else { u.acme -= o.qty; u.cash += o.qty * r.value.px; }
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Trade ${r.value.tradeId} is in the journal. The fill is final.`], async: ['pending', 'Trade capture, clearing, drop copy, reconciliation, settlement.'] });
      ctx.explain(`Filled ${Y.num(o.qty)} at ${px(r.value.px)} against Quill’s quote and journaled as ${r.value.tradeId}. ${st.config.outbox ? 'Trade capture reads that journal entry through the outbox relay, so clearing can only miss the trade by being late, never by losing it.' : 'The engine now publishes the trade to the bus as a second, separate write. If that publish fails, the journal has a trade that clearing never hears about.'}`);
    }, { self: 'maya' });
  }

  function startRecon(sim, manual) {
    sim.startAction('Reconciliation: clearing vs drop copy', function* (ctx) {
      const st = ctx.state;
      Y.L(ctx, { displayed: 'n/a', retrySafe: 'yes', committed: 'n/a', async: 'n/a' });
      const d = yield ctx.call('dropcopy', 'list', {}, { timeout: 600 });
      if (!d.ok) { st.recon = { at: ctx.now(), error: 'drop copy unavailable', breaks: [] }; Y.failed(ctx, 'No independent record to compare against.'); ctx.explain('The drop copy is down. Clearing may be right, but nothing can prove it until the feed is back.'); return; }
      const c = yield ctx.call('clearing', 'list', {}, { timeout: 600 });
      if (!c.ok) { st.recon = { at: ctx.now(), error: 'clearing unavailable', breaks: [] }; Y.failed(ctx); return; }
      const booked = c.value.booked;
      const breaks = [];
      for (const t of d.value.trades) {
        const n = booked[t.id] || 0;
        if (n === 0 && ctx.now() - t.t > 600) breaks.push({ kind: 'missing', trade: t });
        if (n > 1) breaks.push({ kind: 'double', trade: t, n });
      }
      st.recon = { at: ctx.now(), error: null, breaks, compared: d.value.trades.length };
      st.stats.recons++;
      Y.L(ctx, { accepted: 'yes' });
      if (breaks.length) ctx.explain(`${breaks.length} break${breaks.length === 1 ? '' : 's'}: ${breaks.map((b) => `${b.trade.id} ${b.kind === 'missing' ? 'is in the drop copy but not at clearing' : `is booked ${b.n} times`}`).join('; ')}. The pipeline did not notice; the independent copy did.`);
      else if (manual) ctx.explain(`${d.value.trades.length} fills in the drop copy, every one booked exactly once at clearing.`);
    }, { self: 'recon' });
  }

  function startRepair(sim) {
    sim.startAction('Operator: repair breaks from the drop copy', function* (ctx) {
      const st = ctx.state;
      const breaks = (st.recon && st.recon.breaks) || [];
      Y.L(ctx, { displayed: 'n/a', retrySafe: ['yes', 'Booking by trade id is idempotent.'] });
      if (!breaks.length) { Y.L(ctx, { accepted: 'yes', committed: 'n/a', async: 'n/a' }); ctx.explain('No breaks to repair. Run reconciliation first.'); return; }
      let fixed = 0;
      for (const b of breaks) {
        if (b.kind === 'missing') { const r = yield ctx.call('clearing', 'book', { trades: [b.trade], source: 'repair' }, { timeout: 800 }); if (r.ok) fixed++; }
        if (b.kind === 'double') { const r = yield ctx.call('clearing', 'unbook', { tradeId: b.trade.id, keep: 1 }, { timeout: 800 }); if (r.ok) fixed++; }
      }
      st.stats.repaired += fixed;
      st.recon = { at: ctx.now(), error: null, breaks: [], compared: st.recon.compared };
      Y.L(ctx, { accepted: 'yes', committed: ['yes', `${fixed} break${fixed === 1 ? '' : 's'} repaired.`], async: 'n/a' });
      ctx.explain(`${fixed} trade${fixed === 1 ? '' : 's'} corrected from the drop copy. Reconciliation is the backstop: it catches what the pipeline lost or doubled, but hours later and by hand. The pipeline should not need it.`);
    }, { self: 'recon' });
  }

  function startSettle(sim, manual) {
    sim.startAction('Settlement cycle', function* (ctx) {
      const st = ctx.state;
      Y.L(ctx, { displayed: 'n/a', retrySafe: ['yes', 'One instruction id per account per cycle.'] });
      const r = yield ctx.call('clearing', 'unsettled', {}, { timeout: 600 });
      if (!r.ok) { Y.failed(ctx); return; }
      const trades = r.value.trades;
      if (!trades.length) { Y.L(ctx, { accepted: 'yes', committed: 'n/a', async: 'n/a' }); if (manual) ctx.explain('Nothing booked since the last cycle.'); return; }
      const cycle = ++st.settleCycle;
      const instructions = [];
      if (st.config.netting) {
        const net = {};
        for (const t of trades) {
          const b = (net[t.buyer] = net[t.buyer] || { acme: 0, cash: 0, trades: 0 }); b.acme += t.qty; b.cash -= t.qty * t.px; b.trades++;
          const s = (net[t.seller] = net[t.seller] || { acme: 0, cash: 0, trades: 0 }); s.acme -= t.qty; s.cash += t.qty * t.px; s.trades++;
        }
        for (const [acct, n] of Object.entries(net)) instructions.push({ id: `S${cycle}-${acct}`, acct, acme: n.acme, cash: n.cash, trades: n.trades });
      } else {
        for (const t of trades) {
          instructions.push({ id: `S${cycle}-${t.id}-b`, acct: t.buyer, acme: t.qty, cash: -t.qty * t.px, trades: 1 });
          instructions.push({ id: `S${cycle}-${t.id}-s`, acct: t.seller, acme: -t.qty, cash: t.qty * t.px, trades: 1 });
        }
      }
      const c = yield ctx.call('csd', 'instruct', { instructions }, { timeout: 900 });
      if (!c.ok) { st.stats.settleRetries++; Y.failed(ctx, 'The depository did not accept the instructions; the same ids will be sent next cycle.'); return; }
      yield ctx.call('clearing', 'markSettled', { ids: trades.map((t) => t.id), cycle }, { timeout: 600 });
      st.stats.instructions += instructions.length;
      st.stats.settledTrades += trades.length;
      Y.L(ctx, { accepted: 'yes', committed: ['yes', `${instructions.length} instruction${instructions.length === 1 ? '' : 's'} for ${trades.length} trade${trades.length === 1 ? '' : 's'}.`], async: 'n/a' });
      const maya = instructions.filter((i) => i.acct === 'maya');
      ctx.explain(`${trades.length} trade${trades.length === 1 ? '' : 's'} became ${instructions.length} settlement instruction${instructions.length === 1 ? '' : 's'}${st.config.netting ? ' (one per account: net shares and net cash)' : ' (two legs per trade, nothing netted)'}.${maya.length ? ` Maya: ${maya.map((i) => `${i.acme >= 0 ? 'receive' : 'deliver'} ${Y.num(Math.abs(i.acme))} ACME, ${i.cash >= 0 ? 'receive' : 'pay'} ${px(Math.abs(i.cash))}`).join('; ')}.` : ''}`);
    }, { self: 'settle' });
  }

  function setBurst(sim, on) { sim.state.burst = on; sim.note(on ? `Quill and Nova trade ${Y.num(BURST)} times a second.` : 'Background trading stopped.'); }

  const sc = (SDL.scenarios['ex-settle'] = {
    id: 'ex-settle',
    seed: 404,
    productWidth: 640,
    minHopMs: 5,
    intro: 'Buy from Maya’s phone and follow the trade from the journal to clearing, the drop copy, and settlement. Then crash trade capture after it books and before it marks, switch the outbox off, and run reconciliation.',
    topology: {
      width: 1160, height: 640,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'Finch broker app', x: 90, y: 110, latency: 1, role: 'Retail orders. Sees fills from execution reports; sees clearing status from the broker’s back office.', owns: ['What Maya sees'] },
        { id: 'quill', label: 'Quill and Nova', kind: 'client', sub: 'Members, background trades', x: 90, y: 320, latency: 1, role: 'Quill quotes; Nova trades against it in the background.', owns: ['Their orders'] },
        { id: 'gateway', label: 'Order entry gateway', kind: 'gateway', sub: 'Dedupe, forward', x: 330, y: 215, latency: 1, role: 'Deduplicates by client order id and forwards to the engine.', ops: [{ name: 'newOrder', desc: 'Validate and forward.' }], owns: ['Client order ids seen'] },
        { id: 'engine', label: 'Matching engine', kind: 'worker', sub: 'Fills, then journals', x: 560, y: 110, latency: 1, serviceMs: 0.5, role: 'Matches against Quill’s quotes. A trade is final once the journal has it. Sends a drop copy of every fill.', ops: [{ name: 'submit', desc: 'Match and journal.' }], owns: ['The tape'] },
        { id: 'dropcopy', label: 'Drop copy', kind: 'store', sub: 'Independent record of fills', x: 800, y: 110, latency: 2, role: 'Every fill, straight from the engine, on a path that shares nothing with trade capture. The thing reconciliation compares against.', ops: [{ name: 'record', desc: 'Store one fill.' }, { name: 'list', desc: 'All fills.' }], owns: ['fills'] },
        { id: 'recon', label: 'Reconciliation', kind: 'worker', sub: `Every ${SETTLE_MS / 1000 - 1} s`, x: 1040, y: 110, latency: 2, role: 'Compares the drop copy with what clearing booked: missing trades, double bookings.', owns: ['Breaks'] },
        { id: 'journal', label: 'Trade journal', kind: 'store', sub: 'Durable, with outbox', x: 560, y: 320, latency: 3, queue: 'outbox', role: 'Append-only. With the outbox on, each journaled trade is also the message trade capture will read: one write, not two.', ops: [{ name: 'append', desc: 'Journal a trade.' }], owns: ['trades', 'outbox'] },
        { id: 'relay', label: 'Outbox relay', kind: 'worker', sub: 'Journal → bus', x: 800, y: 320, latency: 2, role: 'Polls the journal’s outbox in batches and publishes to the trade bus. Retries until the bus accepts; at-least-once by design.', owns: ['Its offset'] },
        { id: 'bus', label: 'Trade bus', kind: 'queue', sub: 'trades', x: 1040, y: 320, latency: 2, queue: 'trades', role: 'Delivers trades to capture. At-least-once: a consumer that does not acknowledge sees the message again.', ops: [{ name: 'publish', desc: 'Append trades.' }], owns: ['trades'] },
        { id: 'csd', label: 'Depository', kind: 'service', sub: 'Moves shares and cash', x: 330, y: 530, latency: 20, role: 'The central securities depository and bank. Executes settlement instructions once per instruction id.', ops: [{ name: 'instruct', desc: 'Settle instructions.' }], owns: ['Settled instructions'] },
        { id: 'settle', label: 'Settlement', kind: 'worker', sub: `Cycle every ${SETTLE_MS / 1000} s`, x: 560, y: 530, latency: 2, role: 'Takes booked trades, nets them per account, and instructs the depository.', owns: ['Cycle number'] },
        { id: 'clearing', label: 'Clearing', kind: 'db', sub: 'Positions by trade id', x: 800, y: 530, latency: 6, role: 'Books each trade id once, keeps positions and cash per account, and marks what has settled.', ops: [{ name: 'book', desc: 'Book trades.' }, { name: 'list', desc: 'Booked ids.' }, { name: 'unsettled', desc: 'Booked, not settled.' }, { name: 'markSettled', desc: 'Record a cycle.' }, { name: 'unbook', desc: 'Reverse a duplicate.' }], owns: ['positions', 'booked trade ids'] },
        { id: 'tradecap', label: 'Trade capture', kind: 'worker', sub: 'Books, then acknowledges', x: 1040, y: 530, latency: 2, role: 'Reads trades from the bus, books them at clearing, then acknowledges. A crash between those two steps means the trade is delivered again.', owns: ['Its offset'] },
      ],
      edges: [
        { from: 'maya', to: 'gateway', latency: 40 },
        { from: 'quill', to: 'gateway', latency: 1 },
        { from: 'gateway', to: 'engine', latency: 1 },
        { from: 'engine', to: 'journal', latency: 1 },
        { from: 'engine', to: 'dropcopy', latency: 2 },
        { from: 'engine', to: 'bus', latency: 2, label: 'dual write', via: [[680, 110], [680, 200], [1040, 200]] },
        { from: 'journal', to: 'relay', latency: 2, label: 'outbox' },
        { from: 'relay', to: 'bus', latency: 2 },
        { from: 'bus', to: 'tradecap', latency: 2 },
        { from: 'tradecap', to: 'clearing', latency: 2 },
        { from: 'recon', to: 'dropcopy', latency: 2 },
        { from: 'recon', to: 'clearing', latency: 2, via: [[1130, 110], [1130, 440], [800, 440]] },
        { from: 'settle', to: 'clearing', latency: 2 },
        { from: 'settle', to: 'csd', latency: 10 },
      ],
      queues: [
        { id: 'outbox', broker: 'journal', label: 'journal outbox', groups: ['relay'] },
        { id: 'trades', broker: 'bus', label: 'trades', groups: ['tradecap'] },
      ],
    },
    modeLabels: { duplicate: 'Delivering twice', crashAfterBook: 'Will crash after the next booking' },
    failures: [
      { id: 'cap-crash', node: 'tradecap', mode: 'crashAfterBook', label: 'Trade capture crash', desc: 'Crashes right after its next booking, before acknowledging; the trade is redelivered on restart.' },
      { id: 'clearing-down', node: 'clearing', mode: 'down', label: 'Clearing database down', desc: 'Capture cannot book; trades wait on the bus and are retried.' },
      { id: 'bus-down', node: 'bus', mode: 'down', label: 'Trade bus down', desc: 'The outbox relay waits. A dual-writing engine loses its publish.' },
      { id: 'outbox-dup', node: 'journal', mode: 'duplicate', label: 'Outbox delivers twice', desc: 'The relay forwards two copies of each trade.' },
      { id: 'dropcopy-down', node: 'dropcopy', mode: 'down', label: 'Drop copy down', desc: 'No independent record; reconciliation cannot run.' },
      { id: 'recon-paused', node: 'recon', mode: 'paused', label: 'Reconciliation paused', desc: 'Breaks go unnoticed.' },
      { id: 'csd-down', node: 'csd', mode: 'down', label: 'Depository down', desc: 'Settlement instructions are resent next cycle with the same ids.' },
    ],
    switches: Y.switches([
      ['outbox', 'Outbox from the journal', 'Trade capture reads the journaled trade itself, relayed to the bus. Off: the engine journals, then publishes to the bus as a second write that can fail on its own.'],
      ['idemBook', 'Idempotent booking by trade id', 'Clearing books a trade id once and treats a repeat as already done. Off: every delivery changes positions.'],
      ['netting', 'Net settlement per account', 'One instruction per account per cycle: net shares, net cash. Off: two legs per trade, gross.'],
      ['batchBook', `Batch booking (${BATCH} trades per write)`, 'Capture takes up to a hundred trades from the bus and books them in one clearing write. Off: one write per trade.'],
    ]),
    presets: Y.presets({ outbox: true, idemBook: true, netting: true, batchBook: false }, [
      { id: 'normal', label: 'One trade, end to end', desc: 'Maya buys 100. Journal, outbox, bus, capture, clearing, drop copy, reconciliation, then a settlement instruction.', run: (s) => startOrder(s, { side: 'buy', qty: 100 }) },
      { id: 'redeliver', label: 'Capture crashes before acknowledging', desc: 'Trade capture books the trade at clearing and crashes before it marks the message done. On restart the bus delivers it again; clearing recognises the trade id.', run: (s) => { startOrder(s, { side: 'buy', qty: 100 }); s.inject('tradecap', 'crashAfterBook'); } },
      { id: 'redeliver-bad', label: 'Same crash, no idempotency', desc: 'The redelivered trade is booked a second time. Clearing shows Maya with 200 shares she bought 100 of; reconciliation finds the double.', sw: { idemBook: false }, run: (s) => { startOrder(s, { side: 'buy', qty: 100 }); s.inject('tradecap', 'crashAfterBook'); } },
      { id: 'dual-write', label: 'Dual write loses a trade', desc: 'Outbox off: the engine journals the fill, then publishes to the bus, and the bus is down for that second write. The trade is final, Maya owns the shares, and clearing never hears of it.', sw: { outbox: false }, run: (s) => { s.inject('bus', 'down', true, 1200); startOrder(s, { side: 'buy', qty: 100 }); } },
      { id: 'dual-write-repair', label: 'Lost trade found by reconciliation', desc: 'Same loss. Reconciliation compares the drop copy with clearing, finds the missing trade, and the operator books it from the drop copy.', sw: { outbox: false }, run: (s) => { s.inject('bus', 'down', true, 1200); startOrder(s, { side: 'buy', qty: 100 }); s.schedule(4500, () => startRepair(s)); } },
      { id: 'outbox', label: 'Outbox survives the same outage', desc: 'Outbox on: the journaled trade is the message. The relay retries while the bus is down and delivers it when the bus returns. Late, never lost.', run: (s) => { s.inject('bus', 'down', true, 1200); startOrder(s, { side: 'buy', qty: 100 }); } },
      { id: 'dup', label: 'Outbox delivers twice', desc: 'The journal delivers each outbox entry twice, so capture books each trade twice. Clearing accepts the trade id once.', run: (s) => { s.inject('journal', 'duplicate'); startOrder(s, { side: 'buy', qty: 100 }); } },
      { id: 'clearing-down', label: 'Clearing down during capture', desc: 'Capture cannot book for three seconds. The trade waits on the bus, retried every 300 ms, and is booked once when clearing returns.', run: (s) => { s.inject('clearing', 'down', true, 3000); startOrder(s, { side: 'buy', qty: 100 }); } },
      { id: 'dropcopy-down', label: 'No drop copy', desc: 'Everything books correctly, but the independent record is down. Nothing can prove clearing right; the trade stays unverified.', run: (s) => { s.inject('dropcopy', 'down'); startOrder(s, { side: 'buy', qty: 100 }); } },
      { id: 'netting', label: 'Three trades, one instruction', desc: 'Maya buys 300, sells 200, buys 100. Settlement nets them: receive 200 ACME, pay $10,060, in one instruction.', run: (s) => { startOrder(s, { side: 'buy', qty: 300 }); s.schedule(700, () => startOrder(s, { side: 'sell', qty: 200 })); s.schedule(1400, () => startOrder(s, { side: 'buy', qty: 100 })); } },
      { id: 'gross', label: 'Three trades, six instructions', desc: 'Netting off: every trade settles on its own, two legs each. Same positions, six depository movements instead of two.', sw: { netting: false }, run: (s) => { startOrder(s, { side: 'buy', qty: 300 }); s.schedule(700, () => startOrder(s, { side: 'sell', qty: 200 })); s.schedule(1400, () => startOrder(s, { side: 'buy', qty: 100 })); } },
      { id: 'burst', label: 'Burst, one write per trade', desc: `Quill and Nova trade ${Y.num(BURST)} times a second for three seconds. Capture books one trade per clearing write and falls behind: Maya’s fill queues behind hundreds of others.`, run: (s) => { s.schedule(200, () => setBurst(s, true)); s.schedule(3200, () => setBurst(s, false)); s.schedule(2500, () => startOrder(s, { side: 'buy', qty: 100 })); } },
      { id: 'burst-batch', label: 'Burst, batched booking', desc: `Same burst with batch booking: up to ${BATCH} trades per clearing write. Capture keeps up and Maya’s trade is booked within a cycle.`, sw: { batchBook: true }, run: (s) => { s.schedule(200, () => setBurst(s, true)); s.schedule(3200, () => setBurst(s, false)); s.schedule(2500, () => startOrder(s, { side: 'buy', qty: 100 })); } },
    ]),
    initialState: () => ({
      config: { outbox: true, idemBook: true, netting: true, batchBook: false },
      clientSeq: 0, seq: 0, burst: false, settleCycle: 0, seen: {},
      tape: [], journal: [], dropcopy: [],
      clearing: { booked: {}, trades: {}, settled: {}, positions: { maya: { acme: 0, cash: 2500000 }, quill: { acme: 100000, cash: 10000000000 }, nova: { acme: 50000, cash: 1000000000 } } },
      csd: {},
      capture: { inflight: 0 }, relay: { inflight: 0 },
      recon: null,
      stats: { lostPublish: 0, relayRetries: 0, bookRetries: 0, captureCrashes: 0, dupSkipped: 0, doubleBooked: 0, recons: 0, repaired: 0, instructions: 0, settledTrades: 0, settleRetries: 0, bursts: 0, batches: 0 },
    }),
    initialUI: () => ({ maya: { pending: 0, orders: [], acme: 0, cash: 2500000 } }),
    actions: {
      order(sim, a) { startOrder(sim, { side: a.side, qty: a.qty }); },
      burst(sim, a) { setBurst(sim, !!a.on); },
      recon(sim) { startRecon(sim, true); },
      repair(sim) { startRepair(sim); },
      settle(sim) { startSettle(sim, true); },
    },
    handlers: {
      gateway: {
        newOrder: function* (ctx, p) {
          const st = ctx.state;
          const key = `${p.owner}/${p.clientOrderId}`;
          if (st.seen[key]) return st.seen[key];
          const r = ctx.must(yield ctx.call('engine', 'submit', p, { timeout: 1200, quiet: p.quiet }));
          st.seen[key] = r;
          return r;
        },
      },
      engine: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          const seq = ++st.seq;
          const fillPx = p.side === 'buy' ? ASK : BID;
          const t = { id: 'T' + seq, seq, buyer: p.side === 'buy' ? p.owner : 'quill', seller: p.side === 'buy' ? 'quill' : p.owner, qty: p.qty, px: fillPx, t: ctx.now(), actionId: p.actionId, quiet: p.quiet };
          const j = yield ctx.call('journal', 'append', { trade: t }, { timeout: 600, quiet: p.quiet });
          if (!j.ok) ctx.fail('JOURNAL_UNAVAILABLE', 'The trade could not be journaled, so it did not happen.');
          st.tape.push(t);
          ctx.spawn(function* (c) { yield c.call('dropcopy', 'record', { trade: t }, { timeout: 600, quiet: p.quiet ? 'all' : true }); });
          if (!st.config.outbox) {
            ctx.spawn(function* (c) {
              const r = yield c.call('bus', 'publish', { trades: [t] }, { timeout: 600, quiet: p.quiet });
              if (!r.ok) { st.stats.lostPublish++; c.log({ op: `publish of ${t.id} failed`, status: 'lost', detail: `The journal has ${t.id}; the bus never got it. Nothing will retry this: the engine has moved on.` }); }
            });
          }
          return { tradeId: t.id, px: fillPx, qty: p.qty };
        },
      },
      journal: {
        append(ctx, p) {
          const st = ctx.state;
          st.journal.push(p.trade);
          if (st.config.outbox) ctx.sim.enqueue('outbox', { type: 'trade', eventId: p.trade.id, payload: p.trade, actionId: p.trade.actionId, quiet: p.trade.quiet });
          return { seq: p.trade.seq };
        },
      },
      dropcopy: {
        record(ctx, p) { ctx.state.dropcopy.push(p.trade); return { ok: true }; },
        list(ctx) { return { trades: ctx.state.dropcopy.slice() }; },
      },
      bus: {
        publish(ctx, p) {
          for (const t of p.trades) ctx.sim.enqueue('trades', { type: 'trade', eventId: t.id, payload: t, actionId: t.actionId, quiet: t.quiet });
          return { appended: p.trades.length };
        },
      },
      clearing: {
        book(ctx, p) {
          const st = ctx.state;
          const C = st.clearing;
          let booked = 0, dup = 0;
          const dupIds = [];
          for (const t of p.trades) {
            if (st.config.idemBook && C.booked[t.id]) { dup++; dupIds.push(t.id); st.stats.dupSkipped++; continue; }
            C.booked[t.id] = (C.booked[t.id] || 0) + 1;
            if (C.booked[t.id] > 1) st.stats.doubleBooked++;
            C.trades[t.id] = t;
            const b = C.positions[t.buyer], s = C.positions[t.seller];
            b.acme += t.qty; b.cash -= t.qty * t.px; s.acme -= t.qty; s.cash += t.qty * t.px;
            booked++;
          }
          if (dup && !p.quiet) ctx.log({ op: `${dup} trade${dup === 1 ? '' : 's'} already booked`, status: 'dup', detail: `Trade id${dup === 1 ? '' : 's'} ${dupIds.slice(0, 3).join(', ')} seen before: no change to positions.` });
          return { booked, dup };
        },
        unbook(ctx, p) {
          const C = ctx.state.clearing;
          const t = C.trades[p.tradeId];
          const extra = (C.booked[p.tradeId] || 0) - p.keep;
          if (!t || extra <= 0) return { reversed: 0 };
          const b = C.positions[t.buyer], s = C.positions[t.seller];
          for (let i = 0; i < extra; i++) { b.acme -= t.qty; b.cash += t.qty * t.px; s.acme += t.qty; s.cash -= t.qty * t.px; }
          C.booked[p.tradeId] = p.keep;
          return { reversed: extra };
        },
        list(ctx) { return { booked: Object.assign({}, ctx.state.clearing.booked) }; },
        unsettled(ctx) { const C = ctx.state.clearing; return { trades: Object.values(C.trades).filter((t) => !C.settled[t.id]) }; },
        markSettled(ctx, p) { const C = ctx.state.clearing; for (const id of p.ids) C.settled[id] = p.cycle; return { ok: true }; },
      },
      csd: {
        instruct(ctx, p) {
          const st = ctx.state;
          let done = 0;
          for (const i of p.instructions) { if (st.csd[i.id]) continue; st.csd[i.id] = i; done++; }
          return { executed: done };
        },
      },
    },
    setup(sim) {
      // Outbox relay: journal outbox → trade bus, batched, at least once.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msgs } = yield ctx.take('outbox', 'relay', 200);
          const st = ctx.state;
          st.relay.inflight = msgs.length;
          const r = yield ctx.call('bus', 'publish', { trades: msgs.map((m) => m.payload) }, { timeout: 600, quiet: msgs.every((m) => m.quiet) ? 'all' : false });
          if (!r.ok) { st.stats.relayRetries++; ctx.log({ op: 'relay retry', status: 'retry', error: r.error, detail: `${msgs.length} journaled trade${msgs.length === 1 ? '' : 's'} wait in the outbox until the bus accepts them.` }); ctx.nack('outbox', 'relay'); st.relay.inflight = 0; yield ctx.wait(300); continue; }
          st.relay.inflight = 0;
          ctx.ack('outbox', 'relay');
        }
      }, { self: 'relay' });
      // Trade capture: bus → clearing, acknowledge only after booking.
      sim.spawn(function* (ctx) {
        for (;;) {
          const st = ctx.state;
          const { msgs } = yield ctx.take('trades', 'tradecap', st.config.batchBook ? BATCH : 1);
          st.capture.inflight = msgs.length;
          if (msgs.length > 1) st.stats.batches++;
          const r = yield ctx.call('clearing', 'book', { trades: msgs.map((m) => m.payload), quiet: msgs.every((m) => m.quiet) }, { timeout: 800, quiet: msgs.every((m) => m.quiet) ? 'all' : false, actionId: msgs.find((m) => m.actionId) && msgs.find((m) => m.actionId).actionId });
          if (!r.ok) { st.stats.bookRetries++; ctx.nack('trades', 'tradecap'); st.capture.inflight = 0; yield ctx.wait(300); continue; }
          if (ctx.mode('crashAfterBook', 'tradecap')) {
            st.stats.captureCrashes++;
            ctx.sim.restore('tradecap', 'crashAfterBook');
            ctx.sim.inject('tradecap', 'crashed', true, 1000);
            ctx.log({ op: 'crashed before acknowledging', status: 'lost', detail: `Clearing booked ${msgs.map((m) => m.payload.id).join(', ')}, but trade capture died before marking the offset. On restart the bus will deliver ${msgs.length === 1 ? 'it' : 'them'} again.` });
            while (ctx.mode('crashed', 'tradecap')) yield ctx.wait(100);
            ctx.log({ op: 'restarted: redelivery', status: 'retry', detail: 'The unacknowledged message comes back. Only the booking’s idempotency decides whether positions change again.' });
            ctx.nack('trades', 'tradecap');
            st.capture.inflight = 0;
            continue;
          }
          for (const m of msgs) if (m.actionId) ctx.sim.setLedger(m.actionId, 'async', 'yes', `Trade ${m.payload.id} booked at clearing${r.value.dup ? ' (a repeat was recognised)' : ''}.`);
          st.capture.inflight = 0;
          ctx.ack('trades', 'tradecap');
        }
      }, { self: 'tradecap' });
      // Reconciliation and settlement cycles.
      sim.spawn(function* (ctx) { for (;;) { yield ctx.wait(RECON_MS); if (ctx.alive() && ctx.state.dropcopy.length) startRecon(ctx.sim, false); } }, { self: 'recon', quiet: 'all' });
      sim.spawn(function* (ctx) { for (;;) { yield ctx.wait(SETTLE_MS); if (ctx.alive()) startSettle(ctx.sim, false); } }, { self: 'settle', quiet: 'all' });
      Y.load(sim, 'quill', (s) => (s.state.burst ? BURST : 0), function* (ctx, i) {
        ctx.state.stats.bursts++;
        yield ctx.call('gateway', 'newOrder', { clientOrderId: `nova-${i}`, owner: 'nova', side: i % 2 ? 'buy' : 'sell', qty: 10, quiet: 'all' }, { timeout: 1500, quiet: 'all' });
      });
    },
    consistency(sim) {
      const st = sim.state;
      const C = st.clearing;
      const dbl = Object.entries(C.booked).filter(([, n]) => n > 1);
      if (dbl.length) return { key: 'wrong', label: `${dbl.length} trade${dbl.length === 1 ? '' : 's'} booked twice at clearing (${dbl.slice(0, 3).map(([id, n]) => `${id} ×${n}`).join(', ')}): Maya’s clearing position is ${Y.num(C.positions.maya.acme)} ACME against ${Y.num(sim.ui.maya.acme)} traded.` };
      const unbooked = st.journal.filter((t) => !C.booked[t.id]);
      const inFlight = sim.queueStats('outbox').depth + sim.queueStats('trades').depth + st.capture.inflight + st.relay.inflight;
      const lost = unbooked.filter((t) => sim.now - t.t > 800).length - inFlight;
      if (lost > 0 && !st.config.outbox) return { key: 'wrong', label: `${lost} journaled trade${lost === 1 ? '' : 's'} will never reach clearing: the engine’s second write to the bus failed and nothing retries it. Maya owns shares clearing does not know about.` };
      if (sim.ui.maya.pending) return { key: 'stale', label: 'Maya’s order is in flight.' };
      if (unbooked.length) return { key: 'stale', label: `${Y.num(unbooked.length)} trade${unbooked.length === 1 ? '' : 's'} journaled but not yet booked at clearing${sim.nodes.clearing.modes.down ? ' (clearing is down; capture retries)' : sim.nodes.bus.modes.down ? ' (the bus is down; the relay retries)' : sim.nodes.tradecap.modes.crashed ? ' (trade capture crashed)' : ` (${SDL.fmtMs(sim.queueStats('trades').lag)} behind)`}. The fills are final; positions lag.` };
      if (sim.nodes.dropcopy.modes.down && st.journal.length) return { key: 'stale', label: 'Clearing matches the journal, but the drop copy is down: reconciliation has no independent record to prove it.' };
      const unsettled = Object.values(C.trades).filter((t) => !C.settled[t.id]).length;
      return { key: 'ok', label: `Every journaled trade is booked exactly once at clearing (${Y.num(st.journal.length)}), the drop copy agrees${st.recon && st.recon.at ? ` (reconciled ${SDL.fmtMs(sim.now - st.recon.at)} ago)` : ''}, ${st.stats.instructions ? `${st.stats.settledTrades} settled in ${st.stats.instructions} instruction${st.stats.instructions === 1 ? '' : 's'}` : 'nothing settled yet'}${unsettled ? `, ${unsettled} awaiting the next cycle` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const depth = sim.queueStats('trades').depth;
      return [
        { label: 'Journaled trades', value: Y.num(st.journal.length) },
        { label: 'Booked at clearing', value: Y.num(Object.keys(st.clearing.booked).length) },
        { label: 'Bus backlog', value: Y.num(depth), tone: depth > 100 ? 'fail' : depth > 10 ? 'warn' : '' },
        { label: 'Repeats recognised', value: st.stats.dupSkipped },
        { label: 'Double bookings', value: st.stats.doubleBooked, tone: st.stats.doubleBooked ? 'fail' : '' },
        { label: 'Lost publishes', value: st.stats.lostPublish, tone: st.stats.lostPublish ? 'fail' : '' },
        { label: 'Settlement instructions', value: st.stats.instructions },
        { label: 'Reconciliation breaks', value: st.recon ? st.recon.breaks.length : '–', tone: st.recon && st.recon.breaks.length ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Maya’s broker shows her fills and what clearing has booked. The console is the clearing house: trades by id, positions, reconciliation, settlement.',
          side: `<p class="ops-title">Clearing house</p><div class="ops-traffic">${Y.btn('burst', `Background trades (${Y.num(BURST)}/s)`, { arg: { on: true }, cls: 'secondary' })}${Y.btn('burst', 'Stop', { arg: { on: false }, cls: 'secondary' })}${Y.btn('recon', 'Reconcile now', { cls: 'secondary' })}${Y.btn('repair', 'Repair from drop copy', { cls: 'go' })}${Y.btn('settle', 'Settle now', { cls: 'secondary' })}</div><div data-ref="ops"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const C = st.clearing;
        const u = sim.ui.maya;
        const status = (o) => {
          if (o.status !== 'filled') return o.status;
          const n = C.booked[o.tradeId] || 0;
          if (!n) return 'filled · clearing pending';
          if (n > 1) return `filled · booked ×${n}`;
          return C.settled[o.tradeId] ? 'filled · settled' : 'filled · cleared';
        };
        const card = (o) => `<div class="app-card ${o.status === 'rejected' || (C.booked[o.tradeId] || 0) > 1 ? 'is-fail' : o.status === 'filled' && C.booked[o.tradeId] ? 'is-ok' : ''}"><span class="app-kv"><strong>${o.side === 'buy' ? 'Buy' : 'Sell'} ${Y.num(o.qty)}${o.px ? ` @ ${px(o.px)}` : ''}</strong><span>${o.status === 'sending' ? '<span class="spinner"></span>' : esc(o.tradeId || '')}</span></span><span class="app-sub">${esc(o.reason || status(o))}</span></div>`;
        const cp = C.positions.maya;
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Finch</p><p class="app-sub">Maya · ${Y.num(u.acme)} ACME · cash ${px(u.cash)}</p></div>`,
          clearing: `<div class="app-card ${cp.acme !== u.acme ? 'is-hot' : ''}"><span class="app-kv"><strong>At clearing</strong><span>${Y.num(cp.acme)} ACME · ${px(cp.cash)}</span></span><span class="app-sub">${cp.acme === u.acme && cp.cash === u.cash ? 'matches your fills' : `differs from your fills (${Y.num(u.acme)} ACME, ${px(u.cash)})`}</span></div>`,
          ticket: `${Y.btn('order', 'Buy 100 at market ($5,020)', { arg: { side: 'buy', qty: 100 } })}<div class="app-row">${Y.btn('order', 'Buy 300', { arg: { side: 'buy', qty: 300 }, cls: 'secondary' })}${Y.btn('order', 'Sell 200', { arg: { side: 'sell', qty: 200 }, cls: 'secondary', disabled: u.acme < 200 })}</div>`,
          orders: u.orders.length ? `<p class="app-sub">Orders</p>${u.orders.slice(-4).reverse().map(card).join('')}` : '<p class="app-sub">No orders yet.</p>',
        }, {});
        const c = sim.scenario.consistency(sim);
        const recent = st.journal.slice(-6).reverse();
        const rows = recent.map((t) => { const n = C.booked[t.id] || 0; const inDc = st.dropcopy.some((d) => d.id === t.id); return `<tr><td>${t.id}</td><td>${esc(NAMES[t.buyer])} ← ${esc(NAMES[t.seller])}</td><td class="num">${Y.num(t.qty)} @ ${px(t.px)}</td><td>${n === 0 ? '<span class="chip" data-tone="warn">pending</span>' : n === 1 ? (C.settled[t.id] ? '<span class="chip" data-tone="ok">settled</span>' : '<span class="chip" data-tone="ok">booked</span>') : `<span class="chip" data-tone="fail">×${n}</span>`}</td><td>${inDc ? '✓' : '–'}</td></tr>`; }).join('');
        const pos = ['maya', 'quill', 'nova'].map((a) => `<div class="ops-row" data-tone="${a === 'maya' && C.positions.maya.acme !== u.acme ? 'warn' : 'ok'}"><div class="ops-name">${esc(NAMES[a])}<span>${Y.num(C.positions[a].acme)} ACME · ${money(C.positions[a].cash)}</span></div></div>`).join('');
        const r = st.recon;
        SDL.ui.paintSections(el.querySelector('[data-ref="ops"]'), {
          trades: `<table class="ledger"><thead><tr><th>Trade</th><th>Buyer ← seller</th><th class="num">Size</th><th>Clearing</th><th>Drop copy</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">No trades yet.</td></tr>'}</tbody></table><p class="app-sub">${Y.num(st.journal.length)} journaled · ${Y.num(Object.keys(C.booked).length)} booked · bus backlog ${Y.num(sim.queueStats('trades').depth)}${st.stats.lostPublish ? ` · <strong>${st.stats.lostPublish} publish${st.stats.lostPublish === 1 ? '' : 'es'} lost</strong>` : ''}</p>`,
          positions: `<p class="app-sub">Positions at clearing</p><div class="ops-shards">${pos}</div>`,
          recon: `<p class="app-sub">Reconciliation: ${r ? (r.error ? esc(r.error) : `${r.compared} fills compared ${SDL.fmtMs(sim.now - r.at)} ago, ${r.breaks.length ? `<strong>${r.breaks.length} break${r.breaks.length === 1 ? '' : 's'}</strong>: ${r.breaks.slice(0, 3).map((b) => `${b.trade.id} ${b.kind}`).join(', ')}` : 'no breaks'}`) : 'not run yet'} · settlement: ${st.stats.instructions} instruction${st.stats.instructions === 1 ? '' : 's'} for ${st.stats.settledTrades} trade${st.stats.settledTrades === 1 ? '' : 's'}</p><p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
