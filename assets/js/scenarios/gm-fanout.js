/*
 * Mailing lists, hot mailboxes, and shared attachments.
 * Dev sends the all-hands deck to all@: the mail service expands the list and
 * queues one delivery task per shard per ten recipients. Workers write a copy
 * of the message into each recipient’s mailbox. The 10 MB deck is stored once
 * and referenced by every copy (single-instance storage), so its blob carries
 * a reference count and the garbage collector deletes blobs whose count is
 * zero. Take the references before releasing the upload’s, or a GC pass can
 * delete the deck mid-fan-out. Track delivery per recipient so a worker that
 * crashes mid-batch can be retried without duplicates. A per-mailbox limiter
 * keeps one flooded mailbox (support@) from slowing everyone on its shard.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const N = 60;
  const DECK_MB = 10;
  const TASK = 10;
  const GRACE_MS = 3000;
  const RETRY_MS = 500;
  const CRASH_MS = 600;
  const LATE_FAN = 1500;
  const LATE_MS = 400;
  const HOT_GAP = 4; // ms between deliveries to one mailbox when isolated (250 a second)
  const FLOOD_RATE = 1000;
  const SHARDS = ['sh1', 'sh2', 'sh3'];
  const MEMBERS = ['dev', 'maya'].concat(Array.from({ length: N - 2 }, (_, i) => `p${i + 3}`));
  const shardOf = (u) => (u === 'maya' || u === 'support' ? 'sh2' : u === 'dev' ? 'sh1' : SHARDS[+u.slice(1) % 3]);
  const NAMES = { maya: 'Maya', dev: 'Dev', support: 'support@' };

  function initialState() {
    return {
      config: { single: true, tracking: true, isolate: true, refFirst: true },
      blobs: { deck: { id: 'deck', size: DECK_MB, refs: 1, deleted: false } },
      box: {}, jobs: {}, seq: { blob: 0, msg: 0 },
      lim: {}, support: { sent: 0, done: 0 },
      personal: [], stats: { skipped: 0, requeued: 0, crashes: 0 },
      batch: { inserts: 0, crashing: false },
    };
  }
  const job = (st) => st.jobs.j1;
  const copies = (st, u, msgId) => (st.box[u] || []).filter((m) => m.msgId === msgId).length;

  function send(sim) {
    if (job(sim.state)) return;
    sim.startAction(`Dev: send “All-hands deck” to all@ (${N} people, ${DECK_MB} MB PDF)`, function* (ctx) {
      const cfg = ctx.state.config;
      Y.L(ctx, { displayed: ['pending', 'Sending…'], retrySafe: ['yes', 'The send has an idempotency key (see the send lab).'] });
      const r = yield ctx.call('api', 'send', {}, { timeout: 3000 });
      if (!r.ok) { Y.failed(ctx, `Failed: ${r.error.code}.`); return; }
      Y.L(ctx, {
        displayed: ['yes', '“Sent.”'],
        accepted: ['yes', `${r.value.n} recipients, ${r.value.tasks} delivery tasks.`],
        committed: ['yes', cfg.single ? `One ${DECK_MB} MB blob, ${cfg.refFirst ? `${r.value.n} references taken before the upload’s was released` : 'references added as each copy is written'}.` : `Each recipient gets a ${DECK_MB} MB copy of the PDF.`],
        async: ['pending', 'Workers are writing the copies.'],
      });
    }, { self: 'dev' });
  }
  function personal(sim) {
    const st = sim.state;
    const id = `<omar-${st.personal.length + 1}@example.org>`;
    const rec = { msgId: id, t0: sim.now, t: null };
    st.personal.push(rec);
    sim.startAction('Omar emails Maya', function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'Arrives on its own.'], retrySafe: ['yes', 'Keyed by Message-ID.'] });
      const r = yield* deliverOne(ctx, 'maya', { msgId: id, subject: 'Quick question', from: 'Omar' }, {});
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      rec.t = ctx.now();
      Y.L(ctx, { accepted: ['yes', `In Maya’s mailbox after ${rec.t - rec.t0} ms.`], committed: ['yes', 'Shard 2.'] });
    }, { self: 'workers' });
  }

  /** One mailbox write: through the per-mailbox limiter when isolation is on. */
  function* deliverOne(ctx, u, m, o) {
    const st = ctx.state;
    if (st.config.isolate) {
      const l = yield ctx.call('limiter', 'slot', { user: u }, { timeout: 300, quiet: o.quiet });
      if (l.ok && l.value.wait) yield ctx.wait(l.value.wait);
    }
    return yield ctx.call(shardOf(u), 'insert', { user: u, msg: m, tracking: st.config.tracking }, { timeout: o.timeout || 1500, quiet: o.quiet, actionId: o.actionId });
  }

  function* runTask(ctx, msg) {
    const st = ctx.state;
    const p = msg.payload;
    const j = st.jobs[p.job];
    for (const u of p.rcpts) {
      if (st.batch.crashing) return 'crash';
      if (st.config.tracking && j.done[u]) { st.stats.skipped++; continue; }
      if (ctx.mode('crashMidBatch') && st.batch.inserts >= 5) {
        ctx.sim.restore('workers', 'crashMidBatch');
        st.batch.crashing = true;
        st.stats.crashes++;
        ctx.log({ op: `worker crashed after ${st.batch.inserts} deliveries`, status: 'fault', actionId: msg.actionId, detail: st.config.tracking ? 'Its tasks go back to the queue. Each recipient already delivered is recorded, so the retry skips them.' : 'Its tasks go back to the queue and will be redone from the start. Nothing records who already got a copy.' });
        return 'crash';
      }
      const quiet = u === 'maya' || u === 'dev' ? undefined : true;
      let blob = j.blob;
      if (!j.single) {
        const b = yield ctx.call('blobs', 'copy', { from: j.blob }, { timeout: 1500, actionId: msg.actionId, quiet });
        if (!b.ok) return 'retry';
        blob = b.value.id;
      }
      const r = yield* deliverOne(ctx, u, { msgId: j.msgId, subject: j.subject, from: 'Dev', blob }, { actionId: msg.actionId, quiet });
      if (!r.ok) return 'retry';
      st.batch.inserts++;
      if (r.value.dup) st.stats.skipped++;
      if (!r.value.dup && !j.done[u]) j.done[u] = ctx.now();
      if (j.single && !j.refFirst && !r.value.dup) yield ctx.call('blobs', 'ref', { id: blob, n: 1 }, { timeout: 800, actionId: msg.actionId, quiet: quiet ? 'all' : undefined });
    }
    return 'done';
  }
  function requeue(ctx, msg) {
    ctx.state.stats.requeued++;
    ctx.spawn(function* (c) { yield c.wait(RETRY_MS); c.sim.enqueue('fanout', { type: msg.type, eventId: msg.eventId, payload: msg.payload, actionId: msg.actionId }); }, { self: 'fanq', quiet: 'all' });
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'dev', quiet: 'all' });

  function shardHandlers(sid) {
    return {
      insert(ctx, p) {
        const st = ctx.state;
        if (p.user === 'support') { st.support.done++; return { dup: false }; }
        const box = (st.box[p.user] = st.box[p.user] || []);
        if (p.tracking && box.some((m) => m.msgId === p.msg.msgId)) return { dup: true };
        box.push(Object.assign({}, p.msg, { t: ctx.now(), shard: sid }));
        return { dup: false };
      },
    };
  }

  SDL.scenarios['gm-fanout'] = {
    id: 'gm-fanout',
    seed: 3107,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Send the all-hands deck to a 60-person list and watch one stored PDF fan out to every mailbox. Then crash a worker mid-batch, let the garbage collector run mid-fan-out, take a shard down, or flood support@, which shares Maya’s shard.',
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'dev', label: 'Dev’s laptop', sub: 'Sender', kind: 'client', x: 90, y: 110, latency: 1, role: 'Sends the all-hands with a 10 MB deck to all@.', owns: ['The draft'] },
        { id: 'maya', label: 'Maya’s phone', sub: 'One recipient', kind: 'client', x: 90, y: 440, latency: 1, role: 'One of the 60 recipients; her mailbox is on shard 2 with support@.', owns: ['Her view of the inbox'] },
        { id: 'api', label: 'Gmail API', sub: 'Frontend', kind: 'gateway', x: 270, y: 110, latency: 3, role: 'Accepts the send.', ops: [{ name: 'send', desc: 'Send a message.' }], owns: ['Nothing durable'] },
        { id: 'mail', label: 'Mail service', sub: 'Plans the fan-out', kind: 'service', x: 450, y: 110, latency: 3, role: 'Expands the list, takes the attachment references (or not), queues one task per shard per ten recipients, and releases the upload’s reference.', ops: [{ name: 'send', desc: 'Plan and queue the fan-out.' }], owns: ['Fan-out job record (who is done)'] },
        { id: 'expand', label: 'List expansion', sub: 'Groups directory', kind: 'service', x: 450, y: 260, latency: 20, role: 'Turns all@ into its members.', ops: [{ name: 'list', desc: 'Members of a list.' }], owns: ['list membership'] },
        { id: 'fanq', label: 'Fan-out queue', sub: 'Delivery tasks', kind: 'queue', x: 630, y: 110, latency: 2, role: 'Delivery tasks, each for up to ten recipients on one shard. A task that fails is retried later; one taken by a worker that crashes is delivered again.', owns: ['tasks'] },
        { id: 'workers', label: 'Delivery workers', sub: 'Copy into mailboxes', kind: 'worker', x: 810, y: 110, latency: 2, role: 'For each recipient: skip if already delivered (with tracking), write the message into the mailbox, add a reference to the blob.', owns: ['Nothing durable'] },
        { id: 'limiter', label: 'Per-mailbox limiter', sub: '250 a second each', kind: 'cache', x: 810, y: 290, latency: 1, role: 'Gives each mailbox its own pace. A flooded mailbox queues behind itself instead of filling its shard.', ops: [{ name: 'slot', desc: 'When may this mailbox take its next write?' }], owns: ['next slot per mailbox'] },
        { id: 'sh1', label: 'Mailbox shard 1', sub: 'Dev and a third', kind: 'db', x: 1050, y: 110, latency: 3, serviceMs: 5, servers: 2, role: 'Mailboxes for a third of users. About 400 writes a second.', ops: [{ name: 'insert', desc: 'Write a message into a mailbox.' }], owns: ['mailboxes'] },
        { id: 'sh2', label: 'Mailbox shard 2', sub: 'Maya, support@', kind: 'db', x: 1050, y: 280, latency: 3, serviceMs: 5, servers: 2, role: 'Maya’s mailbox, support@, and a third of the list.', ops: [{ name: 'insert', desc: 'Write a message into a mailbox.' }], owns: ['mailboxes'] },
        { id: 'sh3', label: 'Mailbox shard 3', sub: 'A third', kind: 'db', x: 1050, y: 450, latency: 3, serviceMs: 5, servers: 2, role: 'Another third of the list.', ops: [{ name: 'insert', desc: 'Write a message into a mailbox.' }], owns: ['mailboxes'] },
        { id: 'blobs', label: 'Blob store', sub: 'Refcounted', kind: 'store', x: 630, y: 400, latency: 4, serviceMs: 20, servers: 4, role: 'Attachments by content. Each blob has a reference count; when it reaches zero, the collector may delete it after a grace period.', ops: [{ name: 'ref', desc: 'Add references.' }, { name: 'unref', desc: 'Drop a reference.' }, { name: 'copy', desc: 'A private copy.' }], owns: ['blobs', 'refcounts'] },
        { id: 'gc', label: 'Garbage collector', sub: `Grace ${GRACE_MS / 1000} s`, kind: 'worker', x: 400, y: 470, latency: 2, role: 'Deletes blobs whose reference count has been zero for the grace period. A pass that lands while a blob is briefly at zero deletes it.', ops: [{ name: 'sweep', desc: 'Collect a blob if unreferenced.' }], owns: ['Nothing'] },
      ],
      edges: [
        { from: 'dev', to: 'api', latency: 20 },
        { from: 'api', to: 'mail', latency: 3 },
        { from: 'mail', to: 'expand', latency: 3 },
        { from: 'mail', to: 'fanq', latency: 2 },
        { from: 'mail', to: 'blobs', latency: 3, via: [[540, 110], [540, 400]] },
        { from: 'fanq', to: 'workers', latency: 2 },
        { from: 'workers', to: 'limiter', latency: 1 },
        { from: 'workers', to: 'sh1', latency: 3 },
        { from: 'workers', to: 'sh2', latency: 3, via: [[930, 110], [930, 280]] },
        { from: 'workers', to: 'sh3', latency: 3, via: [[930, 110], [930, 450]] },
        { from: 'workers', to: 'blobs', latency: 3, via: [[720, 110], [720, 400]] },
        { from: 'blobs', to: 'gc', latency: 2, via: [[630, 470]] },
        { from: 'maya', to: 'api', latency: 40, label: 'reads her inbox', via: [[180, 440], [180, 170], [270, 170]] },
      ],
      queues: [{ id: 'fanout', broker: 'fanq', label: 'delivery tasks', groups: ['workers'] }],
    },
    modeLabels: { crashMidBatch: 'Crashes mid-batch', eager: 'Sweeping now (no grace)', flood: 'support@ flood' },
    failures: [
      { id: 'sh3-down', node: 'sh3', mode: 'down', label: 'Shard 3 down', desc: 'Deliveries to a third of the list fail and are retried.' },
      { id: 'crash', node: 'workers', mode: 'crashMidBatch', label: 'Worker crashes mid-batch', desc: 'After five deliveries the worker dies; its tasks are delivered again.' },
      { id: 'blobs-slow', node: 'blobs', mode: 'slow', params: { factor: 20 }, label: 'Blob store slow', desc: 'Copies and references take longer.' },
      { id: 'expand-slow', node: 'expand', mode: 'slow', params: { factor: 30 }, label: 'List expansion slow', desc: 'Dev waits longer for “Sent”.' },
      { id: 'gc-now', node: 'gc', mode: 'eager', label: 'GC pass during fan-out', desc: 'A collector pass runs right now: any blob at zero references is deleted at once.' },
      { id: 'flood', node: 'mail', mode: 'flood', label: 'support@ flood', desc: `${FLOOD_RATE} messages a second to support@, on Maya’s shard.` },
      { id: 'dup', node: 'fanq', mode: 'duplicate', label: 'Duplicate task delivery', desc: 'Every task is queued twice.' },
      { id: 'sh2-slow', node: 'sh2', mode: 'slow', params: { factor: 20 }, label: 'Shard 2 slow', desc: 'Maya’s shard answers 20× slower.' },
    ],
    switches: Y.switches([
      ['single', 'Store the attachment once', 'One blob referenced by every copy. Off: each recipient gets a private 10 MB copy.'],
      ['tracking', 'Track delivery per recipient', 'Record each recipient as delivered (and make the write unique per mailbox and Message-ID), so a retried task skips them. Off: a retried task redoes everyone.'],
      ['isolate', 'Isolate hot mailboxes', 'A per-mailbox limiter: one mailbox can use at most 250 writes a second of its shard; the rest waits in its own line.'],
      ['refFirst', 'Take references before releasing the upload’s', 'The mail service adds one reference per recipient, then releases the upload’s. Off: it releases first and each worker adds a reference after writing its copy.'],
    ]),
    presets: Y.presets({ single: true, tracking: true, isolate: true, refFirst: true }, [
      { id: 'normal', label: 'All-hands to 60 people', desc: 'Dev sends the deck to all@. The list expands to 60 people on three shards; ten-recipient tasks write a copy into each mailbox, all pointing at one 10 MB blob with 60 references.', run: (s) => { send(s); } },
      { id: 'copy-per-recipient', label: 'A copy of the PDF per recipient', desc: 'Same send without single-instance storage: every mailbox gets its own 10 MB copy. 600 MB instead of 10 MB here; at 50,000 recipients, 500 GB instead of 10 MB.', sw: { single: false }, run: (s) => { send(s); } },
      { id: 'shard-down', label: 'Shard 3 down during the fan-out', desc: 'Shard 3 is down for 2.5 seconds. Its tasks fail and go back to the queue; everyone on shards 1 and 2 (Maya too) gets the deck at once, the third on shard 3 late.', run: (s) => { s.inject('sh3', 'down', true, 2500); send(s); } },
      { id: 'crash-no-tracking', label: 'Worker crashes mid-batch, no tracking', desc: 'The worker dies after five deliveries. Its tasks are delivered again and, with nothing recording who already got a copy, redone from the start: those people get the all-hands twice.', sw: { tracking: false }, run: (s) => { s.inject('workers', 'crashMidBatch'); send(s); } },
      { id: 'crash-tracking', label: 'Same crash, per-recipient tracking', desc: 'Same crash. Each delivered recipient is recorded and the write is unique per mailbox and Message-ID, so the retry skips them: everyone gets exactly one.', run: (s) => { s.inject('workers', 'crashMidBatch'); send(s); } },
      { id: 'gc-race', label: 'GC runs while the deck has no references', desc: 'The mail service releases the upload’s reference before any copy exists, planning to let each worker add one. For that moment the deck has zero references, and a collector pass deletes it. Every copy then points at a missing attachment.', sw: { refFirst: false }, run: (s) => { s.inject('gc', 'eager'); send(s); } },
      { id: 'gc-ref-first', label: 'Same GC pass, references taken first', desc: 'The mail service adds 60 references before releasing the upload’s. The count never touches zero, so the same collector pass leaves the deck alone.', run: (s) => { s.inject('gc', 'eager'); send(s); } },
      { id: 'flood-no-isolation', label: 'support@ flood, no isolation', desc: `support@ gets ${FLOOD_RATE} messages a second for 1.5 seconds. Shard 2 takes about 400 writes a second, so a queue builds, and Omar’s email to Maya, on the same shard, waits behind the flood.`, sw: { isolate: false }, run: (s) => { s.inject('mail', 'flood', true, 1500); later(s, 600, (x) => personal(x)); } },
      { id: 'flood-isolation', label: 'support@ flood, isolated', desc: 'Same flood. The limiter lets support@ take 250 writes a second; the rest waits in its own line. Shard 2 stays fast and Maya’s email lands at once. support@ catches up a few seconds later.', run: (s) => { s.inject('mail', 'flood', true, 1500); later(s, 600, (x) => personal(x)); } },
      { id: 'duplicate-delivery', label: 'Every task delivered twice', desc: 'The queue hands out each task twice. With per-recipient tracking the second run finds everyone delivered and writes nothing.', run: (s) => { s.inject('fanq', 'duplicate'); send(s); } },
    ]),
    initialState,
    initialUI: () => ({}),
    actions: {
      send(sim) { send(sim); },
      personal(sim) { personal(sim); },
      flood(sim) { if (!sim.nodes.mail.modes.flood) sim.inject('mail', 'flood', true, 1500); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        send: function* (ctx, p) { return ctx.must(yield ctx.call('mail', 'send', p, { timeout: 2800 })); },
      },
      mail: {
        send: function* (ctx) {
          const st = ctx.state;
          const cfg = st.config;
          const ex = ctx.must(yield ctx.call('expand', 'list', { list: 'all@' }, { timeout: 2500 }));
          const j = { id: 'j1', msgId: '<allhands@corp.example>', subject: 'All-hands deck', blob: 'deck', single: cfg.single, refFirst: cfg.refFirst, members: ex.members, done: {}, t0: ctx.now() };
          st.jobs.j1 = j;
          if (cfg.single && cfg.refFirst) ctx.must(yield ctx.call('blobs', 'ref', { id: 'deck', n: ex.members.length }, { timeout: 800 }));
          else ctx.must(yield ctx.call('blobs', 'unref', { id: 'deck' }, { timeout: 800 }));
          const by = {};
          for (const u of ex.members) (by[shardOf(u)] = by[shardOf(u)] || []).push(u);
          let tasks = 0;
          for (const s of SHARDS) for (let i = 0; i < (by[s] || []).length; i += TASK) {
            tasks++;
            ctx.sim.enqueue('fanout', { type: 'deliver', eventId: `t${tasks}`, payload: { job: j.id, shard: s, rcpts: by[s].slice(i, i + TASK) }, actionId: ctx.actionId });
          }
          if (cfg.single && cfg.refFirst) ctx.must(yield ctx.call('blobs', 'unref', { id: 'deck' }, { timeout: 800 }));
          return { n: ex.members.length, tasks };
        },
      },
      expand: {
        list() { return { members: MEMBERS.slice() }; },
      },
      limiter: {
        slot(ctx, p) {
          const st = ctx.state;
          const now = ctx.now();
          const at = Math.max(now, st.lim[p.user] || 0);
          st.lim[p.user] = at + HOT_GAP;
          return { wait: at - now };
        },
      },
      blobs: {
        ref(ctx, p) {
          const b = ctx.state.blobs[p.id];
          if (b.deleted) ctx.fail('NOT_FOUND', `${p.id} was already deleted.`);
          b.refs += p.n;
          return { refs: b.refs };
        },
        unref(ctx, p) {
          const st = ctx.state;
          const b = st.blobs[p.id];
          b.refs -= 1;
          if (b.refs === 0) {
            const eager = ctx.mode('eager', 'gc');
            ctx.spawn(function* (c) {
              if (!eager) yield c.wait(GRACE_MS);
              yield c.call('gc', 'sweep', { id: p.id }, { timeout: 800 });
            }, { self: 'blobs', actionId: ctx.actionId });
          }
          return { refs: b.refs };
        },
        copy(ctx) {
          const st = ctx.state;
          const id = `copy${++st.seq.blob}`;
          st.blobs[id] = { id, size: DECK_MB, refs: 1, deleted: false };
          return { id };
        },
        collect(ctx, p) {
          const b = ctx.state.blobs[p.id];
          if (b.deleted || b.refs > 0) return { deleted: false, refs: b.refs };
          b.deleted = true;
          return { deleted: true };
        },
      },
      gc: {
        sweep: function* (ctx, p) {
          const r = ctx.must(yield ctx.call('blobs', 'collect', p, { timeout: 800 }));
          const st = ctx.state;
          const j = job(st);
          if (r.deleted) ctx.log({ op: `blob ${p.id} deleted (0 references)`, status: j && j.single && p.id === 'deck' && !j.refFirst ? 'fault' : 'ok', detail: j && j.single && p.id === 'deck' ? 'The deck had no references at this moment: the upload’s was released and no copy had added one yet. Every copy written now points at nothing.' : 'Nothing refers to it any more.' });
          return r;
        },
      },
      sh1: shardHandlers('sh1'),
      sh2: shardHandlers('sh2'),
      sh3: shardHandlers('sh3'),
    },
    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msgs } = yield ctx.take('fanout', 'workers', 6);
          const st = ctx.state;
          st.batch = { inserts: 0, crashing: false };
          const procs = msgs.map((m) => ctx.spawn((c) => runTask(c, m), { self: 'workers', actionId: m.actionId }));
          const rs = yield ctx.join(procs);
          if (rs.some((r) => r.value === 'crash')) {
            ctx.nack('fanout', 'workers');
            ctx.sim.inject('workers', 'crashed', true, CRASH_MS);
            yield ctx.wait(CRASH_MS);
            continue;
          }
          rs.forEach((r, i) => { if (r.value !== 'done') requeue(ctx, msgs[i]); });
          ctx.ack('fanout', 'workers');
        }
      }, { self: 'workers' });
      // support@ flood: outside senders, on Maya’s shard.
      Y.load(sim, 'workers', (s) => (s.nodes.mail.modes.flood ? FLOOD_RATE : 0), function* (ctx, n) {
        ctx.state.support.sent++;
        yield* deliverOne(ctx, 'support', { msgId: `<help-${n}>` }, { quiet: 'all', timeout: 10000 });
      });
    },
    consistency(sim) {
      const st = sim.state;
      const j = job(st);
      if (j) {
        const dups = j.members.filter((u) => copies(st, u, j.msgId) > 1);
        if (dups.length) return { key: 'wrong', label: `${dups.length} people got the all-hands twice${dups.includes('maya') ? ', Maya among them' : ''}: a worker crashed mid-batch and its tasks were redone from the start, with nothing recording who already had a copy.` };
        const broken = j.members.filter((u) => (st.box[u] || []).some((m) => m.msgId === j.msgId && st.blobs[m.blob].deleted));
        if (broken.length) return { key: 'wrong', label: `${broken.length} copies of the all-hands point at a deck that no longer exists: the collector deleted it while its reference count was briefly zero (the upload’s reference released before any copy added one). The attachment is lost for everyone.` };
        const missing = j.members.filter((u) => !copies(st, u, j.msgId));
        if (missing.length) return { key: 'stale', label: `Delivered to ${j.members.length - missing.length} of ${j.members.length}; ${missing.length} on the way${sim.nodes.sh3.modes.down ? ' (shard 3 is down; their tasks are retried)' : ''}.` };
        const late = j.members.filter((u) => j.done[u] - j.t0 > LATE_FAN);
        if (late.length) return { key: 'stale', label: `Everyone has exactly one copy, but ${late.length} people (on shard 3) got it ${SDL.fmtMs(Math.max(...late.map((u) => j.done[u] - j.t0)))} after Dev sent it, because their shard was down and the tasks were retried. Maya, on shard 2, had it at once.` };
      }
      const slow = st.personal.find((p) => p.t == null ? sim.now - p.t0 > LATE_MS : p.t - p.t0 > LATE_MS);
      if (slow) return { key: 'stale', label: `Omar’s email to Maya ${slow.t == null ? 'is still waiting' : `took ${SDL.fmtMs(slow.t - slow.t0)}`}: support@ shares her shard and its flood ${st.config.isolate ? 'slowed the shard' : 'filled shard 2’s queue, so every mailbox on it waited behind support@'}.` };
      const pend = st.support.sent - st.support.done;
      if (pend > 0) return { key: 'stale', label: `support@ is catching up: ${pend} messages in its own line.` };
      if (!j && !st.personal.length) return { key: 'ok', label: 'Send the all-hands, or flood support@.' };
      const notes = [];
      if (j) {
        const mb = storage(st);
        notes.push(j.single ? `one ${DECK_MB} MB blob with ${st.blobs.deck.refs} references` : `${mb} MB of copies (one blob would be ${DECK_MB} MB; at 50,000 recipients, 500 GB vs ${DECK_MB} MB)`);
        if (st.stats.crashes) notes.push(`the crashed worker’s retry skipped ${st.stats.skipped} people who already had it`);
        else if (st.stats.skipped) notes.push(`the duplicate tasks found everyone delivered and skipped ${st.stats.skipped}`);
      }
      if (st.personal.length) notes.push(`Omar’s email reached Maya in ${SDL.fmtMs(st.personal[st.personal.length - 1].t - st.personal[st.personal.length - 1].t0)}${st.support.sent ? ` while support@ took its ${st.support.sent} messages in its own line` : ''}`);
      return { key: 'ok', label: `${j ? `All ${j.members.length} people have exactly one copy and the attachment opens` : 'Nothing is behind'}; ${notes.join('; ')}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const j = job(st);
      const delivered = j ? j.members.filter((u) => copies(st, u, j.msgId)).length : 0;
      const dups = j ? j.members.reduce((n, u) => n + Math.max(0, copies(st, u, j.msgId) - 1), 0) : 0;
      const broken = j ? j.members.filter((u) => (st.box[u] || []).some((m) => m.msgId === j.msgId && st.blobs[m.blob].deleted)).length : 0;
      const last = st.personal[st.personal.length - 1];
      return [
        { label: 'Delivered', value: j ? `${delivered} of ${j.members.length}` : '–' },
        { label: 'Duplicate copies', value: dups, tone: dups ? 'fail' : '' },
        { label: 'Missing attachments', value: broken, tone: broken ? 'fail' : '' },
        { label: 'Attachment storage', value: `${storage(st)} MB` },
        { label: 'Deck references', value: st.blobs.deck.deleted ? 'deleted' : st.blobs.deck.refs, tone: st.blobs.deck.deleted && j && j.single ? 'fail' : '' },
        { label: 'Omar → Maya', value: last ? (last.t != null ? `${last.t - last.t0} ms` : 'waiting') : '–', tone: last && (last.t == null || last.t - last.t0 > LATE_MS) ? 'warn' : '' },
        { label: 'Shard 2 queue wait', value: `${Math.round(sim.queueWait ? sim.queueWait('sh2') : 0)} ms` },
        { label: 'support@ backlog', value: st.support.sent - st.support.done },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['dev', 'Dev’s laptop'], ['maya', 'Maya’s phone']], {
          note: 'Dev sends to the list; Maya is one of the 60 recipients. The panel below shows the shards, the blob store, and support@.',
          below: '<div class="ops-console" data-ref="ops"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const j = job(st);
        const delivered = j ? j.members.filter((u) => copies(st, u, j.msgId)).length : 0;
        Y.paint(el, sim, 'dev', {
          head: `<div><p class="app-title">New message</p><p class="app-sub">To: all@ (${N} people)</p></div>`,
          body: `<div class="app-card"><strong>All-hands deck</strong><span class="app-sub">📎 All-hands.pdf · ${DECK_MB} MB</span></div>`,
          act: `<div class="app-row">${Y.btn('send', j ? 'Sent' : 'Send to all@', { disabled: !!j })}</div>`,
          status: j ? `<p class="app-sub">Delivered to ${delivered} of ${j.members.length}</p>` : '',
        }, {});
        const box = (st.box.maya || []).slice().reverse();
        const counts = {};
        for (const m of box) counts[m.msgId] = (counts[m.msgId] || 0) + 1;
        const seen = {};
        const cards = box.filter((m) => (seen[m.msgId] ? false : (seen[m.msgId] = true))).map((m) => {
          const gone = m.blob && st.blobs[m.blob].deleted;
          return `<div class="app-card ${gone || counts[m.msgId] > 1 ? 'is-fail' : 'is-ok'}"><strong>${esc(m.from)}${counts[m.msgId] > 1 ? ` ×${counts[m.msgId]}` : ''}</strong><span class="app-sub">${esc(m.subject)}</span>${m.blob ? `<span class="app-sub">${gone ? '⚠ Attachment unavailable' : `📎 All-hands.pdf · ${DECK_MB} MB`}</span>` : ''}</div>`;
        }).join('');
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Inbox</p><p class="app-sub">Shard 2</p></div>`,
          list: cards || '<p class="app-sub">Nothing new.</p>',
        }, {});
        const c = sim.scenario.consistency(sim);
        const shardRow = (s) => {
          const n = sim.nodes[s];
          const mine = j ? j.members.filter((u) => shardOf(u) === s) : [];
          const got = mine.filter((u) => copies(st, u, j.msgId)).length;
          const wait = Math.round(sim.queueWait ? sim.queueWait(s) : 0);
          return `<div class="ops-row" data-tone="${n.modes.down ? 'fail' : wait > 100 || n.modes.slow ? 'warn' : ''}"><div class="ops-name">Shard ${s.slice(2)} · ${n.modes.down ? '✕ down' : n.modes.slow ? '◐ slow' : '● up'}<span>${j ? `${got} of ${mine.length} delivered · ` : ''}queue ${wait} ms</span></div></div>`;
        };
        const deck = st.blobs.deck;
        const copiesN = Object.values(st.blobs).filter((b) => b.id !== 'deck' && !b.deleted).length;
        SDL.ui.paintSections(el.querySelector('[data-ref="ops"]'), {
          title: '<p class="ops-title">Mailbox shards and blobs</p>',
          rows: `<div class="ops-shards">${SHARDS.map(shardRow).join('')}
            <div class="ops-row" data-tone="${deck.deleted && j && j.single ? 'fail' : ''}"><div class="ops-name">Blob store · ${storage(st)} MB<span>deck: ${deck.deleted ? 'deleted' : `${deck.refs} reference${deck.refs === 1 ? '' : 's'}`}${copiesN ? ` · ${copiesN} private copies` : ''}</span></div></div>
            <div class="ops-row" data-tone="${st.support.sent - st.support.done > 0 ? 'warn' : ''}"><div class="ops-name">support@ (shard 2)<span>${st.support.sent ? `${st.support.done} of ${st.support.sent} written` : 'quiet'}</span></div></div></div>`,
          act: `<div class="app-row">${Y.btn('personal', '✉ Omar emails Maya', { cls: 'secondary' })}${Y.btn('flood', 'Flood support@', { cls: 'secondary', disabled: !!sim.nodes.mail.modes.flood })}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };

  function storage(st) { return Object.values(st.blobs).filter((b) => !b.deleted).reduce((n, b) => n + b.size, 0); }
})(typeof window !== 'undefined' ? window : globalThis);
