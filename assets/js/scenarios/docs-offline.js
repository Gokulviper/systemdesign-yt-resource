/*
 * Offline editing and merge.
 * Ana’s phone loses the network. Her keystrokes become operations that carry
 * the revision she last saw and a few characters of surrounding context, and
 * they are persisted to a local store. Ben keeps editing; a compaction worker
 * folds old revisions into the snapshot and deletes them. When Ana reconnects
 * she sends her queue. If the server still has every revision since her base
 * it transforms her operations like any other. If compaction has passed her
 * base it must say so: the phone fetches the current text, re-anchors each
 * operation by its context, and resends. Skipping that handshake transforms
 * against a partial history and the copies silently diverge.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const OT = Y.ot;

  const PEOPLE = { ana: 'Ana', ben: 'Ben' };
  const DOC0 = 'Q3 plan: ship the editor.';
  const WORDS = { ana: [' Hire two.', ' Launch in May.', ' Budget: flat.'], ben: [' Fix sync.', ' Add tests.', ' Ship it.', ' Cut scope.', ' Review Friday.', ' Done.'] };
  const CTX = 8;
  const retain = (st) => (st.config.longRetention ? 40 : 3);
  const offline = (sim) => !!sim.nodes.ana.modes.down;

  function cursorPos(u) { return u.cursor === 'ship' ? u.text.indexOf('ship') + 4 : u.cursor === 'colon' ? u.text.indexOf(':') + 1 : u.text.length; }

  /* ---------- Ana (can be offline) ---------- */
  function startType(sim, who, kind) {
    const st = sim.state;
    const u = sim.ui[who];
    let op;
    if (kind === 'delAll') { const from = u.text.indexOf(':') + 1; op = { pos: from, del: u.text.length - from }; }
    else { const word = WORDS[who][u.typed++ % WORDS[who].length]; const pos = cursorPos(u); op = { pos, ins: word, ctx: u.text.slice(Math.max(0, pos - CTX), pos) }; }
    const label = kind === 'delAll' ? `${PEOPLE[who]}: delete everything after the colon` : `${PEOPLE[who]}: type “${op.ins.trim()}”${who === 'ana' && offline(sim) ? ' (offline)' : ''}`;
    sim.startAction(label, function* (ctx) {
      u.text = OT.apply(u.text, op);
      const entry = { clientId: `${who}-${++st.seq.client}`, op, baseRev: u.rev, applied: true };
      u.outstanding.push(entry);
      Y.L(ctx, { displayed: ['yes', 'Applied locally first.'], retrySafe: st.config.idem ? ['yes', `Client id ${entry.clientId}.`] : ['no', 'No client id.'] });
      if (who === 'ana' && offline(ctx.sim)) {
        u.status = 'offline';
        if (st.config.persist) {
          const w = yield ctx.call('local', 'write', { queue: u.outstanding.map((e) => ({ clientId: e.clientId, op: e.op, baseRev: e.baseRev })), rev: u.rev }, { timeout: 300 });
          Y.L(ctx, { accepted: ['pending', 'Queued on the phone until the network returns.'], committed: ['pending', w.ok ? 'Persisted in the phone’s local store.' : 'Local store failed: held in memory only.'] });
          ctx.explain(w.ok ? `No network. The edit is applied on screen, queued with base revision ${entry.baseRev} and ${CTX} characters of context, and written to the phone’s local store, so it survives an app restart.` : 'No network, and the local store failed: the edit lives only in memory until the app reconnects or dies.');
        } else {
          Y.L(ctx, { accepted: ['pending', 'Queued in memory.'], committed: ['no', 'Not persisted anywhere.'] });
          ctx.explain(`No network. The edit is queued in memory with base revision ${entry.baseRev}. If the app is killed before it reconnects, the edit is gone.`);
        }
        return;
      }
      u.status = 'saving';
      const r = yield* flush(ctx, who);
      if (r.ok) { Y.L(ctx, { accepted: 'yes', committed: 'yes', async: 'pending' }); ctx.explain(r.explain || `Committed as revision ${r.rev}.`); }
      else { Y.L(ctx, { accepted: ['no', r.error.message], committed: 'no', async: 'n/a' }); ctx.explain(`Not saved: ${r.error.message}`); }
    }, { self: who });
  }

  /** Send everything queued as one merge request; handle resync, lost replies, retries. */
  function* flush(ctx, who) {
    const st = ctx.state;
    const u = ctx.ui[who];
    if (u.sending) { while (u.outstanding.length && u.sending) yield ctx.wait(50); return u.lastResult || { ok: true, rev: u.rev }; }
    u.sending = true;
    let last = { ok: true, rev: u.rev };
    try {
      let resynced = false, resent = false;
      for (let attempt = 1; u.outstanding.length && attempt <= 4; attempt++) {
        const batch = u.outstanding.map((e) => ({ clientId: st.config.idem || attempt === 1 ? e.clientId : `${e.clientId}-r${attempt}`, op: e.op, baseRev: e.baseRev }));
        const r = yield ctx.call('gw', 'merge', { who, ops: batch, baseRev: u.rev }, { timeout: 1500 });
        ctx.recordOutcome(r.ok, r.latency);
        if (r.ok) {
          if (resent && !st.config.idem && !r.value.replayed) st.stats.duplicated += r.value.committed.length;
          const n = u.outstanding.length;
          u.outstanding = [];
          for (const row of r.value.missed) applyRemote(ctx, who, row, true);
          u.rev = Math.max(u.rev, r.value.rev);
          for (const row of r.value.committed) u.ownIds[row.clientId] = true;
          // The server may have placed an operation differently from the phone (a partial history): adopt its text only when told it is authoritative.
          if (r.value.text != null && r.value.text !== u.text) { st.stats.diverged = true; }
          st.stats.merged += n;
          if (st.config.persist) yield ctx.call('local', 'write', { queue: [], rev: u.rev }, { timeout: 300, quiet: true });
          u.status = 'saved';
          last = { ok: true, rev: r.value.rev, explain: resynced ? last.explain : resent ? (r.value.replayed ? 'The first merge had arrived; only its reply was lost. The resend carried the same client ids, so the server returned the existing revisions.' : `The first merge had arrived; only its reply was lost. Without client ids the resend committed ${n} operation${n > 1 ? 's' : ''} again.`) : `${n} queued operation${n > 1 ? 's were' : ' was'} merged: transformed against ${r.value.transformedAgainst} revision${r.value.transformedAgainst === 1 ? '' : 's'} committed while ${PEOPLE[who]} was away, now revision ${r.value.rev}.` };
          break;
        }
        if (r.error.code === 'RESYNC_REQUIRED') {
          st.stats.resyncs++; resynced = true;
          const fresh = r.error.detail;
          const kept = [], conflicts = [];
          let text = fresh.text;
          for (const e of u.outstanding) {
            const op = e.op;
            if (op.del) { conflicts.push({ clientId: e.clientId, why: 'a deletion cannot be re-anchored safely' }); continue; }
            const at = op.ctx ? text.indexOf(op.ctx) : -1;
            const pos = op.ctx === '' ? 0 : at >= 0 ? at + op.ctx.length : -1;
            if (pos < 0) { conflicts.push({ clientId: e.clientId, text: op.ins, why: `the text around it (“${op.ctx.trim()}”) no longer exists` }); continue; }
            const re = { pos, ins: op.ins, ctx: op.ctx };
            text = OT.apply(text, re);
            kept.push({ clientId: e.clientId, op: re, baseRev: fresh.rev, applied: true });
          }
          u.text = text; u.rev = fresh.rev; u.outstanding = kept; u.conflicts = u.conflicts.concat(conflicts);
          st.stats.reanchored += kept.length; st.stats.conflicts += conflicts.length;
          ctx.log({ op: `full resync at revision ${fresh.rev}: ${kept.length} re-anchored, ${conflicts.length} need attention`, status: 'retry', detail: `Compaction had removed revisions after ${PEOPLE[who]}’s base ${r.error.detail.base}. The phone fetched the current text and re-placed each insert by its surrounding context.` });
          if (!kept.length) { u.status = 'saved'; last = { ok: true, rev: u.rev, explain: `The server had compacted past ${PEOPLE[who]}’s base revision, so it asked for a full resync. None of her queued edits could be re-anchored; they are listed for her to re-apply by hand rather than silently dropped.` }; break; }
          last.explain = `The server had compacted past ${PEOPLE[who]}’s base revision and asked for a full resync. The phone fetched revision ${fresh.rev}, re-anchored ${kept.length} insert${kept.length > 1 ? 's' : ''} by context${conflicts.length ? ` and set ${conflicts.length} aside for her` : ''}, and sent them as fresh operations.`;
          continue;
        }
        if (['TIMEOUT', 'UNAVAILABLE'].includes(r.error.code)) { resent = true; ctx.log({ op: 'no reply: resending the queue', status: 'retry', error: r.error, detail: st.config.idem ? 'Same client ids.' : 'No client ids: the server cannot tell this from new work.' }); yield ctx.wait(300 * attempt); last = { ok: false, error: r.error }; continue; }
        u.status = 'unsaved'; last = { ok: false, error: r.error }; break;
      }
      if (u.outstanding.length && !last.ok) u.status = 'unsaved';
    } finally { u.sending = false; u.lastResult = last; }
    return last;
  }
  function applyRemote(ctx, who, row, fromMerge) {
    const u = ctx.ui[who];
    if (row.rev <= u.rev) { return false; }
    u.rev = row.rev;
    if (u.ownIds[row.clientId] || row.who === who) return true;
    let op = row.op;
    for (const e of u.outstanding) { const mine = e.op; e.op = Object.assign({}, OT.transform(mine, op, false), { ctx: mine.ctx }); op = OT.transform(op, mine, true); }
    u.text = OT.apply(u.text, op);
    void fromMerge;
    return true;
  }
  function* receive(ctx, who, row) {
    const u = ctx.ui[who];
    if (who === 'ana' && offline(ctx.sim)) return false;
    if (row.rev > u.rev + 1) { const r = yield ctx.call('gw', 'since', { rev: u.rev, upto: row.rev - 1 }, { timeout: 700 }); if (r.ok) for (const x of r.value.ops) applyRemote(ctx, who, x); }
    return applyRemote(ctx, who, row);
  }

  function startRestart(sim) {
    const st = sim.state;
    const u = sim.ui.ana;
    sim.startAction('Ana: the app is killed and reopened', function* (ctx) {
      const had = u.outstanding.length;
      u.outstanding = []; u.text = u.lastSynced.text; u.rev = u.lastSynced.rev; u.sending = false;
      Y.L(ctx, { retrySafe: 'yes' });
      const r = yield ctx.call('local', 'read', {}, { timeout: 300 });
      const q = r.ok ? r.value.queue : [];
      for (const e of q) { u.outstanding.push({ clientId: e.clientId, op: e.op, baseRev: e.baseRev, applied: true }); u.text = OT.apply(u.text, e.op); }
      if (q.length) { Y.L(ctx, { displayed: 'yes', accepted: 'pending', committed: ['yes', 'Recovered from the local store.'] }); ctx.explain(`The app restarted and found ${q.length} queued operation${q.length > 1 ? 's' : ''} in its local store. They are back on screen and will be sent on reconnect.`); }
      else if (had) { st.lost.push(...Array(had).fill(1)); Y.L(ctx, { displayed: ['no', 'Gone.'], accepted: 'no', committed: ['no', 'Never persisted.'] }); ctx.explain(`The app restarted. ${had} offline edit${had > 1 ? 's were' : ' was'} held only in memory, so ${had > 1 ? 'they are' : 'it is'} gone. Nothing on any server ever knew about ${had > 1 ? 'them' : 'it'}.`); }
      else { Y.L(ctx, { displayed: 'yes', accepted: 'n/a', committed: 'n/a', async: 'n/a' }); ctx.explain('The app restarted with nothing queued.'); }
      u.status = offline(ctx.sim) ? 'offline' : u.outstanding.length ? 'saving' : 'saved';
      if (!offline(ctx.sim) && u.outstanding.length) yield* flush(ctx, 'ana');
    }, { self: 'ana' });
  }

  /* ---------- server ---------- */
  function* commitOne(ctx, p, who, conc) {
    const st = ctx.state;
    if (st.byClient[p.clientId] != null) { const row = st.log.find((r) => r.rev === st.byClient[p.clientId]); return { row, replayed: true }; }
    let op = p.op;
    for (const c of conc) op = OT.transform(op, c, false);
    const rev = st.doc.rev + 1;
    const row = { rev, op, who, clientId: p.clientId, baseRev: p.baseRev };
    ctx.must(yield ctx.call('oplog', 'append', row, { timeout: 900 }));
    st.doc.rev = rev; st.doc.text = OT.apply(st.doc.text, op); st.log.push(row); st.byClient[p.clientId] = rev; st.stats.ops++;
    ctx.sim.enqueue('bcast', { type: `rev ${rev}`, eventId: `r${rev}`, payload: row });
    return { row, transformedAgainst: conc.length };
  }

  SDL.scenarios['docs-offline'] = {
    id: 'docs-offline',
    seed: 404,
    productWidth: 640,
    intro: 'Put Ana in airplane mode, type, let Ben edit, and reconnect. Then stay offline long enough for compaction to pass her base revision, with and without the resync handshake.',
    modeLabels: {},
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'ana', label: 'Ana’s phone', sub: 'Can go offline', kind: 'client', x: 90, y: 110, latency: 1, role: 'Queues operations while offline, each with its base revision and a little surrounding context, and merges them on reconnect.', ops: [{ name: 'push', desc: 'A remote operation.' }], owns: ['Local copy', 'Offline queue'] },
        { id: 'local', label: 'Local store', sub: 'On Ana’s phone', kind: 'store', x: 90, y: 300, latency: 2, role: 'IndexedDB or SQLite on the device. Holds the offline queue so an app restart does not lose it.', ops: [{ name: 'write', desc: 'Persist the queue.' }, { name: 'read', desc: 'Recover the queue.' }], owns: ['queue', 'last synced revision'] },
        { id: 'ben', label: 'Ben’s phone', sub: 'Online', kind: 'client', x: 90, y: 480, latency: 1, role: 'Keeps editing while Ana is away.', ops: [{ name: 'push', desc: 'A remote operation.' }], owns: ['Local copy'] },
        { id: 'gw', label: 'WebSocket gateway', sub: 'Sockets', kind: 'gateway', x: 340, y: 300, latency: 2, role: 'Forwards merges and pushes broadcasts.', ops: [{ name: 'merge', desc: 'A batch of queued operations.' }, { name: 'since', desc: 'Backfill.' }], owns: ['Sockets'] },
        { id: 'session', label: 'Document session', sub: 'Sequencer', kind: 'service', x: 590, y: 300, latency: 4, role: 'Transforms a merge against every revision since its base. If those revisions are gone, it demands a full resync instead of guessing.', ops: [{ name: 'merge', desc: 'Transform and commit a batch.' }, { name: 'since', desc: 'Revisions after a point.' }], owns: ['Text, head revision'] },
        { id: 'oplog', label: 'Operation log', sub: 'Recent revisions', kind: 'db', x: 860, y: 140, latency: 8, role: 'Revisions since the last compaction. Older ones live only inside the snapshot.', ops: [{ name: 'append', desc: 'Write a revision.' }, { name: 'trim', desc: 'Delete compacted rows.' }], owns: ['log[rev]'] },
        { id: 'snap', label: 'Snapshot', sub: 'Text at a revision', kind: 'store', x: 860, y: 460, latency: 6, role: 'The folded history. Everything before its revision has been forgotten as individual operations.', ops: [{ name: 'write', desc: 'Store a snapshot.' }], owns: ['snapshot'] },
        { id: 'compactor', label: 'Compaction worker', sub: 'Keeps the log short', kind: 'worker', x: 1060, y: 300, latency: 5, role: 'Periodically folds old revisions into the snapshot and deletes them from the log, keeping only a retention window.', owns: ['Nothing durable'] },
        { id: 'pubsub', label: 'Pub/sub', sub: 'Document channel', kind: 'queue', x: 590, y: 480, latency: 3, role: 'Broadcasts committed operations.', owns: ['Channel'] },
      ],
      edges: [
        { from: 'ana', to: 'gw', latency: 30, label: 'WebSocket' },
        { from: 'ana', to: 'local', latency: 2 },
        { from: 'ben', to: 'gw', latency: 30, label: 'WebSocket' },
        { from: 'gw', to: 'session', latency: 3 },
        { from: 'session', to: 'oplog', latency: 4 },
        { from: 'session', to: 'pubsub', latency: 3 },
        { from: 'pubsub', to: 'gw', latency: 3, via: [[340, 480]] },
        { from: 'compactor', to: 'oplog', latency: 4 },
        { from: 'compactor', to: 'snap', latency: 4 },
        { from: 'session', to: 'snap', latency: 4 },
      ],
      queues: [{ id: 'bcast', broker: 'pubsub', label: 'Document channel', groups: ['gw'] }],
    },
    failures: [
      { id: 'ana-off', node: 'ana', mode: 'down', label: 'Ana in airplane mode', desc: 'No socket. Her edits queue on the phone.' },
      { id: 'gw-drop', node: 'gw', mode: 'dropResponse', label: 'Gateway loses replies', desc: 'A merge is committed but Ana never hears back and resends.' },
      { id: 'session-hang', node: 'session', mode: 'hang', label: 'Session hangs', desc: 'Merges time out; the queue stays on the phone.' },
      { id: 'local-down', node: 'local', mode: 'down', label: 'Local store failing', desc: 'Offline edits cannot be persisted; they live in memory only.' },
      { id: 'compactor-down', node: 'compactor', mode: 'down', label: 'Compaction paused', desc: 'The log keeps every revision; merges never need a resync.' },
    ],
    switches: Y.switches([
      ['persist', 'Persist the offline queue locally', 'Queued operations are written to the phone’s local store. Off: memory only.'],
      ['idem', 'Client operation ids', 'A resent merge returns the existing revisions. Off: it commits again.'],
      ['handshake', 'Full resync when the base is compacted', 'The server refuses to merge against a partial history and sends the current text; the phone re-anchors by context. Off: transform against whatever is left.'],
      ['longRetention', 'Long retention window (40 revisions)', 'Compaction keeps 40 revisions instead of 3, so short offline periods never need a resync.'],
    ]),
    presets: Y.presets({ persist: true, idem: true, handshake: true, longRetention: false }, [
      { id: 'short', label: 'Offline briefly, then merge', desc: 'Ana types two sentences offline while Ben types one. Her base revision is still in the log, so the merge is an ordinary transform.', run: (s) => { s.inject('ana', 'down', true, 2500); s.schedule(200, () => startType(s, 'ana')); s.schedule(600, () => startType(s, 'ben')); s.schedule(900, () => startType(s, 'ana')); } },
      { id: 'long', label: 'Offline past compaction, handshake', desc: 'Ben commits six revisions; compaction folds the early ones away. Ana’s base is gone, so the server demands a resync; her phone re-anchors each sentence by its context and resends.', run: (s) => { s.inject('ana', 'down', true, 4500); s.schedule(200, () => startType(s, 'ana')); for (let i = 0; i < 6; i++) s.schedule(400 + i * 450, () => startType(s, 'ben')); s.schedule(1500, () => startType(s, 'ana')); } },
      { id: 'long-bad', label: 'Offline past compaction, no handshake', desc: 'The server transforms Ana’s queue against the revisions it still has and commits. Her phone and the document now disagree, and nothing says so.', sw: { handshake: false }, run: (s) => { s.inject('ana', 'down', true, 4500); s.schedule(200, () => startType(s, 'ana')); for (let i = 0; i < 6; i++) s.schedule(400 + i * 450, () => startType(s, 'ben')); s.schedule(1500, () => startType(s, 'ana')); } },
      { id: 'long-retention', label: 'Offline past three revisions, long retention', desc: 'Same offline period, but the log keeps 40 revisions. No resync needed: retention is a product decision about how long people may be away.', sw: { longRetention: true }, run: (s) => { s.inject('ana', 'down', true, 4500); s.schedule(200, () => startType(s, 'ana')); for (let i = 0; i < 6; i++) s.schedule(400 + i * 450, () => startType(s, 'ben')); s.schedule(1500, () => startType(s, 'ana')); } },
      { id: 'resend', label: 'Merge reply lost, client ids', desc: 'The merge is committed but the reply is lost. Ana resends the same queue with the same ids; the server returns the existing revisions.', run: (s) => { s.inject('ana', 'down', true, 1500); s.schedule(200, () => startType(s, 'ana')); s.schedule(700, () => startType(s, 'ana')); s.schedule(1400, () => s.inject('gw', 'dropResponse', true, 1100)); } },
      { id: 'resend-bad', label: 'Merge reply lost, no client ids', desc: 'The resend is indistinguishable from new work: both sentences are committed twice.', sw: { idem: false }, run: (s) => { s.inject('ana', 'down', true, 1500); s.schedule(200, () => startType(s, 'ana')); s.schedule(700, () => startType(s, 'ana')); s.schedule(1400, () => s.inject('gw', 'dropResponse', true, 1100)); } },
      { id: 'restart', label: 'App killed while offline, persisted queue', desc: 'Ana types offline, the app is killed, reopened, and finds its queue in the local store. Reconnecting merges it.', run: (s) => { s.inject('ana', 'down', true, 3000); s.schedule(200, () => startType(s, 'ana')); s.schedule(700, () => startType(s, 'ana')); s.schedule(1500, () => startRestart(s)); } },
      { id: 'restart-bad', label: 'App killed while offline, memory only', desc: 'Same, without persistence. The queue dies with the process. No server ever heard of those edits.', sw: { persist: false }, run: (s) => { s.inject('ana', 'down', true, 3000); s.schedule(200, () => startType(s, 'ana')); s.schedule(700, () => startType(s, 'ana')); s.schedule(1500, () => startRestart(s)); } },
      { id: 'conflict', label: 'Ben deletes the text Ana edited offline', desc: 'Ana inserts after “ship” while offline. Ben deletes everything after the colon and keeps typing until compaction passes her base. On resync the context is gone, so the insert is set aside for Ana instead of being dropped or guessed.', run: (s) => { s.ui.ana.cursor = 'ship'; s.inject('ana', 'down', true, 4500); s.schedule(200, () => startType(s, 'ana')); s.schedule(400, () => startType(s, 'ben', 'delAll')); for (let i = 0; i < 5; i++) s.schedule(900 + i * 450, () => startType(s, 'ben')); } },
      { id: 'session-hang', label: 'Session hangs during the merge', desc: 'Ana reconnects but the merge times out. The queue stays on the phone, still persisted, and goes out when the session answers.', run: (s) => { s.inject('ana', 'down', true, 1500); s.schedule(200, () => startType(s, 'ana')); s.schedule(1400, () => s.inject('session', 'hang')); } },
    ]),
    initialState: () => ({
      config: { persist: true, idem: true, handshake: true, longRetention: false },
      doc: { text: DOC0, rev: 0 }, log: [], byClient: {}, busy: false, snapshot: { text: DOC0, rev: 0 }, compactedUpTo: 0, local: { queue: [], rev: 0 }, lost: [],
      seq: { client: 0 }, stats: { ops: 0, merged: 0, resyncs: 0, reanchored: 0, conflicts: 0, duplicated: 0, compactions: 0, trimmed: 0, diverged: false },
    }),
    initialUI: () => {
      const phone = (who) => ({ who, text: DOC0, rev: 0, outstanding: [], ownIds: {}, status: 'saved', cursor: 'end', typed: 0, sending: false, conflicts: [], lastSynced: { text: DOC0, rev: 0 } });
      return { ana: phone('ana'), ben: phone('ben') };
    },
    onFailureChange(sim, e) {
      if (e.node !== 'ana' || e.mode !== 'down') return;
      const u = sim.ui.ana;
      if (e.active) { u.status = u.outstanding.length ? 'offline' : 'offline'; return; }
      sim.startAction('Ana: back online, syncing', function* (ctx) {
        Y.L(ctx, { displayed: 'yes', retrySafe: ctx.state.config.idem ? 'yes' : 'no' });
        // First catch up on what was missed, then merge the queue.
        const r = yield ctx.call('gw', 'since', { rev: u.rev }, { timeout: 700 });
        if (r.ok) { if (r.error && r.error.code) { /* unreachable */ } }
        if (r.ok && r.value.ok === false) { /* compacted: the merge will say so */ }
        if (r.ok && r.value.ops) for (const row of r.value.ops) applyRemote(ctx, 'ana', row);
        if (!u.outstanding.length) { u.status = 'saved'; u.lastSynced = { text: u.text, rev: u.rev }; Y.L(ctx, { accepted: 'n/a', committed: 'n/a', async: 'n/a' }); ctx.explain(`Ana reconnected with nothing queued and caught up to revision ${u.rev}.`); return; }
        u.status = 'saving';
        const m = yield* flush(ctx, 'ana');
        if (m.ok) { u.lastSynced = { text: u.text, rev: u.rev }; Y.L(ctx, { accepted: 'yes', committed: 'yes', async: 'pending' }); ctx.explain(m.explain); }
        else { Y.L(ctx, { accepted: ['no', m.error.message], committed: 'no', async: 'n/a' }); ctx.explain(`The merge failed: ${m.error.message}. The queue stays on the phone and is retried.`); }
      }, { self: 'ana' });
    },
    actions: {
      type(sim, a) { startType(sim, a.who, a.kind); },
      toggle(sim) { if (offline(sim)) sim.restore('ana', 'down'); else sim.inject('ana', 'down'); },
      restart(sim) { startRestart(sim); },
      set(sim, a) { Y.setAction(sim, a); },
    },
    setup(sim) {
      Y.consumer(sim, 'bcast', 'gw', 'gw', function* (ctx, msg) {
        const row = msg.payload;
        for (const who of Object.keys(PEOPLE)) { if (who === row.who || (who === 'ana' && offline(ctx.sim))) continue; yield ctx.call(who, 'push', row, { timeout: 800 }); }
        return true;
      }, () => false);
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(700);
          const st = ctx.state;
          if (ctx.sim.nodes.compactor.modes.down) continue;
          const keep = retain(st);
          const old = st.log.filter((r) => r.rev <= st.doc.rev - keep);
          if (!old.length) continue;
          let text = st.snapshot.text;
          for (const r of old) text = OT.apply(text, r.op);
          const upTo = old[old.length - 1].rev;
          const w = yield ctx.call('snap', 'write', { text, rev: upTo }, { timeout: 600, quiet: true });
          if (!w.ok) continue;
          const t = yield ctx.call('oplog', 'trim', { upTo }, { timeout: 600, quiet: true });
          if (!t.ok) continue;
          st.stats.compactions++;
          ctx.log({ op: `compacted through revision ${upTo}`, status: 'note', detail: `${old.length} revision${old.length > 1 ? 's' : ''} folded into the snapshot and deleted from the log. A phone whose base is older than ${upTo} can no longer be merged by transformation.` });
        }
      }, { self: 'compactor', quiet: 'all' });
    },
    handlers: {
      gw: {
        merge: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'merge', p, { timeout: 1300 })); },
        since: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'since', p, { timeout: 600 })); },
      },
      session: {
        merge: function* (ctx, p) {
          const st = ctx.state;
          while (st.busy) yield ctx.wait(5);
          st.busy = true;
          try {
            const base = Math.min(...p.ops.map((o) => o.baseRev), p.baseRev);
            const fresh = p.ops.filter((o) => st.byClient[o.clientId] == null);
            if (fresh.length && base < st.compactedUpTo) {
              if (st.config.handshake) ctx.fail('RESYNC_REQUIRED', `Base revision ${base} has been compacted; the log starts at ${st.compactedUpTo + 1}.`, { text: st.doc.text, rev: st.doc.rev, base });
              ctx.log({ op: `merging against a partial history (base ${base}, log starts at ${st.compactedUpTo + 1})`, status: 'err', detail: 'Revisions between the phone’s base and the start of the log are not applied to its operations. Positions will be wrong.' });
              st.stats.partialMerges = (st.stats.partialMerges || 0) + 1;
            }
            const committed = [];
            let transformedAgainst = 0, replayed = true;
            const before = st.doc.rev;
            // The batch is a sequence: each op was made on top of the previous one. Transform each against the
            // concurrent revisions, then move those revisions past the committed op before the next one.
            let conc = st.log.filter((r) => r.rev > base).map((r) => r.op);
            for (const o of p.ops) {
              const r = yield* commitOne(ctx, o, p.who, conc);
              committed.push(r.row);
              if (!r.replayed) { replayed = false; transformedAgainst = Math.max(transformedAgainst, r.transformedAgainst); conc = conc.map((c) => OT.transform(c, o.op, true)); }
            }
            const missed = st.log.filter((r) => r.rev > p.baseRev && r.rev <= before);
            return { rev: st.doc.rev, committed: committed.map((r) => ({ rev: r.rev, clientId: r.clientId, op: r.op })), missed, transformedAgainst, replayed, text: st.doc.text };
          } finally { st.busy = false; }
        },
        since(ctx, p) {
          const st = ctx.state;
          if (p.rev < st.compactedUpTo) return { ops: [], compacted: true };
          return { ops: st.log.filter((r) => r.rev > p.rev && (p.upto == null || r.rev <= p.upto)) };
        },
      },
      oplog: {
        append(ctx, row) { return { rev: row.rev }; },
        trim(ctx, p) { const st = ctx.state; const n = st.log.length; st.log = st.log.filter((r) => r.rev > p.upTo); st.compactedUpTo = p.upTo; st.stats.trimmed += n - st.log.length; return { deleted: n - st.log.length }; },
      },
      snap: { write(ctx, p) { ctx.state.snapshot = { text: p.text, rev: p.rev }; return { rev: p.rev }; } },
      local: {
        write(ctx, p) { ctx.state.local = { queue: p.queue, rev: p.rev }; return { ok: true }; },
        read(ctx) { return ctx.state.local; },
      },
      ana: { push: function* (ctx, row) { return { applied: yield* receive(ctx, 'ana', row) }; } },
      ben: { push: function* (ctx, row) { return { applied: yield* receive(ctx, 'ben', row) }; } },
    },
    consistency(sim) {
      const st = sim.state;
      const a = sim.ui.ana, b = sim.ui.ben;
      if (st.lost.length) return { key: 'wrong', label: `${st.lost.length} offline edit${st.lost.length > 1 ? 's were' : ' was'} lost when the app was killed: held in memory only, never persisted, never sent.` };
      if (st.stats.duplicated) return { key: 'wrong', label: `${st.stats.duplicated} operation${st.stats.duplicated > 1 ? 's were' : ' was'} committed twice: the resent merge carried no client ids.` };
      if (offline(sim)) return { key: 'stale', label: `Ana is offline with ${a.outstanding.length} queued edit${a.outstanding.length === 1 ? '' : 's'}${st.config.persist ? ', persisted on the phone' : ' in memory only'}. The document is at revision ${st.doc.rev}; her base is ${a.rev}${st.compactedUpTo > a.rev ? `, already compacted away: a resync will be needed` : ''}.` };
      if (a.outstanding.length || a.sending) return { key: 'stale', label: `Ana’s queue (${a.outstanding.length}) is being merged${a.status === 'unsaved' ? ' and the last attempt failed; it stays on the phone' : ''}.` };
      if (a.conflicts.length) return { key: 'stale', label: `${a.conflicts.length} of Ana’s offline edit${a.conflicts.length > 1 ? 's' : ''} could not be placed: the text around ${a.conflicts.length > 1 ? 'them' : 'it'} was deleted while she was away. ${a.conflicts.length > 1 ? 'They are' : 'It is'} shown to her to re-apply, not dropped.` };
      if (a.rev < st.doc.rev || b.rev < st.doc.rev) return { key: 'stale', label: `A phone is behind revision ${st.doc.rev}.` };
      if (a.text !== st.doc.text || b.text !== st.doc.text) return { key: 'wrong', label: `Ana’s screen and the document differ at revision ${st.doc.rev}: her queue was transformed against a partial history. Nobody has been told.` };
      return { key: 'ok', label: `Both phones match the document at revision ${st.doc.rev}; every offline edit was merged or set aside visibly.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      return [
        { label: 'Revision', value: st.doc.rev },
        { label: 'Log starts at revision', value: st.compactedUpTo + 1, hint: `${st.log.length} rows kept` },
        { label: 'Ana’s base revision', value: sim.ui.ana.rev, tone: sim.ui.ana.rev < st.compactedUpTo ? 'warn' : '' },
        { label: 'Queued on Ana’s phone', value: sim.ui.ana.outstanding.length },
        { label: 'Merged, re-anchored, set aside', value: `${st.stats.merged}, ${st.stats.reanchored}, ${st.stats.conflicts}` },
        { label: 'Full resyncs', value: st.stats.resyncs },
        { label: 'Compactions, rows trimmed', value: `${st.stats.compactions}, ${st.stats.trimmed}` },
        { label: 'Edits lost or duplicated', value: st.lost.length + st.stats.duplicated, tone: st.lost.length + st.stats.duplicated ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['ana', 'Ana'], ['ben', 'Ben']], {
          note: 'Ana’s phone has an airplane-mode switch and a “kill the app” button. Ben stays online. The console shows the operation log window and Ana’s base revision against it.',
          below: '<div class="ops-console"><p class="ops-title">Operation log window</p><div data-ref="log"></div></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const who of Object.keys(PEOPLE)) {
          const u = sim.ui[who];
          const off = who === 'ana' && offline(sim);
          const chip = off ? ['fail', `Offline · ${u.outstanding.length} queued`] : u.status === 'saved' ? ['ok', `Saved · rev ${u.rev}`] : u.status === 'unsaved' ? ['fail', 'Merge failed, retrying'] : ['work', 'Syncing…'];
          const sections = {
            head: `<div><p class="app-title">Q3 plan</p><p class="app-sub">${off ? 'Airplane mode' : 'Connected'}</p></div>`,
            doc: `<div class="app-card doc-page"><p class="doc-text">${esc(u.text)}<span class="doc-caret"></span></p><span class="app-sub doc-chip" data-tone="${chip[0]}">${chip[1]}</span></div>`,
            keys: `<div class="app-row">${Y.btn('type', `Type “${esc(WORDS[who][u.typed % WORDS[who].length].trim())}”`, { arg: { who }, cls: 'go' })}${who === 'ben' ? Y.btn('type', 'Delete after the colon', { arg: { who, kind: 'delAll' }, cls: 'secondary' }) : ''}</div>`,
          };
          if (who === 'ana') {
            sections.cursor = `<div class="app-row"><label class="app-sub" for="cur-ana">Cursor</label> <select id="cur-ana" data-field="ana.cursor">${[['end', 'End'], ['ship', 'After “ship”'], ['colon', 'After the colon']].map(([k, v]) => `<option value="${k}"${u.cursor === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div>`;
            sections.net = `<div class="app-row">${Y.btn('toggle', off ? 'Turn airplane mode off' : 'Turn airplane mode on', { cls: off ? 'go' : 'secondary' })}${Y.btn('restart', 'Kill and reopen the app', { cls: 'secondary' })}</div>`;
            sections.conflicts = u.conflicts.length ? `<div class="app-card is-hot"><strong>${u.conflicts.length} edit${u.conflicts.length > 1 ? 's' : ''} could not be placed</strong>${u.conflicts.map((c) => `<span class="app-sub">“${esc((c.text || '').trim())}”: ${esc(c.why)}</span>`).join('')}</div>` : '';
          }
          Y.paint(el, sim, who, sections, {}, null);
        }
        const c = sim.scenario.consistency(sim);
        const rows = [['Snapshot', `revision ${st.snapshot.rev}`, 'ok'], ['Log rows kept', `${st.compactedUpTo + 1} … ${st.doc.rev} (${st.log.length} rows, retention ${retain(st)})`, 'ok'], ['Ana’s base', `revision ${sim.ui.ana.rev}${sim.ui.ana.rev < st.compactedUpTo ? ' · compacted away' : ''}`, sim.ui.ana.rev < st.compactedUpTo ? 'fail' : 'ok']];
        SDL.ui.paintSections(el.querySelector('[data-ref="log"]'), {
          rows: `<div class="ops-shards">${rows.map(([k, v, t]) => `<div class="ops-row" data-tone="${t}"><div class="ops-name"><strong>${k}</strong><span>${esc(v)}</span></div></div>`).join('')}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
