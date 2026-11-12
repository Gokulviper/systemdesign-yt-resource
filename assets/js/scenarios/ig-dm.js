/*
 * Direct messages.
 * Three phones hold WebSockets to a gateway. A message carries a client id so
 * a retry cannot create a second bubble; the server gives it a sequence
 * number within its thread so every device shows the same order, even when
 * one phone's clock is wrong. Store-then-deliver means a message a recipient
 * has seen can never be lost. Offline recipients get a push and an inbox
 * entry that syncs on reconnect. Ticks: sent, delivered, seen.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const PEOPLE = { dev: 'Dev', maya: 'Maya', sam: 'Sam' };
  const THREADS = { dm: { label: 'Maya', members: ['dev', 'maya'] }, trip: { label: 'Weekend trip', members: ['dev', 'maya', 'sam'] } };
  const CLOCK_SKEW = { dev: 0, maya: 0, sam: -1500 }; // Sam's phone clock is 1.5 s behind
  const online = (sim, who) => !sim.nodes[who].modes.down;

  function startSend(sim, from, thread, text, opts) {
    opts = opts || {};
    const st = sim.state;
    const clientMsgId = opts.clientMsgId || `${from}-${++st.seq.client}`;
    sim.startAction(`${PEOPLE[from]}: “${text}”${opts.retry ? ' (retry)' : ''}`, function* (ctx) {
      const u = ctx.ui[from];
      const sentAt = ctx.now() + CLOCK_SKEW[from];
      if (!opts.retry) u.threads[thread].push({ clientMsgId, from, text, sentAt, state: 'sending', seqNo: null });
      Y.L(ctx, { displayed: ['yes', 'Optimistic: the bubble appears at once with one grey tick.'], retrySafe: st.config.idem ? ['yes', `Client message id ${clientMsgId}: a retry returns the same message.`] : ['no', 'No client id: a retry is a new message.'] });
      const r = yield ctx.call('gw', 'send', { clientMsgId, thread, from, text, sentAt }, { timeout: 1200 });
      ctx.recordOutcome(r.ok, r.latency);
      const mine = u.threads[thread].find((m) => m.clientMsgId === clientMsgId);
      if (r.ok) {
        Object.assign(mine, { state: mine.state === 'sending' ? 'sent' : mine.state, seqNo: r.value.seqNo, serverId: r.value.id });
        Y.L(ctx, { accepted: 'yes', committed: r.value.stored ? ['yes', `Message ${r.value.id}, sequence ${r.value.seqNo} in thread “${THREADS[thread].label}”.`] : ['no', 'Delivered before storing; the store failed.'], async: ['pending', 'Delivery and receipts.'] });
        ctx.explain(r.value.replayed
          ? 'The retry carried the same client message id, so the server returned the message it already had instead of creating another. One bubble on every phone.'
          : `${st.config.storeFirst ? 'The server stored the message, then delivered it' : 'The server delivered the message first, then stored it'}. ${st.config.sequence ? `It was given sequence number ${r.value.seqNo} in this thread; every device sorts by that number, so they all show the same order.` : 'Devices sort by the sender’s timestamp, so a phone with a wrong clock puts its messages in the wrong place on everyone’s screen.'}`);
      } else {
        if (st.config.idem && r.error.code === 'TIMEOUT') {
          ctx.log({ op: 'no reply: retrying with the same client id', status: 'retry', detail: 'The app cannot tell whether the message arrived, so it sends it again with the same id.' });
          yield ctx.wait(300);
          const again = yield ctx.call('gw', 'send', { clientMsgId, thread, from, text, sentAt }, { timeout: 1200 });
          if (again.ok) { Object.assign(mine, { state: mine.state === 'sending' ? 'sent' : mine.state, seqNo: again.value.seqNo, serverId: again.value.id }); Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', 'Delivery and receipts.'] }); ctx.explain(again.value.replayed ? 'The first send did arrive; only its reply was lost. The retry carried the same client message id, so the server returned the existing message and nobody saw a duplicate.' : 'The first send never arrived; the retry created the message.'); return; }
        }
        if (!st.config.idem && r.error.code === 'TIMEOUT') {
          ctx.log({ op: 'no reply: retrying as a new message', status: 'retry', detail: 'Without a client id the retry is indistinguishable from a new message.' });
          yield ctx.wait(300);
          const again = yield ctx.call('gw', 'send', { clientMsgId: clientMsgId + '-r', thread, from, text, sentAt }, { timeout: 1200 });
          if (again.ok) { Object.assign(mine, { state: 'sent', seqNo: again.value.seqNo }); Y.L(ctx, { accepted: 'yes', committed: 'yes' }); ctx.explain('The first send did arrive; only its reply was lost. The retry had no way to say “this is the same message”, so the server stored and delivered it again: two bubbles for everyone.'); return; }
        }
        mine.state = 'failed';
        Y.failed(ctx, 'The bubble shows “Not delivered. Tap to retry”.');
        ctx.explain(r.error.code === 'UNAVAILABLE' && ctx.sim.nodes.msgdb.modes.down ? 'The messages database is down and the server stores before delivering, so it refused the message. Nobody saw it, nothing is lost, and the sender knows to try again.' : `The send failed: ${r.error.message}`);
      }
    }, { self: from });
  }

  function startOpen(sim, who, thread) {
    const u = sim.ui[who];
    u.open = thread;
    const unseen = u.threads[thread].filter((m) => m.from !== who && !m.seenSent);
    if (!unseen.length) return;
    sim.spawn(function* (ctx) {
      for (const m of unseen) m.seenSent = true;
      yield ctx.call('gw', 'receipt', { thread, from: who, kind: 'seen', ids: unseen.map((m) => m.serverId).filter(Boolean) }, { timeout: 800, quiet: true });
    }, { self: who, quiet: true });
  }

  const sc = (SDL.scenarios['ig-dm'] = {
    id: 'ig-dm',
    seed: 619,
    productWidth: 640,
    intro: 'Send a message from Dev to Maya and watch the ticks: sent, delivered, seen when she opens the thread. Then take Maya offline, lose a reply and retry, or ask a question in the group and let Sam, whose clock is wrong, answer.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'dev', label: 'Dev’s phone', sub: 'Socket open', kind: 'client', x: 90, y: 60, latency: 1, role: 'Sends and receives over a WebSocket.', ops: [{ name: 'receive', desc: 'A message arrives.' }, { name: 'receipt', desc: 'A delivery or seen receipt.' }], owns: ['Local thread copies'] },
        { id: 'maya', label: 'Maya’s phone', sub: 'Socket open', kind: 'client', x: 90, y: 300, latency: 1, role: 'Sends and receives. Can go offline.', ops: [{ name: 'receive', desc: 'A message arrives.' }, { name: 'receipt', desc: 'A receipt.' }, { name: 'notification', desc: 'A push while offline.' }], owns: ['Local thread copies'] },
        { id: 'sam', label: 'Sam’s phone', sub: 'Clock 1.5 s behind', kind: 'client', x: 90, y: 540, latency: 1, role: 'In the group only. His phone’s clock is wrong.', ops: [{ name: 'receive', desc: 'A message arrives.' }, { name: 'receipt', desc: 'A receipt.' }], owns: ['Local thread copies'] },
        { id: 'gw', label: 'Messaging gateway', sub: 'WebSockets', kind: 'gateway', x: 320, y: 300, latency: 2, role: 'Holds every phone’s socket; forwards sends to the message service and pushes messages and receipts down sockets.', ops: [{ name: 'send', desc: 'A new message.' }, { name: 'receipt', desc: 'Delivered or seen.' }, { name: 'push', desc: 'Write to a socket.' }, { name: 'sync', desc: 'Fetch missed messages.' }], owns: ['Open sockets'] },
        { id: 'msgsvc', label: 'Message service', sub: 'Store, sequence, deliver', kind: 'service', x: 560, y: 300, latency: 4, role: 'Deduplicates by client id, takes a sequence number, stores, delivers to each member, and tracks receipts.', ops: [{ name: 'send', desc: 'Handle a send.' }, { name: 'receipt', desc: 'Record a receipt.' }, { name: 'sync', desc: 'Missed messages for a user.' }], owns: ['Delivery rules'] },
        { id: 'seqsvc', label: 'Thread sequencer', sub: 'Per-thread counter', kind: 'service', x: 800, y: 120, latency: 3, role: 'Hands out the next sequence number in a thread, so every device sorts messages the same way.', ops: [{ name: 'next', desc: 'Next sequence number.' }], owns: ['seq[thread]'] },
        { id: 'msgdb', label: 'Messages DB', sub: 'By thread, by sequence', kind: 'db', x: 800, y: 300, latency: 8, role: 'The durable copy. Phones that were offline catch up from it.', ops: [{ name: 'insert', desc: 'Store a message.' }, { name: 'byClient', desc: 'Find by client id.' }, { name: 'after', desc: 'Messages a user has missed.' }], owns: ['messages', 'client ids'] },
        { id: 'presence', label: 'Presence', sub: 'Who is connected', kind: 'cache', x: 560, y: 120, latency: 2, role: 'Which users currently hold a socket.', ops: [{ name: 'lookup', desc: 'Is the user online?' }], owns: ['online[user]'] },
        { id: 'inbox', label: 'Offline inbox', sub: 'Undelivered', kind: 'db', x: 800, y: 470, latency: 5, role: 'Message ids a user has not received yet, drained when they reconnect.', ops: [{ name: 'add', desc: 'Queue for an offline user.' }, { name: 'drain', desc: 'Hand over missed messages.' }], owns: ['pending[user]'] },
        { id: 'push', label: 'Push provider', sub: 'APNs and FCM', kind: 'service', x: 320, y: 500, latency: 40, role: 'Notifies a phone that is offline or in the background.', ops: [{ name: 'notify', desc: 'Send a push.' }], owns: ['Device tokens'] },
      ],
      edges: [
        { from: 'dev', to: 'gw', latency: 30 },
        { from: 'maya', to: 'gw', latency: 30 },
        { from: 'sam', to: 'gw', latency: 30 },
        { from: 'gw', to: 'msgsvc', latency: 3 },
        { from: 'msgsvc', to: 'seqsvc', latency: 3 },
        { from: 'msgsvc', to: 'msgdb', latency: 4 },
        { from: 'msgsvc', to: 'presence', latency: 3 },
        { from: 'msgsvc', to: 'inbox', latency: 4 },
        { from: 'msgsvc', to: 'push', latency: 5, via: [[560, 500]] },
        { from: 'push', to: 'maya', latency: 40, via: [[200, 500], [200, 340]] },
      ],
      queues: [],
    },
    failures: [
      { id: 'maya-off', node: 'maya', mode: 'down', label: 'Maya offline', desc: 'Her socket drops; messages wait in the inbox and a push goes out.' },
      { id: 'svc-drop', node: 'msgsvc', mode: 'dropResponse', label: 'Message service replies lost', desc: 'Sends are handled but the sender gets no reply and retries.' },
      { id: 'msgsvc-hang', node: 'msgsvc', mode: 'hang', label: 'Message service hangs', desc: 'Sends time out.' },
      { id: 'db-down', node: 'msgdb', mode: 'down', label: 'Messages DB down', desc: 'Nothing can be stored.' },
      { id: 'db-slow', node: 'msgdb', mode: 'slow', params: { factor: 40 }, label: 'Messages DB slow', desc: 'Storing takes hundreds of milliseconds.' },
      { id: 'seq-down', node: 'seqsvc', mode: 'down', label: 'Sequencer down', desc: 'No sequence numbers: sends fail under server ordering.' },
      { id: 'push-down', node: 'push', mode: 'down', label: 'Push provider down', desc: 'Offline phones are not woken; the inbox still syncs on reconnect.' },
    ],
    switches: Y.switches([
      ['idem', 'Client message id', 'Each message carries an id made on the phone; the server returns the existing message for a repeat. Off: a retry is a new message.'],
      ['sequence', 'Server sequence numbers', 'The server numbers messages within a thread and every device sorts by that number. Off: devices sort by the sender’s clock.'],
      ['storeFirst', 'Store, then deliver', 'Write the message to the database before pushing it to anyone. Off: push first, store after.'],
    ]),
    presets: Y.presets({ idem: true, sequence: true, storeFirst: true }, [
      { id: 'chat', label: 'Send, deliver, seen', desc: 'Dev writes to Maya. One tick when the server stores it, two when her phone has it, “Seen” when she opens the thread.', run: (s) => { startSend(s, 'dev', 'dm', 'Hey! Still on for Saturday?'); s.schedule(1500, () => startOpen(s, 'maya', 'dm')); s.schedule(2200, () => startSend(s, 'maya', 'dm', 'Yes! 10 at the station?')); } },
      { id: 'offline', label: 'Maya offline, then back', desc: 'Her socket is gone, so the message waits in the inbox and a push wakes her phone. When she reconnects, it syncs.', run: (s) => { s.inject('maya', 'down', true, 3000); s.schedule(500, () => startSend(s, 'dev', 'dm', 'Running 10 min late')); } },
      { id: 'offline-stays', label: 'Maya stays offline', desc: 'The message is stored and waiting; her phone has been told by push. Nothing more can happen until she reconnects.', run: (s) => { s.inject('maya', 'down'); s.schedule(500, () => startSend(s, 'dev', 'dm', 'Running 10 min late')); } },
      { id: 'push-down', label: 'Maya offline, push down', desc: 'No push reaches her, but the inbox still holds the message and delivers it when she reconnects.', run: (s) => { s.inject('push', 'down'); s.inject('maya', 'down', true, 3000); s.schedule(500, () => startSend(s, 'dev', 'dm', 'Running 10 min late')); } },
      { id: 'retry', label: 'Lost reply, client id', desc: 'The send arrives but its reply is lost. The retry carries the same id; the server returns the existing message. One bubble.', run: (s) => { s.inject('msgsvc', 'dropResponse', true, 900); startSend(s, 'dev', 'dm', 'Hey! Still on for Saturday?'); } },
      { id: 'retry-bad', label: 'Lost reply, no client id', desc: 'The retry is a brand-new message to the server: Maya gets it twice, Dev sees it twice.', sw: { idem: false }, run: (s) => { s.inject('msgsvc', 'dropResponse', true, 900); startSend(s, 'dev', 'dm', 'Hey! Still on for Saturday?'); } },
      { id: 'group', label: 'Group chat, server sequence numbers', desc: 'Dev asks, Sam answers. Sam’s clock is 1.5 s behind, but the server numbered the messages, so every phone shows the answer after the question.', run: (s) => { for (const w of ['dev', 'maya']) s.ui[w].open = 'trip'; startSend(s, 'dev', 'trip', 'Where are you two?'); s.schedule(800, () => startSend(s, 'sam', 'trip', 'At the station, platform 3')); s.schedule(1600, () => startSend(s, 'maya', 'trip', 'Parking now')); } },
      { id: 'group-bad', label: 'Group chat, sorted by sender clocks', desc: 'Sam’s answer carries a timestamp from before Dev’s question. Every phone shows the answer first.', sw: { sequence: false }, run: (s) => { for (const w of ['dev', 'maya']) s.ui[w].open = 'trip'; startSend(s, 'dev', 'trip', 'Where are you two?'); s.schedule(800, () => startSend(s, 'sam', 'trip', 'At the station, platform 3')); s.schedule(1600, () => startSend(s, 'maya', 'trip', 'Parking now')); } },
      { id: 'db-down', label: 'Database down, store first', desc: 'The server cannot store the message, so it refuses it. Dev sees “Not delivered”; nothing is lost.', run: (s) => { s.inject('msgdb', 'down'); startSend(s, 'dev', 'dm', 'Hey! Still on for Saturday?'); } },
      { id: 'db-down-bad', label: 'Database down, deliver first', desc: 'Maya’s phone gets the message, then the store fails. Her next sync from the database will not have it: a message she saw no longer exists.', sw: { storeFirst: false }, run: (s) => { s.inject('msgdb', 'down'); startSend(s, 'dev', 'dm', 'Hey! Still on for Saturday?'); } },
      { id: 'db-slow', label: 'Database slow, store first', desc: 'Storing takes a third of a second before anyone is told. Maya gets it late, but once.', run: (s) => { s.inject('msgdb', 'slow', { factor: 40 }); startSend(s, 'dev', 'dm', 'Hey! Still on for Saturday?'); } },
    ]),
    initialState: () => ({
      config: { idem: true, sequence: true, storeFirst: true },
      messages: {}, byClient: {}, seq: { client: 0, msg: 0, thread: { dm: 0, trip: 0 } },
      arrival: { dm: [], trip: [] }, inbox: { dev: [], maya: [], sam: [] }, lost: [],
      stats: { delivered: 0, pushes: 0, synced: 0, dups: 0 },
    }),
    initialUI: () => {
      const phone = (who) => ({ open: 'dm', threads: { dm: [], trip: [] }, banner: null, who });
      return { dev: phone('dev'), maya: phone('maya'), sam: phone('sam') };
    },
    actions: {
      send(sim, a) { startSend(sim, a.from, a.thread, a.text); },
      open(sim, a) { startOpen(sim, a.who, a.thread); },
      set(sim, a) {
        if (/\.open$/.test(a.field)) { startOpen(sim, a.field.split('.')[0], a.value); return; }
        Y.setAction(sim, a);
      },
    },
    onFailureChange(sim, e) {
      if (e.mode !== 'down' || !PEOPLE[e.node] || e.active) return;
      // A phone reconnected: drain its inbox.
      sim.spawn(function* (ctx) {
        const r = yield ctx.call('gw', 'sync', { user: e.node }, { timeout: 1000 });
        if (r.ok && r.value.messages.length) ctx.log({ op: `${PEOPLE[e.node]} synced ${r.value.messages.length} message${r.value.messages.length > 1 ? 's' : ''}`, status: 'recovered', detail: 'Waiting in the inbox while the phone was offline; delivered on reconnect.' });
      }, { self: e.node });
    },
    handlers: {
      gw: {
        send: function* (ctx, p) { return ctx.must(yield ctx.call('msgsvc', 'send', p, { timeout: 1100 })); },
        receipt: function* (ctx, p) { return ctx.must(yield ctx.call('msgsvc', 'receipt', p, { timeout: 700 })); },
        push: function* (ctx, p) {
          if (!online(ctx.sim, p.to)) ctx.fail('SOCKET_CLOSED', `${PEOPLE[p.to]}’s socket is closed.`);
          return ctx.must(yield ctx.call(p.to, p.kind === 'message' ? 'receive' : 'receipt', p, { timeout: 500 }));
        },
        sync: function* (ctx, p) { return ctx.must(yield ctx.call('msgsvc', 'sync', p, { timeout: 900 })); },
      },
      msgsvc: {
        send: function* (ctx, p) {
          const st = ctx.state;
          if (st.config.idem && st.byClient[p.clientMsgId]) { const m = st.messages[st.byClient[p.clientMsgId]]; return { id: m.id, seqNo: m.seqNo, stored: true, replayed: true }; }
          let seqNo = p.sentAt;
          if (st.config.sequence) seqNo = ctx.must(yield ctx.call('seqsvc', 'next', { thread: p.thread }, { timeout: 500 })).seqNo;
          const id = 'm' + ++st.seq.msg;
          const m = { id, thread: p.thread, from: p.from, text: p.text, seqNo, sentAt: p.sentAt, clientMsgId: p.clientMsgId, t: ctx.now(), deliveredTo: [], seenBy: [], stored: false };
          st.messages[id] = m;
          st.arrival[p.thread].push(id);
          st.byClient[p.clientMsgId] = id;
          let stored = true;
          if (st.config.storeFirst) { ctx.must(yield ctx.call('msgdb', 'insert', m, { timeout: 900 })); m.stored = true; }
          yield* deliver(ctx, m);
          if (!st.config.storeFirst) { const w = yield ctx.call('msgdb', 'insert', m, { timeout: 900 }); if (w.ok) m.stored = true; else { stored = false; st.lost.push(id); ctx.log({ op: `${id} delivered but not stored`, status: 'err', detail: 'Recipients already have it; the database never will. The next sync from the database loses it.' }); } }
          return { id, seqNo, stored };
        },
        receipt: function* (ctx, p) {
          const st = ctx.state;
          for (const id of p.ids) {
            const m = st.messages[id];
            if (!m) continue;
            const list = p.kind === 'seen' ? m.seenBy : m.deliveredTo;
            if (!list.includes(p.from)) list.push(p.from);
            if (online(ctx.sim, m.from) && m.from !== p.from) yield ctx.call('gw', 'push', { to: m.from, kind: 'receipt', id, receipt: p.kind, by: p.from }, { timeout: 500, quiet: true });
          }
          return { ok: true };
        },
        sync: function* (ctx, p) {
          const st = ctx.state;
          const d = ctx.must(yield ctx.call('inbox', 'drain', { user: p.user }, { timeout: 600 }));
          const rows = ctx.must(yield ctx.call('msgdb', 'after', { ids: d.ids }, { timeout: 600 }));
          for (const m of rows.messages) {
            const r = yield ctx.call('gw', 'push', { to: p.user, kind: 'message', message: m }, { timeout: 500 });
            if (r.ok) { st.stats.synced++; yield* markDelivered(ctx, m, p.user); }
          }
          return { messages: rows.messages };
        },
      },
      seqsvc: { next(ctx, p) { return { seqNo: ++ctx.state.seq.thread[p.thread] }; } },
      msgdb: {
        insert(ctx, m) { ctx.state.messages[m.id].stored = true; return { stored: true }; },
        byClient(ctx, p) { return { id: ctx.state.byClient[p.clientMsgId] || null }; },
        after(ctx, p) { return { messages: p.ids.map((id) => ctx.state.messages[id]).filter((m) => m && m.stored) }; },
      },
      presence: { lookup(ctx, p) { return { online: online(ctx.sim, p.user) }; } },
      inbox: {
        add(ctx, p) { ctx.state.inbox[p.user].push(p.id); return { queued: true }; },
        drain(ctx, p) { const ids = ctx.state.inbox[p.user].splice(0); return { ids }; },
      },
      push: {
        notify: function* (ctx, p) {
          ctx.state.stats.pushes++;
          const u = ctx.ui[p.to];
          u.banner = { title: PEOPLE[p.from], body: p.text, tone: 'ok', t: ctx.now() };
          return { sent: true };
        },
      },
      dev: phoneHandlers('dev'), maya: phoneHandlers('maya'), sam: phoneHandlers('sam'),
    },
    consistency(sim) {
      const st = sim.state;
      for (const who of Object.keys(PEOPLE)) for (const [thread, list] of Object.entries(sim.ui[who].threads)) {
        const ids = list.map((m) => m.clientMsgId.replace(/-r$/, ''));
        const dup = ids.find((x, i) => ids.indexOf(x) !== i);
        if (dup) return { key: 'wrong', label: `${PEOPLE[who]}’s phone shows the same message twice in “${THREADS[thread].label}”: a retry without a client id became a second message.` };
        const shown = list.filter((m) => m.serverId).slice().sort((a, b) => a.seqNo - b.seqNo || a.sentAt - b.sentAt).map((m) => m.serverId);
        const server = st.arrival[thread].filter((id) => shown.includes(id));
        if (shown.join() !== server.join()) return { key: 'wrong', label: `${PEOPLE[who]}’s phone shows “${st.messages[shown[0]].text}” before “${st.messages[server[0]].text}”, the opposite of the order the server received them. Sorting by sender clocks put Sam’s answer before the question.` };
      }
      if (st.lost.length) return { key: 'wrong', label: `${st.lost.length} message${st.lost.length > 1 ? 's were' : ' was'} delivered and seen but never stored. The next sync from the database will not have ${st.lost.length > 1 ? 'them' : 'it'}.` };
      const waiting = Object.entries(st.inbox).filter(([, ids]) => ids.length);
      if (waiting.length) return { key: 'stale', label: `${waiting.map(([u, ids]) => `${ids.length} message${ids.length > 1 ? 's' : ''} waiting for ${PEOPLE[u]}`).join('; ')}: stored, pushed, and delivered as soon as the phone reconnects.` };
      const sending = Object.values(sim.ui).some((u) => Object.values(u.threads).some((l) => l.some((m) => m.state === 'sending')));
      if (sending) return { key: 'stale', label: 'A message is still being sent.' };
      const failed = Object.values(sim.ui).some((u) => Object.values(u.threads).some((l) => l.some((m) => m.state === 'failed')));
      if (failed) return { key: 'ok', label: 'A send was refused and the sender was told. Nothing was delivered that is not stored, and nothing was lost.' };
      return { key: 'ok', label: 'Every phone shows every message once, in the same order, and every delivered message is stored.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const msgs = Object.values(st.messages);
      const lat = msgs.filter((m) => m.deliveredAt).map((m) => m.deliveredAt - m.t);
      return [
        { label: 'Messages', value: msgs.length },
        { label: 'Send to delivered (p50)', value: lat.length ? SDL.fmtMs(SDL.percentile(lat, 50)) : 'n/a' },
        { label: 'Waiting in inboxes', value: Object.values(st.inbox).reduce((a, l) => a + l.length, 0) },
        { label: 'Pushes sent', value: st.stats.pushes },
        { label: 'Synced on reconnect', value: st.stats.synced },
        { label: 'Delivered but not stored', value: st.lost.length, tone: st.lost.length ? 'fail' : '' },
        { label: 'Retries', value: sim.retries },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['dev', 'Dev'], ['maya', 'Maya']], {
          note: 'Each phone shows one thread at a time: the direct chat between Dev and Maya, or the “Weekend trip” group with all three. Ticks on your own bubbles: ✓ sent, ✓✓ delivered, “Seen”. Sam, the third member of the group, is in the console below.',
          below: '<div class="ops-console"><p class="ops-title">Sam’s phone · Weekend trip · clock 1.5 s behind</p><div data-ref="sam"></div></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const sorted = (list) => list.slice().sort((a, b) => (a.seqNo == null ? Infinity : a.seqNo) - (b.seqNo == null ? Infinity : b.seqNo) || a.sentAt - b.sentAt);
        for (const who of ['dev', 'maya']) {
          const u = sim.ui[who];
          const thread = u.open;
          const list = sorted(u.threads[thread]);
          const members = THREADS[thread].members.filter((m) => m !== who);
          const tick = (m) => {
            if (m.from !== who) return '';
            const srv = m.serverId && st.messages[m.serverId];
            if (m.state === 'failed') return '<span class="app-sub">✕ Not delivered. Tap to retry</span>';
            if (!srv) return '<span class="app-sub">○ sending</span>';
            const seen = members.every((x) => srv.seenBy.includes(x));
            const delivered = members.every((x) => srv.deliveredTo.includes(x));
            return `<span class="app-sub">${seen ? 'Seen' : delivered ? '✓✓ delivered' : '✓ sent'}</span>`;
          };
          const bubbles = list.map((m) => `<div class="app-card ${m.from === who ? 'is-ok' : ''}"${m.from === who ? ' style="margin-left:24px"' : ' style="margin-right:24px"'}><span class="app-sub">${esc(PEOPLE[m.from])}${m.seqNo != null && st.config.sequence ? ` · #${m.seqNo}` : ''}</span><strong>${esc(m.text)}</strong>${tick(m)}</div>`).join('');
          const tabs = `<label class="app-sub" for="th-${who}">Thread</label> <select id="th-${who}" data-field="${who}.open">${Object.entries(THREADS).filter(([, t]) => t.members.includes(who)).map(([k, t]) => `<option value="${k}"${u.open === k ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`;
          const canned = { dm: who === 'dev' ? 'Hey! Still on for Saturday?' : 'Yes! 10 at the station?', trip: who === 'dev' ? 'Where are you two?' : who === 'sam' ? 'At the station, platform 3' : 'Parking now' }[thread];
          Y.paint(el, sim, who, {
            head: `<div><p class="app-title">${esc(THREADS[thread].label)}</p><p class="app-sub">${online(sim, who) ? 'Connected' : 'Offline'}${who === 'sam' ? ' · clock 1.5 s behind' : ''}</p></div>`,
            tabs: `<div class="app-row">${tabs}</div>`,
            bubbles: bubbles || '<p class="app-sub">No messages yet.</p>',
            send: Y.btn('send', `Send “${esc(canned)}”`, { arg: { from: who, thread, text: canned }, cls: 'go' }),
          }, {}, u.banner);
        }
        const sam = sim.ui.sam;
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="sam"]'), {
          rows: `<div class="ops-shards">${sorted(sam.threads.trip).map((m) => `<div class="ops-row" data-tone="${m.from === 'sam' ? 'ok' : ''}"><div class="ops-name">${esc(PEOPLE[m.from])}${m.seqNo != null && st.config.sequence ? ` #${m.seqNo}` : ''}<span>${esc(m.text)}${m.from === 'sam' ? ` · ${m.state === 'failed' ? 'not delivered' : m.serverId ? 'sent' : 'sending'}` : ''}</span></div></div>`).join('') || '<p class="app-sub">No group messages yet.</p>'}</div>`,
          send: `<div class="app-row">${Y.btn('send', 'Sam sends “At the station, platform 3”', { arg: { from: 'sam', thread: 'trip', text: 'At the station, platform 3' } })}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  function* deliver(ctx, m) {
    const st = ctx.state;
    for (const to of THREADS[m.thread].members) {
      if (to === m.from) continue;
      const pr = yield ctx.call('presence', 'lookup', { user: to }, { timeout: 300 });
      const isOnline = pr.ok && pr.value.online;
      if (isOnline) {
        const r = yield ctx.call('gw', 'push', { to, kind: 'message', message: m }, { timeout: 600 });
        if (r.ok) { yield* markDelivered(ctx, m, to); continue; }
      }
      yield ctx.call('inbox', 'add', { user: to, id: m.id }, { timeout: 400 });
      yield ctx.call('push', 'notify', { to, from: m.from, text: m.text }, { timeout: 800 });
      ctx.log({ op: `${m.id} queued for ${PEOPLE[to]}`, status: 'note', detail: `${PEOPLE[to]} is offline: inbox entry written and a push sent.` });
    }
    void st;
  }
  function* markDelivered(ctx, m, to) {
    const st = ctx.state;
    if (!m.deliveredTo.includes(to)) m.deliveredTo.push(to);
    m.deliveredAt = m.deliveredAt || ctx.now();
    st.stats.delivered++;
    if (online(ctx.sim, m.from)) yield ctx.call('gw', 'push', { to: m.from, kind: 'receipt', id: m.id, receipt: 'delivered', by: to }, { timeout: 500, quiet: true });
  }
  function phoneHandlers(who) {
    return {
      receive(ctx, p) {
        const u = ctx.ui[who];
        const m = p.message;
        const list = u.threads[m.thread];
        if (list.some((x) => x.serverId === m.id)) return { duplicate: true };
        list.push({ clientMsgId: m.clientMsgId, serverId: m.id, from: m.from, text: m.text, sentAt: m.sentAt, seqNo: m.seqNo, state: 'received' });
        if (u.open !== m.thread) u.banner = { title: PEOPLE[m.from], body: m.text, tone: 'ok', t: ctx.now() };
        return { received: true };
      },
      receipt(ctx, p) {
        const u = ctx.ui[who];
        for (const list of Object.values(u.threads)) { const m = list.find((x) => x.serverId === p.id); if (m) m.state = p.receipt; }
        return { ok: true };
      },
      notification(ctx, p) { ctx.ui[who].banner = { title: PEOPLE[p.from], body: p.text, tone: 'ok', t: ctx.now() }; return { shown: true }; },
    };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
