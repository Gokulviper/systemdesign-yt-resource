/*
 * End to end: two people, one document.
 * Ana and Ben hold WebSockets to a gateway. A keystroke is applied locally at
 * once (optimistic echo) and sent as an operation with the revision it was
 * based on. One session service owns the document: it checks access, transforms
 * the operation against everything committed since that base revision, appends
 * it to the operation log, acknowledges the new revision, and broadcasts it
 * through pub/sub to every other socket. A snapshot worker folds the log into
 * a snapshot every few revisions so opening the document stays fast.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const OT = Y.ot;

  const PEOPLE = { ana: 'Ana', ben: 'Ben' };
  const OTHER = { ana: 'ben', ben: 'ana' };
  const DOC0 = 'Q3 plan: ship the editor.';
  const WORDS = { ana: [' Hire two.', ' Launch in May.', ' Budget: flat.'], ben: [' Fix sync.', ' Add tests.', ' Ship it.'] };
  const SNAP_EVERY = 4;
  const online = (sim, who) => !sim.nodes[who].modes.down;

  function cursorPos(u) {
    const t = u.text;
    return u.cursor === 'start' ? 0 : u.cursor === 'middle' ? t.indexOf(':') + 1 : t.length;
  }

  /* ---------- client side ---------- */
  function startType(sim, who, kind) {
    const st = sim.state;
    const u = sim.ui[who];
    let ops;
    if (kind === 'del') {
      const pos = cursorPos(u);
      const left = u.text.slice(0, pos);
      const m = left.match(/\s*\S+\s*$/);
      if (!m) return;
      ops = [{ pos: pos - m[0].length, del: m[0].length }];
    } else {
      const word = WORDS[who][u.typed % WORDS[who].length];
      u.typed++;
      const pos = cursorPos(u);
      ops = st.config.coalesce ? [{ pos, ins: word }] : word.split('').map((ch, i) => ({ pos: pos + i, ins: ch }));
    }
    const label = kind === 'del' ? `${PEOPLE[who]}: delete a word` : `${PEOPLE[who]}: type “${ops.map((o) => o.ins).join('').trim()}”`;
    sim.startAction(label, function* (ctx) {
      for (const op of ops) {
        const clientId = `${who}-${++st.seq.client}`;
        const entry = { clientId, op, who, state: 'queued' };
        if (st.config.optimistic) { u.text = OT.apply(u.text, op); entry.applied = true; }
        u.outstanding.push(entry);
      }
      Y.L(ctx, {
        displayed: st.config.optimistic ? ['yes', 'Optimistic echo: the text changed before the server answered.'] : ['pending', 'Shown only when the server acknowledges.'],
        retrySafe: st.config.idem ? ['yes', 'Each operation carries a client id; the server returns the existing revision for a repeat.'] : ['no', 'No client id: a resend is a new operation.'],
      });
      u.status = 'saving';
      const res = yield* flush(ctx, who);
      if (res.ok) {
        Y.L(ctx, { accepted: ['yes', `Revision ${res.rev}.`], committed: res.durable ? ['yes', 'Appended to the operation log before the acknowledgement.'] : ['pending', 'Acknowledged first; the log write is still running.'], displayed: 'yes', async: ['pending', `Broadcast to ${PEOPLE[OTHER[who]]}.`] });
        ctx.explain(res.explain || `${PEOPLE[who]}’s edit was applied locally at once, sent with base revision ${res.baseRev}, ${res.transformed ? 'transformed against ' + res.transformed + ' concurrent operation' + (res.transformed > 1 ? 's' : '') + ', ' : ''}committed as revision ${res.rev}, and broadcast to ${PEOPLE[OTHER[who]]}.`);
      } else {
        Y.L(ctx, { accepted: ['no', res.error.message], committed: 'no', async: 'n/a', displayed: st.config.optimistic ? ['yes', 'Still on screen, marked unsaved.'] : 'no' });
        ctx.explain(res.explain || `The edit could not be saved: ${res.error.message}. It stays on ${PEOPLE[who]}’s screen as unsaved and is resent when the server recovers.`);
      }
    }, { self: who });
  }

  /** Send outstanding operations one at a time (one in flight), transforming against anything that arrives meanwhile. */
  function* flush(ctx, who) {
    const st = ctx.state;
    const u = ctx.ui[who];
    if (u.sending) { // another action is already draining the queue; wait for ours
      while (u.outstanding.length && u.sending) yield ctx.wait(50);
      return u.lastResult || { ok: true, rev: u.rev };
    }
    u.sending = true;
    let last = { ok: true, rev: u.rev };
    try {
      while (u.outstanding.length) {
        const e = u.outstanding[0];
        e.state = 'inflight';
        let r;
        for (let attempt = 1; ; attempt++) {
          const sent = { clientId: st.config.idem ? e.clientId : attempt === 1 ? e.clientId : `${e.clientId}-r${attempt}`, baseRev: u.rev, op: e.op, who };
          r = yield ctx.call('gw', 'submit', sent, { timeout: 1200 });
          ctx.recordOutcome(r.ok, r.latency);
          if (r.ok) {
            if (attempt > 1 && !st.config.idem && !r.value.replayed) { st.stats.duplicated++; last.explain = `The first send did arrive; only its reply was lost. Without a client id the resend was a brand-new operation, so the document now contains ${PEOPLE[who]}’s text twice.`; }
            else if (attempt > 1 && r.value.replayed) last.explain = 'The first send did arrive; only its reply was lost. The resend carried the same client id, so the server returned the existing revision and nothing was duplicated.';
            break;
          }
          const retryable = ['TIMEOUT', 'UNAVAILABLE', 'OVERLOADED'].includes(r.error.code);
          if (!retryable || attempt >= 3) break;
          ctx.log({ op: 'no acknowledgement: resending', status: 'retry', error: r.error, detail: st.config.idem ? `Resending with the same client id ${e.clientId}.` : 'Resending without a client id: the server cannot tell it from a new operation.' });
          yield ctx.wait(300 * attempt);
        }
        if (!r.ok) {
          e.state = 'unsaved';
          u.status = 'unsaved';
          last = { ok: false, error: r.error };
          st.stats.unsaved = u.outstanding.length;
          break;
        }
        // Catch up on revisions we have not seen before accepting the acknowledged one.
        if (r.value.rev > u.rev + 1) yield* catchUp(ctx, who, r.value.rev - 1);
        u.outstanding.shift();
        if (!e.applied) { u.text = OT.apply(u.text, r.value.op); e.applied = true; }
        u.rev = Math.max(u.rev, r.value.rev);
        u.ownIds[e.clientId] = true;
        last = { ok: true, rev: r.value.rev, baseRev: r.value.baseRev, transformed: r.value.transformed, durable: r.value.durable, explain: last.explain };
      }
      if (!u.outstanding.length) { u.status = 'saved'; st.stats.unsaved = 0; }
    } finally { u.sending = false; u.lastResult = last; }
    return last;
  }

  /** Fetch revisions (u.rev, upto] from the session and apply them. */
  function* catchUp(ctx, who, upto) {
    const u = ctx.ui[who];
    const r = yield ctx.call('gw', 'since', { who, rev: u.rev, upto }, { timeout: 800 });
    if (!r.ok) return;
    ctx.state.stats.backfills++;
    for (const row of r.value.ops) applyRemote(ctx, who, row);
    ctx.log({ op: `backfilled ${r.value.ops.length} revision${r.value.ops.length === 1 ? '' : 's'}`, status: 'recovered', detail: `${PEOPLE[who]}’s copy was at revision ${r.value.from}; the server was at ${upto}. The missing operations were fetched and applied.` });
  }

  /** Apply a remote operation to a client copy, transforming it against anything not yet acknowledged. */
  function applyRemote(ctx, who, row) {
    const u = ctx.ui[who];
    if (row.rev <= u.rev) { ctx.state.stats.dupsIgnored++; return false; }
    u.rev = row.rev;
    if (u.ownIds[row.clientId] || row.who === who) return true;
    let op = row.op;
    for (const e of u.outstanding) {
      if (!e.applied) continue;
      const mine = e.op;
      e.op = OT.transform(mine, op, false);
      op = OT.transform(op, mine, true);
    }
    u.text = OT.apply(u.text, op);
    if (row.cursor != null) u.peerCursor = row.cursor;
    return true;
  }

  function startReload(sim, who) {
    sim.startAction(`${PEOPLE[who]}: reload the document`, function* (ctx) {
      const u = ctx.ui[who];
      Y.L(ctx, { retrySafe: ['yes', 'Read only.'] });
      const r = yield ctx.call('gw', 'open', { who }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, 'The document could not be opened.'); ctx.explain(`Open failed: ${r.error.message}`); return; }
      const before = u.text;
      u.text = r.value.text; u.rev = r.value.rev; u.outstanding = []; u.status = 'saved';
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'yes', async: 'n/a' });
      ctx.explain(before === r.value.text
        ? `Reloaded from snapshot revision ${r.value.snapRev} plus ${r.value.tail} logged operation${r.value.tail === 1 ? '' : 's'}: the same text ${PEOPLE[who]} was already looking at.`
        : `Reloaded from snapshot revision ${r.value.snapRev} plus ${r.value.tail} logged operation${r.value.tail === 1 ? '' : 's'}. The text differs from what ${PEOPLE[who]} saw before: an edit that was shown as saved was never in the log.`);
    }, { self: who });
  }

  /** The sequencer's critical section: transform, assign the revision, log, broadcast. */
  function* commit(ctx, p) {
    const st = ctx.state;
    let op = p.op;
    const since = st.log.filter((r) => r.rev > p.baseRev);
    for (const r of since) op = OT.transform(op, r.op, false);
    st.stats.transformed += since.length;
    const rev = st.doc.rev + 1;
    const row = { rev, op, who: p.who, clientId: p.clientId, baseRev: p.baseRev, t: ctx.now() };
    const append = function* () { const w = yield ctx.call('oplog', 'append', row, { timeout: 900 }); return w.ok; };
    if (st.config.durable && !(yield* append())) ctx.fail('UNAVAILABLE', 'The operation log is not accepting writes; the edit was not committed.');
    st.doc.rev = rev;
    st.doc.text = OT.apply(st.doc.text, op);
    st.log.push(row);
    st.byClient[p.clientId] = rev;
    st.stats.ops++;
    const pr = yield ctx.call('presence', 'set', { who: p.who, cursor: op.pos + (op.ins ? op.ins.length : 0) }, { timeout: 300, quiet: true });
    const cursor = pr.ok ? pr.value.cursor : null;
    if (ctx.mode('drop', 'pubsub')) { st.stats.dropped++; ctx.log({ op: `broadcast of revision ${rev} dropped`, status: 'lost', detail: 'Pub/sub lost the message. The other phone will only learn of this revision from a later gap or a reload.' }); }
    else { ctx.sim.enqueue('bcast', { type: `rev ${rev}`, eventId: `r${rev}`, payload: { rev, op, who: p.who, clientId: p.clientId, cursor } }); st.stats.broadcasts++; }
    ctx.sim.enqueue('commits', { type: 'commit', eventId: `c${rev}`, payload: { rev }, quiet: true });
    if (!st.config.durable) {
      ctx.spawn(function* (c) {
        const ok = yield* append();
        if (!ok) { st.lost.push(rev); c.log({ op: `revision ${rev} acknowledged but not logged`, status: 'err', detail: 'Both phones show it as saved. The log never will. A reload loses it.' }); }
      });
    }
    return { rev, op, baseRev: p.baseRev, transformed: since.length, durable: st.config.durable };
  }

  /** A phone receives a broadcast: detect a gap first, then apply. */
  function* receive(ctx, who, row) {
    const u = ctx.ui[who];
    if (row.rev > u.rev + 1) {
      ctx.log({ op: `gap: expected revision ${u.rev + 1}, got ${row.rev}`, status: 'retry', detail: 'A broadcast was missed. Fetching the missing revisions before applying this one.' });
      yield* catchUp(ctx, who, row.rev - 1);
    }
    return applyRemote(ctx, who, row);
  }

  /* ---------- scenario ---------- */
  SDL.scenarios['docs-edit'] = {
    id: 'docs-edit',
    seed: 1203,
    productWidth: 640,
    intro: 'Type on Ana’s phone and watch the word reach Ben’s. Then make both phones type at the same spot, lose a reply and resend, or take the operation log down and see what “Saved” has to mean.',
    modeLabels: { drop: 'Dropping messages' },
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'ana', label: 'Ana’s phone', sub: 'Owner, editing', kind: 'client', x: 90, y: 120, latency: 1, role: 'Applies each keystroke locally at once, sends it as an operation with its base revision, and transforms incoming operations against anything it has not had acknowledged.', ops: [{ name: 'push', desc: 'A remote operation arrives.' }], owns: ['Local copy', 'Outstanding operations'] },
        { id: 'ben', label: 'Ben’s phone', sub: 'Editor', kind: 'client', x: 90, y: 400, latency: 1, role: 'Same as Ana’s phone.', ops: [{ name: 'push', desc: 'A remote operation arrives.' }], owns: ['Local copy', 'Outstanding operations'] },
        { id: 'gw', label: 'WebSocket gateway', sub: 'Sockets', kind: 'gateway', x: 320, y: 260, latency: 2, role: 'Holds both sockets, forwards submits to the session service, and pushes broadcast operations down every other socket on the document.', ops: [{ name: 'submit', desc: 'An operation from a client.' }, { name: 'open', desc: 'Load the document.' }, { name: 'since', desc: 'Operations after a revision.' }, { name: 'push', desc: 'Write to a socket.' }], owns: ['Open sockets'] },
        { id: 'session', label: 'Document session', sub: 'One per open document', kind: 'service', x: 560, y: 260, latency: 4, role: 'The single sequencer for this document: checks access, transforms the operation against everything committed since its base revision, appends it to the log, assigns the revision, and broadcasts it.', ops: [{ name: 'submit', desc: 'Order, transform, commit, broadcast.' }, { name: 'open', desc: 'Snapshot plus tail.' }, { name: 'since', desc: 'Backfill.' }], owns: ['In-memory text and head revision'] },
        { id: 'meta', label: 'Metadata and ACL', sub: 'Who may edit', kind: 'db', x: 800, y: 80, latency: 6, role: 'Document metadata and the access-control list checked on every open and every operation.', ops: [{ name: 'check', desc: 'May this user edit?' }], owns: ['acl[doc]'] },
        { id: 'oplog', label: 'Operation log', sub: 'Append-only, by revision', kind: 'db', x: 800, y: 260, latency: 10, role: 'The durable history: one row per revision. “Saved” means the row is here.', ops: [{ name: 'append', desc: 'Write one revision.' }, { name: 'read', desc: 'Revisions after a point.' }], owns: ['log[doc][rev]'] },
        { id: 'presence', label: 'Presence', sub: 'Cursors, TTL', kind: 'cache', x: 800, y: 440, latency: 2, role: 'Where each collaborator’s cursor is. Never durable: if it is lost, nobody loses work.', ops: [{ name: 'set', desc: 'Record a cursor.' }], owns: ['cursor[doc][user]'] },
        { id: 'pubsub', label: 'Pub/sub', sub: 'Per-document channel', kind: 'queue', x: 560, y: 480, latency: 3, role: 'Fans each committed operation out to every gateway that holds a socket on this document, and feeds the snapshot worker.', owns: ['Channel per document'] },
        { id: 'snapper', label: 'Snapshot worker', sub: `Every ${SNAP_EVERY} revisions`, kind: 'worker', x: 1030, y: 480, latency: 5, role: 'Folds the log into a snapshot so a fresh open does not replay the whole history.', owns: ['Nothing durable'] },
        { id: 'snap', label: 'Snapshot store', sub: 'Text at a revision', kind: 'store', x: 1030, y: 260, latency: 8, role: 'The latest snapshot of the document and the revision it represents.', ops: [{ name: 'write', desc: 'Store a snapshot.' }, { name: 'read', desc: 'Latest snapshot.' }], owns: ['snapshot[doc]'] },
      ],
      edges: [
        { from: 'ana', to: 'gw', latency: 30, label: 'WebSocket' },
        { from: 'ben', to: 'gw', latency: 30, label: 'WebSocket' },
        { from: 'gw', to: 'session', latency: 3 },
        { from: 'session', to: 'meta', latency: 3 },
        { from: 'session', to: 'oplog', latency: 4 },
        { from: 'session', to: 'presence', latency: 3 },
        { from: 'session', to: 'pubsub', latency: 3 },
        { from: 'pubsub', to: 'gw', latency: 3, via: [[320, 480]] },
        { from: 'pubsub', to: 'snapper', latency: 3 },
        { from: 'snapper', to: 'oplog', latency: 4 },
        { from: 'snapper', to: 'snap', latency: 4 },
        { from: 'session', to: 'snap', latency: 4, via: [[800, 180], [1030, 180]] },
      ],
      queues: [
        { id: 'bcast', broker: 'pubsub', label: 'Document channel', groups: ['gw'] },
        { id: 'commits', broker: 'pubsub', label: 'Commits', groups: ['snapper'] },
      ],
    },
    failures: [
      { id: 'gw-drop', node: 'gw', mode: 'dropResponse', label: 'Gateway loses acknowledgements', desc: 'Operations are committed but the sender never hears back and resends.' },
      { id: 'session-hang', node: 'session', mode: 'hang', label: 'Session service hangs', desc: 'Submits time out; edits stay unsaved on the phones.' },
      { id: 'log-slow', node: 'oplog', mode: 'slow', params: { factor: 40 }, label: 'Operation log slow', desc: '“Saving…” lingers; nothing is lost.' },
      { id: 'log-down', node: 'oplog', mode: 'down', label: 'Operation log down', desc: 'Nothing can be made durable.' },
      { id: 'pubsub-drop', node: 'pubsub', mode: 'drop', label: 'Pub/sub drops messages', desc: 'Committed operations are not broadcast; the other phone falls behind until it detects the gap.' },
      { id: 'pubsub-dup', node: 'pubsub', mode: 'duplicate', label: 'Pub/sub duplicates messages', desc: 'Every broadcast arrives twice.' },
      { id: 'meta-down', node: 'meta', mode: 'down', label: 'ACL database down', desc: 'Access cannot be checked; the session refuses edits rather than guessing.' },
      { id: 'presence-down', node: 'presence', mode: 'down', label: 'Presence down', desc: 'No cursors. Editing continues.' },
    ],
    switches: Y.switches([
      ['optimistic', 'Optimistic local echo', 'Apply each keystroke on the phone before the server answers. Off: text appears only when acknowledged.'],
      ['idem', 'Client operation ids', 'Each operation carries an id made on the phone; a resend returns the existing revision. Off: a resend is a new operation.'],
      ['durable', 'Acknowledge only after the log write', 'The session appends to the operation log before answering. Off: answer first, write after.'],
      ['coalesce', 'Coalesce keystrokes', 'Characters typed within a short window are sent as one operation. Off: one operation per character.'],
    ]),
    presets: Y.presets({ optimistic: true, idem: true, durable: true, coalesce: true }, [
      { id: 'type', label: 'Type and watch it arrive', desc: 'Ana types a sentence; it shows at once on her phone, is committed as a revision, and reaches Ben in about 100 ms. Ben replies.', run: (s) => { startType(s, 'ana'); s.schedule(1500, () => startType(s, 'ben')); } },
      { id: 'apart', label: 'Both type, different places', desc: 'Ana at the end, Ben at the start, at the same moment. Each operation is transformed against the other, and both screens end identical.', run: (s) => { s.ui.ben.cursor = 'start'; startType(s, 'ana'); s.schedule(40, () => startType(s, 'ben')); } },
      { id: 'same-spot', label: 'Both type at the same spot', desc: 'Two inserts at the same position in the same instant. The session orders them; the loser is shifted past the winner. Both words survive and both screens agree.', run: (s) => { startType(s, 'ana'); s.schedule(20, () => startType(s, 'ben')); } },
      { id: 'per-char', label: 'One operation per character', desc: 'Without coalescing a ten-character word is ten round trips, one in flight at a time. Same result, far more operations.', sw: { coalesce: false }, run: (s) => { startType(s, 'ana'); } },
      { id: 'resend', label: 'Lost acknowledgement, client id', desc: 'The operation is committed but the reply is lost. Ana resends with the same id; the session returns the existing revision. One copy.', run: (s) => { s.inject('gw', 'dropResponse', true, 700); startType(s, 'ana'); } },
      { id: 'resend-bad', label: 'Lost acknowledgement, no client id', desc: 'The resend looks like a new operation. The document, and Ben’s screen, now contain Ana’s sentence twice.', sw: { idem: false }, run: (s) => { s.inject('gw', 'dropResponse', true, 700); startType(s, 'ana'); } },
      { id: 'log-down', label: 'Log down, acknowledge after write', desc: 'The session cannot append, so it refuses. Ana’s text stays on screen marked unsaved and is resent when the log returns. Nothing was called saved that is not.', run: (s) => { s.inject('oplog', 'down'); startType(s, 'ana'); } },
      { id: 'log-down-bad', label: 'Log down, acknowledge first', desc: '“Saved” appears, Ben receives the text, then the log write fails. The log recovers, Ben reloads, and the sentence is gone: an edit everyone saw never existed.', sw: { durable: false }, run: (s) => { s.inject('oplog', 'down', true, 1500); startType(s, 'ana'); s.schedule(2500, () => startReload(s, 'ben')); } },
      { id: 'pubsub-drop', label: 'Pub/sub drops the broadcast', desc: 'Ana’s revision is committed but never reaches Ben. His copy is behind and nothing tells him yet.', run: (s) => { s.inject('pubsub', 'drop'); startType(s, 'ana'); } },
      { id: 'pubsub-heal', label: 'Dropped broadcast, then a gap', desc: 'The next revision that does arrive has a number Ben did not expect. He fetches the missing operations from the session and catches up.', run: (s) => { s.inject('pubsub', 'drop', true, 600); startType(s, 'ana'); s.schedule(1500, () => startType(s, 'ana')); } },
      { id: 'pubsub-dup', label: 'Pub/sub duplicates the broadcast', desc: 'Ben receives every operation twice. Revision numbers make the second copy obvious, so it is ignored.', run: (s) => { s.inject('pubsub', 'duplicate'); startType(s, 'ana'); } },
      { id: 'acl-down', label: 'ACL database down', desc: 'The session cannot confirm Ana may edit, so it refuses rather than guesses. Her text stays unsaved until access can be checked.', run: (s) => { s.inject('meta', 'down'); startType(s, 'ana'); } },
    ]),
    initialState: () => ({
      config: { optimistic: true, idem: true, durable: true, coalesce: true },
      doc: { text: DOC0, rev: 0 }, log: [], logged: {}, byClient: {}, busy: false, snapshot: { text: DOC0, rev: 0 }, lost: [],
      acl: { ana: 'owner', ben: 'editor' }, cursors: {},
      seq: { client: 0 }, stats: { ops: 0, transformed: 0, backfills: 0, dupsIgnored: 0, duplicated: 0, unsaved: 0, dropped: 0, snapshots: 0, broadcasts: 0 },
    }),
    initialUI: () => {
      const phone = (who) => ({ who, text: DOC0, rev: 0, outstanding: [], ownIds: {}, status: 'saved', cursor: 'end', peerCursor: null, typed: 0, sending: false });
      return { ana: phone('ana'), ben: phone('ben') };
    },
    onFailureChange(sim, e) {
      if (e.active) return;
      // Something recovered: phones with unsaved edits send them again.
      for (const who of Object.keys(PEOPLE)) {
        const u = sim.ui[who];
        if (!u.outstanding.length || u.sending) continue;
        sim.startAction(`${PEOPLE[who]}: resend ${u.outstanding.length} unsaved edit${u.outstanding.length === 1 ? '' : 's'}`, function* (ctx) {
          Y.L(ctx, { displayed: 'yes', retrySafe: sim.state.config.idem ? 'yes' : 'no' });
          u.status = 'saving';
          const r = yield* flush(ctx, who);
          if (r.ok) { Y.L(ctx, { accepted: 'yes', committed: 'yes', async: 'pending' }); ctx.explain(`${PEOPLE[who]}’s unsaved edits were sent again once the server could take them, and are now in the log.`); }
          else { Y.L(ctx, { accepted: 'no', committed: 'no', async: 'n/a' }); }
        }, { self: who });
      }
    },
    actions: {
      type(sim, a) { startType(sim, a.who, a.kind); },
      reload(sim, a) { startReload(sim, a.who); },
      set(sim, a) { Y.setAction(sim, a); },
    },
    setup(sim) {
      // Gateway: deliver each broadcast to every socket except the author's.
      Y.consumer(sim, 'bcast', 'gw', 'gw', function* (ctx, msg) {
        const row = msg.payload;
        for (const who of Object.keys(PEOPLE)) {
          if (who === row.who || !online(ctx.sim, who)) continue;
          yield ctx.call(who, 'push', row, { timeout: 500, actionId: msg.actionId });
        }
        return true;
      }, () => false);
      // Snapshot worker: fold the log every SNAP_EVERY revisions.
      Y.consumer(sim, 'commits', 'snapper', 'snapper', function* (ctx, msg) {
        const st = ctx.state;
        if (msg.payload.rev % SNAP_EVERY !== 0) return true;
        const r = yield ctx.call('oplog', 'read', { after: st.snapshot.rev }, { timeout: 900 });
        if (!r.ok) return false;
        let text = st.snapshot.text;
        for (const row of r.value.ops) text = OT.apply(text, row.op);
        const w = yield ctx.call('snap', 'write', { text, rev: r.value.rev }, { timeout: 900 });
        if (!w.ok) return false;
        ctx.log({ op: `snapshot at revision ${r.value.rev}`, status: 'ok', detail: `${r.value.ops.length} operations folded into the snapshot.` });
        return true;
      }, () => false);
    },
    handlers: {
      gw: {
        submit: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'submit', p, { timeout: 1100 })); },
        open: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'open', p, { timeout: 1400 })); },
        since: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'since', p, { timeout: 700 })); },
      },
      session: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          if (st.config.idem && st.byClient[p.clientId] != null) {
            const row = st.log[st.byClient[p.clientId] - 1];
            return { rev: row.rev, op: row.op, baseRev: p.baseRev, transformed: 0, durable: true, replayed: true };
          }
          const acl = ctx.must(yield ctx.call('meta', 'check', { who: p.who }, { timeout: 500 }));
          if (!acl.allowed) ctx.fail('FORBIDDEN', `${PEOPLE[p.who]} may not edit this document.`);
          // One sequencer per document: operations are committed strictly one at a time.
          while (st.busy) yield ctx.wait(5);
          st.busy = true;
          try { return yield* commit(ctx, p); } finally { st.busy = false; }
        },
        open: function* (ctx, p) {
          ctx.must(yield ctx.call('meta', 'check', { who: p.who }, { timeout: 500 }));
          const s = ctx.must(yield ctx.call('snap', 'read', {}, { timeout: 800 }));
          const tail = ctx.must(yield ctx.call('oplog', 'read', { after: s.rev }, { timeout: 900 }));
          let text = s.text;
          for (const row of tail.ops) text = OT.apply(text, row.op);
          return { text, rev: tail.rev, snapRev: s.rev, tail: tail.ops.length };
        },
        since(ctx, p) {
          const st = ctx.state;
          return { from: p.rev, ops: st.log.filter((r) => r.rev > p.rev && (p.upto == null || r.rev <= p.upto)).map((r) => ({ rev: r.rev, op: r.op, who: r.who, clientId: r.clientId })) };
        },
      },
      meta: { check(ctx, p) { return { allowed: !!ctx.state.acl[p.who] && ctx.state.acl[p.who] !== 'viewer' }; } },
      oplog: {
        append(ctx, row) { ctx.state.logged[row.rev] = true; return { rev: row.rev }; },
        read(ctx, p) { const st = ctx.state; const ops = st.log.filter((r) => r.rev > p.after && st.logged[r.rev]); return { ops, rev: ops.length ? ops[ops.length - 1].rev : p.after }; },
      },
      presence: { set(ctx, p) { ctx.state.cursors[p.who] = p.cursor; return { cursor: p.cursor }; } },
      snap: {
        write(ctx, p) { ctx.state.snapshot = { text: p.text, rev: p.rev }; ctx.state.stats.snapshots++; return { rev: p.rev }; },
        read(ctx) { return ctx.state.snapshot; },
      },
      ana: { push: function* (ctx, row) { return { applied: yield* receive(ctx, 'ana', row) }; } },
      ben: { push: function* (ctx, row) { return { applied: yield* receive(ctx, 'ben', row) }; } },
    },
    consistency(sim) {
      const st = sim.state;
      if (st.stats.duplicated) return { key: 'wrong', label: `Ana typed a sentence once; the document contains it ${st.stats.duplicated + 1} times. A resend without a client id became a second operation.` };
      if (st.lost.length) return { key: 'wrong', label: `Revision ${st.lost.join(', ')} was acknowledged and shown as saved on both phones but never reached the operation log. A reload loses it.` };
      const behind = Object.keys(PEOPLE).filter((w) => sim.ui[w].rev < st.doc.rev && !sim.ui[w].outstanding.length);
      const pending = Object.keys(PEOPLE).filter((w) => sim.ui[w].outstanding.length);
      if (pending.length) {
        const unsaved = pending.filter((w) => sim.ui[w].status === 'unsaved');
        if (unsaved.length) return { key: 'stale', label: `${unsaved.map((w) => PEOPLE[w]).join(' and ')} ${unsaved.length > 1 ? 'have' : 'has'} edits on screen that are not saved. They are resent when the server recovers; nothing is lost yet, and nothing was called saved.` };
        return { key: 'stale', label: `${pending.map((w) => PEOPLE[w]).join(' and ')} ${pending.length > 1 ? 'have' : 'has'} operations in flight.` };
      }
      if (behind.length) return { key: 'stale', label: `${behind.map((w) => `${PEOPLE[w]}’s copy is at revision ${sim.ui[w].rev}`).join('; ')}; the document is at ${st.doc.rev}. ${behind.length > 1 ? 'They' : 'It'} will catch up at the next revision or a reload.` };
      const diverged = Object.keys(PEOPLE).filter((w) => sim.ui[w].text !== st.doc.text);
      if (diverged.length) return { key: 'wrong', label: `${diverged.map((w) => PEOPLE[w]).join(' and ')}’s screen does not match the document at the same revision: the copies have diverged.` };
      return { key: 'ok', label: `Both phones show the same text as the document at revision ${st.doc.rev}, and every revision is in the log.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const lat = sim.requests.filter((r) => r.ok).map((r) => r.latency);
      return [
        { label: 'Document revision', value: st.doc.rev },
        { label: 'Operations committed', value: st.stats.ops },
        { label: 'Transformed against concurrent ops', value: st.stats.transformed },
        { label: 'Submit to acknowledgement (p50)', value: lat.length ? SDL.fmtMs(SDL.percentile(lat, 50)) : 'n/a' },
        { label: 'Unsaved on phones', value: Object.values(sim.ui).reduce((a, u) => a + u.outstanding.length, 0), tone: st.stats.unsaved ? 'warn' : '' },
        { label: 'Backfills, duplicates ignored', value: `${st.stats.backfills}, ${st.stats.dupsIgnored}` },
        { label: 'Acknowledged but not logged', value: st.lost.length, tone: st.lost.length ? 'fail' : '' },
        { label: 'Revisions since snapshot', value: st.doc.rev - st.snapshot.rev },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['ana', 'Ana'], ['ben', 'Ben']], {
          note: 'Both phones show the same document. Type on either; the other phone receives the operation through the session service. The chip shows “Saving…” until the revision is in the log. Reload rebuilds the screen from the snapshot and the log, which is the only truth that survives.',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const who of Object.keys(PEOPLE)) {
          const u = sim.ui[who];
          const pos = cursorPos(u);
          const peer = u.peerCursor != null && !sim.nodes.presence.modes.down ? Math.min(u.peerCursor, u.text.length) : null;
          let html = '';
          const marks = [[pos, `<span class="doc-caret" aria-label="${PEOPLE[who]}’s cursor"></span>`]];
          if (peer != null) marks.push([peer, `<span class="doc-caret is-peer" aria-label="${PEOPLE[OTHER[who]]}’s cursor" title="${PEOPLE[OTHER[who]]}"></span>`]);
          marks.sort((a, b) => a[0] - b[0]);
          let last = 0;
          for (const [p, m] of marks) { html += esc(u.text.slice(last, p)) + m; last = p; }
          html += esc(u.text.slice(last));
          const chip = u.status === 'saved' ? ['ok', `Saved · rev ${u.rev}`] : u.status === 'saving' ? ['work', 'Saving…'] : ['fail', `Unsaved · ${u.outstanding.length} edit${u.outstanding.length === 1 ? '' : 's'}`];
          Y.paint(el, sim, who, {
            head: `<div><p class="app-title">Q3 plan</p><p class="app-sub">${online(sim, who) ? 'Connected' : 'Offline'} · ${sim.nodes.presence.modes.down ? 'presence down, no cursors' : peer != null ? `${PEOPLE[OTHER[who]]} is here` : `waiting for ${PEOPLE[OTHER[who]]} to type`}</p></div>`,
            doc: `<div class="app-card doc-page"><p class="doc-text">${html}</p><span class="app-sub doc-chip" data-tone="${chip[0]}">${chip[1]}</span></div>`,
            cursor: `<div class="app-row"><label class="app-sub" for="cur-${who}">Cursor</label> <select id="cur-${who}" data-field="${who}.cursor"><option value="start"${u.cursor === 'start' ? ' selected' : ''}>Start</option><option value="middle"${u.cursor === 'middle' ? ' selected' : ''}>After the colon</option><option value="end"${u.cursor === 'end' ? ' selected' : ''}>End</option></select></div>`,
            keys: `<div class="app-row">${Y.btn('type', `Type “${esc(WORDS[who][u.typed % WORDS[who].length].trim())}”`, { arg: { who, kind: 'ins' }, cls: 'go' })}${Y.btn('type', 'Delete a word', { arg: { who, kind: 'del' }, cls: 'secondary' })}</div>`,
            reload: `<div class="app-row">${Y.btn('reload', 'Reload from the server', { arg: { who }, cls: 'secondary' })}</div>`,
          }, {}, null);
        }
        void st;
      },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
