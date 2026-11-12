/*
 * Operation log, snapshots, and version history.
 * Every revision is appended to the log. A snapshot worker folds the log into
 * a snapshot every few revisions so opening the document means one snapshot
 * read plus a short tail, not a replay of everything. Version history lists
 * snapshots and named versions. Restoring an old version appends a new
 * operation that turns the current text into the old one, so the history
 * stays intact and a concurrent edit survives. Compaction archives old
 * snapshots and must never delete one somebody named.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const OT = Y.ot;

  const DOC0 = 'Q3 plan: ship the editor.';
  const WORDS = [' Fix sync.', ' Add tests.', ' Ship it.', ' Cut scope.', ' Review Friday.', ' Done.', ' Hire two.', ' Budget: flat.'];
  const REPLAY_MS = 25; // cost of replaying one logged operation on open
  const snapEvery = (st) => (st.config.snapOften ? 4 : 12);

  /* ---------- actions ---------- */
  function startType(sim) {
    const st = sim.state;
    const word = WORDS[st.seq.word++ % WORDS.length];
    sim.startAction(`Ben: type “${word.trim()}”`, function* (ctx) {
      const u = ctx.ui.ben;
      const op = { pos: u.text.length, ins: word };
      u.text = OT.apply(u.text, op);
      u.pending = op;
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('gw', 'submit', { clientId: `ben-${++st.seq.client}`, baseRev: u.rev, op, who: 'ben' }, { timeout: 1500 });
      u.pending = null;
      if (r.ok) { u.rev = Math.max(u.rev, r.value.rev); if (r.value.op.pos !== op.pos) { /* transformed past a concurrent restore */ } Y.L(ctx, { accepted: 'yes', committed: 'yes', async: 'pending' }); ctx.explain(`Ben’s edit is revision ${r.value.rev}. ${st.doc.rev - st.snapshot.rev} revision${st.doc.rev - st.snapshot.rev === 1 ? '' : 's'} since the last snapshot.`); }
      else { u.text = OT.apply(u.text, { pos: op.pos, del: op.ins.length }); Y.L(ctx, { accepted: ['no', r.error.message], committed: 'no', async: 'n/a' }); ctx.explain(`Not saved: ${r.error.message}`); }
    }, { self: 'ben' });
  }
  function startOpen(sim) {
    sim.startAction('Ana: open the document', function* (ctx) {
      const u = ctx.ui.ana;
      Y.L(ctx, { retrySafe: 'yes', committed: 'n/a', async: 'n/a' });
      u.opening = true;
      const t0 = ctx.now();
      const r = yield ctx.call('gw', 'open', {}, { timeout: 4000 });
      u.opening = false;
      if (!r.ok) { u.openError = r.error.message; Y.failed(ctx, 'Could not open.'); ctx.explain(`Open failed: ${r.error.message}`); return; }
      u.text = r.value.text; u.rev = r.value.rev; u.openMs = ctx.now() - t0; u.openError = null; u.opened = { snapRev: r.value.snapRev, tail: r.value.tail, source: r.value.source };
      if (r.value.text !== ctx.state.doc.text) ctx.state.staleOpens++;
      Y.L(ctx, { displayed: 'yes', accepted: 'yes' });
      ctx.explain(r.value.source === 'log' ? `The snapshot store was unavailable, so the document was rebuilt by replaying all ${r.value.tail} logged operations: ${SDL.fmtMs(u.openMs)}.` : `Opened from snapshot revision ${r.value.snapRev} plus ${r.value.tail} logged operation${r.value.tail === 1 ? '' : 's'} in ${SDL.fmtMs(u.openMs)}. ${r.value.tail > 2 * snapEvery(ctx.state) ? 'The tail is long: snapshots are behind.' : 'Short tail, fast open.'}`);
    }, { self: 'ana' });
  }
  function startName(sim, name) {
    sim.startAction(`Ana: name the current version “${name}”`, function* (ctx) {
      Y.L(ctx, { retrySafe: 'yes', async: 'n/a' });
      const r = yield ctx.call('gw', 'name', { name, rev: ctx.state.doc.rev }, { timeout: 1500 });
      if (r.ok) { Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'yes' }); ctx.explain(`Revision ${r.value.rev} is now named “${name}”. A named version is a pointer in metadata plus a pinned snapshot: compaction must keep it.`); }
      else { Y.failed(ctx); ctx.explain(`Could not name the version: ${r.error.message}`); }
    }, { self: 'ana' });
  }
  function startHistory(sim) {
    sim.startAction('Ana: open version history', function* (ctx) {
      const u = ctx.ui.ana;
      Y.L(ctx, { retrySafe: 'yes', committed: 'n/a', async: 'n/a' });
      const r = yield ctx.call('gw', 'history', {}, { timeout: 2500 });
      if (!r.ok) { u.history = null; Y.failed(ctx); ctx.explain(`History unavailable: ${r.error.message}`); return; }
      u.history = r.value.versions; u.historyPartial = r.value.partial;
      Y.L(ctx, { displayed: 'yes', accepted: 'yes' });
      ctx.explain(r.value.partial ? `${r.value.versions.length} recent version${r.value.versions.length === 1 ? '' : 's'} listed. Older versions live in the cold archive, which is down, so they are missing from the list rather than shown as broken links.` : `${r.value.versions.length} version${r.value.versions.length === 1 ? '' : 's'}: every snapshot and every named version, newest first.`);
    }, { self: 'ana' });
  }
  function startRestore(sim, rev) {
    const st = sim.state;
    const baseRev = st.doc.rev; // what Ana was looking at when she clicked
    sim.startAction(`Ana: restore revision ${rev}`, function* (ctx) {
      const u = ctx.ui.ana;
      Y.L(ctx, { retrySafe: ['yes', 'Restoring the same version twice is harmless.'] });
      const r = yield ctx.call('gw', 'restore', { rev, who: 'ana', baseRev }, { timeout: 2500 });
      if (!r.ok) { Y.failed(ctx, 'Restore failed.'); ctx.explain(`Restore failed: ${r.error.message}${/gone|deleted|archive/i.test(r.error.message) ? ' A version someone named has been destroyed by compaction.' : ''}`); if (r.error.code === 'GONE') st.lostVersions++; return; }
      u.text = st.doc.text; u.rev = st.doc.rev; u.history = null;
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'yes', async: 'n/a' });
      ctx.explain(st.config.forward
        ? `Restore appended revision ${r.value.rev}: one operation that turns the current text into revision ${rev}. The log still has everything after ${rev}, so the restore itself can be undone${r.value.concurrent ? `, and Ben’s edit that landed at the same moment was transformed past it and kept` : ''}.`
        : `Restore rewrote the document to revision ${rev} and deleted every later row from the log. The head is now ${r.value.rev}${r.value.dropped ? `; ${r.value.dropped} committed revision${r.value.dropped > 1 ? 's were' : ' was'} destroyed, including work that was acknowledged to Ben` : ''}.`);
    }, { self: 'ana' });
  }

  SDL.scenarios['docs-history'] = {
    id: 'docs-history',
    seed: 505,
    productWidth: 640,
    intro: 'Let Ben type a few revisions, open the document on Ana’s phone, and watch the open cost. Then restore an old version while Ben is typing, with restore as a forward operation or as a rewrite.',
    modeLabels: { staleSnap: 'Snapshotting a stale head' },
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'ana', label: 'Ana’s phone', sub: 'Opens, browses history', kind: 'client', x: 90, y: 120, latency: 1, role: 'Opens the document, browses version history, names and restores versions.', owns: ['Local copy'] },
        { id: 'ben', label: 'Ben’s phone', sub: 'Typing', kind: 'client', x: 90, y: 440, latency: 1, role: 'Produces revisions.', ops: [{ name: 'push', desc: 'A remote operation.' }], owns: ['Local copy'] },
        { id: 'gw', label: 'API and sockets', sub: 'Gateway', kind: 'gateway', x: 320, y: 280, latency: 2, role: 'Routes edits to the session and history calls to the history service.', ops: [{ name: 'submit', desc: 'An operation.' }, { name: 'open', desc: 'Load the document.' }, { name: 'history', desc: 'List versions.' }, { name: 'restore', desc: 'Restore a version.' }, { name: 'name', desc: 'Name a version.' }], owns: ['Sockets'] },
        { id: 'session', label: 'Document session', sub: 'Sequencer', kind: 'service', x: 560, y: 180, latency: 4, role: 'Commits operations in order. A restore is just another operation here.', ops: [{ name: 'submit', desc: 'Commit.' }, { name: 'open', desc: 'Snapshot plus tail.' }, { name: 'restore', desc: 'Append the restoring operation, or rewrite.' }], owns: ['Head revision'] },
        { id: 'history', label: 'History service', sub: 'Versions', kind: 'service', x: 560, y: 420, latency: 4, role: 'Lists snapshots and named versions from hot and cold storage; reads the text of any version.', ops: [{ name: 'list', desc: 'Versions.' }, { name: 'read', desc: 'Text at a revision.' }, { name: 'name', desc: 'Pin a version.' }], owns: ['Nothing durable'] },
        { id: 'oplog', label: 'Operation log', sub: 'Append-only', kind: 'db', x: 800, y: 80, latency: 8, role: 'One row per revision. Replaying rows costs time: this is why snapshots exist.', ops: [{ name: 'append', desc: 'Write.' }, { name: 'read', desc: 'Rows after a revision.' }, { name: 'truncate', desc: 'Delete rows (rewrite restore).' }], owns: ['log[rev]'] },
        { id: 'snapper', label: 'Snapshot worker', sub: 'Every N revisions', kind: 'worker', x: 1040, y: 180, latency: 5, role: 'Folds the log into a new snapshot every N revisions.', owns: ['Nothing durable'] },
        { id: 'snap', label: 'Snapshot store', sub: 'Hot, recent', kind: 'store', x: 800, y: 280, latency: 6, role: 'Recent snapshots. Opening reads the newest.', ops: [{ name: 'write', desc: 'Store.' }, { name: 'latest', desc: 'Newest snapshot.' }, { name: 'read', desc: 'Snapshot at a revision.' }], owns: ['snapshots[rev]'] },
        { id: 'archive', label: 'Cold archive', sub: 'Old snapshots', kind: 'store', x: 1040, y: 420, latency: 60, role: 'Where compaction moves old snapshots. Slow and cheap. Named versions are pinned here for ever.', ops: [{ name: 'put', desc: 'Archive a snapshot.' }, { name: 'get', desc: 'Read an old snapshot.' }, { name: 'list', desc: 'Archived versions.' }], owns: ['archived snapshots', 'pinned versions'] },
        { id: 'meta', label: 'Metadata', sub: 'Named versions', kind: 'db', x: 800, y: 480, latency: 6, role: 'Document metadata and the list of named versions (name → revision).', ops: [{ name: 'name', desc: 'Record a name.' }, { name: 'names', desc: 'List names.' }], owns: ['names[doc]'] },
        { id: 'pubsub', label: 'Pub/sub', sub: 'Channel and commits', kind: 'queue', x: 320, y: 480, latency: 3, role: 'Broadcasts operations and feeds the snapshot worker.', owns: ['Channels'] },
      ],
      edges: [
        { from: 'ana', to: 'gw', latency: 30 }, { from: 'ben', to: 'gw', latency: 30, label: 'WebSocket' },
        { from: 'gw', to: 'session', latency: 3 }, { from: 'gw', to: 'history', latency: 3 },
        { from: 'session', to: 'oplog', latency: 4 }, { from: 'session', to: 'snap', latency: 4 }, { from: 'session', to: 'pubsub', latency: 3, via: [[440, 230], [440, 480]] },
        { from: 'history', to: 'snap', latency: 4 }, { from: 'history', to: 'archive', latency: 6 }, { from: 'history', to: 'meta', latency: 4 },
        { from: 'pubsub', to: 'snapper', latency: 3, via: [[1040, 540]] }, { from: 'pubsub', to: 'gw', latency: 3 },
        { from: 'snapper', to: 'oplog', latency: 4 }, { from: 'snapper', to: 'snap', latency: 4 }, { from: 'snapper', to: 'archive', latency: 6 },
      ],
      queues: [{ id: 'bcast', broker: 'pubsub', label: 'Document channel', groups: ['gw'] }, { id: 'commits', broker: 'pubsub', label: 'Commits', groups: ['snapper'] }],
    },
    failures: [
      { id: 'snapper-down', node: 'snapper', mode: 'down', label: 'Snapshot worker down', desc: 'The tail grows; every open replays more.' },
      { id: 'snap-down', node: 'snap', mode: 'down', label: 'Snapshot store down', desc: 'Opens fall back to replaying the whole log.' },
      { id: 'log-slow', node: 'oplog', mode: 'slow', params: { factor: 20 }, label: 'Operation log slow', desc: 'Commits and replays take longer.' },
      { id: 'archive-down', node: 'archive', mode: 'down', label: 'Cold archive down', desc: 'Old versions cannot be listed or restored.' },
      { id: 'history-hang', node: 'history', mode: 'hang', label: 'History service hangs', desc: 'Version history never loads; editing is unaffected.' },
      { id: 'stale-snap', node: 'snapper', mode: 'staleSnap', label: 'Snapshot taken from a stale head', desc: 'A bug: the worker labels a snapshot with the head revision but folds one revision too few.' },
    ],
    switches: Y.switches([
      ['snapOften', 'Snapshot every 4 revisions', 'Short tails, fast opens, more snapshot writes. Off: every 12.'],
      ['forward', 'Restore as a forward operation', 'Restoring appends an operation that recreates the old text; nothing is deleted. Off: rewrite the text and truncate the log.'],
      ['pin', 'Compaction keeps named versions', 'Named versions are pinned in the archive. Off: compaction treats them like any old snapshot.'],
      ['verifySnap', 'Verify snapshots against the log', 'The session checks that a snapshot’s text matches the log at its revision before serving it. Off: trust the label.'],
    ]),
    presets: Y.presets({ snapOften: true, forward: true, pin: true, verifySnap: false }, [
      { id: 'open-fresh', label: 'Open with a fresh snapshot', desc: 'Ben types four revisions, the worker snapshots, Ana opens: one snapshot read, no tail.', run: (s) => { for (let i = 0; i < 4; i++) s.schedule(i * 300, () => startType(s)); s.schedule(2200, () => startOpen(s)); } },
      { id: 'open-tail', label: 'Snapshot worker down, long tail', desc: 'Eight revisions and no snapshot. Opening replays all eight: still correct, but the open cost grows with every keystroke until the worker returns.', run: (s) => { s.inject('snapper', 'down'); for (let i = 0; i < 8; i++) s.schedule(i * 250, () => startType(s)); s.schedule(2600, () => startOpen(s)); } },
      { id: 'open-nosnap', label: 'Snapshot store down', desc: 'The latest snapshot cannot be read, so the session rebuilds from the log alone. Slow, but nothing is lost because the log is complete.', run: (s) => { for (let i = 0; i < 6; i++) s.schedule(i * 250, () => startType(s)); s.schedule(2000, () => s.inject('snap', 'down')); s.schedule(2200, () => startOpen(s)); } },
      { id: 'restore-forward', label: 'Restore while Ben types, forward', desc: 'Ana restores revision 2 at the moment Ben commits revision 5. The restore is one more operation; Ben’s edit is transformed past it and survives, and the log keeps everything.', run: (s) => { for (let i = 0; i < 4; i++) s.schedule(i * 250, () => startType(s)); s.schedule(1500, () => startRestore(s, 2)); s.schedule(1510, () => startType(s)); } },
      { id: 'restore-rewrite', label: 'Restore while Ben types, rewrite', desc: 'Same moment, but restore rewrites the text and truncates the log. Ben’s acknowledged edit and the audit trail after revision 2 are destroyed.', sw: { forward: false }, run: (s) => { for (let i = 0; i < 4; i++) s.schedule(i * 250, () => startType(s)); s.schedule(1500, () => startRestore(s, 2)); s.schedule(1510, () => startType(s)); } },
      { id: 'named-kept', label: 'Name a version, compact, restore it', desc: 'Ana names revision 2 “Draft”. Many revisions later compaction archives old snapshots; the named one is pinned, so the restore works.', run: (s) => { for (let i = 0; i < 2; i++) s.schedule(i * 250, () => startType(s)); s.schedule(800, () => startName(s, 'Draft')); for (let i = 0; i < 8; i++) s.schedule(1200 + i * 250, () => startType(s)); s.schedule(4500, () => startRestore(s, 2)); } },
      { id: 'named-lost', label: 'Name a version, compaction deletes it', desc: 'Without pinning, compaction deletes the snapshot behind “Draft”. The name still exists; the text does not. Restore fails: data someone asked to keep is gone.', sw: { pin: false }, run: (s) => { for (let i = 0; i < 2; i++) s.schedule(i * 250, () => startType(s)); s.schedule(800, () => startName(s, 'Draft')); for (let i = 0; i < 8; i++) s.schedule(1200 + i * 250, () => startType(s)); s.schedule(4500, () => startRestore(s, 2)); } },
      { id: 'stale-snap', label: 'Snapshot from a stale head', desc: 'A buggy worker writes a snapshot labelled with the head revision but missing the last edit. Ana opens and sees old text at the newest revision number.', run: (s) => { s.inject('snapper', 'staleSnap'); for (let i = 0; i < 4; i++) s.schedule(i * 300, () => startType(s)); s.schedule(2200, () => startOpen(s)); } },
      { id: 'stale-snap-verified', label: 'Stale snapshot caught by verification', desc: 'Same bug, but the session replays the log from the previous snapshot to check the new one, finds the mismatch, and serves the log instead.', sw: { verifySnap: true }, run: (s) => { s.inject('snapper', 'staleSnap'); for (let i = 0; i < 4; i++) s.schedule(i * 300, () => startType(s)); s.schedule(2200, () => startOpen(s)); } },
      { id: 'archive-down', label: 'Cold archive down', desc: 'Version history lists only what is in hot storage and says so. Editing and opening are unaffected.', run: (s) => { for (let i = 0; i < 2; i++) s.schedule(i * 250, () => startType(s)); s.schedule(800, () => startName(s, 'Draft')); for (let i = 0; i < 8; i++) s.schedule(1200 + i * 250, () => startType(s)); s.schedule(4300, () => s.inject('archive', 'down')); s.schedule(4500, () => startHistory(s)); } },
    ]),
    initialState: () => ({
      config: { snapOften: true, forward: true, pin: true, verifySnap: false },
      doc: { text: DOC0, rev: 0 }, log: [{ rev: 0, op: null, text: DOC0 }], byClient: {}, busy: false,
      snapshot: { text: DOC0, rev: 0 }, snapshots: { 0: { text: DOC0, rev: 0 } }, archive: {}, names: {}, lost: [], staleOpens: 0, lostVersions: 0,
      seq: { client: 0, word: 0 }, stats: { ops: 0, snapshots: 0, archived: 0, deleted: 0, replayed: 0, restores: 0, verified: 0 },
    }),
    initialUI: () => ({ ana: { text: DOC0, rev: 0, openMs: null, opened: null, opening: false, openError: null, history: null, historyPartial: false }, ben: { text: DOC0, rev: 0, pending: null } }),
    actions: {
      type(sim) { startType(sim); },
      open(sim) { startOpen(sim); },
      history(sim) { startHistory(sim); },
      name(sim, a) { startName(sim, a.name || 'Draft'); },
      restoreVersion(sim, a) { startRestore(sim, a.rev); },
    },
    setup(sim) {
      Y.consumer(sim, 'bcast', 'gw', 'gw', function* (ctx, msg) { const row = msg.payload; if (row.who !== 'ben') { const u = ctx.ui.ben; if (row.rev > u.rev) { let op = row.op; if (u.pending) { const mine = u.pending; u.pending = OT.transform(mine, op, false); op = OT.transform(op, mine, true); } u.text = OT.apply(u.text, op); u.rev = row.rev; } } if (ctx.ui.ana.rev && row.rev > ctx.ui.ana.rev) { ctx.ui.ana.text = OT.apply(ctx.ui.ana.text, row.op); ctx.ui.ana.rev = row.rev; } return true; }, () => false);
      Y.consumer(sim, 'commits', 'snapper', 'snapper', function* (ctx, msg) {
        const st = ctx.state;
        const rev = msg.payload.rev;
        if (rev % snapEvery(st) !== 0 || rev <= st.snapshot.rev) return true;
        const r = yield ctx.call('oplog', 'read', { after: st.snapshot.rev, upto: rev }, { timeout: 2000 });
        if (!r.ok) return false;
        let rows = r.value.ops;
        if (ctx.mode('staleSnap')) rows = rows.slice(0, -1);
        let text = st.snapshot.text;
        for (const row of rows) text = OT.apply(text, row.op);
        const w = yield ctx.call('snap', 'write', { text, rev }, { timeout: 900 });
        if (!w.ok) return false;
        st.stats.snapshots++;
        ctx.log({ op: `snapshot at revision ${rev}${ctx.mode('staleSnap') ? ' (missing the last operation)' : ''}`, status: ctx.mode('staleSnap') ? 'err' : 'ok', detail: `${rows.length} operation${rows.length === 1 ? '' : 's'} folded.` });
        // Compaction: keep the two newest snapshots hot, archive the rest, pin named ones.
        const revs = Object.keys(st.snapshots).map(Number).sort((a, b) => a - b);
        for (const old of revs.slice(0, Math.max(0, revs.length - 2))) {
          const named = Object.values(st.names).includes(old);
          if (named && st.config.pin) { const a = yield ctx.call('archive', 'put', { rev: old, text: st.snapshots[old].text, pinned: true }, { timeout: 900, quiet: true }); if (!a.ok) continue; st.stats.archived++; }
          else if (old === 0 || old % (snapEvery(st) * 2) === 0) { const a = yield ctx.call('archive', 'put', { rev: old, text: st.snapshots[old].text }, { timeout: 900, quiet: true }); if (!a.ok) continue; st.stats.archived++; }
          else { st.stats.deleted++; if (named) { st.lost.push(old); ctx.log({ op: `compaction deleted snapshot ${old}, which is named “${Object.keys(st.names).find((n) => st.names[n] === old)}”`, status: 'err', detail: 'The name still points at it. Restoring it will fail.' }); } }
          delete st.snapshots[old];
        }
        return true;
      }, () => false);
    },
    handlers: {
      gw: {
        submit: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'submit', p, { timeout: 1300 })); },
        open: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'open', p, { timeout: 3800 })); },
        restore: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'restore', p, { timeout: 2300 })); },
        history: function* (ctx, p) { return ctx.must(yield ctx.call('history', 'list', p, { timeout: 2300 })); },
        name: function* (ctx, p) { return ctx.must(yield ctx.call('history', 'name', p, { timeout: 1300 })); },
      },
      session: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          while (st.busy) yield ctx.wait(5);
          st.busy = true;
          try { return yield* commit(ctx, p.op, p.who, p.baseRev, p.clientId); } finally { st.busy = false; }
        },
        open: function* (ctx) {
          const st = ctx.state;
          const s = yield ctx.call('snap', 'latest', {}, { timeout: 800 });
          let base = s.ok ? s.value : { text: DOC0, rev: 0 };
          let source = s.ok ? 'snapshot' : 'log';
          if (s.ok && st.config.verifySnap && base.rev > 0) {
            const prev = Object.keys(st.snapshots).map(Number).filter((r) => r < base.rev).sort((a, b) => b - a)[0];
            const from = prev != null ? st.snapshots[prev] : { text: DOC0, rev: 0 };
            const chk = ctx.must(yield ctx.call('oplog', 'read', { after: from.rev, upto: base.rev }, { timeout: 3000 }));
            let t = from.text;
            for (const row of chk.ops) t = OT.apply(t, row.op);
            st.stats.verified++;
            if (t !== base.text) { ctx.log({ op: `snapshot ${base.rev} failed verification`, status: 'err', detail: 'Its text does not match the log replayed to the same revision. Serving the replay instead and flagging the snapshot.' }); base = { text: t, rev: base.rev }; source = 'verified log'; st.badSnapshots = (st.badSnapshots || 0) + 1; }
          }
          const tail = ctx.must(yield ctx.call('oplog', 'read', { after: base.rev }, { timeout: 3500 }));
          let text = base.text;
          for (const row of tail.ops) text = OT.apply(text, row.op);
          return { text, rev: tail.rev, snapRev: base.rev, tail: tail.ops.length, source };
        },
        restore: function* (ctx, p) {
          const st = ctx.state;
          const v = ctx.must(yield ctx.call('history', 'read', { rev: p.rev }, { timeout: 1800 }));
          while (st.busy) yield ctx.wait(5);
          st.busy = true;
          try {
            st.stats.restores++;
            if (st.config.forward) {
              const baseText = st.log.filter((r) => r.rev <= p.baseRev).reduce((t, r) => (r.op ? OT.apply(t, r.op) : t), DOC0);
              const op = { pos: 0, del: baseText.length, ins: v.text, restore: p.rev };
              const concurrent = st.doc.rev - p.baseRev;
              const r = yield* commit(ctx, op, p.who, p.baseRev, `restore-${++st.seq.client}`);
              return { rev: r.rev, concurrent };
            }
            const dropped = st.log.filter((r) => r.rev > p.rev);
            ctx.must(yield ctx.call('oplog', 'truncate', { after: p.rev }, { timeout: 900 }));
            st.doc = { text: v.text, rev: p.rev };
            for (const r of dropped) st.lost.push(r.rev);
            ctx.log({ op: `log truncated after revision ${p.rev}`, status: 'err', detail: `${dropped.length} committed revision${dropped.length === 1 ? '' : 's'} deleted. Phones that applied them are now ahead of the server.` });
            ctx.sim.enqueue('bcast', { type: `rewrite to ${p.rev}`, eventId: `rw${p.rev}-${ctx.now()}`, payload: { rev: p.rev, who: 'ana', op: { pos: 0, del: 10000, ins: v.text }, rewrite: true } });
            return { rev: p.rev, dropped: dropped.length };
          } finally { st.busy = false; }
        },
      },
      history: {
        list: function* (ctx) {
          const st = ctx.state;
          const names = ctx.must(yield ctx.call('meta', 'names', {}, { timeout: 600 }));
          const hot = Object.values(st.snapshots).map((s) => ({ rev: s.rev, where: 'hot' }));
          const a = yield ctx.call('archive', 'list', {}, { timeout: 1200 });
          const cold = a.ok ? a.value.revs.map((rev) => ({ rev, where: 'archive' })) : [];
          const byRev = {};
          for (const v of hot.concat(cold)) byRev[v.rev] = v;
          for (const [name, rev] of Object.entries(names.names)) { byRev[rev] = Object.assign(byRev[rev] || { rev, where: 'missing' }, { name }); }
          const versions = Object.values(byRev).sort((x, y) => y.rev - x.rev);
          return { versions, partial: !a.ok };
        },
        read: function* (ctx, p) {
          const st = ctx.state;
          if (st.snapshots[p.rev]) return { text: st.snapshots[p.rev].text };
          const a = yield ctx.call('archive', 'get', { rev: p.rev }, { timeout: 1200 });
          if (a.ok && a.value.found) return { text: a.value.text };
          if (!a.ok) ctx.fail('UNAVAILABLE', 'The cold archive is down; old versions cannot be read right now.');
          // Rebuild from the nearest earlier snapshot and the log, if the log still has those rows.
          const earlier = Object.keys(st.snapshots).map(Number).filter((r) => r <= p.rev).sort((x, y) => y - x)[0];
          if (earlier == null) ctx.fail('GONE', `Revision ${p.rev} is gone: its snapshot was deleted by compaction and nothing earlier remains to rebuild it from.`);
          const rows = ctx.must(yield ctx.call('oplog', 'read', { after: earlier, upto: p.rev }, { timeout: 2000 }));
          let t = st.snapshots[earlier].text;
          for (const r of rows.ops) t = OT.apply(t, r.op);
          return { text: t };
        },
        name: function* (ctx, p) {
          const st = ctx.state;
          ctx.must(yield ctx.call('meta', 'name', p, { timeout: 600 }));
          if (!st.snapshots[p.rev]) { // pin: make sure a snapshot of exactly this revision exists
            const rows = ctx.must(yield ctx.call('oplog', 'read', { after: st.snapshot.rev <= p.rev ? st.snapshot.rev : 0, upto: p.rev }, { timeout: 2000 }));
            let t = st.snapshot.rev <= p.rev ? st.snapshot.text : DOC0;
            for (const r of rows.ops) t = OT.apply(t, r.op);
            st.snapshots[p.rev] = { text: t, rev: p.rev };
          }
          return { rev: p.rev };
        },
      },
      oplog: {
        append(ctx, row) { return { rev: row.rev }; },
        read: function* (ctx, p) { const st = ctx.state; const ops = st.log.filter((r) => r.rev > p.after && r.op && (p.upto == null || r.rev <= p.upto)); yield ctx.wait(REPLAY_MS * ops.length); st.stats.replayed += ops.length; return { ops, rev: ops.length ? ops[ops.length - 1].rev : p.after }; },
        truncate(ctx, p) { const st = ctx.state; const n = st.log.length; st.log = st.log.filter((r) => r.rev <= p.after); for (const k of Object.keys(st.snapshots)) if (Number(k) > p.after) delete st.snapshots[k]; if (st.snapshot.rev > p.after) st.snapshot = st.snapshots[Math.max(...Object.keys(st.snapshots).map(Number))]; return { deleted: n - st.log.length }; },
      },
      snap: {
        write(ctx, p) { const st = ctx.state; st.snapshots[p.rev] = { text: p.text, rev: p.rev }; if (p.rev > st.snapshot.rev) st.snapshot = st.snapshots[p.rev]; return { rev: p.rev }; },
        latest(ctx) { return ctx.state.snapshot; },
        read(ctx, p) { return ctx.state.snapshots[p.rev] || { found: false }; },
      },
      archive: {
        put(ctx, p) { ctx.state.archive[p.rev] = { text: p.text, pinned: !!p.pinned }; return { ok: true }; },
        get(ctx, p) { const a = ctx.state.archive[p.rev]; return a ? { found: true, text: a.text } : { found: false }; },
        list(ctx) { return { revs: Object.keys(ctx.state.archive).map(Number) }; },
      },
      meta: {
        name(ctx, p) { ctx.state.names[p.name] = p.rev; return { ok: true }; },
        names(ctx) { return { names: ctx.state.names }; },
      },
      ben: { push() { return { ok: true }; } },
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.ana;
      if (st.lost.length) return { key: 'wrong', label: st.config.forward ? `Snapshot ${st.lost.join(', ')} behind a named version was deleted by compaction. The name points at nothing: a version someone asked to keep is gone.` : `Restore by rewrite deleted ${st.lost.length} committed revision${st.lost.length > 1 ? 's' : ''} (${st.lost.join(', ')}) from the log, including an edit Ben was told was saved. The audit trail after the restore point is gone.` };
      if (st.lostVersions) return { key: 'wrong', label: 'A named version could not be restored: its text was deleted by compaction.' };
      if (st.staleOpens) return { key: 'wrong', label: `Ana opened the document and saw revision ${u.rev} with text that does not match revision ${u.rev}: the snapshot was labelled with a head it did not contain.` };
      const tail = st.doc.rev - st.snapshot.rev;
      if (u.opening) return { key: 'stale', label: 'The document is opening.' };
      if (sim.nodes.snapper.modes.down && tail > snapEvery(st)) return { key: 'stale', label: `${tail} revisions since the last snapshot and the worker is down: every open replays all of them. Correct, but slower with each keystroke.` };
      if (u.historyPartial) return { key: 'stale', label: 'Version history is incomplete: the cold archive is down, so older versions are missing from the list, and the list says so.' };
      if (u.openError) return { key: 'stale', label: `The last open failed: ${u.openError}` };
      return { key: 'ok', label: `Revision ${st.doc.rev}, snapshot at ${st.snapshot.rev}, ${tail} operation${tail === 1 ? '' : 's'} of tail. Every revision is in the log and every named version is readable.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const tail = st.doc.rev - st.snapshot.rev;
      return [
        { label: 'Revision', value: st.doc.rev },
        { label: 'Operations since snapshot', value: tail, tone: tail > 2 * snapEvery(st) ? 'warn' : '' },
        { label: 'Last open', value: sim.ui.ana.openMs == null ? 'n/a' : SDL.fmtMs(sim.ui.ana.openMs), tone: sim.ui.ana.openMs > 300 ? 'warn' : '' },
        { label: 'Snapshots hot, archived, deleted', value: `${Object.keys(st.snapshots).length}, ${st.stats.archived}, ${st.stats.deleted}` },
        { label: 'Operations replayed on reads', value: st.stats.replayed },
        { label: 'Restores', value: st.stats.restores },
        { label: 'Named versions', value: Object.keys(st.names).length },
        { label: 'Revisions or versions lost', value: st.lost.length + st.lostVersions, tone: st.lost.length + st.lostVersions ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['ana', 'Ana'], ['ben', 'Ben']], {
          note: 'Ben types revisions. Ana opens the document, names the current version, browses history, and restores. The console shows what is in the log, the hot snapshots, and the archive.',
          below: '<div class="ops-console"><p class="ops-title">Storage</p><div data-ref="store"></div></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const a = sim.ui.ana;
        const hist = a.history ? `<div class="app-card"><strong>Version history</strong>${a.history.map((v) => `<div class="app-row"><span class="app-sub">rev ${v.rev}${v.name ? ` · “${esc(v.name)}”` : ''} · ${v.where}</span>${v.where === 'missing' ? '<span class="app-sub">✕ text gone</span>' : Y.btn('restoreVersion', 'Restore', { arg: { rev: v.rev }, cls: 'secondary' })}</div>`).join('')}${a.historyPartial ? '<span class="app-sub">Older versions unavailable: archive down.</span>' : ''}</div>` : '';
        Y.paint(el, sim, 'ana', {
          head: `<div><p class="app-title">Q3 plan</p><p class="app-sub">${a.opening ? 'Opening…' : a.openMs != null ? `Opened in ${SDL.fmtMs(a.openMs)} from ${a.opened.source} (snapshot ${a.opened.snapRev} + ${a.opened.tail})` : 'Not opened yet'}</p></div>`,
          doc: `<div class="app-card doc-page"><p class="doc-text">${esc(a.text)}</p><span class="app-sub doc-chip" data-tone="ok">rev ${a.rev}</span></div>`,
          keys: `<div class="app-row">${Y.btn('open', 'Open the document', { cls: 'go' })}${Y.btn('history', 'Version history', { cls: 'secondary' })}</div><div class="app-row">${Y.btn('name', 'Name this version “Draft”', { arg: { name: 'Draft' }, cls: 'secondary' })}</div>`,
          hist,
        }, {}, null);
        const b = sim.ui.ben;
        Y.paint(el, sim, 'ben', {
          head: `<div><p class="app-title">Q3 plan</p><p class="app-sub">Editing</p></div>`,
          doc: `<div class="app-card doc-page"><p class="doc-text">${esc(b.text)}<span class="doc-caret"></span></p><span class="app-sub doc-chip" data-tone="${b.pending ? 'work' : 'ok'}">${b.pending ? 'Saving…' : `Saved · rev ${b.rev}`}</span></div>`,
          keys: `<div class="app-row">${Y.btn('type', `Type “${esc(WORDS[st.seq.word % WORDS.length].trim())}”`, { cls: 'go' })}</div>`,
        }, {}, null);
        const c = sim.scenario.consistency(sim);
        const rows = [
          ['Operation log', `revisions ${st.log.length ? st.log[0].rev : 0} … ${st.doc.rev} (${st.log.filter((r) => r.op).length} rows)`, 'ok'],
          ['Hot snapshots', Object.keys(st.snapshots).map((r) => `rev ${r}`).join(', ') || 'none', 'ok'],
          ['Cold archive', Object.entries(st.archive).map(([r, v]) => `rev ${r}${v.pinned ? ' (pinned)' : ''}`).join(', ') || 'empty', sim.nodes.archive.modes.down ? 'fail' : 'ok'],
          ['Named versions', Object.entries(st.names).map(([n, r]) => `“${n}” → rev ${r}${st.snapshots[r] || st.archive[r] ? '' : ' · text gone'}`).join(', ') || 'none', st.lost.length ? 'fail' : 'ok'],
        ];
        SDL.ui.paintSections(el.querySelector('[data-ref="store"]'), {
          rows: `<div class="ops-shards">${rows.map(([k, v, t]) => `<div class="ops-row" data-tone="${t}"><div class="ops-name"><strong>${k}</strong><span>${esc(v)}</span></div></div>`).join('')}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };

  function* commit(ctx, op0, who, baseRev, clientId) {
    const st = ctx.state;
    if (st.byClient[clientId] != null) { const row = st.log.find((r) => r.rev === st.byClient[clientId]); return { rev: row.rev, op: row.op, replayed: true }; }
    let op = op0;
    for (const r of st.log.filter((x) => x.rev > baseRev && x.op)) op = OT.transform(op, r.op, false);
    const rev = st.doc.rev + 1;
    const row = { rev, op, who, clientId };
    ctx.must(yield ctx.call('oplog', 'append', row, { timeout: 1200 }));
    st.doc.rev = rev; st.doc.text = OT.apply(st.doc.text, op); st.log.push(row); st.byClient[clientId] = rev; st.stats.ops++;
    ctx.sim.enqueue('bcast', { type: `rev ${rev}`, eventId: `r${rev}`, payload: row });
    ctx.sim.enqueue('commits', { type: 'commit', eventId: `c${rev}`, payload: { rev }, quiet: true });
    return { rev, op };
  }
})(typeof window !== 'undefined' ? window : globalThis);
