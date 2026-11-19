/*
 * Receiving mail: the 250, duplicates, and backpressure.
 * Outside servers (Omar at example.org, the Finch News newsletter, a botnet)
 * talk SMTP to Gmail’s MX. The inbound MTA checks the recipient, takes the
 * message, and answers 250: a promise that the sender may now delete its copy.
 * Durable mode answers only after the message is in the replicated spool;
 * memory mode answers from a buffer that a flusher writes later. Delivery
 * workers take batches from the spool, get a spam verdict, and insert into
 * the mailbox, where a unique index on recipient + Message-ID + body hash
 * absorbs the copies that SMTP retries create. Under load the MX answers 421
 * so senders keep their copy and retry, instead of accepting and dropping.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const SENDER_TIMEOUT = 1200; // how long a sender waits for the reply to the final dot
  const SLOW_REPLY_MS = 1500;
  const SHED_MS = 250; // the MX answers 421 when a spool write would wait longer than this
  const COOL_MS = 1000; // once overloaded, keep answering 421 this long (hysteresis)
  const BUFFER_MAX = 100; // memory mode: messages the MTA holds before it starts dropping
  const BUFFER_SOFT = 60; // memory mode with 421 on: refuse above this
  const FLOOD_RATE = 600; // botnet sessions a second
  const USERS = ['maya', 'dev', 'bulk'];
  const WHO = {
    omar: { name: 'Omar', from: 'omar@example.org', subject: 'Contract draft' },
    finch: { name: 'Finch News', from: 'digest@finch.news', subject: 'Weekly digest' },
    botnet: { name: 'Botnet', from: 'victim@example.net', subject: 'You won!' },
  };

  /** A sender’s SMTP client: retry on 4xx, timeouts, and dropped connections; stop on 250 or 5xx. */
  function sendMail(sim, who, opts) {
    opts = opts || {};
    const st = sim.state;
    const n = ++st.seq[who];
    const w = WHO[who];
    const trace = `${who}-${n}`;
    const rcpt = opts.rcpt || 'maya';
    st.msgs[trace] = { trace, who, rcpt, subject: w.subject, got250: false, at250: null, t0: sim.now, spooled: 0, delivered: 0, deferred: 0, tempfailed: 0, rejected: false, legit: who !== 'botnet' };
    sim.startAction(`${w.name}: send “${w.subject}” to ${rcpt === 'nobody' ? 'nobody@gmail.com' : `${rcpt}@gmail.com`}`, function* (ctx) {
      const m = ctx.state.msgs[trace];
      Y.L(ctx, { displayed: ['n/a', 'A mail server, no screen.'], retrySafe: [ctx.state.config.dedupe ? 'yes' : 'no', ctx.state.config.dedupe ? 'Gmail drops a second copy with the same Message-ID and body.' : 'Every copy that reaches the spool is delivered.'] });
      for (let a = 1; a <= 8; a++) {
        const r = yield ctx.call('mx', 'smtp', { trace, from: w.from, rcpt, subject: w.subject, msgId: `<${trace}@${w.from.split('@')[1]}>`, bulk: false }, { timeout: SENDER_TIMEOUT });
        if (r.ok) {
          m.got250 = true; m.at250 = ctx.now();
          log(ctx, who, `250 2.0.0 OK “${w.subject}” after ${SDL.fmtMs(ctx.now() - m.t0)}`);
          Y.L(ctx, { accepted: ['yes', '250: the sender may delete its copy now.'], committed: ctx.state.config.durable ? ['yes', 'In the replicated spool before the 250.'] : ['pending', 'Only in the MTA’s memory.'] });
          ctx.explain(`${w.name}’s server got a 250 and deletes its copy. ${ctx.state.config.durable ? 'The message was already in the replicated spool, so Gmail can lose a machine and still deliver it.' : 'The message is only in one MTA’s memory until the flusher writes it to the spool.'}`);
          return;
        }
        const code = r.error.code;
        if (code === 'REJECTED') {
          m.rejected = true;
          log(ctx, who, `${r.error.message}: not retried`);
          Y.L(ctx, { accepted: ['no', r.error.message], committed: ['n/a', 'Rejected before DATA.'], async: ['n/a', 'Nothing to deliver.'] });
          ctx.explain(`Gmail refused the recipient during the SMTP conversation. The sending server owns the message and the failure, so ${who === 'botnet' ? 'any bounce goes back to whoever really connected, the botnet, not to the forged address.' : 'it tells its own user.'}`);
          return;
        }
        if (m.legit) { m.deferred++; ctx.state.stats.deferredLegit++; if (code === 'TEMPFAIL') m.tempfailed++; }
        const wait = Math.min(3000, 600 * 2 ** (a - 1));
        log(ctx, who, `${code === 'TEMPFAIL' ? r.error.message : code === 'TIMEOUT' ? 'no reply to the final dot' : 'connection reset'}: retry in ${SDL.fmtMs(wait)}`);
        ctx.log({ op: `${w.name} retries in ${wait} ms`, status: 'retry', actionId: ctx.actionId, detail: code === 'TEMPFAIL' ? 'A 4xx means “not now”: the sender keeps its copy and tries again later.' : 'No 250 and no 5xx: the sender cannot tell whether Gmail has the message, so SMTP says try again.' });
        yield ctx.wait(wait);
      }
      Y.failed(ctx, 'The sender gave up.');
    }, { self: who });
  }

  function log(ctx, who, line) {
    const l = ctx.ui.logs[who];
    l.push(`${(ctx.now() / 1000).toFixed(1)} s  ${line}`);
    if (l.length > 3) l.shift();
  }

  function flood(sim, ms) {
    sim.inject('botnet', 'flood', true, ms || 3000);
  }
  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'omar', quiet: 'all' });

  /** Delivery worker: verdict, then the mailbox insert with its unique index. */
  function* deliverOne(ctx, m) {
    const st = ctx.state;
    const p = m.payload;
    const q = p.bulk ? 'all' : undefined;
    let v;
    for (;;) { v = yield ctx.call('verdict', 'score', { from: p.from, bulk: p.bulk }, { timeout: 1500, quiet: q }); if (v.ok) break; yield ctx.wait(200); }
    if (v.value.spam) { st.stats.spamFiled++; return; }
    let r;
    for (;;) { r = yield ctx.call('store', 'deliver', p, { timeout: 1500, quiet: q }); if (r.ok || r.error.code === 'NO_USER') break; yield ctx.wait(200); }
    if (!r.ok) {
      // Accepted for a mailbox that does not exist: the only way to report it now is a bounce to MAIL FROM.
      st.backscatter.push({ to: p.from, trace: p.trace, t: ctx.now() });
      ctx.log({ op: `bounce sent to ${p.from}`, status: 'err', actionId: m.actionId, detail: `There is no ${p.rcpt}@gmail.com, but the message was already accepted. A bounce goes to the MAIL FROM address, ${p.from}, which the botnet forged: an innocent server gets mail about a message it never sent (backscatter).` });
      return;
    }
    if (r.value.dup) ctx.log({ op: `duplicate ${p.msgId} dropped`, status: 'dup', actionId: m.actionId, detail: 'The mailbox already has a message with this Message-ID and body hash: a sender retried after Gmail had already taken it.' });
    else ctx.sim.setLedger(m.actionId, 'async', 'yes', 'In Maya’s inbox.');
    if (ctx.mode('crashAfterWrite')) {
      ctx.sim.restore('workers', 'crashAfterWrite');
      st.workerCrashed = true;
      ctx.sim.inject('workers', 'crashed', true, 500);
      ctx.log({ op: 'delivery worker crashed before ack', status: 'fault', actionId: m.actionId, detail: 'The mailbox write committed, but the worker died before acknowledging the spool. The whole batch will be delivered again.' });
    }
  }

  SDL.scenarios['gm-inbound'] = {
    id: 'gm-inbound',
    seed: 2503,
    minHopMs: 5,
    productWidth: 640,
    intro: 'Send as Omar or Finch News and watch the SMTP conversation: recipient check, DATA, spool, 250. Then crash the MTA, make its final reply slow, flood it from a botnet, or let the botnet send to an address that does not exist.',
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'omar', label: 'Omar’s server', sub: 'example.org', kind: 'client', x: 90, y: 80, latency: 2, role: 'A normal mail server. Retries on 4xx, on a timeout, or on a dropped connection; stops on 250 or 5xx.', owns: ['Its copy, until it gets a 250'] },
        { id: 'finch', label: 'Finch News', sub: 'Newsletter sender', kind: 'client', x: 90, y: 230, latency: 2, role: 'A legitimate bulk sender.', owns: ['Its copy, until it gets a 250'] },
        { id: 'botnet', label: 'Botnet', sub: 'Thousands of IPs', kind: 'client', x: 90, y: 400, latency: 2, role: 'Sends spam and forges the MAIL FROM address. Never retries.', owns: ['Nothing'] },
        { id: 'mx', label: 'MX front', sub: 'Load balancer + 421', kind: 'gateway', x: 300, y: 230, latency: 2, role: `Accepts SMTP connections for gmail.com. With 421 on, it refuses new mail while a spool write would wait more than ${SHED_MS} ms, and for ${COOL_MS / 1000} s after, so senders keep their copy and retry.`, ops: [{ name: 'smtp', desc: 'One SMTP session.' }], owns: ['Nothing durable'] },
        { id: 'mta', label: 'Inbound MTA', sub: 'RCPT, DATA, 250', kind: 'gateway', x: 520, y: 230, latency: 4, role: 'Runs the SMTP conversation. Durable mode: answer 250 only after the spool has the message. Memory mode: answer from a buffer and flush later.', ops: [{ name: 'session', desc: 'RCPT check, DATA, spool, reply.' }], owns: ['Memory buffer (memory mode)'] },
        { id: 'directory', label: 'Recipient directory', sub: 'Does this user exist?', kind: 'cache', x: 520, y: 80, latency: 2, role: 'Answers the RCPT check, so unknown recipients are refused with 550 while the sender is still connected.', ops: [{ name: 'lookup', desc: 'Does the mailbox exist?' }], owns: ['user list'] },
        { id: 'spool', label: 'Spool', sub: 'Replicated, 3 copies', kind: 'queue', x: 760, y: 230, latency: 3, serviceMs: 8, servers: 2, role: 'Durable queue of accepted mail. A write succeeds when 2 of 3 replicas have it. About 250 writes a second.', ops: [{ name: 'append', desc: 'Write to a quorum of replicas.' }], owns: ['Accepted, undelivered mail'] },
        { id: 'workers', label: 'Delivery workers', sub: 'Batches from the spool', kind: 'worker', x: 760, y: 420, latency: 3, role: 'Take up to 40 messages, get a verdict, insert each into its mailbox, then acknowledge the batch. A crash before the ack means the batch is delivered again.', owns: ['Spool offset'] },
        { id: 'verdict', label: 'Spam verdict', sub: 'Score each message', kind: 'service', x: 980, y: 330, latency: 3, role: 'Scores each message. Spam goes to the spam folder; the rest to the inbox.', ops: [{ name: 'score', desc: 'Spam or not.' }], owns: ['Nothing durable'] },
        { id: 'store', label: 'Mailbox store', sub: 'Unique Message-ID index', kind: 'db', x: 980, y: 500, latency: 5, role: 'Inserts a message into a mailbox. With dedupe on, a unique index on recipient + Message-ID + body hash turns a second copy into a no-op, in the same transaction as the insert.', ops: [{ name: 'deliver', desc: 'Insert into a mailbox.' }], owns: ['mailboxes', 'Message-ID index'] },
        { id: 'maya', label: 'Maya’s phone', sub: 'Inbox', kind: 'client', x: 980, y: 80, latency: 1, role: 'Shows Maya’s mailbox.', owns: ['Nothing'] },
      ],
      edges: [
        { from: 'omar', to: 'mx', latency: 30, label: 'SMTP' },
        { from: 'finch', to: 'mx', latency: 30 },
        { from: 'botnet', to: 'mx', latency: 30 },
        { from: 'mx', to: 'mta', latency: 2 },
        { from: 'mta', to: 'directory', latency: 2 },
        { from: 'mta', to: 'spool', latency: 2 },
        { from: 'spool', to: 'workers', latency: 2 },
        { from: 'workers', to: 'verdict', latency: 2, via: [[880, 420], [880, 330]] },
        { from: 'workers', to: 'store', latency: 2, via: [[880, 420], [880, 500]] },
        { from: 'store', to: 'maya', latency: 20, via: [[1080, 500], [1080, 80]] },
      ],
      queues: [
        { id: 'spool', broker: 'spool', label: 'spool', groups: ['workers'] },
      ],
    },
    modeLabels: { crash: 'Crashes in the next session', slowReply: 'Slow reply to the final dot', crashAfterWrite: 'Crashes after the next mailbox write', flood: 'Flooding', replicaDown: 'One replica down' },
    failures: [
      { id: 'mta-crash', node: 'mta', mode: 'crash', label: 'MTA crashes in the next session', desc: 'Durable mode: after spooling, before the 250. Memory mode: after the 250, before the flush.' },
      { id: 'replica-down', node: 'spool', mode: 'replicaDown', label: 'One spool replica down', desc: 'Writes still reach 2 of 3 replicas.' },
      { id: 'spool-down', node: 'spool', mode: 'down', label: 'Spool down', desc: 'Durable mode cannot write, so it answers 451 and senders retry.' },
      { id: 'slow-reply', node: 'mta', mode: 'slowReply', duration: 2000, label: 'Slow final reply (2 s)', desc: 'The 250 comes after the sender has given up waiting. The sender retries a message Gmail already has.' },
      { id: 'worker-crash', node: 'workers', mode: 'crashAfterWrite', label: 'Delivery worker crash after write', desc: 'The mailbox write commits, the batch is not acknowledged, and it is delivered again.' },
      { id: 'store-slow', node: 'store', mode: 'slow', params: { factor: 40 }, label: 'Mailbox store slow', desc: 'Delivery lags; the spool holds the mail meanwhile.' },
      { id: 'verdict-slow', node: 'verdict', mode: 'slow', params: { factor: 60 }, label: 'Spam verdict slow', desc: 'Every message waits longer for its score.' },
      { id: 'flood', node: 'botnet', mode: 'flood', duration: 3000, label: 'Botnet flood (3 s)', desc: `${FLOOD_RATE} sessions a second against a spool that writes about 250.` },
      { id: 'directory-down', node: 'directory', mode: 'down', label: 'Recipient directory down', desc: 'The RCPT check cannot be answered, so the MTA answers 451 and senders retry.' },
    ],
    switches: Y.switches([
      ['durable', 'Answer 250 only after the spool write', 'The 250 waits for 2 of 3 spool replicas. Off: answer from the MTA’s memory and flush later.'],
      ['dedupe', 'Drop duplicate copies (Message-ID + body hash)', 'A unique index in the mailbox store makes a retried copy a no-op. Off: every copy is delivered.'],
      ['tempfail', 'Answer 421 under load', 'Refuse new mail while the spool is backed up, so senders keep it and retry. Off: keep accepting.'],
      ['rcptCheck', 'Reject unknown recipients at RCPT', 'Answer 550 while the sender is connected. Off: accept everything and bounce later.'],
    ]),
    presets: Y.presets({ durable: true, dedupe: true, tempfail: true, rcptCheck: true }, [
      { id: 'normal', label: 'Omar and Finch News send', desc: 'Both messages are checked, spooled to a quorum, answered with 250, scored, and delivered to Maya’s inbox once.', run: (s) => { sendMail(s, 'omar'); later(s, 300, (x) => sendMail(x, 'finch')); } },
      { id: 'memory-250-crash', label: '250 from memory, then the MTA crashes', desc: 'The MTA answers 250 from its buffer and crashes before the flush. Omar’s server deleted its copy when it saw the 250; Gmail never wrote it down. The mail is gone.', sw: { durable: false }, run: (s) => { s.inject('mta', 'crash'); sendMail(s, 'omar'); } },
      { id: 'durable-crash', label: 'Spool first, then the MTA crashes', desc: 'The message is in the spool when the MTA dies, before its 250. Omar’s server sees the connection drop and retries; the second copy is dropped by the Message-ID index. One message in the inbox.', run: (s) => { s.inject('mta', 'crash'); sendMail(s, 'omar'); } },
      { id: 'slow-dot-no-dedupe', label: 'Slow final reply, no dedupe', desc: 'Gmail has the message but its 250 arrives after Omar’s server stopped waiting (RFC 1047’s gap). The server retries, and every copy that reached the spool is delivered: Maya gets the contract more than once.', sw: { dedupe: false }, run: (s) => { s.inject('mta', 'slowReply', true, 2000); sendMail(s, 'omar'); } },
      { id: 'slow-dot-dedupe', label: 'Slow final reply, with dedupe', desc: 'Same slow reply and the same retries. The extra copies have the same Message-ID and body hash, so the mailbox insert is a no-op. One message.', run: (s) => { s.inject('mta', 'slowReply', true, 2000); sendMail(s, 'omar'); } },
      { id: 'worker-crash', label: 'Delivery worker crashes after its write', desc: 'The worker inserts Omar’s message and dies before acknowledging the spool. The batch is delivered again when it restarts; the unique index makes the second insert a no-op.', run: (s) => { s.inject('workers', 'crashAfterWrite'); sendMail(s, 'omar'); } },
      { id: 'flood-421', label: 'Botnet flood, 421 on', desc: `${FLOOD_RATE} spam sessions a second back up the spool. The MX answers 421 to new mail, Omar’s included; his server keeps the message and retries, and gets in when there is room. Late, but nothing lost.`, run: (s) => { flood(s, 3000); later(s, 1000, (x) => sendMail(x, 'omar')); } },
      { id: 'flood-accept-drop', label: 'Botnet flood, accept and drop', desc: 'No 421 and 250 from memory: the MTA keeps saying yes while its buffer overflows, and drops what does not fit. Omar’s message got its 250 and was then thrown away.', sw: { durable: false, tempfail: false }, run: (s) => { flood(s, 3000); later(s, 500, (x) => sendMail(x, 'omar')); } },
      { id: 'backscatter', label: 'Unknown recipient, accepted then bounced', desc: 'The botnet sends to nobody@gmail.com with a forged sender. Without the RCPT check Gmail accepts it, finds no mailbox, and bounces to the forged address: an innocent server gets spam from Gmail.', sw: { rcptCheck: false }, run: (s) => { sendMail(s, 'botnet', { rcpt: 'nobody' }); } },
      { id: 'rcpt-reject', label: 'Unknown recipient, rejected at RCPT', desc: 'Same message. The directory says there is no such user, so Gmail answers 550 during the conversation. The connecting server owns the failure, and nobody else gets a bounce.', run: (s) => { sendMail(s, 'botnet', { rcpt: 'nobody' }); } },
      { id: 'replica-down', label: 'One spool replica down', desc: 'Omar’s message is written to 2 of 3 replicas, which is a quorum, so the 250 is still a safe promise. Delivered normally.', run: (s) => { s.inject('spool', 'replicaDown'); sendMail(s, 'omar'); } },
    ]),
    initialState: () => ({
      config: { durable: true, dedupe: true, tempfail: true, rcptCheck: true },
      msgs: {}, buffer: [], lost: [], backscatter: [],
      box: { maya: [], dev: [], bulk: [] }, ids: { maya: {}, dev: {}, bulk: {} },
      workerCrashed: false, overloadAt: -1e9,
      stats: { deferredLegit: 0, tempfails: 0, rejects: 0, dupDropped: 0, spamFiled: 0, floodSent: 0, floodDropped: 0, bufferPeak: 0 },
      seq: { omar: 0, finch: 0, botnet: 0 },
    }),
    initialUI: () => ({ logs: { omar: [], finch: [], botnet: [] } }),
    actions: {
      send(sim, a) { sendMail(sim, a.who || 'omar', { rcpt: a.rcpt }); },
      flood(sim) { flood(sim, 3000); },
      set: Y.setAction,
    },
    handlers: {
      mx: {
        smtp: function* (ctx, p) {
          const st = ctx.state;
          if (ctx.sim.queueWait('spool') > SHED_MS || st.buffer.length > BUFFER_SOFT) st.overloadAt = ctx.now();
          if (st.config.tempfail && ctx.now() - st.overloadAt < COOL_MS) {
            st.stats.tempfails++;
            ctx.fail('TEMPFAIL', '421 4.7.0 Try again later');
          }
          return ctx.must(yield ctx.call('mta', 'session', p, { timeout: 3000, quiet: p.bulk ? 'all' : undefined }));
        },
      },
      mta: {
        session: function* (ctx, p) {
          const st = ctx.state;
          const q = p.bulk ? 'all' : undefined;
          if (st.config.rcptCheck) {
            const d = yield ctx.call('directory', 'lookup', { rcpt: p.rcpt }, { timeout: 400, quiet: q });
            if (!d.ok) ctx.fail('TEMPFAIL', '451 4.3.0 Recipient check unavailable');
            if (!d.value.exists) { st.stats.rejects++; ctx.fail('REJECTED', '550 5.1.1 No such user'); }
          }
          yield ctx.wait(20); // DATA: the body crosses the network
          const m = st.msgs[p.trace];
          if (!st.config.durable) {
            if (st.buffer.length >= BUFFER_MAX) {
              if (m) { st.lost.push(p.trace); ctx.log({ op: `buffer full: “${p.subject}” dropped after its 250`, status: 'err', actionId: ctx.actionId, detail: `The MTA holds ${BUFFER_MAX} messages in memory and is still saying 250 to everyone. This one does not fit, so it is thrown away; the sender has already been told it was accepted.` }); } else st.stats.floodDropped++;
            } else {
              st.buffer.push(p);
              st.stats.bufferPeak = Math.max(st.stats.bufferPeak, st.buffer.length);
            }
            if (ctx.mode('crash')) {
              ctx.sim.restore('mta', 'crash');
              ctx.spawn(function* (c) {
                yield c.wait(1);
                const gone = c.state.buffer.filter((x) => c.state.msgs[x.trace]);
                for (const x of gone) c.state.lost.push(x.trace);
                c.state.buffer = [];
                c.sim.inject('mta', 'down', true, 600);
                c.log({ op: `MTA crashed: ${gone.length} accepted message${gone.length === 1 ? '' : 's'} lost`, status: 'fault', detail: 'Everything in the MTA’s memory is gone. Each of those senders got a 250 and deleted its own copy.' });
              }, { self: 'mta' });
            }
            return { code: 250 };
          }
          const r = yield ctx.call('spool', 'append', p, { timeout: 1500, quiet: q });
          if (!r.ok) ctx.fail('TEMPFAIL', '451 4.3.0 Could not spool, try again');
          if (ctx.mode('crash')) {
            ctx.sim.restore('mta', 'crash');
            ctx.sim.inject('mta', 'down', true, 600);
            ctx.log({ op: 'MTA crashed before its 250', status: 'fault', actionId: ctx.actionId, detail: 'The message is safe in the spool, but the connection drops before the reply. The sender will try again.' });
            ctx.fail('UNAVAILABLE', 'Connection reset');
          }
          if (ctx.mode('slowReply')) yield ctx.wait(SLOW_REPLY_MS);
          return { code: 250 };
        },
      },
      directory: { lookup(ctx, p) { return { exists: USERS.includes(p.rcpt) }; } },
      spool: {
        append(ctx, p) {
          const st = ctx.state;
          const m = st.msgs[p.trace];
          if (m) m.spooled++;
          ctx.sim.enqueue('spool', { type: 'mail', eventId: `${p.trace}#${m ? m.spooled : 0}`, payload: p, actionId: ctx.actionId, quiet: p.bulk });
          return { replicas: ctx.mode('replicaDown') ? 2 : 3 };
        },
      },
      verdict: { score(ctx, p) { return { spam: !!p.bulk }; } },
      store: {
        deliver(ctx, p) {
          const st = ctx.state;
          if (!st.box[p.rcpt]) ctx.fail('NO_USER', `No mailbox for ${p.rcpt}@gmail.com.`);
          const key = `${p.msgId}|${p.subject}`;
          if (st.config.dedupe && st.ids[p.rcpt][key]) { st.stats.dupDropped++; return { dup: true }; }
          st.ids[p.rcpt][key] = true;
          st.box[p.rcpt].push({ trace: p.trace, from: p.from, subject: p.subject, t: ctx.now() });
          const m = st.msgs[p.trace];
          if (m) { m.delivered++; m.tDone = ctx.now(); }
          return { dup: false };
        },
      },
    },
    setup(sim) {
      // Memory mode: a flusher writes the MTA’s buffer to the spool at the spool’s pace.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(200); // group flush: memory buffers are written out in batches
          const st = ctx.state;
          if (ctx.sim.nodes.mta.modes.down) continue;
          for (const p of st.buffer.splice(0, 50)) ctx.spawn(function* (c) { yield c.call('spool', 'append', p, { timeout: 1500, quiet: 'all' }); }, { self: 'mta', quiet: 'all' });
        }
      }, { self: 'mta', quiet: 'all' });
      // Delivery workers: a batch at a time, acknowledged only after every insert.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msgs } = yield ctx.take('spool', 'workers', 40);
          const procs = msgs.map((m) => ctx.spawn((c) => deliverOne(c, m), { self: 'workers', actionId: m.actionId, quiet: m.payload.bulk ? 'all' : undefined }));
          yield ctx.join(procs);
          if (ctx.state.workerCrashed) { ctx.state.workerCrashed = false; ctx.nack('spool', 'workers'); continue; }
          ctx.ack('spool', 'workers');
        }
      }, { self: 'workers' });
      // The botnet: spam sessions while flooding. It never retries.
      Y.load(sim, 'botnet', (s) => (s.nodes.botnet.modes.flood ? FLOOD_RATE : 0), function* (ctx, i) {
        ctx.state.stats.floodSent++;
        yield ctx.call('mx', 'smtp', { trace: `spam-${i}`, from: 'promo@spam.example', rcpt: 'bulk', subject: 'Cheap pills', msgId: `<spam-${i}@spam.example>`, bulk: true }, { timeout: SENDER_TIMEOUT, quiet: 'all' });
      });
    },
    consistency(sim) {
      const st = sim.state;
      const legit = Object.values(st.msgs).filter((m) => m.legit);
      const lost = legit.find((m) => st.lost.includes(m.trace));
      if (lost) return { key: 'wrong', label: `${WHO[lost.who].name}’s server got a 250 for “${lost.subject}” and deleted its copy, but Gmail ${st.stats.bufferPeak >= BUFFER_MAX ? 'dropped it when its memory buffer overflowed' : 'lost it when the MTA crashed before flushing its memory'}. Nobody has the message any more.` };
      const dup = legit.find((m) => m.delivered > 1);
      if (dup) return { key: 'wrong', label: `Maya has ${dup.delivered} copies of “${dup.subject}”: the sender retried after Gmail had already taken the message, and nothing recognised the copies.` };
      if (st.backscatter.length) return { key: 'wrong', label: `Gmail accepted mail for nobody@gmail.com and then bounced it to ${st.backscatter[0].to}, which never sent it. Bouncing to a forged sender turns Gmail into a source of spam (backscatter).` };
      const pending = legit.filter((m) => !m.rejected && m.delivered === 0);
      if (pending.length) { const m = pending[0]; return { key: 'stale', label: m.got250 ? `“${m.subject}” is accepted and waiting in the spool for a delivery worker.` : `${WHO[m.who].name}’s server still holds “${m.subject}” and is retrying (${m.deferred} deferral${m.deferred === 1 ? '' : 's'} so far). Gmail has promised nothing yet.` }; }
      const late = legit.find((m) => m.tempfailed > 0);
      if (late) return { key: 'stale', label: `“${late.subject}” was refused ${late.tempfailed} time${late.tempfailed > 1 ? 's' : ''} with ${st.stats.tempfails ? '421 while the spool was backed up' : '451 while Gmail could not take it'}, then accepted and delivered ${SDL.fmtMs(late.tDone - late.t0)} after the first attempt. The sender kept its copy the whole time: late, nothing lost.` };
      if (!Object.keys(st.msgs).length) return { key: 'ok', label: 'Send a message to start.' };
      const absorbed = st.stats.dupDropped;
      const rej = Object.values(st.msgs).find((m) => m.rejected);
      return { key: 'ok', label: `Every accepted message is in its mailbox exactly once${absorbed ? ` (${absorbed} retried cop${absorbed > 1 ? 'ies' : 'y'} dropped by the Message-ID index)` : ''}${rej ? '; the unknown recipient was refused with 550 while the sender was still connected' : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const legit = Object.values(st.msgs).filter((m) => m.legit);
      const t250 = legit.filter((m) => m.at250).map((m) => m.at250 - m.t0);
      const dups = legit.reduce((a, m) => a + Math.max(0, m.delivered - 1), 0);
      return [
        { label: 'Time to 250 (last)', value: t250.length ? SDL.fmtMs(t250[t250.length - 1]) : '–' },
        { label: 'Deferred (4xx, timeouts)', value: st.stats.deferredLegit, tone: st.stats.deferredLegit ? 'warn' : '' },
        { label: '421 answers', value: st.stats.tempfails, tone: st.stats.tempfails ? 'warn' : '' },
        { label: 'Rejected (550)', value: st.stats.rejects },
        { label: 'Copies dropped by dedupe', value: st.stats.dupDropped },
        { label: 'Duplicates delivered', value: dups, tone: dups ? 'fail' : '' },
        { label: 'Dropped after 250', value: legit.filter((m) => st.lost.includes(m.trace)).length + st.stats.floodDropped, tone: st.lost.length || st.stats.floodDropped ? 'fail' : '' },
        { label: 'Spool depth', value: sim.queueStats('spool').depth, tone: sim.queueWait('spool') > SHED_MS ? 'warn' : '' },
        { label: 'MTA memory buffer', value: st.config.durable ? 'unused' : `${st.buffer.length} of ${BUFFER_MAX}`, tone: st.buffer.length >= BUFFER_MAX ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Each button opens an SMTP session to gmail.com. The log under each sender is what its server sees. Maya’s inbox shows what was delivered.',
          side: '<div data-ref="senders"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const box = st.box.maya.slice(-6).reverse().map((m) => `<div class="app-card is-ok"><strong>${esc(m.from)}</strong><span class="app-sub">${esc(m.subject)}</span></div>`).join('');
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Inbox · ${st.box.maya.length}</p><p class="app-sub">maya@gmail.com · ${st.stats.spamFiled} spam messages filtered</p></div>`,
          inbox: box || '<p class="app-sub">No mail yet.</p>',
        }, {});
        const c = sim.scenario.consistency(sim);
        const L = sim.ui.logs;
        const row = (who, btns) => `<div class="ops-row"><div class="ops-name">${esc(WHO[who].name)} <span>${esc(WHO[who].from)}</span><span>${L[who].length ? L[who].map(esc).join('<br>') : 'idle'}</span></div></div><div class="app-row">${btns}</div>`;
        const flooding = !!sim.nodes.botnet.modes.flood;
        SDL.ui.paintSections(el.querySelector('[data-ref="senders"]'), {
          title: '<p class="ops-title">The internet</p>',
          rows: `<div class="ops-shards">
            ${row('omar', Y.btn('send', '✉ Omar sends “Contract draft”', { arg: { who: 'omar' } }))}
            ${row('finch', Y.btn('send', 'Finch sends the digest', { arg: { who: 'finch' }, cls: 'secondary' }))}
            ${row('botnet', `${Y.btn('send', 'Send to nobody@gmail.com', { arg: { who: 'botnet', rcpt: 'nobody' }, cls: 'secondary' })}${Y.btn('flood', flooding ? 'Flooding…' : 'Flood for 3 s', { cls: 'secondary', disabled: flooding })}`)}</div>`,
          spool: `<div class="ops-shards"><div class="ops-row" data-tone="${sim.queueWait('spool') > SHED_MS ? 'warn' : ''}"><div class="ops-name">Gmail<span>spool ${sim.queueStats('spool').depth} · ${st.config.durable ? '250 after spool' : `memory buffer ${st.buffer.length}/${BUFFER_MAX}`} · ${st.stats.tempfails} × 421${st.backscatter.length ? ` · ${st.backscatter.length} bounce to a forged sender` : ''}</span></div></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
