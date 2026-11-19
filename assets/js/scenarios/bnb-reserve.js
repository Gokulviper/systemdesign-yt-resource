/*
 * From quote to confirmed: payments and request to book.
 * “Confirm and pay” is a saga in the booking service: a fraud check, a hold on
 * the nights, a charge through the payment service, then a confirmation with an
 * outbox event. The payment service writes an attempt record before it calls
 * the card provider and passes the record's key as the provider's idempotency
 * key, so a retry after a lost reply finds the first charge instead of making a
 * second (the pattern Airbnb described for its payments, “Orpheus”). A recovery
 * job finishes checkouts left half-done by a crash or an unknown outcome.
 * With request to book, the card is authorised and the host has a deadline;
 * accept and expiry are both state changes that only one may win.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const PRICE = 310;
  const NIGHTS = { maya: ['Dec 30', 'Dec 31', 'Jan 1'], fraud: ['Jan 5', 'Jan 6'] };
  const RANGE = { maya: 'Dec 30 – Jan 2', fraud: 'Jan 5 – Jan 7' };
  const amount = (who) => Math.round((PRICE * NIGHTS[who].length + 120) * 1.14);
  const usd = (n) => '$' + n.toLocaleString('en-US');
  const REQ_MS = 4000; // the host's 24 hours
  const NAME = { maya: 'Maya', fraud: 'New account', lena: 'Lena' };
  const ACTIVE = ['held', 'charging', 'payment_pending', 'pending', 'confirmed'];

  function pay(sim, who) {
    const u = sim.ui[who];
    if (u.busy) return;
    u.busy = true;
    const instant = sim.ui.lena.instant;
    sim.startAction(`${NAME[who]}: ${instant ? 'confirm and pay' : 'request to book'} ${usd(amount(who))}`, function* (ctx) {
      const v = ctx.ui[who];
      Object.assign(v, { stage: 'working', message: '', tone: '' });
      Y.L(ctx, { displayed: ['pending', instant ? '“Confirming…”.' : '“Sending request…”.'], retrySafe: [ctx.state.config.records ? 'yes' : 'no', ctx.state.config.records ? 'The payment attempt has a recorded key; the provider deduplicates on it.' : 'Payment retries carry no key: each one is a new charge.'] });
      const r = yield ctx.call('api', 'reserve', { who, card: who === 'fraud' ? 'leaked' : 'visa-4242', instant }, { timeout: 5000 });
      ctx.recordOutcome(r.ok, r.latency);
      v.busy = false;
      if (r.ok) {
        const st = r.value.status;
        Object.assign(v, { stage: st, booking: r.value.id });
        Y.L(ctx, { displayed: 'yes', accepted: ['yes', `Booking ${r.value.id}.`], committed: [st === 'payment_pending' ? 'pending' : 'yes', st === 'confirmed' ? 'Confirmed and charged.' : st === 'pending' ? 'Nights held; card authorised.' : 'Payment outcome unknown; nights held.'], async: [st === 'confirmed' ? 'pending' : 'n/a', 'Lena is notified from the outbox.'] });
        ctx.explain(st === 'payment_pending'
          ? 'The card provider never answered, so the payment service does not know whether Maya was charged. It recorded the attempt as “unknown” and the booking waits. The recovery job will ask the provider by key and finish it either way. Retrying blindly could charge twice; giving up could lose a real charge.'
          : st === 'pending'
            ? 'The card is authorised, not charged, and the nights are held as pending. Lena has 24 hours (4 s here). Accepting captures the authorisation; expiry voids it.'
            : r.value.unchecked
              ? 'The fraud check was down and the booking service let the booking through without one (fail open). The card was charged and the booking confirmed.'
              : r.value.replayed
                ? `The provider’s first reply was lost. The payment service retried with the same key (${r.value.key}), and the provider returned the charge it had already made. One charge.`
                : r.value.charges > 1
                  ? 'The provider’s first reply was lost. The payment service retried with nothing to tie it to the first attempt, so the provider made a second charge. The booking is confirmed once; the card is charged twice.'
                  : `Fraud check, hold, charge, confirm. The payment attempt was recorded before calling the provider, so any retry would reuse its key.`);
        return;
      }
      const code = r.error.code;
      Object.assign(v, { stage: 'failed', message: code === 'RISK_DECLINED' ? 'We couldn’t verify this payment.' : code === 'RISK_UNAVAILABLE' ? 'We can’t confirm bookings right now. Please try again soon.' : code === 'CARD_DECLINED' ? 'Your card was declined.' : code === 'CRASHED' ? 'Something went wrong. Check your trips in a moment.' : `Couldn’t book: ${r.error.message}`, tone: 'fail' });
      Y.failed(ctx, code === 'CRASHED' ? 'The phone shows an error; the charge may have happened.' : 'No booking.');
      ctx.explain(code === 'CRASHED'
        ? `The booking service crashed after the charge and before confirming. ${ctx.state.config.recover ? 'The recovery job will find the checkout stuck in “charging”, ask the payment service what happened, and finish it.' : 'Nothing will come back to it: the card is charged, the nights are blocked, and there is no booking.'}`
        : code === 'RISK_UNAVAILABLE'
          ? 'The fraud check is down and the booking service fails closed: no booking without a check. Honest guests are turned away until it returns.'
          : code === 'RISK_DECLINED'
            ? 'The fraud check scored this card as leaked and refused the booking before any nights were held.'
            : `It failed with ${code}. Nothing was charged.`);
    }, { self: who });
  }

  function hostAnswer(sim, accept) {
    const b = Object.values(sim.state.bookings).find((x) => x.status === 'pending');
    if (!b) return;
    sim.startAction(`Lena: ${accept ? 'accept' : 'decline'} the request`, function* (ctx) {
      Y.L(ctx, { displayed: ['pending', 'Sending.'], retrySafe: ['yes', 'A second accept finds the booking already decided.'] });
      const r = yield ctx.call('api', accept ? 'accept' : 'decline', { id: b.id }, { timeout: 2000 });
      if (!r.ok) {
        ctx.ui.lena.message = r.error.code === 'NOT_PENDING' ? 'Too late: this request already expired.' : r.error.message;
        Y.failed(ctx, ctx.ui.lena.message);
        ctx.explain('Lena’s accept tried to change the request from “pending” to “confirmed”, but the expiry had already changed it to “expired”. Only one change can win, and Lena is told the truth.');
        return;
      }
      ctx.state.told.lena = accept ? 'accepted' : 'declined';
      ctx.ui.lena.message = accept ? `Accepted. ${NAME[b.who]} is coming.` : 'Declined.';
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', accept ? 'Confirmed; authorisation captured.' : 'Declined; authorisation voided.'], async: 'n/a' });
      ctx.explain(r.value.blind
        ? 'Lena’s accept read “pending”, captured the card, and wrote “confirmed”, without checking that the request was still pending when it wrote.'
        : accept ? 'The request was still pending, so the accept won: confirmed, and the authorisation captured.' : 'Declined: the nights are free and the authorisation voided.');
    }, { self: 'lena' });
  }

  /** Accept the pending request 45 ms before its deadline: it reaches the booking service as the expiry fires. */
  function acceptAtDeadline(sim) {
    sim.spawn(function* (ctx) {
      let b;
      while (!(b = Object.values(ctx.state.bookings).find((x) => x.status === 'pending'))) yield ctx.wait(20);
      yield ctx.wait(Math.max(0, b.deadline - 45 - ctx.now()));
      hostAnswer(ctx.sim, true);
    }, { self: 'lena', quiet: 'all' });
  }

  /* ---------------- booking state changes ---------------- */
  /** Decide a pending request. With compare-and-set the write is conditional and comes first; blind: read, act, then write. */
  function* decide(ctx, id, to) {
    const st = ctx.state;
    const money = to === 'confirmed' ? 'capture' : 'void';
    if (st.config.cas) {
      const r = ctx.must(yield ctx.call('calendar', 'cas', { id, from: 'pending', to }, { timeout: 800 }));
      yield ctx.call('payments', money, { booking: id, chargeId: r.chargeId }, { timeout: 1500 });
      return { ok: true };
    }
    const b = ctx.must(yield ctx.call('calendar', 'get', { id }, { timeout: 800 }));
    if (b.status !== 'pending') ctx.fail('NOT_PENDING', 'Already decided.');
    yield ctx.call('payments', money, { booking: id, chargeId: b.chargeId }, { timeout: 1500 });
    ctx.must(yield ctx.call('calendar', 'set', { id, status: to }, { timeout: 800 }));
    return { ok: true, blind: true };
  }

  SDL.scenarios['bnb-reserve'] = {
    id: 'bnb-reserve',
    seed: 4307,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Tap “Confirm and pay” on Maya’s phone and follow the saga: fraud check, hold, charge, confirm. Then lose the card provider’s reply, crash the booking service after the charge, or turn Instant Book off and let Lena accept at the very moment the request expires.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'Checkout', kind: 'client', x: 90, y: 90, latency: 1, role: 'Confirms and pays for Dec 30 – Jan 2.', owns: ['What Maya sees'] },
        { id: 'fraud', label: 'New account', sub: 'Leaked card', kind: 'client', x: 90, y: 300, latency: 1, role: 'An account created an hour ago, paying with a card from a leaked list.', owns: ['Nothing'] },
        { id: 'lena', label: 'Lena’s phone', sub: 'Host app', kind: 'client', x: 90, y: 510, latency: 1, role: 'Turns Instant Book on or off and answers requests.', ops: [{ name: 'notify', desc: 'Push a notification.' }], owns: ['What Lena sees'] },
        { id: 'api', label: 'API gateway', sub: 'Routing', kind: 'gateway', x: 290, y: 300, latency: 2, role: 'Routes checkout and host calls.', ops: [{ name: 'reserve', desc: 'Confirm and pay.' }, { name: 'accept', desc: 'Host accepts.' }], owns: ['Nothing durable'] },
        { id: 'booking', label: 'Booking service', sub: 'Checkout saga', kind: 'service', x: 500, y: 300, latency: 3, role: 'Runs the saga: fraud check, hold, charge, confirm. Records each step in the booking row so a crash can be recovered.', ops: [{ name: 'reserve', desc: 'Run the saga.' }, { name: 'accept', desc: 'Accept a request.' }], owns: ['Saga logic'] },
        { id: 'risk', label: 'Fraud check', sub: 'Score per payment', kind: 'service', x: 500, y: 90, latency: 15, role: 'Scores the account, card, and booking. Refuses cards it has seen in leaks.', ops: [{ name: 'check', desc: 'Score this booking.' }], owns: ['Risk models'] },
        { id: 'calendar', label: 'Booking database', sub: 'Bookings, nights, outbox', kind: 'db', x: 720, y: 200, latency: 6, role: 'Booking rows with their saga step, night rows (unique per night), and the outbox.', ops: [{ name: 'hold', desc: 'Insert night rows.' }, { name: 'step', desc: 'Record a saga step.' }, { name: 'cas', desc: 'Change status only if it is still X.' }, { name: 'set', desc: 'Write status.' }], owns: ['bookings', 'nights', 'outbox'] },
        { id: 'payments', label: 'Payment service', sub: 'Records, then calls', kind: 'service', x: 720, y: 420, latency: 3, role: 'Writes an attempt record before calling the card provider and sends its key as the provider’s idempotency key. On a timeout it retries with the same key, or marks the outcome unknown.', ops: [{ name: 'charge', desc: 'Charge or authorise.' }, { name: 'reconcile', desc: 'Find out what happened.' }], owns: ['Retry rules'] },
        { id: 'paydb', label: 'Payment records', sub: 'One row per attempt', kind: 'db', x: 940, y: 520, latency: 5, role: 'Attempt records: key, booking, status (pending, succeeded, failed, unknown). Read from the primary only.', ops: [{ name: 'begin', desc: 'Record an attempt.' }, { name: 'finish', desc: 'Record its outcome.' }], owns: ['payment attempts'] },
        { id: 'psp', label: 'Card provider', sub: 'External', kind: 'service', x: 940, y: 380, latency: 60, role: 'Charges, authorises, captures, and voids cards. Deduplicates requests that carry the same idempotency key.', ops: [{ name: 'charge', desc: 'Charge a card.' }, { name: 'lookup', desc: 'Find a charge by key.' }], owns: ['charges'] },
        { id: 'scheduler', label: 'Scheduler and recovery', sub: 'Deadlines, stuck sagas', kind: 'worker', x: 500, y: 510, latency: 3, role: 'Fires request deadlines and finishes checkouts left in “charging” or “payment pending”.', owns: ['timers'] },
        { id: 'bus', label: 'Event bus', sub: 'From the outbox', kind: 'queue', x: 940, y: 220, latency: 3, role: 'Carries booking events from the outbox to the notification worker.', owns: ['events'] },
        { id: 'notifier', label: 'Notification worker', sub: 'Push to hosts', kind: 'worker', x: 940, y: 80, latency: 3, role: 'Tells Lena about bookings and requests.', owns: ['Nothing durable'] },
      ],
      edges: [
        { from: 'maya', to: 'api', latency: 40, label: 'mobile network' },
        { from: 'fraud', to: 'api', latency: 40 },
        { from: 'lena', to: 'api', latency: 40 },
        { from: 'api', to: 'booking', latency: 3 },
        { from: 'booking', to: 'risk', latency: 3 },
        { from: 'booking', to: 'calendar', latency: 3 },
        { from: 'booking', to: 'payments', latency: 3 },
        { from: 'payments', to: 'paydb', latency: 3 },
        { from: 'payments', to: 'psp', latency: 20, label: 'HTTPS' },
        { from: 'scheduler', to: 'calendar', latency: 3, via: [[620, 510], [620, 250]] },
        { from: 'scheduler', to: 'payments', latency: 3 },
        { from: 'calendar', to: 'bus', latency: 3, label: 'outbox relay' },
        { from: 'bus', to: 'notifier', latency: 3 },
        { from: 'notifier', to: 'lena', latency: 30, via: [[1080, 80], [1080, 585], [90, 585]] },
      ],
      queues: [
        { id: 'outbox', broker: 'calendar', label: 'outbox', groups: ['bus'] },
        { id: 'events', broker: 'bus', label: 'booking events', groups: ['notifier'] },
      ],
    },
    modeLabels: { loseNextReply: 'Loses the next reply', crashAfterCharge: 'Crashes after the next charge', twice: 'Fires every timer twice' },
    failures: [
      { id: 'psp-slow', node: 'psp', mode: 'slow', params: { factor: 6 }, label: 'Card provider slow', desc: 'Replies take about 0.4 s; checkouts slow down.' },
      { id: 'psp-lost', node: 'psp', mode: 'loseNextReply', label: 'Card provider loses a reply', desc: 'The charge happens; the reply never arrives.' },
      { id: 'psp-hang', node: 'psp', mode: 'hang', duration: 1500, label: 'Card provider not answering (1.5 s)', desc: 'Calls time out. Nobody knows whether they charged.' },
      { id: 'declined', node: 'psp', mode: 'reject', params: { code: 'CARD_DECLINED', message: 'The card was declined.' }, label: 'Cards declined', desc: 'The hold is released at once.' },
      { id: 'risk-down', node: 'risk', mode: 'down', label: 'Fraud check down', desc: 'Fail closed: refuse bookings. Fail open: book without a check.' },
      { id: 'risk-slow', node: 'risk', mode: 'slow', params: { factor: 20 }, label: 'Fraud check slow', desc: 'Every checkout waits 0.3 s longer.' },
      { id: 'crash', node: 'booking', mode: 'crashAfterCharge', label: 'Booking service crashes after a charge', desc: 'The card is charged; the booking is stuck in “charging”.' },
      { id: 'sched-paused', node: 'scheduler', mode: 'paused', label: 'Scheduler paused', desc: 'Requests outlive their deadline; stuck checkouts stay stuck.' },
      { id: 'sched-twice', node: 'scheduler', mode: 'twice', label: 'Scheduler fires timers twice', desc: 'Every expiry runs twice. Harmless only if the state change is conditional.' },
      { id: 'bus-down', node: 'bus', mode: 'down', label: 'Event bus down', desc: 'Booking events wait in the outbox; Lena hears later.' },
    ],
    switches: Y.switches([
      ['records', 'Record payment attempts before calling', 'Write an attempt row and send its key to the provider; retry with the same key, or mark the outcome unknown. Off: retry the call blindly.'],
      ['recover', 'Recovery job', 'Find checkouts stuck in “charging” or “payment pending” and finish them from the payment records. Off: nothing comes back to them.'],
      ['cas', 'Compare-and-set state changes', 'Accept and expiry change a request only if it is still pending. Off: read, act, then write.'],
      ['riskClosed', 'Fraud check fails closed', 'If the fraud check is down, refuse bookings. Off: book without a check (fail open).'],
    ]),
    presets: Y.presets({ records: true, recover: true, cas: true, riskClosed: true }, [
      { id: 'instant', label: 'Confirm and pay', desc: 'Fraud check, hold, record the attempt, charge, confirm. Lena is notified from the outbox.', run: (s) => { pay(s, 'maya'); } },
      { id: 'lost-reply-blind', label: 'Provider reply lost, blind retry', desc: 'The provider charges Maya, but the reply is lost. The retry has no key, so the provider charges again: one booking, two charges.', sw: { records: false }, run: (s) => { s.inject('psp', 'loseNextReply'); pay(s, 'maya'); } },
      { id: 'lost-reply-records', label: 'Provider reply lost, recorded key', desc: 'Same lost reply. The retry carries the recorded key and the provider returns the first charge. One charge.', run: (s) => { s.inject('psp', 'loseNextReply'); pay(s, 'maya'); } },
      { id: 'psp-timeout', label: 'Provider not answering', desc: 'Both attempts time out. The outcome is unknown, so the booking waits in “payment pending”. When the provider is back, the recovery job looks the key up, charges once, and confirms.', run: (s) => { s.inject('psp', 'hang', true, 1500); pay(s, 'maya'); } },
      { id: 'declined', label: 'Card declined', desc: 'The provider declines. The hold is released and nothing is charged.', run: (s) => { s.inject('psp', 'reject', { code: 'CARD_DECLINED', message: 'The card was declined.' }); pay(s, 'maya'); } },
      { id: 'crash-no-recovery', label: 'Crash after the charge, no recovery', desc: 'The card is charged, then the booking service crashes. Nothing finishes the checkout: Maya has paid $1,197 for a booking that does not exist, and the nights stay blocked.', sw: { recover: false }, run: (s) => { s.inject('booking', 'crashAfterCharge'); pay(s, 'maya'); } },
      { id: 'crash-recovery', label: 'Crash after the charge, recovery job', desc: 'Same crash. The recovery job finds the checkout stuck in “charging”, reads the payment record (succeeded), and confirms the booking.', run: (s) => { s.inject('booking', 'crashAfterCharge'); pay(s, 'maya'); } },
      { id: 'request-expires', label: 'Request to book, Lena silent', desc: 'Instant Book is off. The card is authorised and the nights held. Lena never answers; at the deadline the request expires and the authorisation is voided.', run: (s) => { s.ui.lena.instant = false; pay(s, 'maya'); } },
      { id: 'accept-race-blind', label: 'Accept at the deadline, blind writes', desc: 'Lena taps Accept as the request expires. Both read “pending”, both act, both write. Lena is told “accepted”; Maya is told it expired and her authorisation is voided.', sw: { cas: false }, run: (s) => { s.ui.lena.instant = false; pay(s, 'maya'); acceptAtDeadline(s); } },
      { id: 'accept-race-cas', label: 'Accept at the deadline, compare-and-set', desc: 'Same moment. Each side changes the request only if it is still pending. The expiry gets there first; Lena is told the request expired.', run: (s) => { s.ui.lena.instant = false; pay(s, 'maya'); acceptAtDeadline(s); } },
      { id: 'risk-open', label: 'Fraud check down, fail open', desc: 'The fraud check is down and bookings go through without it. A new account books with a leaked card and is confirmed.', sw: { riskClosed: false }, run: (s) => { s.inject('risk', 'down'); pay(s, 'fraud'); s.schedule(200, () => pay(s, 'maya')); } },
      { id: 'risk-closed', label: 'Fraud check down, fail closed', desc: 'Same outage. Every booking is refused until the check is back: the leaked card is stopped, and so is Maya.', run: (s) => { s.inject('risk', 'down'); pay(s, 'fraud'); s.schedule(200, () => pay(s, 'maya')); } },
    ]),
    initialState: () => ({
      config: { records: true, recover: true, cas: true, riskClosed: true },
      bookings: {}, nights: [], charges: {}, records: {}, timers: [], told: {},
      seq: { b: 0, c: 0 },
      stats: { unknown: 0, replays: 0, recovered: 0, blindRetries: 0 },
    }),
    initialUI: () => {
      const g = () => ({ stage: 'checkout', booking: null, busy: false, message: '', tone: '' });
      return { maya: g(), fraud: g(), lena: { instant: true, notes: [], message: '' } };
    },
    actions: {
      pay(sim, a) { pay(sim, a.who || 'maya'); },
      accept(sim) { hostAnswer(sim, true); },
      decline(sim) { hostAnswer(sim, false); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        reserve: function* (ctx, p) { return ctx.must(yield ctx.call('booking', 'reserve', p, { timeout: 4800 })); },
        accept: function* (ctx, p) { return ctx.must(yield ctx.call('booking', 'decide', { id: p.id, to: 'confirmed' }, { timeout: 1800 })); },
        decline: function* (ctx, p) { return ctx.must(yield ctx.call('booking', 'decide', { id: p.id, to: 'declined' }, { timeout: 1800 })); },
      },
      booking: {
        reserve: function* (ctx, p) {
          const st = ctx.state;
          const rk = yield ctx.call('risk', 'check', { who: p.who, card: p.card }, { timeout: 600 });
          let unchecked = false;
          if (!rk.ok) {
            if (st.config.riskClosed) ctx.fail('RISK_UNAVAILABLE', 'The fraud check is unavailable.');
            unchecked = true;
            ctx.log({ op: 'fraud check down: fail open', status: 'err', detail: 'No score. The booking continues without a fraud check.' });
          } else if (rk.value.score > 0.8) ctx.fail('RISK_DECLINED', `Fraud score ${rk.value.score}.`);
          const id = `B${++st.seq.b}`;
          ctx.must(yield ctx.call('calendar', 'hold', { id, who: p.who, nights: NIGHTS[p.who], unchecked, actionId: ctx.actionId }, { timeout: 800 }));
          ctx.must(yield ctx.call('calendar', 'step', { id, status: 'charging' }, { timeout: 800 }));
          const kind = p.instant ? 'charge' : 'authorize';
          const pr = yield ctx.call('payments', 'charge', { booking: id, amount: amount(p.who), kind }, { timeout: 4000 });
          if (!pr.ok) {
            yield ctx.call('calendar', 'step', { id, status: 'released' }, { timeout: 800 });
            ctx.must(pr);
          }
          if (pr.value.pending) {
            ctx.must(yield ctx.call('calendar', 'step', { id, status: 'payment_pending', kind }, { timeout: 800 }));
            return { id, status: 'payment_pending' };
          }
          if (ctx.mode('crashAfterCharge')) {
            ctx.sim.restore('booking', 'crashAfterCharge');
            ctx.log({ op: `crashed after charging ${id}`, status: 'err', detail: `The charge succeeded; the process died before writing “confirmed”. ${id} is left in “charging”.` });
            ctx.fail('CRASHED', 'The booking service restarted mid-request.');
          }
          const done = p.instant ? 'confirmed' : 'pending';
          ctx.must(yield ctx.call('calendar', 'step', { id, status: done, chargeId: pr.value.chargeId, deadline: p.instant ? null : ctx.now() + REQ_MS }, { timeout: 800 }));
          const charges = Object.values(st.charges).filter((c) => c.booking === id).length;
          return { id, status: done, unchecked, replayed: pr.value.replayed, key: pr.value.key, charges };
        },
        decide: function* (ctx, p) { return yield* decide(ctx, p.id, p.to); },
      },
      risk: { check(ctx, p) { return { score: p.card === 'leaked' ? 0.97 : 0.04 }; } },
      calendar: {
        hold(ctx, p) {
          const st = ctx.state;
          const clash = p.nights.find((n) => st.nights.some((r) => r.n === n && ACTIVE.includes(st.bookings[r.b].status)));
          if (clash) ctx.fail('NIGHTS_TAKEN', `${clash} is taken.`);
          st.bookings[p.id] = { id: p.id, who: p.who, nights: p.nights, status: 'held', since: ctx.now(), unchecked: p.unchecked, actionId: p.actionId };
          for (const n of p.nights) st.nights.push({ n, b: p.id });
          return { id: p.id };
        },
        step(ctx, p) {
          const b = ctx.state.bookings[p.id];
          Object.assign(b, { status: p.status, since: ctx.now() });
          if (p.chargeId) b.chargeId = p.chargeId;
          if (p.kind) b.kind = p.kind;
          if (p.deadline) {
            b.deadline = p.deadline;
            const t = { id: p.id, at: p.deadline, fired: 0 };
            ctx.state.timers.push(t);
            ctx.sim.schedule(p.deadline - ctx.now(), () => fire(ctx.sim, t));
          }
          if (p.status === 'confirmed' || p.status === 'pending') ctx.sim.enqueue('outbox', { type: p.status, eventId: `${p.id}:${p.status}`, payload: { id: p.id, who: b.who, type: p.status }, actionId: b.actionId });
          return { ok: true };
        },
        get(ctx, p) { return Object.assign({}, ctx.state.bookings[p.id]); },
        set(ctx, p) {
          const b = ctx.state.bookings[p.id];
          b.status = p.status;
          ctx.sim.enqueue('outbox', { type: p.status, eventId: `${p.id}:${p.status}:${ctx.now()}`, payload: { id: p.id, who: b.who, type: p.status }, actionId: b.actionId });
          return { ok: true };
        },
        cas(ctx, p) {
          const b = ctx.state.bookings[p.id];
          if (!b || b.status !== p.from) {
            ctx.log({ op: `${p.id}: ${p.from} → ${p.to} refused`, status: 'err', detail: `${p.id} is already “${b ? b.status : 'missing'}”. The conditional update changes nothing.` });
            ctx.fail('NOT_PENDING', `The request is already ${b ? b.status : 'gone'}.`);
          }
          b.status = p.to;
          ctx.sim.enqueue('outbox', { type: p.to, eventId: `${p.id}:${p.to}`, payload: { id: p.id, who: b.who, type: p.to }, actionId: b.actionId });
          return { chargeId: b.chargeId };
        },
      },
      payments: {
        charge: function* (ctx, p) {
          const st = ctx.state;
          if (st.config.records) {
            const key = `pay-${p.booking}`;
            ctx.must(yield ctx.call('paydb', 'begin', { key, booking: p.booking, kind: p.kind }, { timeout: 800 }));
            for (let a = 1; a <= 2; a++) {
              const r = yield ctx.call('psp', p.kind, { key, booking: p.booking, amount: p.amount }, { timeout: 600 });
              if (r.ok) {
                yield ctx.call('paydb', 'finish', { key, status: 'succeeded', chargeId: r.value.chargeId }, { timeout: 800 });
                return { chargeId: r.value.chargeId, replayed: r.value.replayed, key };
              }
              if (r.error.code !== 'TIMEOUT') {
                yield ctx.call('paydb', 'finish', { key, status: 'failed' }, { timeout: 800 });
                ctx.must(r);
              }
              if (a < 2) { ctx.log({ op: `no reply: retry with key ${key}`, status: 'retry', detail: 'The provider may or may not have charged. The retry carries the same key, so it cannot make a second charge.' }); yield ctx.wait(200); }
            }
            st.stats.unknown++;
            yield ctx.call('paydb', 'finish', { key, status: 'unknown' }, { timeout: 800 });
            ctx.log({ op: `${key}: outcome unknown`, status: 'err', detail: 'Two attempts, no answer. The attempt is recorded as unknown; recovery will look it up by key.' });
            return { pending: true, key };
          }
          for (let a = 1; a <= 2; a++) {
            const r = yield ctx.call('psp', p.kind, { key: null, booking: p.booking, amount: p.amount }, { timeout: 600 });
            if (r.ok) return { chargeId: r.value.chargeId };
            if (r.error.code !== 'TIMEOUT' || a === 2) ctx.must(r);
            st.stats.blindRetries++;
            ctx.log({ op: 'no reply: retry blindly', status: 'retry', detail: 'Nothing ties this retry to the first attempt. If the first one charged, this one charges again.' });
            yield ctx.wait(200);
          }
          return null;
        },
        reconcile: function* (ctx, p) {
          const rec = ctx.must(yield ctx.call('paydb', 'get', { booking: p.booking }, { timeout: 800 }));
          if (!rec) return { status: 'none' };
          if (rec.status === 'succeeded') return { status: 'succeeded', chargeId: rec.chargeId };
          if (rec.status === 'failed') return { status: 'failed' };
          const f = ctx.must(yield ctx.call('psp', 'lookup', { key: rec.key }, { timeout: 600 }));
          let chargeId = f && f.chargeId;
          if (!chargeId) chargeId = ctx.must(yield ctx.call('psp', rec.kind, { key: rec.key, booking: p.booking, amount: p.amount }, { timeout: 600 })).chargeId;
          yield ctx.call('paydb', 'finish', { key: rec.key, status: 'succeeded', chargeId }, { timeout: 800 });
          return { status: 'succeeded', chargeId, found: !!(f && f.chargeId) };
        },
        capture: function* (ctx, p) { return ctx.must(yield ctx.call('psp', 'capture', p, { timeout: 600 })); },
        void: function* (ctx, p) { return ctx.must(yield ctx.call('psp', 'void', p, { timeout: 600 })); },
      },
      paydb: {
        begin(ctx, p) { if (!ctx.state.records[p.key]) ctx.state.records[p.key] = { key: p.key, booking: p.booking, kind: p.kind, status: 'pending' }; return { ok: true }; },
        finish(ctx, p) { Object.assign(ctx.state.records[p.key], { status: p.status, chargeId: p.chargeId }); return { ok: true }; },
        get(ctx, p) { return Object.values(ctx.state.records).find((r) => r.booking === p.booking) || null; },
      },
      psp: {
        charge: function* (ctx, p) { return yield* pspCreate(ctx, p, 'captured'); },
        authorize: function* (ctx, p) { return yield* pspCreate(ctx, p, 'authorized'); },
        capture(ctx, p) { const c = ctx.state.charges[p.chargeId]; if (c) c.status = 'captured'; return { ok: true }; },
        void(ctx, p) { const c = ctx.state.charges[p.chargeId]; if (c) c.status = 'voided'; return { ok: true }; },
        lookup(ctx, p) { const c = Object.values(ctx.state.charges).find((x) => x.key === p.key); return c ? { chargeId: c.id } : null; },
      },
      lena: {
        notify(ctx, p) {
          const u = ctx.ui.lena;
          const text = { confirmed: `${NAME[p.who]} booked ${RANGE[p.who]}`, pending: `Request from ${NAME[p.who]}: ${RANGE[p.who]}`, expired: `${NAME[p.who]}’s request expired`, declined: `You declined ${NAME[p.who]}` }[p.type] || p.type;
          u.notes.unshift(text);
          if (u.notes.length > 3) u.notes.pop();
          return { ok: true };
        },
      },
    },
    setup(sim) {
      Y.relay(sim, 'outbox', 'bus', 'bus', 'events');
      Y.consumer(sim, 'events', 'notifier', 'notifier', function* (ctx, msg) {
        const r = yield ctx.call('lena', 'notify', msg.payload, { timeout: 800, actionId: msg.actionId });
        return r.ok;
      });
      // Scheduler: request deadlines, then recovery of stuck checkouts.
      sim.spawn(function* (ctx) {
        let tick = 0;
        for (;;) {
          yield ctx.wait(50);
          if (ctx.mode('paused')) continue;
          const st = ctx.state;
          for (const t of st.timers.filter((x) => x.at <= ctx.now() && !x.fired)) fire(ctx.sim, t); // deadlines missed while paused
          if (++tick % 6 || !st.config.recover) continue;
          for (const b of Object.values(st.bookings).filter((x) => (x.status === 'charging' && ctx.now() - x.since > 800) || x.status === 'payment_pending')) {
            const r = yield ctx.call('payments', 'reconcile', { booking: b.id, amount: amount(b.who) }, { timeout: 1500, quiet: true, actionId: b.actionId });
            if (!r.ok) continue;
            if (r.value.status === 'succeeded') {
              const instant = b.kind !== 'authorize';
              yield ctx.call('calendar', 'step', { id: b.id, status: instant ? 'confirmed' : 'pending', chargeId: r.value.chargeId, deadline: instant ? null : ctx.now() + REQ_MS }, { timeout: 800, actionId: b.actionId });
              st.stats.recovered++;
              ctx.log({ op: `recovered ${b.id}`, status: 'ok', actionId: b.actionId, detail: r.value.found === false ? 'The provider had no charge for this key, so recovery charged once with the same key and confirmed the booking.' : 'The payment record says the charge succeeded, so recovery confirmed the booking.' });
              const g = ctx.ui[b.who];
              if (g) Object.assign(g, { stage: instant ? 'confirmed' : 'pending', booking: b.id, message: 'Payment confirmed.', tone: 'ok' });
              ctx.sim.setLedger(b.actionId, 'committed', 'yes', 'Finished by the recovery job.');
            } else if (r.value.status === 'failed' || r.value.status === 'none') {
              yield ctx.call('calendar', 'step', { id: b.id, status: 'released' }, { timeout: 800, actionId: b.actionId });
            }
          }
        }
      }, { self: 'scheduler', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const bs = Object.values(st.bookings);
      const money = (b) => Object.values(st.charges).filter((c) => c.booking === b.id && c.status === 'captured');
      const twice = bs.find((b) => money(b).length > 1);
      if (twice) return { key: 'wrong', label: `${NAME[twice.who]} was charged ${money(twice).length} times (${usd(amount(twice.who))} each) for one booking, ${twice.id}: the blind retry made a new charge after the first reply was lost.` };
      if (st.told.lena === 'accepted' && sim.ui.maya.stage === 'failed' && st.told.maya === 'expired') {
        const b = bs.find((x) => x.who === 'maya');
        return { key: 'wrong', label: `Lena was told “accepted” and expects Maya; Maya was told the request expired. The booking ends “${b.status}” and the authorisation is ${st.charges[b.chargeId] ? st.charges[b.chargeId].status : 'gone'}: whoever wrote last won.` };
      }
      const paidNothing = bs.find((b) => money(b).length && b.status !== 'confirmed' && sim.now - b.since > 1200);
      if (paidNothing) return { key: 'wrong', label: `${NAME[paidNothing.who]} paid ${usd(amount(paidNothing.who))} but ${paidNothing.id} is stuck in “${paidNothing.status}”: no booking, and its nights are blocked. Nothing will finish it.` };
      const fraud = bs.find((b) => b.who === 'fraud' && b.status === 'confirmed');
      if (fraud) return { key: 'wrong', label: `The new account’s booking ${fraud.id} was confirmed with a leaked card: the fraud check was down and the booking service failed open. Lena will lose the money when the real cardholder disputes it.` };
      const pend = bs.find((b) => b.status === 'payment_pending' || (b.status === 'charging' && sim.now - b.since > 300));
      if (pend) return { key: 'stale', label: `${pend.id} is waiting in “${pend.status.replace('_', ' ')}”: the payment outcome is not known yet. Its nights are held and nobody is charged twice.` };
      const refused = ['maya', 'fraud'].filter((w) => /can’t confirm bookings/.test(sim.ui[w].message));
      if (refused.length && sim.nodes.risk.modes.down) return { key: 'stale', label: `The fraud check is down and bookings fail closed: ${refused.map((w) => (w === 'fraud' ? 'the new account' : NAME[w])).join(' and ')} ${refused.length > 1 ? 'were' : 'was'} refused. Safe, but honest guests cannot book until it returns.` };
      const late = bs.find((b) => b.status === 'pending' && b.deadline < sim.now - 300);
      if (late) return { key: 'stale', label: `${late.id} passed its deadline ${((sim.now - late.deadline) / 1000).toFixed(1)} s ago and is still pending: the scheduler is paused. Maya’s card stays authorised.` };
      if (!bs.length) return { key: 'ok', label: 'Confirm and pay to start.' };
      return { key: 'ok', label: 'Every booking was charged at most once, every charge belongs to a confirmed booking, and host and guest were told the same thing.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const cap = Object.values(st.charges).filter((c) => c.status === 'captured');
      const byB = {};
      for (const c of cap) byB[c.booking] = (byB[c.booking] || 0) + 1;
      const dup = Object.values(byB).reduce((a, n) => a + Math.max(0, n - 1), 0);
      return [
        { label: 'Confirmed bookings', value: Object.values(st.bookings).filter((b) => b.status === 'confirmed').length },
        { label: 'Charges captured', value: cap.length },
        { label: 'Duplicate charges', value: dup, tone: dup ? 'fail' : 'ok' },
        { label: 'Authorisations voided', value: Object.values(st.charges).filter((c) => c.status === 'voided').length },
        { label: 'Outcomes unknown', value: st.stats.unknown, tone: st.stats.unknown ? 'warn' : '' },
        { label: 'Key replays', value: st.stats.replays },
        { label: 'Recovered checkouts', value: st.stats.recovered },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['lena', 'Lena’s phone']], {
          note: 'Maya is on the checkout screen with a quote. Lena can turn Instant Book off to make guests send requests. Below: a brand-new account and the card provider’s ledger.',
          below: '<div class="ops-console" data-ref="ops"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.maya;
        const b = st.bookings[u.booking];
        const instant = sim.ui.lena.instant;
        let stage = Y.btn('pay', instant ? `Confirm and pay ${usd(amount('maya'))}` : 'Request to book', { arg: { who: 'maya' }, cls: 'go', disabled: u.busy });
        if (u.stage === 'working') stage = `<div class="app-card is-work"><strong><span class="spinner"></span>${instant ? 'Confirming…' : 'Sending request…'}</strong></div>`;
        const live = b && u.stage !== 'failed' ? b.status : 'told'; // the phone shows what Maya was told, not the database
        if (b && live === 'confirmed') stage = `<div class="app-card is-ok"><strong>✓ You’re going to Lake Tahoe</strong><span class="app-sub">${esc(b.id)} · charged ${usd(amount('maya'))}</span></div>`;
        if (b && live === 'pending') stage = `<div class="app-card is-hot"><strong>⏱ Request sent to Lena</strong><span class="app-sub">Card authorised, not charged · <span data-live="dl"></span></span></div>`;
        if (b && (live === 'payment_pending' || live === 'charging')) stage = '<div class="app-card is-work"><strong><span class="spinner"></span>Confirming your payment…</strong><span class="app-sub">We’ll let you know shortly.</span></div>';
        if (b && (live === 'expired' || live === 'declined')) stage = `<div class="app-card is-fail"><strong>✕ ${live === 'expired' ? 'Lena didn’t respond in time' : 'Lena declined'}</strong><span class="app-sub">Authorisation released</span></div>`;
        Y.paint(el, sim, 'maya', {
          head: '<div><p class="app-title">Confirm and pay</p><p class="app-sub">Lakeside cabin · Dec 30 – Jan 2</p></div>',
          price: `<div class="app-card"><span class="app-kv"><span>$${PRICE} × 3 nights</span><span>$${PRICE * 3}</span></span><span class="app-kv"><span>Cleaning and service fees</span><span>$${amount('maya') - PRICE * 3}</span></span><span class="app-kv"><strong>Total</strong><strong>${usd(amount('maya'))}</strong></span><span class="app-sub">Visa ·4242</span></div>`,
          stage, msg: Y.msg(u.message, u.tone),
        }, { dl: b && b.deadline ? `Lena has ${(Math.max(0, b.deadline - sim.now) / 1000).toFixed(1)} s` : '' });
        const lu = sim.ui.lena;
        const pend = Object.values(st.bookings).find((x) => x.status === 'pending');
        Y.paint(el, sim, 'lena', {
          head: '<div><p class="app-title">Hosting</p><p class="app-sub">Lena · Lakeside cabin</p></div>',
          setting: `<label class="check"><input type="checkbox" data-field="lena.instant"${lu.instant ? ' checked' : ''}> Instant Book</label>`,
          req: pend ? `<div class="app-card is-hot"><strong>⏱ ${NAME[pend.who]} wants ${RANGE[pend.who]}</strong><span class="app-sub"><span data-live="ldl"></span></span></div><div class="app-row">${Y.btn('accept', 'Accept', { cls: 'go' })}${Y.btn('decline', 'Decline', { cls: 'secondary' })}</div>` : '',
          notes: lu.notes.length ? lu.notes.map((n) => `<div class="app-card"><strong>${esc(n)}</strong></div>`).join('') : '<p class="app-sub">No notifications.</p>',
          msg: Y.msg(lu.message, /Too late/.test(lu.message) ? 'fail' : 'ok'),
        }, { ldl: pend ? `${(Math.max(0, pend.deadline - sim.now) / 1000).toFixed(1)} s left to answer` : '' });
        const fu = sim.ui.fraud;
        const fb = st.bookings[fu.booking];
        const c = sim.scenario.consistency(sim);
        const charges = Object.values(st.charges).slice(-4).reverse();
        SDL.ui.paintSections(el.querySelector('[data-ref="ops"]'), {
          title: '<p class="ops-title">New account (created an hour ago) · card provider ledger</p>',
          fraud: `<div class="app-row">${Y.btn('pay', `New account: book ${RANGE.fraud} with a leaked card`, { arg: { who: 'fraud' }, cls: 'secondary', disabled: fu.busy || !!fb })}</div>${fb ? `<p class="app-sub">${esc(fb.id)}: ${esc(fb.status)}${fb.unchecked ? ' (no fraud check)' : ''}</p>` : Y.msg(fu.message, fu.tone)}`,
          ledger: `<div class="ops-shards">${charges.map((x) => `<div class="ops-row" data-tone="${x.status === 'captured' ? 'ok' : x.status === 'voided' ? '' : 'warn'}"><div class="ops-name">${esc(x.id)} · ${esc(x.booking)} · $${x.amount}<span>${esc(x.status)}${x.key ? ` · key ${esc(x.key)}` : ' · no key'}</span></div></div>`).join('') || '<p class="app-sub">No charges yet.</p>'}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };

  /** The provider: a key it has seen returns the earlier charge. */
  function* pspCreate(ctx, p, status) {
    const st = ctx.state;
    if (p.key) {
      const old = Object.values(st.charges).find((c) => c.key === p.key);
      if (old) { st.stats.replays++; ctx.log({ op: `key ${p.key}: same charge ${old.id}`, status: 'dup', detail: 'The provider has already processed this key and returns the original result. No new charge.' }); return { chargeId: old.id, replayed: true }; }
    }
    const id = `ch${++st.seq.c}`;
    st.charges[id] = { id, key: p.key, booking: p.booking, amount: p.amount, status };
    if (ctx.mode('loseNextReply')) {
      ctx.sim.restore('psp', 'loseNextReply');
      ctx.log({ op: `${id} made, reply lost`, status: 'lost', detail: `The card was ${status === 'captured' ? 'charged' : 'authorised'}; the reply never reaches the payment service in time.` });
      yield ctx.wait(2000);
    }
    return { chargeId: id };
  }

  /** A deadline is due: the scheduler runs the expiry (twice if it is misbehaving). Paused: the loop catches up later. */
  function fire(sim, t) {
    if (t.fired || sim.nodes.scheduler.modes.paused) return;
    t.fired = 1;
    const runs = sim.nodes.scheduler.modes.twice ? 2 : 1;
    for (let i = 0; i < runs; i++) sim.spawn((c) => expire(c, t.id), { self: 'scheduler', actionId: sim.state.bookings[t.id].actionId });
  }
  /** A request deadline fired. */
  function* expire(ctx, id) {
    const st = ctx.state;
    const r = yield* tryDecide(ctx, id, 'expired');
    if (!r) return;
    st.told.maya = 'expired';
    const g = ctx.ui[st.bookings[id].who];
    if (g) Object.assign(g, { stage: 'failed', message: 'Lena didn’t respond in time. Your authorisation was released.', tone: 'fail' });
    ctx.log({ op: `request ${id} expired`, status: 'ok', detail: r.blind ? 'Expiry read “pending”, voided the authorisation, and wrote “expired”, without checking again before writing.' : 'The request was still pending, so the expiry won: nights released, authorisation voided.' });
  }
  function* tryDecide(ctx, id, to) {
    try { return yield* decide(ctx, id, to); } catch (e) { return null; }
  }
})(typeof window !== 'undefined' ? window : globalThis);
