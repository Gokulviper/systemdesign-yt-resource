/*
 * Paying the host exactly once.
 * Maya paid $1,670.28 for Dec 30 – Jan 2. Lena is paid her share (nights and
 * cleaning, less a 3% host fee) 24 hours after check-in. A scheduler puts a
 * payout job on a queue at that moment; the payout worker claims the payout,
 * works out the amount from the booking, asks the bank to transfer it, and
 * records it in the ledger. Reconciliation compares the bank statement with
 * the ledger twice a day. Two schedulers, a crash after the bank accepted, a
 * bank that never answers, a cancellation during the run, and a payout
 * account changed by someone else all test whether money out ever exceeds
 * money in. Simulated time is scaled: 0.1 s stands for one hour. All money is
 * integer cents.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const HOUR = 100;
  const DAY = 24 * HOUR;
  const LEASE = 10 * HOUR; // longer than the bank timeout
  const HOLD = 72 * HOUR;
  const RECON = 12 * HOUR;
  const PAID = 167028; // what Maya paid
  const HOST_NIGHT = 38703; // $399 less 3%
  const HOST_CLEAN = 14550; // $150 less 3%
  const GUEST_NIGHT = 49476; // $399 + service fee + tax for one night
  const NIGHTS = ['Dec 30', 'Dec 31', 'Jan 1'];
  const DAYS = ['Dec 30', 'Dec 31', 'Jan 1', 'Jan 2', 'Jan 3', 'Jan 4', 'Jan 5'];
  const LENA = 'Lena ·· 4021';
  const THIEF = 'New account ·· 9917';

  const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /** Story time: check-in is Dec 30, 4 pm. */
  const when = (st, t) => {
    const h = Math.max(0, Math.floor((t - st.checkin) / HOUR)) + 16;
    const hr = h % 24;
    return `${DAYS[Math.floor(h / 24)] || 'later'}, ${hr === 0 ? '12 am' : hr < 12 ? `${hr} am` : hr === 12 ? '12 pm' : `${hr - 12} pm`}`;
  };
  /** Nights that had not started yet when the trip was cancelled. */
  const unusedAt = (st, t) => NIGHTS.filter((_, i) => st.checkin + i * DAY > t).length;
  const hostShare = (st) => (NIGHTS.length - st.booking.unused) * HOST_NIGHT + HOST_CLEAN;
  const toLena = (st) => st.bank.transfers.filter((x) => x.to === LENA && x.status !== 'rejected');
  const outNet = (st) => st.bank.transfers.filter((x) => x.status === 'settled').reduce((a, x) => a + x.amt, 0) + st.bank.refunds.reduce((a, x) => a + x.amt, 0) - st.receivable;

  /** Check-in now; the payout is due 24 hours later, scheduled for that exact moment. */
  function begin(sim) {
    const st = sim.state;
    st.checkin = sim.now;
    st.due = sim.now + DAY;
    const due = st.due;
    sim.schedule(DAY, () => tick(sim, due, 'due'));
  }
  /** The scheduler fires: one job per scheduler instance that has not yet scheduled this payout. */
  function tick(sim, due, why) {
    const st = sim.state;
    if (due !== st.due) return; // a timer from an earlier story
    if (sim.nodes.scheduler.modes.paused) { st.missed = true; return; }
    const p = st.payout;
    const retry = why === 'lease';
    if (!retry && p.status !== 'pending') return;
    if (retry && !(p.status === 'claimed' && p.lease <= sim.now)) return;
    const instances = sim.nodes.scheduler.modes.twice ? ['A', 'B'] : ['A'];
    for (const inst of instances) {
      const key = `${inst}:${why}:${p.tries}`;
      if (st.sched[key]) continue;
      st.sched[key] = true;
      sim.enqueue('jobs', { eventId: `job-${++st.seq.job}`, type: 'payout.due', payload: { pid: p.id, by: inst, why } });
    }
    sim.note(`${instances.length > 1 ? 'Two schedulers' : 'The scheduler'} ${retry ? 'found an expired claim and re-queued' : 'queued'} payout ${p.id} at ${when(st, sim.now)}.`);
  }

  /* ---------------- flows ---------------- */
  function cancel(sim) {
    const u = sim.ui.maya;
    if (u.busy || sim.state.booking.status !== 'confirmed') return;
    u.busy = true;
    sim.startAction('Maya: cancel the rest of the trip', function* (ctx) {
      const st = ctx.state;
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'Cancelling a cancelled booking changes nothing.'] });
      const r = yield ctx.call('api', 'cancel', {}, { timeout: 2000 });
      ctx.recordOutcome(r.ok, r.latency);
      u.busy = false;
      if (!r.ok) { u.message = `Couldn’t cancel: ${r.error.message}`; Y.failed(ctx, r.error.message); return; }
      const v = r.value;
      u.message = `Cancelled. ${v.unused} unused night${v.unused === 1 ? '' : 's'}: ${usd(v.refund)} back to your card.`;
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Refund ${usd(v.refund)}${v.clawback ? `, ${usd(v.clawback)} recovered from Lena` : ''}.`], async: 'n/a' });
      ctx.explain(v.clawback
        ? `The payout was already on its way, for the full ${usd(v.paidOut)}. The cancellation read the payout’s state in the same ledger transaction, so it refunded ${usd(v.refund)} and booked ${usd(v.clawback)} as owed by Lena, to come out of Lena’s next payout. Money out stays below money in.`
        : v.inFlight
          ? `The refund service worked out ${usd(v.refund)} by policy and paid it, unaware that the payout worker had already fixed Lena’s amount at the full ${usd(v.paidOut)}. Both left the platform.`
          : `The payout had not run yet. The refund is ${usd(v.refund)} for ${v.unused} unused night${v.unused === 1 ? '' : 's'}; when the payout runs it reads the cancelled booking and pays Lena for the nights used and cleaning: ${usd(hostShare(st))}.`);
    }, { self: 'maya' });
  }

  function takeover(sim) {
    sim.startAction('Someone else: change Lena’s payout account', function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'Not Lena.'], retrySafe: 'yes' });
      const r = yield ctx.call('api', 'account', { iban: THIEF, by: 'unknown device' }, { timeout: 1500 });
      if (r.ok) { Y.L(ctx, { accepted: 'yes', committed: 'yes', async: 'n/a' }); ctx.explain(`A stolen session changed the payout account to ${THIEF}. Lena gets an email; whether the next payout waits depends on the hold.`); }
      else Y.failed(ctx, r.error.message);
    }, { self: 'lena' });
  }

  function notMe(sim) {
    sim.startAction('Lena: “That wasn’t me”', function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call('api', 'account', { iban: LENA, by: 'Lena, verified', release: true }, { timeout: 1500 });
      if (r.ok) {
        sim.ui.lena.message = 'Thanks. Your account is restored and the payout is released.';
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'yes', async: ['pending', 'The payout runs again.'] });
        ctx.explain('Lena confirmed the change was not hers. The old account is restored after verification and the held payout is queued again.');
      } else Y.failed(ctx, r.error.message);
    }, { self: 'lena' });
  }

  SDL.scenarios['bnb-payouts'] = {
    id: 'bnb-payouts',
    seed: 4733,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Lena checks Maya in on Dec 30 at 4 pm; the payout runs 24 hours later (2.4 s here). Watch it go out once. Then run two schedulers, crash the worker after the bank accepts, cancel the trip mid-run, or change the payout account from somewhere else.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'lena', label: 'Lena’s earnings', sub: 'Host', kind: 'client', x: 90, y: 110, latency: 1, role: 'Sees upcoming and paid payouts and the payout account.', owns: ['What Lena sees'] },
        { id: 'maya', label: 'Maya’s phone', sub: 'Guest', kind: 'client', x: 90, y: 480, latency: 1, role: 'Can cancel the rest of the trip.', owns: ['What Maya sees'] },
        { id: 'api', label: 'API gateway', sub: 'Routing', kind: 'gateway', x: 280, y: 300, latency: 2, role: 'Routes account changes and cancellations.', ops: [{ name: 'cancel', desc: 'Cancel the trip.' }, { name: 'account', desc: 'Change the payout account.' }], owns: ['Nothing durable'] },
        { id: 'booking', label: 'Booking service', sub: 'Trip state', kind: 'service', x: 480, y: 480, latency: 3, role: 'Cancels the booking and asks for the refund.', ops: [{ name: 'cancel', desc: 'Cancel and refund.' }], owns: ['Booking status'] },
        { id: 'refund', label: 'Refund service', sub: 'Cancellation policy', kind: 'service', x: 700, y: 480, latency: 3, role: 'Refunds unused nights (cleaning is kept after check-in).', ops: [{ name: 'refund', desc: 'Refund by policy.' }], owns: ['Policy'] },
        { id: 'ledger', label: 'Ledger', sub: 'Payouts + journal', kind: 'db', x: 700, y: 300, latency: 5, role: 'The payout record (status, claim, amount) and a journal of every movement of money.', ops: [{ name: 'claim', desc: 'Claim a payout.' }, { name: 'record', desc: 'Record a transfer.' }, { name: 'cancel', desc: 'Cancel with the payout in one transaction.' }], owns: ['payouts', 'journal'] },
        { id: 'bank', label: 'Bank / payout provider', sub: 'Transfers', kind: 'service', x: 960, y: 300, latency: 300, role: 'Sends money to the payout account. With an idempotency key, a repeated request returns the first transfer.', ops: [{ name: 'transfer', desc: 'Pay the host.' }, { name: 'refund', desc: 'Refund the guest’s card.' }, { name: 'statement', desc: 'Settled transfers.' }], owns: ['transfers'] },
        { id: 'scheduler', label: 'Payout scheduler', sub: '24 h after check-in', kind: 'worker', x: 280, y: 110, latency: 2, role: 'Queues a payout job at the due time, and again if a claim expires unfinished.', owns: ['Which payouts it queued'] },
        { id: 'jobs', label: 'Payout jobs', sub: 'Queue', kind: 'queue', x: 480, y: 110, latency: 2, queue: 'jobs', role: 'Jobs from the scheduler.', owns: ['pending jobs'] },
        { id: 'worker', label: 'Payout worker', sub: 'Claim, transfer, record', kind: 'worker', x: 700, y: 110, latency: 3, role: 'Claims the payout, works out the amount from the booking, asks the bank, records the result.', owns: ['Nothing durable'] },
        { id: 'recon', label: 'Reconciliation', sub: 'Every 12 h', kind: 'worker', x: 960, y: 110, latency: 3, role: 'Matches the bank statement against the ledger. Settles payouts whose outcome was unknown; flags anything else.', owns: ['Open flags'] },
      ],
      edges: [
        { from: 'lena', to: 'api', latency: 40 },
        { from: 'maya', to: 'api', latency: 40 },
        { from: 'api', to: 'booking', latency: 3, via: [[280, 480]] },
        { from: 'api', to: 'ledger', latency: 3 },
        { from: 'booking', to: 'refund', latency: 3 },
        { from: 'booking', to: 'ledger', latency: 3, via: [[480, 380], [700, 380]] },
        { from: 'refund', to: 'bank', latency: 5, via: [[960, 480]] },
        { from: 'scheduler', to: 'jobs', latency: 2 },
        { from: 'jobs', to: 'worker', latency: 2 },
        { from: 'worker', to: 'ledger', latency: 3 },
        { from: 'worker', to: 'bank', latency: 5, via: [[960, 160]] },
        { from: 'recon', to: 'bank', latency: 5 },
        { from: 'recon', to: 'ledger', latency: 5, via: [[860, 110], [860, 260]] },
      ],
      queues: [{ id: 'jobs', broker: 'jobs', label: 'jobs', groups: ['worker'] }],
    },
    modeLabels: { twice: 'Two instances running', crashAfterAccept: 'Crashes after the bank accepts', lostReply: 'Loses the next reply', reject: 'Rejecting transfers', loseNext: 'Failover loses the next entry', utc: 'Due time in UTC' },
    failures: [
      { id: 'twice', node: 'scheduler', mode: 'twice', label: 'Scheduler runs twice', desc: 'A deploy left two scheduler instances running; both queue the payout.' },
      { id: 'crash', node: 'worker', mode: 'crashAfterAccept', label: 'Worker crashes after the bank accepts', desc: 'The transfer is made; the ledger never hears. The claim expires after 10 h and the payout is retried.' },
      { id: 'lost', node: 'bank', mode: 'lostReply', label: 'Bank reply lost', desc: 'The bank makes the transfer; the worker times out and cannot tell whether it did.' },
      { id: 'reject', node: 'bank', mode: 'reject', label: 'Bank rejects transfers', desc: 'The payout account is closed.' },
      { id: 'failover', node: 'ledger', mode: 'loseNext', label: 'Ledger failover loses an entry', desc: 'The primary dies before replicating the next journal entry.' },
      { id: 'sched-paused', node: 'scheduler', mode: 'paused', label: 'Scheduler paused', desc: 'Payouts are not queued; they run late when it resumes.' },
      { id: 'recon-paused', node: 'recon', mode: 'paused', label: 'Reconciliation paused', desc: 'Nobody compares the bank with the ledger.' },
      { id: 'bank-slow', node: 'bank', mode: 'slow', params: { factor: 3 }, label: 'Bank slow', desc: 'Transfers take three times as long; the run stays open longer.' },
    ],
    switches: Y.switches([
      ['claim', 'Claim each payout (compare-and-set)', 'A worker moves the payout from pending to claimed, with a 10 h lease; a second worker’s claim fails. Off: read the status and go.'],
      ['key', 'Bank idempotency key', 'Every transfer request for a payout carries the payout id; the bank returns the first transfer for a repeat. Off: each request is a new transfer.'],
      ['atomic', 'Cancel and payout in one transaction', 'A cancellation reads the payout’s state in the same ledger transaction and books any overpayment as owed by the host. Off: the refund service acts alone.'],
      ['hold', 'Hold after a payout account change', 'For 72 h after the account changes, payouts wait and the host is asked to confirm. Off: pay whatever account is on file.'],
    ]),
    presets: Y.presets({ claim: true, key: true, atomic: true, hold: true }, [
      { id: 'payout', label: 'Payout 24 h after check-in', desc: 'Check-in Dec 30, 4 pm. At 4 pm the next day the payout is queued, claimed, transferred, and recorded: $1,306.59 to Lena, once.', run: (s) => begin(s) },
      { id: 'two-noclaim', label: 'Two schedulers, no claim', desc: 'Two scheduler instances queue the payout. Without a claim or a bank key, both workers read “pending” and both transfer.', sw: { claim: false, key: false }, run: (s) => { s.inject('scheduler', 'twice'); begin(s); } },
      { id: 'two-claim', label: 'Two schedulers, claim', desc: 'Same two jobs, still no bank key. The second worker’s claim fails, so the bank is asked once.', sw: { key: false }, run: (s) => { s.inject('scheduler', 'twice'); begin(s); } },
      { id: 'crash-nokey', label: 'Crash after the bank accepts, no key', desc: 'The transfer goes out and the worker dies before recording it. The claim expires, the retry asks the bank again, and Lena is paid twice.', sw: { key: false }, run: (s) => { s.inject('worker', 'crashAfterAccept'); begin(s); } },
      { id: 'crash-key', label: 'Crash after the bank accepts, key', desc: 'Same crash. The retry carries the payout id; the bank returns the transfer it already made, and the ledger records it once.', run: (s) => { s.inject('worker', 'crashAfterAccept'); begin(s); } },
      { id: 'bank-timeout', label: 'Bank never answers', desc: 'The transfer is made but the reply is lost. The worker marks the payout “unknown” instead of retrying; reconciliation finds it on the statement and settles it.', run: (s) => { s.inject('bank', 'lostReply'); begin(s); } },
      { id: 'bank-reject', label: 'Bank rejects the transfer', desc: 'Lena’s account is closed. The payout is held and Lena is asked to add a new account.', run: (s) => { s.inject('bank', 'reject'); begin(s); } },
      { id: 'cancel-separate', label: 'Cancel during the run, separate operations', desc: 'Maya cancels the last night while the transfer is in flight. The refund service refunds it; the payout still pays the full amount. More money leaves than came in.', sw: { atomic: false }, run: (s) => { begin(s); s.schedule(DAY + 100, () => cancel(s)); } },
      { id: 'cancel-atomic', label: 'Cancel during the run, one transaction', desc: 'Same timing. The cancellation sees the payout in flight and books the unused night as owed by Lena, recovered from Lena’s next payout.', run: (s) => { begin(s); s.schedule(DAY + 100, () => cancel(s)); } },
      { id: 'partial', label: 'Cancel before the payout', desc: 'Maya leaves after the first night, cancelling Dec 31 and Jan 1 at 10 pm on Dec 30. Maya gets two nights back; Lena is paid for one night and cleaning.', run: (s) => { begin(s); s.schedule(6 * HOUR, () => cancel(s)); } },
      { id: 'takeover-nohold', label: 'Account changed by someone else, no hold', desc: 'Six hours after check-in, a stolen session changes the payout account. The payout goes to the new account.', sw: { hold: false }, run: (s) => { begin(s); s.schedule(6 * HOUR, () => takeover(s)); } },
      { id: 'takeover-hold', label: 'Account changed by someone else, hold', desc: 'Same change. The payout waits; Lena taps “That wasn’t me”, the account is restored, and the payout goes to Lena.', run: (s) => { begin(s); s.schedule(6 * HOUR, () => takeover(s)); s.schedule(DAY + 600, () => notMe(s)); } },
      { id: 'failover', label: 'Ledger failover loses an entry', desc: 'The payout is made and its journal entry is lost in a failover. Reconciliation sees a transfer the journal does not have and flags it for finance.', run: (s) => { s.inject('ledger', 'loseNext'); begin(s); } },
    ]),
    initialState: () => ({
      config: { claim: true, key: true, atomic: true, hold: true },
      checkin: 0, due: DAY, missed: false,
      booking: { status: 'confirmed', unused: 0, cancelledAt: null },
      payout: { id: 'P1', status: 'pending', lease: 0, amount: null, transfer: null, reason: '', tries: 0, paidAt: null },
      journal: [{ kind: 'guest paid', amt: PAID, ref: 'B1' }],
      bank: { transfers: [], refunds: [] },
      account: { iban: LENA, changedAt: null, by: 'Lena' },
      receivable: 0, flags: [], sched: {},
      stats: { claimsLost: 0, deduped: 0, unknown: 0 },
      seq: { job: 0, tx: 0 },
    }),
    initialUI: () => ({ lena: { message: '' }, maya: { busy: false, message: '' } }),
    actions: {
      cancel(sim) { cancel(sim); },
      takeover(sim) { takeover(sim); },
      notMe(sim) { notMe(sim); },
      checkin(sim) { begin(sim); sim.note('Check-in: Dec 30, 4 pm. The payout is due in 24 hours.'); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        cancel: function* (ctx) { return ctx.must(yield ctx.call('booking', 'cancel', {}, { timeout: 1800 })); },
        account: function* (ctx, p) { return ctx.must(yield ctx.call('ledger', 'account', p, { timeout: 1200 })); },
      },
      booking: {
        cancel: function* (ctx) {
          const st = ctx.state;
          const unused = unusedAt(st, ctx.now());
          if (!unused) ctx.fail('NOTHING_LEFT', 'Every night has started; nothing to refund.');
          const refund = unused * GUEST_NIGHT;
          if (st.config.atomic) {
            const t = ctx.must(yield ctx.call('ledger', 'cancel', { unused, refund }, { timeout: 800 }));
            yield ctx.call('bank', 'refund', { amt: refund }, { timeout: 1200 });
            return Object.assign({ unused, refund }, t);
          }
          // Separate operations: the booking row and the refund, without looking at the payout.
          st.booking = { status: 'cancelled', unused, cancelledAt: ctx.now() };
          const inFlight = ['claimed', 'unknown'].includes(st.payout.status) && st.payout.amount != null;
          ctx.must(yield ctx.call('refund', 'refund', { amt: refund }, { timeout: 1500 }));
          return { unused, refund, inFlight, paidOut: st.payout.amount, clawback: 0 };
        },
      },
      refund: {
        refund: function* (ctx, p) {
          ctx.state.journal.push({ kind: 'refund to Maya', amt: -p.amt, ref: 'B1' });
          return ctx.must(yield ctx.call('bank', 'refund', p, { timeout: 1200 }));
        },
      },
      ledger: {
        claim(ctx, p) {
          const st = ctx.state;
          const po = st.payout;
          if (!st.config.claim) {
            if (po.status === 'paid' || po.status === 'held') return { ok: false, status: po.status };
            return { ok: true, raced: po.status === 'claimed' };
          }
          const free = po.status === 'pending' || (po.status === 'claimed' && po.lease <= ctx.now());
          if (!free) { st.stats.claimsLost++; return { ok: false, status: po.status }; }
          po.status = 'claimed';
          po.lease = ctx.now() + LEASE;
          po.tries++;
          po.by = p.by;
          const due = st.due;
          ctx.sim.schedule(LEASE, () => tick(ctx.sim, due, 'lease'));
          return { ok: true };
        },
        prepare(ctx) {
          const st = ctx.state;
          const po = st.payout;
          if (st.config.hold && st.account.changedAt != null && ctx.now() - st.account.changedAt < HOLD) {
            po.status = 'held';
            po.reason = 'account';
            return { hold: true };
          }
          po.amount = hostShare(st);
          return { amount: po.amount, to: st.account.iban };
        },
        record(ctx, p) {
          const st = ctx.state;
          const po = st.payout;
          if (p.status === 'unknown') { po.status = 'unknown'; return { ok: true }; }
          if (p.status === 'rejected') { po.status = 'held'; po.reason = 'rejected'; return { ok: true }; }
          po.status = 'paid';
          po.transfer = p.tx;
          po.paidAt = ctx.now();
          if (ctx.mode('loseNext')) {
            ctx.sim.restore('ledger', 'loseNext');
            ctx.log({ op: `journal entry for ${p.tx} lost in failover`, status: 'lost', detail: 'The primary died before replicating it. The payout record (written earlier) says paid; the journal does not show the money leaving.' });
            return { ok: true };
          }
          st.journal.push({ kind: `payout to ${p.to}`, amt: -p.amt, ref: p.tx });
          return { ok: true };
        },
        cancel(ctx, p) {
          const st = ctx.state;
          const po = st.payout;
          st.booking = { status: 'cancelled', unused: p.unused, cancelledAt: ctx.now() };
          st.journal.push({ kind: 'refund to Maya', amt: -p.refund, ref: 'B1' });
          if (po.amount != null && ['claimed', 'unknown', 'paid'].includes(po.status)) {
            const clawback = p.unused * HOST_NIGHT;
            st.receivable += clawback;
            st.journal.push({ kind: 'owed by Lena (next payout)', amt: clawback, ref: 'B1' });
            return { clawback, paidOut: po.amount, inFlight: true };
          }
          return { clawback: 0, inFlight: false };
        },
        account(ctx, p) {
          const st = ctx.state;
          st.account = { iban: p.iban, changedAt: p.release ? null : ctx.now(), by: p.by };
          if (!p.release) ctx.ui.lena.message = `Your payout account was changed to ${p.iban} from an unknown device. Wasn’t you?`;
          if (p.release && st.payout.status === 'held' && st.payout.reason === 'account') {
            st.payout.status = 'pending';
            st.payout.tries++;
            ctx.sim.enqueue('jobs', { eventId: `job-${++st.seq.job}`, type: 'payout.due', payload: { pid: 'P1', by: 'release', why: 'release' } });
          }
          return { ok: true };
        },
        journal(ctx) { return { out: -ctx.state.journal.filter((e) => /^payout/.test(e.kind)).reduce((a, e) => a + e.amt, 0) }; },
        settle(ctx, p) {
          const st = ctx.state;
          st.payout.status = 'paid';
          st.payout.transfer = p.tx;
          st.payout.paidAt = ctx.now();
          st.journal.push({ kind: `payout to ${p.to}`, amt: -p.amt, ref: p.tx });
          return { ok: true };
        },
      },
      bank: {
        transfer: function* (ctx, p) {
          const st = ctx.state;
          if (ctx.mode('reject')) ctx.fail('ACCOUNT_CLOSED', 'The receiving account is closed.');
          const same = p.key && st.bank.transfers.find((x) => x.key === p.key);
          if (same) { st.stats.deduped++; ctx.log({ op: `key ${p.key}: returned ${same.id}`, status: 'dup', detail: 'The bank already made this transfer and returns it instead of sending money again.' }); return { tx: same.id, existing: true }; }
          const tx = { id: `T${++st.seq.tx}`, key: p.key, to: p.to, amt: p.amt, status: 'settled', at: ctx.now() };
          st.bank.transfers.push(tx);
          if (ctx.mode('lostReply')) {
            ctx.sim.restore('bank', 'lostReply');
            ctx.log({ op: `${tx.id} made; reply lost`, status: 'lost', detail: 'The money is on its way, but the worker will not hear back.' });
            yield ctx.wait(3000);
          }
          return { tx: tx.id };
        },
        refund(ctx, p) { ctx.state.bank.refunds.push({ amt: p.amt, at: ctx.now() }); return { ok: true }; },
        statement(ctx) { return { transfers: ctx.state.bank.transfers.filter((x) => x.status === 'settled').map((x) => Object.assign({}, x)) }; },
      },
    },
    setup(sim) {
      begin(sim);
      // Payout worker: each job is handled on its own, so two jobs can run at once.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('jobs', 'worker');
          ctx.ack('jobs', 'worker');
          ctx.spawn((c) => runJob(c, msg.payload), { self: 'worker', quiet: 'all' });
        }
      }, { self: 'worker', quiet: 'all' });
      // Reconciliation: every 12 h, the bank statement against the ledger.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(RECON);
          if (ctx.mode('paused')) continue;
          const st = ctx.state;
          const b = yield ctx.call('bank', 'statement', {}, { timeout: 1500, quiet: 'all' });
          if (!b.ok) continue;
          const po = st.payout;
          for (const tx of b.value.transfers) {
            const booked = st.journal.some((e) => e.ref === tx.id);
            if (booked || st.flags.some((f) => f.tx === tx.id) || tx.at > ctx.now() - RECON) continue; // only settled, older transfers
            if (po.status === 'unknown' && !po.transfer) {
              yield ctx.call('ledger', 'settle', { tx: tx.id, amt: tx.amt, to: tx.to }, { timeout: 800, quiet: 'all' });
              ctx.log({ op: `settled ${po.id} from the statement (${tx.id})`, status: 'ok', detail: `The bank shows ${usd(tx.amt)} to ${tx.to}. The payout whose outcome was unknown is now recorded as paid.` });
              continue;
            }
            st.flags.push({ tx: tx.id, amt: tx.amt, to: tx.to });
            ctx.log({ op: `flagged ${tx.id}: on the statement, not in the journal`, status: 'err', detail: `${usd(tx.amt)} to ${tx.to} left the bank, and the ledger has no entry for it. Finance must look.` });
          }
        }
      }, { self: 'recon', quiet: 'all' });
      // A paused scheduler catches up when it resumes.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(HOUR);
          const st = ctx.state;
          if (st.missed && !ctx.mode('paused', 'scheduler')) { st.missed = false; tick(ctx.sim, st.due, 'due'); }
        }
      }, { self: 'scheduler', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const lena = toLena(st);
      const thief = st.bank.transfers.filter((x) => x.to === THIEF);
      if (thief.length) return { key: 'wrong', label: `${usd(thief[0].amt)} went to ${THIEF}, an account Lena did not add. The payout account changed ${Math.round((thief[0].at - st.account.changedAt) / HOUR)} h before the payout and nothing held it.` };
      if (lena.length > 1) return { key: 'wrong', label: `Lena was paid ${lena.length} times for one stay: ${lena.map((x) => `${x.id} ${usd(x.amt)}`).join(' and ')}. ${st.config.claim ? 'The retry after the crash' : 'Two workers'} asked the bank without a key it could deduplicate.` };
      const out = outNet(st);
      if (out > PAID) return { key: 'wrong', label: `More money left than came in: Maya paid ${usd(PAID)}; ${usd(out)} went out (Lena ${usd(lena.reduce((a, x) => a + x.amt, 0))}, Maya’s refund ${usd(st.bank.refunds.reduce((a, x) => a + x.amt, 0))}). The refund and the payout were decided separately.` };
      if (st.flags.length) return { key: 'stale', label: `Reconciliation flagged ${st.flags.map((f) => `${f.tx} (${usd(f.amt)} to ${f.to})`).join(', ')}: the bank paid it, the journal does not show it. Lena was paid once; the books are wrong until finance fixes them.` };
      const po = st.payout;
      if (po.status === 'held') return { key: 'stale', label: po.reason === 'rejected' ? 'The bank rejected the transfer (account closed). The payout is held and Lena has been asked for a new account.' : `The payout is held: the payout account changed ${((sim.now - st.account.changedAt) / HOUR).toFixed(0)} h ago. Lena has been asked to confirm.` };
      if (po.status === 'unknown') return { key: 'stale', label: 'The bank never answered. The payout is “unknown”, not retried; reconciliation will settle it from the statement.' };
      if (sim.now > st.due + 3 * HOUR && po.status !== 'paid') return { key: 'stale', label: `The payout was due at ${when(st, st.due)} and has not been made (${po.status}).` };
      if (po.status !== 'paid') return { key: 'ok', label: `Payout ${po.id} is due ${when(st, st.due)}.` };
      return { key: 'ok', label: `Lena was paid ${usd(lena[0].amt)} once (${lena[0].id}). Money in ${usd(PAID)}, money out ${usd(out)}${st.receivable ? ` after ${usd(st.receivable)} owed by Lena` : ''}; the platform keeps the fees and the tax to remit.${st.stats.deduped ? ' The bank returned the first transfer for the retry.' : ''}${st.stats.claimsLost ? ' A second claim was refused.' : ''}${st.stats.unknown ? ' The bank never answered; reconciliation settled it from the statement.' : ''}` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const out = outNet(st);
      const lena = toLena(st);
      return [
        { label: 'Money in', value: usd(PAID) },
        { label: 'Money out (net)', value: usd(out), tone: out > PAID ? 'fail' : '' },
        { label: 'Transfers to Lena', value: lena.length, tone: lena.length > 1 ? 'fail' : '' },
        { label: 'Refunded to Maya', value: usd(st.bank.refunds.reduce((a, x) => a + x.amt, 0)) },
        { label: 'Owed by Lena', value: usd(st.receivable) },
        { label: 'Payout status', value: st.payout.status, tone: ['held', 'unknown'].includes(st.payout.status) ? 'warn' : '' },
        { label: 'Reconciliation flags', value: st.flags.length, tone: st.flags.length ? 'warn' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['lena', 'Lena’s earnings'], ['maya', 'Maya’s phone']], {
          note: 'Lena’s earnings screen and Maya’s trip. The console below shows the bank statement next to the ledger’s journal.',
          below: '<div class="ops-console" data-ref="books"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const po = st.payout;
        const lena = toLena(st);
        const status = po.status === 'paid' ? `Paid ${when(st, po.paidAt)}` : po.status === 'held' ? 'On hold' : po.status === 'unknown' ? 'Processing' : po.status === 'claimed' ? 'Sending…' : `Due ${when(st, st.due)}`;
        const tone = po.status === 'paid' ? (lena.length > 1 ? 'fail' : 'ok') : po.status === 'held' ? 'warn' : '';
        Y.paint(el, sim, 'lena', {
          head: '<div><p class="app-title">Earnings</p><p class="app-sub">Lakeside cabin · Maya · Dec 30 – Jan 2</p></div>',
          payout: `<div class="ops-shards"><div class="ops-row" data-tone="${tone}"><div class="ops-name">Payout ${esc(po.id)}<span>${po.amount != null ? usd(po.amount) : usd(hostShare(st))} · ${esc(status)}</span></div></div>
            ${lena.map((x) => `<div class="ops-row" data-tone="${lena.length > 1 ? 'fail' : ''}"><div class="ops-name">${esc(x.id)}<span>${usd(x.amt)} to ${esc(x.to)}</span></div></div>`).join('')}</div>`,
          account: `<p class="app-sub">Payout account: ${esc(st.account.iban)}${st.account.changedAt != null ? ' · changed recently' : ''}</p>${st.account.changedAt != null ? Y.btn('notMe', 'That wasn’t me', { cls: 'secondary' }) : ''}`,
          msg: Y.msg(sim.ui.lena.message, st.account.changedAt != null ? 'warn' : ''),
        }, {});
        const b = st.booking;
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Your trip</p><p class="app-sub">Lakeside cabin · checked in ${when(st, st.checkin)}</p></div>`,
          trip: `<div class="ops-shards">${NIGHTS.map((d, i) => `<div class="ops-row" data-tone="${b.status === 'cancelled' && i >= NIGHTS.length - b.unused ? 'warn' : ''}"><div class="ops-name">${d}<span>${b.status === 'cancelled' && i >= NIGHTS.length - b.unused ? 'cancelled' : st.checkin + i * DAY <= sim.now ? 'stayed' : 'upcoming'}</span></div></div>`).join('')}</div>
            <p class="app-sub">Paid ${usd(PAID)} · now ${esc(when(st, sim.now))}</p>`,
          stage: b.status === 'cancelled' ? '<div class="app-card is-ok"><strong>Trip cancelled</strong></div>' : Y.btn('cancel', `Cancel the rest (${unusedAt(st, sim.now)} night${unusedAt(st, sim.now) === 1 ? '' : 's'} back)`, { cls: 'secondary', disabled: sim.ui.maya.busy || !unusedAt(st, sim.now) }),
          msg: Y.msg(sim.ui.maya.message, ''),
        }, {});
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="books"]'), {
          title: '<p class="ops-title">Bank statement and journal</p>',
          rows: `<div class="ops-shards">
            ${st.journal.map((e) => `<div class="ops-row"><div class="ops-name">Journal: ${esc(e.kind)}<span>${e.amt < 0 ? '−' : '+'}${usd(Math.abs(e.amt))}</span></div></div>`).join('')}
            ${st.bank.transfers.map((x) => `<div class="ops-row" data-tone="${st.flags.some((f) => f.tx === x.id) ? 'warn' : ''}"><div class="ops-name">Bank: ${esc(x.id)}<span>${usd(x.amt)} to ${esc(x.to)}</span></div></div>`).join('')}
          </div>
          <div class="app-row">${Y.btn('checkin', 'Check in again (restart the clock)', { cls: 'secondary' })}${Y.btn('takeover', 'Someone else changes the account', { cls: 'secondary' })}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };

  function* runJob(ctx, job) {
    const st = ctx.state;
    const cfg = st.config;
    const cl = ctx.must(yield ctx.call('ledger', 'claim', { pid: job.pid, by: job.by }, { timeout: 800 }));
    if (!cl.ok) { ctx.log({ op: `job from scheduler ${job.by}: payout already ${cl.status}`, status: 'dup', detail: 'The claim failed; this worker stops without touching the bank.' }); return; }
    const pr = ctx.must(yield ctx.call('ledger', 'prepare', {}, { timeout: 800 }));
    if (pr.hold) { ctx.ui.lena.message = 'Your payout is on hold because your payout account changed. If that wasn’t you, tell us.'; ctx.log({ op: 'payout held: account changed recently', status: 'err', detail: 'Payouts wait 72 h after an account change unless the host confirms.' }); return; }
    const r = yield ctx.call('bank', 'transfer', { key: cfg.key ? job.pid : null, to: pr.to, amt: pr.amount }, { timeout: 8 * HOUR });
    if (!r.ok) {
      if (r.error.code === 'TIMEOUT') { st.stats.unknown++; yield ctx.call('ledger', 'record', { status: 'unknown' }, { timeout: 800 }); ctx.log({ op: 'bank did not answer: outcome unknown', status: 'err', detail: 'A blind retry could pay twice; the payout waits for reconciliation instead.' }); return; }
      yield ctx.call('ledger', 'record', { status: 'rejected' }, { timeout: 800 });
      ctx.ui.lena.message = 'Your bank rejected the payout. Add a new payout account.';
      return;
    }
    if (ctx.mode('crashAfterAccept', 'worker')) {
      ctx.sim.restore('worker', 'crashAfterAccept');
      ctx.log({ op: `crashed after ${r.value.tx} was accepted`, status: 'err', detail: `The bank made the transfer; the ledger was never told. The claim expires in ${LEASE / HOUR} h and the payout will be retried.` });
      return;
    }
    yield ctx.call('ledger', 'record', { tx: r.value.tx, amt: pr.amount, to: pr.to }, { timeout: 800 });
  }
})(typeof window !== 'undefined' ? window : globalThis);
