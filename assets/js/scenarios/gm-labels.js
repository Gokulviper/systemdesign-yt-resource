/*
 * Threads, labels, and unread counts.
 * A message carries a set of labels (INBOX, UNREAD, …); archiving removes
 * INBOX, reading removes UNREAD. The mailbox service applies label operations
 * (“remove INBOX”) one at a time per mailbox; the alternative is devices
 * writing whole label sets from what they last saw, and the later write wins.
 * The unread badge is a counter: kept in the same transaction as the labels,
 * or updated asynchronously by consuming the history log (where a lost or
 * duplicated event makes it drift until a repair job recounts). The threader
 * joins messages by In-Reply-To / References, so a reply that arrives before
 * its original is joined when the original lands; joining by subject merges
 * strangers. Bulk jobs checkpoint their progress so a crash resumes.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const DEVS = ['phone', 'laptop'];
  const INITIAL = [
    { id: 'm1', from: 'Acme Billing', subject: 'Invoice', conv: 'acme-invoice', msgId: '<inv-77@acme.example>', labels: ['INBOX'] },
    { id: 'm2', from: 'Dev', subject: 'Lunch Friday?', conv: 'lunch', msgId: '<s1@gmail.com>', labels: ['INBOX', 'UNREAD'] },
    { id: 'm3', from: 'Lena', subject: 'Photos from Goa', conv: 'goa', msgId: '<goa@example.net>', labels: ['INBOX', 'UNREAD'] },
  ];
  const FINCH = 12;

  const unreadInbox = (st) => Object.values(st.msgs).filter((m) => m.labels.includes('INBOX') && m.labels.includes('UNREAD')).length;
  const badgeOf = (st) => (st.config.txn ? st.count : st.ctr);
  const has = (m, l) => m.labels.includes(l);

  function initialState() {
    const msgs = {};
    INITIAL.forEach((m, i) => { msgs[m.id] = Object.assign({}, m, { thread: `t${i + 1}`, refs: [], labels: m.labels.slice(), t: 0 }); });
    for (let i = 1; i <= FINCH; i++) msgs[`f${i}`] = { id: `f${i}`, from: 'Finch News', subject: `Digest #${i}`, conv: `finch-${i}`, msgId: `<d${i}@finch.news>`, thread: `tf${i}`, refs: [], labels: ['INBOX'], t: 0 };
    const st = {
      config: { txn: true, headers: true, labelOps: true, checkpoint: true },
      msgs, init: {}, intents: [],
      count: 0, ctr: 0, hidSeq: 0,
      lock: { next: 0, serving: 0 },
      jobs: [], repairs: 0,
      stats: { lostDeltas: 0, rethreaded: 0 },
      seq: { msg: 0, thread: 100, job: 0 },
      dev: {},
    };
    for (const m of Object.values(msgs)) st.init[m.id] = m.labels.slice();
    st.count = st.ctr = unreadInbox(st);
    for (const d of DEVS) st.dev[d] = { msgs: snapshot(st), badge: st.count, hid: 0 };
    return st;
  }
  function snapshot(st) {
    const out = {};
    for (const m of Object.values(st.msgs)) out[m.id] = { id: m.id, from: m.from, subject: m.subject, thread: m.thread, labels: m.labels.slice() };
    return out;
  }

  /** What the labels should be: the starting labels plus every operation a device asked for, in arrival order. */
  function expected(st, id) {
    let l = (st.init[id] || []).slice();
    for (const it of st.intents) if (it.id === id) { l = l.filter((x) => !(it.remove || []).includes(x)); for (const a of it.add || []) if (!l.includes(a)) l.push(a); }
    return l.sort();
  }

  function op(sim, d, kind, id) {
    const st = sim.state;
    const v = st.dev[d];
    if (!id) {
      const list = Object.values(v.msgs).filter((m) => has(m, 'INBOX') && (kind !== 'read' || has(m, 'UNREAD')));
      id = list.length ? list[list.length - 1].id : null;
    }
    if (!id) return;
    const seen = v.msgs[id];
    const remove = kind === 'archive' ? ['INBOX'] : ['UNREAD'];
    sim.startAction(`${d === 'phone' ? 'Phone' : 'Laptop'}: ${kind === 'archive' ? 'archive' : 'mark read'} “${seen.subject}”`, function* (ctx) {
      const cfg = ctx.state.config;
      Y.L(ctx, { displayed: ['pending', 'Updating…'], retrySafe: [cfg.labelOps ? 'yes' : 'no', cfg.labelOps ? `“Remove ${remove[0]}” means the same thing however often it is applied.` : 'A whole label set, computed from what this device last saw.'] });
      const p = cfg.labelOps ? { id, remove } : { id, labels: seen.labels.filter((x) => !remove.includes(x)), remove };
      const r = yield ctx.call('api', 'modify', p, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, `Failed: ${r.error.code}.`); return; }
      Y.L(ctx, { displayed: ['yes', 'Done.'], accepted: ['yes', `History ${r.value.hid}.`], committed: ['yes', cfg.labelOps ? `Labels now ${r.value.labels.join(', ') || 'none'}.` : `Wrote the set {${p.labels.join(', ')}} over whatever was there.`], async: ['pending', cfg.txn ? 'Counter changed in the same write.' : 'Counter follows the history log.'] });
    }, { self: d });
  }

  function arrive(sim, m) {
    sim.startAction(`New mail from ${m.from}: “${m.subject}”`, function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'Arrives on its own.'], retrySafe: ['n/a', 'Covered in the inbound lab.'] });
      const r = yield ctx.call('mbox', 'deliver', m, { timeout: 1500 });
      if (r.ok) Y.L(ctx, { accepted: ['yes', `History ${r.value.hid}.`], committed: ['yes', `Thread ${r.value.thread}.`], async: ['pending', 'Devices and counters follow.'] });
    }, { self: 'api' });
  }
  const omar = { from: 'Omar', subject: 'Contract draft', conv: 'contract', msgId: '<c1@example.org>', refs: [] };
  const omarReply = { from: 'Omar', subject: 'Re: Contract draft', conv: 'contract', msgId: '<c2@example.org>', refs: ['<c1@example.org>'] };
  const rent = { from: 'Landlord', subject: 'Invoice', conv: 'rent-invoice', msgId: '<rent-11@flat.example>', refs: [] };

  function bulk(sim) {
    const st = sim.state;
    const ids = Object.keys(st.msgs).filter((id) => id.startsWith('f') && has(st.msgs[id], 'INBOX'));
    const job = { id: `j${++st.seq.job}`, ids, done: 0, state: 'running', active: false, t: sim.now };
    st.jobs.push(job);
    sim.startAction(`Laptop: archive all ${ids.length} from Finch News`, function* (ctx) {
      Y.L(ctx, { displayed: ['yes', '“Archiving 12 conversations…”'], accepted: ['yes', `Job ${job.id}.`], committed: [ctx.state.config.checkpoint ? 'yes' : 'pending', ctx.state.config.checkpoint ? 'The job and its progress are stored.' : 'The job lives in one worker’s memory.'], retrySafe: ['yes', 'Archiving twice is harmless.'] });
      ctx.spawn((c) => runJob(c, job.id), { self: 'jobs' });
    }, { self: 'laptop' });
  }
  function* runJob(ctx, jid) {
    const st = ctx.state;
    const job = st.jobs.find((j) => j.id === jid);
    if (job.active || job.state !== 'running') return;
    job.active = true;
    let done = job.done; // with checkpoints, start from the stored progress
    let batches = 0;
    while (done < job.ids.length) {
      if (ctx.sim.nodes.jobs.modes.crashed) { job.active = false; return; }
      const ids = job.ids.slice(done, done + 3);
      const r = yield ctx.call('mbox', 'modifyMany', { ids, remove: ['INBOX'] }, { timeout: 1500, actionId: null });
      if (!r.ok) { yield ctx.wait(300); continue; }
      done += ids.length; batches++;
      if (st.config.checkpoint) job.done = done;
      if (ctx.mode('crashMidway') && batches === 2) {
        ctx.sim.restore('jobs', 'crashMidway');
        ctx.sim.inject('jobs', 'crashed', true, 600);
        job.active = false;
        if (!st.config.checkpoint) { job.state = 'lost'; job.done = done; }
        ctx.log({ op: `bulk job ${jid} crashed after ${done} of ${job.ids.length}`, status: 'fault', detail: st.config.checkpoint ? `Progress (${done}) is stored with the job, so the next worker resumes from there.` : 'Its progress was only in memory. Nobody knows the job exists any more.' });
        return;
      }
      yield ctx.wait(150);
    }
    job.done = done; job.state = 'done'; job.active = false; job.tDone = ctx.now();
  }

  function repair(sim) {
    sim.startAction('Counter repair: recount the inbox', function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'Background job.'], retrySafe: ['yes', 'A recount is idempotent.'] });
      const r = yield ctx.call('repair', 'run', {}, { timeout: 1500 });
      if (r.ok) Y.L(ctx, { accepted: ['yes', `Counted ${r.value.n}.`], committed: ['yes', `Counter set to ${r.value.n} (was ${r.value.was}).`], async: ['n/a', '—'] });
    }, { self: 'repair' });
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'api', quiet: 'all' });

  SDL.scenarios['gm-labels'] = {
    id: 'gm-labels',
    seed: 2819,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Read and archive on the phone and laptop and watch the unread badge, the labels, and the threads. Then lose a counter update, let a reply arrive before its original, race two devices on one message, or crash a bulk archive.',
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'phone', label: 'Maya’s phone', sub: 'Gmail app', kind: 'client', x: 90, y: 110, latency: 1, role: 'Shows the inbox and the unread badge. Sends label operations, or whole label sets when operations are off.', owns: ['Its copy of the mailbox'] },
        { id: 'laptop', label: 'Maya’s laptop', sub: 'Web', kind: 'client', x: 90, y: 360, latency: 1, role: 'Same as the phone; can also start a bulk archive.', owns: ['Its copy of the mailbox'] },
        { id: 'api', label: 'Gmail API', sub: 'Frontend', kind: 'gateway', x: 290, y: 230, latency: 3, role: 'messages.modify, batchModify, list.', ops: [{ name: 'modify', desc: 'Change labels.' }, { name: 'snapshot', desc: 'Messages and the badge.' }], owns: ['Nothing durable'] },
        { id: 'mbox', label: 'Mailbox service', sub: 'One writer per mailbox', kind: 'service', x: 500, y: 230, latency: 3, role: 'With label operations, takes the mailbox’s turn, reads the current labels, applies “add/remove”, and writes. Without them, writes whatever set the device sent.', ops: [{ name: 'modify', desc: 'Apply a label change.' }, { name: 'deliver', desc: 'Insert a message.' }, { name: 'modifyMany', desc: 'A batch for bulk jobs.' }], owns: ['Per-mailbox turn'] },
        { id: 'msgs', label: 'Messages + labels', sub: 'Per user', kind: 'db', x: 740, y: 110, latency: 4, role: 'Messages, their labels and threads. With counters in the transaction, the unread count changes in the same write as the labels.', ops: [{ name: 'get', desc: 'Read a message.' }, { name: 'put', desc: 'Write labels.' }], owns: ['messages', 'labels', 'threads', 'count (in-transaction mode)'] },
        { id: 'threader', label: 'Threader', sub: 'References, then subject', kind: 'service', x: 500, y: 450, latency: 3, role: 'Puts a new message in a conversation by its In-Reply-To and References headers, and re-threads a reply when its original arrives later. Subject-only mode joins anything with the same subject.', ops: [{ name: 'thread', desc: 'Which conversation?' }], owns: ['Message-ID index'] },
        { id: 'counters', label: 'Label counters', sub: 'Async mode', kind: 'cache', x: 740, y: 330, latency: 1, role: 'In async mode, adds each event’s delta to the unread count. A lost or doubled event makes it drift.', ops: [{ name: 'get', desc: 'Unread count.' }], owns: ['unread[INBOX] (async mode)'] },
        { id: 'log', label: 'History log', sub: 'Change events', kind: 'queue', x: 960, y: 230, latency: 2, role: 'Every write appends an event with its history id and the unread delta. Devices and (in async mode) the counter follow it.', owns: ['events'] },
        { id: 'jobs', label: 'Bulk jobs', sub: 'batchModify workers', kind: 'worker', x: 740, y: 510, latency: 2, role: 'Archive thousands of messages three at a time. With checkpoints, progress is stored with the job and a crash resumes.', owns: ['Job progress'] },
        { id: 'repair', label: 'Counter repair', sub: 'Recount', kind: 'worker', x: 960, y: 430, latency: 2, role: 'Recounts unread messages from the labels and resets the counter. Fixes drift after the fact; does not prevent it.', ops: [{ name: 'run', desc: 'Recount.' }], owns: ['Nothing'] },
      ],
      edges: [
        { from: 'phone', to: 'api', latency: 40, label: 'mobile network' },
        { from: 'laptop', to: 'api', latency: 15 },
        { from: 'api', to: 'mbox', latency: 3 },
        { from: 'mbox', to: 'msgs', latency: 2, via: [[620, 230], [620, 110]] },
        { from: 'mbox', to: 'threader', latency: 2 },
        { from: 'mbox', to: 'counters', latency: 2, via: [[620, 230], [620, 330]] },
        { from: 'msgs', to: 'log', latency: 2, via: [[960, 110]] },
        { from: 'log', to: 'counters', latency: 2, via: [[860, 230], [860, 330]] },
        { from: 'log', to: 'phone', latency: 30, via: [[1060, 230], [1060, 40], [90, 40]] },
        { from: 'log', to: 'laptop', latency: 20, via: [[1060, 230], [1060, 580], [200, 580], [200, 360]] },
        { from: 'jobs', to: 'mbox', latency: 2, via: [[620, 510], [620, 300], [560, 300]] },
        { from: 'repair', to: 'msgs', latency: 2, via: [[1020, 430], [1020, 150], [830, 150]] },
        { from: 'repair', to: 'counters', latency: 2 },
      ],
      queues: [{ id: 'log', broker: 'log', label: 'history', groups: ['counters', 'phone', 'laptop'] }],
    },
    modeLabels: { loseNext: 'Loses the next update', crashMidway: 'Crashes mid-job' },
    failures: [
      { id: 'counter-lost', node: 'counters', mode: 'loseNext', label: 'Counter update lost', desc: 'The next delta never reaches the counter (async mode only).' },
      { id: 'mbox-slow', node: 'mbox', mode: 'slow', params: { factor: 30 }, label: 'Mailbox service slow', desc: 'Label changes take longer; with full-set writes the race window widens.' },
      { id: 'laptop-off', node: 'laptop', mode: 'down', label: 'Laptop closed', desc: 'It stops following the history and catches up when opened.' },
      { id: 'log-lag', node: 'phone', mode: 'paused', label: 'History log lag (phone)', desc: 'The phone stops applying events for a while.' },
      { id: 'bulk-crash', node: 'jobs', mode: 'crashMidway', label: 'Bulk job crash', desc: 'The worker dies after its second batch.' },
      { id: 'counters-down', node: 'counters', mode: 'down', label: 'Counter store down', desc: 'In async mode the badge cannot be read or updated; events wait.' },
      { id: 'dup-event', node: 'log', mode: 'duplicate', label: 'Duplicate change event', desc: 'Every event is appended twice.' },
      { id: 'threader-slow', node: 'threader', mode: 'slow', params: { factor: 40 }, label: 'Threader slow', desc: 'New mail takes longer to land.' },
    ],
    switches: Y.switches([
      ['txn', 'Counters in the same transaction', 'The unread count changes in the same write as the labels. Off: a counter service adds deltas from the history log.', (s) => { s.state.count = s.state.ctr = unreadInbox(s.state); }],
      ['headers', 'Thread by References headers', 'Join a reply to its original by Message-ID. Off: join anything with the same subject.'],
      ['labelOps', 'Label operations, one writer per mailbox', 'Devices send “remove INBOX”; the mailbox applies them in turn. Off: devices write whole label sets from what they saw.'],
      ['checkpoint', 'Checkpoint bulk jobs', 'Store progress with the job so a crash resumes. Off: progress lives in one worker’s memory.'],
    ]),
    presets: Y.presets({ txn: true, headers: true, labelOps: true, checkpoint: true }, [
      { id: 'normal', label: 'New mail, read it, reply arrives', desc: 'Omar’s message lands unread and the badge goes up on both devices; Maya reads it on the phone and the badge goes down; his follow-up joins the same conversation.', run: (s) => { arrive(s, omar); later(s, 600, (x) => op(x, 'phone', 'read', 'm4')); later(s, 1200, (x) => arrive(x, omarReply)); } },
      { id: 'async-counter-lost', label: 'Async counter, an update lost', desc: 'The counter follows the history log and one delta never arrives. Omar’s message is unread in the list, but the badge does not count it, and nothing will notice until a repair job recounts.', sw: { txn: false }, run: (s) => { s.inject('counters', 'loseNext'); arrive(s, omar); } },
      { id: 'txn-counter', label: 'Counter in the transaction', desc: 'Same lost update. The count lives with the labels and changes in the same write, so there is no separate update to lose.', run: (s) => { s.inject('counters', 'loseNext'); arrive(s, omar); } },
      { id: 'reply-before-original', label: 'Reply arrives before its original', desc: 'Omar’s “Re: Contract draft” lands first and starts its own conversation. When the original arrives, the threader sees that the reply references it and joins them: one conversation.', run: (s) => { arrive(s, omarReply); later(s, 500, (x) => arrive(x, omar)); } },
      { id: 'subject-only', label: 'Two strangers called “Invoice”', desc: 'The landlord sends “Invoice”. Threading by subject joins it to Acme’s “Invoice”, so two unrelated senders share one conversation, and replying would answer both.', sw: { headers: false }, run: (s) => { arrive(s, rent); } },
      { id: 'full-set-race', label: 'Archive and mark read at once, whole label sets', desc: 'The phone archives Lena’s message while the laptop marks it read. Each writes the whole set it computed from the same old view; the laptop’s write lands last and puts INBOX back. The archive is lost.', sw: { labelOps: false }, run: (s) => { op(s, 'phone', 'archive', 'm3'); later(s, 60, (x) => op(x, 'laptop', 'read', 'm3')); } },
      { id: 'label-ops', label: 'Archive and mark read at once, label operations', desc: 'Same race. The phone sends “remove INBOX”, the laptop “remove UNREAD”; the mailbox applies them in turn and both hold: archived and read.', run: (s) => { op(s, 'phone', 'archive', 'm3'); later(s, 60, (x) => op(x, 'laptop', 'read', 'm3')); } },
      { id: 'bulk-crash-no-checkpoint', label: 'Bulk archive crashes, no checkpoint', desc: 'The worker archives 6 of 12 Finch digests and dies. Its progress was only in memory, so nothing resumes: half the digests stay in the inbox and Maya thinks the job ran.', sw: { checkpoint: false }, run: (s) => { s.inject('jobs', 'crashMidway'); bulk(s); } },
      { id: 'bulk-checkpoint', label: 'Bulk archive crashes, checkpointed', desc: 'Same crash. Progress is stored with the job, so when a worker is back it resumes from 6 and finishes all 12.', run: (s) => { s.inject('jobs', 'crashMidway'); bulk(s); } },
      { id: 'duplicate-event-async', label: 'Duplicate event, async counter', desc: 'Each event is appended twice and the counter adds every delta it sees: one new message, badge +2.', sw: { txn: false }, run: (s) => { s.inject('log', 'duplicate'); arrive(s, omar); } },
      { id: 'laptop-closed', label: 'Laptop closed while Maya reads on the phone', desc: 'The laptop misses the events while closed and applies them when it is opened. Its badge and list match the phone.', run: (s) => { s.inject('laptop', 'down', true, 2000); arrive(s, omar); later(s, 600, (x) => op(x, 'phone', 'read', 'm4')); } },
    ]),
    initialState,
    initialUI: () => ({}),
    actions: {
      read(sim, a) { op(sim, a.dev || 'phone', 'read'); },
      archive(sim, a) { op(sim, a.dev || 'phone', 'archive'); },
      bulk(sim) { bulk(sim); },
      arrive(sim, a) { arrive(sim, a.which === 'reply' ? omarReply : a.which === 'rent' ? rent : omar); },
      repair(sim) { repair(sim); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        modify: function* (ctx, p) { return ctx.must(yield ctx.call('mbox', 'modify', p, { timeout: 1200 })); },
        snapshot: function* (ctx) {
          const st = ctx.state;
          const r = ctx.must(yield ctx.call('msgs', 'list', {}, { timeout: 800, quiet: true }));
          let badge = st.count;
          if (!st.config.txn) { const c = yield ctx.call('counters', 'get', {}, { timeout: 400, quiet: true }); badge = c.ok ? c.value.n : null; }
          return { msgs: r.msgs, hid: r.hid, badge };
        },
      },
      mbox: {
        modify: function* (ctx, p) {
          const st = ctx.state;
          st.intents.push({ id: p.id, remove: p.remove, add: p.add });
          if (!st.config.labelOps) return ctx.must(yield ctx.call('msgs', 'put', { id: p.id, labels: p.labels }, { timeout: 800 }));
          // One writer per mailbox: take a ticket and wait for our turn.
          const my = st.lock.next++;
          while (st.lock.serving !== my) yield ctx.wait(2);
          try {
            const cur = ctx.must(yield ctx.call('msgs', 'get', { id: p.id }, { timeout: 800, quiet: true }));
            let labels = cur.labels.filter((x) => !(p.remove || []).includes(x));
            for (const a of p.add || []) if (!labels.includes(a)) labels.push(a);
            return ctx.must(yield ctx.call('msgs', 'put', { id: p.id, labels }, { timeout: 800 }));
          } finally { st.lock.serving++; }
        },
        modifyMany: function* (ctx, p) {
          const st = ctx.state;
          for (const id of p.ids) st.intents.push({ id, remove: p.remove });
          const my = st.lock.next++;
          while (st.lock.serving !== my) yield ctx.wait(2);
          try {
            let hid = 0;
            for (const id of p.ids) {
              const cur = ctx.must(yield ctx.call('msgs', 'get', { id }, { timeout: 800, quiet: 'all' }));
              hid = ctx.must(yield ctx.call('msgs', 'put', { id, labels: cur.labels.filter((x) => !p.remove.includes(x)) }, { timeout: 800, quiet: 'all' })).hid;
            }
            return { hid };
          } finally { st.lock.serving++; }
        },
        deliver: function* (ctx, p) {
          const t = ctx.must(yield ctx.call('threader', 'thread', p, { timeout: 800 }));
          return ctx.must(yield ctx.call('msgs', 'insert', Object.assign({}, p, { thread: t.thread, rethread: t.rethread }), { timeout: 800 }));
        },
      },
      threader: {
        thread(ctx, p) {
          const st = ctx.state;
          const all = Object.values(st.msgs);
          if (st.config.headers) {
            const parent = all.find((m) => (p.refs || []).includes(m.msgId));
            if (parent) return { thread: parent.thread };
            const child = all.find((m) => (m.refs || []).includes(p.msgId));
            if (child) return { thread: child.thread, rethread: true };
            return { thread: `t${++st.seq.thread}` };
          }
          const norm = (s) => s.replace(/^(re|fwd?):\s*/i, '').toLowerCase();
          const same = all.find((m) => norm(m.subject) === norm(p.subject));
          return { thread: same ? same.thread : `t${++st.seq.thread}` };
        },
      },
      msgs: {
        get(ctx, p) { const m = ctx.state.msgs[p.id]; if (!m) ctx.fail('NOT_FOUND', 'No such message.'); return { labels: m.labels.slice() }; },
        list(ctx) { return { msgs: snapshot(ctx.state), hid: ctx.state.hidSeq }; },
        put(ctx, p) {
          const st = ctx.state;
          const m = st.msgs[p.id];
          const before = has(m, 'INBOX') && has(m, 'UNREAD') ? 1 : 0;
          m.labels = p.labels.slice();
          const after = has(m, 'INBOX') && has(m, 'UNREAD') ? 1 : 0;
          return { hid: change(ctx, after - before), labels: m.labels.slice() };
        },
        insert(ctx, p) {
          const st = ctx.state;
          const id = `m${4 + st.seq.msg++}`;
          st.msgs[id] = { id, from: p.from, subject: p.subject, conv: p.conv, msgId: p.msgId, refs: (p.refs || []).slice(), thread: p.thread, labels: ['INBOX', 'UNREAD'], t: ctx.now() };
          st.init[id] = ['INBOX', 'UNREAD'];
          if (p.rethread) st.stats.rethreaded++;
          return { hid: change(ctx, 1), thread: p.thread };
        },
      },
      counters: {
        get(ctx) { return { n: ctx.state.ctr }; },
      },
      repair: {
        run: function* (ctx) {
          const st = ctx.state;
          const r = ctx.must(yield ctx.call('msgs', 'list', {}, { timeout: 800 }));
          const n = Object.values(r.msgs).filter((m) => m.labels.includes('INBOX') && m.labels.includes('UNREAD')).length;
          const was = badgeOf(st);
          yield ctx.call('counters', 'get', {}, { timeout: 400, quiet: true });
          st.ctr = n; st.count = n; st.repairs++;
          return { n, was };
        },
      },
    },
    setup(sim) {
      // Async counter: add each event’s delta (only when counters are not in the transaction).
      Y.consumer(sim, 'log', 'counters', 'counters', function* (ctx, msg) {
        const st = ctx.state;
        if (st.config.txn) return true;
        if (ctx.mode('loseNext')) {
          ctx.sim.restore('counters', 'loseNext');
          st.stats.lostDeltas++;
          ctx.log({ op: `delta ${msg.payload.delta > 0 ? '+' : ''}${msg.payload.delta} lost`, status: 'lost', actionId: msg.actionId, detail: 'The counter never applies this event. The labels are right; the badge is now off by one, and stays off.' });
          return true;
        }
        st.ctr += msg.payload.delta;
        return true;
      });
      // Devices: on each event, refresh their copy.
      for (const d of DEVS) {
        Y.consumer(sim, 'log', d, d, function* (ctx, msg) {
          const r = yield ctx.call('api', 'snapshot', {}, { timeout: 1200, quiet: true });
          if (!r.ok) return false;
          const v = ctx.state.dev[d];
          v.msgs = r.value.msgs; v.badge = r.value.badge; v.hid = Math.max(v.hid, msg.payload.hid);
          return true;
        });
      }
      // Bulk jobs: a fresh worker resumes any stored job that is still running.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(200);
          if (ctx.sim.nodes.jobs.modes.crashed) continue;
          for (const j of ctx.state.jobs) if (j.state === 'running' && !j.active && ctx.state.config.checkpoint) ctx.spawn((c) => runJob(c, j.id), { self: 'jobs' });
        }
      }, { self: 'jobs', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      for (const m of Object.values(st.msgs)) {
        const want = expected(st, m.id);
        const got = m.labels.slice().sort();
        if (JSON.stringify(want) !== JSON.stringify(got)) {
          const back = want.includes('INBOX') ? null : got.includes('INBOX');
          return { key: 'wrong', label: `“${m.subject}” has labels {${got.join(', ') || 'none'}} but the devices asked for {${want.join(', ') || 'none'}}: ${back ? 'the archive was overwritten by a whole label set written from an older view, so the message is back in the inbox' : 'one device’s change was overwritten by another’s whole label set'}. A lost update.` };
        }
      }
      const byConv = {};
      for (const m of Object.values(st.msgs)) (byConv[m.conv] = byConv[m.conv] || new Set()).add(m.thread);
      const split = Object.entries(byConv).find(([, t]) => t.size > 1);
      const byThread = {};
      for (const m of Object.values(st.msgs)) (byThread[m.thread] = byThread[m.thread] || new Set()).add(m.conv);
      const merged = Object.entries(byThread).find(([, c]) => c.size > 1);
      if (merged) { const names = Object.values(st.msgs).filter((m) => m.thread === merged[0]).map((m) => m.from); return { key: 'wrong', label: `${[...new Set(names)].join(' and ')} are in one conversation because both subjects are “Invoice”. Unrelated senders share a thread; a reply-all would go to both.` }; }
      const truth = unreadInbox(st);
      const lag = sim.queueStats('log');
      const ctrBehind = !st.config.txn && sim.queues.log.groups.counters && sim.queues.log.msgs.length - sim.queues.log.groups.counters.offset > 0;
      if (badgeOf(st) !== truth && !ctrBehind) return { key: 'wrong', label: `The badge says ${badgeOf(st)} unread but the inbox has ${truth}: the counter ${st.stats.lostDeltas ? 'missed an update' : 'applied an event twice'}. It stays wrong until a repair job recounts.` };
      if (split) return { key: 'stale', label: `Omar’s two messages are in two conversations until the threader joins them.` };
      const lost = st.jobs.find((j) => j.state === 'lost');
      if (lost) return { key: 'stale', label: `The bulk archive stopped at ${lost.done} of ${lost.ids.length}: its progress was in a worker that crashed, and nothing knows to resume it. Half the Finch digests are still in the inbox.` };
      const running = st.jobs.find((j) => j.state === 'running');
      if (running) return { key: 'stale', label: `The bulk archive is running: ${running.done} of ${running.ids.length}.` };
      for (const d of DEVS) {
        const v = st.dev[d];
        if (v.hid < st.hidSeq || (lag.depth && sim.nodes[d].modes.down)) return { key: 'stale', label: `The ${d} is behind the mailbox (history ${v.hid} of ${st.hidSeq})${sim.nodes[d].modes.down ? ': it is closed and catches up when opened' : ''}.` };
        if (v.badge !== badgeOf(st)) return { key: 'stale', label: `The ${d}’s badge is catching up.` };
      }
      const notes = [];
      if (st.stats.rethreaded) notes.push('the reply was joined to its original when the original arrived');
      const done = st.jobs.find((j) => j.state === 'done');
      if (done) notes.push(`the bulk archive finished all ${done.ids.length}`);
      if (st.repairs) notes.push('the repair job recounted the badge');
      return { key: 'ok', label: `Labels are what the devices asked for, each conversation is one thread, and the badge (${badgeOf(st)}) matches the inbox${notes.length ? `; ${notes.join('; ')}` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const truth = unreadInbox(st);
      const drift = badgeOf(st) - truth;
      const threads = new Set(Object.values(st.msgs).filter((m) => has(m, 'INBOX')).map((m) => m.thread)).size;
      const lostUpdates = Object.values(st.msgs).filter((m) => JSON.stringify(expected(st, m.id)) !== JSON.stringify(m.labels.slice().sort())).length;
      return [
        { label: 'Unread in the inbox', value: truth },
        { label: 'Badge', value: badgeOf(st), tone: drift ? 'fail' : '' },
        { label: 'Counter drift', value: drift > 0 ? `+${drift}` : drift, tone: drift ? 'fail' : '' },
        { label: 'Inbox conversations', value: threads },
        { label: 'Lost label updates', value: lostUpdates, tone: lostUpdates ? 'fail' : '' },
        { label: 'History id', value: st.hidSeq },
        { label: 'Bulk job', value: st.jobs.length ? `${st.jobs[st.jobs.length - 1].done} of ${st.jobs[st.jobs.length - 1].ids.length} · ${st.jobs[st.jobs.length - 1].state}` : '–' },
        { label: 'Re-threaded', value: st.stats.rethreaded },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone'], ['laptop', 'Maya’s laptop']], {
          note: 'Each device shows the inbox by conversation and the unread badge. The mailbox (below) shows the labels as stored.',
          below: '<div class="ops-console" data-ref="box"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const convs = (msgs) => {
          const by = {};
          for (const m of Object.values(msgs)) if (m.labels.includes('INBOX')) (by[m.thread] = by[m.thread] || []).push(m);
          return Object.values(by).filter((g) => !g[0].id.startsWith('f')).map((g) => {
            const unread = g.some((m) => m.labels.includes('UNREAD'));
            return `<div class="app-card ${unread ? 'is-ok' : ''}"><strong>${unread ? '● ' : ''}${esc([...new Set(g.map((m) => m.from))].join(', '))}${g.length > 1 ? ` (${g.length})` : ''}</strong><span class="app-sub">${esc(g[0].subject.replace(/^Re:\s*/, ''))}</span></div>`;
          }).join('');
        };
        for (const d of DEVS) {
          const v = st.dev[d];
          const finch = Object.values(v.msgs).filter((m) => m.id.startsWith('f') && m.labels.includes('INBOX')).length;
          Y.paint(el, sim, d, {
            head: `<div><p class="app-title">Inbox · ${v.badge == null ? '?' : v.badge} unread</p><p class="app-sub">history ${v.hid}</p></div>`,
            act: `<div class="app-row">${Y.btn('read', 'Read newest', { arg: { dev: d } })}${Y.btn('archive', 'Archive newest', { arg: { dev: d }, cls: 'secondary' })}</div>`,
            list: convs(v.msgs) || '<p class="app-sub">Nothing else in the inbox.</p>',
            finch: `<p class="app-sub">Finch News: ${finch} digest${finch === 1 ? '' : 's'} in the inbox</p>${d === 'laptop' ? `<div class="app-row">${Y.btn('bulk', 'Archive all from Finch', { cls: 'secondary', disabled: !finch })}</div>` : ''}`,
          }, {});
        }
        const c = sim.scenario.consistency(sim);
        const rows = Object.values(st.msgs).filter((m) => !m.id.startsWith('f')).map((m) => `<div class="ops-row"><div class="ops-name">${esc(m.from)} · ${esc(m.subject)}<span>${m.thread} · {${m.labels.join(', ') || 'none'}}</span></div></div>`).join('');
        const job = st.jobs[st.jobs.length - 1];
        SDL.ui.paintSections(el.querySelector('[data-ref="box"]'), {
          title: `<p class="ops-title">Maya’s mailbox · ${unreadInbox(st)} unread · counter ${badgeOf(st)} (${st.config.txn ? 'in the transaction' : 'async'})</p>`,
          rows: `<div class="ops-shards">${rows}${job ? `<div class="ops-row" data-tone="${job.state === 'lost' ? 'warn' : ''}"><div class="ops-name">Bulk job ${job.id}<span>${job.done} of ${job.ids.length} · ${job.state}</span></div></div>` : ''}</div>`,
          act: `<div class="app-row">${Y.btn('arrive', '✉ Mail from Omar', { arg: { which: 'omar' }, cls: 'secondary' })}${Y.btn('arrive', 'Omar’s reply', { arg: { which: 'reply' }, cls: 'secondary' })}${Y.btn('arrive', 'Landlord “Invoice”', { arg: { which: 'rent' }, cls: 'secondary' })}${Y.btn('repair', 'Run counter repair', { cls: 'secondary' })}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };

  /** Append a change event; in transaction mode the unread count changes in the same write. */
  function change(ctx, delta) {
    const st = ctx.state;
    const hid = ++st.hidSeq;
    if (st.config.txn) st.count += delta;
    ctx.sim.enqueue('log', { type: 'change', eventId: `h${hid}`, payload: { hid, delta }, actionId: ctx.actionId });
    return hid;
  }
})(typeof window !== 'undefined' ? window : globalThis);
