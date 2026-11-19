/*
 * Replication, backups, and the bad push.
 * Maya’s mailbox lives in three zones: a primary and two replicas fed by a
 * replication log. With a synchronous quorum, a message is acknowledged only
 * once a second zone has it, so losing the primary loses nothing; with async
 * shipping, a primary that dies right after acknowledging takes the message
 * with it. Replicas copy everything, including a buggy storage release that
 * deletes mail, so they are not backups. Recovery needs a copy the bug cannot
 * reach: an offline backup (slow, plus log replay up to the push, as long as
 * the log still goes back that far) or a delayed replica that applies changes
 * a few seconds late and can be stopped before the bad ones. A canary rollout
 * limits the damage to a small cell.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const ZONES = ['pri', 'repB', 'repC'];
  const ZNAME = { pri: 'zone A', repB: 'zone B', repC: 'zone C' };
  const DELAY_MS = 3000;
  const DETECT_MS = 1000;
  const LOG_RET_MS = 5000;
  const BACKUP_EVERY = 1500;
  const FAILOVER_MS = 600;
  const ASYNC_MS = 300;
  const FAST_OK = 1500;
  const INITIAL = [['m1', 'Lena', 'Photos from Goa'], ['m2', 'Acme Billing', 'Invoice 77'], ['m3', 'Dev', 'Lunch Friday?']];

  function initialState() {
    const msgs = {};
    INITIAL.forEach(([id, from, subject]) => { msgs[id] = { id, from, subject }; });
    const log = INITIAL.map(([id], i) => ({ seq: i + 1, t: 0, op: 'insert', msg: msgs[id] }));
    const zone = () => ({ msgs: Object.assign({}, msgs), applied: 3, recv: [], lastRecv: 3 });
    const st = {
      config: { sync: true, canary: true, offline: true, delayed: true },
      zones: { pri: zone(), repB: zone(), repC: zone() },
      log, seq: 3, primary: 'pri', members: ZONES.slice(),
      acked: {}, sends: [], vault: [{ seq: 3, t: 0, msgs: Object.assign({}, msgs) }],
      push: null, badSeq: null, restore: null, emptyAt: null, emptyMs: null,
      frozenC: false, skipBad: false, failovers: [], crashLost: [],
      canary: { state: 'fine' }, oseq: 0, tempfails: 0,
    };
    for (const id of Object.keys(msgs)) st.acked[id] = 0;
    return st;
  }

  function apply(z, e) {
    if (e.op === 'insert') z.msgs[e.msg.id] = e.msg;
    else if (e.op === 'wipe') z.msgs = {};
    else if (e.op === 'restore') for (const m of Object.values(e.msgs)) z.msgs[m.id] = m;
    z.applied = e.seq;
  }
  /** Apply received entries in order; zone C waits DELAY_MS when it is the delayed replica. */
  function drain(st, zid, now) {
    const z = st.zones[zid];
    while (z.recv.length) {
      const e = z.recv[0];
      const delayed = zid === 'repC' && st.config.delayed && st.primary !== 'repC';
      if (delayed && (st.frozenC || now - e.t < DELAY_MS)) break;
      z.recv.shift();
      if (e.bad && st.skipBad && zid === 'repC') { z.applied = e.seq; continue; }
      apply(z, e);
    }
  }

  function omar(sim, subject) {
    const st = sim.state;
    const id = `o${++st.oseq}`;
    const rec = { id, subject, t0: sim.now, tries: 0, t: null };
    st.sends.push(rec);
    sim.startAction(`Omar emails Maya: “${subject}”`, function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'Arrives on its own.'], retrySafe: ['yes', 'Same Message-ID on every retry; the mailbox ignores a copy it has.'] });
      for (let i = 0; i < 8; i++) {
        rec.tries++;
        const r = yield ctx.call('api', 'deliver', { msg: { id, from: 'Omar', subject } }, { timeout: 1500 });
        if (r.ok) {
          ctx.state.acked[id] = ctx.now();
          rec.t = ctx.now();
          Y.L(ctx, { accepted: ['yes', `250 OK${rec.tries > 1 ? ` on try ${rec.tries}` : ''}.`], committed: [ctx.state.config.sync ? 'yes' : 'pending', ctx.state.config.sync ? `In ${ZNAME[r.value.zone]} and at least one other zone.` : `Only in ${ZNAME[r.value.zone]} for now; shipped to the others within ${ASYNC_MS} ms.`] });
          return;
        }
        ctx.state.tempfails++;
        ctx.log({ op: `451 for ${id}, Omar’s server will retry`, status: 'retry', detail: r.error.message });
        yield ctx.wait(600);
      }
      Y.failed(ctx, 'Gave up after 8 tries.');
    }, { self: 'api' });
  }
  function rollout(sim) {
    if (sim.state.push) return;
    sim.startAction('Ops: roll out storage release 2.4.1', function* (ctx) {
      const st = ctx.state;
      Y.L(ctx, { displayed: ['n/a', 'Operator action.'], retrySafe: ['n/a', '—'] });
      const r = yield ctx.call('deploy', 'push', { cell: st.config.canary ? 'canary' : 'maya' }, { timeout: 3000 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { accepted: ['yes', st.config.canary ? 'Canary cell first (1% of users).' : 'Every cell at once, Maya’s included.'], committed: ['yes', 'Release running.'], async: ['pending', `Health checks alarm within ${DETECT_MS / 1000} s if mail disappears.`] });
    }, { self: 'deploy' });
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'api', quiet: 'all' });

  /** Send entries to the other zones through the replication log. */
  function* replicate(ctx, from, entries) {
    return yield ctx.call('rlog', 'append', { from, entries }, { timeout: 900 });
  }
  function shipLater(ctx, from, entries) {
    ctx.spawn(function* (c) {
      yield c.wait(ASYNC_MS);
      if (c.sim.nodes[from].modes.down) return; // the unshipped entries died with the machine
      yield* replicate(c, from, entries);
    }, { self: from, quiet: 'all' });
  }
  function* commit(ctx, sid, e, failMsg) {
    const st = ctx.state;
    st.log.push(e);
    if (st.config.sync) {
      const r = yield* replicate(ctx, sid, [e]);
      if (!r.ok || r.value.acks < 1) { e.aborted = true; ctx.fail('TEMPFAIL', failMsg); }
    }
    apply(st.zones[sid], e);
    if (!st.config.sync) shipLater(ctx, sid, [e]);
  }

  function zoneHandlers(sid) {
    return {
      write: function* (ctx, p) {
        const st = ctx.state;
        if (st.primary !== sid) ctx.fail('NOT_PRIMARY', `${ZNAME[sid]} is not the primary.`);
        if (st.zones[sid].msgs[p.msg.id]) return { zone: sid, dup: true };
        const e = { seq: ++st.seq, t: ctx.now(), op: 'insert', msg: p.msg };
        yield* commit(ctx, sid, e, '451 4.3.0 Could not reach a second zone; try again later.');
        if (ctx.mode('crashAfterAck')) {
          ctx.sim.restore(sid, 'crashAfterAck');
          ctx.spawn(function* (c) {
            yield c.wait(1);
            c.sim.inject(sid, 'down');
            c.log({ op: `${ZNAME[sid]} primary crashed`, status: 'fault', detail: st.config.sync ? 'Everything it acknowledged is already in another zone.' : `It acknowledged ${p.msg.id} a moment ago and had not shipped it yet.` });
          }, { self: sid });
        }
        return { zone: sid, seq: e.seq };
      },
      upgrade: function* (ctx) {
        const st = ctx.state;
        const e = { seq: ++st.seq, t: ctx.now(), op: 'wipe', bad: true };
        st.badSeq = e.seq;
        st.emptyAt = ctx.now();
        ctx.log({ op: 'release 2.4.1 deletes Maya’s mail', status: 'fault', detail: 'A bug in the new storage code treats every message as unreferenced and deletes it. The deletion is an ordinary write, so it is replicated like any other.' });
        yield* commit(ctx, sid, e, 'replication failed');
        return { seq: e.seq };
      },
      restore: function* (ctx, p) {
        const st = ctx.state;
        const e = { seq: ++st.seq, t: ctx.now(), op: 'restore', msgs: p.msgs };
        yield* commit(ctx, st.primary, e, 'replication failed');
        if (st.emptyAt != null) { st.emptyMs = ctx.now() - st.emptyAt; st.emptyAt = null; }
        return { n: Object.keys(p.msgs).length };
      },
      ship(ctx, p) {
        const st = ctx.state;
        const z = st.zones[sid];
        for (const e of p.entries) if (e.seq > z.lastRecv) { z.recv.push(e); z.lastRecv = e.seq; }
        drain(st, sid, ctx.now());
        return { at: z.lastRecv };
      },
      snapshot(ctx) { const z = ctx.state.zones[sid]; return { seq: z.applied, msgs: Object.assign({}, z.msgs) }; },
      export(ctx, p) {
        const z = ctx.state.zones[sid];
        const msgs = Object.assign({}, z.msgs);
        for (const e of z.recv) if (e.seq < p.before && !e.bad && !e.aborted) {
          if (e.op === 'insert') msgs[e.msg.id] = e.msg;
          else if (e.op === 'restore') Object.assign(msgs, e.msgs);
        }
        return { msgs, applied: z.applied };
      },
    };
  }

  SDL.scenarios['gm-durability'] = {
    id: 'gm-durability',
    seed: 3203,
    minHopMs: 5,
    productWidth: 640,
    intro: 'Omar’s mail lands in three zones. Take a zone down, crash the primary with async shipping, or roll out a storage release that deletes mail, and see which copies can bring it back: replicas, an offline backup, or a delayed replica.',
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'phone', label: 'Maya’s phone', sub: 'Gmail app', kind: 'client', x: 90, y: 280, latency: 1, role: 'Shows the inbox as the primary holds it.', owns: ['Nothing durable'] },
        { id: 'api', label: 'Gmail frontend', sub: 'Mail in, mail out', kind: 'gateway', x: 275, y: 280, latency: 3, role: 'Takes Omar’s message (SMTP) and writes it to whichever zone is primary. Answers 451 if the write fails, so the sender retries.', ops: [{ name: 'deliver', desc: 'Write a message.' }], owns: ['Nothing durable'] },
        { id: 'pri', label: 'Mailbox, zone A', sub: 'Primary', kind: 'db', x: 480, y: 110, latency: 3, role: 'The primary copy. Writes go here, then to the replication log.', ops: [{ name: 'write', desc: 'Insert a message.' }, { name: 'restore', desc: 'Put recovered messages back.' }], owns: ['Maya’s mailbox'] },
        { id: 'repB', label: 'Mailbox, zone B', sub: 'Replica', kind: 'db', x: 480, y: 280, latency: 3, role: 'Applies the log as it arrives. First choice for failover; the backup job copies from it.', ops: [{ name: 'ship', desc: 'Receive log entries.' }, { name: 'snapshot', desc: 'A consistent copy for backup.' }], owns: ['A copy of the mailbox'] },
        { id: 'repC', label: 'Mailbox, zone C', sub: 'Replica', kind: 'db', x: 480, y: 450, latency: 3, role: `A replica. As a delayed replica it stores entries at once (they count for the quorum) but applies them only ${DELAY_MS / 1000} s later, so it can be stopped before a bad change.`, ops: [{ name: 'ship', desc: 'Receive log entries.' }, { name: 'export', desc: 'Its state before a given point.' }], owns: ['A copy of the mailbox'] },
        { id: 'rlog', label: 'Replication log', sub: 'Quorum across zones', kind: 'queue', x: 700, y: 280, latency: 2, role: 'Carries every write from the primary to the replicas in order and reports how many zones have it. Also holds the lease that decides who is primary.', ops: [{ name: 'append', desc: 'Replicate entries.' }], owns: ['log entries', `${LOG_RET_MS / 1000} s of history`, 'primary lease'] },
        { id: 'deploy', label: 'Deploy system', sub: 'Storage releases', kind: 'service', x: 920, y: 110, latency: 5, role: 'Rolls out new storage software, to a canary cell first when staged.', ops: [{ name: 'push', desc: 'Roll out a release.' }], owns: ['Rollout state'] },
        { id: 'restore', label: 'Restore service', sub: 'Recovery', kind: 'worker', x: 920, y: 280, latency: 5, role: 'When mail disappears, rebuilds the mailbox from a source the bug did not touch: the delayed replica if there is one, else the newest offline backup before the push plus log replay.', ops: [{ name: 'run', desc: 'Recover a mailbox.' }], owns: ['Nothing'] },
        { id: 'backup', label: 'Backup job', sub: `Every ${BACKUP_EVERY / 1000} s`, kind: 'worker', x: 700, y: 450, latency: 3, role: 'Copies a snapshot from zone B to offline storage.', owns: ['Nothing'] },
        { id: 'vault', label: 'Offline backups', sub: 'Separate software, slow', kind: 'store', x: 920, y: 450, latency: 900, role: 'Snapshots on a separate system (tape, in 2011) that no storage release touches. Slow to read back.', ops: [{ name: 'read', desc: 'Newest snapshot before a point.' }, { name: 'put', desc: 'Store a snapshot.' }], owns: ['snapshots'] },
      ],
      edges: [
        { from: 'phone', to: 'api', latency: 40 },
        { from: 'api', to: 'pri', latency: 3, via: [[385, 280], [385, 110]] },
        { from: 'api', to: 'repB', latency: 3 },
        { from: 'api', to: 'repC', latency: 3, via: [[385, 280], [385, 450]] },
        { from: 'pri', to: 'rlog', latency: 4, via: [[600, 110], [600, 280]] },
        { from: 'repB', to: 'rlog', latency: 4 },
        { from: 'repC', to: 'rlog', latency: 4, via: [[600, 450], [600, 280]] },
        { from: 'deploy', to: 'pri', latency: 3 },
        { from: 'restore', to: 'pri', latency: 3, via: [[920, 190], [480, 190]] },
        { from: 'restore', to: 'repC', latency: 3, via: [[1040, 280], [1040, 520], [480, 520]] },
        { from: 'restore', to: 'vault', latency: 3 },
        { from: 'backup', to: 'repB', latency: 3, via: [[700, 365], [480, 365]] },
        { from: 'backup', to: 'vault', latency: 3 },
      ],
    },
    modeLabels: { crashAfterAck: 'Crashes after the next ack', partitioned: 'Cut off from zones B and C' },
    failures: [
      { id: 'zone-a-down', node: 'pri', mode: 'down', label: 'Zone A down', desc: 'The primary’s zone goes dark; after the lease expires zone B takes over.' },
      { id: 'primary-crash', node: 'pri', mode: 'crashAfterAck', label: 'Primary crashes after an ack', desc: 'Zone A acknowledges the next message and dies a millisecond later.' },
      { id: 'lag', node: 'repB', mode: 'slow', params: { factor: 40 }, label: 'Replica B slow', desc: 'Zone B applies the log slowly.' },
      { id: 'backup-paused', node: 'backup', mode: 'paused', label: 'Backup job stuck', desc: 'No new snapshots reach offline storage.' },
      { id: 'restore-slow', node: 'restore', mode: 'slow', params: { factor: 20 }, label: 'Restore slow', desc: 'Recovery takes much longer.' },
      { id: 'partition', node: 'pri', mode: 'partitioned', label: 'Zone A partitioned', desc: 'Zone A is up but cannot reach zones B and C. It keeps the lease, so no failover.' },
      { id: 'zone-c-down', node: 'repC', mode: 'down', label: 'Zone C down', desc: 'One replica is gone; quorum still works with A and B.' },
    ],
    switches: Y.switches([
      ['sync', 'Synchronous quorum ack', 'Acknowledge a message only once a second zone has it. Off: acknowledge at once and ship to the replicas a moment later.'],
      ['canary', 'Staged rollout with canary', 'New storage releases go to a 1% canary cell first and stop if health checks fail. Off: every cell at once.'],
      ['offline', 'Offline backups', 'Snapshots on a separate system the storage software cannot touch, plus the replication log for replay.'],
      ['delayed', 'Delayed replica', `Zone C applies changes ${DELAY_MS / 1000} s late, so a bad change can be stopped before it lands there.`],
    ]),
    presets: Y.presets({ sync: true, canary: true, offline: true, delayed: true }, [
      { id: 'normal', label: 'Two emails, three zones', desc: 'Omar sends two emails. Each is acknowledged once a second zone has it; all three zones end with the same mailbox, and the backup job keeps copying snapshots offline.', run: (s) => { omar(s, 'Contract draft'); later(s, 500, (x) => omar(x, 'Dinner on Friday')); } },
      { id: 'zone-down-sync', label: 'Zone A goes dark, quorum ack', desc: 'Omar’s first email is in zones A and B. Zone A goes down; the lease moves to zone B, which already has everything acknowledged. His second email goes to zone B.', run: (s) => { omar(s, 'Contract draft'); later(s, 400, (x) => x.inject('pri', 'down')); later(s, 1500, (x) => omar(x, 'Dinner on Friday')); } },
      { id: 'async-primary-crash', label: 'Primary crashes right after an async ack', desc: 'With async shipping, zone A answers 250 at once and dies a millisecond later, before shipping. Zone B takes over without the message. Omar’s server deleted its copy on the 250: the email is gone.', sw: { sync: false }, run: (s) => { s.inject('pri', 'crashAfterAck'); omar(s, 'Contract draft'); } },
      { id: 'sync-primary-crash', label: 'Same crash, quorum ack', desc: 'Same crash. The 250 was sent only after zone B had the message, so when zone B takes over the email is there.', run: (s) => { s.inject('pri', 'crashAfterAck'); omar(s, 'Contract draft'); } },
      { id: 'bad-push-replicas-only', label: 'Bad release, replicas only', desc: 'A storage release deletes Maya’s mail. The deletion is an ordinary write, so both replicas apply it. No canary, no offline backup, no delayed replica: every copy is empty and there is nothing to restore from.', sw: { canary: false, offline: false, delayed: false }, run: (s) => { omar(s, 'Contract draft'); later(s, 300, (x) => omar(x, 'Dinner on Friday')); later(s, 1500, (x) => rollout(x)); } },
      { id: 'bad-push-offline', label: 'Bad release, offline backup', desc: 'Same release. The restore service reads the newest snapshot from before the push out of offline storage and replays the log up to the push. Everything comes back, but slowly: the inbox is empty for seconds here, days in 2011.', sw: { canary: false, delayed: false }, run: (s) => { omar(s, 'Contract draft'); later(s, 300, (x) => omar(x, 'Dinner on Friday')); later(s, 1500, (x) => rollout(x)); } },
      { id: 'bad-push-canary', label: 'Bad release, canary first', desc: 'The release goes to the canary cell (1% of users) first. Health checks see mail disappear and stop the rollout; Maya’s cell never gets it. The canary users are restored from offline backups.', sw: { delayed: false }, run: (s) => { omar(s, 'Contract draft'); later(s, 300, (x) => omar(x, 'Dinner on Friday')); later(s, 1500, (x) => rollout(x)); } },
      { id: 'bad-push-delayed', label: 'Bad release, delayed replica', desc: `Same release, no canary. Zone C applies changes ${DELAY_MS / 1000} s late, so when the alarm fires a second later the deletion has not reached it. The restore service stops zone C and copies its mailbox back: restored in well under a second.`, sw: { canary: false }, run: (s) => { omar(s, 'Contract draft'); later(s, 300, (x) => omar(x, 'Dinner on Friday')); later(s, 1500, (x) => rollout(x)); } },
      { id: 'backup-stuck-bad-push', label: 'Backup job stuck, then a bad release', desc: `The backup job has been stuck, so the newest offline snapshot is old. When the release deletes mail, the restore replays the log from that snapshot, but the log keeps only ${LOG_RET_MS / 1000} s. Omar’s two emails fall in the gap and are gone.`, sw: { canary: false, delayed: false }, run: (s) => { s.inject('backup', 'paused'); omar(s, 'Contract draft'); later(s, 300, (x) => omar(x, 'Dinner on Friday')); later(s, 5000, (x) => rollout(x)); } },
      { id: 'partition', label: 'Zone A cut off, quorum ack', desc: 'Zone A is up but cannot reach the other zones for two seconds. It cannot get a second copy, so it answers 451 instead of 250; Omar’s server retries and the email lands once the partition heals. Late, never lost.', run: (s) => { s.inject('pri', 'partitioned', true, 2000); later(s, 200, (x) => omar(x, 'Contract draft')); } },
    ]),
    initialState,
    initialUI: () => ({}),
    actions: {
      omar(sim, a) { omar(sim, a.subject || 'Contract draft'); },
      rollout(sim) { rollout(sim); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        deliver: function* (ctx, p) {
          const st = ctx.state;
          const r = yield ctx.call(st.primary, 'write', p, { timeout: 1200 });
          if (!r.ok) ctx.fail('TEMPFAIL', r.error.code === 'TEMPFAIL' ? r.error.message : `451 4.3.0 ${ZNAME[st.primary]} is not answering; try again later.`);
          return r.value;
        },
      },
      pri: zoneHandlers('pri'),
      repB: zoneHandlers('repB'),
      repC: zoneHandlers('repC'),
      rlog: {
        append: function* (ctx, p) {
          const st = ctx.state;
          if (ctx.mode('partitioned', p.from)) ctx.fail('PARTITION', `${ZNAME[p.from]} cannot reach the other zones.`);
          const peers = st.members.filter((z) => z !== p.from && !(ctx.sim.nodes[z].modes.down));
          const procs = peers.map((z) => ctx.spawn(function* (c) { return yield c.call(z, 'ship', { entries: p.entries }, { timeout: 400, quiet: 'all' }); }, { self: 'rlog' }));
          const rs = yield ctx.join(procs);
          return { acks: rs.filter((x) => x.value && x.value.ok).length };
        },
      },
      deploy: {
        push: function* (ctx, p) {
          const st = ctx.state;
          st.push = { t: ctx.now(), cell: p.cell, halted: false };
          if (p.cell === 'canary') {
            st.canary = { state: 'lost', t: ctx.now() };
            ctx.log({ op: 'release 2.4.1 on the canary cell: mail disappearing', status: 'fault', detail: 'The bug hits the canary cell (1% of users) only.' });
            ctx.spawn(function* (c) {
              yield c.wait(DETECT_MS);
              st.push.halted = true;
              c.log({ op: 'health check failed: rollout halted at the canary', status: 'ok', detail: 'Mail vanished in the canary cell, so the release never reaches the other 99%.' });
              if (!st.config.offline) { st.canary.state = 'unrecoverable'; return; }
              const r = yield c.call('vault', 'read', { before: 1e9 }, { timeout: 20000 });
              if (r.ok) { st.canary = { state: 'restored', t: st.canary.t, t1: c.now() }; c.log({ op: 'canary cell restored from offline backups', status: 'ok' }); }
            }, { self: 'deploy' });
            return { cell: 'canary' };
          }
          ctx.must(yield ctx.call(st.primary, 'upgrade', {}, { timeout: 1500 }));
          ctx.spawn(function* (c) {
            yield c.wait(DETECT_MS);
            c.log({ op: 'alarm: mailboxes emptied after release 2.4.1', status: 'fault', detail: 'Rollback stops the bug, but the deleted mail has to be restored from somewhere.' });
            yield c.call('restore', 'run', {}, { timeout: 30000 });
          }, { self: 'deploy' });
          return { cell: 'maya' };
        },
      },
      restore: {
        run: function* (ctx) {
          const st = ctx.state;
          const bad = st.badSeq;
          st.restore = { state: 'running', t0: ctx.now(), source: null, lost: [] };
          let msgs;
          if (st.config.delayed && st.primary !== 'repC' && st.zones.repC.applied < bad && !ctx.sim.nodes.repC.modes.down) {
            st.frozenC = true;
            st.restore.source = 'delayed';
            ctx.log({ op: 'zone C apply stopped before the bad change', status: 'ok', detail: `Zone C is ${DELAY_MS / 1000} s behind; the deletion is in its log but not applied.` });
            msgs = ctx.must(yield ctx.call('repC', 'export', { before: bad }, { timeout: 2000 })).msgs;
          } else if (st.config.offline) {
            st.restore.source = 'backup';
            const snap = ctx.must(yield ctx.call('vault', 'read', { before: bad }, { timeout: 20000 }));
            msgs = Object.assign({}, snap.msgs);
            const horizon = ctx.now() - LOG_RET_MS;
            for (const e of st.log) {
              if (e.seq <= snap.seq || e.seq >= bad || e.aborted || e.bad) continue;
              if (e.t < horizon) { if (e.op === 'insert') st.restore.lost.push(e.msg.id); continue; }
              if (e.op === 'insert') msgs[e.msg.id] = e.msg;
              else if (e.op === 'restore') Object.assign(msgs, e.msgs);
            }
            if (st.restore.lost.length) ctx.log({ op: `log replay gap: ${st.restore.lost.length} messages unrecoverable`, status: 'fault', detail: `The newest snapshot is from history ${snap.seq}; the log only goes back ${LOG_RET_MS / 1000} s. Anything in between is gone.` });
          } else {
            st.restore = { state: 'impossible', t0: ctx.now(), source: null, lost: [] };
            ctx.log({ op: 'nothing to restore from', status: 'fault', detail: 'Every replica applied the deletion. Replicas protect against losing a machine or a zone, not against a bad write.' });
            return { source: null };
          }
          for (const e of st.log) if (e.seq > bad && e.op === 'insert' && !e.aborted) msgs[e.msg.id] = e.msg; // mail that arrived after the push
          ctx.must(yield ctx.call(st.primary, 'restore', { msgs }, { timeout: 2000 }));
          st.skipBad = true;
          st.frozenC = false;
          st.restore.state = 'done';
          st.restore.t1 = ctx.now();
          return { source: st.restore.source };
        },
      },
      vault: {
        read(ctx, p) {
          const snaps = ctx.state.vault.filter((s) => s.seq < p.before);
          const s = snaps[snaps.length - 1];
          return { seq: s.seq, t: s.t, msgs: Object.assign({}, s.msgs) };
        },
        put(ctx, p) { const v = ctx.state.vault; v.push({ seq: p.seq, t: ctx.now(), msgs: p.msgs }); if (v.length > 6) v.splice(1, 1); return {}; },
      },
    },
    setup(sim) {
      // Delayed replica: apply entries once they are old enough.
      sim.spawn(function* (ctx) {
        for (;;) { yield ctx.wait(50); drain(ctx.state, 'repC', ctx.now()); }
      }, { self: 'repC', quiet: 'all' });
      // Lease: when the primary’s zone is down, the most up-to-date replica takes over; a zone that comes back rejoins.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const st = ctx.state;
          if (ctx.sim.nodes[st.primary].modes.down) {
            const old = st.primary;
            yield ctx.wait(FAILOVER_MS);
            const up = st.members.filter((z) => z !== old && !ctx.sim.nodes[z].modes.down);
            if (!up.length) continue;
            for (const z of up) { const zz = st.zones[z]; while (zz.recv.length) apply(zz, zz.recv.shift()); }
            const next = up.sort((a, b) => st.zones[b].applied - st.zones[a].applied || (a < b ? -1 : 1))[0];
            st.primary = next;
            st.members = st.members.filter((z) => z !== old);
            const lost = Object.keys(st.acked).filter((id) => !st.zones[next].msgs[id]);
            st.crashLost.push(...lost);
            st.failovers.push({ from: old, to: next, t: ctx.now() });
            ctx.log({ op: `failover: ${ZNAME[next]} is primary`, status: lost.length ? 'fault' : 'ok', detail: lost.length ? `${ZNAME[old]} had acknowledged ${lost.join(', ')} without shipping it. ${ZNAME[next]} never saw it.` : `${ZNAME[next]} has every acknowledged message.` });
          }
          for (const z of ZONES) if (!st.members.includes(z) && !ctx.sim.nodes[z].modes.down) {
            st.zones[z] = { msgs: Object.assign({}, st.zones[st.primary].msgs), applied: st.zones[st.primary].applied, recv: [], lastRecv: st.seq };
            st.members.push(z);
            ctx.log({ op: `${ZNAME[z]} rejoined as a replica`, status: 'ok' });
          }
        }
      }, { self: 'rlog', quiet: 'all' });
      // Backups: copy a snapshot of zone B offline.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(BACKUP_EVERY);
          const n = ctx.sim.nodes.backup;
          if (!ctx.state.config.offline || n.modes.paused || n.modes.down) continue;
          const src = ctx.state.members.includes('repB') ? 'repB' : ctx.state.primary;
          const s = yield ctx.call(src, 'snapshot', {}, { timeout: 800, quiet: 'all' });
          if (s.ok) ctx.spawn(function* (c) { yield c.call('vault', 'put', s.value, { timeout: 4000, quiet: 'all' }); }, { self: 'backup', quiet: 'all' });
        }
      }, { self: 'backup', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const P = st.zones[st.primary];
      const lost = Object.keys(st.acked).filter((id) => !P.msgs[id]);
      const name = (id) => { const m = st.log.find((e) => e.op === 'insert' && e.msg.id === id); return m ? `“${m.msg.subject}”` : id; };
      if (st.restore && st.restore.state === 'running') return { key: 'stale', label: `Maya’s inbox is empty while the restore service rebuilds it from ${st.restore.source === 'delayed' ? 'the delayed replica' : 'offline backups plus the log'}.` };
      if (st.badSeq && !st.restore && st.emptyAt != null) return { key: 'stale', label: 'Maya’s inbox just emptied; the health check has not fired yet.' };
      if (lost.length) {
        const which = lost.map(name).join(' and ');
        if (st.restore && st.restore.state === 'impossible') return { key: 'wrong', label: `All ${lost.length} of Maya’s messages are gone from all three zones, Omar’s two included: the release’s deletion was replicated like any write, and there is no copy the bug could not reach.` };
        if (st.restore && st.restore.lost.length) return { key: 'wrong', label: `${which} ${lost.length === 1 ? 'is' : 'are'} gone for good: the newest offline snapshot predates ${lost.length === 1 ? 'it' : 'them'} (the backup job was stuck) and the log no longer goes back that far.` };
        if (st.crashLost.length) return { key: 'wrong', label: `${which} was acknowledged with 250 and then lost: zone A crashed before shipping it, and zone B took over without it. Omar’s server deleted its copy on the 250.` };
        return { key: 'wrong', label: `${which} ${lost.length === 1 ? 'was' : 'were'} acknowledged but ${lost.length === 1 ? 'is' : 'are'} missing.` };
      }
      if (st.canary.state === 'unrecoverable') return { key: 'wrong', label: 'The canary cell’s users (1%) lost their mail and there is no offline backup to restore it from. Maya’s cell is fine.' };
      if (st.canary.state === 'lost') return { key: 'stale', label: 'The canary cell (1% of users) lost mail and is being restored; the rollout is halted, so Maya’s cell never got the release.' };
      if (st.canary.state === 'restored') return { key: 'stale', label: `The canary cell (1% of users) had no mail for ${SDL.fmtMs(st.canary.t1 - st.canary.t)} until offline backups brought it back. Health checks stopped the rollout, so Maya and the other 99% never got the release.` };
      if (st.restore && st.restore.state === 'done' && st.emptyMs > FAST_OK) return { key: 'stale', label: `Everything is back, but Maya’s inbox was empty for ${SDL.fmtMs(st.emptyMs)} while offline backups were read and the log replayed. (In February 2011, a bug like this took Gmail days to restore from tape.)` };
      const late = st.sends.find((s) => s.tries > 1);
      if (late) return { key: 'stale', label: `Omar’s “${late.subject}” got 451 ${late.tries - 1} time${late.tries > 2 ? 's' : ''} ${st.failovers.length ? 'during the failover' : 'while zone A could not reach a second zone'} and landed ${SDL.fmtMs(late.t - late.t0)} after the first try. Late, never lost: nothing was acknowledged until it was in two zones.` };
      const pend = st.sends.find((s) => s.t == null);
      if (pend) return { key: 'stale', label: `Omar’s “${pend.subject}” is still being retried.` };
      const behind = st.members.filter((z) => z !== st.primary && !(z === 'repC' && st.config.delayed) && st.zones[z].applied < P.applied);
      if (behind.length) return { key: 'stale', label: `${behind.map((z) => ZNAME[z]).join(' and ')} ${behind.length === 1 ? 'is' : 'are'} catching up with the primary.` };
      const notes = [];
      if (st.failovers.length) notes.push(`${ZNAME[st.failovers[0].to]} took over from ${ZNAME[st.failovers[0].from]} with every acknowledged message`);
      if (st.restore && st.restore.state === 'done') notes.push(`the delayed replica brought the mail back ${SDL.fmtMs(st.emptyMs)} after the bad release`);
      return { key: 'ok', label: `Every acknowledged message is in Maya’s mailbox (${Object.keys(P.msgs).length} messages, ${st.members.length} zones)${notes.length ? `; ${notes.join('; ')}` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const P = st.zones[st.primary];
      const lost = Object.keys(st.acked).filter((id) => !P.msgs[id]).length;
      const last = st.vault[st.vault.length - 1];
      return [
        { label: 'Primary', value: ZNAME[st.primary] },
        { label: 'Messages (primary)', value: Object.keys(P.msgs).length },
        { label: 'Acknowledged, missing', value: lost, tone: lost ? 'fail' : '' },
        { label: 'Zones with a copy', value: st.members.filter((z) => Object.keys(st.zones[z].msgs).length).length },
        { label: 'Zone C behind', value: `${Math.max(0, st.seq - st.zones.repC.applied)} entries` },
        { label: 'Newest backup', value: `${SDL.fmtMs(Math.max(0, sim.now - last.t))} old`, tone: sim.now - last.t > LOG_RET_MS ? 'warn' : '' },
        { label: 'Inbox empty for', value: st.emptyMs != null ? SDL.fmtMs(st.emptyMs) : st.emptyAt != null ? 'now' : '–', tone: st.emptyAt != null || st.emptyMs > FAST_OK ? 'warn' : '' },
        { label: '451 retries', value: st.tempfails },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone']], {
          note: 'The phone shows the mailbox as the primary holds it. The console shows each zone, the backups, and the rollout.',
          side: '<div data-ref="ops"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const P = st.zones[st.primary];
        const down = sim.nodes[st.primary].modes.down;
        const msgs = Object.values(P.msgs).slice().reverse();
        Y.paint(el, sim, 'phone', {
          head: `<div><p class="app-title">Inbox · ${msgs.length}</p><p class="app-sub">served by ${ZNAME[st.primary]}</p></div>`,
          list: down ? Y.msg('Connecting…', 'warn') : msgs.length ? msgs.slice(0, 6).map((m) => `<div class="app-card ${m.from === 'Omar' ? 'is-ok' : ''}"><strong>${esc(m.from)}</strong><span class="app-sub">${esc(m.subject)}</span></div>`).join('') : `${Y.msg('Your inbox is empty.', st.badSeq ? 'fail' : '')}`,
        }, {});
        const c = sim.scenario.consistency(sim);
        const zoneRow = (z) => {
          const n = sim.nodes[z];
          const zz = st.zones[z];
          const role = z === st.primary ? 'primary' : st.members.includes(z) ? (z === 'repC' && st.config.delayed ? `replica, ${DELAY_MS / 1000} s delayed${st.frozenC ? ' (stopped)' : ''}` : 'replica') : 'out';
          return `<div class="ops-row" data-tone="${n.modes.down || n.modes.partitioned ? 'fail' : !Object.keys(zz.msgs).length ? 'warn' : ''}"><div class="ops-name">${ZNAME[z][0].toUpperCase()}${ZNAME[z].slice(1)} · ${n.modes.down ? '✕ down' : n.modes.partitioned ? '✕ cut off' : role}<span>${Object.keys(zz.msgs).length} messages · history ${zz.applied}</span></div></div>`;
        };
        const last = st.vault[st.vault.length - 1];
        const rollout = !st.push ? 'not started' : st.push.cell === 'canary' ? (st.push.halted ? 'halted at the canary (1%)' : 'canary cell (1%)') : 'every cell';
        SDL.ui.paintSections(el.querySelector('[data-ref="ops"]'), {
          title: '<p class="ops-title">Storage operations</p>',
          btns: `<div class="app-row">${Y.btn('omar', '✉ Omar emails Maya', { arg: { subject: `Note ${st.oseq + 1}` }, cls: 'secondary' })}${Y.btn('rollout', 'Roll out release 2.4.1', { cls: 'secondary', disabled: !!st.push })}</div>`,
          rows: `<div class="ops-shards">${ZONES.map(zoneRow).join('')}
            <div class="ops-row" data-tone="${sim.now - last.t > LOG_RET_MS ? 'warn' : ''}"><div class="ops-name">Offline backups${st.config.offline ? '' : ' · off'}<span>newest: history ${last.seq}, ${SDL.fmtMs(Math.max(0, sim.now - last.t))} ago</span></div></div>
            <div class="ops-row" data-tone="${st.push && !st.push.halted && st.push.cell !== 'canary' ? 'fail' : ''}"><div class="ops-name">Release 2.4.1<span>${rollout}${st.restore ? ` · restore ${st.restore.state}${st.restore.source ? ` from ${st.restore.source === 'delayed' ? 'zone C' : 'backup'}` : ''}` : ''}</span></div></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
