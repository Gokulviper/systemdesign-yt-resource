/*
 * Deep dive: payments.
 *
 * Authorise a hold when the ride is requested, capture the real fare at
 * drop-off, and treat the processor's webhook as the source of truth for
 * money movement. Every confirmed movement is posted to a double-entry
 * ledger (debits equal credits). Driver earnings accrue as a payable and are
 * paid out in batches. Reconciliation compares the ledger with what the
 * processor actually charged.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;

  const EST = 14.2;
  const HOLD = Math.round(EST * 1.2 * 100) / 100;
  const DRIVER_SHARE = 0.75;
  const money = (v) => '$' + Number(v).toFixed(2);
  const r2 = (v) => Math.round(v * 100) / 100;

  function* withRetry(ctx, policy, fn) { return yield* ctx.retry(policy, fn); }

  function startRequest(sim) {
    sim.startAction('Rider: request ride', function* (ctx) {
      const ui = ctx.ui.rider;
      const st = ctx.state;
      ctx.ledger('displayed', 'pending', 'Shows “Checking your card…”.');
      ctx.ledger('retrySafe', 'yes', 'The authorisation uses an idempotency key.');
      const trip = 'trip-' + ++st.seq.trip;
      ui.busy = true;
      const r = yield ctx.call('gateway', 'request', { trip }, { timeout: 2500 });
      ui.busy = false;
      if (r.ok) {
        Object.assign(ui, { trip, stage: 'onTrip', hold: r.value.hold, risky: r.value.risky, message: r.value.risky ? 'Ride confirmed without a card check (processor unavailable).' : `Card authorised: a ${money(r.value.hold)} hold, not a charge.`, tone: r.value.risky ? 'warn' : 'ok' });
        ctx.ledger('displayed', 'yes');
        ctx.ledger('accepted', 'yes');
        ctx.ledger('committed', 'yes', r.value.risky ? 'Trip created with no authorisation: the platform carries the risk.' : 'Authorisation recorded; no money has moved yet.');
        ctx.ledger('async', 'n/a');
        ctx.explain(r.value.risky
          ? 'The processor was down and the fail-open switch is on, so the ride went ahead without a hold. If the card later fails, the platform has given a free ride. Fail-open trades fraud risk for availability.'
          : `A hold of ${money(r.value.hold)} (estimate plus 20%) reserves funds on the card without moving money. If the rider never takes the trip, the hold simply expires.`);
      } else {
        Object.assign(ui, { message: `Couldn’t start the ride: ${r.error.message}`, tone: 'fail' });
        ctx.ledger('displayed', 'no');
        ctx.ledger('accepted', 'no', null, { ifPending: true });
        ctx.ledger('committed', 'no', null, { ifPending: true });
        ctx.ledger('async', 'n/a');
        ctx.explain(`Fail-closed: the card could not be authorised (${r.error.code}), so no ride was created. Nobody was charged and no driver was dispatched.`);
      }
    }, { self: 'rider' });
  }

  function startFinish(sim, fare) {
    const ui = sim.ui.rider;
    if (!ui.trip) return;
    const trip = ui.trip;
    sim.startAction(`Trip ends: capture ${money(fare)}`, function* (ctx) {
      const u = ctx.ui.rider;
      u.stage = 'paying';
      u.fare = fare;
      u.message = 'Processing payment…';
      u.tone = 'work';
      ctx.ledger('displayed', 'pending', 'Shows “Processing payment”.');
      ctx.ledger('retrySafe', 'yes', 'The capture carries an idempotency key.');
      const r = yield ctx.call('gateway', 'complete', { trip, fare, card: u.card }, { timeout: 4000 });
      if (r.ok) {
        ctx.ledger('accepted', 'yes', 'The processor accepted the capture; confirmation arrives by webhook.');
        ctx.ledger('displayed', 'yes', 'Shows “Payment processing” until the webhook confirms.');
        ctx.ledger('committed', 'pending', 'Money is confirmed only when the processor’s webhook is posted to the ledger.');
        ctx.ledger('async', 'pending');
        ctx.state.captureAction[trip] = ctx.actionId;
      } else {
        Object.assign(u, { stage: 'failed', message: r.error.code === 'CARD_DECLINED' ? 'Payment failed: your card was declined. The trip is complete; please update your card.' : `Payment couldn’t be processed: ${r.error.message}`, tone: 'fail' });
        ctx.ledger('displayed', 'no', 'Asks the rider for another card.');
        ctx.ledger('accepted', 'no', null, { ifPending: true });
        ctx.ledger('committed', 'no', null, { ifPending: true });
        ctx.ledger('async', 'n/a');
        ctx.explain(r.error.code === 'CARD_DECLINED'
          ? 'The ride already happened, so it cannot be undone. The trip is marked unpaid, the rider is asked for another card, and the debt stays on the account until it is collected.'
          : `The capture did not complete (${r.error.code}). Because every attempt used the same idempotency key, retrying later is safe.`);
      }
    }, { self: 'rider', detail: `The driver completes ${trip}; final fare ${money(fare)}.` });
  }

  function startRefund(sim) {
    const ui = sim.ui.rider;
    if (!ui.trip || ui.stage !== 'paid') return;
    const trip = ui.trip;
    sim.startAction('Rider: request $5 refund', function* (ctx) {
      ctx.ledger('displayed', 'pending');
      ctx.ledger('retrySafe', 'yes', 'The refund carries an idempotency key.');
      const r = yield ctx.call('gateway', 'refund', { trip, amount: 5 }, { timeout: 4000 });
      const u = ctx.ui.rider;
      if (r.ok) {
        u.message = 'Refund requested. It appears once the processor confirms.';
        u.tone = 'work';
        ctx.ledger('displayed', 'yes');
        ctx.ledger('accepted', 'yes');
        ctx.ledger('committed', 'pending', 'Posted when the refund webhook arrives.');
        ctx.ledger('async', 'pending');
        ctx.state.refundAction[trip] = ctx.actionId;
      } else {
        u.message = `Refund failed: ${r.error.message}`;
        u.tone = 'fail';
        ctx.ledger('displayed', 'no');
        ctx.ledger('accepted', 'no', null, { ifPending: true });
        ctx.ledger('committed', 'no', null, { ifPending: true });
        ctx.ledger('async', 'n/a');
      }
    }, { self: 'rider' });
  }

  function post(ctx, memo, lines, trip) {
    const st = ctx.state;
    const id = 'JE-' + ++st.seq.entry;
    for (const [account, debit, credit] of lines) st.ledger.push({ id, t: ctx.now(), memo, account, debit: debit || 0, credit: credit || 0, trip });
    return id;
  }
  const balance = (st, account) => r2(st.ledger.filter((l) => l.account === account).reduce((a, l) => a + l.debit - l.credit, 0));

  const sc = (SDL.scenarios['rides-payments'] = {
    id: 'rides-payments',
    seed: 71,
    productWidth: 620,
    intro: 'Request a ride (a hold, not a charge), end the trip (a capture confirmed by webhook), then ask for a refund. The ledger beside the phone shows every posting and checks it against the processor.',
    topology: {
      width: 1160,
      height: 600,
      nodes: [
        { id: 'rider', label: 'Rider app', sub: 'Card ending 4242', kind: 'client', x: 100, y: 90, latency: 1, role: 'Requests rides, sees payment status, asks for refunds.', ops: [{ name: 'push', desc: 'Receipts and payment updates.' }], owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Rider traffic', kind: 'gateway', x: 330, y: 90, latency: 2, role: 'Routes rider calls.', ops: [{ name: 'request', desc: 'Start a ride.' }, { name: 'complete', desc: 'End a ride.' }, { name: 'refund', desc: 'Refund part of a fare.' }], owns: ['Nothing durable'] },
        { id: 'trip', label: 'Trip service', sub: 'Asks for payment', kind: 'service', x: 560, y: 90, latency: 4, role: 'Requires an authorisation before dispatching, and a capture at drop-off.', ops: [{ name: 'create', desc: 'Authorise, then create.' }, { name: 'complete', desc: 'Capture the fare.' }], owns: ['Trip payment state'] },
        { id: 'payments', label: 'Payment service', sub: 'Talks to the processor', kind: 'service', x: 790, y: 90, latency: 5, role: 'Authorises, captures, and refunds with idempotency keys. Posts confirmed money movements to the ledger when webhooks arrive.', ops: [{ name: 'authorize', desc: 'Hold funds.' }, { name: 'capture', desc: 'Charge the final fare.' }, { name: 'confirm', desc: 'Handle a processor webhook.' }], owns: ['Payment intents', 'Processed webhook IDs'] },
        { id: 'provider', label: 'Card processor', sub: 'External PSP', kind: 'service', x: 1020, y: 90, latency: 30, role: 'Holds and moves money on cards. Deduplicates by idempotency key and reports results by webhook, retrying until acknowledged.', ops: [{ name: 'authorize', desc: 'Place a hold.' }, { name: 'capture', desc: 'Charge against a hold.' }, { name: 'refund', desc: 'Return money.' }], owns: ['Card charges'] },
        { id: 'events', label: 'Payment events', sub: 'Receipts, payouts', kind: 'queue', x: 560, y: 300, latency: 4, queue: 'payEvents', role: 'Announces confirmed payments.', ops: [{ name: 'publish', desc: 'Append an event.' }], owns: ['payment-events log'] },
        { id: 'ledger', label: 'Payment ledger', sub: 'Double entry', kind: 'db', x: 790, y: 300, latency: 8, role: 'Append-only journal. Every entry’s debits equal its credits; balances are sums of entries.', ops: [{ name: 'post', desc: 'Append a balanced journal entry.' }], owns: ['journal entries'] },
        { id: 'webhook', label: 'Webhook receiver', sub: 'From the processor', kind: 'gateway', x: 1020, y: 300, latency: 3, role: 'Receives processor callbacks and acknowledges them only after they are safely handled.', ops: [{ name: 'event', desc: 'One processor event.' }], owns: ['Nothing durable'] },
        { id: 'receipts', label: 'Receipts', sub: 'Event consumer', kind: 'worker', x: 330, y: 490, latency: 4, role: 'Sends the rider a receipt or refund notice.', ops: [{ name: 'consume', desc: 'Event → push.' }], owns: ['Its offset'] },
        { id: 'payout', label: 'Driver payouts', sub: 'Every 3 s', kind: 'worker', x: 790, y: 490, latency: 5, role: 'Pays accrued driver earnings in batches, with an idempotency key per batch.', ops: [{ name: 'run', desc: 'Pay the payable balance.' }], owns: ['Payout batches'] },
        { id: 'bank', label: 'Bank transfers', sub: 'External', kind: 'service', x: 1020, y: 490, latency: 25, role: 'Moves money to drivers’ bank accounts.', ops: [{ name: 'transfer', desc: 'One payout, once per key.' }], owns: ['Transfers'] },
      ],
      edges: [
        { from: 'rider', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'trip', latency: 4 },
        { from: 'trip', to: 'payments', latency: 4 },
        { from: 'payments', to: 'provider', latency: 35, label: 'HTTPS' },
        { from: 'provider', to: 'webhook', latency: 35, label: 'webhooks' },
        { from: 'webhook', to: 'payments', latency: 5 },
        { from: 'payments', to: 'ledger', latency: 5 },
        { from: 'payments', to: 'events', latency: 5 },
        { from: 'events', to: 'receipts', latency: 5 },
        { from: 'receipts', to: 'rider', latency: 30 },
        { from: 'payout', to: 'ledger', latency: 5 },
        { from: 'payout', to: 'bank', latency: 30, label: 'HTTPS' },
      ],
      queues: [{ id: 'payEvents', broker: 'events', label: 'payment-events', groups: ['receipts'] }],
    },
    modeLabels: { decline: 'Declining cards', duplicate: 'Sending webhooks twice' },

    failures: [
      { id: 'proc-timeout', node: 'provider', mode: 'dropResponse', label: 'Processor times out after charging', desc: 'The charge happens but the reply is lost. Retries must not charge again.' },
      { id: 'decline', node: 'provider', mode: 'decline', label: 'Card declined at capture', desc: 'The authorisation succeeded, but the final charge is refused.' },
      { id: 'proc-down', node: 'provider', mode: 'down', label: 'Processor unavailable', desc: 'Authorisations fail: rides are refused (fail-closed) or allowed (fail-open).' },
      { id: 'webhook-dup', node: 'webhook', mode: 'duplicate', label: 'Webhooks delivered twice', desc: 'The processor retries a webhook it believes failed.' },
      { id: 'ledger-down', node: 'ledger', mode: 'down', label: 'Ledger unavailable', desc: 'Webhooks cannot be handled; the processor keeps retrying them.' },
      { id: 'payout-paused', node: 'payout', mode: 'paused', label: 'Payout worker paused', desc: 'Driver earnings accrue but are not paid.' },
      { id: 'bank-down', node: 'bank', mode: 'down', label: 'Bank transfers failing', desc: 'Payout batches are retried with the same key.' },
    ],

    switches: [
      { id: 'idem', label: 'Idempotency keys on processor calls', desc: 'Off: each retry is a brand-new charge.', get: (s) => s.state.config.idem, set: (s, on) => { s.state.config.idem = on; } },
      { id: 'dedupe', label: 'Deduplicate webhooks by event ID', desc: 'Off: a repeated webhook is posted to the ledger twice.', get: (s) => s.state.config.dedupe, set: (s, on) => { s.state.config.dedupe = on; } },
      { id: 'preauth', label: 'Authorise a hold before the ride', desc: 'Off: no check until drop-off, so bad cards are discovered too late.', get: (s) => s.state.config.preauth, set: (s, on) => { s.state.config.preauth = on; } },
      { id: 'failOpen', label: 'Fail open when the processor is down', desc: 'Allow rides without authorisation. Keeps riders moving; risks unpaid trips.', get: (s) => s.state.config.failOpen, set: (s, on) => { s.state.config.failOpen = on; } },
    ],

    presets: (function () {
      const base = (sim, sw) => {
        sim.restoreAll();
        const def = { idem: true, dedupe: true, preauth: true, failOpen: false };
        for (const [id, on] of Object.entries(Object.assign(def, sw || {}))) sim.do('setSwitch', { id, on });
      };
      return [
        { id: 'happy', label: 'Hold, capture, receipt, payout', desc: 'The full money path. The ledger balances and matches the processor.', run: (s) => { base(s); startRequest(s); s.schedule(1500, () => startFinish(s, 14.2)); } },
        { id: 'timeout', label: 'Processor times out after charging', desc: 'The capture succeeds but its reply is lost. The retry reuses the key: charged exactly once.', run: (s) => { base(s); startRequest(s); s.schedule(1500, () => { s.inject('provider', 'dropResponse', true, 900); startFinish(s, 14.2); }); } },
        { id: 'timeout-bad', label: 'Same timeout, no idempotency keys', desc: 'Each retry is a new charge. The rider is billed twice.', run: (s) => { base(s, { idem: false }); startRequest(s); s.schedule(1500, () => { s.inject('provider', 'dropResponse', true, 900); startFinish(s, 14.2); }); } },
        { id: 'decline', label: 'Card declined at capture', desc: 'The ride is over but the charge fails. The rider adds another card and it succeeds.', run: (s) => { base(s); startRequest(s); s.schedule(1500, () => { s.inject('provider', 'decline'); startFinish(s, 18.6); }); s.schedule(3500, () => { s.restore('provider', 'decline'); s.do('newCard', {}); }); } },
        { id: 'dup', label: 'Webhook delivered twice, deduplicated', desc: 'The processor sends the capture webhook twice. The second is recognised and ignored.', run: (s) => { base(s); s.inject('webhook', 'duplicate'); startRequest(s); s.schedule(1500, () => startFinish(s, 14.2)); } },
        { id: 'dup-bad', label: 'Webhook twice, no deduplication', desc: 'The ledger records the payment twice. It still balances, but it no longer matches the processor.', run: (s) => { base(s, { dedupe: false }); s.inject('webhook', 'duplicate'); startRequest(s); s.schedule(1500, () => startFinish(s, 14.2)); } },
        { id: 'refund', label: 'Partial refund', desc: 'After payment, a $5 refund flows through the processor and back as a reversing ledger entry.', run: (s) => { base(s); startRequest(s); s.schedule(1500, () => startFinish(s, 14.2)); s.schedule(3800, () => startRefund(s)); } },
        { id: 'closed', label: 'Processor down: fail closed', desc: 'No authorisation, no ride. Safe for money, bad for riders.', run: (s) => { base(s); s.inject('provider', 'down', true, 4000); startRequest(s); } },
        { id: 'open', label: 'Processor down: fail open', desc: 'The ride goes ahead without a hold. Riders keep moving; the platform takes the risk.', run: (s) => { base(s, { failOpen: true }); s.inject('provider', 'down', true, 2500); startRequest(s); s.schedule(3000, () => startFinish(s, 14.2)); } },
        { id: 'ledger-down', label: 'Ledger down when the webhook arrives', desc: 'The webhook is not acknowledged, so the processor retries until the ledger is back. Nothing is lost.', run: (s) => { base(s); startRequest(s); s.schedule(1500, () => { s.inject('ledger', 'down', true, 2500); startFinish(s, 14.2); }); } },
      ];
    })(),

    initialState: () => ({
      config: { idem: true, dedupe: true, preauth: true, failOpen: false },
      seq: { trip: 0, entry: 0, event: 0, attempt: 0, payout: 0 },
      intents: {}, ledger: [], processed: {},
      provider: { auths: {}, captures: {}, refunds: {} },
      bank: {}, captureAction: {}, refundAction: {},
      stats: { webhooks: 0, dupWebhooks: 0 },
    }),
    initialUI: () => ({ rider: { trip: null, stage: 'idle', card: 'card-4242', hold: 0, fare: 0, paid: 0, refunded: 0, busy: false, risky: false, message: 'Tap “Request ride”. Estimated fare $14.20.', tone: '', banner: null } }),

    actions: {
      request(sim) { startRequest(sim); },
      finish(sim, a) { startFinish(sim, a.fare); },
      refund(sim) { startRefund(sim); },
      newCard(sim) { sim.ui.rider.card = 'card-5555'; sim.note('Rider added a new card ending 5555.'); startFinish(sim, sim.ui.rider.fare || 18.6); },
      reset(sim) { Object.assign(sim.ui.rider, { trip: null, stage: 'idle', paid: 0, refunded: 0, message: 'Ready for another ride.', tone: '' }); },
    },

    handlers: {
      rider: {
        push(ctx, p) {
          const u = ctx.ui.rider;
          if (p.trip !== u.trip) return { ignored: true };
          if (p.type === 'payment.captured') { u.stage = 'paid'; u.paid = p.amount; u.message = `Paid ${money(p.amount)}. Receipt sent.`; u.tone = 'ok'; u.banner = { title: 'Receipt', body: `${money(p.amount)} charged to card ${p.card.slice(-4)}`, tone: 'ok', t: ctx.now() }; }
          if (p.type === 'refund.succeeded') { u.refunded = r2(u.refunded + p.amount); u.message = `Refunded ${money(p.amount)}.`; u.tone = 'ok'; u.banner = { title: 'Refund issued', body: `${money(p.amount)} back to your card`, tone: 'ok', t: ctx.now() }; }
          return { shown: p.type };
        },
      },
      gateway: {
        request: function* (ctx, p) { return ctx.must(yield ctx.call('trip', 'create', p, { timeout: 2300 })); },
        complete: function* (ctx, p) { return ctx.must(yield ctx.call('trip', 'complete', p, { timeout: 3800 })); },
        refund: function* (ctx, p) { return ctx.must(yield ctx.call('payments', 'refund', p, { timeout: 3800 })); },
      },
      trip: {
        create: function* (ctx, p) {
          const st = ctx.state;
          if (!st.config.preauth) return { trip: p.trip, hold: 0, risky: false };
          const r = yield ctx.call('payments', 'authorize', { trip: p.trip, amount: HOLD }, { timeout: 2200 });
          if (r.ok) return { trip: p.trip, hold: HOLD, risky: false };
          if (st.config.failOpen && ['UNAVAILABLE', 'TIMEOUT'].includes(r.error.code)) {
            ctx.log({ op: 'fail open', status: 'note', detail: 'The processor is unavailable; the ride is allowed without authorisation.' });
            st.intents[p.trip] = { trip: p.trip, risky: true };
            return { trip: p.trip, hold: 0, risky: true };
          }
          return ctx.must(r);
        },
        complete: function* (ctx, p) { return ctx.must(yield ctx.call('payments', 'capture', p, { timeout: 3600 })); },
      },
      payments: {
        authorize: function* (ctx, p) {
          const st = ctx.state;
          const r = yield* withRetry(ctx, { attempts: 2, baseMs: 150 }, function* (a) {
            const key = st.config.idem ? `auth-${p.trip}` : `auth-${p.trip}-${a}`;
            return yield ctx.call('provider', 'authorize', { key, trip: p.trip, amount: p.amount }, { timeout: 900 });
          });
          const v = ctx.must(r);
          st.intents[p.trip] = { trip: p.trip, authId: v.authId, hold: p.amount };
          return v;
        },
        capture: function* (ctx, p) {
          const st = ctx.state;
          const r = yield* withRetry(ctx, { attempts: 3, baseMs: 200, retryable: (x) => x.error && ['UNAVAILABLE', 'TIMEOUT'].includes(x.error.code) }, function* (a) {
            const key = st.config.idem ? `cap-${p.trip}-${p.card}` : `cap-${p.trip}-${++st.seq.attempt}`;
            return yield ctx.call('provider', 'capture', { key, trip: p.trip, amount: p.fare, card: p.card }, { timeout: 900 });
          });
          return ctx.must(r);
        },
        refund: function* (ctx, p) {
          const st = ctx.state;
          const r = yield* withRetry(ctx, { attempts: 3, baseMs: 200 }, function* (a) {
            const key = st.config.idem ? `ref-${p.trip}` : `ref-${p.trip}-${++st.seq.attempt}`;
            return yield ctx.call('provider', 'refund', { key, trip: p.trip, amount: p.amount }, { timeout: 900 });
          });
          return ctx.must(r);
        },
        confirm: function* (ctx, e) {
          const st = ctx.state;
          if (st.config.dedupe && st.processed[e.eventId]) {
            st.stats.dupWebhooks++;
            ctx.log({ op: `webhook ${e.eventId} already handled`, status: 'dup', detail: 'Acknowledged without posting again.' });
            return { duplicate: true };
          }
          const lines = e.type === 'capture.succeeded'
            ? [['Rider card receivable', e.amount, 0], ['Driver payable', 0, r2(e.amount * DRIVER_SHARE)], ['Platform revenue', 0, r2(e.amount - r2(e.amount * DRIVER_SHARE))]]
            : [['Platform revenue', e.amount, 0], ['Rider card receivable', 0, e.amount]];
          ctx.must(yield ctx.call('ledger', 'post', { memo: `${e.type} ${e.trip}`, lines, trip: e.trip }, { timeout: 600 }));
          st.processed[e.eventId] = true;
          if (e.type === 'capture.succeeded' && st.intents[e.trip]) st.intents[e.trip].risky = false;
          const actionId = e.type === 'capture.succeeded' ? st.captureAction[e.trip] : st.refundAction[e.trip];
          ctx.sim.setLedger(actionId, 'committed', 'yes', `The processor’s ${e.type} webhook was posted to the ledger.`);
          yield ctx.call('events', 'publish', { type: e.type === 'capture.succeeded' ? 'payment.captured' : 'refund.succeeded', trip: e.trip, amount: e.amount, card: e.card || 'card-4242', actionId }, { timeout: 500 });
          return { posted: true };
        },
      },
      provider: {
        authorize(ctx, p) {
          const pv = ctx.state.provider;
          if (pv.auths[p.key]) return Object.assign({ replayed: true }, pv.auths[p.key]);
          pv.auths[p.key] = { authId: 'au_' + p.trip, trip: p.trip, amount: p.amount };
          return pv.auths[p.key];
        },
        capture(ctx, p) {
          const pv = ctx.state.provider;
          if (ctx.mode('decline')) ctx.fail('CARD_DECLINED', 'The card was declined.');
          if (pv.captures[p.key]) return Object.assign({ replayed: true }, pv.captures[p.key]);
          const id = 'ch_' + (Object.keys(pv.captures).length + 1);
          pv.captures[p.key] = { chargeId: id, trip: p.trip, amount: p.amount, card: p.card, status: 'pending' };
          scheduleWebhook(ctx, { type: 'capture.succeeded', trip: p.trip, amount: p.amount, card: p.card, chargeId: id });
          return { chargeId: id, status: 'pending' };
        },
        refund(ctx, p) {
          const pv = ctx.state.provider;
          if (pv.refunds[p.key]) return Object.assign({ replayed: true }, pv.refunds[p.key]);
          pv.refunds[p.key] = { refundId: 're_' + p.trip, trip: p.trip, amount: p.amount };
          scheduleWebhook(ctx, { type: 'refund.succeeded', trip: p.trip, amount: p.amount });
          return pv.refunds[p.key];
        },
      },
      webhook: { event: function* (ctx, e) { return ctx.must(yield ctx.call('payments', 'confirm', e, { timeout: 1000 })); } },
      ledger: {
        post(ctx, p) {
          const debit = r2(p.lines.reduce((a, l) => a + l[1], 0));
          const credit = r2(p.lines.reduce((a, l) => a + l[2], 0));
          if (debit !== credit) ctx.fail('UNBALANCED', 'Debits must equal credits.');
          return { entry: post(ctx, p.memo, p.lines, p.trip) };
        },
      },
      events: { publish(ctx, p) { ctx.sim.enqueue('payEvents', { type: p.type, payload: p, actionId: p.actionId }); return { appended: true }; } },
      bank: {
        transfer(ctx, p) {
          const b = ctx.state.bank;
          if (b[p.key]) return Object.assign({ replayed: true }, b[p.key]);
          b[p.key] = { amount: p.amount, t: ctx.now() };
          return b[p.key];
        },
      },
    },

    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('payEvents', 'receipts');
          const p = msg.payload;
          yield ctx.call('rider', 'push', p, { timeout: 600, actionId: msg.actionId });
          ctx.sim.setLedger(p.actionId, 'async', 'yes', 'Receipt delivered to the rider.');
          ctx.ack('payEvents', 'receipts');
        }
      }, { self: 'receipts' });
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(3000);
          if (ctx.sim.nodes.payout.modes.paused) continue;
          const st = ctx.state;
          const owed = r2(-balance(st, 'Driver payable'));
          if (owed <= 0) continue;
          const batch = st.pendingPayout || { key: 'payout-' + ++st.seq.payout, amount: owed };
          st.pendingPayout = batch;
          const r = yield ctx.call('bank', 'transfer', batch, { timeout: 800 });
          if (!r.ok) { ctx.log({ op: `${batch.key} failed`, status: 'retry', error: r.error, detail: `Will retry the same batch (${money(batch.amount)}) with key ${batch.key}, so the driver cannot be paid twice.` }); continue; }
          const w = yield ctx.call('ledger', 'post', { memo: `driver payout ${batch.key}`, lines: [['Driver payable', batch.amount, 0], ['Cash at bank', 0, batch.amount]] }, { timeout: 600 });
          if (w.ok) { st.pendingPayout = null; ctx.log({ op: `paid drivers ${money(batch.amount)}`, status: 'ok', detail: `Batch ${batch.key} transferred and posted.` }); }
        }
      }, { self: 'payout' });
    },

    consistency(sim) {
      const st = sim.state;
      const pv = st.provider;
      const trips = new Set(Object.values(pv.captures).map((c) => c.trip).concat(st.ledger.map((l) => l.trip).filter(Boolean)));
      for (const t of trips) {
        const caps = Object.values(pv.captures).filter((c) => c.trip === t);
        const charged = r2(caps.reduce((a, c) => a + c.amount, 0) - Object.values(pv.refunds).filter((r) => r.trip === t).reduce((a, r) => a + r.amount, 0));
        const perCard = {};
        for (const c of caps) perCard[c.card] = (perCard[c.card] || 0) + 1;
        const dbl = Object.values(perCard).find((n) => n > 1);
        if (dbl) return { key: 'wrong', label: `Double charge: the processor captured ${dbl} payments for ${t} on the same card.` };
        const booked = r2(st.ledger.filter((l) => l.trip === t && l.account === 'Rider card receivable').reduce((a, l) => a + l.debit - l.credit, 0));
        if (booked > charged + 0.001) return { key: 'wrong', label: `Reconciliation mismatch on ${t}: the ledger records ${money(booked)} but the processor charged ${money(charged)}.` };
        if (booked < charged - 0.001) return { key: 'stale', label: `The processor charged ${money(charged)} for ${t}; the ledger has ${money(booked)} so far (webhook pending).` };
      }
      const u = sim.ui.rider;
      if (u.stage === 'failed') return { key: 'stale', label: `${u.trip} is complete but unpaid.` };
      if (Object.values(st.intents).some((i) => i.risky)) return { key: 'stale', label: 'A ride is running without an authorisation hold; payment is not guaranteed.' };
      return { key: 'ok', label: 'The ledger balances and matches the processor for every trip.' };
    },

    metrics(snap, sim) {
      const st = sim.state;
      const debits = r2(st.ledger.reduce((a, l) => a + l.debit, 0));
      const credits = r2(st.ledger.reduce((a, l) => a + l.credit, 0));
      return [
        { label: 'Ledger debits = credits', value: debits === credits ? `Yes, ${money(debits)}` : `No: ${money(debits)} vs ${money(credits)}`, tone: debits === credits ? 'ok' : 'fail' },
        { label: 'Processor captures', value: Object.keys(st.provider.captures).length },
        { label: 'Driver payable', value: money(-balance(st, 'Driver payable')) },
        { label: 'Paid out to drivers', value: money(-balance(st, 'Cash at bank')) },
        { label: 'Duplicate webhooks ignored', value: st.stats.dupWebhooks },
      ];
    },

    product: {
      mount(el, sim) {
        el.innerHTML = `
          <p class="panel-note phones-note">The phone shows the rider’s view. The ledger shows what the company recorded, and checks it against the card processor.</p>
          <div class="hk-wrap">
            ${SDL.ui.phone.frame('rider', 'Rider phone')}
            <div class="ops-console"><p class="ops-title">Payment ledger</p><div data-ref="ledger"></div></div>
          </div>`;
        SDL.ui.phone.wire(el.querySelector('.phone'));
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-act]');
          if (!b || b.disabled) return;
          sim.dispatch(b.dataset.act, b.dataset.arg ? JSON.parse(b.dataset.arg) : {});
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.rider;
        const ph = el.querySelector('.phone');
        SDL.ui.phone.render(ph, sim, 'rider', u.banner, false);
        let body = `<div class="app-card"><span class="app-kv"><span>Payment</span><span>Card ending ${u.card.slice(-4)}</span></span>${u.hold ? `<span class="app-kv"><span>Hold</span><span>${money(u.hold)}</span></span>` : ''}${u.paid ? `<span class="app-kv"><span>Paid</span><span>${money(u.paid)}</span></span>` : ''}${u.refunded ? `<span class="app-kv"><span>Refunded</span><span>${money(u.refunded)}</span></span>` : ''}</div>`;
        if (u.stage === 'idle') body += `<button class="app-btn" data-act="request"${u.busy ? ' disabled' : ''}>${u.busy ? '<span class="spinner"></span>Checking card…' : 'Request ride, about $14.20'}</button>`;
        if (u.stage === 'onTrip') body += `<p class="app-sub">On trip. When it ends, the final fare is charged.</p><div class="app-row"><button class="app-btn go" style="flex:1" data-act="finish" data-arg='{"fare":14.2}'>End trip, $14.20</button><button class="app-btn secondary" data-act="finish" data-arg='{"fare":18.6}'>Traffic, $18.60</button></div>`;
        if (u.stage === 'paying') body += '<div class="app-card is-work"><strong><span class="spinner"></span>Processing payment…</strong><span class="app-sub">Waiting for the processor to confirm</span></div>';
        if (u.stage === 'failed') body += '<button class="app-btn" data-act="newCard">Use another card</button>';
        if (u.stage === 'paid') body += `<button class="app-btn secondary" data-act="refund"${u.refunded ? ' disabled' : ''}>Request $5 refund</button><button class="app-btn secondary" data-act="reset">Done</button>`;
        body += `<p class="app-msg" data-tone="${u.tone}">${esc(u.message)}</p>`;
        SDL.ui.phone.paint(ph, { head: '<div><p class="app-title">RideNow</p><p class="app-sub">Sam</p></div>', body }, {});
        const rows = st.ledger.slice(-9).map((l) => `<tr><td>${l.id}</td><td>${esc(l.account)}</td><td class="num">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td></tr>`).join('');
        const c = sc.consistency(sim);
        const table = `<table class="ledger"><thead><tr><th>Entry</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">No entries yet. Money is recorded only when the processor confirms it.</td></tr>'}</tbody></table>
          <p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`;
        SDL.ui.paintSections(el.querySelector('[data-ref="ledger"]'), { table }, {});
      },
    },
  });

  function scheduleWebhook(ctx, e) {
    const sim = ctx.sim;
    const st = sim.state;
    const ev = Object.assign({ eventId: 'evt_' + ++st.seq.event }, e);
    sim.spawn(function* (c) {
      yield c.wait(500);
      const copies = sim.nodes.webhook.modes.duplicate ? 2 : 1;
      for (let i = 0; i < copies; i++) {
        let backoff = 300;
        for (let attempt = 1; attempt <= 8; attempt++) {
          st.stats.webhooks++;
          const r = yield c.call('webhook', 'event', ev, { timeout: 1500 });
          if (r.ok) break;
          c.log({ op: `webhook ${ev.eventId} retry`, status: 'retry', error: r.error, detail: `The processor did not get an acknowledgement and will resend ${ev.type} in ${backoff} ms. Money has already moved; only the record is waiting.` });
          yield c.wait(backoff);
          backoff = Math.min(2000, backoff * 2);
        }
        if (copies > 1 && i === 0) { yield c.wait(400); c.log({ op: `webhook ${ev.eventId} resent`, status: 'dup', detail: 'The processor sends the same event again, as it does when it is unsure the first delivery succeeded.' }); }
      }
    }, { self: 'provider' });
  }
})(typeof window !== 'undefined' ? window : globalThis);
