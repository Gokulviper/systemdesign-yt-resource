/*
 * End-to-end: one notification, five channels.
 * Product teams call one API. The API stores the request together with an
 * outbox row; a relay turns the row into one send job per channel; workers
 * render the template, read preferences and device tokens, call the push,
 * email, and SMS providers, and write the in-app inbox. The team is told
 * "accepted" once the request is durable, never before and never without
 * a path to delivery. Maya's phone shows what arrives, and when.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const KINDS = {
    order: { label: 'Order shipped', title: 'Your order has shipped', text: 'Arriving Thursday. Track it in the app.', category: 'orders', priority: 'transactional', channels: ['push', 'email'] },
    otp: { label: 'One-time code', title: 'Your code is 482 913', text: 'It expires in 10 minutes. Never share it.', category: 'security', priority: 'critical', channels: ['push', 'sms'] },
    promo: { label: 'Weekend promo', title: '20% off this weekend', text: 'Sneakers, jackets, and more. Ends Sunday.', category: 'marketing', priority: 'marketing', channels: ['push', 'email'] },
  };
  const PROVIDER = { push: 'apns', email: 'email', sms: 'sms' };
  const MAX_ATTEMPTS = 5;
  const OTP_SLO = 3000;

  function startSend(sim, kind) {
    const k = KINDS[kind];
    if (!k) return;
    const st = sim.state;
    const nid = `n${++st.seq.n}`;
    const idem = `${kind}-${st.seq.n}`;
    st.requests[nid] = { id: nid, kind, t: sim.now, status: 'sending', jobs: {} };
    sim.startAction(`${kind === 'otp' ? 'Security team' : kind === 'promo' ? 'Growth team' : 'Checkout team'}: send “${k.label}”`, function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'The team sees the API reply; Maya’s phone shows the result.'], retrySafe: ['yes', `Idempotency key ${idem}: a retry of this call cannot create a second notification.`] });
      const r = yield ctx.call('api', 'send', { nid, kind, idem, user: 'maya' }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      const req = st.requests[nid];
      if (r.ok) {
        req.status = r.value.published ? 'queued' : 'stored';
        req.acceptedAt = ctx.now();
        Y.L(ctx, { accepted: ['yes', `202 Accepted, id ${nid}.`], committed: ['yes', r.value.outbox ? 'Request and outbox row written in one transaction.' : 'Request row written.'], async: ['pending', 'Delivery is asynchronous.'] });
        ctx.explain(`The team got 202 in ${Math.round(r.latency)} ms. ${r.value.outbox ? 'Nothing has been sent yet: the relay will turn the outbox row into send jobs.' : r.value.published ? 'The API published the jobs itself after writing the row.' : 'The row was written but the publish failed. The API still said yes because the row exists.'}`);
      } else {
        req.status = 'failed';
        Y.failed(ctx, `The team got ${r.error.code}.`);
        ctx.explain(`The API answered ${r.error.code}. The team keeps the idempotency key and retries later; nothing reached Maya.`);
      }
    }, { self: 'console' });
    return nid;
  }

  const dead = (sim, n) => !!(sim.nodes[n].modes.down || sim.nodes[n].modes.crashed);

  const sc = (SDL.scenarios['nt-send'] = {
    id: 'nt-send',
    seed: 611,
    minHopMs: 5,
    productWidth: 640,
    intro: 'Send an order update from the console: the request is stored with an outbox row, the relay makes one job per channel, workers deliver, and Maya’s phone lights up. Then send an OTP and watch the clock, break the push provider, or crash a worker after the provider said yes.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'console', label: 'Product teams', sub: 'Checkout, security, growth', kind: 'client', x: 90, y: 90, latency: 1, role: 'Any product team calls the same API with an idempotency key. They never talk to providers.', owns: ['Idempotency keys'] },
        { id: 'api', label: 'Notification API', sub: 'Validate, store, accept', kind: 'gateway', x: 300, y: 90, latency: 3, role: 'Validates the request, stores it with an outbox row, and replies 202. Accepting means durable, not delivered.', ops: [{ name: 'send', desc: 'Accept a notification request.' }], owns: ['Nothing durable'] },
        { id: 'notifdb', label: 'Notification store', sub: 'Requests + outbox', kind: 'db', x: 520, y: 90, latency: 8, queue: 'outbox', role: 'The request row and, in the same transaction, an outbox row that says “this still has to be published”.', ops: [{ name: 'write', desc: 'Write request (+ outbox row).' }], owns: ['requests', 'outbox'] },
        { id: 'relay', label: 'Outbox relay', sub: 'Rows → jobs', kind: 'worker', x: 740, y: 90, latency: 3, role: 'Reads outbox rows and publishes one send job per channel. Retries until the queue takes them; the row stays until then.', owns: ['Relay offset'] },
        { id: 'sendq', label: 'Send queue', sub: 'Jobs per channel', kind: 'queue', x: 960, y: 90, latency: 3, queue: 'sends', role: 'Send jobs, at least once. A worker that fails a job gets it again.', ops: [{ name: 'publish', desc: 'Append a job.' }], owns: ['send jobs'] },
        { id: 'prefs', label: 'Preferences', sub: 'Per user and category', kind: 'db', x: 520, y: 270, latency: 6, role: 'Which categories Maya wants on which channel. Security messages ignore it.', ops: [{ name: 'get', desc: 'Read one user’s preferences.' }], owns: ['prefs[user]'] },
        { id: 'registry', label: 'Device registry', sub: 'User → tokens', kind: 'db', x: 740, y: 270, latency: 6, role: 'Device tokens per user. Push needs one; email and SMS do not.', ops: [{ name: 'tokens', desc: 'Tokens for a user.' }], owns: ['tokens[user]'] },
        { id: 'workers', label: 'Send workers', sub: 'Render, check, deliver', kind: 'worker', x: 960, y: 270, latency: 4, role: 'Take a job, render the template, read preferences and tokens, call the provider, write the inbox, then acknowledge. A crash between “provider said yes” and “acknowledged” is where duplicates come from.', owns: ['Dedupe keys'] },
        { id: 'apns', label: 'Push provider', sub: 'APNs / FCM', kind: 'service', x: 520, y: 450, latency: 30, role: 'Delivers pushes to the phone. Best effort, and it says yes before the phone has seen anything.', ops: [{ name: 'send', desc: 'Deliver a push.' }], owns: ['Nothing of ours'] },
        { id: 'email', label: 'Email provider', sub: 'API', kind: 'service', x: 740, y: 450, latency: 40, role: 'Sends emails. Slow is normal; minutes are fine.', ops: [{ name: 'send', desc: 'Send an email.' }], owns: ['Nothing of ours'] },
        { id: 'sms', label: 'SMS provider', sub: 'Costs money', kind: 'service', x: 960, y: 450, latency: 60, role: 'Sends texts. Every one costs money, so it is for codes and alerts, not promos.', ops: [{ name: 'send', desc: 'Send a text.' }], owns: ['Nothing of ours'] },
        { id: 'inbox', label: 'In-app inbox', sub: 'Always there', kind: 'db', x: 300, y: 450, latency: 6, role: 'The list inside the app. The one channel the platform fully controls.', ops: [{ name: 'add', desc: 'Add an entry.' }], owns: ['inbox[user]'] },
        { id: 'phone', label: 'Maya’s phone', sub: 'Receives everything', kind: 'client', x: 90, y: 450, latency: 1, role: 'Shows pushes on the lock screen, texts, emails, and the in-app inbox.', ops: [{ name: 'push', desc: 'Show a push.' }, { name: 'sms', desc: 'Show a text.' }, { name: 'email', desc: 'Receive an email.' }], owns: ['Nothing'] },
      ],
      edges: [
        { from: 'console', to: 'api', latency: 30, label: 'HTTPS' },
        { from: 'api', to: 'notifdb', latency: 4 },
        { from: 'api', to: 'sendq', latency: 4, via: [[300, 30], [960, 30]], label: 'dual write' },
        { from: 'notifdb', to: 'relay', latency: 4 },
        { from: 'relay', to: 'sendq', latency: 4 },
        { from: 'sendq', to: 'workers', latency: 3 },
        { from: 'workers', to: 'prefs', latency: 4, via: [[740, 350], [520, 350]] },
        { from: 'workers', to: 'registry', latency: 4 },
        { from: 'workers', to: 'apns', latency: 4, via: [[620, 390]] },
        { from: 'workers', to: 'email', latency: 4, via: [[850, 390]] },
        { from: 'workers', to: 'sms', latency: 4 },
        { from: 'workers', to: 'inbox', latency: 4, via: [[960, 560], [300, 560]] },
        { from: 'apns', to: 'phone', latency: 30 },
        { from: 'email', to: 'phone', latency: 40, via: [[740, 530], [90, 530]] },
        { from: 'sms', to: 'phone', latency: 60, via: [[960, 580], [60, 580]] },
        { from: 'inbox', to: 'phone', latency: 20, label: 'sync' },
      ],
      queues: [
        { id: 'outbox', broker: 'notifdb', label: 'outbox rows', groups: ['relay'] },
        { id: 'sends', broker: 'sendq', label: 'send jobs', groups: ['workers'] },
      ],
    },
    modeLabels: { crashAfterSend: 'Crashes after the next provider accept' },
    failures: [
      { id: 'api-down', node: 'api', mode: 'down', label: 'API down', desc: 'Teams get errors and retry later with the same key.' },
      { id: 'prefs-down', node: 'prefs', mode: 'down', label: 'Preferences unavailable', desc: 'Workers cannot check preferences. Order and promo jobs wait; security messages skip the check.' },
      { id: 'registry-down', node: 'registry', mode: 'down', label: 'Device registry down', desc: 'Push jobs cannot find a token and retry. Email and SMS are unaffected.' },
      { id: 'workers-paused', node: 'workers', mode: 'paused', label: 'Workers paused', desc: 'Jobs wait in the queue. Nothing is lost, nothing moves.' },
      { id: 'sendq-down', node: 'sendq', mode: 'down', label: 'Send queue unavailable', desc: 'Publishing fails. With the outbox, rows wait and the relay retries. With a dual write, the API has already written the row.' },
      { id: 'worker-crash', node: 'workers', mode: 'crashAfterSend', label: 'Worker crash after provider accept', desc: 'The next job is sent, then the worker dies before acknowledging. The job comes back.' },
      { id: 'apns-down', node: 'apns', mode: 'down', label: 'Push provider down', desc: 'Pushes fail and retry with backoff, then dead-letter.' },
      { id: 'email-slow', node: 'email', mode: 'slow', params: { factor: 20 }, label: 'Email provider slow', desc: 'Emails take close to a second each. Fine for email.' },
      { id: 'sms-down', node: 'sms', mode: 'down', label: 'SMS provider down', desc: 'Texts fail and retry. The OTP still reaches the phone by push.' },
    ],
    switches: Y.switches([
      ['outbox', 'Transactional outbox', 'Write the request and an outbox row in one transaction; a relay publishes jobs. Off: write the row, then publish from the API (a dual write).'],
      ['inbox', 'Mirror pushes into the in-app inbox', 'Every push also becomes an inbox entry, written before the provider is called. Off: a push that never lands is simply gone.'],
      ['dedupe', 'Claim the dedupe key before sending', 'The worker records (notification, channel) as claimed before calling the provider; a redelivered job that finds the claim is skipped. Off: a redelivered job is sent again.'],
    ]),
    presets: Y.presets({ outbox: true, inbox: true, dedupe: true }, [
      { id: 'order', label: 'Send an order update', desc: 'The checkout team gets 202 in about 50 ms. The outbox row becomes two jobs; Maya gets a push (mirrored into her inbox) and an email.', run: (s) => startSend(s, 'order') },
      { id: 'otp', label: 'Send a one-time code', desc: 'Security messages skip the preference check. Push and SMS both land well inside the 3 s budget; the clock on the phone shows the end-to-end time.', run: (s) => startSend(s, 'otp') },
      { id: 'promo', label: 'Send a promo Maya does not want on push', desc: 'Maya turned marketing pushes off. The worker reads preferences at send time: the push job is suppressed, the email goes.', run: (s) => startSend(s, 'promo') },
      { id: 'apns-down', label: 'Push provider down, inbox mirrored', desc: 'The push fails five times with backoff and is dead-lettered, but the inbox entry was written first, so the app shows the update when Maya opens it.', run: (s) => { s.inject('apns', 'down'); startSend(s, 'order'); } },
      { id: 'apns-down-noinbox', label: 'Push provider down, no inbox mirror', desc: 'Same outage without the mirror. The push dead-letters and the email arrives, but the app itself never shows the update.', sw: { inbox: false }, run: (s) => { s.inject('apns', 'down'); startSend(s, 'order'); } },
      { id: 'workers-paused', label: 'Workers paused for 4 s', desc: 'Jobs pile up in the queue and nothing is lost. When the workers return, everything is delivered once.', run: (s) => { s.inject('workers', 'paused', true, 4000); startSend(s, 'order'); } },
      { id: 'outbox-queue-down', label: 'Send queue down for 2 s, with the outbox', desc: 'The API still says 202, because the row and the outbox row are durable. The relay retries the publish until the queue is back.', run: (s) => { s.inject('sendq', 'down', true, 2000); startSend(s, 'order'); } },
      { id: 'dual-write-loss', label: 'Send queue down for 2 s, dual write', desc: 'The API writes the row, then fails to publish. The row exists, so the status reads “stored” and the team was told yes. Nobody will ever publish it.', sw: { outbox: false }, run: (s) => { s.inject('sendq', 'down', true, 2000); startSend(s, 'order'); } },
      { id: 'crash-dup', label: 'Worker crash after accept, no claim', desc: 'The provider accepts the push, the worker dies before acknowledging, and the job is redelivered. Nothing remembers the first send: Maya gets the same push twice.', sw: { dedupe: false }, run: (s) => { s.inject('workers', 'crashAfterSend'); startSend(s, 'order'); } },
      { id: 'crash-dedupe', label: 'Worker crash after accept, key claimed first', desc: 'The worker claimed (n1, push) before calling the provider. The redelivered job finds the claim and is skipped. One push.', run: (s) => { s.inject('workers', 'crashAfterSend'); startSend(s, 'order'); } },
      { id: 'registry-down', label: 'Device registry down for 3 s', desc: 'The push job cannot find a token and retries with backoff; the email is unaffected. When the registry returns, the push goes out late.', run: (s) => { s.inject('registry', 'down', true, 3000); startSend(s, 'order'); } },
    ]),
    initialState: () => ({
      config: { outbox: true, inbox: true, dedupe: true },
      prefs: { orders: { push: true, email: true }, marketing: { push: false, email: true } },
      tokens: { maya: ['tok-phone-7f3a'] },
      requests: {}, jobs: {}, claims: {}, attempts: {}, dead: [], received: [], lost: [],
      stats: { accepted: 0, jobs: 0, retries: 0, suppressed: 0, dupSkipped: 0 },
      seq: { n: 0, job: 0 },
    }),
    initialUI: () => ({ phone: { pushes: [], inbox: [], sms: [], emails: [], banner: null, tab: 'lock' } }),
    actions: {
      send(sim, a) { startSend(sim, a.kind); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        send: function* (ctx, p) {
          const st = ctx.state;
          const k = KINDS[p.kind];
          const outbox = st.config.outbox;
          ctx.must(yield ctx.call('notifdb', 'write', { nid: p.nid, kind: p.kind, idem: p.idem, outbox }, { timeout: 600 }));
          st.stats.accepted++;
          if (outbox) return { accepted: true, outbox: true, published: false };
          // Dual write: the row is committed; now publish from the API.
          const r = yield ctx.call('sendq', 'publish', { nid: p.nid, kind: p.kind, channels: k.channels }, { timeout: 600 });
          if (!r.ok) {
            st.lost.push(p.nid);
            ctx.log({ op: `${p.nid} stored but not published`, status: 'fault', actionId: ctx.actionId, detail: `The request row is committed and the publish failed (${r.error.code}). The API returns 202 because the row exists. No relay will ever pick it up.` });
            ctx.sim.setLedger(ctx.actionId, 'async', 'no', 'Row stored, jobs never published.');
            return { accepted: true, outbox: false, published: false };
          }
          return { accepted: true, outbox: false, published: true };
        },
      },
      notifdb: {
        write(ctx, p) {
          const st = ctx.state;
          if (p.outbox) ctx.sim.enqueue('outbox', { type: 'notification', eventId: p.nid, payload: { nid: p.nid, kind: p.kind }, actionId: ctx.actionId });
          st.requests[p.nid].stored = ctx.now();
          return { stored: true };
        },
      },
      sendq: {
        publish(ctx, p) {
          const st = ctx.state;
          for (const channel of p.channels) {
            const key = `${p.nid}/${channel}`;
            st.jobs[key] = { nid: p.nid, channel, state: 'queued', t: ctx.now() };
            st.requests[p.nid].jobs[channel] = 'queued';
            st.stats.jobs++;
            ctx.sim.enqueue('sends', { type: 'send', eventId: key, payload: { nid: p.nid, kind: p.kind, channel, key }, actionId: ctx.actionId });
          }
          if (st.requests[p.nid].status !== 'failed') st.requests[p.nid].status = 'queued';
          return { jobs: p.channels.length };
        },
      },
      prefs: { get(ctx, p) { return Object.assign({}, ctx.state.prefs[p.category] || {}); } },
      registry: { tokens(ctx, p) { return { tokens: (ctx.state.tokens[p.user] || []).slice() }; } },
      apns: { send: function* (ctx, p) { return ctx.must(yield ctx.call('phone', 'push', p, { timeout: 500 })); } },
      email: { send: function* (ctx, p) { return ctx.must(yield ctx.call('phone', 'email', p, { timeout: 500 })); } },
      sms: { send: function* (ctx, p) { return ctx.must(yield ctx.call('phone', 'sms', p, { timeout: 500 })); } },
      inbox: {
        add(ctx, p) {
          const ui = ctx.ui.phone;
          if (!ui.inbox.some((e) => e.key === p.key)) ui.inbox.unshift({ key: p.key, title: p.title, text: p.text, t: ctx.now() });
          ctx.state.received.push({ channel: 'inbox', key: p.key, nid: p.nid, t: ctx.now() });
          return { added: true };
        },
      },
      phone: {
        push(ctx, p) {
          const ui = ctx.ui.phone;
          const req = ctx.state.requests[p.nid];
          const ms = ctx.now() - req.t;
          ui.pushes.unshift({ title: p.title, text: p.text, t: ctx.now(), ms, kind: p.kind });
          ui.banner = { title: p.title, body: p.text, tone: 'ok', t: ctx.now() };
          ctx.state.received.push({ channel: 'push', key: p.key, nid: p.nid, t: ctx.now(), ms });
          return { shown: true };
        },
        sms(ctx, p) {
          const ui = ctx.ui.phone;
          const ms = ctx.now() - ctx.state.requests[p.nid].t;
          ui.sms.unshift({ text: `${p.title}. ${p.text}`, t: ctx.now(), ms });
          ctx.state.received.push({ channel: 'sms', key: p.key, nid: p.nid, t: ctx.now(), ms });
          return { shown: true };
        },
        email(ctx, p) {
          const ui = ctx.ui.phone;
          const ms = ctx.now() - ctx.state.requests[p.nid].t;
          ui.emails.unshift({ title: p.title, text: p.text, t: ctx.now(), ms });
          ctx.state.received.push({ channel: 'email', key: p.key, nid: p.nid, t: ctx.now(), ms });
          return { received: true };
        },
      },
    },
    setup(sim) {
      // Outbox relay: one row -> one job per channel, published through the queue's API so a dead broker is visible.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('outbox', 'relay');
          const k = KINDS[msg.payload.kind];
          for (let attempt = 1; ; attempt++) {
            const r = yield ctx.call('sendq', 'publish', { nid: msg.payload.nid, kind: msg.payload.kind, channels: k.channels }, { timeout: 600, actionId: msg.actionId });
            if (r.ok) break;
            ctx.log({ op: `${msg.payload.nid} publish failed, retry ${attempt}`, status: 'retry', actionId: msg.actionId, detail: `${r.error.message} The outbox row stays until the queue takes the jobs.` });
            yield ctx.wait(Math.min(1600, 200 * 2 ** (attempt - 1)));
          }
          ctx.ack('outbox', 'relay');
        }
      }, { self: 'relay' });
      // Workers: render, check preferences and tokens, deliver, acknowledge.
      Y.consumer(sim, 'sends', 'workers', 'workers', function* (ctx, msg) {
        const st = ctx.state;
        const p = msg.payload;
        const k = KINDS[p.kind];
        const job = st.jobs[p.key];
        const req = st.requests[p.nid];
        const mark = (state) => { job.state = state; req.jobs[p.channel] = state; };
        if (st.config.dedupe && st.claims[p.key]) {
          st.stats.dupSkipped++;
          mark('sent');
          ctx.log({ op: `${p.key} already claimed`, status: 'dup', actionId: msg.actionId, detail: 'A worker claimed this key before calling the provider. This redelivery is skipped.' });
          return true;
        }
        const attempt = (st.attempts[p.key] = (st.attempts[p.key] || 0) + 1);
        if (attempt > 1) st.stats.retries++;
        const retryLater = (why) => {
          mark('retrying');
          ctx.log({ op: `${p.key} retry in ${Math.min(2400, 300 * 2 ** (attempt - 1))} ms`, status: 'retry', actionId: msg.actionId, detail: `${why} Attempt ${attempt} of ${MAX_ATTEMPTS}.` });
          ctx.spawn(function* (c) {
            yield c.wait(Math.min(2400, 300 * 2 ** (attempt - 1)));
            c.sim.enqueue('sends', { type: 'send', eventId: `${p.key}#${++c.state.seq.job}`, payload: p, actionId: msg.actionId });
          }, { self: 'workers', quiet: true });
          return true;
        };
        const park = (why) => {
          mark('dead');
          st.dead.push({ key: p.key, why, t: ctx.now() });
          ctx.log({ op: `${p.key} dead-lettered`, status: 'fault', actionId: msg.actionId, detail: `${why} after ${attempt} attempts. Parked for a human; the queue moves on.` });
          return true;
        };
        // 1. Render (templates are local to the worker).
        const rendered = { nid: p.nid, kind: p.kind, key: p.key, title: k.title, text: k.text, user: 'maya' };
        // 2. Preferences, except for security messages.
        if (k.priority !== 'critical') {
          const pr = yield ctx.call('prefs', 'get', { user: 'maya', category: k.category }, { timeout: 600, actionId: msg.actionId });
          if (!pr.ok) return attempt >= MAX_ATTEMPTS ? park('Preferences unavailable') : retryLater(`Preferences: ${pr.error.message}`);
          if (!pr.value[p.channel]) {
            st.stats.suppressed++;
            mark('suppressed');
            ctx.log({ op: `${p.key} suppressed`, status: 'note', actionId: msg.actionId, detail: `Maya has ${k.category} turned off on ${p.channel}. Read at send time, so a change a second ago counts.` });
            return true;
          }
        }
        // 3. Tokens for push.
        if (p.channel === 'push') {
          const tr = yield ctx.call('registry', 'tokens', { user: 'maya' }, { timeout: 600, actionId: msg.actionId });
          if (!tr.ok) return attempt >= MAX_ATTEMPTS ? park('Device registry unavailable') : retryLater(`Registry: ${tr.error.message}`);
          rendered.token = tr.value.tokens[0];
          if (st.config.inbox && !st.claims[p.key]) {
            const ir = yield ctx.call('inbox', 'add', rendered, { timeout: 600, actionId: msg.actionId });
            if (!ir.ok) return retryLater(`Inbox: ${ir.error.message}`);
          }
        }
        // 4. Claim, then send.
        if (st.config.dedupe) st.claims[p.key] = ctx.now();
        mark('sending');
        const r = yield ctx.call(PROVIDER[p.channel], 'send', rendered, { timeout: 1500, actionId: msg.actionId });
        if (r.ok && ctx.mode('crashAfterSend')) {
          ctx.sim.restore('workers', 'crashAfterSend');
          ctx.log({ op: `worker crashed after ${p.key} was accepted`, status: 'fault', actionId: msg.actionId, detail: 'The provider said yes; the worker died before acknowledging. The queue will redeliver this job.' });
          st.stats.retries++;
          return false;
        }
        if (r.ok) {
          mark('sent');
          const all = k.channels.every((c) => ['sent', 'suppressed'].includes(req.jobs[c]));
          if (all) { req.status = 'delivered'; ctx.sim.setLedger(msg.actionId, 'async', 'yes', 'Delivered on every channel Maya wants.'); }
          return true;
        }
        if (st.config.dedupe) delete st.claims[p.key];
        if (attempt >= MAX_ATTEMPTS) { ctx.sim.setLedger(msg.actionId, 'async', 'no', `${p.channel} dead-lettered.`); return park(`${ctx.sim.nodes[PROVIDER[p.channel]].label} unavailable`); }
        return retryLater(`${ctx.sim.nodes[PROVIDER[p.channel]].label}: ${r.error.message}`);
      });
    },
    consistency(sim) {
      const st = sim.state;
      const keys = st.received.filter((x) => x.channel !== 'inbox').map((x) => x.key);
      const dup = keys.find((k, i) => keys.indexOf(k) !== i);
      if (dup) return { key: 'wrong', label: `Maya received “${KINDS[st.requests[dup.split('/')[0]].kind].title}” twice on ${dup.split('/')[1]}. At-least-once delivery with nothing to remember the first send.` };
      if (st.lost.length) return { key: 'wrong', label: `The team was told 202 for ${st.lost.join(', ')} but the jobs were never published. A dual write lost the notification; an outbox would have kept it.` };
      const reqs = Object.values(st.requests);
      if (!reqs.length) return { key: 'ok', label: 'Nothing sent yet.' };
      const otp = st.received.filter((x) => x.channel !== 'inbox' && st.requests[x.nid].kind === 'otp');
      if (otp.some((x) => x.ms > OTP_SLO)) return { key: 'stale', label: `A one-time code took ${Math.round(Math.max(...otp.map((x) => x.ms)) / 1000)} s to arrive. Codes expire; this one may be useless.` };
      const pending = reqs.filter((r) => r.status !== 'delivered' && r.status !== 'failed');
      const deadReqs = reqs.filter((r) => Object.values(r.jobs).includes('dead'));
      if (deadReqs.length) {
        const unseen = deadReqs.filter((r) => !st.received.some((x) => x.nid === r.id));
        if (unseen.length) return { key: 'stale', label: `${unseen.map((r) => KINDS[r.kind].title).map((t) => `“${t}”`).join(', ')} reached Maya on no channel at all. A human must look at the dead letters.` };
        const noApp = deadReqs.filter((r) => !st.received.some((x) => x.nid === r.id && x.channel === 'inbox'));
        if (noApp.length) return { key: 'stale', label: `The push for “${KINDS[noApp[0].kind].title}” is dead-lettered and the app has no record of it. ${st.received.some((x) => x.nid === noApp[0].id) ? 'Email got through, but anyone who only looks at the app never learns about it.' : 'Maya never learns about it.'}` };
        return { key: 'ok', label: `The push for “${KINDS[deadReqs[0].kind].title}” is dead-lettered, but the inbox entry was written before the provider was called, so the app shows it. The one channel the platform controls carried the message.` };
      }
      if (pending.length) {
        const waiting = pending.filter((r) => Object.values(r.jobs).some((s) => s === 'retrying'));
        return { key: 'stale', label: waiting.length ? `${waiting.length} notification${waiting.length > 1 ? 's are' : ' is'} being retried with backoff.` : `${pending.length} notification${pending.length > 1 ? 's' : ''} still on the way.` };
      }
      const failed = reqs.filter((r) => r.status === 'failed');
      if (failed.length) return { key: 'ok', label: `${failed.length} request${failed.length > 1 ? 's were' : ' was'} refused by the API; the team keeps the key and retries. Nothing half-done.` };
      return { key: 'ok', label: 'Every notification reached Maya once, on every channel she wants, and the team was never told yes about something that could not be delivered.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const ui = sim.ui.phone;
      const otp = st.received.filter((x) => x.channel !== 'inbox' && st.requests[x.nid].kind === 'otp').map((x) => x.ms);
      return [
        { label: 'Accepted (202)', value: st.stats.accepted },
        { label: 'Send jobs', value: st.stats.jobs },
        { label: 'Pushes shown', value: ui.pushes.length },
        { label: 'Emails', value: ui.emails.length },
        { label: 'Texts', value: ui.sms.length },
        { label: 'OTP end to end', value: otp.length ? SDL.fmtMs(Math.max(...otp)) : '–', tone: otp.some((m) => m > OTP_SLO) ? 'fail' : otp.length ? 'ok' : '' },
        { label: 'Retries', value: st.stats.retries, tone: st.stats.retries ? 'warn' : '' },
        { label: 'Dead letters', value: st.dead.length, tone: st.dead.length ? 'warn' : '' },
        { label: 'Suppressed by prefs', value: st.stats.suppressed },
        { label: 'Queue depth', value: sim.queueStats('sends').depth + sim.queueStats('outbox').depth },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone']], {
          note: 'The console is what a product team sees: one API, three kinds of message. The phone shows the lock screen, texts, email, and the in-app inbox; each item carries its end-to-end time.',
          side: `<p class="ops-title">Product teams</p><div class="ops-traffic">
              ${Y.btn('send', 'Checkout: order shipped', { arg: { kind: 'order' } })}
              ${Y.btn('send', 'Security: one-time code', { arg: { kind: 'otp' }, cls: 'secondary' })}
              ${Y.btn('send', 'Growth: weekend promo', { arg: { kind: 'promo' }, cls: 'secondary' })}
            </div><div data-ref="status"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const ui = sim.ui.phone;
        const tabs = [['lock', 'Lock screen'], ['inbox', 'In-app'], ['sms', 'Texts'], ['email', 'Email']];
        const nav = `<div class="app-row" style="flex-wrap:wrap">${tabs.map(([k, v]) => Y.btn('set', v, { arg: { field: 'phone.tab', value: k }, cls: ui.tab === k ? '' : 'secondary' })).join('')}</div>`;
        const card = (n, extra) => `<div class="app-card ${extra || ''}"><strong>${esc(n.title || n.text)}</strong>${n.title && n.text ? `<span class="app-sub">${esc(n.text)}</span>` : ''}<span class="app-sub">${SDL.fmtMs(n.ms)} after the team’s call</span></div>`;
        let body = '';
        if (ui.tab === 'lock') body = `<p class="app-sub">Notifications (${ui.pushes.length})</p>${ui.pushes.slice(0, 5).map((n) => card(n, n.kind === 'otp' && n.ms > OTP_SLO ? 'is-fail' : 'is-ok')).join('') || '<p class="app-sub">Nothing yet.</p>'}`;
        if (ui.tab === 'inbox') body = `<p class="app-sub">🔔 Inbox (${ui.inbox.length})</p>${ui.inbox.slice(0, 6).map((n) => `<div class="app-card"><strong>${esc(n.title)}</strong><span class="app-sub">${esc(n.text)}</span></div>`).join('') || '<p class="app-sub">Nothing yet.</p>'}`;
        if (ui.tab === 'sms') body = `<p class="app-sub">Texts (${ui.sms.length})</p>${ui.sms.slice(0, 5).map((n) => card(n)).join('') || '<p class="app-sub">None yet.</p>'}`;
        if (ui.tab === 'email') body = `<p class="app-sub">Email (${ui.emails.length})</p>${ui.emails.slice(0, 5).map((n) => card(n)).join('') || '<p class="app-sub">No email yet.</p>'}`;
        const signin = `<div class="app-row">${Y.btn('send', 'Sign in to the shop', { arg: { kind: 'otp' } })}</div><p class="app-sub">Signing in asks the security team for a one-time code.</p>`;
        Y.paint(el, sim, 'phone', { head: '<div><p class="app-title">Notifications</p><p class="app-sub">Maya · marketing push off</p></div>', signin, nav, body }, {}, ui.banner);
        const c = sim.scenario.consistency(sim);
        const rows = Object.values(st.requests).slice(-6).reverse().map((r) => {
          const k = KINDS[r.kind];
          const parts = k.channels.map((ch) => `${ch}: ${r.jobs[ch] || (r.status === 'failed' ? 'never created' : r.status === 'stored' ? 'never published' : 'waiting')}`);
          const tone = r.status === 'failed' || r.status === 'stored' ? 'fail' : Object.values(r.jobs).includes('dead') ? 'fail' : r.status === 'delivered' ? 'ok' : 'warn';
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name">${r.id} · ${esc(k.label)}<span>${r.status === 'failed' ? 'API error: the team will retry' : r.status === 'stored' ? 'stored, jobs never published' : parts.join(' · ')}</span></div></div>`;
        }).join('');
        SDL.ui.paintSections(el.querySelector('[data-ref="status"]'), {
          title: '<p class="ops-title">Requests</p>',
          rows: `<div class="ops-shards">${rows || '<p class="app-sub">No requests yet.</p>'}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void dead;
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
