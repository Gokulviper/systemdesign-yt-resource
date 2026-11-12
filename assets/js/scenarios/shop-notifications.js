/*
 * Order notifications.
 * The order service emits one event per step of an order (confirmed, packed,
 * shipped, delivered). The notification service reads the shopper's
 * preferences, turns each event into send jobs per channel (push, email,
 * SMS, in-app), and senders deliver through providers. The pipeline must
 * tell the shopper each thing once, in order, only through channels they
 * still want, and must not stop when one message or one provider misbehaves.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const STEPS = [
    ['confirmed', 'Order confirmed', 'Thanks! Your order #A1 is confirmed.'],
    ['packed', 'Order packed', 'Your Echo Dot has been packed.'],
    ['shipped', 'Shipped', 'Your order is on its way. Arriving Thursday.'],
    ['delivered', 'Delivered', 'Your package was delivered. Enjoy!'],
  ];
  const STEP_MS = 900;
  const MAX_ATTEMPTS = 3; // for a message that cannot be rendered
const MAX_PROVIDER_ATTEMPTS = 6; // for a provider that is down
  const CHANNELS = ['push', 'email', 'sms', 'inapp'];
  const PROVIDER = { push: 'push', email: 'email', sms: 'sms', inapp: 'inbox' };

  function startOrder(sim, opts) {
    opts = opts || {};
    const st = sim.state;
    if (st.order && st.order.step < STEPS.length) return;
    st.order = { id: 'A1', step: 0, poison: !!opts.poison, prefs: Object.assign({}, st.prefs) };
    sim.ui.phone.pushes = [];
    sim.ui.phone.inbox = [];
    sim.ui.phone.sms = [];
    sim.ui.phone.emails = [];
    st.received = [];
    const next = () => {
      const o = st.order;
      if (!o || o.step >= STEPS.length) return;
      const [type, title] = STEPS[o.step];
      const seq = o.step + 1;
      o.step++;
      sim.startAction(`Order ${o.id}: ${title.toLowerCase()}`, function* (ctx) {
        Y.L(ctx, { displayed: ['n/a', 'The order service has no screen; the shopper’s phone shows the result.'], retrySafe: ['yes', 'Every event has an id; every send job has a key (order, step, channel).'] });
        const r = yield ctx.call('events', 'publish', { orderId: o.id, seq, type, poison: o.poison && type === 'packed' }, { timeout: 800 });
        if (r.ok) Y.L(ctx, { accepted: 'yes', committed: ['yes', `Event ${o.id}/${seq} in the broker.`], async: ['pending', 'Waiting to reach the shopper.'] });
        else Y.failed(ctx);
      }, { self: 'orders' });
      if (o.step < STEPS.length) sim.schedule(STEP_MS, next);
    };
    next();
  }

  function setPref(sim, channel, on) {
    const prefs = sim.state.prefs;
    if (prefs[channel] === on) return;
    prefs[channel] = on;
    sim.state.prefChanges.push({ channel, on, t: sim.now });
    sim.note(`Shopper turned ${channel === 'sms' ? 'SMS' : channel} notifications ${on ? 'on' : 'off'}.`);
  }

  const sc = (SDL.scenarios['shop-notifications'] = {
    id: 'shop-notifications',
    seed: 457,
    productWidth: 600,
    intro: 'Place an order from the console: four events, each delivered by push, email, SMS, and the in-app list. Then duplicate the events, reorder them, break a provider, poison a message, or turn SMS off while the order is in flight.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'orders', label: 'Order service', sub: 'Emits events', kind: 'service', x: 90, y: 90, latency: 3, role: 'Moves the order through its steps and emits one event per step.', owns: ['orders'] },
        { id: 'events', label: 'Order events', sub: 'Event broker', kind: 'queue', x: 300, y: 90, latency: 4, queue: 'orderEvents', role: 'Order events, at least once, usually in order.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['event log'] },
        { id: 'notif', label: 'Notification service', sub: 'Events → send jobs', kind: 'worker', x: 520, y: 90, latency: 4, role: 'Deduplicates events, keeps each order’s messages in sequence, reads preferences, and creates one send job per channel.', ops: [{ name: 'consume', desc: 'Handle one event.' }], owns: ['Per-order sequence', 'Held events'] },
        { id: 'prefs', label: 'Preferences', sub: 'Per shopper', kind: 'db', x: 520, y: 260, latency: 6, role: 'Which channels the shopper wants. Changes take effect for anything not sent yet.', ops: [{ name: 'get', desc: 'Read preferences.' }], owns: ['prefs[user]'] },
        { id: 'sendq', label: 'Send queue', sub: 'Jobs', kind: 'queue', x: 760, y: 90, latency: 3, queue: 'sends', role: 'Send jobs waiting for a sender. A failing job is retried at the head of the queue.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['send jobs'] },
        { id: 'sender', label: 'Senders', sub: 'Render and deliver', kind: 'worker', x: 760, y: 260, latency: 3, role: 'Renders the message template and calls the provider. Retries, then dead-letters or blocks.', ops: [{ name: 'consume', desc: 'Deliver one job.' }], owns: ['Dedupe store'] },
        { id: 'dlq', label: 'Dead letters', sub: 'For a human', kind: 'queue', x: 980, y: 260, latency: 2, queue: 'dead', role: 'Jobs that failed every attempt, parked so the rest of the queue can move.', ops: [{ name: 'publish', desc: 'Park a job.' }], owns: ['dead jobs'] },
        { id: 'push', label: 'Push provider', sub: 'APNs and FCM', kind: 'service', x: 520, y: 440, latency: 30, role: 'Delivers pushes to the phone.', ops: [{ name: 'send', desc: 'Deliver a push.' }], owns: ['Device tokens'] },
        { id: 'email', label: 'Email provider', sub: 'SMTP API', kind: 'service', x: 760, y: 440, latency: 40, role: 'Sends emails. Outages are common; emails are not urgent.', ops: [{ name: 'send', desc: 'Send an email.' }], owns: ['Nothing'] },
        { id: 'sms', label: 'SMS gateway', sub: 'Costs money', kind: 'service', x: 980, y: 440, latency: 60, role: 'Sends texts. Each one costs money, and sending to someone who opted out is a compliance problem.', ops: [{ name: 'send', desc: 'Send a text.' }], owns: ['Nothing'] },
        { id: 'inbox', label: 'In-app list', sub: 'Notification centre', kind: 'db', x: 300, y: 440, latency: 6, role: 'The list inside the app. Always there when the app opens.', ops: [{ name: 'add', desc: 'Add an entry.' }], owns: ['notifications[user]'] },
        { id: 'phone', label: 'Shopper’s phone', sub: 'Receives everything', kind: 'client', x: 90, y: 440, latency: 1, role: 'Shows pushes, texts, emails, and the in-app list. Changes preferences.', ops: [{ name: 'push', desc: 'Show a push.' }, { name: 'sms', desc: 'Show a text.' }, { name: 'email', desc: 'Receive an email.' }], owns: ['Nothing'] },
      ],
      edges: [
        { from: 'orders', to: 'events', latency: 4 },
        { from: 'events', to: 'notif', latency: 4 },
        { from: 'notif', to: 'prefs', latency: 4 },
        { from: 'notif', to: 'sendq', latency: 4 },
        { from: 'sendq', to: 'sender', latency: 3 },
        { from: 'sender', to: 'dlq', latency: 3 },
        { from: 'sender', to: 'push', latency: 4, via: [[640, 350]] },
        { from: 'sender', to: 'email', latency: 4 },
        { from: 'sender', to: 'sms', latency: 4, via: [[880, 350]] },
        { from: 'sender', to: 'inbox', latency: 4, via: [[300, 350]] },
        { from: 'push', to: 'phone', latency: 30, via: [[520, 540], [90, 540]] },
        { from: 'sms', to: 'phone', latency: 60, via: [[980, 560], [90, 560]] },
        { from: 'email', to: 'phone', latency: 40, via: [[760, 520], [90, 520]] },
        { from: 'inbox', to: 'phone', latency: 30, label: 'sync' },
      ],
      queues: [
        { id: 'orderEvents', broker: 'events', label: 'order events', groups: ['notif'] },
        { id: 'sends', broker: 'sendq', label: 'send jobs', groups: ['sender'] },
        { id: 'dead', broker: 'dlq', label: 'dead letters', groups: [] },
      ],
    },
    modeLabels: { reorder: 'Delivering out of order' },
    failures: [
      { id: 'dup', node: 'events', mode: 'duplicate', label: 'Events delivered twice', desc: 'At-least-once delivery repeats every event.' },
      { id: 'reorder', node: 'events', mode: 'reorder', label: 'Events out of order', desc: 'The “shipped” event overtakes “packed”.' },
      { id: 'email-down', node: 'email', mode: 'down', label: 'Email provider down', desc: 'Emails fail; everything else continues.' },
      { id: 'push-down', node: 'push', mode: 'down', label: 'Push provider down', desc: 'Pushes fail and retry; the in-app list still gets everything.' },
      { id: 'sms-slow', node: 'sms', mode: 'slow', params: { factor: 20 }, label: 'SMS gateway slow', desc: 'Texts take over a second each.' },
      { id: 'prefs-down', node: 'prefs', mode: 'down', label: 'Preferences unavailable', desc: 'The notification service cannot read preferences.' },
      { id: 'notif-paused', node: 'notif', mode: 'paused', label: 'Notification service paused', desc: 'Events wait in the broker.' },
    ],
    switches: Y.switches([
      ['dedupe', 'Deduplicate events and sends', 'Skip an event id or a send key already handled. Off: a repeated event reaches the phone twice.'],
      ['ordered', 'Keep each order’s messages in sequence', 'Hold an event whose predecessor has not arrived; drop one that a later step already superseded. Off: deliver in arrival order.'],
      ['dlq', 'Dead-letter failing jobs', `After ${MAX_ATTEMPTS} failed attempts, park the job and move on. Off: keep retrying at the head of the queue.`],
      ['livePrefs', 'Check preferences at send time', 'Read preferences when the event is handled. Off: copy them onto the order when it is placed and use that for every message.'],
    ]),
    presets: Y.presets({ dedupe: true, ordered: true, dlq: true, livePrefs: true }, [
      { id: 'order', label: 'Place an order', desc: 'Four events, each sent as a push, an email, a text, and an in-app entry. Everything arrives once, in order.', run: (s) => startOrder(s) },
      { id: 'dup', label: 'Events delivered twice, deduplicated', desc: 'Every event arrives twice. The event id has been seen, so the copy is dropped (and the sequence check would catch it too).', run: (s) => { s.inject('events', 'duplicate'); startOrder(s); } },
      { id: 'dup-bad', label: 'Events delivered twice, no dedupe, no sequencing', desc: 'Nothing remembers what was sent. The phone buzzes twice for every step: eight pushes, eight texts, double the SMS bill.', sw: { dedupe: false, ordered: false }, run: (s) => { s.inject('events', 'duplicate'); startOrder(s); } },
      { id: 'reorder', label: 'Events out of order, sequenced', desc: '“Shipped” arrives before “packed”. It is held until “packed” has been sent, then released.', run: (s) => { s.inject('events', 'reorder'); startOrder(s); } },
      { id: 'reorder-bad', label: 'Events out of order, as they come', desc: 'The shopper is told the order shipped, then that it was packed.', sw: { ordered: false }, run: (s) => { s.inject('events', 'reorder'); startOrder(s); } },
      { id: 'email-down', label: 'Email provider down for 3 s', desc: 'Emails fail and are retried with backoff, in order. Push, SMS, and the in-app list are unaffected, and the emails arrive once the provider is back.', run: (s) => { s.inject('email', 'down', true, 3000); startOrder(s); } },
      { id: 'push-down', label: 'Push provider down', desc: 'Pushes are retried for seconds, then dead-lettered. The in-app list has every step, so the app still shows them.', run: (s) => { s.inject('push', 'down'); startOrder(s); } },
      { id: 'poison', label: 'Poison message, dead-lettered', desc: 'The “packed” push cannot be rendered. After three attempts it is parked in the dead-letter queue and the later messages flow.', run: (s) => startOrder(s, { poison: true }) },
      { id: 'poison-bad', label: 'Poison message blocks the queue', desc: 'The same job is retried for ever at the head of the queue. Nothing behind it is ever delivered.', sw: { dlq: false }, run: (s) => startOrder(s, { poison: true }) },
      { id: 'optout', label: 'SMS turned off mid-order', desc: 'After the first text, the shopper turns SMS off. Preferences are read at send time, so no more texts.', run: (s) => { startOrder(s); s.schedule(700, () => setPref(s, 'sms', false)); } },
      { id: 'optout-bad', label: 'SMS turned off, preferences copied at order time', desc: 'The order carries the preferences it was placed with. Three more texts go to someone who opted out.', sw: { livePrefs: false }, run: (s) => { startOrder(s); s.schedule(700, () => setPref(s, 'sms', false)); } },
    ]),
    initialState: () => ({
      config: { dedupe: true, ordered: true, dlq: true, livePrefs: true },
      prefs: { push: true, email: true, sms: true, inapp: true },
      prefChanges: [],
      order: null, received: [], expected: {}, held: {}, superseded: 0,
      attempts: {}, retrying: {}, dead: [], delivered: {},
      stats: { pushes: 0, emails: 0, sms: 0, inapp: 0, retries: 0, held: 0 },
      seq: { ev: 0, job: 0 },
    }),
    initialUI: () => ({ phone: { pushes: [], inbox: [], sms: [], emails: [], banner: null, tab: 'alerts' } }),
    actions: {
      order(sim, a) { startOrder(sim, a); },
      pref(sim, a) { setPref(sim, a.channel, !!a.on); },
      set: Y.setAction,
    },
    handlers: {
      events: {
        publish(ctx, p) {
          const st = ctx.state;
          const ev = { type: `order.${p.type}`, eventId: `${p.orderId}/${p.seq}`, payload: Object.assign({ prefsAtOrder: Object.assign({}, st.order.prefs) }, p), actionId: ctx.actionId };
          if (ctx.mode('reorder') && p.seq === 2) {
            ctx.log({ op: `${ev.eventId} delayed in the broker`, status: 'fault', actionId: ctx.actionId, detail: 'This partition is behind: the next event will be delivered first.' });
            ctx.spawn(function* (c) { yield c.wait(STEP_MS + 300); c.sim.enqueue('orderEvents', ev); }, { self: 'events', quiet: true });
          } else ctx.sim.enqueue('orderEvents', ev);
          return { appended: true };
        },
      },
      prefs: { get(ctx) { return Object.assign({}, ctx.state.prefs); } },
      push: { send: function* (ctx, p) { return ctx.must(yield ctx.call('phone', 'push', p, { timeout: 500 })); } },
      sms: { send: function* (ctx, p) { return ctx.must(yield ctx.call('phone', 'sms', p, { timeout: 500 })); } },
      email: { send: function* (ctx, p) { return ctx.must(yield ctx.call('phone', 'email', p, { timeout: 500 })); } },
      inbox: {
        add(ctx, p) {
          const ui = ctx.ui.phone;
          ui.inbox.push({ title: p.title, text: p.text, seq: p.seq, t: ctx.now() });
          ctx.state.stats.inapp++;
          ctx.state.received.push({ channel: 'inapp', seq: p.seq, key: p.key, t: ctx.now() });
          return { ok: true };
        },
      },
      phone: {
        push(ctx, p) {
          const ui = ctx.ui.phone;
          ui.pushes.unshift({ title: p.title, text: p.text, seq: p.seq, t: ctx.now() });
          ui.banner = { title: p.title, body: p.text, tone: 'ok', t: ctx.now() };
          ctx.state.stats.pushes++;
          ctx.state.received.push({ channel: 'push', seq: p.seq, key: p.key, t: ctx.now() });
          return { shown: true };
        },
        sms(ctx, p) {
          const ui = ctx.ui.phone;
          ui.sms.unshift({ text: `AMZN: ${p.text}`, seq: p.seq, t: ctx.now(), optedOut: !!p.optedOut });
          ctx.state.stats.sms++;
          ctx.state.received.push({ channel: 'sms', seq: p.seq, key: p.key, t: ctx.now(), optedOut: !!p.optedOut });
          return { shown: true };
        },
        email(ctx, p) {
          const ui = ctx.ui.phone;
          ui.emails.unshift({ title: p.title, seq: p.seq, t: ctx.now() });
          ctx.state.stats.emails++;
          ctx.state.received.push({ channel: 'email', seq: p.seq, key: p.key, t: ctx.now() });
          return { received: true };
        },
      },
    },
    setup(sim) {
      // Notification service: order events -> send jobs, with per-order sequencing.
      const fanOut = function* (ctx, p, actionId) {
        const st = ctx.state;
        let prefs = p.prefsAtOrder;
        if (st.config.livePrefs) {
          const r = yield ctx.call('prefs', 'get', { user: 'you' }, { timeout: 600, actionId });
          if (!r.ok) return false;
          prefs = r.value;
        }
        const [, title, text] = STEPS[p.seq - 1];
        const chosen = CHANNELS.filter((c) => prefs[c]);
        for (const channel of chosen) {
          const key = `${p.orderId}/${p.seq}/${channel}`;
          ctx.sim.enqueue('sends', { type: 'send', eventId: key, payload: { key, channel, seq: p.seq, orderId: p.orderId, title, text, poison: p.poison && channel === 'push' }, actionId });
        }
        ctx.log({ op: `${p.orderId}/${p.seq}: ${chosen.length} send jobs`, status: 'ok', actionId, detail: `${title} → ${chosen.join(', ')}${chosen.length < CHANNELS.length ? ` (${CHANNELS.filter((c) => !prefs[c]).join(', ')} off)` : ''}.` });
        st.expected[p.orderId] = p.seq + 1;
        return true;
      };
      Y.consumer(sim, 'orderEvents', 'notif', 'notif', function* (ctx, msg) {
        const st = ctx.state;
        const p = msg.payload;
        const expected = st.expected[p.orderId] || 1;
        if (st.config.ordered) {
          if (p.seq > expected) {
            st.held[p.orderId] = st.held[p.orderId] || {};
            st.held[p.orderId][p.seq] = { p, actionId: msg.actionId };
            st.stats.held++;
            ctx.log({ op: `${msg.eventId} held`, status: 'note', actionId: msg.actionId, detail: `Step ${p.seq} arrived but step ${expected} has not been sent yet. Holding it so the shopper hears things in order.` });
            return true;
          }
          if (p.seq < expected) {
            st.superseded++;
            ctx.log({ op: `${msg.eventId} superseded`, status: 'dup', actionId: msg.actionId, detail: `Step ${expected - 1} was already sent; this older step is dropped.` });
            return true;
          }
        }
        if (!(yield* fanOut(ctx, p, msg.actionId))) return false;
        // Release anything held that is now next in line.
        let h;
        while (st.held[p.orderId] && (h = st.held[p.orderId][st.expected[p.orderId]])) {
          delete st.held[p.orderId][h.p.seq];
          ctx.log({ op: `${p.orderId}/${h.p.seq} released`, status: 'ok', actionId: h.actionId, detail: 'Its predecessor has been sent; sending this one now.' });
          if (!(yield* fanOut(ctx, h.p, h.actionId))) break;
        }
        return true;
      }, (s) => s.state.config.dedupe);
      // Senders: render, deliver, retry, dead-letter. A provider failure is retried
      // through a delayed re-enqueue (like a visibility timeout) so other channels
      // keep flowing; a poison message is retried in place, which blocks the queue.
      Y.consumer(sim, 'sends', 'sender', 'sender', function* (ctx, msg) {
        const st = ctx.state;
        const p = msg.payload;
        const lane = `${p.orderId}/${p.channel}`;
        if (st.config.dedupe && st.delivered[p.key]) { st.dupSkipped = (st.dupSkipped || 0) + 1; ctx.log({ op: `${p.key} already delivered`, status: 'dup', actionId: msg.actionId, detail: 'The dedupe store has this key; skipping.' }); return true; }
        const retryLater = (delay, why) => {
          st.retrying[lane] = st.retrying[lane] || {};
          st.retrying[lane][p.seq] = true;
          ctx.spawn(function* (c) {
            yield c.wait(delay);
            c.sim.enqueue('sends', { type: 'send', eventId: `${p.key}#${++c.state.seq.job}`, payload: p, actionId: msg.actionId });
          }, { self: 'sender', quiet: true });
          if (why) ctx.log({ op: `${p.key} retry in ${delay} ms`, status: 'retry', actionId: msg.actionId, detail: why });
        };
        // Keep each channel in order: an earlier step of the same order is still being retried.
        const earlier = Object.keys(st.retrying[lane] || {}).map(Number).filter((q) => q < p.seq);
        if (earlier.length) { retryLater(300, `Step ${earlier[0]} on ${p.channel} is still being retried; this one waits so the shopper hears things in order.`); return true; }
        const attempt = (st.attempts[p.key] = (st.attempts[p.key] || 0) + 1);
        if (attempt > 1) st.stats.retries++;
        const settled = () => { if (st.retrying[lane]) delete st.retrying[lane][p.seq]; };
        const park = (why) => {
          settled();
          ctx.sim.enqueue('dead', { type: 'dead', eventId: p.key, payload: Object.assign({ why }, p), actionId: msg.actionId });
          st.dead.push({ key: p.key, why, t: ctx.now() });
          ctx.log({ op: `${p.key} dead-lettered`, status: 'fault', actionId: msg.actionId, detail: `${why} after ${attempt} attempts. Parked for a human; the queue moves on.` });
          ctx.sim.setLedger(msg.actionId, 'async', 'no', `${p.channel} message dead-lettered.`);
        };
        if (p.poison) {
          ctx.log({ op: `${p.key} render failed`, status: 'fail', actionId: msg.actionId, detail: `Template error: the ${p.channel} template references a field this event does not have. Attempt ${attempt}.` });
          if (st.config.dlq && attempt >= MAX_ATTEMPTS) { park('Template error'); return true; }
          return false;
        }
        const payload = Object.assign({ optedOut: p.channel === 'sms' && !st.prefs.sms }, p);
        const r = yield ctx.call(PROVIDER[p.channel], p.channel === 'inapp' ? 'add' : 'send', payload, { timeout: 1500, actionId: msg.actionId });
        if (r.ok) {
          settled();
          st.delivered[p.key] = (st.delivered[p.key] || 0) + 1;
          const o = st.order;
          if (o && p.seq === o.step && CHANNELS.every((c) => !st.prefs[c] || st.delivered[`${p.orderId}/${p.seq}/${c}`])) ctx.sim.setLedger(msg.actionId, 'async', 'yes', 'Delivered on every channel the shopper wants.');
          return true;
        }
        if (attempt >= MAX_PROVIDER_ATTEMPTS) { park(`${ctx.sim.nodes[PROVIDER[p.channel]].label} unavailable`); return true; }
        retryLater(Math.min(2400, 300 * 2 ** (attempt - 1)), `${ctx.sim.nodes[PROVIDER[p.channel]].label}: ${r.error.message} Attempt ${attempt} of ${MAX_PROVIDER_ATTEMPTS}.`);
        return true;
      }, (s) => s.state.config.dedupe);
    },
    consistency(sim) {
      const st = sim.state;
      const rec = st.received;
      const keys = rec.map((x) => x.key);
      const dupKey = keys.find((k, i) => keys.indexOf(k) !== i);
      if (dupKey) return { key: 'wrong', label: `The phone received “${STEPS[Number(dupKey.split('/')[1]) - 1][1]}” twice on ${dupKey.split('/')[2]}. Duplicate notifications, and a duplicate SMS bill.` };
      const optedOut = rec.find((x) => x.optedOut);
      if (optedOut) return { key: 'wrong', label: 'A text was sent after the shopper turned SMS off. That is a compliance problem, not a glitch.' };
      for (const ch of CHANNELS) {
        const seqs = rec.filter((x) => x.channel === ch).map((x) => x.seq);
        for (let i = 1; i < seqs.length; i++) if (seqs[i] < seqs[i - 1]) return { key: 'wrong', label: `On ${ch === 'inapp' ? 'the in-app list' : ch}, “${STEPS[seqs[i - 1] - 1][1]}” arrived before “${STEPS[seqs[i] - 1][1]}”. The shopper was told the order shipped before it was packed.` };
      }
      if (st.dead.length) return { key: 'stale', label: `${st.dead.length} message${st.dead.length > 1 ? 's are' : ' is'} in the dead-letter queue (${st.dead[0].key}). Everything else was delivered; a human must look at that one.` };
      const o = st.order;
      if (!o) return { key: 'ok', label: 'No order yet.' };
      const want = [];
      for (let s = 1; s <= o.step; s++) for (const c of CHANNELS) if (st.prefs[c]) want.push(`${o.id}/${s}/${c}`);
      const missing = want.filter((k) => !st.delivered[k]);
      const heldCount = Object.values(st.held).reduce((a, h) => a + Object.keys(h).length, 0);
      if (missing.length || heldCount || sim.queueStats('sends').depth || sim.queueStats('orderEvents').depth || o.step < STEPS.length) {
        const blocked = Object.values(st.attempts).some((a) => a >= MAX_ATTEMPTS) && !st.config.dlq;
        return { key: 'stale', label: blocked ? `The send queue is blocked by a job that fails every attempt. ${missing.length} messages behind it will never be delivered.` : heldCount ? `${heldCount} event${heldCount > 1 ? 's' : ''} held until ${heldCount > 1 ? 'their predecessors arrive' : 'its predecessor arrives'}.` : `${missing.length} message${missing.length === 1 ? '' : 's'} still on the way.` };
      }
      return { key: 'ok', label: 'Every step reached the shopper once, in order, only through the channels they want.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const ui = sim.ui.phone;
      return [
        { label: 'Pushes', value: ui.pushes.length },
        { label: 'Texts', value: ui.sms.length, tone: ui.sms.some((s) => s.optedOut) ? 'fail' : '' },
        { label: 'Emails', value: ui.emails.length },
        { label: 'In-app entries', value: ui.inbox.length },
        { label: 'Retries', value: st.stats.retries, tone: st.stats.retries > 5 ? 'warn' : '' },
        { label: 'Dead letters', value: st.dead.length, tone: st.dead.length ? 'warn' : '' },
        { label: 'Send queue', value: sim.queueStats('sends').depth },
        { label: 'Duplicates dropped', value: st.dupSkipped || 0 },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Shopper’s phone']], {
          note: 'The phone shows pushes as banners and lists everything it received per channel. The console places an order and steps it through confirmed, packed, shipped, delivered.',
          side: `<p class="ops-title">Order console</p><div class="ops-traffic">
              ${Y.btn('order', 'Place an order', {})}
              ${Y.btn('order', 'Place an order with a broken template', { arg: { poison: true }, cls: 'secondary' })}
            </div><div data-ref="progress"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const ui = sim.ui.phone;
        const tabs = [['alerts', 'Alerts'], ['sms', 'Texts'], ['email', 'Email'], ['prefs', 'Prefs']];
        const o = st.order;
        const busy = o && o.step < STEPS.length;
        const buy = `<div class="yt-card"><div class="yt-thumb" style="--h:200"><span aria-hidden="true">◉</span></div><div><strong>Echo Dot (5th gen)</strong><p class="app-sub">${busy ? `Order A1: step ${o.step} of ${STEPS.length}` : o ? 'Order A1 delivered' : 'Buy again'}</p></div></div>
          ${Y.btn('order', busy ? 'Order in progress…' : 'Buy again', { cls: 'go', disabled: !!busy })}`;
        const nav = `<div class="app-row" style="flex-wrap:wrap">${tabs.map(([k, v]) => Y.btn('set', v, { arg: { field: 'phone.tab', value: k }, cls: ui.tab === k ? '' : 'secondary' })).join('')}</div>`;
        const card = (n, extra) => `<div class="app-card ${extra || ''}"><strong>${esc(n.title || n.text)}</strong>${n.title ? `<span class="app-sub">${esc(n.text || '')}</span>` : ''}</div>`;
        let body = '';
        if (ui.tab === 'alerts') body = `<p class="app-sub">Pushes (${ui.pushes.length})</p>${ui.pushes.slice(0, 4).map((n) => card(n, 'is-ok')).join('') || '<p class="app-sub">None yet.</p>'}
          <p class="app-sub">🔔 In-app (${ui.inbox.length})</p>${ui.inbox.slice(-4).reverse().map((n) => card(n)).join('') || '<p class="app-sub">Nothing yet.</p>'}`;
        if (ui.tab === 'sms') body = `<p class="app-sub">Texts (${ui.sms.length})</p>${ui.sms.slice(0, 6).map((n) => `<div class="app-card ${n.optedOut ? 'is-fail' : ''}">${esc(n.text)}${n.optedOut ? '<span class="app-sub">✕ Sent after you turned SMS off</span>' : ''}</div>`).join('') || '<p class="app-sub">None yet.</p>'}`;
        if (ui.tab === 'email') body = `<p class="app-sub">Inbox (${ui.emails.length})</p>${ui.emails.slice(0, 6).map((n) => `<div class="app-card"><strong>Amazon: ${esc(n.title)}</strong></div>`).join('') || '<p class="app-sub">No email yet.</p>'}`;
        if (ui.tab === 'prefs') body = `<p class="app-sub">Order updates</p>${CHANNELS.map((c) => `<div class="app-card"><span class="app-kv"><span>${c === 'inapp' ? 'In-app list' : c === 'sms' ? 'SMS' : c[0].toUpperCase() + c.slice(1)}</span><span>${Y.btn('pref', st.prefs[c] ? 'On' : 'Off', { arg: { channel: c, on: !st.prefs[c] }, cls: st.prefs[c] ? '' : 'secondary' })}</span></span></div>`).join('')}`;
        Y.paint(el, sim, 'phone', { head: '<div><p class="app-title">Amazon</p><p class="app-sub">Notifications</p></div>', buy, nav, body }, {}, ui.banner);
        const c = sim.scenario.consistency(sim);
        const steps = STEPS.map(([type, title], i) => {
          const seq = i + 1;
          const done = o && seq <= o.step;
          const sent = CHANNELS.filter((ch) => st.delivered[`A1/${seq}/${ch}`]);
          const held = o && st.held[o.id] && st.held[o.id][seq];
          const dead = st.dead.filter((d) => d.key.startsWith(`A1/${seq}/`)).map((d) => d.key.split('/')[2]);
          return `<div class="ops-row" data-tone="${dead.length ? 'fail' : held ? 'warn' : ''}"><div class="ops-name">${seq}. ${esc(title)}<span>${!done ? 'not yet' : held ? 'held: waiting for the previous step' : `${sent.length ? 'sent: ' + sent.join(', ') : 'sending…'}${dead.length ? ` · dead: ${dead.join(', ')}` : ''}`}</span></div></div>`;
        }).join('');
        SDL.ui.paintSections(el.querySelector('[data-ref="progress"]'), {
          title: '<p class="ops-title">Order A1</p>',
          steps: `<div class="ops-shards">${steps}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
