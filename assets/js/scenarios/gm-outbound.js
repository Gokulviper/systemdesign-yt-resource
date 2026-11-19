/*
 * Sending to the world: retries, bounces, undo, and schedule.
 * A send commits a Sent row and, with server-side undo, a delay-queue entry
 * due a few seconds later; Undo removes the entry if it has not been
 * dispatched. Scheduled send is the same queue with a later due time, so it
 * does not need the phone. Dispatched copies go to the outbound queue;
 * workers look up the MX, sign with DKIM, take a per-domain slot, and talk
 * SMTP. No answer or a 4xx defers the copy with backoff; a 5xx or the give-up
 * age produces a bounce in Maya’s inbox. A crash after the remote 250 but
 * before the copy is marked sends it again: the one gap a sender cannot close.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const UNDO_MS = 2000; // Gmail offers 5 to 30 s; shortened here
  const SCHEDULE_MS = 3000; // “tomorrow 9:00”, shortened
  const GIVEUP_MS = 3500; // days in practice; shortened
  const DAILY = 20; // Gmail’s consumer limit is 500 a day; scaled down
  const PACE_PAUSE = 1000; // a 421 pauses the whole domain this long
  const SLOW_RATE = 4; // slowmail.net accepts this many messages a second from Gmail
  const BLOCK_AFTER = 12; // refusals within 2 s that make slowmail.net block Gmail
  const BLOCK_MS = 4000;
  const SPAM_MARK = 30; // spam from Gmail after which example.org files all Gmail mail as spam
  const LATE_MS = 2500;
  const DEST = { 'example.org': 'omar', 'slowmail.net': 'slow' };

  const phoneOff = (sim) => !!sim.nodes.maya.modes.down;

  function send(sim, to, opts) {
    opts = opts || {};
    const st = sim.state;
    const n = ++st.seq.send;
    const [user, domain] = to.split('@');
    const subject = opts.subject || (domain === 'slowmail.net' ? 'Book club tonight' : user === 'nobody' ? 'Hello?' : 'Contract signed');
    const local = { n, to, subject, id: null, state: 'sending', t: sim.now, scheduled: !!opts.scheduled, attacker: !!opts.attacker };
    if (!opts.attacker) st.local.push(local);
    sim.startAction(opts.attacker ? `Stolen session: spam to ${to}` : `Maya: ${opts.scheduled ? 'schedule' : 'send'} “${subject}” to ${to}`, function* (ctx) {
      const cfg = ctx.state.config;
      Y.L(ctx, { displayed: ['pending', 'Sending…'], retrySafe: ['yes', 'One Sent row per send; the delay queue holds its id.'] });
      const r = yield ctx.call('api', 'send', { to, user, domain, subject, scheduled: !!opts.scheduled, spam: !!opts.attacker }, { timeout: 1500, quiet: opts.attacker ? 'all' : undefined });
      if (!r.ok) {
        local.state = r.error.code === 'RATE_LIMITED' ? 'limited' : 'failed';
        Y.failed(ctx, r.error.message);
        if (!opts.attacker) ctx.explain(r.error.code === 'RATE_LIMITED' ? 'The account hit its daily sending limit, so the send is refused. The limit exists for exactly this: a stolen session cannot send without bound.' : `The send failed: ${r.error.code}. Nothing was queued.`);
        return;
      }
      local.id = r.value.id;
      local.state = 'sent';
      Y.L(ctx, { displayed: ['yes', opts.scheduled ? 'Scheduled.' : cfg.serverUndo ? `“Sending…” with Undo for ${UNDO_MS / 1000} s.` : '“Sent”, with an Undo button that only hides it.'], accepted: ['yes', `Sent row ${r.value.id}.`], committed: ['yes', r.value.delayed ? `Delay queue entry due in ${SDL.fmtMs(r.value.due - ctx.now())}.` : 'Queued for delivery now.'] });
      if (!opts.attacker) {
        sim.ui.maya.toast = opts.scheduled ? null : { id: r.value.id, until: ctx.now() + UNDO_MS };
        ctx.explain(opts.scheduled ? `Scheduled in the delay queue, due in ${SDL.fmtMs(r.value.due - ctx.now())}. The server sends it; the phone does not need to be on.` : cfg.serverUndo ? `The Sent row and a delay-queue entry due in ${UNDO_MS / 1000} s are committed. Until then Undo can still remove the entry: nothing has left Gmail.` : 'The copy is in the outbound queue already. Undo can hide it on the phone, but it cannot call it back.');
      }
    }, { self: 'maya' });
  }

  function undo(sim) {
    const t = sim.ui.maya.toast;
    if (!t) return;
    sim.ui.maya.toast = null;
    const id = t.id;
    sim.startAction('Maya: undo', function* (ctx) {
      const st = ctx.state;
      if (!st.config.serverUndo) {
        ctx.ui.maya.hidden[id] = true;
        Y.L(ctx, { displayed: ['yes', '“Undone” on the phone.'], accepted: ['n/a', 'Nothing was asked of the server.'], committed: ['n/a', 'Nothing changed.'], async: ['n/a', 'The copy was already handed on.'], retrySafe: ['n/a', 'Read only.'] });
        ctx.explain('The phone hides the message and says “Undone”, but the copy was queued the moment Maya pressed Send. Whatever has been delivered stays delivered.');
        return;
      }
      const r = yield ctx.call('api', 'undo', { id }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.message); ctx.explain('Too late: the delay queue had already dispatched it.'); return; }
      Y.L(ctx, { displayed: ['yes', 'Undone.'], accepted: ['yes', 'Delay-queue entry removed.'], committed: ['yes', 'Sent row marked cancelled.'], async: ['n/a', 'Nothing was dispatched.'], retrySafe: ['yes', 'Cancelling twice is harmless.'] });
      ctx.explain('The delay-queue entry was removed before it was due, so nothing left Gmail. The server, not the phone, decides whether Undo worked.');
    }, { self: 'maya' });
  }

  function attack(sim) {
    sim.ui.console.attacked = true;
    for (let i = 0; i < 60; i++) {
      sim.spawn(function* (ctx) { yield ctx.wait(i * 40); send(ctx.sim, `list${i + 1}@example.org`, { attacker: true, subject: 'Cheap watches' }); }, { self: 'maya', quiet: 'all' });
    }
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'maya', quiet: 'all' });
  const group = (sim) => { for (let i = 1; i <= 12; i++) send(sim, `friend${i}@slowmail.net`); };

  /** Put a copy back on the outbound queue after a delay (the queue’s retry schedule). */
  function requeue(ctx, id, ms, quiet) {
    ctx.spawn(function* (c) {
      yield c.wait(ms);
      c.sim.enqueue('outbound', { type: 'copy', eventId: `${id}@${c.now()}`, payload: { id }, actionId: c.state.sent[id].actionId, quiet });
    }, { self: 'outq', quiet: 'all' });
  }

  function* bounce(ctx, c, reason) {
    c.state = 'bounced';
    c.tDone = ctx.now();
    c.bounceReason = reason;
    ctx.state.stats.bounced++;
    yield ctx.call('bounce', 'dsn', { id: c.id, to: c.to, subject: c.subject, reason }, { timeout: 1000, actionId: c.actionId });
  }

  function* deliverCopy(ctx, id) {
    const st = ctx.state;
    const c = st.sent[id];
    if (!c || c.state !== 'queued') return;
    const q = c.spam ? 'all' : true;
    const cap = st.config.domainCap;
    if (cap) {
      const a = yield ctx.call('limits', 'acquire', { domain: c.domain }, { timeout: 400, quiet: 'all' });
      if (!a.ok || !a.value.slot) { requeue(ctx, id, 100, true); return; }
    }
    const release = (throttled) => { if (cap) ctx.spawn(function* (x) { yield x.call('limits', 'release', { domain: c.domain, throttled }, { timeout: 400, quiet: 'all' }); }, { self: 'workers', quiet: 'all' }); };
    const defer = function* (code, why) {
      release(code === 'TEMPFAIL');
      c.tries++;
      if (code !== 'TEMPFAIL') c.unreachable = true;
      if (!c.spam) st.stats.deferred++;
      if (ctx.now() - c.first >= GIVEUP_MS) { yield* bounce(ctx, c, `No answer from ${c.domain} after ${c.tries} attempts over ${SDL.fmtMs(ctx.now() - c.first)}: giving up.`); return; }
      const wait = st.config.backoff ? Math.min(4000, 500 * 2 ** (c.tries - 1)) + Math.round(ctx.rand() * 200) : 150;
      if (!c.spam) ctx.log({ op: `copy to ${c.to} deferred, retry in ${wait} ms`, status: 'retry', actionId: c.actionId, detail: `${why} ${st.config.backoff ? 'Exponential backoff with jitter.' : 'A fixed, fast retry.'}` });
      requeue(ctx, id, wait, !!c.spam);
    };
    if (c.first == null) c.first = ctx.now();
    const mx = yield ctx.call('dns', 'mx', { domain: c.domain }, { timeout: 500, quiet: q, actionId: c.actionId });
    if (!mx.ok) { yield* defer('UNAVAILABLE', `No MX record for ${c.domain} could be looked up.`); return; }
    const sig = yield ctx.call('dkim', 'sign', { id }, { timeout: 500, quiet: q, actionId: c.actionId });
    if (!sig.ok) { yield* defer('UNAVAILABLE', 'The DKIM signer is down. Sending unsigned would land in spam at the other end, so the copy waits.'); return; }
    const r = yield ctx.call(DEST[c.domain], 'smtp', { id, user: c.user, msgId: c.msgId, subject: c.subject, spam: c.spam }, { timeout: 1000, quiet: c.spam ? 'all' : undefined, actionId: c.actionId });
    if (r.ok) {
      if (ctx.mode('crashAfterHandoff')) {
        ctx.sim.restore('workers', 'crashAfterHandoff');
        st.workerCrashed = true;
        ctx.sim.inject('workers', 'crashed', true, 500);
        ctx.log({ op: 'worker crashed after the remote 250', status: 'fault', actionId: c.actionId, detail: `${c.domain} has the message, but the worker died before marking the copy delivered. The batch will be taken again.` });
        release(false);
        return;
      }
      c.state = 'delivered';
      c.tDone = ctx.now();
      release(false);
      if (!c.spam) ctx.sim.setLedger(c.actionId, 'async', 'yes', `250 from ${c.domain}.`);
      return;
    }
    if (r.error.code === 'REJECTED') { release(false); yield* bounce(ctx, c, r.error.message); return; }
    yield* defer(r.error.code, r.error.code === 'TEMPFAIL' ? `${c.domain} answered ${r.error.message}.` : `${c.domain} did not answer.`);
  }

  SDL.scenarios['gm-outbound'] = {
    id: 'gm-outbound',
    seed: 2609,
    minHopMs: 5,
    productWidth: 640,
    intro: 'Send from Maya’s phone and watch the copy wait out the Undo window in the delay queue, then go out over SMTP. Undo it, schedule it with the phone off, send to an address that does not exist, or to a server that is down or throttling.',
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'Gmail app', kind: 'client', x: 90, y: 100, latency: 1, role: 'Sends, schedules, and undoes. With server-side undo, “Undone” is shown only after the server confirms.', owns: ['Nothing durable'] },
        { id: 'api', label: 'Gmail frontend', sub: 'API', kind: 'gateway', x: 290, y: 100, latency: 3, role: 'Routes send and undo.', ops: [{ name: 'send', desc: 'Send or schedule.' }, { name: 'undo', desc: 'Cancel a send.' }], owns: ['Nothing durable'] },
        { id: 'mail', label: 'Mail service', sub: 'Send, cancel, limits', kind: 'service', x: 500, y: 100, latency: 4, role: `Writes the Sent row and the delay-queue entry. Enforces the daily sending limit (${DAILY} here; 500 a day on consumer Gmail).`, ops: [{ name: 'send', desc: 'Commit a send.' }, { name: 'cancel', desc: 'Undo.' }], owns: ['Sent count per day'] },
        { id: 'store', label: 'Mailbox store', sub: 'Sent rows, bounces', kind: 'db', x: 720, y: 100, latency: 5, role: 'Holds Sent rows and delivers bounce messages to Maya’s inbox.', ops: [{ name: 'insertSent', desc: 'Write a Sent row.' }, { name: 'deliver', desc: 'Put a bounce in the inbox.' }], owns: ['Sent rows', 'Maya’s inbox'] },
        { id: 'delayq', label: 'Delay queue', sub: 'Undo window, schedule', kind: 'queue', x: 500, y: 250, latency: 3, role: 'Holds each send until it is due. A cancel before the due time removes it; at the due time it moves to the outbound queue.', ops: [{ name: 'add', desc: 'Hold until due.' }, { name: 'cancel', desc: 'Remove if not yet due.' }], owns: ['Entries not yet due'] },
        { id: 'outq', label: 'Outbound queue', sub: 'Copies + retry schedule', kind: 'queue', x: 720, y: 250, latency: 3, role: 'Copies ready to send, and deferred copies waiting for their next attempt.', ops: [{ name: 'put', desc: 'Queue now.' }], owns: ['Pending copies'] },
        { id: 'workers', label: 'Outbound MTA', sub: 'Workers', kind: 'worker', x: 720, y: 400, latency: 3, role: 'Take a batch, send each copy, mark it, then acknowledge the batch. No answer or a 4xx defers; a 5xx or the give-up age bounces.', owns: ['Batch in progress'] },
        { id: 'dns', label: 'DNS', sub: 'MX lookup', kind: 'store', x: 500, y: 380, latency: 3, role: 'Finds the receiving servers for a domain.', ops: [{ name: 'mx', desc: 'MX records.' }], owns: ['Cached MX records'] },
        { id: 'dkim', label: 'DKIM signer', sub: 'Signs every copy', kind: 'service', x: 500, y: 500, latency: 2, role: 'Signs outgoing mail with gmail.com’s key so receivers can verify it.', ops: [{ name: 'sign', desc: 'Sign a copy.' }], owns: ['Signing keys'] },
        { id: 'limits', label: 'Pacing', sub: 'Per destination', kind: 'cache', x: 940, y: 400, latency: 1, role: `One connection at a time per destination, and a 421 pauses that destination for ${PACE_PAUSE / 1000} s so Gmail slows down when asked.`, ops: [{ name: 'acquire', desc: 'Take a slot.' }, { name: 'release', desc: 'Give it back.' }], owns: ['In-flight per domain', 'Pause until'] },
        { id: 'omar', label: 'example.org', sub: 'Omar’s server', kind: 'client', x: 940, y: 100, latency: 2, role: `Accepts mail for its users; 550 for unknown ones. It does not dedupe. After ${SPAM_MARK} spam messages from Gmail it files all Gmail mail as spam.`, ops: [{ name: 'smtp', desc: 'Receive.' }], owns: ['Its mailboxes'] },
        { id: 'slow', label: 'slowmail.net', sub: 'Throttles Gmail', kind: 'client', x: 940, y: 250, latency: 2, role: `Accepts ${SLOW_RATE} messages a second from Gmail and answers 421 above that. ${BLOCK_AFTER} refusals within 2 s and it blocks Gmail for ${BLOCK_MS / 1000} s.`, ops: [{ name: 'smtp', desc: 'Receive.' }], owns: ['Its mailboxes'] },
        { id: 'bounce', label: 'Bounce generator', sub: 'Delivery status', kind: 'worker', x: 290, y: 300, latency: 3, role: 'Writes a “couldn’t deliver” message to the sender’s inbox with the reason.', ops: [{ name: 'dsn', desc: 'Write a bounce.' }], owns: ['Nothing durable'] },
      ],
      edges: [
        { from: 'maya', to: 'api', latency: 50, label: 'mobile network' },
        { from: 'api', to: 'mail', latency: 3 },
        { from: 'mail', to: 'store', latency: 3 },
        { from: 'mail', to: 'delayq', latency: 3 },
        { from: 'mail', to: 'outq', latency: 3, via: [[620, 100], [620, 190], [720, 190]] },
        { from: 'delayq', to: 'outq', latency: 3, label: 'due' },
        { from: 'outq', to: 'workers', latency: 3 },
        { from: 'workers', to: 'dns', latency: 3 },
        { from: 'workers', to: 'dkim', latency: 3, via: [[640, 440], [640, 500]] },
        { from: 'workers', to: 'limits', latency: 1 },
        { from: 'workers', to: 'omar', latency: 40, via: [[840, 400], [840, 100]], label: 'SMTP' },
        { from: 'workers', to: 'slow', latency: 40, via: [[860, 400], [860, 250]] },
        { from: 'workers', to: 'bounce', latency: 3, via: [[720, 460], [400, 460], [400, 300]] },
        { from: 'bounce', to: 'store', latency: 3, via: [[290, 30], [720, 30]] },
      ],
      queues: [
        { id: 'outbound', broker: 'outq', label: 'outbound copies', groups: ['workers'] },
      ],
    },
    modeLabels: { throttle: 'Throttling Gmail', crashAfterHandoff: 'Crashes after the next 250', compromised: 'Session stolen' },
    failures: [
      { id: 'dest-down', node: 'omar', mode: 'down', label: 'example.org down', desc: 'No answer. Copies are deferred and retried until the give-up age.' },
      { id: 'dest-throttle', node: 'slow', mode: 'throttle', label: 'slowmail.net throttles (421)', desc: `It already accepts only ${SLOW_RATE} a second; this makes it refuse everything with 421.` },
      { id: 'dest-reject', node: 'omar', mode: 'reject', params: { code: 'REJECTED', message: '550 5.7.1 Message rejected' }, label: 'example.org rejects (550)', desc: 'A permanent refusal: bounce at once, never retry.' },
      { id: 'dkim-down', node: 'dkim', mode: 'down', label: 'DKIM signer down', desc: 'Copies wait rather than go out unsigned.' },
      { id: 'crash-handoff', node: 'workers', mode: 'crashAfterHandoff', label: 'Worker crash after the remote 250', desc: 'The destination has the message; Gmail does not know it, and sends it again.' },
      { id: 'compromised', node: 'maya', mode: 'compromised', label: 'Account compromised', desc: 'Someone with Maya’s session sends 60 spam messages.' },
      { id: 'delayq-slow', node: 'delayq', mode: 'slow', label: 'Delay queue slow', desc: 'Due entries are dispatched late.' },
      { id: 'store-down', node: 'store', mode: 'down', label: 'Mailbox store down', desc: 'Sends fail before anything is queued.' },
      { id: 'dns-down', node: 'dns', mode: 'down', label: 'MX lookup fails', desc: 'No destination can be found; copies are deferred.' },
    ],
    switches: Y.switches([
      ['serverUndo', 'Undo through a server-side delay', `Each send waits ${UNDO_MS / 1000} s in the delay queue; Undo removes it there. Off: send at once and let Undo hide it on the phone.`],
      ['backoff', 'Exponential backoff with jitter', 'Deferred copies wait 0.5 s, 1 s, 2 s, 4 s, plus a random spread. Off: retry every 150 ms.'],
      ['domainCap', 'Per-destination pacing', `One connection at a time per destination, and a 421 pauses that destination for ${PACE_PAUSE / 1000} s. Off: send every copy at once.`],
      ['senderLimit', 'Daily sending limit', `Refuse sends past ${DAILY} a day. Off: no limit.`],
    ]),
    presets: Y.presets({ serverUndo: true, backoff: true, domainCap: true, senderLimit: true }, [
      { id: 'normal', label: 'Send to Omar', desc: `The copy waits ${UNDO_MS / 1000} s in the delay queue (the Undo window), then goes out: MX lookup, DKIM, one SMTP session, 250.`, run: (s) => { send(s, 'omar@example.org'); } },
      { id: 'undo-in-window', label: 'Undo within the window', desc: 'Maya presses Undo after one second. The delay-queue entry is still there, so it is removed and nothing ever leaves Gmail.', run: (s) => { send(s, 'omar@example.org'); later(s, 1000, undo); } },
      { id: 'undo-client-side', label: 'Undo that only hides the message', desc: 'No server-side delay: the copy is queued and delivered at once. Undo hides it on Maya’s phone and says “Undone”, but Omar already has it.', sw: { serverUndo: false }, run: (s) => { send(s, 'omar@example.org'); later(s, 1000, undo); } },
      { id: 'destination-down', label: 'example.org down for 2.5 s', desc: 'No answer, so the copy is deferred: 0.5 s, 1 s, 2 s. It is delivered on the next attempt after the server is back. Late, never dropped.', run: (s) => { s.inject('omar', 'down', true, UNDO_MS + 2500); send(s, 'omar@example.org'); } },
      { id: 'give-up-bounce', label: 'example.org never comes back', desc: `After ${GIVEUP_MS / 1000} s of deferrals (days, in practice) Gmail gives up and writes a bounce to Maya’s inbox with the reason. An honest failure, not a silent one.`, run: (s) => { s.inject('omar', 'down'); send(s, 'omar@example.org'); } },
      { id: 'user-unknown', label: 'Send to nobody@example.org', desc: 'example.org answers 550: no such user. A 5xx is permanent, so there is no retry; the bounce reaches Maya within a second of the attempt.', run: (s) => { send(s, 'nobody@example.org'); } },
      { id: 'throttle-paced', label: 'Twelve friends at slowmail.net, paced', desc: `slowmail.net takes ${SLOW_RATE} a second. One connection at a time and a pause after each 421 keep Gmail just under its limit; all twelve arrive with a few polite deferrals.`, run: (s) => { group(s); } },
      { id: 'throttle-hammer', label: 'Twelve friends, fast retries and no pacing', desc: `Every copy goes at once and every 421 is retried after 150 ms. slowmail.net sees ${BLOCK_AFTER} refusals in two seconds and blocks Gmail for ${BLOCK_MS / 1000} s: every Gmail user’s mail to it waits, and some of Maya’s copies reach the give-up age and bounce.`, sw: { backoff: false, domainCap: false }, run: (s) => { group(s); } },
      { id: 'crash-after-handoff', label: 'Worker crashes after the remote 250', desc: 'example.org has the message, but the worker dies before marking it. The batch is taken again and the copy is sent a second time with the same Message-ID. Gmail’s own inbound would drop it; example.org does not dedupe, so Omar gets two.', run: (s) => { s.inject('workers', 'crashAfterHandoff'); send(s, 'omar@example.org'); } },
      { id: 'compromised-limited', label: 'Stolen session, daily limit on', desc: `Someone with Maya’s session sends 60 spam messages. The daily limit stops them after ${DAILY}, which also blocks Maya’s own message later. A nuisance, but Gmail’s reputation at example.org survives.`, run: (s) => { s.inject('maya', 'compromised'); later(s, 3000, (x) => send(x, 'omar@example.org')); } },
      { id: 'compromised-unlimited', label: 'Stolen session, no limit', desc: `All 60 spam messages go out. After ${SPAM_MARK}, example.org starts filing every message from Gmail as spam, so Maya’s real mail to Omar lands in his spam folder, and so does everyone else’s.`, sw: { senderLimit: false }, run: (s) => { s.inject('maya', 'compromised'); later(s, 3000, (x) => send(x, 'omar@example.org')); } },
      { id: 'scheduled-phone-off', label: 'Schedule for 9:00, then the phone dies', desc: 'The scheduled send is a delay-queue entry on the server. Maya’s phone is off long before it is due; it goes out on time anyway.', run: (s) => { send(s, 'omar@example.org', { scheduled: true }); later(s, 600, (x) => x.inject('maya', 'down')); } },
    ]),
    initialState: () => ({
      config: { serverUndo: true, backoff: true, domainCap: true, senderLimit: true },
      local: [], sent: {}, delayed: [], bounces: [],
      dest: { omar: { box: [], spamFolder: 0, spamFrom: 0, markSpam: false }, slow: { box: [], ok: [], refused: [], blockedUntil: 0, everBlocked: false } },
      pace: {}, sentToday: 0, workerCrashed: false,
      stats: { deferred: 0, bounced: 0, limited: 0 },
      seq: { send: 0, sent: 0 },
    }),
    initialUI: () => ({ maya: { toast: null, hidden: {} }, console: { attacked: false } }),
    actions: {
      send(sim, a) { send(sim, a.to || 'omar@example.org', { scheduled: !!a.scheduled }); },
      group(sim) { group(sim); },
      undo(sim) { undo(sim); },
      attack(sim) { sim.inject('maya', 'compromised'); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        send: function* (ctx, p) { return ctx.must(yield ctx.call('mail', 'send', p, { timeout: 1200, quiet: p.spam ? 'all' : undefined })); },
        undo: function* (ctx, p) { return ctx.must(yield ctx.call('mail', 'cancel', p, { timeout: 1200 })); },
      },
      mail: {
        send: function* (ctx, p) {
          const st = ctx.state;
          const q = p.spam ? 'all' : undefined;
          if (st.config.senderLimit && st.sentToday >= DAILY) { st.stats.limited++; ctx.fail('RATE_LIMITED', `Daily sending limit reached (${DAILY}).`); }
          const row = ctx.must(yield ctx.call('store', 'insertSent', p, { timeout: 800, quiet: q }));
          st.sentToday++;
          const delayed = p.scheduled || st.config.serverUndo;
          const due = ctx.now() + (p.scheduled ? SCHEDULE_MS : UNDO_MS);
          if (delayed) ctx.must(yield ctx.call('delayq', 'add', { id: row.id, due }, { timeout: 800, quiet: q }));
          else ctx.must(yield ctx.call('outq', 'put', { id: row.id }, { timeout: 800, quiet: q }));
          return { id: row.id, delayed, due: delayed ? due : ctx.now() };
        },
        cancel: function* (ctx, p) { return ctx.must(yield ctx.call('delayq', 'cancel', p, { timeout: 800 })); },
      },
      store: {
        insertSent(ctx, p) {
          const st = ctx.state;
          const id = `s${++st.seq.sent}`;
          st.sent[id] = { id, to: p.to, user: p.user, domain: p.domain, subject: p.subject, spam: p.spam, msgId: `<${id}.maya@gmail.com>`, state: 'waiting', t: ctx.now(), due: null, first: null, tries: 0, tDone: null, actionId: ctx.actionId, scheduled: p.scheduled };
          return { id };
        },
        deliver(ctx, p) { ctx.state.bounces.push({ subject: p.subject, reason: p.reason, t: ctx.now(), id: p.id }); return { ok: true }; },
      },
      delayq: {
        add(ctx, p) { const st = ctx.state; st.sent[p.id].due = p.due; st.delayed.push(p.id); return { due: p.due }; },
        cancel(ctx, p) {
          const st = ctx.state;
          const i = st.delayed.indexOf(p.id);
          if (i < 0) ctx.fail('TOO_LATE', 'Already dispatched.');
          st.delayed.splice(i, 1);
          st.sent[p.id].state = 'cancelled';
          return { cancelled: true };
        },
      },
      outq: {
        put(ctx, p) { const c = ctx.state.sent[p.id]; c.state = 'queued'; c.due = ctx.now(); ctx.sim.enqueue('outbound', { type: 'copy', eventId: p.id, payload: p, actionId: c.actionId, quiet: c.spam }); return { queued: true }; },
      },
      dns: { mx(ctx, p) { return { host: `mx.${p.domain}` }; } },
      dkim: { sign() { return { signed: true }; } },
      limits: {
        acquire(ctx, p) {
          const d = (ctx.state.pace[p.domain] = ctx.state.pace[p.domain] || { inflight: 0, pausedUntil: 0 });
          if (d.inflight >= 1 || d.pausedUntil > ctx.now()) return { slot: false };
          d.inflight++;
          return { slot: true };
        },
        release(ctx, p) {
          const d = ctx.state.pace[p.domain];
          d.inflight = Math.max(0, d.inflight - 1);
          if (p.throttled) d.pausedUntil = ctx.now() + PACE_PAUSE;
          return { ok: true };
        },
      },
      omar: {
        smtp(ctx, p) {
          const o = ctx.state.dest.omar;
          if (p.user === 'nobody') ctx.fail('REJECTED', '550 5.1.1 No such user');
          if (p.spam) o.spamFrom++;
          const filed = o.markSpam || p.spam;
          if (filed) o.spamFolder++;
          o.box.push({ id: p.id, msgId: p.msgId, subject: p.subject, spam: !!p.spam, filed, t: ctx.now() });
          if (o.spamFrom >= SPAM_MARK && !o.markSpam) {
            o.markSpam = true;
            ctx.log({ op: 'example.org now files Gmail mail as spam', status: 'err', detail: `${o.spamFrom} spam messages from Gmail’s servers: example.org’s filter lowers Gmail’s reputation, and every Gmail user’s mail to it now goes to spam.` });
          }
          return { code: 250 };
        },
      },
      slow: {
        smtp(ctx, p) {
          const s = ctx.state.dest.slow;
          const now = ctx.now();
          s.ok = s.ok.filter((t) => now - t < 1000);
          s.refused = s.refused.filter((t) => now - t < 2000);
          if (s.blockedUntil > now) ctx.fail('TEMPFAIL', '421 4.7.0 Gmail temporarily blocked');
          if (ctx.mode('throttle') || s.ok.length >= SLOW_RATE) {
            s.refused.push(now);
            if (s.refused.length >= BLOCK_AFTER) {
              s.blockedUntil = now + BLOCK_MS;
              s.everBlocked = true;
              ctx.log({ op: 'slowmail.net blocks Gmail', status: 'err', detail: `${s.refused.length} refused attempts in two seconds: slowmail.net blocks Gmail’s servers for ${BLOCK_MS / 1000} s. Every Gmail user’s mail to it waits.` });
            }
            ctx.fail('TEMPFAIL', '421 4.7.28 Rate limited, slow down');
          }
          s.ok.push(now);
          s.box.push({ id: p.id, subject: p.subject, t: now });
          return { code: 250 };
        },
      },
      bounce: {
        dsn: function* (ctx, p) {
          for (;;) {
            const r = yield ctx.call('store', 'deliver', { id: p.id, subject: `Delivery Status Notification (Failure): ${p.subject}`, reason: p.reason }, { timeout: 800 });
            if (r.ok) return { ok: true };
            yield ctx.wait(300);
          }
        },
      },
    },
    setup(sim) {
      // The delay queue’s dispatcher: due entries move to the outbound queue.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          if (ctx.mode('slow')) yield ctx.wait(1500);
          const st = ctx.state;
          const due = st.delayed.filter((id) => st.sent[id].due <= ctx.now());
          for (const id of due) {
            st.delayed.splice(st.delayed.indexOf(id), 1);
            const c = st.sent[id];
            c.state = 'queued';
            ctx.sim.enqueue('outbound', { type: 'copy', eventId: id, payload: { id }, actionId: c.actionId, quiet: c.spam });
          }
        }
      }, { self: 'delayq', quiet: 'all' });
      // Outbound workers: a batch at a time, acknowledged after every copy is sent and marked.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msgs } = yield ctx.take('outbound', 'workers', 20);
          const procs = msgs.map((m) => ctx.spawn((c) => deliverCopy(c, m.payload.id), { self: 'workers', actionId: m.actionId, quiet: m.quiet ? 'all' : undefined }));
          yield ctx.join(procs);
          if (ctx.state.workerCrashed) { ctx.state.workerCrashed = false; ctx.nack('outbound', 'workers'); continue; }
          ctx.ack('outbound', 'workers');
        }
      }, { self: 'workers' });
    },
    onFailureChange(sim, ch) {
      // A stolen session starts sending as soon as it exists.
      if (ch.node === 'maya' && ch.mode === 'compromised' && ch.active && !sim.ui.console.attacked) attack(sim);
    },
    consistency(sim) {
      const st = sim.state;
      const o = st.dest.omar;
      const lie = st.local.find((x) => x.id && sim.ui.maya.hidden[x.id] && st.sent[x.id].state === 'delivered');
      if (lie) return { key: 'wrong', label: `Maya’s phone says “Undone”, but ${st.sent[lie.id].domain} accepted the message ${SDL.fmtMs(st.sent[lie.id].tDone - st.sent[lie.id].t)} after she pressed Send. Undo without a server-side delay cannot call anything back.` };
      const ids = {};
      for (const m of o.box) ids[m.msgId] = (ids[m.msgId] || 0) + 1;
      const dup = Object.entries(ids).find(([, n]) => n > 1);
      if (dup) return { key: 'wrong', label: `Omar has ${dup[1]} copies of “${o.box.find((m) => m.msgId === dup[0]).subject}”. The worker crashed after example.org’s 250 and before marking the copy, so it was sent again. Both copies carry the same Message-ID; a receiver that dedupes (Gmail’s inbound does) would drop the second, example.org does not.` };
      if (o.markSpam) { const real = o.box.filter((m) => !m.spam && m.filed).length; return { key: 'wrong', label: `A stolen session sent ${o.spamFrom} spam messages through Gmail and example.org now files every Gmail message as spam${real ? `: Maya’s real mail to Omar is in his spam folder` : ''}. Every Gmail user pays for one account’s abuse.` }; }
      const real = Object.values(st.sent).filter((c) => !c.spam);
      const pending = real.filter((c) => c.state === 'waiting' || c.state === 'queued');
      if (pending.length) { const c = pending[0]; return { key: 'stale', label: c.state === 'waiting' ? `“${c.subject}” is in the delay queue, due in ${SDL.fmtMs(Math.max(0, c.due - sim.now))}.` : `${pending.length} cop${pending.length > 1 ? 'ies are' : 'y is'} queued${c.tries ? ` after ${c.tries} deferral${c.tries > 1 ? 's' : ''}` : ''}: not delivered yet, not lost.` }; }
      if (st.dest.slow.everBlocked) { const to = real.filter((c) => c.domain === 'slowmail.net'); const ok = to.filter((c) => c.state === 'delivered').length; return { key: 'stale', label: `slowmail.net blocked Gmail for ${BLOCK_MS / 1000} s after ${BLOCK_AFTER} refused attempts in two seconds. ${ok} of ${to.length} copies got through${ok < to.length ? `; the other ${to.length - ok} hit the give-up age and Maya has bounces for them` : ''}. Fast retries and no pacing hurt every Gmail user sending there, not just Maya.` }; }
      if (st.stats.limited) return { key: 'stale', label: `The daily limit stopped the stolen session after ${DAILY} messages (${st.stats.limited} refused), and it also refuses Maya’s own sends until the account is secured. Gmail’s reputation at example.org is intact (${o.spamFrom} spam, below ${SPAM_MARK}).` };
      const late = real.find((c) => c.state === 'delivered' && c.unreachable && c.tDone - c.due > LATE_MS);
      if (late) return { key: 'stale', label: `“${late.subject}” reached ${late.domain} ${SDL.fmtMs(late.tDone - late.due)} after it was due, after ${late.tries} deferral${late.tries > 1 ? 's' : ''} while the destination was unreachable. Late, never dropped.` };
      if (!real.length) return { key: 'ok', label: 'Send a message to start.' };
      const b = real.find((c) => c.state === 'bounced');
      if (b) return { key: 'ok', label: `“${b.subject}” could not be delivered and Maya has a bounce saying why: ${b.bounceReason}` };
      const cancelled = real.find((c) => c.state === 'cancelled');
      if (cancelled) return { key: 'ok', label: 'Undone on the server: the delay-queue entry was removed before it was due, so nothing left Gmail.' };
      const paced = real.filter((c) => c.domain === 'slowmail.net');
      if (paced.length) return { key: 'ok', label: `All ${paced.length} copies reached slowmail.net within its limit, with ${st.stats.deferred} polite deferrals after 421s. Gmail slowed down when asked and was never blocked.` };
      const sch = real.find((c) => c.scheduled);
      if (sch) return { key: 'ok', label: `The scheduled message went out ${SDL.fmtMs(sch.tDone - sch.due)} after it was due, from the server, while Maya’s phone was off.` };
      return { key: 'ok', label: 'Every copy was sent once, after the Undo window, signed and paced.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const real = Object.values(st.sent).filter((c) => !c.spam);
      const done = real.filter((c) => c.state === 'delivered');
      const last = done.length ? done[done.length - 1] : null;
      const ids = {};
      for (const m of st.dest.omar.box) ids[m.msgId] = (ids[m.msgId] || 0) + 1;
      const dup = Object.values(ids).reduce((a, n) => a + n - 1, 0);
      return [
        { label: 'In the delay queue', value: st.delayed.length },
        { label: 'Outbound queue', value: sim.queueStats('outbound').depth },
        { label: 'Delivered', value: `${done.length} of ${real.length}` },
        { label: 'Due to 250 (last)', value: last ? SDL.fmtMs(last.tDone - last.due) : '–' },
        { label: 'Deferrals', value: st.stats.deferred, tone: st.stats.deferred ? 'warn' : '' },
        { label: 'Bounces', value: st.stats.bounced },
        { label: 'Duplicates at example.org', value: dup, tone: dup ? 'fail' : '' },
        { label: 'Sent today', value: `${st.sentToday}${st.config.senderLimit ? ` of ${DAILY}` : ''}`, tone: st.stats.limited ? 'warn' : '' },
        { label: 'Spam from Gmail at example.org', value: st.dest.omar.spamFrom, tone: st.dest.omar.markSpam ? 'fail' : st.dest.omar.spamFrom ? 'warn' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Send from the phone. With server-side undo the copy waits in the delay queue first. The panel shows what the two destination servers have received.',
          side: '<div data-ref="dest"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const ui = sim.ui.maya;
        const off = phoneOff(sim);
        const label = (c, x) => {
          if (x.state === 'limited') return '✕ Refused: daily limit';
          if (x.state === 'failed') return '✕ Not sent';
          if (!c) return '↑ Sending…';
          if (ui.hidden[c.id]) return '↶ Undone';
          return { waiting: c.scheduled ? '🕘 Scheduled' : '⏳ Sending…', queued: c.tries ? `↻ Deferred (${c.tries})` : '↑ Sending', delivered: '✓ Delivered', bounced: '✕ Bounced', cancelled: '↶ Undone' }[c.state];
        };
        const rows = st.local.slice(-5).reverse().map((x) => { const c = x.id && st.sent[x.id]; return `<div class="app-card"><strong>${esc(x.subject)}</strong><span class="app-sub">to ${esc(x.to)} · ${label(c, x)}</span></div>`; }).join('');
        const toast = ui.toast && sim.now < ui.toast.until && !off ? `<div class="app-card is-ok"><strong>${st.config.serverUndo ? 'Sending…' : 'Sent'}</strong>${Y.btn('undo', `Undo (${Math.ceil((ui.toast.until - sim.now) / 1000)} s)`, { cls: 'secondary' })}</div>` : '';
        const inbox = st.bounces.slice(-2).reverse().map((b) => `<div class="app-card"><strong>Mail Delivery Subsystem</strong><span class="app-sub">${esc(b.subject)}</span></div>`).join('');
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Gmail</p><p class="app-sub">maya@gmail.com · sent today ${st.sentToday}${st.config.senderLimit ? ` of ${DAILY}` : ''}</p></div>`,
          compose: `<div class="app-row">${Y.btn('send', '✉ Send to Omar', { arg: { to: 'omar@example.org' }, disabled: off })}${Y.btn('send', '🕘 Schedule to Omar', { arg: { to: 'omar@example.org', scheduled: true }, cls: 'secondary', disabled: off })}</div><div class="app-row">${Y.btn('send', 'To nobody@example.org', { arg: { to: 'nobody@example.org' }, cls: 'secondary', disabled: off })}</div><div class="app-row">${Y.btn('group', 'To 12 friends at slowmail.net', { cls: 'secondary', disabled: off })}</div>`,
          toast,
          sent: rows ? `<p class="app-sub">Sent</p>${rows}` : '',
          inbox: inbox ? `<p class="app-sub">Inbox</p>${inbox}` : '',
        }, {});
        const o = st.dest.omar;
        const sl = st.dest.slow;
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="dest"]'), {
          title: '<p class="ops-title">Other mail servers</p>',
          rows: `<div class="ops-shards">
            <div class="ops-row" data-tone="${o.markSpam ? 'fail' : sim.nodes.omar.modes.down ? 'warn' : ''}"><div class="ops-name">example.org (Omar)<span>${sim.nodes.omar.modes.down ? 'down · ' : ''}${o.box.filter((m) => !m.spam).length} received · ${o.spamFrom} spam from Gmail${o.markSpam ? ' · files Gmail mail as spam' : ''}</span></div></div>
            <div class="ops-row" data-tone="${sl.blockedUntil > sim.now ? 'fail' : ''}"><div class="ops-name">slowmail.net<span>${sl.box.length} of 12 received · ${SLOW_RATE}/s limit${sl.blockedUntil > sim.now ? ' · blocking Gmail' : sl.everBlocked ? ' · blocked Gmail earlier' : ''}</span></div></div></div>`,
          act: `<div class="app-row">${Y.btn('attack', '⚠ Stolen session: send 60 spam', { cls: 'secondary', disabled: sim.ui.console.attacked })}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
