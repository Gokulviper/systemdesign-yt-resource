/*
 * Notifications. An upload fans out to subscribers; each (user, channel)
 * becomes a send job with a dedupe key. Senders deliver through push, email,
 * and the in-app inbox. A per-user rate limit turns bursts into a digest;
 * when push fails, the in-app inbox still gets the message.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const SUBSCRIBERS = 2000;
  const LIMIT = 3;
  const WINDOW = 10000;

  function startPublish(sim, n) {
    const st = sim.state;
    for (let i = 0; i < (n || 1); i++) {
      const vid = 'vid-' + ++st.seq.video;
      sim.schedule(i * 150, () => sim.startAction(`Creator: publish ${vid}`, function* (ctx) {
        Y.L(ctx, { displayed: 'yes', retrySafe: ['yes', 'Every send job has a dedupe key: (video, user, channel).'] });
        const r = yield ctx.call('uploads', 'publish', { vid }, { timeout: 800 });
        if (r.ok) { st.sent[vid] = { t: ctx.now(), actionId: ctx.actionId }; Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', 'Fanning out to subscribers.'] }); }
        else Y.failed(ctx);
      }, { self: 'creator' }));
    }
  }

  const sc = (SDL.scenarios.notifications = {
    id: 'notifications',
    seed: 173,
    productWidth: 600,
    intro: 'Publish a video from the console. The upload fans out to 2,000 subscribers; your phone gets a push and an inbox entry. Then publish five in a row, or break the push provider.',
    topology: {
      width: 1100, height: 560,
      nodes: [
        { id: 'creator', label: 'Creator', sub: 'Publishes', kind: 'client', x: 100, y: 90, latency: 1, role: 'Publishes videos.', owns: ['Nothing'] },
        { id: 'uploads', label: 'Upload service', sub: 'Emits events', kind: 'service', x: 320, y: 90, latency: 4, role: 'Records the upload and emits an event.', ops: [{ name: 'publish', desc: 'New video.' }], owns: ['videos'] },
        { id: 'events', label: 'Upload events', sub: 'Event broker', kind: 'queue', x: 540, y: 90, latency: 4, queue: 'pubs', role: 'One event per published video.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['upload log'] },
        { id: 'fanout', label: 'Notification fan-out', sub: 'One job per subscriber', kind: 'worker', x: 760, y: 90, latency: 4, role: 'Looks up subscribers and their preferences and creates send jobs, applying the per-user limit.', ops: [{ name: 'consume', desc: 'Fan an upload out.' }], owns: ['Rate-limit counters'] },
        { id: 'sendq', label: 'Send queue', sub: 'Jobs', kind: 'queue', x: 760, y: 300, latency: 3, queue: 'sends', role: 'Send jobs waiting for a sender.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['send jobs'] },
        { id: 'sender', label: 'Senders', sub: 'Push, email, in-app', kind: 'worker', x: 540, y: 300, latency: 3, role: 'Delivers each job through its channel, skipping jobs already sent (dedupe store).', ops: [{ name: 'consume', desc: 'Deliver one job.' }], owns: ['Dedupe store'] },
        { id: 'push', label: 'Push provider', sub: 'APNs and FCM', kind: 'service', x: 320, y: 300, latency: 30, role: 'Apple and Google push services.', ops: [{ name: 'send', desc: 'Deliver a push.' }], owns: ['Device tokens'] },
        { id: 'email', label: 'Email provider', sub: 'SMTP API', kind: 'service', x: 540, y: 490, latency: 40, role: 'Sends email notifications.', ops: [{ name: 'send', desc: 'Send an email.' }], owns: ['Nothing'] },
        { id: 'inbox', label: 'In-app inbox', sub: 'Bell icon', kind: 'db', x: 320, y: 490, latency: 6, role: 'The notification list inside the app. Always reachable when the app opens.', ops: [{ name: 'add', desc: 'Add an entry.' }], owns: ['notifications'] },
        { id: 'phone', label: 'Your phone', sub: 'One subscriber', kind: 'client', x: 100, y: 400, latency: 1, role: 'One of the 2,000 subscribers.', ops: [{ name: 'push', desc: 'Show a push.' }], owns: ['Nothing'] },
      ],
      edges: [
        { from: 'creator', to: 'uploads', latency: 30 },
        { from: 'uploads', to: 'events', latency: 4 },
        { from: 'events', to: 'fanout', latency: 4 },
        { from: 'fanout', to: 'sendq', latency: 4 },
        { from: 'sendq', to: 'sender', latency: 3 },
        { from: 'sender', to: 'push', latency: 4 },
        { from: 'sender', to: 'email', latency: 4 },
        { from: 'sender', to: 'inbox', latency: 4 },
        { from: 'push', to: 'phone', latency: 30 },
        { from: 'inbox', to: 'phone', latency: 30, label: 'sync' },
      ],
      queues: [{ id: 'pubs', broker: 'events', label: 'uploads', groups: ['fanout'] }, { id: 'sends', broker: 'sendq', label: 'send jobs', groups: ['sender'] }],
    },
    failures: [
      { id: 'push-down', node: 'push', mode: 'down', label: 'Push provider outage', desc: 'Pushes fail; senders retry.' },
      { id: 'dup', node: 'sendq', mode: 'duplicate', label: 'Send jobs delivered twice', desc: 'As after a sender crash before acknowledging.' },
      { id: 'email-down', node: 'email', mode: 'down', label: 'Email provider down', desc: 'Emails fail; push and in-app are unaffected.' },
      { id: 'fanout-paused', node: 'fanout', mode: 'paused', label: 'Fan-out paused', desc: 'Notifications wait until it resumes.' },
    ],
    switches: Y.switches([
      ['dedupe', 'Deduplicate sends', 'Skip a job whose (video, user, channel) key was already delivered. Off: duplicates reach the phone.'],
      ['limit', 'Per-user rate limit with digest', `At most ${LIMIT} pushes per user per ${WINDOW / 1000} s; the rest are summarised in one digest.`],
      ['fallback', 'In-app fallback', 'If a push keeps failing, make sure the in-app inbox has it. Off: the push is retried only.'],
    ]),
    presets: Y.presets({ dedupe: true, limit: true, fallback: true }, [
      { id: 'publish', label: 'Publish a video', desc: 'One push, one inbox entry, one email per subscriber who wants it.', run: (s) => startPublish(s, 1) },
      { id: 'burst', label: 'Five uploads, rate limited', desc: 'Three pushes, then one digest for the rest. The inbox has all five.', run: (s) => startPublish(s, 5) },
      { id: 'burst-bad', label: 'Five uploads, no limit', desc: 'Five pushes in under a second. Subscribers mute the channel.', sw: { limit: false }, run: (s) => startPublish(s, 5) },
      { id: 'dup', label: 'Duplicate jobs, deduplicated', desc: 'Every job arrives twice; the dedupe store drops the copies.', run: (s) => { s.inject('sendq', 'duplicate'); startPublish(s, 1); } },
      { id: 'dup-bad', label: 'Duplicate jobs, no dedupe', desc: 'Your phone buzzes twice for the same video.', sw: { dedupe: false }, run: (s) => { s.inject('sendq', 'duplicate'); startPublish(s, 1); } },
      { id: 'push-down', label: 'Push outage, in-app fallback', desc: 'Pushes fail; the inbox entry is there anyway, and the push goes out when the provider recovers.', run: (s) => { s.inject('push', 'down', true, 3000); startPublish(s, 1); } },
      { id: 'email-down', label: 'Email down', desc: 'Email retries in the background; push and the inbox are unaffected.', run: (s) => { s.inject('email', 'down', true, 3000); startPublish(s, 1); } },
    ]),
    initialState: () => ({ config: { dedupe: true, limit: true, fallback: true }, sent: {}, delivered: {}, pushTimes: [], digestPending: [], inbox: [], emails: 0, others: 0, dupSkipped: 0, seq: { video: 0, job: 0 } }),
    initialUI: () => ({ phone: { pushes: [], banner: null } }),
    actions: { publish(sim, a) { startPublish(sim, (a && a.n) || 1); }, set: Y.setAction },
    handlers: {
      uploads: { publish(ctx, p) { ctx.sim.enqueue('pubs', { type: 'upload', eventId: 'u-' + p.vid, payload: p, actionId: ctx.actionId }); return { ok: true }; } },
      push: { send: function* (ctx, p) { if (p.user === 'you') return ctx.must(yield ctx.call('phone', 'push', p, { timeout: 500 })); return { delivered: true }; } },
      email: { send(ctx) { ctx.state.emails++; return { sent: true }; } },
      inbox: { add(ctx, p) { const st = ctx.state; if (p.user === 'you' && !st.inbox.some((x) => x.vid === p.vid)) st.inbox.push({ vid: p.vid, text: p.text, t: ctx.now() }); return { ok: true }; } },
      phone: {
        push(ctx, p) {
          const ui = ctx.ui.phone;
          ui.pushes.unshift({ text: p.text, t: ctx.now() });
          ui.banner = { title: 'Distributed Daily', body: p.text, tone: 'ok', t: ctx.now() };
          const st = ctx.state;
          st.pushTimes.push({ t: ctx.now(), key: p.key });
          if (st.pushTimes.filter((x) => ctx.now() - x.t < WINDOW && !x.key.startsWith('digest')).length > LIMIT) st.spam = true;
          return { shown: true };
        },
      },
    },
    setup(sim) {
      // Fan-out: your phone gets individual jobs; the other 1,999 subscribers are batched.
      Y.consumer(sim, 'pubs', 'fanout', 'fanout', function* (ctx, msg) {
        const st = ctx.state;
        const vid = msg.payload.vid;
        st.others += SUBSCRIBERS - 1;
        const recent = st.pushTimes.filter((x) => ctx.now() - x.t < WINDOW).length + st.digestPending.length + sim.queueStats('sends').depth / 3;
        const limited = st.config.limit && recent >= LIMIT;
        const jobs = [['inapp', `New video: ${vid}`], ['email', `New video: ${vid}`]];
        if (limited) {
          st.digestPending.push(vid);
          ctx.log({ op: `push for ${vid} held for digest`, status: 'note', actionId: msg.actionId, detail: `You already had ${LIMIT} pushes from this channel in ${WINDOW / 1000} s. This one joins a digest.` });
        } else jobs.unshift(['push', `New video: ${vid}`]);
        for (const [channel, text] of jobs) ctx.sim.enqueue('sends', { type: 'send', eventId: `${vid}/you/${channel}`, payload: { vid, user: 'you', channel, text, key: `${vid}/you/${channel}` }, actionId: msg.actionId });
        yield ctx.wait(SUBSCRIBERS / 400);
        return true;
      }, () => true);
      Y.consumer(sim, 'sends', 'sender', 'sender', function* (ctx, msg) {
        const st = ctx.state;
        const p = msg.payload;
        if (p.channel === 'push') {
          for (let a = 1; a <= 3; a++) {
            const r = yield ctx.call('push', 'send', p, { timeout: 800, actionId: msg.actionId });
            if (r.ok) { st.delivered[p.key] = (st.delivered[p.key] || 0) + 1; ctx.sim.setLedger(msg.actionId, 'async', 'yes', 'Push delivered.'); return true; }
            yield ctx.wait(200 * a);
          }
          if (st.config.fallback) {
            const has = st.inbox.some((x) => x.vid === p.vid);
            ctx.log({ op: `push for ${p.vid} failing`, status: 'retry', actionId: msg.actionId, detail: has ? 'The in-app inbox already has it; the push will be retried later.' : 'Making sure the in-app inbox has it while push is down.' });
            if (!has) yield ctx.call('inbox', 'add', p, { timeout: 500 });
          }
          return false;
        }
        if (p.channel === 'email') { const r = yield ctx.call('email', 'send', p, { timeout: 800 }); return r.ok; }
        const r = yield ctx.call('inbox', 'add', p, { timeout: 500, actionId: msg.actionId });
        return r.ok;
      }, (s) => s.state.config.dedupe);
      // Digest: one summary push once the window allows.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(500);
          const st = ctx.state;
          if (!st.digestPending.length) continue;
          const recent = st.pushTimes.filter((x) => ctx.now() - x.t < WINDOW).length;
          if (recent >= LIMIT && ctx.now() - st.digestPending.t0 < 3000) continue;
          const vids = st.digestPending.splice(0);
          ctx.sim.enqueue('sends', { type: 'send', eventId: `digest-${vids.join('+')}`, payload: { vid: vids.join('+'), user: 'you', channel: 'push', text: `${vids.length} more new videos from Distributed Daily`, key: `digest-${vids.join('+')}` } });
        }
      }, { self: 'fanout', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const pushes = sim.ui.phone.pushes;
      const keys = st.pushTimes.map((x) => x.key);
      if (new Set(keys).size < keys.length) return { key: 'wrong', label: 'Your phone received the same notification twice.' };
      if (st.spam) return { key: 'wrong', label: `More than ${LIMIT} pushes from one channel within ${WINDOW / 1000} s: notification spam.` };
      const published = Object.keys(st.sent);
      const missingInbox = published.filter((v) => !st.inbox.some((x) => x.vid === v));
      if (missingInbox.length || sim.queueStats('sends').depth || sim.queueStats('pubs').depth || st.digestPending.length) return { key: 'stale', label: `Notifications still on their way${missingInbox.length ? ` (${missingInbox.join(', ')} not yet in the inbox)` : ''}.` };
      void pushes;
      return { key: 'ok', label: 'Every subscriber was told once, through the channels they chose, without spam.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      return [
        { label: 'Pushes on your phone', value: sim.ui.phone.pushes.length },
        { label: 'Inbox entries', value: st.inbox.length },
        { label: 'Other subscribers notified', value: Y.num(st.others) },
        { label: 'Duplicates dropped', value: st.dupSkipped || 0 },
        { label: 'Send queue', value: sim.queueStats('sends').depth },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Your phone']], { note: 'Pushes appear as banners; the bell inbox lists everything, even when push is down.', side: '<p class="ops-title">Creator</p><div class="ops-traffic"><button class="btn btn-primary" data-act="publish" data-arg=\'{"n":1}\'>Publish a video</button><button class="btn" data-act="publish" data-arg=\'{"n":5}\'>Publish five in a row</button></div><p class="recon">2,000 subscribers. Your phone is one of them.</p>' });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const ui = sim.ui.phone;
        const body = `<p class="app-sub">Pushes received</p>${ui.pushes.slice(0, 4).map((p) => `<div class="app-card is-ok">${esc(p.text)}</div>`).join('') || '<p class="app-sub">None yet.</p>'}
          <p class="app-sub">🔔 Inbox (${st.inbox.length})</p>${st.inbox.slice(-4).reverse().map((n) => `<div class="app-card">${esc(n.text)}</div>`).join('')}`;
        Y.paint(el, sim, 'phone', { head: '<div><p class="app-title">YouTube</p><p class="app-sub">Notifications</p></div>', body }, {}, ui.banner);
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
