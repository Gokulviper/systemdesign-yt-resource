/*
 * Comments, suggestions, and anchors that move.
 * A comment is attached to a range of text at a revision. Every later
 * operation moves that range: an insert above shifts it, a delete across it
 * shrinks it, a delete of all of it orphans it. The session transforms
 * anchors as it commits, so the margin stays on the right words. A mention
 * must become exactly one notification even when the queue duplicates or
 * fails: the comment write and its event go through an outbox, and the
 * worker deduplicates by event id. A suggestion is an operation held until
 * accepted, and accepting it transforms it to wherever the text is now.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const OT = Y.ot;

  const PEOPLE = { ana: 'Ana', ben: 'Ben', cho: 'Cho' };
  const DOC0 = 'Q3 plan: ship the editor.';
  const WORDS = { ben: [' Fix sync.', ' Add tests.', ' Ship it.'] };

  /** Move an anchor [start, end) past an operation. */
  function shiftAnchor(a, op) {
    let { start, end } = a;
    if (op.ins) {
      const n = op.ins.length;
      if (op.pos <= start) { start += n; end += n; }
      else if (op.pos < end) end += n;
    } else if (op.del) {
      const ds = op.pos, de = op.pos + op.del;
      const cut = (x) => (x <= ds ? x : x >= de ? x - op.del : ds);
      start = cut(start); end = cut(end);
      if (op.then) return shiftAnchor({ start, end }, op.then);
    }
    return { start, end };
  }

  /* ---------- editing (Ben) ---------- */
  function startType(sim, kind) {
    const st = sim.state;
    const u = sim.ui.ben;
    let op;
    if (kind === 'delRange') { const from = u.text.indexOf('ship'); op = from < 0 ? null : { pos: from, del: 'ship the editor'.length }; }
    else if (kind === 'start') op = { pos: 0, ins: 'Draft: ' };
    else { const word = WORDS.ben[u.typed++ % WORDS.ben.length]; op = { pos: u.text.length, ins: word }; }
    if (!op) return;
    sim.startAction(`Ben: ${kind === 'delRange' ? 'delete “ship the editor”' : kind === 'start' ? 'type “Draft: ” at the start' : `type “${op.ins.trim()}”`}`, function* (ctx) {
      u.text = OT.apply(u.text, op); u.pending = op;
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('gw', 'submit', { clientId: `ben-${++st.seq.client}`, baseRev: u.rev, op, who: 'ben' }, { timeout: 1500 });
      u.pending = null;
      if (r.ok) { u.rev = Math.max(u.rev, r.value.rev); Y.L(ctx, { accepted: 'yes', committed: 'yes', async: 'pending' }); ctx.explain(`Revision ${r.value.rev}. ${r.value.anchorsMoved ? `${r.value.anchorsMoved} comment anchor${r.value.anchorsMoved > 1 ? 's were' : ' was'} transformed with it${r.value.orphaned ? `; ${r.value.orphaned} now point${r.value.orphaned > 1 ? '' : 's'} at deleted text and ${r.value.orphaned > 1 ? 'are' : 'is'} marked as such` : ''}.` : st.config.anchorsInSession ? 'No open comments to move.' : 'Comment anchors were left as fixed offsets.'}`); }
      else { u.text = OT.apply(u.text, op.ins ? { pos: op.pos, del: op.ins.length } : { pos: op.pos, ins: 'ship the editor' }); Y.L(ctx, { accepted: ['no', r.error.message], committed: 'no', async: 'n/a' }); ctx.explain(`Not saved: ${r.error.message}`); }
    }, { self: 'ben' });
  }

  /* ---------- comments (Cho) ---------- */
  function startComment(sim, text, mention) {
    const st = sim.state;
    sim.startAction(`Cho: comment on “ship the editor”${mention ? ', mentioning Ben' : ''}`, function* (ctx) {
      const u = ctx.ui.cho;
      const from = st.doc.text.indexOf('ship the editor');
      if (from < 0) { ctx.explain('The phrase is gone; nothing to comment on.'); return; }
      Y.L(ctx, { displayed: 'yes', retrySafe: ['yes', 'Client comment id.'] });
      const r = yield ctx.call('gw', 'comment', { clientId: `c-${++st.seq.client}`, start: from, end: from + 'ship the editor'.length, rev: st.doc.rev, text, mention: mention ? 'ben' : null, by: 'cho' }, { timeout: 1800 });
      if (!r.ok) { u.error = r.error.message; Y.failed(ctx, 'Comment not posted.'); ctx.explain(`The comment could not be posted: ${r.error.message} Editing is unaffected.`); return; }
      u.error = null;
      Y.L(ctx, { accepted: 'yes', committed: ['yes', 'Comment row written.'], async: [mention ? 'pending' : 'n/a', mention ? (st.config.outbox ? 'Mention event in the outbox, same transaction.' : 'Mention event published after the write.') : null] });
      ctx.explain(`Comment ${r.value.id} is anchored to characters ${r.value.start}–${r.value.end} at revision ${r.value.rev}.${mention ? st.config.outbox ? ' The mention event was written in the same transaction as the comment; a relay moves it to the queue.' : ' The mention event was published to the queue after the comment write, as a separate step.' : ''}`);
    }, { self: 'cho' });
  }
  function startResolve(sim, id) {
    sim.startAction(`Ana: resolve comment ${id}`, function* (ctx) {
      Y.L(ctx, { retrySafe: 'yes', async: 'n/a' });
      const r = yield ctx.call('gw', 'resolve', { id }, { timeout: 1500 });
      if (r.ok) { Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'yes' }); ctx.explain(`Comment ${id} is resolved: hidden from the margin, kept in history.`); } else { Y.failed(ctx); ctx.explain(`Could not resolve: ${r.error.message}`); }
    }, { self: 'ana' });
  }
  function startSuggest(sim) {
    const st = sim.state;
    sim.startAction('Cho: suggest inserting “ (v2)” after “editor”', function* (ctx) {
      const at = st.doc.text.indexOf('editor');
      if (at < 0) { ctx.explain('The word is gone.'); return; }
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('gw', 'suggest', { clientId: `s-${++st.seq.client}`, op: { pos: at + 'editor'.length, ins: ' (v2)' }, anchor: { start: at, end: at + 'editor'.length }, rev: st.doc.rev, by: 'cho' }, { timeout: 1800 });
      if (!r.ok) { Y.failed(ctx); ctx.explain(`Suggestion failed: ${r.error.message}`); return; }
      Y.L(ctx, { accepted: 'yes', committed: 'yes', async: 'n/a' });
      ctx.explain(`Suggestion ${r.value.id} is stored as a pending operation anchored at revision ${r.value.rev}. It is not in the document until someone with edit rights accepts it.`);
    }, { self: 'cho' });
  }
  function startAccept(sim, id) {
    sim.startAction(`Ana: accept suggestion ${id}`, function* (ctx) {
      Y.L(ctx, { retrySafe: ['yes', 'Accepting twice applies once.'] });
      const r = yield ctx.call('gw', 'accept', { id, who: 'ana' }, { timeout: 1800 });
      if (r.ok) { Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'yes', async: 'pending' }); ctx.explain(`Accepted: the suggested operation was transformed from revision ${r.value.from} to the current text and committed as revision ${r.value.rev}.`); }
      else { Y.L(ctx, { displayed: 'no', accepted: ['no', r.error.message], committed: 'no', async: 'n/a' }); ctx.explain(`Cannot accept: ${r.error.message} The suggestion is marked outdated instead of being applied somewhere else in the text.`); }
    }, { self: 'ana' });
  }

  SDL.scenarios['docs-comments'] = {
    id: 'docs-comments',
    seed: 909,
    productWidth: 640,
    intro: 'Have Cho comment on “ship the editor”, then let Ben type at the start of the sentence and watch the anchor. Mention Ben and break the queue; suggest an edit and delete the text under it.',
    modeLabels: { skipAnchors: 'Skipping anchor updates' },
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'ana', label: 'Ana’s phone', sub: 'Owner', kind: 'client', x: 90, y: 90, latency: 1, role: 'Sees the margin, resolves comments, accepts suggestions.', ops: [{ name: 'push', desc: 'A remote operation.' }, { name: 'notify', desc: 'A notification.' }], owns: ['Local copy'] },
        { id: 'ben', label: 'Ben’s phone', sub: 'Editor', kind: 'client', x: 90, y: 300, latency: 1, role: 'Edits the text under and around the comments. Gets mention notifications.', ops: [{ name: 'push', desc: 'A remote operation.' }, { name: 'notify', desc: 'A notification.' }], owns: ['Local copy'] },
        { id: 'cho', label: 'Cho’s browser', sub: 'Commenter', kind: 'client', x: 90, y: 510, latency: 1, role: 'May comment and suggest, not edit.', owns: ['Nothing'] },
        { id: 'gw', label: 'Gateway', sub: 'Sockets and API', kind: 'gateway', x: 330, y: 300, latency: 2, role: 'Routes operations to the session and comment calls to the comments service.', ops: [{ name: 'submit', desc: 'An operation.' }, { name: 'comment', desc: 'New comment.' }, { name: 'resolve', desc: 'Resolve.' }, { name: 'suggest', desc: 'New suggestion.' }, { name: 'accept', desc: 'Accept a suggestion.' }], owns: ['Sockets'] },
        { id: 'session', label: 'Document session', sub: 'Sequencer and anchors', kind: 'service', x: 580, y: 180, latency: 4, role: 'Commits operations and, with each one, transforms the anchors of every open comment and suggestion.', ops: [{ name: 'submit', desc: 'Commit and move anchors.' }, { name: 'apply', desc: 'Commit an accepted suggestion.' }], owns: ['Head revision', 'Live anchors'] },
        { id: 'comments', label: 'Comments service', sub: 'Threads, suggestions', kind: 'service', x: 580, y: 420, latency: 4, role: 'Stores comments and suggestions, writes mention events, resolves threads.', ops: [{ name: 'create', desc: 'New comment.' }, { name: 'resolve', desc: 'Resolve.' }, { name: 'suggest', desc: 'New suggestion.' }, { name: 'accept', desc: 'Accept.' }], owns: ['Nothing durable'] },
        { id: 'cdb', label: 'Comments DB', sub: 'Rows and outbox', kind: 'db', x: 830, y: 420, latency: 8, role: 'Comment rows, suggestion rows, and the outbox table written in the same transaction.', ops: [{ name: 'insert', desc: 'Write a row (and outbox event).' }, { name: 'update', desc: 'Resolve or accept.' }], owns: ['comments', 'suggestions', 'outbox'] },
        { id: 'broker', label: 'Notification queue', sub: 'Mention events', kind: 'queue', x: 830, y: 240, latency: 3, role: 'Carries mention events to the notifier. May duplicate.', owns: ['events'] },
        { id: 'notifier', label: 'Notification worker', sub: 'Dedupes by event id', kind: 'worker', x: 1060, y: 240, latency: 4, role: 'Turns a mention event into exactly one notification, remembering event ids it has handled.', owns: ['processed ids'] },
        { id: 'push', label: 'Push provider', sub: 'APNs and FCM', kind: 'service', x: 1060, y: 80, latency: 40, role: 'Delivers to the phone. When down, the in-app inbox still gets the notification.', ops: [{ name: 'send', desc: 'Push.' }], owns: ['Device tokens'] },
        { id: 'pubsub', label: 'Pub/sub', sub: 'Document channel', kind: 'queue', x: 330, y: 500, latency: 3, role: 'Broadcasts operations and anchor updates to the phones.', owns: ['Channel'] },
      ],
      edges: [
        { from: 'ana', to: 'gw', latency: 30 }, { from: 'ben', to: 'gw', latency: 30 }, { from: 'cho', to: 'gw', latency: 30 },
        { from: 'gw', to: 'session', latency: 3 }, { from: 'gw', to: 'comments', latency: 3 },
        { from: 'session', to: 'pubsub', latency: 3, via: [[460, 240], [460, 500]] }, { from: 'session', to: 'comments', latency: 3 },
        { from: 'comments', to: 'cdb', latency: 4 }, { from: 'comments', to: 'broker', latency: 3, via: [[700, 330]] }, { from: 'comments', to: 'session', latency: 3 },
        { from: 'cdb', to: 'broker', latency: 3, label: 'relay' }, { from: 'broker', to: 'notifier', latency: 3 }, { from: 'notifier', to: 'push', latency: 5 },
        { from: 'push', to: 'ben', latency: 40, via: [[1060, 20], [200, 20], [200, 260]] }, { from: 'pubsub', to: 'gw', latency: 3 },
      ],
      queues: [
        { id: 'bcast', broker: 'pubsub', label: 'Document channel', groups: ['gw'] },
        { id: 'outbox', broker: 'cdb', label: 'Outbox table', groups: ['relay'] },
        { id: 'mentions', broker: 'broker', label: 'Mention events', groups: ['notifier'] },
      ],
    },
    failures: [
      { id: 'comments-down', node: 'comments', mode: 'down', label: 'Comments service down', desc: 'No comments can be posted or resolved; editing continues.' },
      { id: 'skip-anchors', node: 'session', mode: 'skipAnchors', label: 'Anchor update lost', desc: 'A bug: the session commits an operation without moving the anchors.' },
      { id: 'queue-down', node: 'broker', mode: 'down', label: 'Notification queue down', desc: 'Mention events cannot be published. With an outbox they wait; without it they are lost.' },
      { id: 'queue-dup', node: 'broker', mode: 'duplicate', label: 'Queue duplicates events', desc: 'Every mention event is delivered twice.' },
      { id: 'notifier-paused', node: 'notifier', mode: 'paused', label: 'Notification worker paused', desc: 'Events wait in the queue.' },
      { id: 'push-down', node: 'push', mode: 'down', label: 'Push provider down', desc: 'No push; the in-app inbox still gets it.' },
    ],
    switches: Y.switches([
      ['anchorsInSession', 'Transform anchors in the session', 'Each committed operation moves every open anchor. Off: anchors are fixed character offsets.'],
      ['outbox', 'Mention events through an outbox', 'The event row is written in the same transaction as the comment and relayed to the queue. Off: publish to the queue after the write.'],
      ['dedupe', 'Deduplicate notifications by event id', 'The worker remembers event ids it has handled. Off: every delivery becomes a notification.'],
    ]),
    presets: Y.presets({ anchorsInSession: true, outbox: true, dedupe: true }, [
      { id: 'shift', label: 'Comment, then insert above it', desc: 'Cho comments on “ship the editor”. Ben types at the start of the sentence. The anchor moves with the text and the margin still highlights the right words.', run: (s) => { startComment(s, 'Too vague?'); s.schedule(900, () => startType(s, 'start')); s.schedule(1700, () => startType(s)); } },
      { id: 'fixed', label: 'Same, with fixed offsets', desc: 'Anchors are stored as character positions and never moved. After Ben’s insert the comment highlights “: ship the edit” instead of the phrase Cho commented on.', sw: { anchorsInSession: false }, run: (s) => { startComment(s, 'Too vague?'); s.schedule(900, () => startType(s, 'start')); s.schedule(1700, () => startType(s)); } },
      { id: 'lost-update', label: 'Anchor update lost once', desc: 'A bug skips the anchor transform for one commit. The highlight drifts by the length of that insert and stays wrong for ever after.', run: (s) => { startComment(s, 'Too vague?'); s.schedule(800, () => s.inject('session', 'skipAnchors', true, 400)); s.schedule(900, () => startType(s, 'start')); s.schedule(1700, () => startType(s)); } },
      { id: 'orphan', label: 'Delete the commented text', desc: 'Ben deletes the phrase under the comment. The anchor collapses to a point and the comment is shown as “text deleted”, not dropped and not re-attached to neighbouring words.', run: (s) => { startComment(s, 'Too vague?'); s.schedule(900, () => startType(s, 'delRange')); } },
      { id: 'resolve', label: 'Resolve a comment', desc: 'Ana resolves Cho’s comment: it leaves the margin and stays in the thread history.', run: (s) => { startComment(s, 'Too vague?'); s.schedule(900, () => startResolve(s, 'c1')); } },
      { id: 'mention', label: 'Mention Ben, outbox', desc: 'Cho mentions Ben. The comment row and the mention event are one transaction; the relay publishes it and Ben gets exactly one notification.', run: (s) => { startComment(s, '@Ben can you own this?', true); } },
      { id: 'mention-bad', label: 'Mention Ben, queue down, no outbox', desc: 'The comment is written, then the publish to the queue fails. The comment exists; the mention never reaches Ben, and nothing will retry it.', sw: { outbox: false }, run: (s) => { s.inject('broker', 'down', true, 1500); startComment(s, '@Ben can you own this?', true); } },
      { id: 'mention-outbox-down', label: 'Mention Ben, queue down, outbox', desc: 'Same outage. The event waits in the outbox table and is relayed when the queue returns: one notification, late.', run: (s) => { s.inject('broker', 'down', true, 1500); startComment(s, '@Ben can you own this?', true); } },
      { id: 'dup', label: 'Queue duplicates, deduplicated', desc: 'The event is delivered twice. The worker has seen the id and skips the second: one notification.', run: (s) => { s.inject('broker', 'duplicate'); startComment(s, '@Ben can you own this?', true); } },
      { id: 'dup-bad', label: 'Queue duplicates, no dedupe', desc: 'Two deliveries, two notifications: Ben is pinged twice for one mention.', sw: { dedupe: false }, run: (s) => { s.inject('broker', 'duplicate'); startComment(s, '@Ben can you own this?', true); } },
      { id: 'suggest', label: 'Suggest, edit above, accept', desc: 'Cho suggests “ (v2)” after “editor”. Ben types at the start. Ana accepts: the suggestion is transformed to the current text and lands after “editor”, not where it was.', run: (s) => { startSuggest(s); s.schedule(900, () => startType(s, 'start')); s.schedule(1800, () => startAccept(s, 's1')); } },
      { id: 'suggest-deleted', label: 'Suggest, delete the text, accept', desc: 'Ben deletes the phrase the suggestion was anchored to. Accepting is refused with a clear reason instead of inserting “ (v2)” into unrelated text.', run: (s) => { startSuggest(s); s.schedule(900, () => startType(s, 'delRange')); s.schedule(1800, () => startAccept(s, 's1')); } },
      { id: 'push-down', label: 'Mention with push down', desc: 'The notification is created and lands in Ben’s in-app inbox; only the phone banner is missing.', run: (s) => { s.inject('push', 'down'); startComment(s, '@Ben can you own this?', true); } },
    ]),
    initialState: () => ({
      config: { anchorsInSession: true, outbox: true, dedupe: true },
      doc: { text: DOC0, rev: 0 }, log: [], busy: false, comments: {}, suggestions: {}, seq: { client: 0, comment: 0, suggestion: 0, event: 0 },
      notifications: [], processed: {}, lostEvents: 0,
      stats: { ops: 0, anchorsMoved: 0, orphaned: 0, notified: 0, dupSkipped: 0, pushes: 0, accepted: 0, refusedAccepts: 0 },
    }),
    initialUI: () => ({ ana: { text: DOC0, rev: 0 }, ben: { text: DOC0, rev: 0, pending: null, typed: 0, inbox: [], banner: null }, cho: { error: null } }),
    actions: {
      type(sim, a) { startType(sim, a.kind); },
      comment(sim, a) { startComment(sim, a.mention ? '@Ben can you own this?' : 'Too vague?', !!a.mention); },
      resolve(sim, a) { startResolve(sim, a.id); },
      suggest(sim) { startSuggest(sim); },
      accept(sim, a) { startAccept(sim, a.id); },
    },
    setup(sim) {
      Y.consumer(sim, 'bcast', 'gw', 'gw', function* (ctx, msg) { const row = msg.payload; for (const who of ['ana', 'ben']) { const u = ctx.ui[who]; if (row.rev <= u.rev) continue; u.rev = row.rev; if (row.who === who) continue; let op = row.op; if (u.pending) { const mine = u.pending; u.pending = OT.transform(mine, op, false); op = OT.transform(op, mine, true); } u.text = OT.apply(u.text, op); } return true; }, () => false);
      Y.relay(sim, 'outbox', 'relay', 'cdb', 'mentions');
      Y.consumer(sim, 'mentions', 'notifier', 'notifier', function* (ctx, msg) {
        const st = ctx.state;
        const ev = msg.payload;
        st.stats.notified++;
        st.notifications.push({ eventId: msg.eventId, to: ev.to, text: ev.text, t: ctx.now() });
        ctx.ui.ben.inbox.push({ text: ev.text, t: ctx.now() });
        const p = yield ctx.call('push', 'send', { to: ev.to, text: ev.text }, { timeout: 800 });
        if (p.ok) st.stats.pushes++;
        return true;
      }, (s) => s.state.config.dedupe);
    },
    handlers: {
      gw: {
        submit: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'submit', p, { timeout: 1300 })); },
        comment: function* (ctx, p) { return ctx.must(yield ctx.call('comments', 'create', p, { timeout: 1600 })); },
        resolve: function* (ctx, p) { return ctx.must(yield ctx.call('comments', 'resolve', p, { timeout: 1300 })); },
        suggest: function* (ctx, p) { return ctx.must(yield ctx.call('comments', 'suggest', p, { timeout: 1600 })); },
        accept: function* (ctx, p) { return ctx.must(yield ctx.call('comments', 'accept', p, { timeout: 1600 })); },
      },
      session: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          while (st.busy) yield ctx.wait(5);
          st.busy = true;
          try { return yield* commit(ctx, p.op, p.who, p.baseRev); } finally { st.busy = false; }
        },
        apply: function* (ctx, p) {
          const st = ctx.state;
          while (st.busy) yield ctx.wait(5);
          st.busy = true;
          try { return yield* commit(ctx, p.op, p.who, p.baseRev); } finally { st.busy = false; }
        },
      },
      comments: {
        create: function* (ctx, p) {
          const st = ctx.state;
          const id = 'c' + ++st.seq.comment;
          const row = { id, start: p.start, end: p.end, rev: p.rev, text: p.text, by: p.by, quoted: st.doc.text.slice(p.start, p.end), resolved: false, orphaned: false };
          const ev = p.mention ? { eventId: 'ev' + ++st.seq.event, to: p.mention, text: `${PEOPLE[p.by]} mentioned you: “${p.text}”` } : null;
          ctx.must(yield ctx.call('cdb', 'insert', { kind: 'comment', row, outbox: st.config.outbox ? ev : null }, { timeout: 900 }));
          if (ev && !st.config.outbox) {
            const pub = yield ctx.call('broker', 'publish', ev, { timeout: 600 });
            if (!pub.ok) { st.lostEvents++; ctx.log({ op: `mention event ${ev.eventId} lost`, status: 'err', detail: 'The comment row was committed; the publish that followed failed. Nothing records that a notification is owed.' }); }
          }
          return { id, start: row.start, end: row.end, rev: row.rev };
        },
        resolve: function* (ctx, p) { const st = ctx.state; const c = st.comments[p.id]; if (!c) ctx.fail('NOT_FOUND', `No comment ${p.id}.`); ctx.must(yield ctx.call('cdb', 'update', { kind: 'comment', id: p.id, resolved: true }, { timeout: 900 })); return { id: p.id }; },
        suggest: function* (ctx, p) {
          const st = ctx.state;
          const id = 's' + ++st.seq.suggestion;
          const row = { id, op: p.op, start: p.anchor.start, end: p.anchor.end, rev: p.rev, by: p.by, quoted: st.doc.text.slice(p.anchor.start, p.anchor.end), state: 'pending' };
          ctx.must(yield ctx.call('cdb', 'insert', { kind: 'suggestion', row }, { timeout: 900 }));
          return { id, rev: p.rev };
        },
        accept: function* (ctx, p) {
          const st = ctx.state;
          const s = st.suggestions[p.id];
          if (!s) ctx.fail('NOT_FOUND', `No suggestion ${p.id}.`);
          if (s.state === 'accepted') return { id: p.id, rev: s.appliedRev, from: s.rev, replayed: true };
          if (s.orphaned || st.doc.text.slice(s.start, s.end) !== s.quoted) { st.stats.refusedAccepts++; ctx.must(yield ctx.call('cdb', 'update', { kind: 'suggestion', id: p.id, state: 'outdated' }, { timeout: 900 })); ctx.fail('OUTDATED', `The text “${s.quoted}” the suggestion was attached to has been changed or deleted.`); }
          const r = ctx.must(yield ctx.call('session', 'apply', { op: s.op, who: p.who, baseRev: s.rev }, { timeout: 1300 }));
          ctx.must(yield ctx.call('cdb', 'update', { kind: 'suggestion', id: p.id, state: 'accepted', appliedRev: r.rev }, { timeout: 900 }));
          st.stats.accepted++;
          return { id: p.id, rev: r.rev, from: s.rev };
        },
      },
      cdb: {
        insert(ctx, p) {
          const st = ctx.state;
          if (p.kind === 'comment') st.comments[p.row.id] = p.row; else st.suggestions[p.row.id] = p.row;
          if (p.outbox) ctx.sim.enqueue('outbox', { type: 'mention', eventId: p.outbox.eventId, payload: p.outbox });
          return { ok: true };
        },
        update(ctx, p) { const st = ctx.state; const row = p.kind === 'comment' ? st.comments[p.id] : st.suggestions[p.id]; Object.assign(row, p, { kind: undefined, id: row.id }); return { ok: true }; },
      },
      broker: { publish(ctx, ev) { ctx.sim.enqueue('mentions', { type: 'mention', eventId: ev.eventId, payload: ev }); return { ok: true }; } },
      push: { send: function* (ctx, p) { return ctx.must(yield ctx.call(p.to, 'notify', p, { timeout: 600 })); } },
      ana: { push() { return { ok: true }; }, notify() { return { ok: true }; } },
      ben: { push() { return { ok: true }; }, notify(ctx, p) { ctx.ui.ben.banner = { title: 'Q3 plan', body: p.text, tone: 'ok', t: ctx.now() }; return { shown: true }; } },
    },
    consistency(sim) {
      const st = sim.state;
      const open = Object.values(st.comments).filter((c) => !c.resolved);
      const wrongAnchor = open.filter((c) => !c.orphaned && st.doc.text.slice(c.start, c.end) !== c.quoted);
      if (wrongAnchor.length) return { key: 'wrong', label: `Comment ${wrongAnchor[0].id} highlights “${st.doc.text.slice(wrongAnchor[0].start, wrongAnchor[0].end)}” but was written about “${wrongAnchor[0].quoted}”. ${st.config.anchorsInSession ? 'An anchor update was lost and nothing will correct it.' : 'Fixed offsets do not follow the text.'}` };
      if (st.lostEvents) return { key: 'wrong', label: `${st.lostEvents} mention event${st.lostEvents > 1 ? 's were' : ' was'} lost after the comment was committed: Ben will never be notified, and no record says he should have been.` };
      const byEvent = {};
      for (const n of st.notifications) byEvent[n.eventId] = (byEvent[n.eventId] || 0) + 1;
      const dup = Object.entries(byEvent).find(([, n]) => n > 1);
      if (dup) return { key: 'wrong', label: `Ben was notified ${dup[1]} times for one mention (${dup[0]}): the duplicate delivery was not recognised.` };
      const owed = sim.queueStats('outbox').depth + sim.queueStats('mentions').depth;
      if (owed) return { key: 'stale', label: `${owed} mention event${owed > 1 ? 's are' : ' is'} waiting ${sim.queueStats('outbox').depth ? 'in the outbox for the queue to return' : 'for the notification worker'}. Late, but not lost.` };
      if (sim.nodes.comments.modes.down) return { key: 'stale', label: 'The comments service is down: no new comments or suggestions, but editing and existing anchors keep working.' };
      if (sim.nodes.push.modes.down && st.notifications.length) return { key: 'stale', label: 'Push is down: the mention is in Ben’s in-app inbox but no banner reached his phone.' };
      if (sim.ui.ben.pending) return { key: 'stale', label: 'An edit is in flight.' };
      const orphans = open.filter((c) => c.orphaned).length;
      return { key: 'ok', label: `${open.length} open comment${open.length === 1 ? '' : 's'}, every anchor on the text it was written about${orphans ? ` (${orphans} marked as deleted text)` : ''}; ${st.notifications.length} notification${st.notifications.length === 1 ? '' : 's'} for ${Object.keys(byEvent).length} mention${Object.keys(byEvent).length === 1 ? '' : 's'}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      return [
        { label: 'Revision', value: st.doc.rev },
        { label: 'Open comments (orphaned)', value: `${Object.values(st.comments).filter((c) => !c.resolved).length} (${Object.values(st.comments).filter((c) => c.orphaned).length})` },
        { label: 'Anchors transformed', value: st.stats.anchorsMoved },
        { label: 'Misanchored comments', value: Object.values(st.comments).filter((c) => !c.resolved && !c.orphaned && st.doc.text.slice(c.start, c.end) !== c.quoted).length, tone: Object.values(st.comments).some((c) => !c.resolved && !c.orphaned && st.doc.text.slice(c.start, c.end) !== c.quoted) ? 'fail' : 'ok' },
        { label: 'Notifications (pushes)', value: `${st.notifications.length} (${st.stats.pushes})` },
        { label: 'Duplicates skipped', value: st.dupSkipped || 0 },
        { label: 'Mention events lost', value: st.lostEvents, tone: st.lostEvents ? 'fail' : 'ok' },
        { label: 'Suggestions accepted (refused)', value: `${st.stats.accepted} (${st.stats.refusedAccepts})` },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['ana', 'Ana'], ['ben', 'Ben']], {
          note: 'Ana sees the comment margin and accepts suggestions. Ben edits the text under it and receives mentions. Cho, in the console, comments and suggests.',
          below: '<div class="ops-console"><p class="ops-title">Cho’s browser · commenter</p><div data-ref="cho"></div></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const open = Object.values(st.comments).filter((c) => !c.resolved);
        const hl = (text) => {
          const c = open.find((x) => !x.orphaned);
          if (!c || c.end > text.length) return esc(text);
          return esc(text.slice(0, c.start)) + `<mark class="doc-mark">${esc(text.slice(c.start, c.end))}</mark>` + esc(text.slice(c.end));
        };
        const margin = open.map((c) => `<div class="app-card ${c.orphaned ? 'is-hot' : ''}"><span class="app-sub">${esc(PEOPLE[c.by])} on “${esc(c.quoted)}”${c.orphaned ? ' · text deleted' : ''}</span><strong>${esc(c.text)}</strong><div class="app-row">${Y.btn('resolve', 'Resolve', { arg: { id: c.id }, cls: 'secondary' })}</div></div>`).join('');
        const sugg = Object.values(st.suggestions).filter((s) => s.state === 'pending').map((s) => `<div class="app-card"><span class="app-sub">Suggestion by ${esc(PEOPLE[s.by])} after “${esc(s.quoted)}”</span><strong>insert “${esc(s.op.ins)}”</strong><div class="app-row">${Y.btn('accept', 'Accept', { arg: { id: s.id }, cls: 'go' })}</div></div>`).join('');
        Y.paint(el, sim, 'ana', {
          head: `<div><p class="app-title">Q3 plan</p><p class="app-sub">Owner · ${open.length} open comment${open.length === 1 ? '' : 's'}</p></div>`,
          doc: `<div class="app-card doc-page"><p class="doc-text">${hl(st.doc.text)}</p><span class="app-sub doc-chip" data-tone="ok">rev ${st.doc.rev}</span></div>`,
          margin: margin + sugg || '<p class="app-sub">No open comments or suggestions.</p>',
        }, {}, null);
        const b = sim.ui.ben;
        Y.paint(el, sim, 'ben', {
          head: `<div><p class="app-title">Q3 plan</p><p class="app-sub">Editor · ${b.inbox.length} notification${b.inbox.length === 1 ? '' : 's'}</p></div>`,
          doc: `<div class="app-card doc-page"><p class="doc-text">${hl(b.text)}<span class="doc-caret"></span></p><span class="app-sub doc-chip" data-tone="${b.pending ? 'work' : 'ok'}">${b.pending ? 'Saving…' : `Saved · rev ${b.rev}`}</span></div>`,
          keys: `<div class="app-row">${Y.btn('type', 'Type “Draft: ” at the start', { arg: { kind: 'start' }, cls: 'go' })}${Y.btn('type', `Type “${esc(WORDS.ben[b.typed % WORDS.ben.length].trim())}”`, { arg: { kind: 'end' }, cls: 'secondary' })}</div><div class="app-row">${Y.btn('type', 'Delete “ship the editor”', { arg: { kind: 'delRange' }, cls: 'secondary' })}</div>`,
          inbox: b.inbox.length ? `<div class="app-card"><strong>Notifications</strong>${b.inbox.map((n) => `<span class="app-sub">${esc(n.text)}</span>`).join('')}</div>` : '',
        }, {}, b.banner);
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="cho"]'), {
          keys: `<div class="app-row">${Y.btn('comment', 'Comment on “ship the editor”', { cls: 'secondary' })}${Y.btn('comment', 'Comment and mention Ben', { arg: { mention: true }, cls: 'secondary' })}${Y.btn('suggest', 'Suggest “ (v2)” after “editor”', { cls: 'secondary' })}</div>${sim.ui.cho.error ? Y.msg(sim.ui.cho.error, 'fail') : ''}`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };

  function* commit(ctx, op0, who, baseRev) {
    const st = ctx.state;
    let op = op0;
    for (const r of st.log.filter((x) => x.rev > baseRev)) op = OT.transform(op, r.op, false);
    const rev = st.doc.rev + 1;
    const row = { rev, op, who };
    st.doc.rev = rev; st.doc.text = OT.apply(st.doc.text, op); st.log.push(row); st.stats.ops++;
    let moved = 0, orphaned = 0;
    if (st.config.anchorsInSession && !ctx.mode('skipAnchors')) {
      for (const c of Object.values(st.comments).concat(Object.values(st.suggestions))) {
        if (c.resolved || c.state === 'accepted' || c.orphaned) continue;
        const a = shiftAnchor(c, op);
        c.start = a.start; c.end = a.end; moved++;
        if (c.end <= c.start) { c.orphaned = true; orphaned++; }
      }
      st.stats.anchorsMoved += moved; st.stats.orphaned += orphaned;
    } else if (ctx.mode('skipAnchors')) ctx.log({ op: 'anchor update skipped', status: 'err', detail: 'The operation committed; the comment anchors were not moved.' });
    ctx.sim.enqueue('bcast', { type: `rev ${rev}`, eventId: `r${rev}`, payload: row });
    return { rev, anchorsMoved: moved, orphaned };
  }
})(typeof window !== 'undefined' ? window : globalThis);
