/*
 * End-to-end: send, receive, read.
 * Maya sends “Lunch Friday?” to Dev (on Gmail) and Omar (at example.org). The
 * phone sends with a client id; the mail service writes the Sent copy and one
 * outbox row per recipient in the same mailbox transaction; a relay moves the
 * outbox into the outbound queue; delivery workers hand Dev’s copy over
 * locally and Omar’s over SMTP, deferring and retrying when a server does not
 * answer. Omar’s reply comes back through the inbound MTA, waits in the spool
 * for the spam filter, and lands in Maya’s thread. Every mailbox change gets a
 * history id; push sends only a hint and each phone fetches “everything since
 * my cursor”. The search indexer follows the same change log.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const SUBJECTS = ['Lunch Friday?', 'Slides for Monday', 'Train times', 'Birthday plans'];
  const NAMES = { dev: 'Dev', omar: 'Omar' };
  const ADDR = { dev: 'dev@gmail.com', omar: 'omar@example.org', maya: 'maya@gmail.com' };
  const LATE_MS = 2500; // a copy delivered later than this after its commit counts as late
  const POLL_MS = 3000; // with push off, phones poll this often
  const SAFETY_MS = 20000; // with push on, a slow safety poll

  const offline = (sim) => !!sim.nodes.maya.modes.offline;
  const off = (sim, who) => !!sim.nodes[who].modes.down;
  const p99of = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return SDL.percentile(s, 99); };

  function send(sim, to) {
    const st = sim.state;
    const n = ++st.seq.send;
    const subject = SUBJECTS[(n - 1) % SUBJECTS.length];
    const item = { n, cid: `maya-phone-${n}`, to: to.slice(), subject, state: 'sending', t: sim.now, tries: 0, sentId: null };
    st.local.push(item);
    sim.startAction(`Maya: send “${subject}” to ${to.map((x) => NAMES[x]).join(' and ')}`, function* (ctx) {
      const cfg = ctx.state.config;
      Y.L(ctx, { displayed: ['pending', '“Sending…” until the mail service confirms the Sent copy.'], retrySafe: [cfg.idem ? 'yes' : 'no', cfg.idem ? `Client id ${item.cid}: a retried send returns the message it already made.` : 'No client id: a retried send makes a new message.'] });
      for (let a = 1; ; a++) {
        while (offline(ctx.sim)) { item.state = 'offline'; yield ctx.wait(100); }
        item.state = a > 1 ? 'retrying' : 'sending';
        item.tries = a;
        const r = yield ctx.call('api', 'send', { cid: cfg.idem ? item.cid : null, trace: item.cid, to: item.to, subject }, { timeout: 1500 });
        if (r.ok) {
          item.state = 'sent';
          item.sentId = r.value.id;
          Y.L(ctx, { displayed: ['yes', '“Sent”.'], accepted: ['yes', `Message ${r.value.id}.`], committed: ['yes', r.value.existing ? 'Already committed by an earlier attempt.' : 'Sent copy committed.'] });
          ctx.explain(r.value.existing ? `The retry carried client id ${item.cid}, so the mail service returned message ${r.value.id} instead of making another. One message, one copy per recipient.` : `“${subject}” is committed as ${r.value.id}${a > 1 ? ` after ${a} attempts` : ''}. ${cfg.outbox ? 'Its outbox rows committed in the same transaction, so delivery cannot be forgotten.' : 'The queue write happened separately (dual write).'}`);
          return;
        }
        if (a >= 8) { item.state = 'failed'; Y.failed(ctx, `Gave up after ${a} attempts: ${r.error.code}.`); ctx.explain('The phone gave up and kept the message in its outbox. Nothing was promised to anyone.'); return; }
        const wait = Math.min(2000, 300 * 2 ** (a - 1)) + Math.round(ctx.rand() * 100);
        ctx.log({ op: `send retry in ${wait} ms`, status: 'retry', actionId: ctx.actionId, detail: `${r.error.message} The message stays in the phone’s outbox and is sent again${cfg.idem ? ` with the same client id ${item.cid}` : ' with nothing to match it to the first attempt'}.` });
        item.state = 'retrying';
        yield ctx.wait(wait);
      }
    }, { self: 'maya' });
  }

  function omarReply(sim) {
    const st = sim.state;
    const orig = sim.ui.omar.box.filter((m) => !m.replied).pop();
    if (!orig) return;
    orig.replied = true;
    const trace = `omar-${++st.seq.omar}`;
    st.inbound[trace] = { t0: sim.now, t250: null, tDone: null, tries: 0 };
    sim.startAction(`Omar’s server: reply “Re: ${orig.subject}”`, function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'An SMTP server, no screen.'], retrySafe: ['yes', 'SMTP senders retry until they get a 250 or a 5xx.'] });
      const inb = ctx.state.inbound[trace];
      for (let a = 1; a <= 8; a++) {
        inb.tries = a;
        const r = yield ctx.call('mtaIn', 'smtp', { from: ADDR.omar, to: ADDR.maya, subject: `Re: ${orig.subject}`, inReplyTo: orig.msgId, trace }, { timeout: 1500 });
        if (r.ok) {
          inb.t250 = ctx.now();
          smtpLog(ctx, `→ gmail.com: 250 2.0.0 OK (Re: ${orig.subject})`);
          Y.L(ctx, { accepted: ['yes', '250 from Gmail’s inbound MTA.'], committed: ['yes', 'Spooled before the 250.'], async: ['pending', 'Spam filter, then Maya’s inbox.'] });
          return;
        }
        smtpLog(ctx, `→ gmail.com: no answer (${r.error.code}), retrying`);
        yield ctx.wait(400 * a);
      }
      Y.failed(ctx, 'Gmail never answered.');
    }, { self: 'omar' });
  }

  function smtpLog(ctx, line) {
    const log = ctx.ui.omar.log;
    log.push(`${(ctx.now() / 1000).toFixed(1)} s  ${line}`);
    if (log.length > 5) log.shift();
  }

  /** Fetch “everything since my cursor” for one phone. One sync at a time per phone. */
  function* sync(ctx, who, quiet) {
    const u = ctx.ui[who];
    if (u.syncing) { u.again = true; return; }
    u.syncing = true;
    try {
      do {
        u.again = false;
        if (off(ctx.sim, who) || (who === 'maya' && offline(ctx.sim))) break;
        const r = yield ctx.call('api', 'history', { user: who, since: u.cursor }, { timeout: 1200, quiet: quiet ? true : undefined });
        if (!r.ok) break;
        for (const e of r.value.entries) {
          if (e.type === 'added' && !u.msgs[e.msg.id]) { u.msgs[e.msg.id] = Object.assign({}, e.msg); u.order.unshift(e.msg.id); u.seenAt[e.msg.id] = ctx.now(); }
          if (e.type === 'read' && u.msgs[e.msgId]) u.msgs[e.msgId].unread = false;
        }
        if (r.value.entries.some((e) => e.type === 'added')) {
          const m = r.value.entries.filter((e) => e.type === 'added').pop().msg;
          u.banner = { title: m.from, body: m.subject, tone: 'ok', t: ctx.now() };
        }
        u.cursor = r.value.hid;
        u.lastSync = ctx.now();
      } while (u.again);
    } finally { u.syncing = false; }
  }

  function search(sim) {
    sim.startAction('Dev: search “lunch”', function* (ctx) {
      const r = yield ctx.call('api', 'search', { user: 'dev', q: 'lunch' }, { timeout: 1500 });
      if (!r.ok) { ctx.ui.dev.results = null; Y.failed(ctx, `Search failed: ${r.error.code}.`); return; }
      ctx.ui.dev.results = r.value.ids;
      Y.L(ctx, { displayed: ['yes', `${r.value.ids.length} result${r.value.ids.length === 1 ? '' : 's'}.`], committed: ['n/a', 'Read only.'], async: ['n/a', 'Read only.'] });
      ctx.explain(`“lunch” found ${r.value.ids.length} message${r.value.ids.length === 1 ? '' : 's'}. The index follows the same change log as the phones, a little behind, so mail that arrived a moment ago may not be searchable yet.`);
    }, { self: 'dev' });
  }

  function openNewest(sim) {
    const u = sim.ui.dev;
    const id = u.order.find((x) => u.msgs[x].unread);
    if (!id) return;
    u.msgs[id].unread = false; // optimistic: the phone shows it read straight away
    sim.startAction('Dev: open the newest unread message', function* (ctx) {
      const r = yield ctx.call('api', 'markRead', { user: 'dev', id }, { timeout: 1500 });
      if (!r.ok) { ctx.ui.dev.msgs[id].unread = true; Y.failed(ctx, `Mark read failed: ${r.error.code}. The phone shows it unread again.`); return; }
      Y.L(ctx, { displayed: ['yes', 'Read.'], accepted: ['yes', 'Mailbox updated.'], committed: ['yes', 'A “read” history entry.'], async: ['n/a', 'Other devices follow the history.'] });
    }, { self: 'dev' });
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'maya', quiet: 'all' });
  const fresh = (sim) => { for (const w of ['maya', 'dev']) sim.ui[w].lastSync = sim.now; };

  SDL.scenarios['gm-send'] = {
    id: 'gm-send',
    seed: 2401,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Send “Lunch Friday?” from Maya’s phone to Dev and Omar. Dev’s copy is delivered inside Gmail and reaches his phone through a push hint; Omar’s goes over SMTP to example.org. Reply as Omar to see mail come in. Then lose a reply, take a queue down, or switch off push.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'Gmail app', kind: 'client', x: 90, y: 90, latency: 1, role: 'Sends with a client id and keeps the message in its outbox until the mail service confirms. Fetches history when hinted.', ops: [{ name: 'hint', desc: 'Your mailbox changed.' }], owns: ['Outbox of unsent messages', 'History cursor'] },
        { id: 'dev', label: 'Dev’s phone', sub: 'Gmail app', kind: 'client', x: 90, y: 300, latency: 1, role: 'Shows Dev’s inbox. Push only hints that something changed; the phone then asks for every change since its cursor.', ops: [{ name: 'hint', desc: 'Your mailbox changed.' }], owns: ['Its copy of the inbox', 'History cursor'] },
        { id: 'omar', label: 'Omar’s mail server', sub: 'example.org', kind: 'client', x: 90, y: 510, latency: 2, role: 'Somebody else’s SMTP server. Answers 250 when it has the message; retries its own sends until it gets a 250.', ops: [{ name: 'smtp', desc: 'Receive a message over SMTP.' }], owns: ['Omar’s mailbox'] },
        { id: 'api', label: 'Gmail frontend', sub: 'API, auth, routing', kind: 'gateway', x: 300, y: 200, latency: 3, role: 'Authenticates the phones and routes send, history, search, and mark-read calls.', ops: [{ name: 'send', desc: 'Send a message.' }, { name: 'history', desc: 'Changes since a history id.' }, { name: 'search', desc: 'Search my mail.' }], owns: ['Nothing durable'] },
        { id: 'mail', label: 'Mail service', sub: 'Send, deliver, read history', kind: 'service', x: 520, y: 90, latency: 4, role: 'Turns a send into a Sent copy plus one outbox row per recipient. With a client id, a retried send returns the message it already made.', ops: [{ name: 'send', desc: 'Commit a send.' }, { name: 'deliver', desc: 'Put a message in a mailbox.' }], owns: ['Client-id map'] },
        { id: 'store', label: 'Mailbox store', sub: 'Per user: mail + history', kind: 'db', x: 760, y: 90, latency: 6, role: 'Sharded by user. Every write to a mailbox appends a history entry in the same transaction; the outbox rows live here too.', ops: [{ name: 'sendTxn', desc: 'Sent copy + outbox rows, one transaction.' }, { name: 'insertSent', desc: 'Sent copy only.' }, { name: 'deliver', desc: 'Insert into a mailbox.' }, { name: 'history', desc: 'Read changes since an id.' }], owns: ['messages', 'history', 'outbox'] },
        { id: 'outq', label: 'Outbound queue', sub: 'Copies to deliver', kind: 'queue', x: 760, y: 300, latency: 3, role: 'Durable queue of copies to deliver. A relay moves committed outbox rows into it.', ops: [{ name: 'put', desc: 'Append a copy (dual-write path).' }], owns: ['Pending deliveries'] },
        { id: 'workers', label: 'Delivery workers', sub: 'Local or SMTP out', kind: 'worker', x: 520, y: 400, latency: 4, role: 'Delivers Gmail recipients locally and everyone else over SMTP. A copy that gets no 250 is deferred and retried with backoff; it is never dropped.', owns: ['Retry schedule per copy'] },
        { id: 'mtaIn', label: 'Inbound MTA', sub: 'SMTP from the internet', kind: 'gateway', x: 300, y: 510, latency: 10, role: 'Receives SMTP and answers 250 only after the message is in the spool.', ops: [{ name: 'smtp', desc: 'Receive a message.' }], owns: ['The spool'] },
        { id: 'spam', label: 'Spam filter', sub: 'Verdict per message', kind: 'service', x: 520, y: 530, latency: 5, role: 'Takes messages from the spool, classifies them, and delivers. While it is down, accepted mail waits in the spool.', owns: ['Nothing durable'] },
        { id: 'push', label: 'Push', sub: 'Hints to phones', kind: 'service', x: 980, y: 200, latency: 3, role: 'Follows the history log and sends each phone a hint (“your mailbox changed”). Hints are best effort: the history is the truth.', owns: ['Device registrations'] },
        { id: 'search', label: 'Search index', sub: 'Per user', kind: 'worker', x: 980, y: 420, latency: 4, role: 'Follows the history log and indexes each new message. Answers queries for one user’s mailbox.', ops: [{ name: 'query', desc: 'Search one mailbox.' }], owns: ['index[user]'] },
      ],
      edges: [
        { from: 'maya', to: 'api', latency: 50, label: 'mobile network' },
        { from: 'dev', to: 'api', latency: 40 },
        { from: 'api', to: 'mail', latency: 3 },
        { from: 'api', to: 'search', latency: 3, via: [[400, 245], [880, 245], [880, 420]] },
        { from: 'mail', to: 'store', latency: 3 },
        { from: 'mail', to: 'outq', latency: 3, via: [[640, 200], [760, 200]] },
        { from: 'store', to: 'outq', latency: 3, label: 'outbox relay' },
        { from: 'outq', to: 'workers', latency: 3 },
        { from: 'workers', to: 'mail', latency: 3 },
        { from: 'workers', to: 'omar', latency: 40, via: [[400, 400], [400, 470], [180, 470]], label: 'SMTP' },
        { from: 'omar', to: 'mtaIn', latency: 40, label: 'SMTP' },
        { from: 'mtaIn', to: 'spam', latency: 3 },
        { from: 'spam', to: 'mail', latency: 3, via: [[640, 530], [640, 160]] },
        { from: 'store', to: 'push', latency: 3 },
        { from: 'store', to: 'search', latency: 3, via: [[880, 90], [880, 380]] },
        { from: 'push', to: 'maya', latency: 30, via: [[980, 150], [200, 150]] },
        { from: 'push', to: 'dev', latency: 30, via: [[1060, 200], [1060, 580], [200, 580], [200, 330]] },
      ],
      queues: [
        { id: 'outbox', broker: 'store', label: 'outbox', groups: ['outq'] },
        { id: 'outbound', broker: 'outq', label: 'outbound copies', groups: ['workers'] },
        { id: 'spool', broker: 'mtaIn', label: 'inbound spool', groups: ['spam'] },
        { id: 'changes', broker: 'store', label: 'history log', groups: ['push', 'search'] },
      ],
    },
    modeLabels: { offline: 'No signal', loseNextReply: 'Loses the next send reply', dropHints: 'Drops push hints' },
    failures: [
      { id: 'maya-offline', node: 'maya', mode: 'offline', duration: 1500, label: 'Maya’s network drops (1.5 s)', desc: 'The send waits in the phone’s outbox and goes when the signal is back.' },
      { id: 'lose-reply', node: 'mail', mode: 'loseNextReply', label: 'Mail service loses a send reply', desc: 'The message is committed but the reply never reaches the phone, which retries.' },
      { id: 'outq-down', node: 'outq', mode: 'down', label: 'Outbound queue down', desc: 'Copies cannot be queued. With an outbox they wait in the mailbox store; with a dual write the queue write fails.' },
      { id: 'omar-down', node: 'omar', mode: 'down', label: 'Omar’s server down', desc: 'SMTP to example.org gets no answer. The copy is deferred and retried.' },
      { id: 'mtain-slow', node: 'mtaIn', mode: 'slow', params: { factor: 30 }, label: 'Inbound MTA slow', desc: 'Omar’s server waits longer for each 250.' },
      { id: 'spam-down', node: 'spam', mode: 'down', label: 'Spam filter down', desc: 'Inbound mail is accepted and held in the spool until the filter returns.' },
      { id: 'store-down', node: 'store', mode: 'down', label: 'Mailbox store down', desc: 'Sends fail and are retried from the phone; nothing is half-written.' },
      { id: 'hints-lost', node: 'push', mode: 'dropHints', label: 'Push hints lost', desc: 'Phones are not told about changes. They catch up on refresh or on the next poll.' },
      { id: 'index-backlog', node: 'search', mode: 'paused', label: 'Search indexer backlog', desc: 'New mail is in the inbox but not yet searchable.' },
      { id: 'dev-off', node: 'dev', mode: 'down', label: 'Dev’s phone off', desc: 'Hints fail. When it comes back it fetches every change since its cursor.' },
    ],
    switches: Y.switches([
      ['idem', 'Client id on send', 'The phone sends a client id; a retried send returns the message already made. Off: every retry is a new message.'],
      ['outbox', 'Outbox in the same transaction', 'The Sent copy and one outbox row per recipient commit together; a relay moves them to the queue. Off: write Sent, then write the queue separately (a dual write).'],
      ['push', 'Push hints', 'Phones are hinted when their mailbox changes. Off: phones poll every 3 s.'],
    ]),
    presets: Y.presets({ idem: true, outbox: true, push: true }, [
      { id: 'happy-path', label: 'Send to Dev and Omar, Omar replies', desc: 'Dev’s copy is delivered locally and his phone shows it within a fraction of a second; Omar’s goes over SMTP. Omar replies, the reply is spooled, filtered, and threaded under Maya’s message. Dev’s search for “lunch” finds it.', run: (s) => { fresh(s); send(s, ['dev', 'omar']); later(s, 1200, omarReply); later(s, 2500, search); } },
      { id: 'lost-reply-no-key', label: 'Send reply lost, no client id', desc: 'The message commits but the reply is lost. The phone retries with nothing to match on, so the mail service makes a second message: Dev gets “Lunch Friday?” twice.', sw: { idem: false }, run: (s) => { fresh(s); s.inject('mail', 'loseNextReply'); send(s, ['dev']); } },
      { id: 'lost-reply-with-key', label: 'Send reply lost, with a client id', desc: 'Same lost reply. The retry carries the same client id and gets the same message back. Dev gets one copy.', run: (s) => { fresh(s); s.inject('mail', 'loseNextReply'); send(s, ['dev']); } },
      { id: 'dual-write-queue-down', label: 'Outbound queue down, dual write', desc: 'The Sent copy commits, the queue write fails, and the phone retries. The retry finds the Sent copy by its client id and reports success, so Maya sees “Sent” for a message nothing will ever deliver.', sw: { outbox: false }, run: (s) => { fresh(s); s.inject('outq', 'down', true, 1500); send(s, ['omar']); } },
      { id: 'outbox-queue-down', label: 'Outbound queue down, outbox', desc: 'Same outage. The outbox row committed with the Sent copy, so the relay moves it as soon as the queue is back and Omar gets the message.', run: (s) => { fresh(s); s.inject('outq', 'down', true, 1500); send(s, ['omar']); } },
      { id: 'omar-server-down', label: 'Omar’s server down', desc: 'SMTP to example.org gets no answer for 2.5 s. The copy is deferred and retried with backoff, and delivered once the server is back: late, but never lost.', run: (s) => { fresh(s); s.inject('omar', 'down', true, 2500); send(s, ['omar']); } },
      { id: 'push-lost', label: 'Push hints lost', desc: 'Dev’s copy is in his mailbox, but the hint never reaches his phone. Until he refreshes or the safety poll runs, the phone shows an old inbox.', run: (s) => { fresh(s); s.inject('push', 'dropHints'); send(s, ['dev']); } },
      { id: 'dev-offline', label: 'Dev’s phone off, then back', desc: 'The hint fails while the phone is off. When it comes back it asks for every change since its cursor and shows the message. Nothing is lost because the history, not the hint, is the truth.', run: (s) => { fresh(s); s.inject('dev', 'down', true, 2500); send(s, ['dev']); } },
      { id: 'spam-filter-down', label: 'Spam filter down when Omar replies', desc: 'Gmail answers Omar’s server with 250 and holds the reply in the spool. When the filter returns, the reply is delivered: about 3 s late, but accepted mail is never dropped.', run: (s) => { fresh(s); send(s, ['omar']); later(s, 900, (x) => { x.inject('spam', 'down', true, 3000); omarReply(x); }); } },
      { id: 'store-down-at-send', label: 'Mailbox store down at send', desc: 'The send fails and the phone keeps the message in its outbox, retrying with backoff and the same client id. When the store is back it commits once and is delivered.', run: (s) => { fresh(s); s.inject('store', 'down', true, 1200); send(s, ['dev']); } },
      { id: 'index-backlog', label: 'Search indexer behind', desc: 'The message is in Dev’s inbox and on his phone, but his search for “lunch” finds nothing yet: the index follows the change log and is behind.', run: (s) => { fresh(s); s.inject('search', 'paused'); send(s, ['dev']); later(s, 1500, search); } },
    ]),
    initialState: () => ({
      config: { idem: true, outbox: true, push: true },
      local: [],
      sent: {}, byClient: {}, sentByTrace: {},
      boxes: { maya: {}, dev: {} },
      hist: { maya: [], dev: [] },
      index: { maya: {}, dev: {} },
      out: {}, inbound: {}, deliveries: [],
      stats: { deferred: 0, queueFails: 0 },
      seq: { send: 0, msg: 0, omar: 0 },
    }),
    initialUI: () => ({
      maya: { cursor: 0, msgs: {}, order: [], seenAt: {}, lastSync: 0, syncing: false, again: false, banner: null },
      dev: { cursor: 0, msgs: {}, order: [], seenAt: {}, lastSync: 0, syncing: false, again: false, banner: null, results: null },
      omar: { box: [], log: [] },
    }),
    actions: {
      send(sim, a) { send(sim, a.to || ['dev', 'omar']); },
      omarReply(sim) { omarReply(sim); },
      search(sim) { search(sim); },
      open(sim) { openNewest(sim); },
      refresh(sim, a) { sim.spawn((c) => sync(c, a.who || 'dev'), { self: a.who || 'dev' }); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        send: function* (ctx, p) {
          if (offline(ctx.sim)) ctx.fail('OFFLINE', 'The phone lost signal; the request never arrived.');
          return ctx.must(yield ctx.call('mail', 'send', p, { timeout: 1200 }));
        },
        history: function* (ctx, p) { return ctx.must(yield ctx.call('mail', 'history', p, { timeout: 800 })); },
        search: function* (ctx, p) { return ctx.must(yield ctx.call('search', 'query', p, { timeout: 800 })); },
        markRead: function* (ctx, p) { return ctx.must(yield ctx.call('mail', 'markRead', p, { timeout: 800 })); },
      },
      mail: {
        send: function* (ctx, p) {
          const st = ctx.state;
          if (p.cid && st.byClient[p.cid]) {
            ctx.log({ op: `send ${p.cid} again: same message`, status: 'dup', actionId: ctx.actionId, detail: `Client id ${p.cid} already made ${st.byClient[p.cid]}. The retry gets that message back; nothing new is written or queued.` });
            return { id: st.byClient[p.cid], existing: true };
          }
          let r;
          if (st.config.outbox) r = ctx.must(yield ctx.call('store', 'sendTxn', p, { timeout: 800 }));
          else {
            r = ctx.must(yield ctx.call('store', 'insertSent', p, { timeout: 800 }));
            for (const rcpt of p.to) {
              const q = yield ctx.call('outq', 'put', { sentId: r.id, rcpt }, { timeout: 600 });
              if (!q.ok) {
                st.stats.queueFails++;
                ctx.log({ op: `${r.id}: Sent written, queue write failed`, status: 'err', actionId: ctx.actionId, detail: 'A dual write: the Sent copy is already committed in the mailbox store, but the copy for the queue was not written. Nothing links the two.' });
                ctx.fail('UNAVAILABLE', 'The outbound queue did not accept the copy.');
              }
            }
            st.sent[r.id].queued = true;
          }
          if (ctx.mode('loseNextReply')) {
            // Only this reply is lost: the work is committed, the answer arrives after the caller gave up.
            ctx.sim.restore('mail', 'loseNextReply');
            ctx.log({ op: `send reply for ${r.id} lost`, status: 'lost', actionId: ctx.actionId, detail: `Message ${r.id} is committed and queued, but the reply never reaches the phone in time. The phone cannot tell whether the send happened.` });
            yield ctx.wait(3000);
          }
          return r;
        },
        deliver: function* (ctx, p) { return ctx.must(yield ctx.call('store', 'deliver', p, { timeout: 800 })); },
        markRead: function* (ctx, p) { return ctx.must(yield ctx.call('store', 'markRead', p, { timeout: 800 })); },
        history: function* (ctx, p) { return ctx.must(yield ctx.call('store', 'history', p, { timeout: 600 })); },
      },
      store: {
        sendTxn(ctx, p) {
          const row = insertSent(ctx, p, true);
          for (const rcpt of p.to) ctx.sim.enqueue('outbox', { type: 'copy', eventId: `${row.id}:${rcpt}`, payload: { sentId: row.id, rcpt }, actionId: ctx.actionId });
          return { id: row.id };
        },
        insertSent(ctx, p) { return { id: insertSent(ctx, p, false).id }; },
        deliver(ctx, p) {
          const st = ctx.state;
          const id = `m${++st.seq.msg}`;
          let thread = id;
          if (p.inReplyTo) { const orig = Object.values(st.sent).find((x) => x.msgId === p.inReplyTo); if (orig) thread = orig.id; }
          const msg = { id, from: p.fromName, subject: p.subject, unread: true, thread, trace: p.trace };
          st.boxes[p.user][id] = msg;
          st.deliveries.push({ user: p.user, trace: p.trace, at: ctx.now(), latency: ctx.now() - p.since, kind: p.kind });
          addHistory(ctx, p.user, { type: 'added', msg: Object.assign({}, msg) });
          return { id };
        },
        markRead(ctx, p) {
          const m = ctx.state.boxes[p.user][p.id];
          if (!m) ctx.fail('NOT_FOUND', 'No such message.');
          if (m.unread) { m.unread = false; addHistory(ctx, p.user, { type: 'read', msgId: p.id }); }
          return { ok: true };
        },
        history(ctx, p) {
          const h = ctx.state.hist[p.user];
          return { entries: h.slice(p.since), hid: h.length };
        },
      },
      outq: {
        put(ctx, p) { ctx.sim.enqueue('outbound', { type: 'copy', eventId: `${p.sentId}:${p.rcpt}`, payload: p, actionId: ctx.actionId }); return { queued: true }; },
      },
      omar: {
        smtp(ctx, p) {
          ctx.ui.omar.box.push({ subject: p.subject, msgId: p.msgId, trace: p.trace, t: ctx.now() });
          smtpLog(ctx, `← maya@gmail.com: 250 OK (“${p.subject}”)`);
          return { code: 250 };
        },
      },
      mtaIn: {
        smtp(ctx, p) {
          ctx.sim.enqueue('spool', { type: 'inbound', eventId: p.trace, payload: Object.assign({ t250: ctx.now() }, p), actionId: ctx.actionId });
          return { code: 250 };
        },
      },
      search: {
        query(ctx, p) {
          const q = String(p.q).toLowerCase();
          const idx = ctx.state.index[p.user];
          return { ids: Object.keys(idx).filter((id) => idx[id].includes(q)) };
        },
      },
      dev: { hint(ctx) { ctx.spawn((c) => sync(c, 'dev'), { self: 'dev' }); return { ok: true }; } },
      maya: {
        hint(ctx) {
          if (offline(ctx.sim)) ctx.fail('OFFLINE', 'No signal.');
          ctx.spawn((c) => sync(c, 'maya'), { self: 'maya' });
          return { ok: true };
        },
      },
    },
    setup(sim) {
      Y.relay(sim, 'outbox', 'outq', 'outq', 'outbound');
      // Delivery workers: hand each copy to its own retry schedule, so one slow domain never blocks another.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('outbound', 'workers');
          ctx.spawn((c) => deliverCopy(c, msg.payload, msg.actionId), { self: 'workers', actionId: msg.actionId });
          ctx.ack('outbound', 'workers');
        }
      }, { self: 'workers' });
      // Spam filter: classify each spooled message, then deliver. Acked only after the mailbox write.
      Y.consumer(sim, 'spool', 'spam', 'spam', function* (ctx, msg) {
        const p = msg.payload;
        yield ctx.wait(40);
        const r = yield ctx.call('mail', 'deliver', { user: 'maya', fromName: 'Omar', subject: p.subject, inReplyTo: p.inReplyTo, trace: p.trace, since: p.t250, kind: 'inbound' }, { timeout: 800, actionId: msg.actionId });
        if (r.ok) {
          const inb = ctx.state.inbound[p.trace];
          if (inb) inb.tDone = ctx.now();
          ctx.sim.setLedger(msg.actionId, 'async', 'yes', 'In Maya’s inbox.');
        }
        return r.ok;
      });
      // Push: one hint per history entry. Best effort; the history is the truth.
      Y.consumer(sim, 'changes', 'push', 'push', function* (ctx, msg) {
        const who = msg.payload.user;
        if (!ctx.state.config.push) return true;
        if (ctx.mode('dropHints')) { ctx.log({ op: `hint for ${NAMES[who] || 'Maya'} lost`, status: 'lost', actionId: msg.actionId, detail: 'The hint never reaches the phone. The change is safe in the history; the phone just does not know to ask.' }); return true; }
        yield ctx.call(who, 'hint', { hid: msg.payload.hid }, { timeout: 600, actionId: msg.actionId });
        return true;
      });
      // Search indexer: index each added message.
      Y.consumer(sim, 'changes', 'search', 'search', function* (ctx, msg) {
        const e = msg.payload;
        if (e.type !== 'added') return true;
        yield ctx.wait(120);
        ctx.state.index[e.user][e.msgId] = e.subject.toLowerCase();
        return true;
      });
      // Polling: every 3 s with push off, a slow safety poll with push on.
      for (const who of ['maya', 'dev']) {
        sim.spawn(function* (ctx) {
          for (;;) {
            yield ctx.wait(250);
            const u = ctx.ui[who];
            const every = ctx.state.config.push ? SAFETY_MS : POLL_MS;
            if (ctx.now() - u.lastSync >= every && !u.syncing) { u.lastSync = ctx.now(); ctx.spawn((c) => sync(c, who, true), { self: who, quiet: 'all' }); }
          }
        }, { self: who, quiet: 'all' });
      }
    },
    onFailureChange(sim, ch) {
      // A phone that comes back asks for everything since its cursor.
      if (!ch.active && (ch.node === 'dev' || ch.node === 'maya')) sim.spawn((c) => sync(c, ch.node), { self: ch.node });
    },
    consistency(sim) {
      const st = sim.state;
      const ui = sim.ui;
      const seen = {};
      for (const d of st.deliveries) { const k = `${d.user}:${d.trace}`; seen[k] = (seen[k] || 0) + 1; }
      for (const r of ui.omar.box) { const k = `omar:${r.trace}`; seen[k] = (seen[k] || 0) + 1; }
      const dup = Object.entries(seen).find(([, n]) => n > 1);
      if (dup) {
        const [who] = dup[0].split(':');
        const item = st.local.find((x) => dup[0].endsWith(x.cid));
        return { key: 'wrong', label: `${NAMES[who] || 'Maya'} has ${dup[1]} copies of “${item ? item.subject : 'the message'}”: the send was retried with no client id, so the mail service made ${dup[1]} messages. Maya’s Sent folder has ${(st.sentByTrace[item && item.cid] || []).length}.` };
      }
      const orphan = st.local.find((x) => x.state === 'sent' && st.sent[x.sentId] && !st.sent[x.sentId].queued);
      if (orphan) return { key: 'wrong', label: `Maya’s phone shows “${orphan.subject}” as sent, but no outbound copy exists: the Sent copy committed, the separate queue write failed, and the retry found the Sent copy and stopped. Nobody will ever deliver it.` };
      const waiting = st.local.filter((x) => x.state !== 'sent');
      if (waiting.length) return { key: 'stale', label: `Maya’s phone still has ${waiting.length} message${waiting.length > 1 ? 's' : ''} in its outbox (${waiting[0].state === 'failed' ? 'it gave up; the message is kept' : `attempt ${waiting[0].tries}`}). Nothing has been promised yet.` };
      const pendingOut = Object.values(st.out).filter((d) => d.state !== 'delivered');
      const qd = sim.queueStats('outbox').depth + sim.queueStats('outbound').depth;
      if (pendingOut.length || qd) return { key: 'stale', label: `${pendingOut.length + qd} cop${pendingOut.length + qd > 1 ? 'ies are' : 'y is'} waiting to be delivered${st.stats.deferred ? ` after ${st.stats.deferred} deferral${st.stats.deferred > 1 ? 's' : ''}: the receiving server is not answering` : ''}. Queued, not lost.` };
      const sd = sim.queueStats('spool').depth;
      if (sd) return { key: 'stale', label: `Omar’s reply was accepted with a 250 and is held in the spool: the spam filter is down. It is delivered when the filter returns.` };
      for (const who of ['dev', 'maya']) {
        const behind = st.hist[who].length - ui[who].cursor;
        if (behind > 0) return { key: 'stale', label: `${who === 'dev' ? 'Dev' : 'Maya'}’s phone is ${behind} change${behind > 1 ? 's' : ''} behind its mailbox${off(sim, who) ? ': it is off, and will fetch every change since its cursor when it is back.' : st.config.push ? ': the push hint was lost, so it does not know to ask. A refresh or the safety poll catches it up.' : ' until its next poll.'}` };
      }
      for (const who of ['dev', 'maya']) {
        const unidx = Object.values(st.boxes[who]).filter((m) => !st.index[who][m.id]);
        if (unidx.length) return { key: 'stale', label: `“${unidx[0].subject}” is in ${who === 'dev' ? 'Dev' : 'Maya'}’s inbox but not searchable yet: the indexer follows the history log and is behind.` };
      }
      const late = st.deliveries.filter((d) => d.latency > LATE_MS).concat(Object.values(st.out).filter((d) => d.tDone - d.t0 > LATE_MS).map((d) => ({ latency: d.tDone - d.t0, user: d.rcpt, kind: 'smtp' })));
      if (late.length) { const l = late[0]; return { key: 'stale', label: `Every copy arrived once, but ${l.kind === 'inbound' ? 'Omar’s reply reached Maya' : `the copy to ${NAMES[l.user] || l.user} arrived`} ${SDL.fmtMs(l.latency)} after it was committed${l.kind === 'inbound' ? ', after waiting in the spool' : st.stats.deferred ? `, after ${st.stats.deferred} deferral${st.stats.deferred > 1 ? 's' : ''}` : ''}. Late, never lost.` }; }
      if (!st.local.length) return { key: 'ok', label: 'Send a message to start.' };
      return { key: 'ok', label: 'Every message was committed once, delivered once to each recipient, and is on every phone and searchable.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const lat = st.deliveries.filter((d) => d.kind !== 'inbound').map((d) => d.latency).concat(Object.values(st.out).filter((d) => d.tDone).map((d) => d.tDone - d.t0));
      const seen = {};
      for (const d of st.deliveries) seen[`${d.user}:${d.trace}`] = (seen[`${d.user}:${d.trace}`] || 0) + 1;
      for (const r of sim.ui.omar.box) seen[`omar:${r.trace}`] = (seen[`omar:${r.trace}`] || 0) + 1;
      const dupes = Object.values(seen).reduce((a, n) => a + n - 1, 0);
      const behind = ['maya', 'dev'].filter((w) => st.hist[w].length > sim.ui[w].cursor).length;
      const unidx = ['maya', 'dev'].reduce((a, w) => a + Object.keys(st.boxes[w]).filter((id) => !st.index[w][id]).length, 0);
      const qd = sim.queueStats('outbox').depth + sim.queueStats('outbound').depth + Object.values(st.out).filter((d) => d.state !== 'delivered').length;
      return [
        { label: 'Messages sent', value: Object.keys(st.sent).length },
        { label: 'Copies delivered', value: Object.keys(seen).length + dupes },
        { label: 'Duplicates', value: dupes, tone: dupes ? 'fail' : '' },
        { label: 'Commit to mailbox p99', value: lat.length ? SDL.fmtMs(p99of(lat)) : '–', tone: lat.length && p99of(lat) > LATE_MS ? 'warn' : '' },
        { label: 'Deferred (no 250)', value: st.stats.deferred, tone: st.stats.deferred ? 'warn' : '' },
        { label: 'Waiting to deliver', value: qd, tone: qd ? 'warn' : '' },
        { label: 'Spool', value: sim.queueStats('spool').depth, tone: sim.queueStats('spool').depth ? 'warn' : '' },
        { label: 'Phones behind', value: behind, tone: behind ? 'warn' : '' },
        { label: 'Not yet searchable', value: unidx, tone: unidx ? 'warn' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['dev', 'Dev’s phone']], {
          note: 'Send from Maya’s phone. “Sent” means the mail service committed it. Dev’s phone fetches changes when hinted; Omar’s server (below) is outside Gmail and talks SMTP.',
          below: '<div class="ops-console" data-ref="omar"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const badge = { sending: '↑ Sending…', retrying: '↻ Retrying', offline: '⚠ No signal, waiting', sent: '✓ Sent', failed: '✕ Not sent, kept in outbox' };
        const list = (u) => u.order.slice(0, 5).map((id) => {
          const m = u.msgs[id];
          return `<div class="app-card ${m.unread ? 'is-ok' : ''}"><strong>${m.unread ? '● ' : ''}${esc(m.from)}</strong><span class="app-sub">${esc(m.subject)}</span></div>`;
        }).join('');
        // Maya
        const mu = sim.ui.maya;
        const out = st.local.slice(-3).reverse().map((x) => `<div class="app-card"><strong>${esc(x.subject)}</strong><span class="app-sub">to ${x.to.map((t) => NAMES[t]).join(', ')} · ${badge[x.state]}${x.state === 'retrying' ? ` (attempt ${x.tries})` : ''}</span></div>`).join('');
        const dis = !!sim.nodes.maya.modes.down;
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Gmail</p><p class="app-sub">${ADDR.maya}${offline(sim) ? ' · no signal' : ''}</p></div>`,
          compose: `<div class="app-row">${Y.btn('send', '✉ Send to Dev and Omar', { arg: { to: ['dev', 'omar'] }, disabled: dis })}</div><div class="app-row">${Y.btn('send', 'Dev only', { arg: { to: ['dev'] }, cls: 'secondary', disabled: dis })}${Y.btn('send', 'Omar only', { arg: { to: ['omar'] }, cls: 'secondary', disabled: dis })}</div>`,
          out: out ? `<p class="app-sub">Outbox and Sent</p>${out}` : '',
          inbox: `<p class="app-sub">Inbox</p>${list(mu) || '<p class="app-sub">No new mail.</p>'}`,
        }, {}, mu.banner);
        // Dev
        const du = sim.ui.dev;
        const unread = du.order.filter((id) => du.msgs[id].unread).length;
        const res = du.results == null ? '' : `<p class="app-sub">“lunch”: ${du.results.length ? `${du.results.length} result${du.results.length > 1 ? 's' : ''}` : 'no results'}</p>`;
        Y.paint(el, sim, 'dev', {
          head: `<div><p class="app-title">Inbox${unread ? ` · ${unread} unread` : ''}</p><p class="app-sub">${ADDR.dev} · history ${du.cursor}</p></div>`,
          act: `<div class="app-row">${Y.btn('refresh', '↻ Refresh', { arg: { who: 'dev' }, cls: 'secondary', disabled: off(sim, 'dev') })}${Y.btn('open', 'Open newest', { cls: 'secondary', disabled: !unread || off(sim, 'dev') })}${Y.btn('search', 'Search “lunch”', { cls: 'secondary', disabled: off(sim, 'dev') })}</div>`,
          res,
          inbox: list(du) || '<p class="app-sub">No new mail.</p>',
        }, {}, du.banner);
        // Omar's server and the backend
        const om = sim.ui.omar;
        const c = sim.scenario.consistency(sim);
        const qd = sim.queueStats('outbound').depth + sim.queueStats('outbox').depth;
        const pend = Object.values(st.out).filter((d) => d.state !== 'delivered').length;
        SDL.ui.paintSections(el.querySelector('[data-ref="omar"]'), {
          title: `<p class="ops-title">Omar’s mail server · example.org${sim.nodes.omar.modes.down ? ' · down' : ''}</p>`,
          box: `<div class="ops-shards"><div class="ops-row"><div class="ops-name">Received<span>${om.box.length ? om.box.map((m) => esc(m.subject)).join(', ') : 'nothing yet'}</span></div></div>
            <div class="ops-row"><div class="ops-name">SMTP log<span>${om.log.length ? om.log.map(esc).join('<br>') : 'idle'}</span></div></div></div>`,
          act: `<div class="app-row">${Y.btn('omarReply', 'Reply to Maya as Omar', { cls: 'secondary', disabled: !om.box.some((m) => !m.replied) || !!sim.nodes.omar.modes.down })}</div>`,
          rows: `<div class="ops-shards">
            <div class="ops-row" data-tone="${qd || pend ? 'warn' : ''}"><div class="ops-name">Outbound<span>${qd} queued · ${pend} deferred or in flight · ${st.stats.deferred} deferrals</span></div></div>
            <div class="ops-row" data-tone="${sim.queueStats('spool').depth ? 'warn' : ''}"><div class="ops-name">Inbound spool<span>${sim.queueStats('spool').depth} held for the spam filter</span></div></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };

  function insertSent(ctx, p, queued) {
    const st = ctx.state;
    const id = `s${Object.keys(st.sent).length + 1}`;
    st.sent[id] = { id, cid: p.cid, trace: p.trace, to: p.to.slice(), subject: p.subject, t: ctx.now(), queued, actionId: ctx.actionId, msgId: `<${id}.${p.trace}@gmail.com>` };
    if (p.cid) st.byClient[p.cid] = id;
    (st.sentByTrace[p.trace] = st.sentByTrace[p.trace] || []).push(id);
    return st.sent[id];
  }
  function addHistory(ctx, user, e) {
    const h = ctx.state.hist[user];
    const hid = h.length + 1;
    h.push(Object.assign({ hid }, e));
    ctx.sim.enqueue('changes', { type: e.type, eventId: `${user}-h${hid}`, payload: { user, hid, type: e.type, msgId: e.msg ? e.msg.id : e.msgId, subject: e.msg ? e.msg.subject : '' }, actionId: ctx.actionId });
  }

  /** One copy, one retry schedule: local delivery for Gmail users, SMTP for everyone else. */
  function* deliverCopy(ctx, p, actionId) {
    const st = ctx.state;
    const key = `${p.sentId}:${p.rcpt}`;
    const s = st.sent[p.sentId];
    const d = (st.out[key] = st.out[key] || { state: 'queued', tries: 0, t0: s.t, tDone: null, rcpt: p.rcpt });
    for (;;) {
      d.state = 'sending';
      d.tries++;
      const r = p.rcpt === 'omar'
        ? yield ctx.call('omar', 'smtp', { from: ADDR.maya, subject: s.subject, msgId: s.msgId, trace: s.trace }, { timeout: 1000, actionId })
        : yield ctx.call('mail', 'deliver', { user: p.rcpt, fromName: 'Maya', subject: s.subject, trace: s.trace, since: s.t, kind: 'local' }, { timeout: 1000, actionId });
      if (r.ok) {
        d.state = 'delivered';
        d.tDone = ctx.now();
        if (p.rcpt !== 'omar') delete st.out[key]; // local copies are measured by the mailbox write
        if (s.to.every((t) => { const x = st.out[`${p.sentId}:${t}`]; return !x || x.state === 'delivered'; })) ctx.sim.setLedger(s.actionId, 'async', 'yes', 'Every recipient has a copy.');
        return;
      }
      st.stats.deferred++;
      d.state = 'deferred';
      const wait = Math.min(3000, 400 * 2 ** (d.tries - 1)) + Math.round(ctx.rand() * 150);
      ctx.log({ op: `copy to ${NAMES[p.rcpt]} deferred, retry in ${wait} ms`, status: 'retry', actionId, detail: `${r.error.message} No 250 means the copy is still ours to deliver: it stays queued and is tried again with backoff.` });
      yield ctx.wait(wait);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
