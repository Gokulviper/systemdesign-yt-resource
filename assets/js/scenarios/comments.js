/*
 * Comments and replies. A comment commits with an outbox event; a moderation
 * worker classifies it asynchronously; replies notify the parent's author
 * after commit. Idempotency keys stop double posts; versions stop lost edits.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const TEXTS = ['Great explanation of leader election!', 'Could you cover log compaction next?', 'Timestamp 4:12 cleared it up for me.', 'FREE MONEY click my channel'];

  function startPost(sim, opts) {
    const st = sim.state;
    const text = opts.text || TEXTS[st.seq.text++ % 3];
    const key = opts.key || 'c-key-' + ++st.seq.key;
    const parent = opts.parent || null;
    sim.startAction(parent ? 'Viewer: reply' : 'Viewer: post comment', function* (ctx) {
      const u = ctx.ui.viewer;
      u.posting = true;
      Y.L(ctx, { displayed: ['pending', 'Shows “Posting…”.'], retrySafe: st.config.idem ? ['yes', `Every attempt carries key ${key}.`] : ['no', 'No key: a retry can post twice.'] });
      const r = yield* ctx.retry({ attempts: 3, baseMs: 150 }, function* () {
        return yield ctx.call('gateway', 'post', { key: st.config.idem ? key : key + '-' + ctx.rand().toString(36).slice(2, 6), text, parent }, { timeout: 1000 });
      });
      u.posting = false;
      if (r.ok) {
        u.message = r.value.status === 'pending' ? 'Posted. It appears once moderation approves it.' : 'Posted.';
        u.tone = 'ok';
        Y.L(ctx, { displayed: ['yes', r.value.status === 'pending' ? 'Shows “Held for review”.' : 'Shows the comment.'], accepted: 'yes', async: ['pending', 'Moderation and notifications run after commit.'] });
        ctx.explain(`The comment and a comment.created event committed in one transaction${r.value.replayed ? ' (the retry carried the same key, so the server returned the original instead of posting again)' : ''}. Moderation and${parent ? ' the reply notification' : ' notifications'} happen asynchronously.`);
      } else {
        u.message = `Couldn’t post: ${r.error.message}`;
        u.tone = 'fail';
        Y.failed(ctx, 'Shows an error; the draft stays in the box.');
        ctx.explain(`Posting failed with ${r.error.code}. Nothing was saved, so retrying is safe.`);
      }
    }, { self: 'viewer' });
  }
  function startEdit(sim, id, text, device, baseVersion) {
    sim.startAction(`${device}: edit comment`, function* (ctx) {
      const st = ctx.state;
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'The edit carries the version it was based on.'] });
      const r = yield ctx.call('gateway', 'edit', { id, text, version: baseVersion }, { timeout: 1200 });
      if (r.ok) { Y.L(ctx, { displayed: 'yes', accepted: 'yes', async: 'n/a' }); ctx.sim.ui.viewer.message = `${device}: edit saved.`; }
      else {
        Y.failed(ctx, r.error.code === 'CONFLICT' ? 'Shows “This comment changed; reload to edit”.' : 'Shows an error.');
        ctx.sim.ui.viewer.message = r.error.code === 'CONFLICT' ? `${device}: the comment changed on another device. Reload to edit.` : r.error.message;
        if (r.error.code === 'CONFLICT') ctx.explain(`Both devices started from version ${baseVersion}. The first edit won; this one was refused instead of silently overwriting it.`);
      }
      void st;
    }, { self: 'viewer' });
  }

  const sc = (SDL.scenarios.comments = {
    id: 'comments',
    seed: 113,
    productWidth: 560,
    intro: 'Post a comment from the viewer phone, then reply to the creator’s pinned comment and watch the creator’s phone get notified. Try the guided scenarios for duplicates, moderation, and edits.',
    topology: {
      width: 1100, height: 540,
      nodes: [
        { id: 'viewer', label: 'Viewer app', sub: 'Posts and replies', kind: 'client', x: 100, y: 90, latency: 1, role: 'Writes comments and replies, pages through the thread.', owns: ['Draft text'] },
        { id: 'author', label: 'Creator app', sub: 'Gets reply alerts', kind: 'client', x: 100, y: 440, latency: 1, role: 'Receives a notification when someone replies.', ops: [{ name: 'notify', desc: 'Show a notification.' }], owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Auth, rate limits', kind: 'gateway', x: 320, y: 90, latency: 2, role: 'Routes comment calls.', ops: [{ name: 'post', desc: 'New comment.' }, { name: 'edit', desc: 'Edit.' }, { name: 'list', desc: 'Read a page.' }], owns: ['Nothing durable'] },
        { id: 'svc', label: 'Comment service', sub: 'Threads', kind: 'service', x: 540, y: 90, latency: 4, role: 'Validates, threads replies, enforces idempotency and versions.', ops: [{ name: 'post', desc: 'Create.' }, { name: 'edit', desc: 'Conditional update.' }], owns: ['Comment rules'] },
        { id: 'db', label: 'Comments DB', sub: 'Comments + outbox', kind: 'db', x: 760, y: 90, latency: 10, role: 'Comments with status (pending, visible, hidden) and version; the outbox commits with them.', ops: [{ name: 'insert', desc: 'Insert unless the key exists.' }, { name: 'update', desc: 'Change if version matches.' }], owns: ['comments', 'idempotency_keys', 'outbox'] },
        { id: 'events', label: 'Comment events', sub: 'Event broker', kind: 'queue', x: 980, y: 90, latency: 4, queue: 'cevents', role: 'comment.created and comment.published.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['comment log'] },
        { id: 'moderator', label: 'Moderation worker', sub: 'After commit', kind: 'worker', x: 980, y: 300, latency: 4, role: 'Classifies new comments and publishes or hides them.', ops: [{ name: 'consume', desc: 'Classify one comment.' }], owns: ['Its offset'] },
        { id: 'classifier', label: 'Spam classifier', sub: 'ML model', kind: 'service', x: 760, y: 300, latency: 15, role: 'Scores a comment for spam and abuse.', ops: [{ name: 'check', desc: 'Score text.' }], owns: ['Model'] },
        { id: 'notify', label: 'Notifications', sub: 'Reply alerts', kind: 'worker', x: 540, y: 440, latency: 4, role: 'Notifies the parent comment’s author about published replies.', ops: [{ name: 'consume', desc: 'Send a reply alert.' }], owns: ['Its offset'] },
      ],
      edges: [
        { from: 'viewer', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'svc', latency: 3 },
        { from: 'svc', to: 'db', latency: 4 },
        { from: 'db', to: 'events', latency: 6, label: 'outbox' },
        { from: 'events', to: 'moderator', latency: 4 },
        { from: 'moderator', to: 'classifier', latency: 4 },
        { from: 'moderator', to: 'db', latency: 5, via: [[870, 300], [870, 160]] },
        { from: 'events', to: 'notify', latency: 5 },
        { from: 'notify', to: 'author', latency: 30, label: 'push' },
      ],
      queues: [{ id: 'outbox', broker: 'db', label: 'outbox', groups: ['relay'] }, { id: 'cevents', broker: 'events', label: 'comment events', groups: ['moderator', 'notify'] }],
    },
    failures: [
      { id: 'db-down', node: 'db', mode: 'down', label: 'Comments DB down', desc: 'Posting fails cleanly; reading fails too.' },
      { id: 'db-drop', node: 'db', mode: 'dropResponse', label: 'Reply lost after commit', desc: 'The comment saves but the app sees a timeout and retries.' },
      { id: 'classifier-down', node: 'classifier', mode: 'down', label: 'Moderation outage', desc: 'Comments cannot be classified: hold them, or publish unreviewed.' },
      { id: 'notify-paused', node: 'notify', mode: 'paused', label: 'Notifications paused', desc: 'Replies are saved and visible; alerts wait.' },
      { id: 'author-down', node: 'author', mode: 'down', label: 'Creator phone offline', desc: 'Reply alerts cannot be delivered.' },
    ],
    switches: Y.switches([
      ['idem', 'Idempotency key on posts', 'Off: a retried post creates a duplicate comment.'],
      ['occ', 'Version check on edits', 'Off: the last edit silently overwrites the other device.'],
      ['failOpen', 'Publish unreviewed when moderation is down', 'Off: hold new comments as pending until moderation recovers.'],
    ]),
    presets: Y.presets({ idem: true, occ: true, failOpen: false }, [
      { id: 'post', label: 'Post a comment', desc: 'Commit, outbox, moderation approves, the comment appears.', run: (s) => startPost(s, {}) },
      { id: 'reply', label: 'Reply notifies the creator', desc: 'A reply to the pinned comment is published, then the creator’s phone is alerted.', run: (s) => startPost(s, { parent: 'c1', text: 'Thanks, this helped a lot!' }) },
      { id: 'dup', label: 'Retry after lost reply, with key', desc: 'The first post commits but its reply is lost. The retry carries the same key: one comment.', run: (s) => { s.inject('db', 'dropResponse', true, 700); startPost(s, {}); } },
      { id: 'dup-bad', label: 'Same, without a key', desc: 'The retry looks new to the server: the comment appears twice.', sw: { idem: false }, run: (s) => { s.inject('db', 'dropResponse', true, 700); startPost(s, {}); } },
      { id: 'spam', label: 'Spam is caught', desc: 'The classifier flags it after commit; it is hidden and never shown.', run: (s) => startPost(s, { text: TEXTS[3] }) },
      { id: 'mod-down', label: 'Moderation down: hold', desc: 'New comments stay pending until the classifier returns, then publish.', run: (s) => { s.inject('classifier', 'down', true, 3000); startPost(s, {}); } },
      { id: 'mod-open', label: 'Moderation down: publish unreviewed', desc: 'Comments go live without review. Including spam.', sw: { failOpen: true }, run: (s) => { s.inject('classifier', 'down', true, 4000); startPost(s, { text: TEXTS[3] }); } },
      { id: 'db-down', label: 'Database down', desc: 'Three attempts fail. Nothing saved; the draft is kept.', run: (s) => { s.inject('db', 'down'); startPost(s, {}); } },
      { id: 'notify-out', label: 'Notifications delayed', desc: 'The reply is saved and visible immediately; the creator’s alert arrives when notifications resume.', run: (s) => { s.inject('notify', 'paused', true, 3000); startPost(s, { parent: 'c1', text: 'Thanks, this helped a lot!' }); } },
      { id: 'edit', label: 'Edits from two devices', desc: 'Phone and laptop both edit version 1. The second is refused with a conflict.', run: (s) => { s.schedule(10, () => startEdit(s, 'c2', 'Edited on my phone', 'Phone', 1)); s.schedule(20, () => startEdit(s, 'c2', 'Edited on my laptop', 'Laptop', 1)); } },
      { id: 'edit-bad', label: 'Same, without version checks', desc: 'Both succeed; the laptop silently overwrites the phone’s edit.', sw: { occ: false }, run: (s) => { s.schedule(10, () => startEdit(s, 'c2', 'Edited on my phone', 'Phone', 1)); s.schedule(20, () => startEdit(s, 'c2', 'Edited on my laptop', 'Laptop', 1)); } },
    ]),
    initialState: () => ({
      config: { idem: true, occ: true, failOpen: false },
      comments: {
        c1: { id: 'c1', author: 'Distributed Daily', text: 'Pinned: questions about consensus go here!', status: 'visible', version: 1, parent: null, t: 0 },
        c2: { id: 'c2', author: 'You', text: 'Raft is so much easier than Paxos.', status: 'visible', version: 1, parent: null, t: 0 },
      },
      keys: {}, edits: [], seq: { id: 2, key: 0, text: 0, event: 0 }, alerts: 0,
    }),
    initialUI: () => ({ viewer: { posting: false, message: 'Write a comment or reply to the pinned one.', tone: '' }, author: { alerts: [], banner: null } }),
    actions: {
      post(sim) { startPost(sim, {}); },
      reply(sim) { startPost(sim, { parent: 'c1', text: 'Thanks, this helped a lot!' }); },
      edit(sim) { startEdit(sim, 'c2', 'Raft is easier than Paxos (edited).', 'Phone', sim.state.comments.c2.version); },
      set: Y.setAction,
    },
    handlers: {
      author: {
        notify(ctx, p) { ctx.ui.author.alerts.unshift(p.text); ctx.ui.author.banner = { title: 'New reply', body: p.text, tone: 'ok', t: ctx.now() }; ctx.state.alerts++; return { shown: true }; },
      },
      gateway: {
        post: function* (ctx, p) { return ctx.must(yield ctx.call('svc', 'post', p, { timeout: 900 })); },
        edit: function* (ctx, p) { return ctx.must(yield ctx.call('svc', 'edit', p, { timeout: 900 })); },
      },
      svc: {
        post: function* (ctx, p) { return ctx.must(yield ctx.call('db', 'insert', p, { timeout: 600 })); },
        edit: function* (ctx, p) { return ctx.must(yield ctx.call('db', 'update', p, { timeout: 600 })); },
      },
      db: {
        insert(ctx, p) {
          const st = ctx.state;
          if (st.keys[p.key]) return Object.assign({ replayed: true }, st.comments[st.keys[p.key]]);
          const id = 'c' + ++st.seq.id;
          const c = { id, author: 'You', text: p.text, status: 'pending', version: 1, parent: p.parent, t: ctx.now() };
          st.comments[id] = c;
          st.keys[p.key] = id;
          ctx.sim.enqueue('outbox', { type: 'comment.created', eventId: 'ev' + ++st.seq.event, payload: { id }, actionId: ctx.actionId });
          ctx.ledger('committed', 'yes', 'The comment (pending moderation) and its event committed together.');
          return Object.assign({}, c);
        },
        update(ctx, p) {
          const st = ctx.state;
          const c = st.comments[p.id];
          if (st.config.occ && c.version !== p.version) ctx.fail('CONFLICT', `Comment is at version ${c.version}, not ${p.version}.`);
          st.edits.push({ id: p.id, text: p.text, base: p.version });
          c.text = p.text;
          c.version++;
          ctx.ledger('committed', 'yes', `Saved as version ${c.version}.`);
          return Object.assign({}, c);
        },
        setStatus(ctx, p) {
          const st = ctx.state;
          const c = st.comments[p.id];
          c.status = p.status;
          if (p.status === 'visible') ctx.sim.enqueue('outbox', { type: 'comment.published', eventId: 'ev' + ++st.seq.event, payload: { id: p.id }, actionId: ctx.actionId });
          return { status: c.status };
        },
      },
      classifier: { check(ctx, p) { return { spam: /free money/i.test(p.text) }; } },
    },
    setup(sim) {
      Y.relay(sim, 'outbox', 'relay', 'events', 'cevents');
      Y.consumer(sim, 'cevents', 'moderator', 'moderator', function* (ctx, msg) {
        if (msg.type !== 'comment.created') return true;
        const st = ctx.state;
        const c = st.comments[msg.payload.id];
        const r = yield ctx.call('classifier', 'check', { text: c.text }, { timeout: 500 });
        let status;
        if (r.ok) status = r.value.spam ? 'hidden' : 'visible';
        else if (st.config.failOpen) { status = 'visible'; ctx.log({ op: `published ${c.id} unreviewed`, status: 'note', actionId: msg.actionId, detail: 'Moderation is down and fail-open is on.' }); }
        else { ctx.log({ op: `holding ${c.id}`, status: 'retry', actionId: msg.actionId, detail: 'Moderation is down. The comment stays pending; retrying shortly.' }); return false; }
        const w = yield ctx.call('db', 'setStatus', { id: c.id, status }, { timeout: 600, actionId: msg.actionId });
        if (!w.ok) return false;
        if (status === 'hidden') { ctx.sim.setLedger(msg.actionId, 'async', 'yes', 'Moderation hid the comment as spam.'); ctx.explain('The comment committed first, then the moderation worker classified it as spam and hid it. Viewers never saw it.'); }
        else if (!c.parent) ctx.sim.setLedger(msg.actionId, 'async', 'yes', 'Moderation approved and published the comment.');
        return true;
      }, () => true);
      Y.consumer(sim, 'cevents', 'notify', 'notify', function* (ctx, msg) {
        if (msg.type !== 'comment.published') return true;
        const c = ctx.state.comments[msg.payload.id];
        if (!c.parent) return true;
        const r = yield ctx.call('author', 'notify', { text: `Sam replied to your pinned comment: “${c.text}”` }, { timeout: 600, actionId: msg.actionId });
        if (!r.ok) { ctx.log({ op: 'reply alert retry', status: 'retry', error: r.error, actionId: msg.actionId, detail: 'The reply is saved and visible; only the alert is waiting.' }); return false; }
        ctx.sim.setLedger(msg.actionId, 'async', 'yes', 'Reply published and the creator was notified.');
        return true;
      }, () => true);
    },
    consistency(sim) {
      const st = sim.state;
      const mine = Object.values(st.comments).filter((c) => c.author === 'You' && c.id !== 'c2');
      const texts = mine.map((c) => c.text);
      if (new Set(texts).size < texts.length) return { key: 'wrong', label: 'The same comment was posted twice: a retry without an idempotency key.' };
      const spamShown = mine.find((c) => /free money/i.test(c.text) && c.status === 'visible');
      if (spamShown) return { key: 'wrong', label: 'Spam is visible: it was published without review while moderation was down.' };
      const lost = st.edits.filter((e) => e.base === 1 && e.id === 'c2');
      if (lost.length > 1 && !st.config.occ) return { key: 'wrong', label: 'Two edits started from version 1 both saved; the first was silently overwritten.' };
      const pending = mine.filter((c) => c.status === 'pending');
      if (pending.length) return { key: 'stale', label: `${pending.length} comment${pending.length > 1 ? 's are' : ' is'} waiting for moderation.` };
      const backlog = sim.queueStats('cevents').depth;
      if (backlog) return { key: 'stale', label: `${backlog} event${backlog > 1 ? 's' : ''} waiting (moderation or notifications).` };
      return { key: 'ok', label: 'Every comment is stored once, moderated, and visible to the right people.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const all = Object.values(st.comments);
      return [
        { label: 'Visible comments', value: all.filter((c) => c.status === 'visible').length },
        { label: 'Pending moderation', value: all.filter((c) => c.status === 'pending').length, tone: all.some((c) => c.status === 'pending') ? 'warn' : '' },
        { label: 'Hidden as spam', value: all.filter((c) => c.status === 'hidden').length },
        { label: 'Reply alerts delivered', value: st.alerts },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['viewer', 'Viewer phone'], ['author', 'Creator phone']], { note: 'Your own pending comments show as “Held for review”; other viewers would not see them yet.' }); },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.viewer;
        const top = Object.values(st.comments).filter((c) => !c.parent).sort((a, b) => b.t - a.t);
        const row = (c) => `<div class="yt-comment${c.status !== 'visible' ? ' is-' + c.status : ''}"><strong>${esc(c.author)}</strong> <span class="app-sub">v${c.version}</span><p>${esc(c.text)}</p>${c.status === 'pending' ? '<span class="app-sub">Held for review</span>' : c.status === 'hidden' ? '<span class="app-sub">Removed as spam</span>' : ''}
          ${Object.values(st.comments).filter((r) => r.parent === c.id).map((r) => `<div class="yt-reply"><strong>${esc(r.author)}</strong><p>${esc(r.text)}</p>${r.status === 'pending' ? '<span class="app-sub">Held for review</span>' : ''}</div>`).join('')}</div>`;
        const body = `${Y.btn('post', u.posting ? '<span class="spinner"></span>Posting…' : 'Post a comment', { disabled: u.posting })}
          <div class="app-row">${Y.btn('reply', 'Reply to pinned', { cls: 'secondary', disabled: u.posting })}${Y.btn('edit', 'Edit mine', { cls: 'secondary' })}</div>
          ${Y.msg(u.message, u.tone)}<div class="yt-comments">${top.map(row).join('')}</div>`;
        Y.paint(el, sim, 'viewer', { head: '<div><p class="app-title">Comments</p></div>', body }, {});
        const a = sim.ui.author;
        Y.paint(el, sim, 'author', { head: '<div><p class="app-title">YouTube Studio</p><p class="app-sub">Distributed Daily</p></div>', body: a.alerts.length ? a.alerts.slice(0, 4).map((t) => `<div class="app-card is-ok">${esc(t)}</div>`).join('') : '<p class="app-sub">No reply alerts yet.</p>' }, {}, a.banner);
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
