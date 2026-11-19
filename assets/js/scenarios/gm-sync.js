/*
 * Sync across devices: history ids, push, offline, drafts.
 * Every change to Maya’s mailbox appends an entry with the next history id.
 * Each device keeps a cursor (the last id it applied) and asks “everything
 * since 812”. Push only hints that something changed, and only to devices
 * whose watch has not expired; a renewal job keeps the watches alive. History
 * is kept for a limited time: a device whose cursor is older than the oldest
 * entry gets “gone” (a 404 in Gmail’s API) and must do a full sync. Drafts
 * carry a version, so a save from a stale copy is refused (409) instead of
 * overwriting what another device wrote. The phone’s outbox sends with client
 * ids, so a flaky reconnect cannot send a message twice.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const DEVS = ['phone', 'laptop', 'tablet'];
  const NAME = { phone: 'phone', laptop: 'laptop', tablet: 'tablet' };
  const WATCH_MS = 3000; // a watch lasts 7 days in Gmail’s API; shortened
  const RENEW_EVERY = 1000; // Google recommends renewing daily; shortened
  const POLL_MS = 2000;
  const RET_MS = 20000; // history retention; “at least a week” in practice
  const SHORT_RET_MS = 1000;
  const INITIAL = [
    { id: 'm1', from: 'Omar', subject: 'Contract draft' },
    { id: 'm2', from: 'Finch News', subject: 'Weekly digest' },
    { id: 'm3', from: 'Dev', subject: 'Lunch Friday?' },
    { id: 'm4', from: 'Lena', subject: 'Photos from Goa' },
  ];
  const ARRIVALS = [{ from: 'Omar', subject: 'Signed copy' }, { from: 'Dev', subject: 'Room booked' }, { from: 'Lena', subject: 'One more photo' }];

  const offline = (sim, d) => !!(sim.nodes[d].modes.down || sim.nodes[d].modes.offline);
  const latest = (st) => st.hidSeq;
  const inboxOf = (msgs) => Object.values(msgs).filter((m) => !m.deleted && m.labels.includes('INBOX')).map((m) => m.id).sort();

  function freshView(st) {
    const msgs = {};
    for (const m of Object.values(st.box)) msgs[m.id] = { id: m.id, from: m.from, subject: m.subject, labels: m.labels.slice(), deleted: m.deleted };
    return msgs;
  }

  /** Fetch every change since the cursor; on “gone”, do a full sync (or, naively, skip ahead). */
  function* sync(ctx, d, quiet) {
    const st = ctx.state;
    const v = st.dev[d];
    if (v.syncing) { v.again = true; return; }
    v.syncing = true;
    try {
      do {
        v.again = false;
        if (offline(ctx.sim, d)) break;
        const r = yield ctx.call('api', 'history', { since: v.cursor, dev: d }, { timeout: 1200, quiet: quiet ? true : undefined });
        if (!r.ok) break;
        if (r.value.gone) {
          st.stats.gone++;
          if (st.config.fullSync) {
            ctx.log({ op: `${NAME[d]}: history ${v.cursor} is gone, full sync`, status: 'retry', detail: `The oldest history still kept is after ${v.cursor}. The ${NAME[d]} cannot know what it missed, so it lists the whole mailbox and starts again from history ${r.value.hid}.` });
            const f = yield ctx.call('api', 'list', { dev: d }, { timeout: 1500 });
            if (!f.ok) break;
            v.msgs = f.value.msgs;
            v.cursor = f.value.hid;
            st.stats.fullSyncs++;
          } else {
            ctx.log({ op: `${NAME[d]}: history ${v.cursor} is gone, skipping ahead`, status: 'err', detail: `The ${NAME[d]} treats “gone” as “nothing new” and moves its cursor to ${r.value.hid}. Everything that changed while it was away is now invisible to it.` });
            v.cursor = r.value.hid;
          }
        } else {
          for (const e of r.value.entries) apply(v, e);
          v.cursor = r.value.hid;
        }
        v.lastSync = ctx.now();
      } while (v.again);
    } finally { v.syncing = false; }
  }
  function apply(v, e) {
    if (e.type === 'add') v.msgs[e.msg.id] = Object.assign({}, e.msg, { labels: e.msg.labels.slice() });
    if (e.type === 'labels' && v.msgs[e.id]) v.msgs[e.id].labels = e.labels.slice();
    if (e.type === 'delete' && v.msgs[e.id]) v.msgs[e.id].deleted = true;
    if (e.type === 'draft' && !v.draft.dirty && e.id === v.draft.id) { v.draft.lines = e.lines.slice(); v.draft.base = e.version; }
  }

  function modify(sim, d, kind) {
    const st = sim.state;
    const v = st.dev[d];
    const id = inboxOf(v.msgs).filter((x) => !v.pending[x])[0];
    if (!id) return;
    v.pending[id] = kind;
    const subject = v.msgs[id].subject;
    sim.startAction(`${d === 'laptop' ? 'Laptop' : d === 'phone' ? 'Phone' : 'Tablet'}: ${kind} “${subject}”`, function* (ctx) {
      Y.L(ctx, { displayed: ['pending', `“${kind === 'archive' ? 'Archiving' : 'Deleting'}…”`], retrySafe: ['yes', 'Removing a label or deleting twice changes nothing.'] });
      const r = yield ctx.call('api', kind === 'archive' ? 'modify' : 'remove', { id, remove: ['INBOX'], dev: d }, { timeout: 1500 });
      delete ctx.state.dev[d].pending[id];
      if (!r.ok) { Y.failed(ctx, `${kind} failed: ${r.error.code}.`); return; }
      Y.L(ctx, { accepted: ['yes', `History ${r.value.hid}.`], committed: ['yes', 'Mailbox and history in one write.'], async: ['pending', 'Other devices follow the history.'] });
      ctx.explain(`The mailbox change and history entry ${r.value.hid} committed together. Every device that applies the history up to ${r.value.hid} sees it; push only tells them to look.`);
      yield* sync(ctx, d);
      ctx.ledger('displayed', 'yes', 'Gone from this inbox.');
    }, { self: d });
  }

  function arrive(sim) {
    const st = sim.state;
    const a = ARRIVALS[st.seq.arrive++ % ARRIVALS.length];
    sim.startAction(`New mail from ${a.from}: “${a.subject}”`, function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'Arrives on its own.'], retrySafe: ['n/a', 'Delivery is covered in the inbound lab.'] });
      const r = yield ctx.call('sync', 'deliver', a, { timeout: 1500 });
      if (r.ok) Y.L(ctx, { accepted: ['yes', `History ${r.value.hid}.`], committed: ['yes', 'In the mailbox.'], async: ['pending', 'Devices follow the history.'] });
    }, { self: 'api' });
  }

  function editDraft(sim, d, line) {
    const v = sim.state.dev[d];
    v.draft.lines.push(line);
    v.draft.dirty = true;
    sim.startAction(`${d === 'laptop' ? 'Laptop' : 'Phone'}: edit the draft (“${line}”)`, function* (ctx) {
      Y.L(ctx, { displayed: ['yes', 'On this device.'], retrySafe: [ctx.state.config.versioned ? 'yes' : 'no', ctx.state.config.versioned ? `The save says “if the draft is still version ${v.draft.base}”.` : 'The save overwrites whatever is there.'] });
      if (offline(ctx.sim, d)) { ctx.ledger('accepted', 'pending', 'Offline: saved on the device, sent when back.'); return; }
      yield* saveDraft(ctx, d);
    }, { self: d });
  }
  function* saveDraft(ctx, d) {
    const st = ctx.state;
    const v = st.dev[d];
    if (!v.draft.dirty) return;
    const r = yield ctx.call('api', 'saveDraft', { id: v.draft.id, lines: v.draft.lines.slice(), ifMatch: st.config.versioned ? v.draft.base : null }, { timeout: 1500 });
    if (r.ok) {
      v.draft.base = r.value.version; v.draft.dirty = false;
      Y.L(ctx, { accepted: ['yes', `Draft version ${r.value.version}.`], committed: ['yes', 'Saved.'], async: ['n/a', 'Other devices follow the history.'] });
      return;
    }
    if (r.error.code === 'CONFLICT') {
      const c = yield ctx.call('api', 'createDraft', { lines: v.draft.lines.slice(), from: d }, { timeout: 1500 });
      if (c.ok) {
        st.conflicts++;
        v.draft = { id: c.value.id, lines: v.draft.lines.slice(), base: c.value.version, dirty: false };
        Y.L(ctx, { accepted: ['yes', '409: the draft changed elsewhere.'], committed: ['yes', `Kept as a second draft, ${c.value.id}.`], async: ['n/a', 'Maya merges by hand.'] });
        ctx.explain(`The draft had moved on to a newer version while the ${NAME[d]} was editing an old one, so the save was refused with 409. The ${NAME[d]}’s text is kept as a second draft; nothing anyone typed is lost.`);
      }
    }
  }

  function sendOffline(sim) {
    const st = sim.state;
    const n = ++st.seq.send;
    const subject = ['Running late', 'See you at 6'][(n - 1) % 2];
    st.dev.phone.outbox.push({ cid: `maya-phone-o${n}`, subject, tries: 0 });
    if (!offline(sim, 'phone')) sim.spawn((c) => flush(c), { self: 'phone' });
  }
  function* flush(ctx) {
    const st = ctx.state;
    const v = st.dev.phone;
    if (v.flushing) return;
    v.flushing = true;
    try {
      while (v.outbox.length && !offline(ctx.sim, 'phone')) {
        const it = v.outbox[0];
        it.tries++;
        const r = yield ctx.call('api', 'send', { cid: st.config.ids ? it.cid : null, trace: it.cid, subject: it.subject }, { timeout: 1200 });
        if (r.ok) { v.outbox.shift(); continue; }
        ctx.log({ op: `outbox: “${it.subject}” again`, status: 'retry', detail: `No reply. The phone keeps the message and tries again${st.config.ids ? ` with client id ${it.cid}` : ', with nothing to say it is the same message'}.` });
        yield ctx.wait(300);
      }
    } finally { v.flushing = false; }
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'api', quiet: 'all' });
  const fresh = (sim) => { for (const d of DEVS) sim.state.dev[d].lastSync = sim.now; };

  function initialState() {
    const box = {};
    INITIAL.forEach((m) => { box[m.id] = { id: m.id, from: m.from, subject: m.subject, labels: ['INBOX'], deleted: false }; });
    const st = {
      config: { poll: true, renew: true, fullSync: true, versioned: true, ids: true },
      box, hist: [], hidSeq: 0, histBase: 0,
      drafts: { d1: { id: 'd1', version: 1, lines: ['Agenda for Friday'] } }, savedLines: ['Agenda for Friday'], conflicts: 0,
      sent: {}, byClient: {}, flakyHit: {},
      watch: { phone: WATCH_MS, laptop: WATCH_MS, tablet: WATCH_MS }, watchLapsed: {},
      dev: {},
      stats: { gone: 0, fullSyncs: 0, hintsLost: 0, noWatch: 0 },
      seq: { arrive: 0, send: 0, msg: 4, draft: 1 },
    };
    for (const d of DEVS) st.dev[d] = { msgs: freshView(st), cursor: 0, lastSync: 0, syncing: false, again: false, pending: {}, draft: { id: 'd1', lines: ['Agenda for Friday'], base: 1, dirty: false }, outbox: [], flushing: false };
    return st;
  }

  SDL.scenarios['gm-sync'] = {
    id: 'gm-sync',
    seed: 2711,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Archive a message on the laptop and watch the phone and tablet follow: a history entry, a push hint, “everything since my cursor”. Then lose the hints, let the watch lapse, keep the tablet away past retention, or edit one draft on two devices.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'phone', label: 'Maya’s phone', sub: 'Gmail app', kind: 'client', x: 90, y: 90, latency: 1, role: 'Keeps a history cursor, an outbox with client ids, and a draft with its base version.', ops: [{ name: 'hint', desc: 'Your mailbox changed.' }], owns: ['Cursor', 'Outbox', 'Draft copy'] },
        { id: 'laptop', label: 'Maya’s laptop', sub: 'Web', kind: 'client', x: 90, y: 280, latency: 1, role: 'Same cursor logic as the phone.', ops: [{ name: 'hint', desc: 'Your mailbox changed.' }], owns: ['Cursor', 'Draft copy'] },
        { id: 'tablet', label: 'Maya’s tablet', sub: 'Rarely used', kind: 'client', x: 90, y: 470, latency: 1, role: 'Often off for weeks. Its cursor can fall behind the history that is still kept.', ops: [{ name: 'hint', desc: 'Your mailbox changed.' }], owns: ['Cursor'] },
        { id: 'api', label: 'Gmail API', sub: 'Frontend', kind: 'gateway', x: 300, y: 280, latency: 3, role: 'history.list, messages.list, modify, drafts, send.', ops: [{ name: 'history', desc: 'Changes since a history id.' }, { name: 'list', desc: 'Full mailbox listing.' }], owns: ['Nothing durable'] },
        { id: 'sync', label: 'Sync service', sub: 'Reads and writes', kind: 'service', x: 520, y: 280, latency: 3, role: 'Answers history reads, does full listings, applies label changes, and saves drafts with a version check.', ops: [{ name: 'history', desc: 'Read the history.' }, { name: 'deliver', desc: 'A new message for Maya.' }], owns: ['Nothing durable'] },
        { id: 'store', label: 'Mailbox store', sub: 'Messages + labels', kind: 'db', x: 760, y: 120, latency: 5, role: 'Each write to Maya’s mailbox appends the next history entry in the same transaction.', ops: [{ name: 'modify', desc: 'Change labels.' }, { name: 'deliver', desc: 'Insert.' }, { name: 'list', desc: 'Everything.' }], owns: ['messages', 'labels', 'sent'] },
        { id: 'hist', label: 'History log', sub: 'Kept for a while', kind: 'db', x: 760, y: 300, latency: 3, role: `Entries older than the retention window are trimmed. A cursor older than the oldest kept entry gets “gone”.`, ops: [{ name: 'read', desc: 'Entries after an id, or “gone”.' }], owns: ['history[id]'] },
        { id: 'drafts', label: 'Draft store', sub: 'Versioned', kind: 'db', x: 760, y: 480, latency: 4, role: 'A save carries the version it was based on. With versioning on, a save from an older version is refused with 409.', ops: [{ name: 'save', desc: 'Save if the version matches.' }, { name: 'create', desc: 'A new draft.' }], owns: ['drafts'] },
        { id: 'push', label: 'Push', sub: 'Hints via watches', kind: 'service', x: 980, y: 200, latency: 3, role: 'Follows the history and hints every device whose watch has not expired. A hint carries no data.', owns: ['Nothing durable'] },
        { id: 'watch', label: 'Watch registry', sub: 'Expires', kind: 'cache', x: 980, y: 360, latency: 1, role: `Each device’s watch expires ${WATCH_MS / 1000} s after its last renewal (7 days in Gmail’s API).`, ops: [{ name: 'renew', desc: 'Extend every watch.' }, { name: 'active', desc: 'Devices with a live watch.' }], owns: ['expiry per device'] },
        { id: 'renew', label: 'Renewal job', sub: 'Keeps watches alive', kind: 'worker', x: 980, y: 500, latency: 2, role: `Renews every watch each ${RENEW_EVERY / 1000} s (daily, in practice). If it stops, push goes quiet without an error.`, owns: ['Nothing'] },
      ],
      edges: [
        { from: 'phone', to: 'api', latency: 40, label: 'mobile network' },
        { from: 'laptop', to: 'api', latency: 15 },
        { from: 'tablet', to: 'api', latency: 30 },
        { from: 'api', to: 'sync', latency: 3 },
        { from: 'sync', to: 'store', latency: 3, via: [[640, 280], [640, 120]] },
        { from: 'sync', to: 'hist', latency: 3, via: [[640, 300]] },
        { from: 'sync', to: 'drafts', latency: 3, via: [[640, 280], [640, 480]] },
        { from: 'store', to: 'hist', latency: 2 },
        { from: 'hist', to: 'push', latency: 2, via: [[880, 300], [880, 200]] },
        { from: 'push', to: 'watch', latency: 1 },
        { from: 'renew', to: 'watch', latency: 1 },
        { from: 'push', to: 'phone', latency: 30, via: [[980, 40], [90, 40]] },
        { from: 'push', to: 'laptop', latency: 20, via: [[1080, 200], [1080, 575], [200, 575], [200, 280]] },
        { from: 'push', to: 'tablet', latency: 30, via: [[1080, 200], [1080, 575], [200, 575], [200, 470]] },
      ],
      queues: [{ id: 'changes', broker: 'hist', label: 'history', groups: ['push'] }],
    },
    modeLabels: { dropHints: 'Drops hints', shortRetention: 'Short retention', offline: 'No signal', flaky: 'Flaky: replies get lost' },
    failures: [
      { id: 'hints-lost', node: 'push', mode: 'dropHints', label: 'Push hints lost', desc: 'No device is told. Only polling or a refresh catches up.' },
      { id: 'renew-paused', node: 'renew', mode: 'paused', label: 'Watch not renewed', desc: `Watches lapse ${WATCH_MS / 1000} s after the last renewal and push stops, with no error anywhere.` },
      { id: 'short-retention', node: 'hist', mode: 'shortRetention', label: 'Short history retention', desc: `History older than ${SHORT_RET_MS / 1000} s is trimmed. A device away longer gets “gone”.` },
      { id: 'phone-offline', node: 'phone', mode: 'offline', label: 'Phone offline', desc: 'Sends wait in the outbox, draft edits stay on the phone, and history is fetched when it is back.' },
      { id: 'sync-down', node: 'sync', mode: 'down', label: 'Sync service down', desc: 'Devices cannot read history or save; they keep their cursor and try again.' },
      { id: 'store-slow', node: 'store', mode: 'slow', params: { factor: 40 }, label: 'Mailbox store slow', desc: 'Writes and full listings take much longer.' },
      { id: 'flaky', node: 'phone', mode: 'flaky', duration: 2500, label: 'Flaky reconnect (2.5 s)', desc: 'The first reply to each send is lost, so the phone retries every send.' },
      { id: 'tablet-away', node: 'tablet', mode: 'down', label: 'Tablet off for weeks', desc: 'No hints, no polls. When it comes back it asks for everything since its cursor.' },
    ],
    switches: Y.switches([
      ['poll', 'Poll as a fallback', `Devices also ask every ${POLL_MS / 1000} s. Off: they rely on push hints alone.`],
      ['renew', 'Renew watches', `A job renews every watch each ${RENEW_EVERY / 1000} s. Off: watches lapse and push stops.`],
      ['fullSync', 'Full sync on “gone”', 'A cursor older than the kept history triggers a full listing. Off: the device skips its cursor ahead as if nothing changed.'],
      ['versioned', 'Versioned drafts', 'A save carries its base version; a stale save gets 409 and is kept as a second draft. Off: the last save wins.'],
      ['ids', 'Client ids on queued sends', 'Each outbox message has a client id; a retried send returns the same message. Off: every retry is a new message.'],
    ]),
    presets: Y.presets({ poll: true, renew: true, fullSync: true, versioned: true, ids: true }, [
      { id: 'normal', label: 'Archive on the laptop, new mail arrives', desc: 'The archive and the new message each get a history id. Push hints the phone and the tablet, each asks for everything since its cursor, and all three inboxes match.', run: (s) => { fresh(s); modify(s, 'laptop', 'archive'); later(s, 800, arrive); } },
      { id: 'push-lost-no-poll', label: 'Push hints lost, no polling', desc: 'The archive commits, but no hint reaches the phone or tablet and nothing else makes them ask. They keep showing the message until Maya refreshes.', sw: { poll: false }, run: (s) => { fresh(s); s.inject('push', 'dropHints'); modify(s, 'laptop', 'archive'); } },
      { id: 'push-lost-poll', label: 'Push hints lost, polling on', desc: `Same lost hints. Within ${POLL_MS / 1000} s each device polls, gets the history entry, and catches up. Hints make sync fast; the history makes it correct.`, run: (s) => { fresh(s); s.inject('push', 'dropHints'); modify(s, 'laptop', 'archive'); } },
      { id: 'watch-expired', label: 'Watch not renewed', desc: `Nobody renews the watches. ${WATCH_MS / 1000} s later they lapse, push quietly stops hinting, and a new message never reaches the phone or tablet. No error is raised anywhere.`, sw: { renew: false, poll: false }, run: (s) => { fresh(s); later(s, 4000, arrive); } },
      { id: 'retention-full-sync', label: 'Tablet away past retention, full sync', desc: 'While the tablet is off, Maya archives and new mail arrives, and that history is trimmed. The tablet comes back, asks for “everything since 0”, gets “gone”, lists the whole mailbox, and matches.', run: (s) => { fresh(s); s.inject('hist', 'shortRetention'); s.inject('tablet', 'down', true, 3500); modify(s, 'laptop', 'archive'); later(s, 400, arrive); } },
      { id: 'retention-naive', label: 'Tablet away past retention, “gone” ignored', desc: 'Same trimmed history. The tablet treats “gone” as “nothing new” and skips its cursor ahead. It now believes it is up to date, but still shows the archived message and never sees the new one.', sw: { fullSync: false }, run: (s) => { fresh(s); s.inject('hist', 'shortRetention'); s.inject('tablet', 'down', true, 3500); modify(s, 'laptop', 'archive'); later(s, 400, arrive); } },
      { id: 'draft-lww', label: 'One draft, two devices, last write wins', desc: 'The phone (offline) adds “Bring the slides”; the laptop adds “Venue: Room 4” and saves. The phone comes back and saves its copy over the top: the laptop’s line is gone.', sw: { versioned: false }, run: (s) => { fresh(s); s.inject('phone', 'offline', true, 1500); later(s, 200, (x) => editDraft(x, 'phone', 'Bring the slides')); later(s, 500, (x) => editDraft(x, 'laptop', 'Venue: Room 4')); } },
      { id: 'draft-versioned', label: 'One draft, two devices, versioned', desc: 'Same edits. The phone’s save says “if still version 1”, but the laptop made version 2, so it gets 409. The phone’s text is kept as a second draft and both lines survive.', run: (s) => { fresh(s); s.inject('phone', 'offline', true, 1500); later(s, 200, (x) => editDraft(x, 'phone', 'Bring the slides')); later(s, 500, (x) => editDraft(x, 'laptop', 'Venue: Room 4')); } },
      { id: 'outbox-flaky-ids', label: 'Offline sends, flaky reconnect, client ids', desc: 'Two messages wait in the outbox. The reconnect loses the first reply to each send, so both are retried; their client ids make each retry return the message already made.', run: (s) => { fresh(s); s.inject('phone', 'offline', true, 1200); later(s, 200, sendOffline); later(s, 400, sendOffline); later(s, 1100, (x) => x.inject('phone', 'flaky', true, 2500)); } },
      { id: 'outbox-flaky-no-ids', label: 'Offline sends, flaky reconnect, no client ids', desc: 'Same reconnect without client ids. Each retry is a new message, so both of Maya’s messages are sent twice.', sw: { ids: false }, run: (s) => { fresh(s); s.inject('phone', 'offline', true, 1200); later(s, 200, sendOffline); later(s, 400, sendOffline); later(s, 1100, (x) => x.inject('phone', 'flaky', true, 2500)); } },
      { id: 'delete-while-offline', label: 'Delete on the laptop while the phone is offline', desc: 'The phone misses the hint. When its signal returns it asks for everything since its cursor and removes the message too.', run: (s) => { fresh(s); s.inject('phone', 'offline', true, 2000); modify(s, 'laptop', 'delete'); } },
    ]),
    initialState,
    initialUI: () => ({}),
    actions: {
      archive(sim, a) { modify(sim, a.dev || 'laptop', 'archive'); },
      remove(sim, a) { modify(sim, a.dev || 'laptop', 'delete'); },
      refresh(sim, a) { sim.spawn((c) => sync(c, a.dev || 'phone'), { self: a.dev || 'phone' }); },
      arrive(sim) { arrive(sim); },
      draft(sim, a) { editDraft(sim, a.dev || 'laptop', a.dev === 'phone' ? 'Bring the slides' : 'Venue: Room 4'); },
      send(sim) { sendOffline(sim); },
      set: Y.setAction,
    },
    handlers: {
      api: (() => {
        const fwd = (op) => function* (ctx, p) {
          if (p && p.dev && offline(ctx.sim, p.dev)) ctx.fail('OFFLINE', 'No signal.');
          return ctx.must(yield ctx.call('sync', op, p, { timeout: 1200 }));
        };
        return { history: fwd('history'), list: fwd('list'), modify: fwd('modify'), remove: fwd('remove'), saveDraft: fwd('saveDraft'), createDraft: fwd('createDraft'), send: fwd('send') };
      })(),
      sync: {
        history: function* (ctx, p) { return ctx.must(yield ctx.call('hist', 'read', p, { timeout: 800 })); },
        list: function* (ctx, p) { return ctx.must(yield ctx.call('store', 'list', p, { timeout: 1000 })); },
        modify: function* (ctx, p) { return ctx.must(yield ctx.call('store', 'modify', p, { timeout: 800 })); },
        remove: function* (ctx, p) { return ctx.must(yield ctx.call('store', 'remove', p, { timeout: 800 })); },
        deliver: function* (ctx, p) { return ctx.must(yield ctx.call('store', 'deliver', p, { timeout: 800 })); },
        saveDraft: function* (ctx, p) { return ctx.must(yield ctx.call('drafts', 'save', p, { timeout: 800 })); },
        createDraft: function* (ctx, p) { return ctx.must(yield ctx.call('drafts', 'create', p, { timeout: 800 })); },
        send: function* (ctx, p) {
          const st = ctx.state;
          const r = ctx.must(yield ctx.call('store', 'send', p, { timeout: 800 }));
          if (ctx.mode('flaky', 'phone') && !st.flakyHit[p.trace]) {
            st.flakyHit[p.trace] = true;
            ctx.log({ op: `reply to “${p.subject}” lost`, status: 'lost', detail: 'The message is sent, but the reply never reaches the phone on its flaky connection.' });
            yield ctx.wait(2000);
          }
          return r;
        },
      },
      store: {
        modify(ctx, p) {
          const m = ctx.state.box[p.id];
          if (!m) ctx.fail('NOT_FOUND', 'No such message.');
          m.labels = m.labels.filter((l) => !(p.remove || []).includes(l));
          return { hid: append(ctx, { type: 'labels', id: p.id, labels: m.labels.slice() }) };
        },
        remove(ctx, p) {
          const m = ctx.state.box[p.id];
          if (!m) ctx.fail('NOT_FOUND', 'No such message.');
          m.deleted = true;
          return { hid: append(ctx, { type: 'delete', id: p.id }) };
        },
        deliver(ctx, p) {
          const st = ctx.state;
          const id = `m${++st.seq.msg}`;
          st.box[id] = { id, from: p.from, subject: p.subject, labels: ['INBOX'], deleted: false };
          return { hid: append(ctx, { type: 'add', msg: Object.assign({}, st.box[id], { labels: ['INBOX'] }) }) };
        },
        list(ctx) {
          const st = ctx.state;
          const msgs = {};
          for (const m of Object.values(st.box)) msgs[m.id] = { id: m.id, from: m.from, subject: m.subject, labels: m.labels.slice(), deleted: m.deleted };
          return { msgs, hid: latest(st) };
        },
        send(ctx, p) {
          const st = ctx.state;
          if (p.cid && st.byClient[p.cid]) { ctx.log({ op: `send ${p.cid} again: same message`, status: 'dup', detail: `Client id ${p.cid} already made ${st.byClient[p.cid]}; nothing new is sent.` }); return { id: st.byClient[p.cid] }; }
          const id = `s${Object.keys(st.sent).length + 1}`;
          st.sent[id] = { id, trace: p.trace, subject: p.subject };
          if (p.cid) st.byClient[p.cid] = id;
          return { id };
        },
      },
      hist: {
        read(ctx, p) {
          const st = ctx.state;
          if (p.since < st.histBase) return { gone: true, hid: latest(st) };
          return { entries: st.hist.filter((e) => e.hid > p.since), hid: latest(st) };
        },
      },
      drafts: {
        save(ctx, p) {
          const st = ctx.state;
          const d = st.drafts[p.id];
          if (p.ifMatch != null && p.ifMatch !== d.version) ctx.fail('CONFLICT', `409: the draft is at version ${d.version}, not ${p.ifMatch}.`);
          d.version++;
          d.lines = p.lines.slice();
          for (const l of p.lines) if (!st.savedLines.includes(l)) st.savedLines.push(l);
          append(ctx, { type: 'draft', id: p.id, version: d.version, lines: d.lines.slice() });
          return { version: d.version };
        },
        create(ctx, p) {
          const st = ctx.state;
          const id = `d${++st.seq.draft}`;
          st.drafts[id] = { id, version: 1, lines: p.lines.slice(), conflictFrom: p.from };
          for (const l of p.lines) if (!st.savedLines.includes(l)) st.savedLines.push(l);
          return { id, version: 1 };
        },
      },
      watch: {
        renew(ctx, p) { for (const d of DEVS) ctx.state.watch[d] = ctx.now() + WATCH_MS; return { until: ctx.now() + WATCH_MS }; },
        active(ctx) { return { devs: DEVS.filter((d) => ctx.state.watch[d] > ctx.now()) }; },
      },
      phone: { hint(ctx) { if (offline(ctx.sim, 'phone')) ctx.fail('OFFLINE', 'No signal.'); ctx.spawn((c) => sync(c, 'phone'), { self: 'phone' }); return { ok: true }; } },
      laptop: { hint(ctx) { ctx.spawn((c) => sync(c, 'laptop'), { self: 'laptop' }); return { ok: true }; } },
      tablet: { hint(ctx) { ctx.spawn((c) => sync(c, 'tablet'), { self: 'tablet' }); return { ok: true }; } },
    },
    setup(sim) {
      // Push: hint every device whose watch is live. Best effort.
      Y.consumer(sim, 'changes', 'push', 'push', function* (ctx, msg) {
        const st = ctx.state;
        if (ctx.mode('dropHints')) { st.stats.hintsLost++; ctx.log({ op: `hints for history ${msg.payload.hid} lost`, status: 'lost', detail: 'No device is told about this change. It is safe in the history; the devices just do not know to ask.' }); return true; }
        const w = yield ctx.call('watch', 'active', {}, { timeout: 300, quiet: 'all' });
        const live = w.ok ? w.value.devs : [];
        for (const d of DEVS) {
          if (!live.includes(d)) {
            st.stats.noWatch++;
            if (!st.watchLapsed[d]) { st.watchLapsed[d] = ctx.now(); ctx.log({ op: `no live watch for the ${NAME[d]}`, status: 'warn', detail: `The ${NAME[d]}’s watch expired and nobody renewed it, so push has nobody to tell. There is no error: hints just stop.` }); }
            continue;
          }
          ctx.spawn(function* (c) { yield c.call(d, 'hint', { hid: msg.payload.hid }, { timeout: 600 }); }, { self: 'push' });
        }
        return true;
      });
      // Renewal job.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(RENEW_EVERY);
          if (!ctx.state.config.renew || ctx.mode('paused')) continue;
          yield ctx.call('watch', 'renew', {}, { timeout: 300, quiet: 'all' });
          ctx.state.watchLapsed = {};
        }
      }, { self: 'renew', quiet: 'all' });
      // Retention: trim history older than the window.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(200);
          const st = ctx.state;
          const ret = ctx.mode('shortRetention') ? SHORT_RET_MS : RET_MS;
          while (st.hist.length && st.hist[0].t < ctx.now() - ret) { st.histBase = st.hist[0].hid; st.hist.shift(); }
        }
      }, { self: 'hist', quiet: 'all' });
      // Polling fallback.
      for (const d of DEVS) {
        sim.spawn(function* (ctx) {
          for (;;) {
            yield ctx.wait(250);
            const v = ctx.state.dev[d];
            if (ctx.state.config.poll && ctx.now() - v.lastSync >= POLL_MS && !v.syncing && !offline(ctx.sim, d)) { v.lastSync = ctx.now(); ctx.spawn((c) => sync(c, d, true), { self: d, quiet: 'all' }); }
          }
        }, { self: d, quiet: 'all' });
      }
    },
    onFailureChange(sim, ch) {
      if (ch.active || !DEVS.includes(ch.node) || (ch.mode !== 'down' && ch.mode !== 'offline')) return;
      const d = ch.node;
      sim.spawn(function* (ctx) {
        if (d === 'phone') yield* flush(ctx);
        yield* saveDraft(ctx, d);
        yield* sync(ctx, d);
      }, { self: d });
    },
    consistency(sim) {
      const st = sim.state;
      const lines = Object.values(st.drafts).flatMap((d) => d.lines);
      const lost = st.savedLines.find((l) => !lines.includes(l));
      if (lost) return { key: 'wrong', label: `“${lost}” was saved to the draft and is now in no draft at all: a save from an older copy overwrote it (last write wins).` };
      const byTrace = {};
      for (const s of Object.values(st.sent)) byTrace[s.trace] = (byTrace[s.trace] || 0) + 1;
      const dup = Object.entries(byTrace).find(([, n]) => n > 1);
      if (dup) return { key: 'wrong', label: `“${Object.values(st.sent).find((s) => s.trace === dup[0]).subject}” was sent ${dup[1]} times: each retry after a lost reply made a new message.` };
      const truth = inboxOf(st.box);
      for (const d of DEVS) {
        const v = st.dev[d];
        if (v.cursor >= latest(st) && !v.syncing && JSON.stringify(inboxOf(v.msgs)) !== JSON.stringify(truth)) {
          const extra = inboxOf(v.msgs).filter((x) => !truth.includes(x)).map((x) => `“${v.msgs[x].subject}”`);
          const missing = truth.filter((x) => !inboxOf(v.msgs).includes(x)).map((x) => `“${st.box[x].subject}”`);
          return { key: 'wrong', label: `The ${NAME[d]} believes it is up to date (history ${v.cursor}) but ${extra.length ? `still shows ${extra.join(', ')}` : ''}${extra.length && missing.length ? ' and ' : ''}${missing.length ? `is missing ${missing.join(', ')}` : ''}. It skipped history it never saw, and nothing will ever bring it back.` };
        }
      }
      for (const d of DEVS) {
        const v = st.dev[d];
        const behind = latest(st) - v.cursor;
        if (behind > 0) {
          const why = offline(sim, d) ? `it is ${sim.nodes[d].modes.down ? 'off' : 'offline'}, and will ask for everything since ${v.cursor} when it is back` : st.watch[d] <= sim.now && !st.config.poll ? `its watch expired at ${(st.watch[d] / 1000).toFixed(1)} s and nobody renewed it, so push stopped telling it anything` : st.stats.hintsLost && !st.config.poll ? 'the push hint was lost and it does not poll' : 'it is catching up';
          return { key: 'stale', label: `The ${NAME[d]} is ${behind} change${behind > 1 ? 's' : ''} behind (cursor ${v.cursor}, mailbox at ${latest(st)}): ${why}.` };
        }
      }
      const out = st.dev.phone.outbox.length;
      if (out) return { key: 'stale', label: `${out} message${out > 1 ? 's wait' : ' waits'} in the phone’s outbox.` };
      const dirty = DEVS.find((d) => st.dev[d].draft.dirty);
      if (dirty) return { key: 'stale', label: `The ${NAME[dirty]} has draft edits it has not saved yet.` };
      const notes = [];
      if (st.stats.fullSyncs) notes.push(`${st.stats.fullSyncs} full sync after “gone”`);
      if (st.conflicts) notes.push(`a 409 kept the phone’s edit as a second draft, so both lines survive`);
      if (Object.keys(st.byClient).length && Object.keys(st.sent).length) notes.push(`${Object.keys(st.sent).length} queued message${Object.keys(st.sent).length > 1 ? 's' : ''} sent once each`);
      return { key: 'ok', label: `All three devices match the mailbox at history ${latest(st)}${notes.length ? `; ${notes.join('; ')}` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const behind = DEVS.filter((d) => st.dev[d].cursor < latest(st)).length;
      return [
        { label: 'Mailbox history id', value: latest(st) },
        { label: 'Oldest kept', value: st.histBase + 1 },
        { label: 'Cursors (phone, laptop, tablet)', value: DEVS.map((d) => st.dev[d].cursor).join(', ') },
        { label: 'Devices behind', value: behind, tone: behind ? 'warn' : '' },
        { label: '“Gone” answers', value: st.stats.gone, tone: st.stats.gone ? 'warn' : '' },
        { label: 'Full syncs', value: st.stats.fullSyncs },
        { label: 'Hints not sent (no watch)', value: st.stats.noWatch, tone: st.stats.noWatch ? 'warn' : '' },
        { label: 'Draft conflicts (409)', value: st.conflicts },
        { label: 'Messages sent', value: Object.keys(st.sent).length },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone'], ['laptop', 'Maya’s laptop']], {
          note: 'Archive or delete on one device and watch the others follow. Each shows its history cursor. The tablet (below) is the device that is usually off.',
          below: '<div class="ops-console" data-ref="tablet"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const list = (v) => `<div class="app-card">${inboxOf(v.msgs).map((id) => `<span class="app-sub"><strong>${esc(v.msgs[id].from)}</strong> · ${esc(v.msgs[id].subject)}${v.pending[id] ? ` · ${v.pending[id] === 'archive' ? 'archiving…' : 'deleting…'}` : ''}</span>`).join('<br>') || '<span class="app-sub">Inbox empty.</span>'}</div>`;
        const draft = (v) => `<div class="app-card"><strong>Draft${v.draft.id !== 'd1' ? ' (second copy)' : ''} · v${v.draft.base}${v.draft.dirty ? ' · unsaved' : ''}</strong><span class="app-sub">${v.draft.lines.map(esc).join(' / ')}</span></div>`;
        for (const d of ['phone', 'laptop']) {
          const v = st.dev[d];
          const off = offline(sim, d);
          Y.paint(el, sim, d, {
            head: `<div><p class="app-title">Inbox · ${inboxOf(v.msgs).length}</p><p class="app-sub">history ${v.cursor}${off ? ' · no signal' : ''}${st.watch[d] <= sim.now ? ' · watch expired' : ''}</p></div>`,
            act: `<div class="app-row">${Y.btn('archive', 'Archive top', { arg: { dev: d } })}${Y.btn('remove', 'Delete top', { arg: { dev: d }, cls: 'secondary' })}${Y.btn('refresh', '↻', { arg: { dev: d }, cls: 'secondary', disabled: off })}</div>`,
            inbox: list(v),
            draft: `${draft(v)}<div class="app-row">${Y.btn('draft', d === 'phone' ? 'Add “Bring the slides”' : 'Add “Venue: Room 4”', { arg: { dev: d }, cls: 'secondary' })}${d === 'phone' ? Y.btn('send', 'Send from outbox', { cls: 'secondary' }) : ''}</div>`,
            out: d === 'phone' && v.outbox.length ? `<p class="app-sub">Outbox: ${v.outbox.map((x) => esc(x.subject)).join(', ')}</p>` : '',
          }, {});
        }
        const t = st.dev.tablet;
        const c = sim.scenario.consistency(sim);
        const drafts = Object.values(st.drafts).map((d) => `${d.id} v${d.version}: ${d.lines.map(esc).join(' / ')}`).join('<br>');
        SDL.ui.paintSections(el.querySelector('[data-ref="tablet"]'), {
          title: `<p class="ops-title">Maya’s tablet · history ${t.cursor}${sim.nodes.tablet.modes.down ? ' · off' : ''}</p>`,
          rows: `<div class="ops-shards">
            <div class="ops-row"><div class="ops-name">Tablet inbox<span>${inboxOf(t.msgs).map((id) => esc(t.msgs[id].subject)).join(', ') || 'empty'}</span></div></div>
            <div class="ops-row" data-tone="${st.histBase ? 'warn' : ''}"><div class="ops-name">History log<span>at ${latest(st)} · oldest kept ${st.histBase + 1}${sim.nodes.hist.modes.shortRetention ? ` · keeps ${SHORT_RET_MS / 1000} s` : ''}</span></div></div>
            <div class="ops-row" data-tone="${DEVS.some((d) => st.watch[d] <= sim.now) ? 'warn' : ''}"><div class="ops-name">Watches<span>${DEVS.map((d) => `${NAME[d]} ${st.watch[d] > sim.now ? `until ${(st.watch[d] / 1000).toFixed(1)} s` : 'expired'}`).join(' · ')}</span></div></div>
            <div class="ops-row"><div class="ops-name">Drafts on the server<span>${drafts}</span></div></div></div>`,
          act: `<div class="app-row">${Y.btn('arrive', '✉ New mail arrives', { cls: 'secondary' })}${Y.btn('refresh', 'Tablet: refresh', { arg: { dev: 'tablet' }, cls: 'secondary', disabled: offline(sim, 'tablet') })}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };

  function append(ctx, e) {
    const st = ctx.state;
    const hid = ++st.hidSeq;
    st.hist.push(Object.assign({ hid, t: ctx.now() }, e));
    ctx.sim.enqueue('changes', { type: e.type, eventId: `h${hid}`, payload: { hid }, actionId: ctx.actionId });
    return hid;
  }
})(typeof window !== 'undefined' ? window : globalThis);
