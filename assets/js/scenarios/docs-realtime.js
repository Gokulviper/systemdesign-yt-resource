/*
 * Connections, presence, and reconnection.
 * Ana’s phone holds a WebSocket on gateway 1, Ben’s on gateway 2, with 200
 * other phones spread across both. Committed operations are published once and
 * every gateway that holds a socket on the document pushes them down. Gateways
 * heartbeat their users into a presence cache with a TTL. When a gateway dies
 * its phones reconnect through the load balancer, with or without jitter, and
 * ask for everything since the last revision they saw, or naively resume from
 * now. Revision numbers let a phone notice a gap when pub/sub loses a message.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const OT = Y.ot;

  const PEOPLE = { ana: 'Ana', ben: 'Ben' };
  const OTHER = { ana: 'ben', ben: 'ana' };
  const GWS = ['gw1', 'gw2'];
  const CROWD = 200;
  const DOC0 = 'Q3 plan: ship the editor.';
  const WORDS = { ana: [' Hire two.', ' Launch in May.', ' Budget: flat.'], ben: [' Fix sync.', ' Add tests.', ' Ship it.'] };
  const HEARTBEAT_MS = 1000;
  const online = (sim, who) => !sim.nodes[who].modes.down;
  const ttlMs = (st) => (st.config.shortTtl ? 2500 : 30000);

  /* ---------- connections ---------- */
  function* connectFlow(ctx, user, firstDelay) {
    const st = ctx.state;
    const mine = !!PEOPLE[user];
    const u = mine ? ctx.ui[user] : null;
    if (firstDelay) yield ctx.wait(firstDelay);
    for (let attempt = 1; ; attempt++) {
      if (mine) { u.link = 'reconnecting'; u.attempts = attempt; }
      const sinceRev = mine && st.config.backfill ? u.rev : null;
      const r = yield ctx.call('lb', 'connect', { user, sinceRev }, { timeout: 900, quiet: mine ? false : 'all' });
      if (r.ok) {
        st.conns[user] = r.value.server;
        if (mine) {
          Object.assign(u, { link: 'connected', server: r.value.server });
          if (st.config.backfill) {
            for (const row of r.value.ops) applyRemote(ctx, user, row);
            if (r.value.ops.length) { st.stats.backfilled += r.value.ops.length; ctx.explain(`${PEOPLE[user]} reconnected to ${ctx.sim.nodes[r.value.server].label} and asked for everything since revision ${r.value.from}: ${r.value.ops.length} operation${r.value.ops.length > 1 ? 's' : ''} committed while the socket was down, applied before anything new.`); }
          } else {
            // Naive resume: subscribe from now and assume nothing was missed.
            if (r.value.head > u.rev) { st.stats.silentlyMissed += r.value.head - u.rev; ctx.log({ op: `resumed at revision ${r.value.head}, skipping ${r.value.head - u.rev}`, status: 'err', detail: 'The phone subscribed from “now”. Operations committed while it was disconnected will never arrive, and the revision counter no longer reveals the gap.' }); }
            u.rev = Math.max(u.rev, r.value.head);
          }
          if (u.outstanding.length) ctx.spawn((c) => flush(c, user));
        }
        return true;
      }
      st.stats.connectFails++;
      const delay = st.config.jitter ? Math.round(Math.min(4000, 400 * Math.pow(2, attempt - 1)) * (0.5 + ctx.rand())) : 150;
      yield ctx.wait(delay);
    }
  }
  function dropSockets(sim, gw) {
    const st = sim.state;
    const users = Object.keys(st.conns).filter((u) => st.conns[u] === gw);
    for (const u of users) delete st.conns[u];
    return users;
  }
  function reconnectAll(sim, users, why) {
    const st = sim.state;
    for (const u of users) {
      const mine = !!PEOPLE[u];
      if (mine) sim.ui[u].link = 'reconnecting';
      const first = st.config.jitter ? 500 + Math.round(sim.rng() * 2000) : Math.round(sim.rng() * 30);
      sim.spawn((c) => connectFlow(c, u, first), { self: mine ? u : 'crowd', quiet: mine ? false : 'all' });
    }
    if (why) sim.note(why);
  }

  /* ---------- editing (same model as the end-to-end lab, trimmed) ---------- */
  function startType(sim, who) {
    const st = sim.state;
    const u = sim.ui[who];
    const word = WORDS[who][u.typed++ % WORDS[who].length];
    const op = { pos: u.text.length, ins: word };
    sim.startAction(`${PEOPLE[who]}: type “${word.trim()}”`, function* (ctx) {
      u.text = OT.apply(u.text, op);
      u.outstanding.push({ clientId: `${who}-${++st.seq.client}`, op, applied: true });
      Y.L(ctx, { displayed: ['yes', 'Optimistic local echo.'], retrySafe: ['yes', 'Client operation id.'] });
      u.status = 'saving';
      if (u.link !== 'connected') { Y.L(ctx, { accepted: ['pending', 'No socket: queued until the phone reconnects.'] }); ctx.explain(`${PEOPLE[who]} is not connected. The edit is queued on the phone and will be sent, with its client id, as soon as a socket is back.`); return; }
      const r = yield* flush(ctx, who);
      if (r.ok) { Y.L(ctx, { accepted: ['yes', `Revision ${r.rev}.`], committed: 'yes', async: ['pending', `Pushed to ${PEOPLE[OTHER[who]]} through ${ctx.sim.nodes[st.conns[OTHER[who]] || 'gw2'].label}.`] }); ctx.explain(r.explain || `${PEOPLE[who]}’s operation went up through ${ctx.sim.nodes[st.conns[who] || u.server].label}, was committed as revision ${r.rev}, published once, and pushed down by every gateway holding a socket on this document.`); }
      else { Y.L(ctx, { accepted: ['no', r.error.message], committed: 'no', async: 'n/a' }); ctx.explain(`The edit was not saved: ${r.error.message}`); }
    }, { self: who });
  }
  function* flush(ctx, who) {
    const st = ctx.state;
    const u = ctx.ui[who];
    if (u.sending) { while (u.outstanding.length && u.sending) yield ctx.wait(50); return u.lastResult || { ok: true, rev: u.rev }; }
    u.sending = true;
    let last = { ok: true, rev: u.rev };
    try {
      while (u.outstanding.length && u.link === 'connected') {
        const e = u.outstanding[0];
        const gw = st.conns[who];
        const r = yield ctx.call(gw || 'lb', 'submit', { clientId: e.clientId, baseRev: u.rev, op: e.op, who }, { timeout: 1500 });
        ctx.recordOutcome(r.ok, r.latency);
        if (r.ok && u.link !== 'connected') { ctx.log({ op: 'acknowledgement lost with the socket', status: 'lost', detail: `Revision ${r.value.rev} was committed, but the socket closed before the reply arrived. The phone still holds the operation and will resend it with the same client id.` }); last = { ok: true, rev: u.rev }; break; }
        if (!r.ok) {
          if (u.link !== 'connected') { last = { ok: true, rev: u.rev, explain: 'The socket dropped mid-send. The edit stays queued with its client id and goes out again after the reconnect.' }; break; }
          e.tries = (e.tries || 0) + 1;
          if (['TIMEOUT', 'OVERLOADED', 'UNAVAILABLE'].includes(r.error.code) && e.tries < 4) { ctx.log({ op: 'no acknowledgement: resending with the same client id', status: 'retry', error: r.error, detail: `Attempt ${e.tries} got ${r.error.code}; the gateway is busy with reconnects.` }); yield ctx.wait(400 * e.tries); continue; }
          u.status = 'unsaved'; last = { ok: false, error: r.error }; break;
        }
        if (r.value.replayed) st.stats.replayed++;
        if (r.value.rev > u.rev + 1 && st.config.gapDetect) yield* catchUp(ctx, who, r.value.rev - 1);
        u.outstanding.shift();
        u.rev = Math.max(u.rev, r.value.rev);
        u.ownIds[e.clientId] = true;
        last = { ok: true, rev: r.value.rev, explain: r.value.replayed ? 'The first copy of this operation had already been committed before the socket dropped; the resend carried the same client id, so the server returned the existing revision.' : null };
      }
      if (!u.outstanding.length) u.status = 'saved';
    } finally { u.sending = false; u.lastResult = last; }
    return last;
  }
  function* catchUp(ctx, who, upto) {
    const u = ctx.ui[who];
    const r = yield ctx.call(ctx.state.conns[who] || 'lb', 'since', { rev: u.rev, upto }, { timeout: 800 });
    if (!r.ok) return;
    ctx.state.stats.gapsHealed++;
    for (const row of r.value.ops) applyRemote(ctx, who, row);
    ctx.log({ op: `gap healed: fetched ${r.value.ops.length} revision${r.value.ops.length === 1 ? '' : 's'}`, status: 'recovered', detail: `${PEOPLE[who]} noticed a revision number it had not seen the predecessor of and fetched the missing operations.` });
  }
  function applyRemote(ctx, who, row) {
    const u = ctx.ui[who];
    if (row.rev <= u.rev) { ctx.state.stats.dupsIgnored++; return false; }
    u.rev = row.rev;
    if (u.ownIds[row.clientId] || row.who === who) return true;
    let op = row.op;
    for (const e of u.outstanding) { const mine = e.op; e.op = OT.transform(mine, op, false); op = OT.transform(op, mine, true); }
    u.text = OT.apply(u.text, op);
    return true;
  }
  function* receive(ctx, who, row) {
    const u = ctx.ui[who];
    if (row.rev > u.rev + 1) {
      if (ctx.state.config.gapDetect) { ctx.log({ op: `gap: expected revision ${u.rev + 1}, got ${row.rev}`, status: 'retry', detail: 'A broadcast was missed; fetching it first.' }); yield* catchUp(ctx, who, row.rev - 1); }
      else { ctx.state.stats.silentlyMissed += row.rev - u.rev - 1; ctx.log({ op: `applied revision ${row.rev} after ${u.rev}`, status: 'err', detail: 'Without gap detection the phone applies what arrives and never learns what did not.' }); }
    }
    return applyRemote(ctx, who, row);
  }

  function gwHandlers(id) {
    return {
      handshake: function* (ctx, p) {
        const st = ctx.state;
        st.conns[p.user] = id;
        st.sockets[id][p.user] = true;
        yield ctx.call('presence', 'touch', { users: [p.user], ttl: ttlMs(st) }, { timeout: 400, quiet: true });
        let ops = [], from = p.sinceRev;
        if (p.sinceRev != null) { const r = yield ctx.call('session', 'since', { rev: p.sinceRev }, { timeout: 700 }); if (r.ok) ops = r.value.ops; }
        return { server: id, ops, from, head: st.doc.rev };
      },
      submit: function* (ctx, p) {
        if (!ctx.state.sockets[id][p.who]) ctx.fail('NOT_CONNECTED', `${PEOPLE[p.who]} has no socket on ${ctx.sim.nodes[id].label}.`);
        return ctx.must(yield ctx.call('session', 'submit', p, { timeout: 1300 }));
      },
      since: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'since', p, { timeout: 700 })); },
    };
  }

  SDL.scenarios['docs-realtime'] = {
    id: 'docs-realtime',
    seed: 1217,
    productWidth: 640,
    intro: 'Type on Ana’s phone (gateway 1) and watch Ben (gateway 2) receive it through pub/sub. Then crash gateway 1 and see 101 phones reconnect, with and without jitter and with and without asking for everything since the last revision.',
    modeLabels: { partition: 'Partitioned from pub/sub', nohb: 'Heartbeats lost', flap: 'Network flapping' },
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'ana', label: 'Ana’s phone', sub: 'Socket on gateway 1', kind: 'client', x: 90, y: 90, latency: 1, role: 'Holds one WebSocket. On reconnect it asks for everything since the last revision it applied.', ops: [{ name: 'push', desc: 'A remote operation.' }], owns: ['Local copy', 'Last revision seen'] },
        { id: 'ben', label: 'Ben’s phone', sub: 'Socket on gateway 2', kind: 'client', x: 90, y: 300, latency: 1, role: 'Same as Ana’s phone, on the other gateway.', ops: [{ name: 'push', desc: 'A remote operation.' }], owns: ['Local copy', 'Last revision seen'] },
        { id: 'crowd', label: 'Other phones', sub: `${CROWD} connections`, kind: 'client', x: 90, y: 510, latency: 1, role: `${CROWD} other phones on other documents, spread across both gateways. They matter when a gateway dies.`, owns: ['Their sockets'] },
        { id: 'lb', label: 'Load balancer', sub: 'Least connections', kind: 'gateway', x: 320, y: 300, latency: 2, role: 'Sends each new connection to the healthy gateway with the fewest sockets, and refuses connections outright while that gateway’s handshake queue is over a second, so timed-out work does not pile up.', ops: [{ name: 'connect', desc: 'Pick a gateway and hand over.' }], owns: ['Gateway health'] },
        { id: 'gw1', label: 'Gateway 1', sub: 'WebSockets', kind: 'gateway', x: 540, y: 150, latency: 2, serviceMs: 20, role: 'Holds sockets. Each handshake costs about 20 ms of work, so roughly 50 a second. Subscribes to the document channel and pushes every operation to its sockets.', ops: [{ name: 'handshake', desc: 'Accept a connection.' }, { name: 'submit', desc: 'Forward an operation.' }, { name: 'since', desc: 'Backfill.' }], owns: ['Its sockets'] },
        { id: 'gw2', label: 'Gateway 2', sub: 'WebSockets', kind: 'gateway', x: 540, y: 450, latency: 2, serviceMs: 20, role: 'Same as gateway 1.', ops: [{ name: 'handshake', desc: 'Accept a connection.' }, { name: 'submit', desc: 'Forward an operation.' }, { name: 'since', desc: 'Backfill.' }], owns: ['Its sockets'] },
        { id: 'session', label: 'Document session', sub: 'Sequencer', kind: 'service', x: 790, y: 300, latency: 4, role: 'Orders and commits operations, publishes each once.', ops: [{ name: 'submit', desc: 'Commit an operation.' }, { name: 'since', desc: 'Operations after a revision.' }], owns: ['Text and head revision'] },
        { id: 'oplog', label: 'Operation log', sub: 'By revision', kind: 'db', x: 1040, y: 150, latency: 8, role: 'Durable history and the source of every backfill.', ops: [{ name: 'append', desc: 'Write a revision.' }], owns: ['log[rev]'] },
        { id: 'pubsub', label: 'Pub/sub', sub: 'Document channel', kind: 'queue', x: 790, y: 500, latency: 3, role: 'Delivers each committed operation to every subscribed gateway. At-most-once here: a lost message is lost.', owns: ['Channel per document'] },
        { id: 'presence', label: 'Presence', sub: 'TTL per user', kind: 'cache', x: 1040, y: 450, latency: 2, role: 'Who is in the document, refreshed by gateway heartbeats. Entries expire when heartbeats stop.', ops: [{ name: 'touch', desc: 'Refresh users.' }, { name: 'who', desc: 'Users present.' }], owns: ['present[user] with expiry'] },
      ],
      edges: [
        { from: 'ana', to: 'lb', latency: 30, label: 'WebSocket' },
        { from: 'ben', to: 'lb', latency: 30, label: 'WebSocket' },
        { from: 'crowd', to: 'lb', latency: 30 },
        { from: 'lb', to: 'gw1', latency: 3 },
        { from: 'lb', to: 'gw2', latency: 3 },
        { from: 'ana', to: 'gw1', latency: 33, via: [[200, 60], [540, 60]] },
        { from: 'ben', to: 'gw2', latency: 33, via: [[200, 400], [400, 400]] },
        { from: 'gw1', to: 'session', latency: 3 },
        { from: 'gw2', to: 'session', latency: 3 },
        { from: 'session', to: 'oplog', latency: 4 },
        { from: 'session', to: 'pubsub', latency: 3 },
        { from: 'pubsub', to: 'gw1', latency: 3, via: [[660, 500], [660, 230]] },
        { from: 'pubsub', to: 'gw2', latency: 3 },
        { from: 'gw1', to: 'presence', latency: 3 },
        { from: 'gw2', to: 'presence', latency: 3 },
      ],
      queues: [{ id: 'bcast', broker: 'pubsub', label: 'Document channel', groups: ['gw1', 'gw2'] }],
    },
    failures: [
      { id: 'gw1-down', node: 'gw1', mode: 'down', label: 'Gateway 1 crashes', desc: 'Its 101 sockets drop, including Ana’s. Every one of those phones reconnects through the load balancer.' },
      { id: 'partition', node: 'gw2', mode: 'partition', label: 'Gateway 2 cut off from pub/sub', desc: 'Broadcasts do not reach gateway 2 while this is on. Ben falls behind.' },
      { id: 'nohb', node: 'gw2', mode: 'nohb', label: 'Gateway 2 stops heartbeating', desc: 'Presence entries for its users expire although they are connected.' },
      { id: 'flap', node: 'ana', mode: 'flap', label: 'Ana’s network flaps', desc: 'Her socket drops and reconnects repeatedly.' },
      { id: 'ben-off', node: 'ben', mode: 'down', label: 'Ben closes the app', desc: 'His socket is gone. How long does Ana keep seeing “Ben is here”?' },
      { id: 'lb-slow', node: 'lb', mode: 'slow', params: { factor: 30 }, label: 'Load balancer slow', desc: 'Connections take longer.' },
    ],
    switches: Y.switches([
      ['backfill', 'Reconnect with “since revision”', 'On reconnect the phone asks for every operation after the last revision it applied. Off: it subscribes from now.'],
      ['gapDetect', 'Detect gaps by revision number', 'A pushed revision that is not the next expected one triggers a fetch of the missing ones. Off: apply whatever arrives.'],
      ['jitter', 'Jittered exponential backoff', 'Reconnects spread over a few seconds. Off: every phone retries together every 150 ms.'],
      ['shortTtl', 'Short presence TTL (2.5 s)', 'Presence expires soon after heartbeats stop. Off: 30 s, so a closed app lingers in the avatar row.', (s) => { for (const w of Object.keys(PEOPLE)) if (s.state.conns[w]) s.state.present[w] = s.now + ttlMs(s.state); }],
    ]),
    presets: Y.presets({ backfill: true, gapDetect: true, jitter: true, shortTtl: true }, [
      { id: 'across', label: 'Across two gateways', desc: 'Ana’s operation goes up through gateway 1, is committed, published once, and pushed to Ben by gateway 2.', run: (s) => { startType(s, 'ana'); s.schedule(1200, () => startType(s, 'ben')); } },
      { id: 'crash', label: 'Gateway crash, backfill on reconnect', desc: 'Gateway 1 dies. Ben types while Ana is reconnecting. She comes back on gateway 2 asking for everything since her last revision, and gets it.', run: (s) => { s.schedule(200, () => s.inject('gw1', 'down')); s.schedule(230, () => startType(s, 'ben')); s.schedule(5000, () => startType(s, 'ana')); } },
      { id: 'crash-bad', label: 'Gateway crash, resume from now', desc: 'Same crash, but Ana’s phone subscribes from “now”. Ben’s sentence never reaches her, and her revision counter was moved forward, so nothing will ever flag the gap.', sw: { backfill: false }, run: (s) => { s.schedule(200, () => s.inject('gw1', 'down')); s.schedule(230, () => startType(s, 'ben')); s.schedule(5000, () => startType(s, 'ana')); } },
      { id: 'storm', label: 'Gateway crash, reconnect storm', desc: 'No jitter: 101 phones retry together every 150 ms. Gateway 2’s handshake queue passes a second, the balancer starts refusing, hundreds of attempts fail, and Ben’s typing waits behind the herd.', sw: { jitter: false }, run: (s) => { s.schedule(200, () => s.inject('gw1', 'down')); s.schedule(1500, () => startType(s, 'ben')); } },
      { id: 'partition-heal', label: 'Pub/sub partition, gap detected', desc: 'Gateway 2 misses a broadcast. The next one carries a revision Ben did not expect; he fetches the missing operation first.', run: (s) => { s.inject('gw2', 'partition', true, 700); startType(s, 'ana'); s.schedule(1600, () => startType(s, 'ana')); } },
      { id: 'partition-bad', label: 'Pub/sub partition, no gap detection', desc: 'Ben applies revision 2 without ever seeing revision 1. His screen is missing a sentence and says it is up to date.', sw: { gapDetect: false }, run: (s) => { s.inject('gw2', 'partition', true, 700); startType(s, 'ana'); s.schedule(1600, () => startType(s, 'ana')); } },
      { id: 'flap', label: 'Network flapping while typing', desc: 'Ana’s socket drops three times. Each reconnect backfills what she missed and resends her queued edit with the same client id: nothing duplicated, nothing lost.', run: (s) => { s.inject('ana', 'flap', true, 3000); s.schedule(100, () => startType(s, 'ana')); s.schedule(200, () => startType(s, 'ben')); s.schedule(940, () => startType(s, 'ana')); } },
      { id: 'ghost', label: 'Ben closes the app, long TTL', desc: 'His socket is gone but the presence entry lives 30 s. Ana keeps seeing “Ben is here” and a cursor for someone who left.', sw: { shortTtl: false }, run: (s) => { s.schedule(300, () => s.inject('ben', 'down')); s.schedule(1500, () => startType(s, 'ana')); } },
      { id: 'hb-lost', label: 'Gateway 2 stops heartbeating', desc: 'Ben is connected and typing, but his presence entry expires. Ana sees him vanish while his edits keep arriving: presence is a hint, not truth.', run: (s) => { s.inject('gw2', 'nohb'); s.schedule(3500, () => startType(s, 'ben')); } },
    ]),
    initialState: () => {
      const sockets = { gw1: { ana: true }, gw2: { ben: true } };
      const conns = { ana: 'gw1', ben: 'gw2' };
      for (let i = 1; i <= CROWD; i++) { const g = GWS[i % 2]; sockets[g]['p' + i] = true; conns['p' + i] = g; }
      return {
        config: { backfill: true, gapDetect: true, jitter: true, shortTtl: true },
        doc: { text: DOC0, rev: 0 }, log: [], byClient: {}, busy: false, sockets, conns,
        present: { ana: 0, ben: 0 }, seq: { client: 0 },
        stats: { connectFails: 0, shed: 0, backfilled: 0, gapsHealed: 0, dupsIgnored: 0, silentlyMissed: 0, replayed: 0, dropped: 0 },
      };
    },
    initialUI: () => {
      const phone = (who, server) => ({ who, text: DOC0, rev: 0, outstanding: [], ownIds: {}, status: 'saved', link: 'connected', server, attempts: 0, typed: 0, sending: false });
      return { ana: phone('ana', 'gw1'), ben: phone('ben', 'gw2') };
    },
    onFailureChange(sim, e) {
      const st = sim.state;
      if (GWS.includes(e.node) && e.mode === 'down' && e.active) {
        const users = dropSockets(sim, e.node);
        st.sockets[e.node] = {};
        for (const u of users) if (PEOPLE[u]) sim.ui[u].link = 'reconnecting';
        reconnectAll(sim, users, `${sim.nodes[e.node].label} crashed: ${users.length} sockets dropped. Every one of those phones will reconnect.`);
      }
      if (e.node === 'ana' && e.mode === 'flap' && e.active) {
        sim.spawn(function* (ctx) {
          const t0 = ctx.now();
          for (let i = 0; i < 3 && ctx.mode('flap', 'ana'); i++) {
            const gw = st.conns.ana;
            if (gw) { delete st.sockets[gw].ana; delete st.conns.ana; }
            sim.ui.ana.link = 'reconnecting';
            ctx.log({ op: 'socket dropped', status: 'lost', detail: 'Ana’s network blipped; the WebSocket closed. Any reply in flight is lost with it.' });
            yield* connectFlow(ctx, 'ana', 400);
            const left = t0 + (i + 1) * 1000 - ctx.now();
            if (left > 0) yield ctx.wait(left);
          }
        }, { self: 'ana' });
      }
      if (e.node === 'ben' && e.mode === 'down') {
        if (e.active) { const gw = st.conns.ben; if (gw) { delete st.sockets[gw].ben; delete st.conns.ben; } sim.ui.ben.link = 'closed'; }
        else sim.spawn((c) => connectFlow(c, 'ben', 0), { self: 'ben' });
      }
    },
    actions: {
      type(sim, a) { startType(sim, a.who); },
      close(sim, a) { sim.inject(a.who, 'down'); },
      open(sim, a) { sim.restore(a.who, 'down'); },
    },
    setup(sim) {
      for (const w of Object.keys(PEOPLE)) sim.state.present[w] = ttlMs(sim.state);
      for (const g of GWS) {
        Y.consumer(sim, 'bcast', g, g, function* (ctx, msg) {
          const row = msg.payload;
          if (ctx.mode('partition', g)) { ctx.state.stats.dropped++; ctx.log({ op: `revision ${row.rev} lost before ${ctx.sim.nodes[g].label}`, status: 'lost', detail: 'The gateway is cut off from pub/sub; this message will never arrive.' }); return true; }
          for (const who of Object.keys(PEOPLE)) { if (who === row.who || !ctx.state.sockets[g][who] || !online(ctx.sim, who)) continue; yield ctx.call(who, 'push', row, { timeout: 800 }); }
          return true;
        }, () => false);
        sim.spawn(function* (ctx) {
          for (;;) {
            yield ctx.wait(HEARTBEAT_MS);
            if (ctx.sim.nodes[g].modes.down || ctx.mode('nohb', g)) continue;
            const users = Object.keys(ctx.state.sockets[g]).filter((u) => PEOPLE[u]);
            if (users.length) yield ctx.call('presence', 'touch', { users, ttl: ttlMs(ctx.state) }, { timeout: 400, quiet: 'all' });
          }
        }, { self: g, quiet: 'all' });
      }
    },
    handlers: {
      lb: {
        connect: function* (ctx, p) {
          const st = ctx.state;
          const up = GWS.filter((g) => !ctx.sim.nodes[g].modes.down);
          if (!up.length) ctx.fail('UNAVAILABLE', 'No gateway is healthy.');
          const target = up.sort((a, b) => Object.keys(st.sockets[a]).length - Object.keys(st.sockets[b]).length || (a < b ? -1 : 1))[0];
          if (ctx.sim.queueWait(target) > 1000) { st.stats.shed++; ctx.fail('OVERLOADED', `${ctx.sim.nodes[target].label} reports a ${(ctx.sim.queueWait(target) / 1000).toFixed(1)} s handshake queue; the connection is refused rather than queued.`); }
          return ctx.must(yield ctx.call(target, 'handshake', p, { timeout: 800 }));
        },
        submit() { fail('NOT_CONNECTED', 'No socket.'); },
      },
      gw1: gwHandlers('gw1'),
      gw2: gwHandlers('gw2'),
      session: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          if (st.byClient[p.clientId] != null) { const row = st.log[st.byClient[p.clientId] - 1]; return { rev: row.rev, op: row.op, replayed: true }; }
          while (st.busy) yield ctx.wait(5);
          st.busy = true;
          try {
            let op = p.op;
            for (const r of st.log.filter((x) => x.rev > p.baseRev)) op = OT.transform(op, r.op, false);
            const rev = st.doc.rev + 1;
            const row = { rev, op, who: p.who, clientId: p.clientId };
            ctx.must(yield ctx.call('oplog', 'append', row, { timeout: 900 }));
            st.doc.rev = rev; st.doc.text = OT.apply(st.doc.text, op); st.log.push(row); st.byClient[p.clientId] = rev;
            ctx.sim.enqueue('bcast', { type: `rev ${rev}`, eventId: `r${rev}`, payload: row });
            return { rev, op };
          } finally { st.busy = false; }
        },
        since(ctx, p) { return { from: p.rev, ops: ctx.state.log.filter((r) => r.rev > p.rev && (p.upto == null || r.rev <= p.upto)) }; },
      },
      oplog: { append(ctx, row) { return { rev: row.rev }; } },
      presence: {
        touch(ctx, p) { for (const u of p.users) if (PEOPLE[u]) ctx.state.present[u] = ctx.now() + p.ttl; return { ok: true }; },
        who(ctx) { return { users: Object.keys(PEOPLE).filter((u) => ctx.state.present[u] > ctx.now()) }; },
      },
      ana: { push: function* (ctx, row) { return { applied: yield* receive(ctx, 'ana', row) }; } },
      ben: { push: function* (ctx, row) { return { applied: yield* receive(ctx, 'ben', row) }; } },
    },
    consistency(sim) {
      const st = sim.state;
      const present = (u) => st.present[u] > sim.now;
      if (st.stats.silentlyMissed) {
        const w = Object.keys(PEOPLE).find((x) => sim.ui[x].text !== st.doc.text) || 'ben';
        return { key: 'wrong', label: `${PEOPLE[w]}’s screen is missing ${st.stats.silentlyMissed} committed operation${st.stats.silentlyMissed > 1 ? 's' : ''} and nothing says so. ${st.config.backfill ? 'A broadcast was lost and the gap was not detected.' : 'The reconnect resumed from “now” instead of from the last revision applied.'}` };
      }
      const reconnecting = Object.keys(PEOPLE).filter((w) => sim.ui[w].link === 'reconnecting');
      const crowdLeft = Object.keys(st.conns).length;
      const closed = Object.keys(PEOPLE).filter((w) => sim.ui[w].link === 'closed').length;
      const dropped = CROWD + 2 - closed - crowdLeft;
      if (reconnecting.length || dropped > 0) return { key: 'stale', label: `${dropped} phone${dropped === 1 ? ' is' : 's are'} still reconnecting${reconnecting.length ? `, including ${reconnecting.map((w) => PEOPLE[w]).join(' and ')}` : ''}. Queued edits wait on the phones.` };
      const pending = Object.keys(PEOPLE).filter((w) => sim.ui[w].outstanding.length);
      if (pending.length) return { key: 'stale', label: `${pending.map((w) => PEOPLE[w]).join(' and ')} ${pending.length > 1 ? 'have' : 'has'} operations in flight or queued.` };
      const behind = Object.keys(PEOPLE).filter((w) => sim.ui[w].link === 'connected' && sim.ui[w].rev < st.doc.rev);
      if (behind.length) return { key: 'stale', label: `${behind.map((w) => `${PEOPLE[w]}’s copy is at revision ${sim.ui[w].rev}`).join('; ')}; the document is at ${st.doc.rev}. The gap will be noticed at the next push.` };
      for (const w of Object.keys(PEOPLE)) {
        if (sim.ui[w].link === 'closed' && present(w)) return { key: 'stale', label: `${PEOPLE[w]} closed the app ${((sim.now - (st.present[w] - ttlMs(st))) / 1000).toFixed(1)} s ago but presence still lists ${w === 'ana' ? 'her' : 'him'} for ${((st.present[w] - sim.now) / 1000).toFixed(1)} s more.` };
        if (sim.ui[w].link === 'connected' && !present(w) && sim.now > HEARTBEAT_MS * 2) return { key: 'stale', label: `${PEOPLE[w]} is connected but presence has expired: ${w === 'ana' ? 'her' : 'his'} gateway stopped heartbeating. Edits still flow; the avatar row is wrong.` };
      }
      const diverged = Object.keys(PEOPLE).filter((w) => sim.ui[w].link === 'connected' && sim.ui[w].text !== st.doc.text);
      if (diverged.length) return { key: 'wrong', label: `${diverged.map((w) => PEOPLE[w]).join(' and ')}’s copy differs from the document at the same revision.` };
      return { key: 'ok', label: `Every open phone is connected, both copies match revision ${st.doc.rev}, and presence matches who is really here.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const rows = GWS.map((g) => { const w = sim.queueWait(g); return { label: `${sim.nodes[g].label}: sockets, handshake wait`, value: sim.nodes[g].modes.down ? 'crashed' : `${Object.keys(st.sockets[g]).length}, ${SDL.fmtMs(w)}`, tone: sim.nodes[g].modes.down ? 'fail' : w > 500 ? 'fail' : w > 100 ? 'warn' : 'ok' }; });
      return rows.concat([
        { label: 'Failed connection attempts (refused by the balancer)', value: `${st.stats.connectFails} (${st.stats.shed})`, tone: st.stats.connectFails > 50 ? 'fail' : st.stats.connectFails ? 'warn' : '' },
        { label: 'Backfilled on reconnect', value: st.stats.backfilled },
        { label: 'Gaps healed, duplicates ignored', value: `${st.stats.gapsHealed}, ${st.stats.dupsIgnored}` },
        { label: 'Resends answered by client id', value: st.stats.replayed },
        { label: 'Silently missed operations', value: st.stats.silentlyMissed, tone: st.stats.silentlyMissed ? 'fail' : '' },
        { label: 'Present now', value: Object.keys(PEOPLE).filter((u) => st.present[u] > sim.now).map((u) => PEOPLE[u]).join(', ') || 'nobody' },
      ]);
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['ana', 'Ana'], ['ben', 'Ben']], {
          note: 'Each phone shows its gateway, its link state, who presence says is here, and the document. The console shows sockets per gateway and how long a new handshake would wait.',
          below: '<div class="ops-console"><p class="ops-title">Gateways</p><div class="ops-shards" data-ref="servers"></div><p class="recon" data-ref="recon"></p></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const who of Object.keys(PEOPLE)) {
          const u = sim.ui[who];
          const other = OTHER[who];
          const here = st.present[other] > sim.now;
          const link = u.link === 'connected' ? `Connected to ${sim.nodes[u.server].label}` : u.link === 'reconnecting' ? `Reconnecting, attempt ${u.attempts}…` : 'App closed';
          const chip = u.status === 'saved' ? ['ok', `Saved · rev ${u.rev}`] : u.status === 'saving' ? ['work', u.link === 'connected' ? 'Saving…' : 'Queued offline'] : ['fail', 'Unsaved'];
          Y.paint(el, sim, who, {
            head: `<div><p class="app-title">Q3 plan</p><p class="app-sub">${esc(link)}</p></div>`,
            who: `<div class="app-card ${here ? 'is-ok' : ''}"><strong>${here ? `${PEOPLE[other]} is here` : `${PEOPLE[other]} is away`}</strong><span class="app-sub">from presence</span></div>`,
            doc: `<div class="app-card doc-page"><p class="doc-text">${esc(u.text)}<span class="doc-caret"></span></p><span class="app-sub doc-chip" data-tone="${chip[0]}">${chip[1]}</span></div>`,
            keys: `<div class="app-row">${Y.btn('type', `Type “${esc(WORDS[who][u.typed % WORDS[who].length].trim())}”`, { arg: { who }, cls: 'go', disabled: u.link === 'closed' })}${u.link === 'closed' ? Y.btn('open', 'Open the app', { arg: { who }, cls: 'secondary' }) : Y.btn('close', 'Close the app', { arg: { who }, cls: 'secondary' })}</div>`,
          }, {}, null);
        }
        const rows = GWS.map((g) => `<div class="ops-row" data-shard="${g}"><div class="ops-name"><strong>${sim.nodes[g].label}</strong><span data-live="c-${g}"></span></div><div class="ops-bar"><i data-live-width="w-${g}"></i></div><span class="ops-val" data-live="v-${g}"></span></div>`).join('');
        const live = {};
        for (const g of GWS) { const w = sim.queueWait(g); live[`c-${g}`] = `${Object.keys(st.sockets[g]).length} sockets`; live[`w-${g}`] = `${Math.min(100, (w / 1500) * 100)}%`; live[`v-${g}`] = sim.nodes[g].modes.down ? 'crashed' : `${Math.round(w)} ms handshake wait`; }
        const box = el.querySelector('[data-ref="servers"]');
        SDL.ui.paintSections(box, { rows }, live);
        box.querySelectorAll('.ops-row').forEach((r) => { const g = r.dataset.shard; const w = sim.queueWait(g); r.dataset.tone = sim.nodes[g].modes.down ? 'fail' : w > 500 ? 'fail' : w > 100 ? 'warn' : 'ok'; });
        const c = sim.scenario.consistency(sim);
        const rc = el.querySelector('[data-ref="recon"]');
        const txt = `${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${c.label}`;
        if (rc.textContent !== txt) { rc.textContent = txt; rc.dataset.tone = c.key; }
      },
    },
  };
  const fail = SDL.fail;
})(typeof window !== 'undefined' ? window : globalThis);
