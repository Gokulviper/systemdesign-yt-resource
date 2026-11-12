/*
 * Concurrency and operational transformation.
 * Two phones edit one sentence. Under OT each operation carries the revision it
 * was based on; the session transforms it against everything committed since,
 * and the phone transforms incoming operations against anything it has not had
 * acknowledged. The console lets you swap the strategy: save the whole text and
 * let the last writer win, lock the paragraph, or use CRDT-style ids with
 * tombstones. A switch turns off the one-batch-in-flight rule, and a failure
 * injects a bug into the transform function, to show why both matter.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const OT = Y.ot;

  const PEOPLE = { ana: 'Ana', ben: 'Ben' };
  const OTHER = { ana: 'ben', ben: 'ana' };
  const DOC0 = 'Q3 plan: ship the editor.';
  const ATOMS0 = ['Q3 ', 'plan: ', 'ship ', 'the ', 'editor.'];
  const WORDS = { ana: [' Hire two.', ' Launch in May.', ' Budget: flat.'], ben: [' Fix sync.', ' Add tests.', ' Ship it.'] };
  const STRATEGIES = { ot: 'Operational transformation', lww: 'Save whole text, last writer wins', lock: 'Paragraph lock', crdt: 'CRDT-style ids and tombstones' };
  const LOCK_MS = 1500;
  const online = (sim, who) => !sim.nodes[who].modes.down;
  const isCrdt = (st) => st.strategy === 'crdt';

  /* ---------- text helpers ---------- */
  const visible = (atoms) => atoms.filter((a) => !a.del).map((a) => a.text).join('');
  const atomKey = (id) => { const [n, w] = id.split(':'); return [Number(n), w]; };
  const atomGt = (a, b) => { const x = atomKey(a), y = atomKey(b); return x[0] !== y[0] ? x[0] > y[0] : x[1] > y[1]; };
  function applyAtoms(atoms, op) {
    const out = atoms.slice();
    if (op.del) { const a = out.find((x) => x.id === op.del); if (a) out[out.indexOf(a)] = Object.assign({}, a, { del: true }); return out; }
    if (out.some((x) => x.id === op.id)) return out;
    let i = op.after == null ? 0 : out.findIndex((x) => x.id === op.after) + 1;
    while (i < out.length && atomGt(out[i].id, op.id)) i++; // concurrent inserts after the same atom: higher id first, on every replica
    out.splice(i, 0, { id: op.id, text: op.text, del: false });
    return out;
  }
  function cursorPos(u) {
    const t = u.text;
    return u.cursor === 'start' ? 0 : u.cursor === 'colon' ? t.indexOf(':') + 1 : u.cursor === 'ship' ? t.indexOf('ship') + 4 : t.length;
  }
  function cursorAtom(u) {
    const vis = u.atoms.filter((a) => !a.del);
    if (u.cursor === 'start' || !vis.length) return null;
    if (u.cursor === 'colon') { const a = vis.find((x) => x.text.includes(':')); return a ? a.id : vis[vis.length - 1].id; }
    if (u.cursor === 'ship') { const a = vis.find((x) => x.text.startsWith('ship')); return a ? a.id : vis[vis.length - 1].id; }
    return vis[vis.length - 1].id;
  }
  const textOf = (st, u) => (isCrdt(st) ? visible(u.atoms) : u.text);
  const docText = (st) => (isCrdt(st) ? visible(st.doc.atoms) : st.doc.text);

  /* ---------- client side ---------- */
  function makeOps(sim, who, kind) {
    const st = sim.state;
    const u = sim.ui[who];
    if (isCrdt(st)) {
      if (kind === 'ins') { const word = WORDS[who][u.typed++ % WORDS[who].length]; return [{ after: cursorAtom(u), id: `${++st.seq.lamport}:${who}`, text: word }]; }
      const vis = u.atoms.filter((a) => !a.del);
      if (!vis.length) return [];
      const at = cursorAtom(u);
      const idx = at == null ? -1 : vis.findIndex((a) => a.id === at);
      if (kind === 'delAll') { const from = vis.findIndex((a) => a.text.includes(':')); return vis.slice(from + 1).map((a) => ({ del: a.id })); }
      return idx < 0 ? [] : [{ del: vis[idx].id }];
    }
    if (kind === 'ins') {
      const word = WORDS[who][u.typed++ % WORDS[who].length];
      const pos = cursorPos(u);
      return st.strategy === 'lww' ? [{ text: u.text.slice(0, pos) + word + u.text.slice(pos), word }] : [{ pos, ins: word }];
    }
    if (kind === 'delAll') { const from = u.text.indexOf(':') + 1; return st.strategy === 'lww' ? [{ text: u.text.slice(0, from), word: u.text.slice(from) }] : [{ pos: from, del: u.text.length - from, removed: u.text.slice(from) }]; }
    const pos = cursorPos(u);
    const m = u.text.slice(0, pos).match(/\s*\S+\s*$/);
    if (!m) return [];
    return st.strategy === 'lww' ? [{ text: u.text.slice(0, pos - m[0].length) + u.text.slice(pos), word: m[0] }] : [{ pos: pos - m[0].length, del: m[0].length, removed: m[0] }];
  }
  function applyLocal(st, u, op) {
    if (isCrdt(st)) u.atoms = applyAtoms(u.atoms, op);
    else if (st.strategy === 'lww') u.text = op.text;
    else u.text = OT.apply(u.text, op);
  }

  function startType(sim, who, kind) {
    const st = sim.state;
    const u = sim.ui[who];
    const ops = makeOps(sim, who, kind);
    if (!ops.length) return;
    const what = kind === 'ins' ? `type “${(ops[0].text || ops[0].ins || ops[0].word || '').trim()}”` : kind === 'delAll' ? 'delete everything after the colon' : 'delete a word';
    sim.startAction(`${PEOPLE[who]}: ${what}`, function* (ctx) {
      for (const op of ops) {
        const entry = { clientId: `${who}-${++st.seq.client}`, op, who, state: 'queued' };
        if (st.config.optimistic) { applyLocal(st, u, op); entry.applied = true; }
        u.outstanding.push(entry);
      }
      Y.L(ctx, { displayed: st.config.optimistic ? ['yes', 'Optimistic: applied locally first.'] : 'pending', retrySafe: ['yes', 'Client operation ids.'] });
      u.status = 'saving';
      const res = yield* flush(ctx, who);
      if (res.ok) {
        Y.L(ctx, { accepted: ['yes', `Revision ${res.rev}.`], committed: 'yes', displayed: 'yes', async: ['pending', `Broadcast to ${PEOPLE[OTHER[who]]}.`] });
        ctx.explain(res.explain || explainCommit(st, who, res));
      } else {
        Y.L(ctx, { accepted: ['no', res.error.message], committed: 'no', async: 'n/a' });
        ctx.explain(`${PEOPLE[who]}’s edit was not saved: ${res.error.message}`);
      }
    }, { self: who });
  }
  function explainCommit(st, who, res) {
    const other = PEOPLE[OTHER[who]];
    if (st.strategy === 'lww') return res.overwrote ? `${PEOPLE[who]}’s phone saved the whole text it had. The server kept the last text it received, so ${other}’s concurrent edit, which ${PEOPLE[who]}’s copy never contained, is gone.` : `${PEOPLE[who]}’s phone saved the whole text. Nothing else had changed, so nothing was lost this time.`;
    if (st.strategy === 'lock') return res.waited ? `${PEOPLE[who]} waited ${SDL.fmtMs(res.waited)} for the paragraph lock held by ${other}, then committed revision ${res.rev}. Nothing was lost and nothing had to be transformed, at the price of waiting.` : `${PEOPLE[who]} took the paragraph lock, committed revision ${res.rev}, and keeps the lock for ${LOCK_MS} ms after the last keystroke.`;
    if (isCrdt(st)) return `${PEOPLE[who]}’s operation names the atom it goes after, not an index, so it means the same thing on every replica without transformation. Revision ${res.rev}.`;
    if (res.rebased) return `The server rejected the operation because its base revision was stale, and sent back the ${res.rebased} missing operation${res.rebased > 1 ? 's' : ''}. ${PEOPLE[who]}’s phone transformed its edit against them and sent it again: committed as revision ${res.rev}.`;
    return res.transformed ? `${PEOPLE[who]}’s operation was based on revision ${res.baseRev}; ${res.transformed} operation${res.transformed > 1 ? 's' : ''} from ${other} had been committed since. The session transformed it (position ${res.sent.pos} became ${res.op.pos}) and committed revision ${res.rev}.` : `No concurrent operation: committed as revision ${res.rev} without transformation.`;
  }

  function* submitOne(ctx, who, e) {
    const st = ctx.state;
    const u = ctx.ui[who];
    const sent = { clientId: e.clientId, baseRev: u.rev, op: Object.assign({}, e.op), who };
    if (ctx.mode('lag', 'ben') && who === 'ben') yield ctx.wait(400); // slow link: the operation is in transit while others commit
    const r = yield ctx.call('gw', 'submit', sent, { timeout: 2500 });
    ctx.recordOutcome(r.ok, r.latency);
    return { r, sent };
  }

  function* flush(ctx, who) {
    const st = ctx.state;
    const u = ctx.ui[who];
    if (!st.config.oneInFlight && st.strategy === 'ot') {
      // No in-flight rule: every queued operation goes out at once, each claiming the base revision the phone knows now.
      const mine = u.outstanding.filter((e) => e.state === 'queued');
      const procs = mine.map((e) => ctx.spawn(function* (c) { e.state = 'inflight'; const { r } = yield* submitOne(c, who, e); e.result = r; }));
      yield ctx.join(procs);
      let last = { ok: true, rev: u.rev };
      for (const e of mine) {
        if (!e.result || !e.result.ok) { e.state = 'unsaved'; u.status = 'unsaved'; last = { ok: false, error: (e.result && e.result.error) || { message: 'no reply' } }; continue; }
        u.outstanding.splice(u.outstanding.indexOf(e), 1);
        u.ownIds[e.clientId] = true;
        u.acked.push({ rev: e.result.value.rev, op: e.result.value.op, sent: e.op });
        if (!e.applied) { applyLocal(st, u, e.result.value.op); e.applied = true; }
        u.rev = Math.max(u.rev, e.result.value.rev);
        last = { ok: true, rev: e.result.value.rev, baseRev: e.result.value.baseRev, transformed: e.result.value.transformed, op: e.result.value.op, sent: e.op };
        if (e.result.value.transformed) last.explain = `This operation was sent while an earlier one from the same phone was still in flight, both claiming base revision ${e.result.value.baseRev}. The server transformed it against the earlier one as if they were concurrent, although the phone had already placed it relative to that edit. Its position moved from ${e.op.pos} to ${e.result.value.op.pos}: the server’s text and ${PEOPLE[who]}’s screen now disagree, and nothing reports it.`;
      }
      if (!u.outstanding.length) u.status = 'saved';
      u.lastResult = last;
      return last;
    }
    if (u.sending) { while (u.outstanding.length && u.sending) yield ctx.wait(50); return u.lastResult || { ok: true, rev: u.rev }; }
    u.sending = true;
    let last = { ok: true, rev: u.rev };
    try {
      while (u.outstanding.length) {
        const e = u.outstanding[0];
        e.state = 'inflight';
        let r, sent, rebased = 0, waited = 0;
        for (let attempt = 1; attempt <= 12; attempt++) {
          const out = yield* submitOne(ctx, who, e);
          r = out.r; sent = out.sent;
          if (r.ok) break;
          if (r.error.code === 'STALE_BASE') {
            // Rebase locally: apply what we missed, transform our pending ops against it, try again.
            const missed = r.error.detail.ops;
            for (const row of missed) applyRemote(ctx, who, row);
            rebased += missed.length; st.stats.rebases++;
            ctx.log({ op: `rebased on ${missed.length} missed revision${missed.length > 1 ? 's' : ''}`, status: 'retry', detail: `Base revision ${sent.baseRev} was stale. The phone applied the missing operations, transformed its own against them, and resends with base revision ${u.rev}.` });
            continue;
          }
          if (r.error.code === 'LOCKED') {
            if (!waited) ctx.log({ op: `waiting for the paragraph lock held by ${PEOPLE[r.error.detail.holder]}`, status: 'retry', detail: 'Only one person may edit this paragraph at a time.' });
            waited += 300; st.stats.lockWaits++;
            e.state = 'locked'; u.status = 'locked';
            yield ctx.wait(300);
            continue;
          }
          if (['TIMEOUT', 'UNAVAILABLE'].includes(r.error.code) && attempt < 3) { yield ctx.wait(300 * attempt); continue; }
          break;
        }
        if (!r.ok) { e.state = 'unsaved'; u.status = 'unsaved'; last = { ok: false, error: r.error }; break; }
        if (r.value.rev > u.rev + 1) yield* catchUp(ctx, who, r.value.rev - 1);
        u.outstanding.shift();
        if (!e.applied) { applyLocal(st, u, r.value.op); e.applied = true; }
        u.rev = Math.max(u.rev, r.value.rev);
        u.ownIds[e.clientId] = true;
        u.acked.push({ rev: r.value.rev, op: r.value.op, sent: e.op });
        last = { ok: true, rev: r.value.rev, baseRev: r.value.baseRev, transformed: r.value.transformed, op: r.value.op, sent: sent.op, rebased, waited, overwrote: r.value.overwrote };
      }
      if (!u.outstanding.length) u.status = 'saved';
    } finally { u.sending = false; u.lastResult = last; }
    return last;
  }

  function* catchUp(ctx, who, upto) {
    const u = ctx.ui[who];
    const r = yield ctx.call('gw', 'since', { who, rev: u.rev, upto }, { timeout: 800 });
    if (!r.ok) return;
    ctx.state.stats.backfills++;
    for (const row of r.value.ops) applyRemote(ctx, who, row);
    ctx.log({ op: `backfilled ${r.value.ops.length} revision${r.value.ops.length === 1 ? '' : 's'}`, status: 'recovered', detail: `${PEOPLE[who]}’s copy was behind; the missing operations were fetched from the session.` });
  }
  function applyRemote(ctx, who, row) {
    const st = ctx.state;
    const u = ctx.ui[who];
    if (row.rev <= u.rev) { st.stats.dupsIgnored++; return false; }
    u.rev = row.rev;
    if (u.ownIds[row.clientId] || row.who === who) return true;
    let op = row.op;
    if (st.strategy === 'ot' || st.strategy === 'lock') {
      for (const e of u.outstanding) {
        if (!e.applied) continue;
        const mine = e.op;
        e.op = OT.transform(mine, op, false);
        op = OT.transform(op, mine, true);
      }
    }
    applyLocal(st, u, op);
    u.remote.push({ rev: row.rev, op });
    return true;
  }

  function startUndo(sim, who) {
    const st = sim.state;
    const u = sim.ui[who];
    const lastOwn = u.acked[u.acked.length - 1];
    if (!lastOwn || u.outstanding.length || st.strategy === 'lww') return;
    sim.startAction(`${PEOPLE[who]}: undo`, function* (ctx) {
      let inv;
      if (isCrdt(st)) inv = lastOwn.op.del ? { after: null, id: `${++st.seq.lamport}:${who}`, text: '' } : { del: lastOwn.op.id };
      else {
        const o = lastOwn.op;
        inv = o.ins ? { pos: o.pos, del: o.ins.length, removed: o.ins } : { pos: o.pos, ins: o.removed || lastOwn.sent.removed || '' };
        // The inverse is based on the revision of the original; transform it past every remote operation since.
        for (const r of u.remote.filter((x) => x.rev > lastOwn.rev)) inv = OT.transform(inv, r.op, false);
      }
      if (isCrdt(st) && inv.text === '' && !inv.del) { ctx.explain('Undoing a delete under CRDT ids would re-insert the atom; not modelled here.'); return; }
      const entry = { clientId: `${who}-${++st.seq.client}`, op: inv, who, state: 'queued', applied: true };
      applyLocal(st, u, inv);
      u.outstanding.push(entry);
      u.acked.pop();
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      u.status = 'saving';
      const res = yield* flush(ctx, who);
      if (res.ok) { Y.L(ctx, { accepted: 'yes', committed: 'yes', async: 'pending' }); ctx.explain(`Undo is a new operation: the inverse of ${PEOPLE[who]}’s last edit, transformed past ${u.remote.filter((x) => x.rev > lastOwn.rev).length} remote operation${u.remote.filter((x) => x.rev > lastOwn.rev).length === 1 ? '' : 's'} committed since. It removes only ${PEOPLE[who]}’s own text, wherever it moved to.`); }
      else { Y.L(ctx, { accepted: 'no', committed: 'no', async: 'n/a' }); }
    }, { self: who });
  }

  function resetDoc(sim) {
    const st = sim.state;
    st.doc = { text: DOC0, rev: 0, atoms: ATOMS0.map((t, i) => ({ id: `${i}:doc`, text: t, del: false })) };
    st.log = []; st.lock = null; st.last = null;
    st.stats.lostEdits = 0; st.stats.lost = [];
    for (const who of Object.keys(PEOPLE)) Object.assign(sim.ui[who], { text: DOC0, atoms: st.doc.atoms.slice(), rev: 0, outstanding: [], ownIds: {}, acked: [], remote: [], status: 'saved', typed: 0 });
  }

  /* ---------- server side ---------- */
  function* commit(ctx, p) {
    const st = ctx.state;
    const since = st.log.filter((r) => r.rev > p.baseRev);
    let op = p.op;
    let overwrote = 0;
    if (st.strategy === 'lww') {
      overwrote = since.filter((r) => r.who !== p.who).length;
      if (overwrote) { st.stats.lostEdits += overwrote; for (const r of since.filter((x) => x.who !== p.who)) st.stats.lost.push(r.op.word || ''); ctx.log({ op: `overwrote ${overwrote} concurrent edit${overwrote > 1 ? 's' : ''}`, status: 'err', detail: `The text just saved was based on revision ${p.baseRev}. It silently replaces everything committed since.` }); }
    } else if (st.strategy === 'lock') {
      if (st.lock && st.lock.holder !== p.who && st.lock.until > ctx.now()) ctx.fail('LOCKED', `The paragraph is locked by ${PEOPLE[st.lock.holder]}.`, { holder: st.lock.holder });
      st.lock = { holder: p.who, until: ctx.now() + LOCK_MS };
      for (const r of since) op = OT.transform(op, r.op, false); // with a lock there is nothing concurrent; this is a no-op
    } else if (st.strategy === 'ot') {
      if (!st.config.serverTransform && since.length) ctx.fail('STALE_BASE', `Based on revision ${p.baseRev}; the document is at ${st.doc.rev}.`, { ops: since.map((r) => ({ rev: r.rev, op: r.op, who: r.who, clientId: r.clientId })) });
      const bug = !!ctx.mode('bug');
      for (const r of since) op = bug ? buggyTransform(op, r.op) : OT.transform(op, r.op, false);
      st.stats.transformed += since.length;
      if (since.length) st.last = { who: p.who, baseRev: p.baseRev, head: st.doc.rev, received: p.op, transformed: op, against: since.length, bug };
    }
    const rev = st.doc.rev + 1;
    const row = { rev, op, who: p.who, clientId: p.clientId, baseRev: p.baseRev, t: ctx.now() };
    ctx.must(yield ctx.call('oplog', 'append', row, { timeout: 900 }));
    st.doc.rev = rev;
    if (isCrdt(st)) st.doc.atoms = applyAtoms(st.doc.atoms, op);
    else if (st.strategy === 'lww') st.doc.text = op.text;
    else st.doc.text = OT.apply(st.doc.text, op);
    st.log.push(row);
    st.byClient[p.clientId] = rev;
    st.stats.ops++;
    ctx.sim.enqueue('bcast', { type: `rev ${rev}`, eventId: `r${rev}`, payload: { rev, op, who: p.who, clientId: p.clientId } });
    return { rev, op, baseRev: p.baseRev, transformed: since.length, overwrote };
  }
  /** A plausible bug: forgets that an earlier insert shifts later positions. */
  function buggyTransform(op, prior) {
    const o = Object.assign({}, op);
    if (prior.del && prior.pos < o.pos) o.pos -= Math.min(prior.del, o.pos - prior.pos);
    return o; // inserts are ignored
  }

  SDL.scenarios['docs-ot'] = {
    id: 'docs-ot',
    seed: 311,
    productWidth: 640,
    intro: 'Make both phones type at the same spot and watch the transform inspector. Then switch the strategy in the console to last-writer-wins, a lock, or CRDT ids, or inject the transform bug.',
    modeLabels: { bug: 'Transform bug', lag: 'High latency', reorder: 'Reordering messages' },
    topology: {
      width: 1160, height: 520,
      nodes: [
        { id: 'ana', label: 'Ana’s phone', sub: 'Editing', kind: 'client', x: 90, y: 110, latency: 1, role: 'Applies locally first, keeps at most one operation in flight, transforms incoming operations against its unacknowledged one.', ops: [{ name: 'push', desc: 'A remote operation.' }], owns: ['Local copy'] },
        { id: 'ben', label: 'Ben’s phone', sub: 'Editing', kind: 'client', x: 90, y: 400, latency: 1, role: 'Same as Ana’s phone. Can be put on a slow link.', ops: [{ name: 'push', desc: 'A remote operation.' }], owns: ['Local copy'] },
        { id: 'gw', label: 'WebSocket gateway', sub: 'Sockets', kind: 'gateway', x: 330, y: 255, latency: 2, role: 'Forwards submits and pushes broadcasts.', ops: [{ name: 'submit', desc: 'An operation.' }, { name: 'since', desc: 'Backfill.' }], owns: ['Sockets'] },
        { id: 'session', label: 'Document session', sub: 'Sequencer and transform', kind: 'service', x: 580, y: 255, latency: 4, role: 'Orders operations one at a time. Under OT it transforms each against everything committed since its base revision. Under a lock it refuses the second editor. Under last-writer-wins it stores whatever text arrived last.', ops: [{ name: 'submit', desc: 'Order, transform, commit.' }, { name: 'since', desc: 'Operations after a revision.' }], owns: ['Text and head revision', 'Paragraph lock'] },
        { id: 'oplog', label: 'Operation log', sub: 'By revision', kind: 'db', x: 850, y: 110, latency: 8, role: 'One row per revision.', ops: [{ name: 'append', desc: 'Write a revision.' }], owns: ['log[rev]'] },
        { id: 'pubsub', label: 'Pub/sub', sub: 'Document channel', kind: 'queue', x: 850, y: 400, latency: 3, role: 'Broadcasts committed operations to the gateway.', owns: ['Channel'] },
      ],
      edges: [
        { from: 'ana', to: 'gw', latency: 30, label: 'WebSocket' },
        { from: 'ben', to: 'gw', latency: 30, label: 'WebSocket' },
        { from: 'gw', to: 'session', latency: 3 },
        { from: 'session', to: 'oplog', latency: 4 },
        { from: 'session', to: 'pubsub', latency: 3 },
        { from: 'pubsub', to: 'gw', latency: 3, via: [[580, 470], [330, 470]] },
      ],
      queues: [{ id: 'bcast', broker: 'pubsub', label: 'Document channel', groups: ['gw'] }],
    },
    failures: [
      { id: 'session-slow', node: 'session', mode: 'slow', params: { factor: 60 }, label: 'Session slow', desc: 'Commits take a quarter of a second: a longer window for concurrent edits to pile up.' },
      { id: 'ben-lag', node: 'ben', mode: 'lag', label: 'Ben on a slow link', desc: 'His operations take 400 ms longer to reach the server, so more of Ana’s edits land in between.' },
      { id: 'bug', node: 'session', mode: 'bug', label: 'Transform bug', desc: 'The transform forgets that an earlier insert shifts later positions. The copies silently diverge.' },
      { id: 'reorder', node: 'pubsub', mode: 'reorder', label: 'Pub/sub reorders messages', desc: 'Odd revisions are delayed behind even ones. Revision numbers let the phones notice.' },
      { id: 'log-down', node: 'oplog', mode: 'down', label: 'Operation log down', desc: 'Nothing commits.' },
    ],
    switches: Y.switches([
      ['optimistic', 'Optimistic local echo', 'Apply locally before the server answers.'],
      ['oneInFlight', 'One operation in flight per client', 'Send the next operation only after the previous one is acknowledged, so each one’s base revision is exact. Off: send everything queued at once with the same base revision.'],
      ['serverTransform', 'Server transforms stale operations', 'The session transforms an operation whose base revision is behind. Off: it rejects it and the phone must rebase and resend.'],
    ]),
    presets: Y.presets({ optimistic: true, oneInFlight: true, serverTransform: true }, [
      { id: 'same-spot', label: 'Same spot, OT', desc: 'Both insert at the end in the same instant. The second to arrive is transformed past the first. Both sentences survive, in the same order on both screens.', run: (s) => { setStrategy(s, 'ot'); startType(s, 'ana', 'ins'); s.schedule(20, () => startType(s, 'ben', 'ins')); } },
      { id: 'same-spot-lww', label: 'Same spot, last writer wins', desc: 'Each phone saves its whole text. The server keeps the last one it received, which never contained the other person’s sentence.', run: (s) => { setStrategy(s, 'lww'); startType(s, 'ana', 'ins'); s.schedule(20, () => startType(s, 'ben', 'ins')); } },
      { id: 'same-spot-lock', label: 'Same spot, paragraph lock', desc: 'Ana takes the lock. Ben’s edit waits on his phone until the lock expires, then commits. Nothing conflicts, because nothing is concurrent.', run: (s) => { setStrategy(s, 'lock'); startType(s, 'ana', 'ins'); s.schedule(20, () => startType(s, 'ben', 'ins')); } },
      { id: 'same-spot-crdt', label: 'Same spot, CRDT ids', desc: 'Operations name the atom they follow, not an index. Concurrent inserts after the same atom are ordered by id on every replica, without a transform.', run: (s) => { setStrategy(s, 'crdt'); startType(s, 'ana', 'ins'); s.schedule(20, () => startType(s, 'ben', 'ins')); } },
      { id: 'crdt-delete', label: 'Delete under CRDT ids', desc: 'A deleted atom becomes a tombstone that every replica keeps, so later operations can still name it. The document grows even as the text shrinks.', run: (s) => { setStrategy(s, 'crdt'); startType(s, 'ana', 'ins'); s.schedule(900, () => startType(s, 'ben', 'delAll')); s.schedule(1800, () => startType(s, 'ana', 'ins')); } },
      { id: 'delete-over-insert', label: 'Delete across an insert', desc: 'Ben deletes everything after the colon while Ana types inside that range. The transform deletes around her words: nothing anyone typed is lost.', run: (s) => { setStrategy(s, 'ot'); s.ui.ana.cursor = 'ship'; startType(s, 'ana', 'ins'); s.schedule(20, () => startType(s, 'ben', 'delAll')); } },
      { id: 'undo', label: 'Undo after a remote edit', desc: 'Ana types, Ben types before her text, Ana undoes. The inverse operation is transformed past Ben’s edit, so only Ana’s own words disappear.', run: (s) => { setStrategy(s, 'ot'); s.ui.ben.cursor = 'start'; startType(s, 'ana', 'ins'); s.schedule(800, () => startType(s, 'ben', 'ins')); s.schedule(1800, () => startUndo(s, 'ana')); } },
      { id: 'rebase', label: 'Stale base rejected, phone rebases', desc: 'The server refuses an operation whose base revision is behind. Ben’s phone applies what it missed, transforms, and resends. Same result, one more round trip.', sw: { serverTransform: false }, run: (s) => { setStrategy(s, 'ot'); startType(s, 'ana', 'ins'); s.schedule(20, () => startType(s, 'ben', 'ins')); } },
      { id: 'two-in-flight', label: 'Two operations in flight', desc: 'Ana’s phone sends two operations at once with the same base revision. The server transforms the second against the first as if they were concurrent, shifting it twice. Her screen and the document disagree.', sw: { oneInFlight: false }, run: (s) => { setStrategy(s, 'ot'); s.ui.ana.cursor = 'start'; startType(s, 'ana', 'ins'); startType(s, 'ana', 'ins'); } },
      { id: 'bug', label: 'Transform bug', desc: 'The transform forgets to shift past an earlier insert. Both operations commit, both phones look fine, and the two copies are different.', run: (s) => { setStrategy(s, 'ot'); s.inject('session', 'bug'); s.ui.ana.cursor = 'start'; startType(s, 'ana', 'ins'); s.schedule(20, () => startType(s, 'ben', 'ins')); } },
      { id: 'slow-link', label: 'Ben on a slow link', desc: 'Ana commits three edits at the start of the sentence while Ben’s operation is still in transit. It arrives with base revision 0 and is transformed past all three.', run: (s) => { setStrategy(s, 'ot'); s.inject('ben', 'lag'); s.ui.ana.cursor = 'start'; startType(s, 'ben', 'ins'); s.schedule(10, () => startType(s, 'ana', 'ins')); s.schedule(130, () => startType(s, 'ana', 'ins')); s.schedule(250, () => startType(s, 'ana', 'ins')); } },
      { id: 'reorder', label: 'Pub/sub reorders', desc: 'Revision 2 reaches Ben before revision 1. The gap is obvious from the numbers: he fetches 1 first, then ignores the late copy.', run: (s) => { setStrategy(s, 'ot'); s.inject('pubsub', 'reorder'); startType(s, 'ana', 'ins'); s.schedule(150, () => startType(s, 'ana', 'ins')); } },
    ]),
    initialState: () => ({
      config: { optimistic: true, oneInFlight: true, serverTransform: true },
      strategy: 'ot', doc: { text: DOC0, rev: 0, atoms: ATOMS0.map((t, i) => ({ id: `${i}:doc`, text: t, del: false })) }, log: [], byClient: {}, lock: null, last: null, busy: false,
      seq: { client: 0, lamport: 10 }, stats: { ops: 0, transformed: 0, rebases: 0, lockWaits: 0, backfills: 0, dupsIgnored: 0, lostEdits: 0, lost: [] },
    }),
    initialUI: () => {
      const phone = (who) => ({ who, text: DOC0, atoms: ATOMS0.map((t, i) => ({ id: `${i}:doc`, text: t, del: false })), rev: 0, outstanding: [], ownIds: {}, acked: [], remote: [], status: 'saved', cursor: 'end', typed: 0, sending: false });
      return { ana: phone('ana'), ben: phone('ben') };
    },
    actions: {
      type(sim, a) { startType(sim, a.who, a.kind); },
      undo(sim, a) { startUndo(sim, a.who); },
      set(sim, a) { if (a.field === 'strategy') setStrategy(sim, a.value); else Y.setAction(sim, a); },
    },
    setup(sim) {
      Y.consumer(sim, 'bcast', 'gw', 'gw', function* (ctx, msg) {
        const row = msg.payload;
        const delay = ctx.mode('reorder', 'pubsub') && row.rev % 2 === 1 ? 200 : 0;
        ctx.spawn(function* (c) {
          if (delay) yield c.wait(delay);
          for (const who of Object.keys(PEOPLE)) { if (who === row.who || !online(c.sim, who)) continue; yield c.call(who, 'push', row, { timeout: 800 }); }
        });
        return true;
      }, () => false);
    },
    handlers: {
      gw: {
        submit: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'submit', p, { timeout: 2300 })); },
        since: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'since', p, { timeout: 700 })); },
      },
      session: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          if (st.byClient[p.clientId] != null) { const row = st.log[st.byClient[p.clientId] - 1]; return { rev: row.rev, op: row.op, baseRev: p.baseRev, transformed: 0, replayed: true }; }
          while (st.busy) yield ctx.wait(5);
          st.busy = true;
          try { return yield* commit(ctx, p); } finally { st.busy = false; }
        },
        since(ctx, p) { return { from: p.rev, ops: ctx.state.log.filter((r) => r.rev > p.rev && (p.upto == null || r.rev <= p.upto)).map((r) => ({ rev: r.rev, op: r.op, who: r.who, clientId: r.clientId })) }; },
      },
      oplog: { append(ctx, row) { return { rev: row.rev }; } },
      ana: { push: function* (ctx, row) { return { applied: yield* receive(ctx, 'ana', row) }; } },
      ben: { push: function* (ctx, row) { return { applied: yield* receive(ctx, 'ben', row) }; } },
    },
    consistency(sim) {
      const st = sim.state;
      if (st.stats.lostEdits) return { key: 'wrong', label: `${st.stats.lostEdits} edit${st.stats.lostEdits > 1 ? 's were' : ' was'} overwritten (“${st.stats.lost.map((x) => x.trim()).join('”, “')}”): the last whole-text save silently replaced concurrent work.` };
      const pending = Object.keys(PEOPLE).filter((w) => sim.ui[w].outstanding.length);
      if (pending.length) {
        const locked = pending.filter((w) => sim.ui[w].status === 'locked');
        if (locked.length) return { key: 'stale', label: `${locked.map((w) => PEOPLE[w]).join(' and ')} ${locked.length > 1 ? 'are' : 'is'} waiting for the paragraph lock. The edit is on screen but not on the server.` };
        const unsaved = pending.filter((w) => sim.ui[w].status === 'unsaved');
        if (unsaved.length) return { key: 'stale', label: `${unsaved.map((w) => PEOPLE[w]).join(' and ')} ${unsaved.length > 1 ? 'have' : 'has'} unsaved edits.` };
        return { key: 'stale', label: `${pending.map((w) => PEOPLE[w]).join(' and ')} ${pending.length > 1 ? 'have' : 'has'} operations in flight.` };
      }
      const behind = Object.keys(PEOPLE).filter((w) => sim.ui[w].rev < st.doc.rev);
      if (behind.length) return { key: 'stale', label: `${behind.map((w) => `${PEOPLE[w]}’s copy is at revision ${sim.ui[w].rev}`).join('; ')}; the document is at ${st.doc.rev}.` };
      const server = docText(st);
      const diverged = Object.keys(PEOPLE).filter((w) => textOf(st, sim.ui[w]) !== server);
      if (diverged.length) return { key: 'wrong', label: `${diverged.map((w) => PEOPLE[w]).join(' and ')}’s screen differs from the document at the same revision ${st.doc.rev}. ${st.last && st.last.bug ? 'The transform forgot an earlier insert.' : 'Two operations claimed the same base revision, so the second was shifted twice.'} Nobody has been told.` };
      const tombs = st.doc.atoms.filter((a) => a.del).length;
      return { key: 'ok', label: `Both phones show the same text as the document at revision ${st.doc.rev}.${isCrdt(st) && tombs ? ` ${tombs} tombstone${tombs === 1 ? '' : 's'} kept on every replica.` : ''}` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const tomb = st.doc.atoms.filter((a) => a.del).length;
      const bytes = isCrdt(st) ? st.doc.atoms.reduce((a, x) => a + x.text.length + 12, 0) : st.doc.text.length;
      return [
        { label: 'Strategy', value: STRATEGIES[st.strategy].split(',')[0] },
        { label: 'Revision', value: st.doc.rev },
        { label: 'Transformed against concurrent ops', value: st.stats.transformed },
        { label: 'Rebases on the phone', value: st.stats.rebases },
        { label: 'Lock waits', value: st.stats.lockWaits, tone: st.stats.lockWaits ? 'warn' : '' },
        { label: 'Tombstones', value: tomb, tone: tomb ? 'warn' : '' },
        { label: 'Document bytes with metadata', value: bytes },
        { label: 'Edits overwritten', value: st.stats.lostEdits, tone: st.stats.lostEdits ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['ana', 'Ana'], ['ben', 'Ben']], {
          note: 'Both phones edit the same sentence. Pick where each cursor sits, type, delete, or undo. The console chooses the conflict strategy and shows the last transform the session performed.',
          below: `<div class="ops-console"><p class="ops-title">Conflict strategy and transform inspector</p>
            <div class="app-row"><label class="app-sub" for="strategy">Strategy</label> <select id="strategy" data-field="strategy">${Object.entries(STRATEGIES).map(([k, v]) => `<option value="${k}">${SDL.ui.esc(v)}</option>`).join('')}</select></div>
            <div data-ref="inspector"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const who of Object.keys(PEOPLE)) {
          const u = sim.ui[who];
          const text = textOf(st, u);
          const pos = isCrdt(st) ? (() => { const at = cursorAtom(u); const vis = u.atoms.filter((a) => !a.del); let n = 0; for (const a of vis) { n += a.text.length; if (a.id === at) return n; } return at == null ? 0 : n; })() : cursorPos(u);
          const html = esc(text.slice(0, pos)) + '<span class="doc-caret"></span>' + esc(text.slice(pos));
          const chip = u.status === 'saved' ? ['ok', `Saved · rev ${u.rev}`] : u.status === 'locked' ? ['fail', 'Waiting for lock'] : u.status === 'unsaved' ? ['fail', 'Unsaved'] : ['work', 'Saving…'];
          const canUndo = !!u.acked.length && !u.outstanding.length && st.strategy !== 'lww';
          Y.paint(el, sim, who, {
            head: `<div><p class="app-title">Q3 plan</p><p class="app-sub">${esc(STRATEGIES[st.strategy])}</p></div>`,
            doc: `<div class="app-card doc-page"><p class="doc-text">${html}</p><span class="app-sub doc-chip" data-tone="${chip[0]}">${chip[1]}</span></div>`,
            cursor: `<div class="app-row"><label class="app-sub" for="cur-${who}">Cursor</label> <select id="cur-${who}" data-field="${who}.cursor">${[['start', 'Start'], ['colon', 'After the colon'], ['ship', 'After “ship”'], ['end', 'End']].map(([k, v]) => `<option value="${k}"${u.cursor === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div>`,
            keys: `<div class="app-row">${Y.btn('type', `Type “${esc(WORDS[who][u.typed % WORDS[who].length].trim())}”`, { arg: { who, kind: 'ins' }, cls: 'go' })}${Y.btn('type', 'Delete a word', { arg: { who, kind: 'del' }, cls: 'secondary' })}</div>
                   <div class="app-row">${Y.btn('type', 'Delete after the colon', { arg: { who, kind: 'delAll' }, cls: 'secondary' })}${Y.btn('undo', 'Undo', { arg: { who }, cls: 'secondary', disabled: !canUndo })}</div>`,
          }, {}, null);
        }
        const sel = el.querySelector('#strategy');
        if (sel && sel.value !== st.strategy) sel.value = st.strategy;
        const L = st.last;
        const fmtOp = (o) => (o.ins != null ? `insert “${o.ins}” at ${o.pos}` : o.del != null && o.pos != null ? `delete ${o.del} at ${o.pos}${o.then ? ` and ${o.then.del} at ${o.then.pos}` : ''}` : JSON.stringify(o));
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="inspector"]'), {
          last: L ? `<div class="ops-shards"><div class="ops-row" data-tone="${L.bug ? 'fail' : 'ok'}"><div class="ops-name"><strong>${esc(PEOPLE[L.who])}’s operation, base revision ${L.baseRev}, head ${L.head}</strong><span>received: ${esc(fmtOp(L.received))} → transformed against ${L.against}: ${esc(fmtOp(L.transformed))}${L.bug ? ' (buggy transform)' : ''}</span></div></div></div>` : '<p class="app-sub">No concurrent operation has needed a transform yet.</p>',
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };

  function setStrategy(sim, s) {
    if (!STRATEGIES[s]) return;
    const changed = sim.state.strategy !== s;
    sim.state.strategy = s;
    if (changed) { resetDoc(sim); sim.note(`Strategy set to “${STRATEGIES[s]}”. The document was reset to its first revision.`); }
  }
  function* receive(ctx, who, row) {
    const u = ctx.ui[who];
    if (row.rev > u.rev + 1) { ctx.log({ op: `gap: expected revision ${u.rev + 1}, got ${row.rev}`, status: 'retry', detail: 'Fetching the missing revisions first.' }); yield* catchUp(ctx, who, row.rev - 1); }
    return applyRemote(ctx, who, row);
  }
})(typeof window !== 'undefined' ? window : globalThis);
