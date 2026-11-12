/*
 * Document ownership, failover, and regions.
 * Exactly one session server may sequence a document at a time. A
 * coordination service hands out a lease with a fencing token; the owner
 * renews it with heartbeats. When the owner crashes or stalls, the lease
 * expires, another server takes over with a higher token and rebuilds the
 * document from the log. The log refuses writes carrying an old token, which
 * is what stops a stalled owner that wakes up from writing as if nothing
 * happened. Ben edits from another region; a partition shows why a region
 * must not promote itself.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const OT = Y.ot;

  const PEOPLE = { ana: 'Ana', ben: 'Ben' };
  const DOC0 = 'Q3 plan: ship the editor.';
  const WORDS = { ana: [' Hire two.', ' Launch in May.', ' Budget: flat.'], ben: [' Fix sync.', ' Add tests.', ' Ship it.'] };
  const SERVERS = ['sessA', 'sessB'];
  const HB_MS = 800;
  const leaseMs = (st) => (st.config.longLease ? 10000 : 2500);
  const region = { sessA: 'US', sessB: 'US', sessEU: 'EU', ana: 'US', ben: 'EU' };

  /* ---------- clients ---------- */
  function startType(sim, who) {
    const st = sim.state;
    const u = sim.ui[who];
    const word = WORDS[who][u.typed++ % WORDS[who].length];
    const op = { pos: u.text.length, ins: word };
    sim.startAction(`${PEOPLE[who]} (${region[who]}): type “${word.trim()}”`, function* (ctx) {
      u.text = OT.apply(u.text, op);
      const e = { clientId: `${who}-${++st.seq.client}`, op, applied: true };
      u.outstanding.push(e);
      u.status = 'saving';
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const t0 = ctx.now();
      const r = yield* flush(ctx, who);
      if (r.ok) { Y.L(ctx, { accepted: ['yes', `Revision ${r.rev} by ${ctx.sim.nodes[r.owner].label}, token ${r.token}.`], committed: 'yes', async: 'pending' }); ctx.explain(r.explain || `${PEOPLE[who]}’s edit went to ${ctx.sim.nodes[r.owner].label} (lease token ${r.token}) and became revision ${r.rev}, ${SDL.fmtMs(ctx.now() - t0)} after the keystroke${who === 'ben' ? ', most of it the trip between regions' : ''}.`); }
      else { Y.L(ctx, { accepted: ['no', r.error.message], committed: 'no', async: 'n/a' }); ctx.explain(r.explain || `Not saved: ${r.error.message}`); }
    }, { self: who });
  }
  function* flush(ctx, who) {
    const st = ctx.state;
    const u = ctx.ui[who];
    if (u.sending) { while (u.outstanding.length && u.sending) yield ctx.wait(50); return u.lastResult || { ok: true, rev: u.rev }; }
    u.sending = true;
    let last = { ok: true, rev: u.rev };
    try {
      while (u.outstanding.length) {
        const e = u.outstanding[0];
        let r;
        for (let attempt = 1; attempt <= 8; attempt++) {
          r = yield ctx.call('gw', 'submit', { clientId: e.clientId, baseRev: u.rev, op: e.op, who }, { timeout: 2000 });
          ctx.recordOutcome(r.ok, r.latency);
          if (r.ok) break;
          if (['TIMEOUT', 'UNAVAILABLE', 'NOT_OWNER', 'NO_OWNER', 'FENCED'].includes(r.error.code)) { ctx.log({ op: `retrying after ${r.error.code}`, status: 'retry', error: r.error, detail: 'The same client id is used, so a commit that did happen is returned, not repeated.' }); st.stats.retries++; yield ctx.wait(Math.min(1500, 250 * attempt)); continue; }
          break;
        }
        if (!r.ok) { u.status = 'unsaved'; last = { ok: false, error: r.error }; break; }
        if (r.value.rev > u.rev + 1) { const b = yield ctx.call('gw', 'since', { rev: u.rev, upto: r.value.rev - 1 }, { timeout: 900 }); if (b.ok) for (const row of b.value.ops) applyRemote(ctx, who, row); }
        u.outstanding.shift(); u.ownIds[e.clientId] = true; u.rev = Math.max(u.rev, r.value.rev);
        last = { ok: true, rev: r.value.rev, owner: r.value.owner, token: r.value.token, explain: r.value.explain };
      }
      if (!u.outstanding.length) u.status = 'saved';
    } finally { u.sending = false; u.lastResult = last; }
    return last;
  }
  function applyRemote(ctx, who, row) {
    const u = ctx.ui[who];
    if (row.rev <= u.rev && !row.dup) return false;
    u.rev = Math.max(u.rev, row.rev);
    if (u.ownIds[row.clientId] || row.who === who) return true;
    let op = row.op;
    for (const e of u.outstanding) { const mine = e.op; e.op = OT.transform(mine, op, false); op = OT.transform(op, mine, true); }
    u.text = OT.apply(u.text, op);
    return true;
  }

  /* ---------- session servers ---------- */
  function sessionHandlers(id) {
    return {
      submit: function* (ctx, p) {
        const st = ctx.state;
        const me = st.servers[id];
        if (ctx.mode('pause')) { const t0 = ctx.now(); while (ctx.mode('pause')) yield ctx.wait(100); ctx.log({ op: `resumed after a ${SDL.fmtMs(ctx.now() - t0)} stall`, status: 'recovered', detail: 'The server picks up exactly where it stopped, still believing it owns the document.' }); }
        if (!me.owner) {
          // Try to take the lease; fail if someone else holds it.
          const g = yield ctx.call('coord', 'acquire', { server: id }, { timeout: 700 });
          if (!g.ok) ctx.fail('NO_OWNER', `${ctx.sim.nodes[id].label} cannot reach the coordination service to take the lease.`);
          if (!g.value.granted) ctx.fail('NOT_OWNER', `${ctx.sim.nodes[g.value.holder].label} holds the lease until ${g.value.until} ms.`, { holder: g.value.holder });
          yield* takeOver(ctx, id, g.value.token);
        }
        if (me.byClient[p.clientId] != null) { const row = me.log.find((r) => r.rev === me.byClient[p.clientId]); return { rev: row.rev, op: row.op, owner: id, token: me.token, replayed: true }; }
        while (me.busy) yield ctx.wait(5);
        me.busy = true;
        try {
          let op = p.op;
          for (const r of me.log.filter((x) => x.rev > p.baseRev)) op = OT.transform(op, r.op, false);
          const rev = me.rev + 1;
          const row = { rev, op, who: p.who, clientId: p.clientId, token: me.token, server: id };
          const w = yield ctx.call('oplog', 'append', row, { timeout: 900 });
          if (!w.ok) {
            if (w.error.code === 'FENCED') { me.owner = false; st.stats.fenced++; ctx.log({ op: 'write fenced: this server no longer owns the document', status: 'err', detail: `The log holds token ${w.error.detail.current}; this server wrote with ${me.token}. It steps down; the client retries against the new owner.` }); ctx.fail('NOT_OWNER', 'Fenced: a newer owner exists.'); }
            ctx.fail(w.error.code, w.error.message);
          }
          me.rev = rev; me.text = OT.apply(me.text, op); me.log.push(row); me.byClient[p.clientId] = rev;
          st.stats.ops++;
          ctx.sim.enqueue('bcast', { type: `rev ${rev}`, eventId: `${id}-r${rev}`, payload: Object.assign({}, row) });
          return { rev, op, owner: id, token: me.token };
        } finally { me.busy = false; }
      },
      since(ctx, p) { const me = ctx.state.servers[id]; return { ops: me.log.filter((r) => r.rev > p.rev && (p.upto == null || r.rev <= p.upto)) }; },
    };
  }
  /** A server becomes owner: rebuild its copy from the log. */
  function* takeOver(ctx, id, token) {
    const st = ctx.state;
    const me = st.servers[id];
    const t0 = ctx.now();
    const r = yield ctx.call('oplog', 'read', { token }, { timeout: 1500 });
    if (!r.ok) ctx.fail('UNAVAILABLE', 'Cannot rebuild the document: the log is unreachable.');
    me.log = r.value.rows.slice(); me.rev = me.log.length ? me.log[me.log.length - 1].rev : 0;
    me.text = DOC0; for (const row of me.log) me.text = OT.apply(me.text, row.op);
    me.byClient = {}; for (const row of me.log) me.byClient[row.clientId] = row.rev;
    me.owner = true; me.token = token;
    if (st.failedAt != null) { st.stats.failoverMs = ctx.now() - st.failedAt; st.failedAt = null; }
    st.stats.takeovers++;
    ctx.log({ op: `took over the document with token ${token}`, status: 'recovered', detail: `Rebuilt revision ${me.rev} from ${me.log.length} logged operations in ${SDL.fmtMs(ctx.now() - t0)}.` });
  }

  SDL.scenarios['docs-sessions'] = {
    id: 'docs-sessions',
    seed: 606,
    productWidth: 640,
    intro: 'Type on both phones, then crash session server A and watch B take over. Then stall A instead of crashing it, with and without fencing tokens, and partition the EU region.',
    modeLabels: { pause: 'Stalled (long GC pause)', partition: 'Cut off from the US' },
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'ana', label: 'Ana’s phone', sub: 'US', kind: 'client', x: 90, y: 110, latency: 1, role: 'Edits from the region where the document lives.', ops: [{ name: 'push', desc: 'A remote operation.' }], owns: ['Local copy'] },
        { id: 'ben', label: 'Ben’s phone', sub: 'EU, 120 ms away', kind: 'client', x: 90, y: 470, latency: 1, role: 'Edits from another region. Every operation crosses the ocean to the owner.', ops: [{ name: 'push', desc: 'A remote operation.' }], owns: ['Local copy'] },
        { id: 'gw', label: 'Document router', sub: 'Finds the owner', kind: 'gateway', x: 330, y: 290, latency: 2, role: 'Asks the coordination service which server owns the document (cached briefly) and forwards operations there.', ops: [{ name: 'submit', desc: 'Route an operation.' }, { name: 'since', desc: 'Backfill.' }], owns: ['Owner cache'] },
        { id: 'coord', label: 'Coordination service', sub: 'Leases and tokens', kind: 'db', x: 580, y: 80, latency: 5, role: 'Holds one lease per document: holder, expiry, and a token that increases on every change of owner.', ops: [{ name: 'acquire', desc: 'Take the lease if free or expired.' }, { name: 'renew', desc: 'Heartbeat.' }, { name: 'lookup', desc: 'Who owns it?' }], owns: ['lease[doc]'] },
        { id: 'sessA', label: 'Session server A', sub: 'US · owner at start', kind: 'service', x: 580, y: 230, latency: 4, role: 'Sequences the document while it holds the lease. Renews the lease every 0.8 s.', ops: [{ name: 'submit', desc: 'Commit.' }], owns: ['In-memory copy, token'] },
        { id: 'sessB', label: 'Session server B', sub: 'US · standby', kind: 'service', x: 580, y: 380, latency: 4, role: 'Takes over when the lease expires: rebuilds from the log, then sequences.', ops: [{ name: 'submit', desc: 'Commit.' }], owns: ['In-memory copy, token'] },
        { id: 'sessEU', label: 'Session server EU', sub: 'EU · never owner', kind: 'service', x: 580, y: 520, latency: 4, role: 'Serves EU reads. It must not sequence a US-homed document unless it holds the lease, which it cannot get during a partition.', ops: [{ name: 'submit', desc: 'Commit locally (unsafe).' }], owns: ['Regional copy'] },
        { id: 'oplog', label: 'Operation log', sub: 'Checks the token', kind: 'db', x: 860, y: 290, latency: 8, role: 'Append-only. Remembers the highest token it has seen for the document and refuses writes with an older one.', ops: [{ name: 'append', desc: 'Write if the token is current.' }, { name: 'read', desc: 'All rows.' }], owns: ['log[rev]', 'max token'] },
        { id: 'pubsub', label: 'Pub/sub', sub: 'Document channel', kind: 'queue', x: 860, y: 520, latency: 3, role: 'Broadcasts committed operations.', owns: ['Channel'] },
      ],
      edges: [
        { from: 'ana', to: 'gw', latency: 30, label: 'WebSocket' },
        { from: 'ben', to: 'gw', latency: 120, label: 'EU → US' },
        { from: 'gw', to: 'coord', latency: 3 }, { from: 'gw', to: 'sessA', latency: 3 }, { from: 'gw', to: 'sessB', latency: 3 }, { from: 'gw', to: 'sessEU', latency: 60 },
        { from: 'sessA', to: 'coord', latency: 3 }, { from: 'sessB', to: 'coord', latency: 3 }, { from: 'sessEU', to: 'coord', latency: 60 },
        { from: 'sessA', to: 'oplog', latency: 4 }, { from: 'sessB', to: 'oplog', latency: 4 }, { from: 'sessEU', to: 'oplog', latency: 60 },
        { from: 'sessA', to: 'pubsub', latency: 3, via: [[720, 230], [720, 520]] }, { from: 'sessB', to: 'pubsub', latency: 3 }, { from: 'sessEU', to: 'pubsub', latency: 60 },
        { from: 'pubsub', to: 'gw', latency: 3, via: [[330, 580]] },
      ],
      queues: [{ id: 'bcast', broker: 'pubsub', label: 'Document channel', groups: ['gw'] }],
    },
    failures: [
      { id: 'a-down', node: 'sessA', mode: 'down', label: 'Server A crashes', desc: 'Its lease expires; B takes over after rebuilding from the log.' },
      { id: 'a-pause', node: 'sessA', mode: 'pause', label: 'Server A stalls', desc: 'A long garbage-collection pause: A stops heartbeating but is not dead. When it wakes it still thinks it is the owner.' },
      { id: 'coord-down', node: 'coord', mode: 'down', label: 'Coordination service down', desc: 'No lease can be renewed or taken. The current owner keeps serving until its lease would expire, then stops to be safe.' },
      { id: 'coord-slow', node: 'coord', mode: 'slow', params: { factor: 40 }, label: 'Coordination service slow', desc: 'Lease renewals and lookups take a fifth of a second.' },
      { id: 'eu-partition', node: 'sessEU', mode: 'partition', label: 'EU cut off from the US', desc: 'Ben’s operations cannot reach the US owner. What the EU server does next is the design decision.' },
      { id: 'log-down', node: 'oplog', mode: 'down', label: 'Operation log down', desc: 'Nothing commits anywhere.' },
    ],
    switches: Y.switches([
      ['fencing', 'Fencing tokens on log writes', 'The log refuses a write whose token is older than the newest owner’s. Off: any server that believes it is the owner can write.'],
      ['longLease', 'Long lease (10 s)', 'Fewer renewals, slower failover. Off: 2.5 s.', (s) => { s.state.lease.until = s.now + leaseMs(s.state); }],
      ['euWrites', 'EU may sequence during a partition', 'The EU server accepts Ben’s edits locally when it cannot reach the US. Off: EU goes read-only until the partition heals.'],
    ]),
    presets: Y.presets({ fencing: true, longLease: false, euWrites: false }, [
      { id: 'normal', label: 'Two regions, one owner', desc: 'Ana (US) and Ben (EU) both edit. Server A sequences everything; Ben pays the round trip across the ocean.', run: (s) => { startType(s, 'ana'); s.schedule(700, () => startType(s, 'ben')); } },
      { id: 'crash', label: 'Owner crashes, B takes over', desc: 'A dies. Ana’s edit fails until the lease expires, then B takes the lease with token 2, rebuilds from the log, and commits it. Measure the failover time.', run: (s) => { startType(s, 'ana'); s.schedule(600, () => s.inject('sessA', 'down')); s.schedule(900, () => startType(s, 'ana')); s.schedule(5500, () => startType(s, 'ben')); } },
      { id: 'crash-long-lease', label: 'Owner crashes, 10 s lease', desc: 'Same crash, but nobody may take over until the 10 s lease expires. Ana waits the whole time.', sw: { longLease: true }, run: (s) => { startType(s, 'ana'); s.schedule(600, () => s.inject('sessA', 'down')); s.schedule(900, () => startType(s, 'ana')); } },
      { id: 'pause-fenced', label: 'Owner stalls, fencing on', desc: 'A stalls holding Ana’s operation. B takes over and commits Ben’s. A wakes and tries to write with token 1: the log refuses, A steps down, and Ana’s edit is retried through B.', run: (s) => { s.schedule(300, () => s.inject('sessA', 'pause', true, 4000)); s.schedule(400, () => startType(s, 'ana')); s.schedule(3400, () => startType(s, 'ben')); } },
      { id: 'pause-bad', label: 'Owner stalls, fencing off', desc: 'A wakes and writes revision 1 with its stale state while B has already written its own revision 1. Two sequencers, one document: the log holds two different revision 1s.', sw: { fencing: false }, run: (s) => { s.schedule(300, () => s.inject('sessA', 'pause', true, 4000)); s.schedule(400, () => startType(s, 'ana')); s.schedule(3400, () => startType(s, 'ben')); } },
      { id: 'coord-down', label: 'Coordination service down', desc: 'A keeps sequencing until its lease would have expired, then stops rather than risk two owners. Editing pauses until the service returns.', run: (s) => { startType(s, 'ana'); s.schedule(500, () => s.inject('coord', 'down')); s.schedule(4000, () => startType(s, 'ana')); } },
      { id: 'eu-readonly', label: 'EU partitioned, read-only', desc: 'Ben cannot reach the owner. The EU server refuses his edit instead of sequencing on its own. Stale for him, safe for the document.', run: (s) => { startType(s, 'ana'); s.schedule(500, () => s.inject('sessEU', 'partition')); s.schedule(800, () => startType(s, 'ben')); } },
      { id: 'eu-bad', label: 'EU partitioned, sequences locally', desc: 'The EU server accepts Ben’s edit with no lease. Ana keeps committing in the US. Two histories now exist for one document, and the partition will heal into a conflict nobody can resolve automatically.', sw: { euWrites: true }, run: (s) => { startType(s, 'ana'); s.schedule(500, () => s.inject('sessEU', 'partition')); s.schedule(800, () => startType(s, 'ben')); s.schedule(1500, () => startType(s, 'ana')); } },
    ]),
    initialState: () => {
      const server = (owner) => ({ owner, token: owner ? 1 : 0, rev: 0, text: DOC0, log: [], byClient: {}, busy: false });
      return {
        config: { fencing: true, longLease: false, euWrites: false },
        servers: { sessA: server(true), sessB: server(false), sessEU: server(false) },
        lease: { holder: 'sessA', token: 1, until: 2500 }, ownerCache: null, failedAt: null,
        oplog: { rows: [], maxToken: 1 }, seq: { client: 0 },
        stats: { ops: 0, fenced: 0, takeovers: 0, retries: 0, failoverMs: null, splitBrain: 0, euLocal: 0 },
      };
    },
    initialUI: () => {
      const phone = (who) => ({ who, text: DOC0, rev: 0, outstanding: [], ownIds: {}, status: 'saved', typed: 0, sending: false });
      return { ana: phone('ana'), ben: phone('ben') };
    },
    onFailureChange(sim, e) {
      if (SERVERS.includes(e.node) && (e.mode === 'down' || e.mode === 'pause') && e.active && sim.state.lease.holder === e.node) sim.state.failedAt = sim.now;
    },
    actions: { type(sim, a) { startType(sim, a.who); } },
    setup(sim) {
      Y.consumer(sim, 'bcast', 'gw', 'gw', function* (ctx, msg) { const row = msg.payload; for (const who of Object.keys(PEOPLE)) { if (who === row.who) continue; if (who === 'ben' && ctx.mode('partition', 'sessEU')) continue; yield ctx.call(who, 'push', row, { timeout: 800 }); } return true; }, () => false);
      for (const s of SERVERS) {
        sim.spawn(function* (ctx) {
          for (;;) {
            yield ctx.wait(HB_MS);
            const st = ctx.state;
            const me = st.servers[s];
            if (!me.owner || ctx.sim.nodes[s].modes.down || ctx.mode('pause', s)) continue;
            const r = yield ctx.call('coord', 'renew', { server: s, token: me.token }, { timeout: 600, quiet: 'all' });
            if (r.ok && !r.value.ok) { me.owner = false; ctx.log({ op: 'lease lost: stepping down', status: 'err', detail: `The coordination service says ${ctx.sim.nodes[r.value.holder].label} holds the lease now.` }); }
            if (!r.ok && st.lease.holder === s && ctx.now() >= st.lease.until) { me.owner = false; ctx.log({ op: 'lease expired and cannot be renewed: stepping down', status: 'err', detail: 'With the coordination service unreachable the server cannot know whether someone else took over, so it stops sequencing.' }); }
          }
        }, { self: s, quiet: 'all' });
      }
    },
    handlers: {
      gw: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          if (p.who === 'ben' && ctx.mode('partition', 'sessEU')) {
            // Ben can only reach the EU server.
            return ctx.must(yield ctx.call('sessEU', 'submit', p, { timeout: 1500 }));
          }
          let owner = st.ownerCache && st.ownerCache.until > ctx.now() ? st.ownerCache.holder : null;
          if (!owner || ctx.sim.nodes[owner].modes.down) {
            const l = yield ctx.call('coord', 'lookup', {}, { timeout: 600 });
            if (l.ok && l.value.holder && !l.value.expired) owner = l.value.holder;
            else if (l.ok && (l.value.expired || !l.value.holder)) owner = SERVERS.find((s) => !ctx.sim.nodes[s].modes.down && s !== l.value.holder) || l.value.holder; // ask a healthy server to take over
            else if (!owner) ctx.fail('NO_OWNER', 'Cannot find the document’s owner: the coordination service is unreachable.');
            if (ctx.sim.nodes[owner].modes.down) ctx.fail('UNAVAILABLE', `${ctx.sim.nodes[owner].label} is down and its lease has not expired yet.`);
            st.ownerCache = { holder: owner, until: ctx.now() + 500 };
          }
          const r = yield ctx.call(owner, 'submit', p, { timeout: 1800 });
          if (!r.ok && r.error.code === 'NOT_OWNER') st.ownerCache = null;
          return ctx.must(r);
        },
        since(ctx, p) { const st = ctx.state; const rows = st.oplog.rows.filter((r) => r.rev > p.rev && (p.upto == null || r.rev <= p.upto)); return { ops: rows }; },
      },
      coord: {
        acquire(ctx, p) {
          const st = ctx.state;
          const l = st.lease;
          const holderDead = ctx.sim.nodes[l.holder] && ctx.sim.nodes[l.holder].modes.down;
          if (l.holder !== p.server && ctx.now() < l.until && !holderDead) return { granted: false, holder: l.holder, until: l.until };
          if (l.holder !== p.server && ctx.now() < l.until && holderDead) return { granted: false, holder: l.holder, until: l.until }; // a crash is only known when the lease lapses
          st.lease = { holder: p.server, token: l.holder === p.server ? l.token : l.token + 1, until: ctx.now() + leaseMs(st) };
          return { granted: true, token: st.lease.token, until: st.lease.until };
        },
        renew(ctx, p) { const st = ctx.state; const l = st.lease; if (l.holder !== p.server || l.token !== p.token) return { ok: false, holder: l.holder }; l.until = ctx.now() + leaseMs(st); return { ok: true, until: l.until }; },
        lookup(ctx) { const l = ctx.state.lease; return { holder: l.holder, token: l.token, expired: ctx.now() >= l.until }; },
      },
      sessA: sessionHandlers('sessA'),
      sessB: sessionHandlers('sessB'),
      sessEU: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          const me = st.servers.sessEU;
          if (!ctx.mode('partition')) {
            const g = yield ctx.call('coord', 'lookup', {}, { timeout: 900 });
            ctx.fail('NOT_OWNER', `The document is owned by ${g.ok ? ctx.sim.nodes[g.value.holder].label : 'a US server'}; EU only serves reads.`);
          }
          if (!st.config.euWrites) ctx.fail('READ_ONLY', 'EU is cut off from the US owner and will not sequence on its own: the document is read-only here until the partition heals.');
          // Unsafe: sequence locally without a lease.
          let op = p.op;
          for (const r of me.log.filter((x) => x.rev > p.baseRev)) op = OT.transform(op, r.op, false);
          const rev = me.rev + 1;
          me.rev = rev; me.text = OT.apply(me.text, op); me.log.push({ rev, op, who: p.who, clientId: p.clientId, server: 'sessEU' }); me.byClient[p.clientId] = rev;
          st.stats.euLocal++;
          ctx.log({ op: `sequenced revision ${rev} locally with no lease`, status: 'err', detail: 'The US owner is also assigning revision numbers. These two histories cannot both be right.' });
          return { rev, op, owner: 'sessEU', token: 0, explain: `The EU server could not reach the US owner and sequenced Ben’s edit itself as revision ${rev}, with no lease. The US owner is doing the same for Ana. Two documents now claim the same name.` };
        },
      },
      oplog: {
        append(ctx, row) {
          const st = ctx.state;
          if (st.config.fencing && row.token < st.oplog.maxToken) ctx.fail('FENCED', `Token ${row.token} is older than ${st.oplog.maxToken}.`, { current: st.oplog.maxToken });
          st.oplog.maxToken = Math.max(st.oplog.maxToken, row.token);
          if (st.oplog.rows.some((r) => r.rev === row.rev)) { st.stats.splitBrain++; ctx.log({ op: `second revision ${row.rev} written by ${ctx.sim.nodes[row.server].label}`, status: 'err', detail: 'The log now holds two different operations with the same revision number, from two servers that both believed they owned the document.' }); row = Object.assign({}, row, { dup: true }); }
          st.oplog.rows.push(row);
          return { rev: row.rev };
        },
        read(ctx) { return { rows: ctx.state.oplog.rows.filter((r) => !r.dup) }; },
      },
      ana: { push(ctx, row) { return { applied: applyRemote(ctx, 'ana', row) }; } },
      ben: { push(ctx, row) { return { applied: applyRemote(ctx, 'ben', row) }; } },
    },
    consistency(sim) {
      const st = sim.state;
      if (st.stats.splitBrain) return { key: 'wrong', label: `Split brain: the log holds ${st.stats.splitBrain + 1} different operations numbered the same revision, written by two servers that each believed they owned the document. Phones have diverged and nothing can tell which history is right.` };
      if (st.stats.euLocal) return { key: 'wrong', label: `The EU server sequenced ${st.stats.euLocal} operation${st.stats.euLocal > 1 ? 's' : ''} with no lease while the US owner kept committing. Two histories exist for one document.` };
      const pending = Object.keys(PEOPLE).filter((w) => sim.ui[w].outstanding.length);
      const owners = SERVERS.filter((s) => st.servers[s].owner && !sim.nodes[s].modes.down);
      if (pending.length) {
        const unsaved = pending.filter((w) => sim.ui[w].status === 'unsaved');
        if (unsaved.length && sim.nodes.sessEU.modes.partition) return { key: 'stale', label: 'Ben’s edit was refused: EU is cut off from the owner and read-only. His phone keeps it queued until the partition heals.' };
        return { key: 'stale', label: `${pending.map((w) => PEOPLE[w]).join(' and ')} ${pending.length > 1 ? 'have' : 'has'} edits waiting${owners.length ? '' : ' for a new owner to take the lease'}.` };
      }
      if (!owners.length && sim.now > 500) return { key: 'stale', label: sim.nodes.coord.modes.down ? 'No server holds a valid lease and the coordination service is down: editing is paused rather than risk two owners.' : 'No server currently owns the document; the next edit will trigger a take-over.' };
      const behind = Object.keys(PEOPLE).filter((w) => sim.ui[w].rev < st.oplog.rows.length);
      if (behind.length) return { key: 'stale', label: `${behind.map((w) => PEOPLE[w]).join(' and ')} behind revision ${st.oplog.rows.length}.` };
      const owner = owners[0];
      const text = owner ? st.servers[owner].text : null;
      const diverged = Object.keys(PEOPLE).filter((w) => text != null && sim.ui[w].text !== text && !(w === 'ben' && sim.nodes.sessEU.modes.partition));
      if (diverged.length) return { key: 'wrong', label: `${diverged.map((w) => PEOPLE[w]).join(' and ')}’s copy differs from the owner’s at the same revision.` };
      return { key: 'ok', label: `${owner ? sim.nodes[owner].label : 'A server'} owns the document with token ${st.lease.token}; one sequencer, one history, both phones at revision ${st.oplog.rows.length}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const owner = SERVERS.find((s) => st.servers[s].owner && !sim.nodes[s].modes.down);
      return [
        { label: 'Owner, token', value: owner ? `${sim.nodes[owner].label.replace('Session server ', '')}, ${st.lease.token}` : 'none', tone: owner ? 'ok' : 'warn' },
        { label: 'Lease expires in', value: SDL.fmtMs(Math.max(0, st.lease.until - sim.now)) },
        { label: 'Revisions in the log', value: st.oplog.rows.filter((r) => !r.dup).length },
        { label: 'Failover time', value: st.stats.failoverMs == null ? 'n/a' : SDL.fmtMs(st.stats.failoverMs), tone: st.stats.failoverMs > 4000 ? 'warn' : '' },
        { label: 'Take-overs, fenced writes', value: `${st.stats.takeovers}, ${st.stats.fenced}` },
        { label: 'Client retries', value: st.stats.retries },
        { label: 'Split-brain writes', value: st.stats.splitBrain + st.stats.euLocal, tone: st.stats.splitBrain + st.stats.euLocal ? 'fail' : 'ok' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['ana', 'Ana (US)'], ['ben', 'Ben (EU)']], {
          note: 'Ana is in the region that homes the document; Ben is an ocean away. The console shows which server holds the lease, its token, and what the log has accepted.',
          below: '<div class="ops-console"><p class="ops-title">Lease and servers</p><div data-ref="servers"></div></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const who of Object.keys(PEOPLE)) {
          const u = sim.ui[who];
          const chip = u.status === 'saved' ? ['ok', `Saved · rev ${u.rev}`] : u.status === 'unsaved' ? ['fail', 'Not saved'] : ['work', 'Saving…'];
          Y.paint(el, sim, who, {
            head: `<div><p class="app-title">Q3 plan</p><p class="app-sub">${region[who]} · ${who === 'ben' && sim.nodes.sessEU.modes.partition ? 'cut off from the US' : 'connected'}</p></div>`,
            doc: `<div class="app-card doc-page"><p class="doc-text">${esc(u.text)}<span class="doc-caret"></span></p><span class="app-sub doc-chip" data-tone="${chip[0]}">${chip[1]}</span></div>`,
            keys: `<div class="app-row">${Y.btn('type', `Type “${esc(WORDS[who][u.typed % WORDS[who].length].trim())}”`, { arg: { who }, cls: 'go' })}</div>`,
          }, {}, null);
        }
        const c = sim.scenario.consistency(sim);
        const rows = ['sessA', 'sessB', 'sessEU'].map((s) => { const me = st.servers[s]; const down = sim.nodes[s].modes.down; const paused = sim.nodes[s].modes.pause; const tone = down ? 'fail' : me.owner ? 'ok' : paused ? 'warn' : ''; return `<div class="ops-row" data-shard="${s}" data-tone="${tone}"><div class="ops-name"><strong>${esc(sim.nodes[s].label)}</strong><span>${down ? 'crashed' : paused ? 'stalled' : me.owner ? `owner · token ${me.token} · rev ${me.rev}` : `standby · rev ${me.rev}`}</span></div></div>`; }).join('');
        SDL.ui.paintSections(el.querySelector('[data-ref="servers"]'), {
          lease: `<p class="app-sub">Lease: ${esc(sim.nodes[st.lease.holder].label)}, token ${st.lease.token}, ${st.lease.until > sim.now ? `expires in ${SDL.fmtMs(st.lease.until - sim.now)}` : 'expired'} · log max token ${st.oplog.maxToken} · ${st.oplog.rows.length} rows</p>`,
          rows: `<div class="ops-shards">${rows}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
