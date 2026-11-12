/*
 * Gateway, pre-trade risk, and throttles.
 * Before an order may reach the sequencer it passes the member’s session, a
 * per-participant throttle, and the risk service: size and price sanity
 * checks, and buying power reserved at order time. A market maker’s algorithm
 * runs away, an operator pulls the kill switch, and the risk service goes down
 * under both policies: fail closed and fail open.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const NAMES = { maya: 'Maya', quill: 'Quill Capital', operator: 'Operator' };
  const REF = 5020; // reference price in cents
  const RUNAWAY = 5000; // orders per second from the runaway algorithm
  const LIMIT = { maxQty: 10000, maxNotional: 100000000, bandPct: 0.10, rate: { maya: 20, quill: 100 } };
  const px = (c) => '$' + (c / 100).toFixed(2);

  function startOrder(sim, owner, o) {
    const st = sim.state;
    sim.startAction(`${NAMES[owner]}: ${o.side} ${Y.num(o.qty)} ${o.px == null ? 'at market' : `@ ${px(o.px)}`}`, function* (ctx) {
      const u = ctx.ui[owner];
      const clientOrderId = `${owner}-${++st.clientSeq}`;
      const rec = { id: clientOrderId, side: o.side, qty: o.qty, px: o.px, status: 'sending', reason: '' };
      if (u) { u.pending++; u.orders.push(rec); }
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'The gateway deduplicates by client order id.'] });
      const r = yield* ctx.retry({ attempts: 2, baseMs: 200 }, function* () { return yield ctx.call('gateway', 'newOrder', { clientOrderId, owner, side: o.side, px: o.px, qty: o.qty }, { timeout: 1200 }); });
      ctx.recordOutcome(r.ok, r.latency);
      if (u) u.pending--;
      if (r.ok) {
        rec.status = r.value.filled ? 'filled' : 'cancelled'; rec.fillPx = r.value.px; rec.reason = r.value.filled ? `${r.value.filled} @ ${px(r.value.px)}` : 'no liquidity';
        Y.L(ctx, { displayed: 'yes', accepted: ['yes', r.value.unchecked ? 'Accepted WITHOUT a risk check (fail open).' : `Risk check passed${r.value.reserved ? `, ${px(r.value.reserved)} of buying power reserved` : ''}.`], committed: 'yes', async: 'n/a' });
        ctx.explain(r.value.unchecked ? `The risk service was down and the gateway is configured to fail open, so the order went straight to the sequencer. It filled; nobody checked whether ${NAMES[owner]} could pay.` : `Session valid, within the throttle, within size and price limits, ${o.side === 'buy' ? `${px((o.px == null ? REF : o.px) * o.qty)} of buying power ${st.config.reserve ? 'reserved' : 'available (not reserved)'}` : 'a sell'}: sequenced and filled at ${px(r.value.px)}. The whole check added about ${Math.round(r.latency)} ms on this scale, microseconds in reality.`);
      } else {
        rec.status = 'rejected'; rec.reason = r.error.message;
        Y.failed(ctx, 'The order was rejected before it reached the book.');
        const why = { RATE_LIMITED: 'The throttle protects everyone else from one member’s message rate.', RISK_REJECT: 'Pre-trade risk said no. Nothing reached the sequencer, so there is nothing to unwind.', RISK_UNAVAILABLE: 'With the risk service down the gateway fails closed: no order is better than an unchecked order.', SESSION_DISABLED: 'The kill switch disabled this session; every message is refused at the door.', TIMEOUT: `The sequencer’s queue is full of someone else’s messages. ${NAMES[owner]}’s order timed out behind them.` }[r.error.code];
        ctx.explain(`${r.error.message} ${why || ''}`);
      }
    }, { self: owner });
  }

  function startKill(sim) {
    sim.startAction('Operator: kill switch for Quill Capital', function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('gateway', 'kill', { owner: 'quill' }, { timeout: 600 });
      if (r.ok) { Y.L(ctx, { accepted: 'yes', committed: ['yes', 'Session disabled; resting orders cancelled.'], async: 'n/a' }); ctx.explain('The session store now says Quill is disabled. The algorithm keeps sending; the gateway refuses every message without touching the throttle, risk, or the sequencer.'); }
      else Y.failed(ctx);
    }, { self: 'operator' });
  }

  function setRunaway(sim, on) { sim.state.runaway = on; sim.note(on ? `Quill’s algorithm runs away: ${Y.num(RUNAWAY)} orders a second.` : 'Quill’s algorithm stopped.'); }

  const sc = (SDL.scenarios['ex-risk'] = {
    id: 'ex-risk',
    seed: 303,
    productWidth: 620,
    intro: 'Buy from Maya’s phone, send a fat-finger order from Quill’s console, let Quill’s algorithm run away and throttle it, then take the risk service down under both policies.',
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'Finch broker app', x: 90, y: 110, latency: 1, role: 'Retail orders, $25,000 of buying power.', owns: ['What Maya sees'] },
        { id: 'quill', label: 'Quill Capital', kind: 'client', sub: 'Market maker, algorithm', x: 90, y: 300, latency: 1, role: 'A direct member whose algorithm can misbehave.', owns: ['Its orders'] },
        { id: 'operator', label: 'Exchange operator', kind: 'client', sub: 'Kill switch', x: 90, y: 490, latency: 1, role: 'Can disable any member’s session.', owns: ['Nothing'] },
        { id: 'gateway', label: 'Order entry gateway', kind: 'gateway', sub: 'Session, throttle, risk, then sequence', x: 330, y: 300, latency: 1, role: 'The door. Checks the session, takes a throttle token, asks risk, and only then forwards to the sequencer.', ops: [{ name: 'newOrder', desc: 'Validate and forward.' }, { name: 'kill', desc: 'Disable a session.' }], owns: ['Client order ids seen'] },
        { id: 'sessions', label: 'Session store', kind: 'cache', sub: 'Who may trade', x: 330, y: 110, latency: 1, role: 'Session state per member: active or disabled.', ops: [{ name: 'get', desc: 'Session state.' }, { name: 'kill', desc: 'Disable.' }], owns: ['sessions'] },
        { id: 'throttle', label: 'Throttle', kind: 'service', sub: 'Token bucket per member', x: 560, y: 130, latency: 1, role: `Each member gets a message rate (Quill ${LIMIT.rate.quill}/s, Maya’s broker ${LIMIT.rate.maya}/s). Over it, the gateway rejects without doing any further work.`, ops: [{ name: 'take', desc: 'Take one token.' }], owns: ['buckets'] },
        { id: 'risk', label: 'Pre-trade risk', kind: 'service', sub: 'Limits and buying power', x: 560, y: 300, latency: 2, role: 'Size, notional, and price sanity; buying power with reservation; settlement of fills.', ops: [{ name: 'check', desc: 'Approve or reject.' }, { name: 'settle', desc: 'Apply a fill.' }], owns: ['Reservations'] },
        { id: 'limits', label: 'Limits and balances', kind: 'db', x: 560, y: 480, latency: 3, sub: 'Per account', role: 'Cash, positions, and per-account limits.', ops: [{ name: 'get', desc: 'Read limits and balance.' }], owns: ['accounts'] },
        { id: 'matcher', label: 'Sequencer and engine', kind: 'worker', sub: 'Single thread', x: 800, y: 300, latency: 1, serviceMs: 0.3, role: 'Sequences and matches. Everything the gateway lets through lands in this one queue.', ops: [{ name: 'submit', desc: 'Sequence and match.' }], owns: ['The book'] },
        { id: 'audit', label: 'Audit log', kind: 'store', sub: 'Every message, every decision', x: 800, y: 480, latency: 4, role: 'Accepted and rejected messages alike, for surveillance and disputes.', ops: [{ name: 'append', desc: 'Record.' }], owns: ['audit trail'] },
      ],
      edges: [
        { from: 'maya', to: 'gateway', latency: 40 },
        { from: 'quill', to: 'gateway', latency: 1 },
        { from: 'operator', to: 'gateway', latency: 5 },
        { from: 'gateway', to: 'sessions', latency: 1 },
        { from: 'gateway', to: 'throttle', latency: 1 },
        { from: 'gateway', to: 'risk', latency: 1 },
        { from: 'risk', to: 'limits', latency: 1 },
        { from: 'gateway', to: 'matcher', latency: 1, via: [[440, 300], [440, 220], [680, 220], [680, 300]] },
        { from: 'matcher', to: 'audit', latency: 2 },
      ],
      queues: [],
    },
    failures: [
      { id: 'risk-down', node: 'risk', mode: 'down', label: 'Risk service down', desc: 'Fail closed rejects everything; fail open checks nothing.' },
      { id: 'risk-slow', node: 'risk', mode: 'slow', params: { factor: 80 }, label: 'Risk service slow', desc: 'Every order waits for its check.' },
      { id: 'limits-down', node: 'limits', mode: 'down', label: 'Limits database down', desc: 'Risk cannot read balances; same policy question.' },
      { id: 'throttle-down', node: 'throttle', mode: 'down', label: 'Throttle down', desc: 'The gateway lets everything through: a protection, not a gate.' },
      { id: 'sessions-down', node: 'sessions', mode: 'down', label: 'Session store down', desc: 'Nobody can be authenticated; every order is refused.' },
      { id: 'gateway-drop', node: 'gateway', mode: 'dropResponse', label: 'Gateway replies lost', desc: 'Members retry; client order ids keep it to one order.' },
      { id: 'matcher-slow', node: 'matcher', mode: 'slow', params: { factor: 20 }, label: 'Sequencer slow', desc: 'The queue in front of the single thread grows.' },
    ],
    switches: Y.switches([
      ['failClosed', 'Fail closed when risk is unavailable', 'If the risk service cannot answer, reject the order. Off: let it through unchecked.'],
      ['reserve', 'Reserve buying power at order time', 'A buy reserves its notional the moment it passes risk, so a second buy sees less. Off: each order is checked against the full balance.'],
      ['throttle', 'Per-participant throttle', `A token bucket per member (Quill ${LIMIT.rate.quill}/s). Off: every message reaches risk and the sequencer.`],
      ['fatFinger', 'Size and price sanity checks', `Reject orders over ${Y.num(LIMIT.maxQty)} shares, over ${px(LIMIT.maxNotional)}, or priced more than ${LIMIT.bandPct * 100}% from the reference. Off: trust the member.`],
    ]),
    presets: Y.presets({ failClosed: true, reserve: true, throttle: true, fatFinger: true }, [
      { id: 'normal', label: 'A normal order', desc: 'Session, throttle token, risk check with reservation, sequence, fill, settle, audit.', run: (s) => startOrder(s, 'maya', { side: 'buy', qty: 100, px: null }) },
      { id: 'fat-finger', label: 'Fat finger rejected', desc: 'Quill means $50.50 and types $0.50. The price is 99% from the reference, so risk rejects it before anyone can buy 500 shares for a cent each.', run: (s) => startOrder(s, 'quill', { side: 'sell', qty: 500, px: 50 }) },
      { id: 'fat-finger-bad', label: 'Fat finger accepted', desc: 'Same typo with sanity checks off: 500 shares trade at $0.50. An erroneous trade that the exchange will spend the afternoon breaking.', sw: { fatFinger: false }, run: (s) => startOrder(s, 'quill', { side: 'sell', qty: 500, px: 50 }) },
      { id: 'reserve', label: 'Two buys, buying power reserved', desc: 'Maya taps “Buy 300” twice. The first reserves $15,060 of her $25,000; the second sees $9,940 and is rejected.', run: (s) => { startOrder(s, 'maya', { side: 'buy', qty: 300, px: null }); s.schedule(60, () => startOrder(s, 'maya', { side: 'buy', qty: 300, px: null })); } },
      { id: 'reserve-bad', label: 'Two buys, nothing reserved', desc: 'Both orders are checked against the full $25,000 while the other is in flight. Both fill. Maya owes $30,120 with $25,000.', sw: { reserve: false }, run: (s) => { startOrder(s, 'maya', { side: 'buy', qty: 300, px: null }); s.schedule(60, () => startOrder(s, 'maya', { side: 'buy', qty: 300, px: null })); } },
      { id: 'risk-down-closed', label: 'Risk down, fail closed', desc: 'The risk service is unreachable. The gateway rejects Maya’s orders: no trading on this gateway until risk is back.', run: (s) => { s.inject('risk', 'down'); startOrder(s, 'maya', { side: 'buy', qty: 300, px: null }); s.schedule(60, () => startOrder(s, 'maya', { side: 'buy', qty: 300, px: null })); } },
      { id: 'risk-down-open', label: 'Risk down, fail open', desc: 'Same outage with fail open: both buys go straight to the sequencer and fill. Nobody checked buying power; Maya is overdrawn.', sw: { failClosed: false }, run: (s) => { s.inject('risk', 'down'); startOrder(s, 'maya', { side: 'buy', qty: 300, px: null }); s.schedule(60, () => startOrder(s, 'maya', { side: 'buy', qty: 300, px: null })); } },
      { id: 'runaway', label: 'Runaway algorithm, throttled', desc: `Quill sends ${Y.num(RUNAWAY)} orders a second. The throttle passes ${LIMIT.rate.quill} and rejects the rest at the gateway; Maya’s order is unaffected.`, run: (s) => { s.schedule(300, () => setRunaway(s, true)); s.schedule(2000, () => startOrder(s, 'maya', { side: 'buy', qty: 100, px: null })); s.schedule(4500, () => setRunaway(s, false)); } },
      { id: 'runaway-bad', label: 'Runaway algorithm, no throttle', desc: 'Every one of those orders reaches risk and the sequencer. The single thread’s queue grows by more than a second every second and Maya’s order times out behind it.', sw: { throttle: false }, run: (s) => { s.schedule(300, () => setRunaway(s, true)); s.schedule(2000, () => startOrder(s, 'maya', { side: 'buy', qty: 100, px: null })); s.schedule(4500, () => setRunaway(s, false)); } },
      { id: 'kill', label: 'Kill switch', desc: 'The operator disables Quill’s session mid-runaway. From then on the gateway refuses every message from it before any other check.', run: (s) => { s.schedule(300, () => setRunaway(s, true)); s.schedule(1800, () => startKill(s)); s.schedule(2500, () => startOrder(s, 'maya', { side: 'buy', qty: 100, px: null })); s.schedule(4500, () => setRunaway(s, false)); } },
      { id: 'retry', label: 'Lost reply, one order', desc: 'The gateway’s reply to Maya is lost and her broker resends. The gateway recognises the client order id and returns the first result: one fill, one charge.', run: (s) => { s.inject('gateway', 'dropResponse', true, 500); startOrder(s, 'maya', { side: 'buy', qty: 100, px: null }); } },
    ]),
    initialState: () => ({
      config: { failClosed: true, reserve: true, throttle: true, fatFinger: true },
      accounts: { maya: { cash: 2500000, reserved: 0, shares: 0 }, quill: { cash: 10000000000, reserved: 0, shares: 5000 } },
      sessions: { maya: 'active', quill: 'active' },
      buckets: {}, seen: {}, clientSeq: 0, runaway: false, seq: 0, trades: [],
      stats: { fills: 0, rejected: { rate: 0, risk: 0, riskDown: 0, session: 0 }, unchecked: 0, runawaySent: 0, runawayFilled: 0, timeouts: 0, dupes: 0, killed: 0, erroneous: 0 },
    }),
    initialUI: () => ({ maya: { pending: 0, orders: [] }, quill: { pending: 0, orders: [] } }),
    actions: {
      order(sim, a) { startOrder(sim, a.owner, { side: a.side, qty: a.qty, px: a.px == null ? null : a.px }); },
      runaway(sim, a) { setRunaway(sim, !!a.on); },
      kill(sim) { startKill(sim); },
    },
    handlers: {
      gateway: {
        newOrder: function* (ctx, p) {
          const st = ctx.state;
          const key = `${p.owner}/${p.clientOrderId}`;
          if (st.seen[key]) { st.stats.dupes++; ctx.log({ op: 'duplicate recognised', status: 'dup', detail: `Client order id ${p.clientOrderId} was already processed; returning the same result.` }); return st.seen[key]; }
          const sess = ctx.must(yield ctx.call('sessions', 'get', { owner: p.owner }, { timeout: 300, quiet: p.quiet }));
          if (sess.state !== 'active') { st.stats.rejected.session++; ctx.fail('SESSION_DISABLED', `${NAMES[p.owner]}’s session is disabled.`); }
          if (st.config.throttle) {
            const t = yield ctx.call('throttle', 'take', { owner: p.owner }, { timeout: 200, quiet: p.quiet });
            if (t.ok && !t.value.allowed) { st.stats.rejected.rate++; ctx.fail('RATE_LIMITED', `${NAMES[p.owner]} is over ${LIMIT.rate[p.owner]} messages a second.`); }
          }
          const r = yield ctx.call('risk', 'check', p, { timeout: 400, quiet: p.quiet });
          let reserved = 0, unchecked = false;
          if (!r.ok) {
            if (st.config.failClosed) { st.stats.rejected.riskDown++; ctx.fail('RISK_UNAVAILABLE', 'Risk checks are unavailable; the order is rejected.'); }
            unchecked = true; st.stats.unchecked++;
            if (!p.quiet) ctx.log({ op: 'risk unavailable: failing open', status: 'warn', detail: 'The gateway forwards the order without any check.' });
          } else {
            if (!r.value.ok) { st.stats.rejected.risk++; ctx.fail('RISK_REJECT', r.value.reason); }
            reserved = r.value.reserved || 0;
          }
          // Settlement happens from the sequenced trade (inside the matcher), not from this call chain: a timed-out caller must not stop it.
          const m = ctx.must(yield ctx.call('matcher', 'submit', Object.assign({ reserved }, p), { timeout: 700, quiet: p.quiet }));
          const result = { filled: m.filled, px: m.px, reserved, unchecked, seq: m.seq };
          st.seen[key] = result;
          return result;
        },
        kill: function* (ctx, p) {
          ctx.must(yield ctx.call('sessions', 'kill', p, { timeout: 300 }));
          ctx.state.stats.killed++;
          return { ok: true };
        },
      },
      sessions: {
        get(ctx, p) { return { state: ctx.state.sessions[p.owner] || 'unknown' }; },
        kill(ctx, p) { ctx.state.sessions[p.owner] = 'disabled'; return { ok: true }; },
      },
      throttle: {
        take(ctx, p) {
          const st = ctx.state;
          const rate = LIMIT.rate[p.owner] || 20;
          const b = (st.buckets[p.owner] = st.buckets[p.owner] || { tokens: rate, last: ctx.now() });
          b.tokens = Math.min(rate, b.tokens + ((ctx.now() - b.last) * rate) / 1000);
          b.last = ctx.now();
          if (b.tokens >= 1) { b.tokens -= 1; return { allowed: true }; }
          return { allowed: false };
        },
      },
      risk: {
        check: function* (ctx, p) {
          const st = ctx.state;
          const lim = ctx.must(yield ctx.call('limits', 'get', { owner: p.owner }, { timeout: 300, quiet: p.quiet }));
          const notional = (p.px == null ? REF : p.px) * p.qty;
          if (st.config.fatFinger) {
            if (p.qty > lim.maxQty) return { ok: false, reason: `Size ${Y.num(p.qty)} is over the ${Y.num(lim.maxQty)}-share limit.` };
            if (notional > lim.maxNotional) return { ok: false, reason: `Notional ${px(notional)} is over the ${px(lim.maxNotional)} limit.` };
            if (p.px != null && Math.abs(p.px - REF) > REF * LIMIT.bandPct) return { ok: false, reason: `Price ${px(p.px)} is ${Math.round((Math.abs(p.px - REF) / REF) * 100)}% from the reference ${px(REF)}.` };
          }
          if (p.side === 'buy') {
            const avail = lim.cash - (st.config.reserve ? lim.reserved : 0);
            if (notional > avail) return { ok: false, reason: `Buying power ${px(avail)} is below ${px(notional)}${st.config.reserve && lim.reserved ? ` (${px(lim.reserved)} reserved by an open order)` : ''}.` };
            if (st.config.reserve) { st.accounts[p.owner].reserved += notional; return { ok: true, reserved: notional }; }
          }
          return { ok: true, reserved: 0 };
        },
        settle(ctx, p) { settleLocally(ctx.state, p.owner, p.side, p.filled, p.px, p.reserved); return { ok: true }; },
      },
      limits: { get(ctx, p) { const a = ctx.state.accounts[p.owner]; return { cash: a.cash, reserved: a.reserved, maxQty: LIMIT.maxQty, maxNotional: LIMIT.maxNotional }; } },
      matcher: {
        submit(ctx, p) {
          const st = ctx.state;
          const seq = ++st.seq;
          if (p.flood) { st.stats.runawayFilled++; return { seq, filled: 0, px: p.px }; } // IOC far from the market: nothing to match
          const fillPx = p.px == null ? REF : p.px;
          st.stats.fills++;
          const t = { id: 'T' + st.trades.length, owner: p.owner, side: p.side, qty: p.qty, px: fillPx, seq };
          if (Math.abs(fillPx - REF) > REF * LIMIT.bandPct) { st.stats.erroneous++; t.erroneous = true; }
          st.trades.push(t);
          ctx.spawn(function* (c) {
            const r = yield c.call('risk', 'settle', { owner: p.owner, side: p.side, filled: p.qty, px: fillPx, reserved: p.reserved || 0 }, { timeout: 300, quiet: p.quiet });
            if (!r.ok) settleLocally(st, p.owner, p.side, p.qty, fillPx, p.reserved || 0); // risk is down: the fill still changes the balance
            yield c.call('audit', 'append', t, { timeout: 500, quiet: true });
          });
          return { seq, filled: p.qty, px: fillPx };
        },
      },
      audit: { append(ctx) { ctx.state.stats.audited = (ctx.state.stats.audited || 0) + 1; return { ok: true }; } },
    },
    setup(sim) {
      Y.load(sim, 'quill', (s) => (s.state.runaway ? RUNAWAY : 0), function* (ctx, i) {
        const st = ctx.state;
        st.stats.runawaySent++;
        const r = yield ctx.call('gateway', 'newOrder', { clientOrderId: `algo-${i}`, owner: 'quill', side: 'buy', px: 4900, qty: 10, flood: true, quiet: 'all' }, { timeout: 1200, quiet: 'all' });
        if (!r.ok && r.error.code === 'TIMEOUT') st.stats.timeouts++;
      });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.maya;
      if (st.accounts.maya.cash < 0) return { key: 'wrong', label: `Maya’s account is overdrawn by ${px(-st.accounts.maya.cash)}: two orders were each checked against the full balance${st.stats.unchecked ? ', or not checked at all' : ''}.` };
      if (st.stats.erroneous) return { key: 'wrong', label: `${st.stats.erroneous} trade${st.stats.erroneous === 1 ? '' : 's'} printed more than ${LIMIT.bandPct * 100}% from the reference: an obviously erroneous order reached the book.` };
      if (u.pending) return { key: 'stale', label: 'Maya’s order is in flight.' };
      const last = u.orders[u.orders.length - 1];
      if (last && last.status === 'rejected' && /did not answer|timed out/i.test(last.reason)) return { key: 'stale', label: `Maya’s order timed out behind ${Y.num(st.stats.runawaySent)} algorithm messages in the sequencer’s queue.` };
      if (last && last.status === 'rejected' && /unavailable/i.test(last.reason)) return { key: 'stale', label: 'Risk checks are unavailable and the gateway fails closed: Maya cannot trade until the service is back.' };
      const w = sim.queueWait('matcher');
      if (w > 300) return { key: 'stale', label: `The sequencer’s queue is ${SDL.fmtMs(w)} deep: unthrottled traffic is delaying everyone.` };
      return { key: 'ok', label: `Balances are consistent (Maya ${px(st.accounts.maya.cash)} cash, ${st.accounts.maya.shares} ACME), every trade is within the price band, and ${st.stats.rejected.rate + st.stats.rejected.session ? `${Y.num(st.stats.rejected.rate + st.stats.rejected.session)} messages were refused at the door` : 'nothing was refused at the door'}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const w = sim.queueWait('matcher');
      return [
        { label: 'Maya buying power', value: px(st.accounts.maya.cash - st.accounts.maya.reserved), tone: st.accounts.maya.cash < 0 ? 'fail' : '' },
        { label: 'Reserved', value: px(st.accounts.maya.reserved) },
        { label: 'Fills', value: st.stats.fills },
        { label: 'Rejected by throttle', value: Y.num(st.stats.rejected.rate), tone: st.stats.rejected.rate ? 'warn' : '' },
        { label: 'Rejected by risk', value: st.stats.rejected.risk + st.stats.rejected.riskDown },
        { label: 'Refused: session disabled', value: Y.num(st.stats.rejected.session) },
        { label: 'Sequencer queue', value: SDL.fmtMs(w), tone: w > 300 ? 'fail' : w > 50 ? 'warn' : '' },
        { label: 'Algorithm messages', value: Y.num(st.stats.runawaySent) },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Maya trades through Finch. Quill’s console sends fat fingers and a runaway algorithm; the operator has the kill switch.',
          side: `<p class="ops-title">Quill Capital and the operator</p><div class="ops-traffic">${Y.btn('order', 'Quill: sell 500 @ $0.50 (typo)', { arg: { owner: 'quill', side: 'sell', qty: 500, px: 50 }, cls: 'secondary' })}${Y.btn('order', 'Quill: sell 1,000,000 @ $50.20', { arg: { owner: 'quill', side: 'sell', qty: 1000000, px: 5020 }, cls: 'secondary' })}${Y.btn('runaway', 'Start runaway algorithm', { arg: { on: true } })}${Y.btn('runaway', 'Stop algorithm', { arg: { on: false }, cls: 'secondary' })}${Y.btn('kill', 'Operator: kill switch (Quill)', { cls: 'go' })}</div><div data-ref="ops"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.maya;
        const a = st.accounts.maya;
        const card = (o) => `<div class="app-card ${o.status === 'filled' ? 'is-ok' : o.status === 'rejected' ? 'is-fail' : ''}"><span class="app-kv"><strong>${o.side === 'buy' ? 'Buy' : 'Sell'} ${Y.num(o.qty)} ${o.px == null ? 'market' : px(o.px)}</strong><span>${o.status === 'sending' ? '<span class="spinner"></span>' : esc(o.status)}</span></span><span class="app-sub">${esc(o.reason)}</span></div>`;
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Finch</p><p class="app-sub">Maya · ${a.shares} ACME</p></div>`,
          bp: `<div class="app-card ${a.cash < 0 ? 'is-fail' : ''}"><span class="app-kv"><strong>Buying power</strong><span>${px(a.cash - a.reserved)}</span></span><span class="app-sub">cash ${px(a.cash)}${a.reserved ? ` · ${px(a.reserved)} reserved` : ''}</span></div>`,
          ticket: `${Y.btn('order', 'Buy 100 at market ($5,020)', { arg: { owner: 'maya', side: 'buy', qty: 100, px: null } })}${Y.btn('order', 'Buy 300 at market ($15,060)', { arg: { owner: 'maya', side: 'buy', qty: 300, px: null }, cls: 'secondary' })}`,
          orders: u.orders.length ? `<p class="app-sub">Orders</p>${u.orders.slice(-3).reverse().map(card).join('')}` : '<p class="app-sub">No orders yet.</p>',
        }, {});
        const c = sim.scenario.consistency(sim);
        const q = sim.ui.quill;
        const w = sim.queueWait('matcher');
        SDL.ui.paintSections(el.querySelector('[data-ref="ops"]'), {
          quill: `<p class="app-sub">Quill session: ${esc(st.sessions.quill)}${st.runaway ? ` · algorithm sending ${Y.num(RUNAWAY)}/s` : ''} · ${Y.num(st.stats.rejected.rate)} throttled · ${Y.num(st.stats.rejected.session)} refused</p>${q.orders.slice(-2).reverse().map(card).join('')}`,
          seq: `<div class="ops-row" data-tone="${w > 300 ? 'fail' : w > 50 ? 'warn' : ''}"><div class="ops-name">Sequencer queue<span>${SDL.fmtMs(w)} · ${st.stats.fills} fills · ${st.stats.audited || 0} audited</span></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  function settleLocally(st, owner, side, filled, p, reserved) {
    const a = st.accounts[owner];
    a.reserved = Math.max(0, a.reserved - reserved);
    if (!filled) return;
    if (side === 'buy') { a.cash -= filled * p; a.shares += filled; } else { a.cash += filled * p; a.shares -= filled; }
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
