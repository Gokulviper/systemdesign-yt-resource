/*
 * Permissions, link sharing, and revocation.
 * Every open and every operation is checked against the document’s access
 * list through a cache. Sharing and revoking write the list and push an
 * invalidation to the cache and to the live session, so a revoked viewer’s
 * stream stops at once. Without the push, the cache serves the old answer
 * until its TTL and a revoked viewer keeps receiving edits. When the access
 * service is down the session must choose: refuse everyone (fail closed) or
 * let everyone through (fail open).
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const OT = Y.ot;

  const PEOPLE = { ana: 'Ana', ben: 'Ben', cho: 'Cho' };
  const DOC0 = 'Q3 plan: ship the editor.';
  const WORDS = { ana: [' Hire two.', ' Launch in May.', ' Budget: flat.'], ben: [' Fix sync.', ' Add tests.', ' Ship it.'] };
  const TTL = 6000;
  const canEdit = (role) => role === 'owner' || role === 'editor';
  const canRead = (role) => !!role;

  /** The truth: what the access list says right now, including link access. */
  function trueRole(st, who, viaLink) {
    if (st.acl[who]) return st.acl[who];
    if (viaLink && st.link.enabled) return st.link.role;
    return null;
  }

  /* ---------- editing (Ana, Ben) ---------- */
  function startType(sim, who) {
    const st = sim.state;
    const u = sim.ui[who];
    const word = WORDS[who][u.typed++ % WORDS[who].length];
    const op = { pos: u.text.length, ins: word };
    sim.startAction(`${PEOPLE[who]}: type “${word.trim()}”`, function* (ctx) {
      u.text = OT.apply(u.text, op);
      u.pending = op;
      u.status = 'saving';
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('gw', 'submit', { clientId: `${who}-${++st.seq.client}`, baseRev: u.rev, op, who }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = null;
      if (r.ok) { u.rev = Math.max(u.rev, r.value.rev); u.status = 'saved'; Y.L(ctx, { accepted: ['yes', `Checked: ${r.value.role} (${r.value.via}).`], committed: 'yes', async: 'pending' }); ctx.explain(`${PEOPLE[who]}’s edit passed the access check (${r.value.role}, ${r.value.via}) and became revision ${r.value.rev}.`); }
      else {
        u.text = OT.apply(u.text, { pos: op.pos, del: op.ins.length });
        u.status = r.error.code === 'FORBIDDEN' ? 'readonly' : 'unsaved';
        u.error = r.error.message;
        Y.L(ctx, { displayed: ['no', 'Reverted on the phone.'], accepted: ['no', r.error.message], committed: 'no', async: 'n/a' });
        ctx.explain(r.error.code === 'FORBIDDEN' ? `${PEOPLE[who]}’s edit was refused: ${r.error.message} The phone reverted it and switched to read-only.` : `The edit could not be checked: ${r.error.message} ${st.config.failClosed ? 'Fail closed: refused and reverted; the document is read-only until access can be verified.' : ''}`);
      }
    }, { self: who });
  }

  /* ---------- Cho: open and stream ---------- */
  function startOpen(sim, who, viaLink) {
    const st = sim.state;
    const u = sim.ui[who];
    sim.startAction(`${PEOPLE[who]}: open the document${viaLink ? ' via the link' : ''}`, function* (ctx) {
      Y.L(ctx, { retrySafe: 'yes', committed: 'n/a', async: 'n/a' });
      const r = yield ctx.call('gw', 'open', { who, viaLink: !!viaLink }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      if (!r.ok) { u.open = false; u.error = r.error.message; Y.failed(ctx, 'Access denied or unavailable.'); ctx.explain(r.error.code === 'FORBIDDEN' ? `${PEOPLE[who]} cannot open the document: ${r.error.message}` : `Open failed: ${r.error.message}${st.config.failClosed ? ' Fail closed: nobody gets in while access cannot be checked.' : ''}`); return; }
      u.open = true; u.text = r.value.text; u.rev = r.value.rev; u.role = r.value.role; u.error = null; u.viaLink = !!viaLink;
      if (!canRead(trueRole(st, who, viaLink))) { st.leaks.push({ who, what: 'open', via: r.value.via, t: ctx.now() }); }
      Y.L(ctx, { displayed: 'yes', accepted: ['yes', `${r.value.role} via ${r.value.via}.`] });
      ctx.explain(st.leaks.length && !canRead(trueRole(st, who, viaLink)) ? `${PEOPLE[who]} opened a document ${who === 'cho' ? 'she' : 'he'} has no access to: ${r.value.via === 'fail open' ? 'the access service was down and the session failed open.' : 'the cache still held the old role because the invalidation was dropped.'}` : `${PEOPLE[who]} opened the document as ${r.value.role} (${r.value.via}) and now receives every operation.`);
    }, { self: who });
  }

  /* ---------- Ana: share, revoke, link ---------- */
  function startShare(sim, target, role) {
    const st = sim.state;
    const label = role ? `Ana: ${st.acl[target] ? 'change' : 'share with'} ${PEOPLE[target]} as ${role}` : `Ana: remove ${PEOPLE[target]}’s access`;
    sim.startAction(label, function* (ctx) {
      Y.L(ctx, { retrySafe: ['yes', 'Setting a role is idempotent.'] });
      const r = yield ctx.call('gw', 'share', { target, role, by: 'ana' }, { timeout: 1800 });
      if (!r.ok) { Y.failed(ctx, 'The share sheet shows an error.'); ctx.explain(`Sharing failed: ${r.error.message} Nothing changed, and Ana was told.`); return; }
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'yes', async: [r.value.invalidated ? 'yes' : 'pending', r.value.invalidated ? 'Cache and session invalidated.' : 'No invalidation: the cache keeps the old answer until its TTL.'] });
      ctx.explain(role ? `${PEOPLE[target]} is now ${role}. ${r.value.invalidated ? 'The cache entry was invalidated and the live session told, so the change applies to the very next operation.' : 'The cache was not told; it serves the old answer for up to ' + TTL / 1000 + ' s.'}` : `${PEOPLE[target]}’s access was removed. ${r.value.invalidated ? `The cache entry was invalidated and the session dropped ${PEOPLE[target]}’s subscription at once.` : `Nothing told the cache or the session: ${PEOPLE[target]} keeps the old answer until the TTL expires.`}`);
    }, { self: 'ana' });
  }
  function startLink(sim, enabled) {
    sim.startAction(enabled ? 'Ana: turn on “anyone with the link can view”' : 'Ana: turn the link off', function* (ctx) {
      Y.L(ctx, { retrySafe: 'yes' });
      const r = yield ctx.call('gw', 'link', { enabled, by: 'ana' }, { timeout: 1800 });
      if (!r.ok) { Y.failed(ctx); ctx.explain(`Link setting failed: ${r.error.message}`); return; }
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'yes', async: r.value.invalidated ? 'yes' : 'pending' });
      ctx.explain(enabled ? 'The link token is live: anyone presenting it is a viewer. Link access is checked like any other role, on every operation.' : `The link token was revoked${r.value.invalidated ? ' and every link viewer’s subscription was dropped' : ''}. Opening with the old link now fails.`);
    }, { self: 'ana' });
  }

  SDL.scenarios['docs-sharing'] = {
    id: 'docs-sharing',
    seed: 707,
    productWidth: 640,
    intro: 'Share the document with Cho, let her open it, then remove her access while Ana types. Try it with push invalidation off, and take the access service down under each failure policy.',
    modeLabels: { lostInvalidation: 'Dropping invalidations' },
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'ana', label: 'Ana’s phone', sub: 'Owner', kind: 'client', x: 90, y: 90, latency: 1, role: 'Edits and manages sharing.', ops: [{ name: 'push', desc: 'A remote operation.' }], owns: ['Local copy'] },
        { id: 'ben', label: 'Ben’s phone', sub: 'Editor', kind: 'client', x: 90, y: 300, latency: 1, role: 'Edits. Can be downgraded mid-session.', ops: [{ name: 'push', desc: 'A remote operation.' }], owns: ['Local copy'] },
        { id: 'cho', label: 'Cho’s browser', sub: 'Viewer or nobody', kind: 'client', x: 90, y: 510, latency: 1, role: 'Opens the document when invited or with a link, and streams operations while allowed.', ops: [{ name: 'push', desc: 'A remote operation.' }, { name: 'drop', desc: 'Subscription ended.' }], owns: ['Local copy'] },
        { id: 'gw', label: 'Gateway', sub: 'Sockets and API', kind: 'gateway', x: 330, y: 300, latency: 2, role: 'Routes edits and opens to the session, sharing calls to the access service.', ops: [{ name: 'submit', desc: 'An operation.' }, { name: 'open', desc: 'Open and subscribe.' }, { name: 'share', desc: 'Change a role.' }, { name: 'link', desc: 'Link sharing on or off.' }], owns: ['Sockets'] },
        { id: 'session', label: 'Document session', sub: 'Checks access on every op', kind: 'service', x: 580, y: 300, latency: 4, role: 'Asks the access service before committing an operation or adding a subscriber, and drops subscribers when told their access ended.', ops: [{ name: 'submit', desc: 'Check, commit, broadcast.' }, { name: 'open', desc: 'Check and subscribe.' }, { name: 'revoked', desc: 'Drop a subscriber.' }], owns: ['Subscribers and their roles'] },
        { id: 'acl', label: 'Access service', sub: 'Who may do what', kind: 'service', x: 830, y: 120, latency: 3, role: 'Answers “may this person do this?” from the cache, falling back to the metadata DB. Writes roles and pushes invalidations.', ops: [{ name: 'check', desc: 'Role for a user.' }, { name: 'set', desc: 'Write a role.' }, { name: 'link', desc: 'Set link access.' }], owns: ['Nothing durable'] },
        { id: 'aclcache', label: 'Access cache', sub: `TTL ${TTL / 1000} s`, kind: 'cache', x: 1060, y: 40, latency: 2, role: 'Caches roles per (document, user). Entries live until invalidated or expired.', ops: [{ name: 'get', desc: 'Cached role.' }, { name: 'set', desc: 'Cache a role.' }, { name: 'invalidate', desc: 'Drop an entry.' }], owns: ['role[doc][user], expiry'] },
        { id: 'meta', label: 'Metadata DB', sub: 'Access list', kind: 'db', x: 1060, y: 200, latency: 8, role: 'The access list and link token: the truth.', ops: [{ name: 'read', desc: 'Roles.' }, { name: 'write', desc: 'Set a role.' }], owns: ['acl[doc]', 'link[doc]'] },
        { id: 'links', label: 'Link service', sub: 'Tokens', kind: 'service', x: 830, y: 470, latency: 4, role: 'Issues and revokes “anyone with the link” tokens.', ops: [{ name: 'set', desc: 'Enable or revoke.' }, { name: 'verify', desc: 'Is this token live?' }], owns: ['token[doc]'] },
        { id: 'audit', label: 'Audit log', sub: 'Who shared what', kind: 'db', x: 1060, y: 470, latency: 20, role: 'Append-only record of sharing changes and opens. Written asynchronously; never on the hot path.', ops: [{ name: 'append', desc: 'Record an event.' }], owns: ['audit rows'] },
        { id: 'oplog', label: 'Operation log', sub: 'Revisions', kind: 'db', x: 830, y: 300, latency: 8, role: 'One row per revision.', ops: [{ name: 'append', desc: 'Write.' }], owns: ['log[rev]'] },
        { id: 'pubsub', label: 'Pub/sub', sub: 'Document channel', kind: 'queue', x: 580, y: 510, latency: 3, role: 'Broadcasts operations to the gateway, which delivers only to current subscribers.', owns: ['Channel'] },
      ],
      edges: [
        { from: 'ana', to: 'gw', latency: 30 }, { from: 'ben', to: 'gw', latency: 30 }, { from: 'cho', to: 'gw', latency: 30 },
        { from: 'gw', to: 'session', latency: 3 }, { from: 'gw', to: 'acl', latency: 3, via: [[450, 120]] },
        { from: 'session', to: 'acl', latency: 3 }, { from: 'session', to: 'oplog', latency: 4 }, { from: 'session', to: 'pubsub', latency: 3 },
        { from: 'acl', to: 'aclcache', latency: 2 }, { from: 'acl', to: 'meta', latency: 4 }, { from: 'acl', to: 'links', latency: 3, via: [[760, 300]] }, { from: 'acl', to: 'audit', latency: 4, via: [[950, 300]] },
        { from: 'pubsub', to: 'gw', latency: 3, via: [[330, 510]] },
      ],
      queues: [{ id: 'bcast', broker: 'pubsub', label: 'Document channel', groups: ['gw'] }],
    },
    failures: [
      { id: 'acl-down', node: 'acl', mode: 'down', label: 'Access service down', desc: 'No check can be answered. The failure policy decides what happens.' },
      { id: 'cache-lost', node: 'aclcache', mode: 'lostInvalidation', label: 'Cache drops invalidations', desc: 'Writes succeed but the cache keeps the old role until its TTL.' },
      { id: 'meta-down', node: 'meta', mode: 'down', label: 'Metadata DB down', desc: 'Roles cannot be changed; cached checks still work.' },
      { id: 'links-down', node: 'links', mode: 'down', label: 'Link service down', desc: 'Link tokens cannot be issued or verified.' },
      { id: 'audit-slow', node: 'audit', mode: 'slow', params: { factor: 40 }, label: 'Audit log slow', desc: 'Should change nothing the user can feel.' },
    ],
    switches: Y.switches([
      ['failClosed', 'Fail closed when access cannot be checked', 'Refuse the operation or open. Off: let it through.'],
      ['pushInvalidate', 'Push invalidation on role changes', 'A share or revoke invalidates the cache entry and tells the live session. Off: rely on the cache TTL.'],
      ['perOp', 'Check access on every operation', 'The session asks the access service for each operation. Off: it trusts the role it saw when the socket opened.'],
    ]),
    presets: Y.presets({ failClosed: true, pushInvalidate: true, perOp: true }, [
      { id: 'share', label: 'Share with Cho, she watches', desc: 'Ana makes Cho a viewer. Cho opens the document and receives Ana’s edits as they happen.', run: (s) => { startShare(s, 'cho', 'viewer'); s.schedule(800, () => startOpen(s, 'cho')); s.schedule(1600, () => startType(s, 'ana')); } },
      { id: 'revoke', label: 'Revoke with push invalidation', desc: 'Cho is watching. Ana removes her access; the cache entry is invalidated and the session drops her subscription. Ana’s next edit never reaches her.', run: (s) => { startShare(s, 'cho', 'viewer'); s.schedule(800, () => startOpen(s, 'cho')); s.schedule(1600, () => startShare(s, 'cho', null)); s.schedule(2400, () => startType(s, 'ana')); s.schedule(3200, () => startOpen(s, 'cho')); } },
      { id: 'revoke-ttl', label: 'Revoke, TTL only', desc: 'Same revoke, but nothing tells the cache or the session. Cho keeps receiving Ana’s edits for up to six seconds after she was removed.', sw: { pushInvalidate: false }, run: (s) => { startShare(s, 'cho', 'viewer'); s.schedule(800, () => startOpen(s, 'cho')); s.schedule(1600, () => startShare(s, 'cho', null)); s.schedule(2400, () => startType(s, 'ana')); } },
      { id: 'acl-down-closed', label: 'Access service down, fail closed', desc: 'Checks cannot be answered, so the session refuses edits and opens. Ana’s own edit is reverted and the document goes read-only until the service returns.', run: (s) => { s.schedule(300, () => s.inject('acl', 'down')); s.schedule(600, () => startType(s, 'ana')); s.schedule(1400, () => startOpen(s, 'cho')); } },
      { id: 'acl-down-open', label: 'Access service down, fail open', desc: 'Checks cannot be answered, so the session lets everything through. Cho, who was never given access, opens the document.', sw: { failClosed: false }, run: (s) => { s.schedule(300, () => s.inject('acl', 'down')); s.schedule(600, () => startType(s, 'ana')); s.schedule(1400, () => startOpen(s, 'cho')); } },
      { id: 'link', label: 'Anyone with the link, then off', desc: 'Ana turns on link sharing; Cho opens with the link and watches. Ana turns it off: Cho’s stream stops and reopening fails.', run: (s) => { startLink(s, true); s.schedule(800, () => startOpen(s, 'cho', true)); s.schedule(1600, () => startType(s, 'ana')); s.schedule(2600, () => startLink(s, false)); s.schedule(3400, () => startType(s, 'ana')); s.schedule(4200, () => startOpen(s, 'cho', true)); } },
      { id: 'downgrade', label: 'Downgrade Ben while he types', desc: 'Ana makes Ben a commenter. His next operation is refused with a clear message, reverted on his phone, and his screen turns read-only. Nothing he typed before is lost.', run: (s) => { startType(s, 'ben'); s.schedule(900, () => startShare(s, 'ben', 'commenter')); s.schedule(1700, () => startType(s, 'ben')); } },
      { id: 'per-session', label: 'Revoke an editor, checked only at open', desc: 'The session trusts the role it saw when Ben’s socket opened. Ana removes his edit rights; his edits keep being accepted until he reconnects.', sw: { perOp: false }, run: (s) => { startType(s, 'ben'); s.schedule(900, () => startShare(s, 'ben', 'viewer')); s.schedule(1700, () => startType(s, 'ben')); } },
      { id: 'cache-lost', label: 'Invalidation dropped by the cache', desc: 'The revoke is written and pushed, but the cache drops the invalidation. The session dropped Cho’s live subscription, so her stream stops; but she reopens with the stale cached role and is let back in until the TTL expires.', run: (s) => { startShare(s, 'cho', 'viewer'); s.schedule(800, () => startOpen(s, 'cho')); s.schedule(1500, () => s.inject('aclcache', 'lostInvalidation')); s.schedule(1600, () => startShare(s, 'cho', null)); s.schedule(2400, () => startOpen(s, 'cho')); s.schedule(3200, () => startType(s, 'ana')); } },
      { id: 'meta-down', label: 'Metadata DB down during a share', desc: 'The role cannot be written. Ana is told at once; nothing half-applied, cached checks keep working for everyone already in.', run: (s) => { s.inject('meta', 'down'); startShare(s, 'cho', 'viewer'); s.schedule(800, () => startOpen(s, 'cho')); s.schedule(1600, () => startType(s, 'ana')); } },
    ]),
    initialState: () => ({
      config: { failClosed: true, pushInvalidate: true, perOp: true },
      acl: { ana: 'owner', ben: 'editor' }, revokedAt: {}, link: { enabled: false, role: 'viewer', token: null }, cache: { ana: { role: 'owner', until: TTL }, ben: { role: 'editor', until: TTL } }, subscribers: { ana: { role: 'owner', viaLink: false }, ben: { role: 'editor', viaLink: false } },
      doc: { text: DOC0, rev: 0 }, log: [], byClient: {}, busy: false, leaks: [], audit: [], seq: { client: 0, token: 0 },
      stats: { checks: 0, hits: 0, misses: 0, refused: 0, invalidations: 0, dropped: 0, delivered: 0, openFailOpen: 0 },
    }),
    initialUI: () => ({
      ana: { text: DOC0, rev: 0, pending: null, status: 'saved', typed: 0, error: null },
      ben: { text: DOC0, rev: 0, pending: null, status: 'saved', typed: 0, error: null },
      cho: { text: '', rev: 0, open: false, role: null, error: null, viaLink: false, received: 0 },
    }),
    actions: {
      type(sim, a) { startType(sim, a.who); },
      open(sim, a) { startOpen(sim, a.who, a.viaLink); },
      share(sim, a) { startShare(sim, a.target, a.role || null); },
      link(sim, a) { startLink(sim, !!a.enabled); },
    },
    setup(sim) {
      Y.consumer(sim, 'bcast', 'gw', 'gw', function* (ctx, msg) {
        const st = ctx.state;
        const row = msg.payload;
        for (const who of Object.keys(st.subscribers)) {
          if (who === row.who) continue;
          const sub = st.subscribers[who];
          const r = yield ctx.call(who, 'push', row, { timeout: 800 });
          if (r.ok) {
            st.stats.delivered++;
            if (!canRead(trueRole(st, who, sub.viaLink))) { st.leaks.push({ who, what: `revision ${row.rev}`, t: ctx.now() }); ctx.log({ op: `revision ${row.rev} delivered to ${PEOPLE[who]}, whose access was revoked`, status: 'err', detail: 'The session still lists the subscription: nothing told it the role changed.' }); }
          }
        }
        return true;
      }, () => false);
      sim.spawn(function* (ctx) { // cache expiry
        for (;;) { yield ctx.wait(250); const st = ctx.state; for (const k of Object.keys(st.cache)) if (st.cache[k].until <= ctx.now()) delete st.cache[k]; }
      }, { self: 'aclcache', quiet: 'all' });
    },
    handlers: {
      gw: {
        submit: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'submit', p, { timeout: 1300 })); },
        open: function* (ctx, p) { return ctx.must(yield ctx.call('session', 'open', p, { timeout: 1300 })); },
        share: function* (ctx, p) { return ctx.must(yield ctx.call('acl', 'set', p, { timeout: 1600 })); },
        link: function* (ctx, p) { return ctx.must(yield ctx.call('acl', 'link', p, { timeout: 1600 })); },
      },
      session: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          const sub = st.subscribers[p.who];
          let role, via;
          if (st.config.perOp || !sub) {
            const c = yield ctx.call('acl', 'check', { who: p.who, viaLink: sub ? sub.viaLink : false }, { timeout: 600 });
            if (!c.ok) { if (st.config.failClosed) { st.stats.refused++; ctx.fail('UNAVAILABLE', 'Access could not be checked.'); } role = sub ? sub.role : 'editor'; via = 'fail open'; }
            else { role = c.value.role; via = c.value.via; }
          } else { role = sub.role; via = 'role cached in the session'; }
          if (!canEdit(role)) { st.stats.refused++; ctx.fail('FORBIDDEN', `${PEOPLE[p.who]} is ${role || 'not on the access list'}; editing needs editor or owner.`); }
          while (st.busy) yield ctx.wait(5);
          st.busy = true;
          try {
            let op = p.op;
            for (const r of st.log.filter((x) => x.rev > p.baseRev)) op = OT.transform(op, r.op, false);
            const rev = st.doc.rev + 1;
            const row = { rev, op, who: p.who, clientId: p.clientId, t: ctx.now() };
            ctx.must(yield ctx.call('oplog', 'append', row, { timeout: 900 }));
            st.doc.rev = rev; st.doc.text = OT.apply(st.doc.text, op); st.log.push(row);
            ctx.sim.enqueue('bcast', { type: `rev ${rev}`, eventId: `r${rev}`, payload: row });
            return { rev, role, via };
          } finally { st.busy = false; }
        },
        open: function* (ctx, p) {
          const st = ctx.state;
          const c = yield ctx.call('acl', 'check', { who: p.who, viaLink: p.viaLink }, { timeout: 600 });
          let role, via;
          if (!c.ok) { if (st.config.failClosed) { st.stats.refused++; ctx.fail('UNAVAILABLE', 'Access could not be checked.'); } role = 'viewer'; via = 'fail open'; st.stats.openFailOpen++; }
          else { role = c.value.role; via = c.value.via; }
          if (!canRead(role)) { st.stats.refused++; ctx.fail('FORBIDDEN', `${PEOPLE[p.who]} is not on the access list${p.viaLink ? ' and the link is off' : ''}.`); }
          st.subscribers[p.who] = { role, viaLink: p.viaLink };
          return { text: st.doc.text, rev: st.doc.rev, role, via };
        },
        revoked: function* (ctx, p) {
          const st = ctx.state;
          for (const who of p.users) if (st.subscribers[who] && who !== 'ana') { delete st.subscribers[who]; st.stats.dropped++; yield ctx.call(who, 'drop', { reason: p.reason }, { timeout: 500, quiet: true }); }
          // A session that checks on every operation refreshes the role; one that only checked at open has no such path.
          if (p.roles && st.config.perOp) for (const [who, role] of Object.entries(p.roles)) if (st.subscribers[who]) st.subscribers[who].role = role;
          return { dropped: p.users.length };
        },
      },
      acl: {
        check: function* (ctx, p) {
          const st = ctx.state;
          st.stats.checks++;
          const key = `${p.who}${p.viaLink ? '+link' : ''}`;
          const g = yield ctx.call('aclcache', 'get', { key }, { timeout: 300 });
          if (g.ok && g.value.found) { st.stats.hits++; return { role: g.value.role, via: 'cache' }; }
          st.stats.misses++;
          const m = ctx.must(yield ctx.call('meta', 'read', {}, { timeout: 600 }));
          let role = m.acl[p.who] || null;
          if (!role && p.viaLink) { const v = yield ctx.call('links', 'verify', {}, { timeout: 600 }); if (v.ok && v.value.live) role = st.link.role; }
          yield ctx.call('aclcache', 'set', { key, role }, { timeout: 300, quiet: true });
          return { role, via: 'metadata DB' };
        },
        set: function* (ctx, p) {
          const st = ctx.state;
          ctx.must(yield ctx.call('meta', 'write', { target: p.target, role: p.role }, { timeout: 900 }));
          ctx.spawn(function* (c) { yield c.call('audit', 'append', { by: p.by, target: p.target, role: p.role }, { timeout: 2000, quiet: true }); st.audit.push(p); });
          let invalidated = false;
          if (st.config.pushInvalidate) {
            st.stats.invalidations++;
            yield ctx.call('aclcache', 'invalidate', { keys: [p.target, `${p.target}+link`] }, { timeout: 400 });
            if (!p.role || !canRead(p.role)) yield ctx.call('session', 'revoked', { users: [p.target], reason: 'access removed' }, { timeout: 600 });
            else yield ctx.call('session', 'revoked', { users: [], roles: { [p.target]: p.role } }, { timeout: 600 });
            invalidated = true;
          }
          return { invalidated };
        },
        link: function* (ctx, p) {
          const st = ctx.state;
          ctx.must(yield ctx.call('links', 'set', { enabled: p.enabled }, { timeout: 900 }));
          ctx.must(yield ctx.call('meta', 'write', { link: p.enabled }, { timeout: 900 }));
          ctx.spawn(function* (c) { yield c.call('audit', 'append', { by: p.by, link: p.enabled }, { timeout: 2000, quiet: true }); });
          let invalidated = false;
          if (st.config.pushInvalidate) {
            st.stats.invalidations++;
            yield ctx.call('aclcache', 'invalidate', { keys: Object.keys(st.cache).filter((k) => /\+link$/.test(k)) }, { timeout: 400 });
            if (!p.enabled) yield ctx.call('session', 'revoked', { users: Object.keys(st.subscribers).filter((w) => st.subscribers[w].viaLink), reason: 'link turned off' }, { timeout: 600 });
            invalidated = true;
          }
          return { invalidated };
        },
      },
      aclcache: {
        get(ctx, p) { const e = ctx.state.cache[p.key]; return e && e.until > ctx.now() ? { found: true, role: e.role } : { found: false }; },
        set(ctx, p) { ctx.state.cache[p.key] = { role: p.role, until: ctx.now() + TTL }; return { ok: true }; },
        invalidate(ctx, p) { if (ctx.mode('lostInvalidation')) { ctx.log({ op: 'invalidation dropped', status: 'err', detail: 'The cache kept the old entries.' }); return { ok: true, dropped: true }; } for (const k of p.keys) delete ctx.state.cache[k]; return { ok: true }; },
      },
      meta: {
        read(ctx) { return { acl: ctx.state.acl, link: ctx.state.link }; },
        write(ctx, p) { const st = ctx.state; if (p.target) { if (!canEdit(p.role) && canEdit(st.acl[p.target])) st.revokedAt[p.target] = ctx.now(); if (p.role) st.acl[p.target] = p.role; else delete st.acl[p.target]; } if (p.link != null) st.link.enabled = p.link; return { ok: true }; },
      },
      links: {
        set(ctx, p) { const st = ctx.state; st.link.enabled = p.enabled; st.link.token = p.enabled ? `t${++st.seq.token}` : null; return { token: st.link.token }; },
        verify(ctx) { return { live: ctx.state.link.enabled }; },
      },
      audit: { append(ctx) { return { ok: true }; } },
      oplog: { append(ctx, row) { return { rev: row.rev }; } },
      ana: { push(ctx, row) { return pushTo(ctx, 'ana', row); } },
      ben: { push(ctx, row) { return pushTo(ctx, 'ben', row); } },
      cho: {
        push(ctx, row) { const u = ctx.ui.cho; if (!u.open) return { applied: false }; u.received++; return pushTo(ctx, 'cho', row); },
        drop(ctx, p) { const u = ctx.ui.cho; u.open = false; u.error = `Access ended: ${p.reason}.`; return { ok: true }; },
      },
    },
    consistency(sim) {
      const st = sim.state;
      if (st.leaks.length) { const l = st.leaks[0]; return { key: 'wrong', label: l.what === 'open' ? `${PEOPLE[l.who]} opened a document ${l.who === 'cho' ? 'she' : 'he'} has no access to: ${l.via === 'fail open' ? 'the access service was down and the session failed open.' : 'the cache served a role that had been revoked, because the invalidation was dropped and only the TTL remained.'}` : `${PEOPLE[l.who]} received ${st.leaks.length} revision${st.leaks.length > 1 ? 's' : ''} after ${l.who === 'cho' ? 'her' : 'his'} access was removed. Revocation that waits for a cache TTL is not revocation.` }; }
      const acceptedAfterRevoke = st.log.filter((r) => st.revokedAt[r.who] != null && r.t > st.revokedAt[r.who]);
      if (acceptedAfterRevoke.length) return { key: 'wrong', label: `${acceptedAfterRevoke.length} edit${acceptedAfterRevoke.length > 1 ? 's were' : ' was'} accepted from ${PEOPLE[acceptedAfterRevoke[0].who]} after ${acceptedAfterRevoke[0].who === 'cho' ? 'her' : 'his'} edit rights were removed: the session trusted the role it saw at open.` };
      if (sim.nodes.acl.modes.down) return { key: 'stale', label: st.config.failClosed ? 'The access service is down and the session fails closed: edits and opens are refused with a clear message until it returns. Nothing leaked, nothing lost.' : 'The access service is down and the session fails open.' };
      const stale = Object.keys(st.cache).filter((k) => { const who = k.replace(/\+link$/, ''); return st.cache[k].role !== trueRole(st, who, /\+link$/.test(k)); });
      if (stale.length) return { key: 'stale', label: `The access cache still holds an old role for ${stale.map((k) => PEOPLE[k.replace(/\+link$/, '')]).join(', ')} until the TTL expires. ${st.subscribers.cho ? '' : 'The live session was told, so no stream leaks; a reopen would succeed with the stale answer.'}` };
      const pending = ['ana', 'ben'].filter((w) => sim.ui[w].pending);
      if (pending.length) return { key: 'stale', label: 'An edit is in flight.' };
      if (sim.ui.cho.open && sim.ui.cho.rev < st.doc.rev) return { key: 'stale', label: 'Cho is behind the latest revision.' };
      return { key: 'ok', label: `Every delivery matched the access list at the time: ${st.stats.delivered} delivered, ${st.stats.refused} refused, ${st.stats.dropped} subscription${st.stats.dropped === 1 ? '' : 's'} dropped on revoke.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      return [
        { label: 'Access checks (cache hits)', value: `${st.stats.checks} (${st.stats.hits})` },
        { label: 'Refused', value: st.stats.refused },
        { label: 'Invalidations pushed', value: st.stats.invalidations },
        { label: 'Subscriptions dropped on revoke', value: st.stats.dropped },
        { label: 'Deliveries to revoked users', value: st.leaks.filter((l) => l.what !== 'open').length, tone: st.leaks.length ? 'fail' : 'ok' },
        { label: 'Unauthorised opens', value: st.leaks.filter((l) => l.what === 'open').length, tone: st.leaks.some((l) => l.what === 'open') ? 'fail' : 'ok' },
        { label: 'Audit rows', value: st.audit.length },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['ana', 'Ana (owner)'], ['ben', 'Ben']], {
          note: 'Ana edits and manages sharing from her phone. Ben edits. Cho, in the console, is outside the document until she is invited or given a link; while she is in, her copy streams every edit.',
          below: '<div class="ops-console"><p class="ops-title">Cho’s browser</p><div data-ref="cho"></div></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const who of ['ana', 'ben']) {
          const u = sim.ui[who];
          const role = st.acl[who] || 'no access';
          const chip = u.status === 'saved' ? ['ok', `Saved · rev ${u.rev}`] : u.status === 'saving' ? ['work', 'Saving…'] : u.status === 'readonly' ? ['fail', 'Read-only'] : ['fail', 'Not saved'];
          const sections = {
            head: `<div><p class="app-title">Q3 plan</p><p class="app-sub">${esc(PEOPLE[who])} · ${esc(role)}</p></div>`,
            doc: `<div class="app-card doc-page"><p class="doc-text">${esc(u.text)}<span class="doc-caret"></span></p><span class="app-sub doc-chip" data-tone="${chip[0]}">${chip[1]}</span></div>`,
            keys: `<div class="app-row">${Y.btn('type', `Type “${esc(WORDS[who][u.typed % WORDS[who].length].trim())}”`, { arg: { who }, cls: 'go' })}</div>${u.error && u.status !== 'saved' ? Y.msg(u.error, 'fail') : ''}`,
          };
          if (who === 'ana') {
            sections.share = `<div class="app-card"><strong>Sharing</strong>
              <div class="app-row">${Y.btn('share', st.acl.cho ? 'Remove Cho' : 'Share with Cho (viewer)', { arg: st.acl.cho ? { target: 'cho' } : { target: 'cho', role: 'viewer' }, cls: 'secondary' })}</div>
              <div class="app-row">${Y.btn('share', st.acl.ben === 'editor' ? 'Make Ben a commenter' : 'Make Ben an editor', { arg: { target: 'ben', role: st.acl.ben === 'editor' ? 'commenter' : 'editor' }, cls: 'secondary' })}</div>
              <div class="app-row">${Y.btn('link', st.link.enabled ? 'Turn the link off' : 'Anyone with the link can view', { arg: { enabled: !st.link.enabled }, cls: 'secondary' })}</div>
              <span class="app-sub">Ben: ${esc(st.acl.ben || 'no access')} · Cho: ${esc(st.acl.cho || 'no access')} · link ${st.link.enabled ? 'on' : 'off'}</span></div>`;
          }
          Y.paint(el, sim, who, sections, {}, null);
        }
        const c = sim.scenario.consistency(sim);
        const cho = sim.ui.cho;
        SDL.ui.paintSections(el.querySelector('[data-ref="cho"]'), {
          state: `<div class="ops-shards"><div class="ops-row" data-tone="${cho.open ? 'ok' : cho.error ? 'fail' : ''}"><div class="ops-name"><strong>${cho.open ? `Open as ${esc(cho.role)}${cho.viaLink ? ' via link' : ''} · rev ${cho.rev} · ${cho.received} received` : cho.error ? esc(cho.error) : 'Not open'}</strong><span class="doc-text">${cho.open ? esc(cho.text) : ''}</span></div></div></div>`,
          keys: `<div class="app-row">${Y.btn('open', 'Open the document', { arg: { who: 'cho' }, cls: 'secondary' })}${Y.btn('open', 'Open with the link', { arg: { who: 'cho', viaLink: true }, cls: 'secondary' })}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };

  function pushTo(ctx, who, row) {
    const u = ctx.ui[who];
    if (row.rev <= u.rev) return { applied: false };
    u.rev = row.rev;
    if (row.who === who) return { applied: true };
    let op = row.op;
    if (u.pending) { const mine = u.pending; u.pending = OT.transform(mine, op, false); op = OT.transform(op, mine, true); }
    u.text = OT.apply(u.text, op);
    return { applied: true };
  }
})(typeof window !== 'undefined' ? window : globalThis);
