/*
 * Providers: circuit breakers, bulkheads, rate limits, failover, receipts.
 * Steady traffic flows to APNs, FCM, and SMS provider A through one worker
 * pool. A provider that stops answering ties up a worker for every timeout;
 * a breaker turns that into a fast failure. A provider that is merely slow
 * never trips the breaker but still eats the pool; separate pools per
 * provider keep it contained. FCM's quota answers 429 and wants Retry-After
 * honoured. SMS A fails over to B at a higher price. And "accepted" is not
 * "delivered": receipts arrive later, sometimes twice, sometimes out of order.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const RATE = { ios: 40, android: 15, sms: 10 }; // background jobs per second
  const POOL = { shared: 12, apns: 5, fcm: 4, sms: 3 };
  const PROVIDER_TIMEOUT = 1000;
  const TRIP = 5; // consecutive failures that open a breaker
  const OPEN_MS = 1500;
  const FCM_QUOTA = 40; // per second, while throttled
  const FCM_PACE = 38; // our token bucket, just under the quota
  const BURST = 120;
  const OTP_SLO = 3000;
  const PUSH_SLO = 3000;
  const DLR_WAIT = 3000; // resend SMS through the other provider if no "delivered" receipt by then
  const PRICE = { smsA: 0.0079, smsB: 0.0095 };
  const ORDER = { queued: 0, accepted: 1, sent: 2, delivered: 3, failed: 3 };
  const PNAME = { apns: 'APNs', fcm: 'FCM', smsA: 'SMS A', smsB: 'SMS B' };
  const QUEUES = ['q_shared', 'q_apns', 'q_fcm', 'q_sms'];
  const QPOOL = { q_shared: 'shared', q_apns: 'apns', q_fcm: 'fcm', q_sms: 'sms' };

  const providerFor = (ch) => (ch === 'ios' ? 'apns' : ch === 'android' ? 'fcm' : 'smsA');
  const routeQueue = (st, ch) => (!st.config.isolate ? 'q_shared' : ch === 'ios' ? 'q_apns' : ch === 'android' ? 'q_fcm' : 'q_sms');
  const poolSize = (sim, id) => (sim.nodes.pool.modes.leak ? (id === 'shared' ? 3 : 1) : POOL[id]);

  function enqueueJob(sim, p, actionId) {
    sim.enqueue(routeQueue(sim.state, p.ch), { type: p.ch, eventId: `${p.id}#${p.attempt || 1}`, payload: p, actionId, quiet: !p.maya });
  }

  function mayaSend(sim, kind) {
    const st = sim.state;
    const otp = kind === 'otp';
    sim.startAction(otp ? 'Maya: request a sign-in code by SMS' : 'Orders team: push “order shipped” to Maya’s iPhone', function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'The phone shows the result.'], retrySafe: ['yes', 'One message id, whatever provider carries it.'] });
      const id = `${otp ? 'otp' : 'push'}-${++st.seq}`;
      const ch = otp ? 'sms' : 'ios';
      st.msgs[id] = { id, ch, kind, t0: ctx.now(), status: 'queued', provider: null, history: [], resent: false, done: null, inbox: false };
      enqueueJob(ctx.sim, { id, ch, kind, maya: true, t0: ctx.now(), attempt: 1 }, ctx.actionId);
      Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', `Queued for ${PNAME[providerFor(ch)]}.`] });
      ctx.explain(`${otp ? 'The code' : 'The push'} is queued ${st.config.isolate ? `in the ${PNAME[providerFor(ch)].replace(/ A$/, '')} partition with its own pool` : 'in the shared queue, behind whatever is already waiting for the shared pool'}.`);
    }, { self: otp ? 'phone' : 'console' });
  }

  function burst(sim) {
    sim.startAction(`Deals team: price drop to ${BURST} Android users`, function* (ctx) {
      Y.L(ctx, { displayed: ['n/a'], accepted: 'yes', committed: 'yes', retrySafe: 'yes' });
      for (let i = 0; i < BURST; i++) enqueueJob(ctx.sim, { id: `deal${i}`, ch: 'android', kind: 'deal', maya: false, t0: ctx.now(), attempt: 1, burst: true }, ctx.actionId);
      Y.L(ctx, { async: ['pending', `${BURST} pushes for FCM.`] });
      ctx.explain(`${BURST} Android pushes at once.${ctx.sim.nodes.fcm.modes.throttle ? ` FCM is enforcing a quota of ${FCM_QUOTA} a second for this project.` : ''}`);
    }, { self: 'console' });
  }

  function* sendJob(c, m) {
    const st = c.state;
    const p = m.payload;
    const aid = m.actionId;
    const provider = p.provider || providerFor(p.ch);
    const msg = p.maya ? st.msgs[p.id] : null;
    if (provider === 'fcm' && st.config.bucket) {
      // Pace to the quota and honour Retry-After: wait for a token instead of sending into a 429.
      for (;;) {
        const now = c.now();
        st.tokens = Math.min(10, st.tokens + ((now - st.tokT) * FCM_PACE) / 1000);
        st.tokT = now;
        if (now >= st.fcmPauseUntil && st.tokens >= 1) { st.tokens -= 1; break; }
        yield c.wait(5);
      }
    }
    if (msg) msg.provider = provider;
    st.inflight[provider]++;
    let r = yield c.call('breaker', 'send', { provider, id: p.id, maya: p.maya, kind: p.kind, ch: p.ch }, { timeout: PROVIDER_TIMEOUT + 200 });
    // Without the bucket, a 429 is retried in place 50 ms later, holding the slot: the naive client loop.
    let tries = p.attempt || 1;
    while (!st.config.bucket && !r.ok && r.error.code === 'RATE_LIMITED' && tries < 4) {
      st.stats.r429++;
      st.stats.retries++;
      tries++;
      yield c.wait(50);
      r = yield c.call('breaker', 'send', { provider, id: p.id, maya: p.maya, kind: p.kind, ch: p.ch }, { timeout: PROVIDER_TIMEOUT + 200 });
    }
    st.inflight[provider]--;
    if (r.ok) {
      if (p.ch === 'sms') { st.cost += PRICE[provider]; st.stats.sms[provider]++; }
      if (p.burst) st.stats.burstDone++;
      if (msg) {
        if (p.ch === 'sms') {
          if (ORDER[msg.status] == null || msg.status === 'queued') { msg.status = 'accepted'; msg.history.push([c.now(), `${PNAME[provider]}: accepted`]); }
          c.sim.setLedger(aid, 'async', 'pending', `${PNAME[provider]} accepted. Waiting for its receipt.`);
          if (!p.resend) c.spawn(function* (cc) {
            yield cc.wait(DLR_WAIT);
            const mm = cc.state.msgs[p.id];
            if (mm.status !== 'delivered' && !mm.resent && cc.state.config.fallback) {
              mm.resent = true;
              cc.state.stats.dlrResends++;
              cc.log({ op: `no “delivered” receipt: resend through ${PNAME[provider === 'smsA' ? 'smsB' : 'smsA']}`, status: 'retry', actionId: aid, detail: `${DLR_WAIT / 1000} s after ${PNAME[provider]} accepted it, the message is still “${mm.status}”. The platform assumes it was lost and sends it again through the other provider.` });
              enqueueJob(cc.sim, Object.assign({}, p, { provider: provider === 'smsA' ? 'smsB' : 'smsA', attempt: (p.attempt || 1) + 1, resend: true }), aid);
            }
          }, { quiet: true });
        } else c.sim.setLedger(aid, 'async', 'yes', `Delivered by ${PNAME[provider]}.`);
      }
      return;
    }
    const code = r.error.code;
    const attempt = (p.attempt || 1) + 1;
    if (code === 'RATE_LIMITED') {
      st.stats.r429++;
      const ra = (r.error.detail && r.error.detail.retryAfter) || 500;
      if (st.config.bucket) st.fcmPauseUntil = Math.max(st.fcmPauseUntil, c.now() + ra);
      if (!st.config.bucket || attempt > 4) {
        st.stats.dead++;
        if (p.burst) st.stats.burstDead++;
        return;
      }
      st.stats.retries++;
      c.spawn(function* (cc) { yield cc.wait(ra); enqueueJob(cc.sim, Object.assign({}, p, { attempt }), aid); }, { quiet: 'all' });
      return;
    }
    if (p.ch === 'sms') {
      if (st.config.fallback && provider === 'smsA') {
        st.stats.failovers++;
        if (msg) c.log({ op: 'fail over to SMS B', status: 'retry', actionId: aid, detail: `SMS A answered ${code}. Same message id, other provider. B costs $${PRICE.smsB} a message instead of $${PRICE.smsA}.` });
        enqueueJob(c.sim, Object.assign({}, p, { provider: 'smsB', attempt }), aid);
        return;
      }
      if (attempt > 4) {
        st.stats.dead++;
        if (msg) { msg.status = 'dead'; c.log({ op: 'SMS gave up', status: 'fault', actionId: aid, detail: `Four attempts on ${PNAME[provider]}, all ${code}. No other provider is configured.` }); c.sim.setLedger(aid, 'async', 'no', 'No provider could send it.'); }
        return;
      }
      st.stats.retries++;
      const delay = 300 * 2 ** (attempt - 2);
      if (msg) c.log({ op: `retry in ${delay} ms`, status: 'retry', actionId: aid, detail: `${PNAME[provider]} answered ${code}. Attempt ${attempt - 1} of 4.` });
      c.spawn(function* (cc) { yield cc.wait(delay); enqueueJob(cc.sim, Object.assign({}, p, { attempt }), aid); }, { quiet: 'all' });
      return;
    }
    // A push that cannot be sent: fail fast to the inbox when the breaker is open, otherwise retry with backoff.
    if (code === 'CIRCUIT_OPEN' || attempt > 3) {
      st.stats.toInbox++;
      if (msg) {
        msg.inbox = true;
        msg.done = c.now();
        c.ui.phone.inbox.unshift({ title: 'Your order has shipped', text: 'Arriving Thursday.', ms: c.now() - p.t0 });
        c.log({ op: 'push → in-app inbox', status: 'note', actionId: aid, detail: code === 'CIRCUIT_OPEN' ? `The ${PNAME[provider]} breaker is open, so the push failed in about a millisecond and went straight to the inbox.` : `${PNAME[provider]} failed three times. The message is in the inbox for when Maya opens the app.` });
        c.sim.setLedger(aid, 'async', 'yes', 'In the in-app inbox (push failed).');
      }
      return;
    }
    st.stats.retries++;
    c.spawn(function* (cc) { yield cc.wait(300 * 2 ** (attempt - 2)); enqueueJob(cc.sim, Object.assign({}, p, { attempt }), aid); }, { quiet: 'all' });
  }

  function* smsSend(ctx, p, name) {
    const st = ctx.state;
    if (!p.maya) return { accepted: true };
    const rec = ctx.sim.nodes.receipts.modes;
    const post = (delay, status) => ctx.spawn(function* (c) {
      yield c.wait(delay);
      for (let i = 0; i < (rec.duplicate ? 2 : 1); i++) yield c.call('receipts', 'post', { id: p.id, status, provider: name }, { timeout: 500 });
    }, { self: name, quiet: false });
    if (name === 'smsA' && ctx.mode('asyncFail')) {
      post(200, 'sent');
      post(5000, 'failed');
      return { accepted: true };
    }
    ctx.must(yield ctx.call('phone', 'sms', { id: p.id, provider: name }, { timeout: 500 }));
    post(rec.reorder ? 900 : 200, 'sent');
    post(600, 'delivered');
    void st;
    return { accepted: true };
  }

  const sc = (SDL.scenarios['nt-providers'] = {
    id: 'nt-providers',
    seed: 1123,
    minHopMs: 5,
    productWidth: 660,
    intro: `Steady traffic: about ${RATE.ios} iOS pushes, ${RATE.android} Android pushes, and ${RATE.sms} SMS a second. Ask for a sign-in code on Maya’s phone, then take APNs down or slow it, make FCM answer 429, fail SMS provider A, and scramble the delivery receipts.`,
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'console', label: 'Product traffic', sub: 'Steady + deals team', kind: 'client', x: 90, y: 90, latency: 1, role: 'Background transactional traffic, plus a deals team that sometimes sends a burst.', owns: ['Nothing'] },
        { id: 'phone', label: 'Maya’s iPhone', sub: 'Push, SMS, inbox', kind: 'client', x: 90, y: 470, latency: 1, role: 'Receives pushes through APNs and texts from whichever SMS provider sends them. The app inbox holds what push could not deliver.', ops: [{ name: 'push', desc: 'Show a push.' }, { name: 'sms', desc: 'Show a text.' }], owns: ['Nothing'] },
        { id: 'sendq', label: 'Send queue', sub: 'Shared or per provider', kind: 'queue', x: 300, y: 90, latency: 2, role: 'With pool isolation, each provider has its own partition; otherwise one shared queue in arrival order.', owns: ['send jobs'] },
        { id: 'pool', label: 'Worker pool', sub: `${POOL.shared} shared or ${POOL.apns}/${POOL.fcm}/${POOL.sms}`, kind: 'worker', x: 300, y: 280, latency: 2, role: `Each send holds a slot until the provider answers or the ${PROVIDER_TIMEOUT / 1000} s timeout fires. Shared: any provider can take every slot. Isolated: APNs ${POOL.apns}, FCM ${POOL.fcm}, SMS ${POOL.sms}.`, owns: ['Slots', 'Retry policy', 'Token bucket'] },
        { id: 'breaker', label: 'Provider gateway', sub: `Breaker: ${TRIP} failures, ${OPEN_MS / 1000} s open`, kind: 'service', x: 560, y: 280, latency: 1, role: `One circuit breaker per provider. ${TRIP} failures or timeouts in a row open it: calls then fail in a millisecond for ${OPEN_MS / 1000} s, then one probe decides. Slow answers that succeed do not count as failures.`, ops: [{ name: 'send', desc: 'Forward to a provider.' }], owns: ['Breaker state per provider'] },
        { id: 'apns', label: 'APNs', sub: 'iOS push', kind: 'service', x: 820, y: 90, latency: 30, role: 'Apple’s push service.', ops: [{ name: 'send', desc: 'Deliver a push.' }], owns: ['Nothing of ours'] },
        { id: 'fcm', label: 'FCM', sub: 'Android push, quota', kind: 'service', x: 820, y: 220, latency: 30, role: `Google’s push service. Over the project’s quota it answers 429 with Retry-After.`, ops: [{ name: 'send', desc: 'Deliver a push.' }], owns: ['Nothing of ours'] },
        { id: 'smsA', label: 'SMS A', sub: `Primary, $${PRICE.smsA}`, kind: 'service', x: 820, y: 350, latency: 40, role: 'Primary SMS provider. Accepting a message is not delivering it: the carrier’s result comes later as a receipt.', ops: [{ name: 'send', desc: 'Send a text.' }], owns: ['Nothing of ours'] },
        { id: 'smsB', label: 'SMS B', sub: `Fallback, $${PRICE.smsB}`, kind: 'service', x: 820, y: 480, latency: 45, role: 'Second SMS provider, more expensive. Used on failover and when a message has no receipt in time.', ops: [{ name: 'send', desc: 'Send a text.' }], owns: ['Nothing of ours'] },
        { id: 'receipts', label: 'Receipts webhook', sub: 'sent, delivered, failed', kind: 'gateway', x: 1060, y: 410, latency: 2, role: 'Providers post delivery receipts here. They can arrive twice or out of order; with the state machine a message’s status only moves forward.', ops: [{ name: 'post', desc: 'Apply a receipt.' }], owns: ['Message status'] },
      ],
      edges: [
        { from: 'console', to: 'sendq', latency: 3 },
        { from: 'phone', to: 'sendq', latency: 20, via: [[200, 470], [200, 90]] },
        { from: 'sendq', to: 'pool', latency: 2 },
        { from: 'pool', to: 'breaker', latency: 1 },
        { from: 'breaker', to: 'apns', latency: 3, via: [[690, 280], [690, 90]] },
        { from: 'breaker', to: 'fcm', latency: 3, via: [[690, 280], [690, 220]] },
        { from: 'breaker', to: 'smsA', latency: 3, via: [[690, 280], [690, 350]] },
        { from: 'breaker', to: 'smsB', latency: 3, via: [[690, 280], [690, 480]] },
        { from: 'apns', to: 'phone', latency: 30, via: [[960, 90], [960, 560], [90, 560]] },
        { from: 'smsA', to: 'phone', latency: 40, via: [[940, 350], [940, 560], [90, 560]] },
        { from: 'smsB', to: 'phone', latency: 40, via: [[820, 560], [90, 560]] },
        { from: 'smsA', to: 'receipts', latency: 20 },
        { from: 'smsB', to: 'receipts', latency: 20 },
      ],
      queues: [
        { id: 'q_shared', broker: 'sendq', label: 'shared queue', groups: ['pool'] },
        { id: 'q_apns', broker: 'sendq', label: 'APNs partition', groups: ['pool'] },
        { id: 'q_fcm', broker: 'sendq', label: 'FCM partition', groups: ['pool'] },
        { id: 'q_sms', broker: 'sendq', label: 'SMS partition', groups: ['pool'] },
      ],
    },
    modeLabels: { throttle: `Quota: ${FCM_QUOTA} a second, 429 above`, asyncFail: 'Accepts, then fails at the carrier', leak: 'Connection leak: most slots unusable', stuckOpen: 'APNs breaker stuck open' },
    failures: [
      { id: 'apns-down', node: 'apns', mode: 'hang', label: 'APNs not responding', desc: `Connections open, no answers. Every call waits the full ${PROVIDER_TIMEOUT / 1000} s timeout.` },
      { id: 'apns-slow', node: 'apns', mode: 'slow', params: { factor: 25 }, label: 'APNs slow (25×)', desc: 'Every push succeeds, in about 750 ms instead of 30. Under the timeout, so the breaker never trips.' },
      { id: 'fcm-429', node: 'fcm', mode: 'throttle', label: 'FCM rate-limits', desc: `FCM enforces ${FCM_QUOTA} a second and answers 429 with Retry-After above that.` },
      { id: 'smsA-down', node: 'smsA', mode: 'down', label: 'SMS A down', desc: 'Every call to SMS A fails at once.' },
      { id: 'smsA-async', node: 'smsA', mode: 'asyncFail', label: 'SMS A fails asynchronously', desc: 'SMS A says “accepted”, then the carrier drops the message. The “failed” receipt comes 5 s later.' },
      { id: 'receipts-dup', node: 'receipts', mode: 'duplicate', label: 'Receipts delivered twice', desc: 'The provider retries its webhook, so every receipt arrives twice.' },
      { id: 'receipts-reorder', node: 'receipts', mode: 'reorder', label: 'Receipts out of order', desc: 'The “sent” receipt is retried and lands after “delivered”.' },
      { id: 'pool-leak', node: 'pool', mode: 'leak', label: 'Worker pool exhausted', desc: 'Leaked connections leave a quarter of the slots usable. Everything queues.' },
      { id: 'breaker-stuck', node: 'breaker', mode: 'stuckOpen', label: 'APNs breaker stuck open', desc: 'APNs is fine, but its breaker refuses every call. Pushes go to the inbox until someone notices.' },
    ],
    switches: Y.switches([
      ['breaker', 'Circuit breakers', `Open after ${TRIP} failures in a row; fail fast for ${OPEN_MS / 1000} s, then probe. Off: every call waits for its timeout.`],
      ['isolate', 'Pool per provider', `Bulkheads: APNs ${POOL.apns}, FCM ${POOL.fcm}, SMS ${POOL.sms} slots, each with its own partition. Off: one queue and ${POOL.shared} shared slots.`],
      ['bucket', 'FCM token bucket', `Pace FCM at ${FCM_PACE} a second and honour Retry-After. Off: send as fast as the pool can and retry a 429 after 50 ms.`],
      ['fallback', 'SMS fallback provider', 'Fail SMS A over to B, and resend through the other provider when no “delivered” receipt arrives in time. Off: retry A only.'],
      ['sm', 'Receipt state machine', 'A message’s status only moves forward: queued, accepted, sent, delivered or failed. Off: the latest receipt wins.'],
    ]),
    presets: Y.presets({ breaker: true, isolate: true, bucket: true, fallback: true, sm: true }, [
      { id: 'steady', label: 'Steady traffic', desc: 'A push and a sign-in code for Maya among the background traffic. Both arrive in well under a second; each SMS gets “sent” and “delivered” receipts.', run: (s) => { s.schedule(300, () => mayaSend(s, 'push')); s.schedule(600, () => mayaSend(s, 'otp')); } },
      { id: 'apns-down-no-breaker', label: 'APNs not responding, no breaker, shared pool', desc: `Every iOS push holds a slot for the full ${PROVIDER_TIMEOUT / 1000} s timeout. ${RATE.ios} a second need far more than ${POOL.shared} slots, so the shared pool fills with waiting calls and Maya’s SMS code queues behind them.`, sw: { breaker: false, isolate: false }, run: (s) => { s.inject('apns', 'hang'); s.schedule(1500, () => mayaSend(s, 'push')); s.schedule(2000, () => mayaSend(s, 'otp')); } },
      { id: 'apns-down-breaker', label: 'APNs not responding, with a breaker', desc: `Same outage, same shared pool. After ${TRIP} timeouts the APNs breaker opens: iOS pushes fail in a millisecond and go to the in-app inbox, slots free up, and the code goes through. A probe every ${OPEN_MS / 1000} s checks whether APNs is back.`, sw: { isolate: false }, run: (s) => { s.inject('apns', 'hang'); s.schedule(1500, () => mayaSend(s, 'push')); s.schedule(2000, () => mayaSend(s, 'otp')); } },
      { id: 'apns-slow-shared', label: 'APNs slow, shared pool', desc: 'APNs answers every push, slowly. Nothing fails, so the breaker stays closed, but slow calls hold the shared slots and the SMS code waits.', sw: { isolate: false }, run: (s) => { s.inject('apns', 'slow', { factor: 25 }); s.schedule(3000, () => mayaSend(s, 'otp')); } },
      { id: 'apns-slow-isolated', label: 'APNs slow, pool per provider', desc: `Same slow APNs. It can only take its own ${POOL.apns} slots; iOS pushes queue in their partition while Android and SMS keep their slots. The code arrives on time.`, run: (s) => { s.inject('apns', 'slow', { factor: 25 }); s.schedule(3000, () => mayaSend(s, 'otp')); } },
      { id: 'fcm-429-no-bucket', label: 'FCM 429, retried at once', desc: `FCM enforces ${FCM_QUOTA} a second and the deals team sends ${BURST} pushes. Without pacing the pool sends into the quota, and each 429 is retried 50 ms later, still inside the same second. Four attempts are spent in a fifth of a second and pushes are dropped.`, sw: { bucket: false }, run: (s) => { s.inject('fcm', 'throttle'); burst(s); } },
      { id: 'fcm-429-bucket', label: 'FCM 429, token bucket and Retry-After', desc: `The same burst paced at ${FCM_PACE} a second, under the quota. The burst drains in a few seconds; nothing is dropped.`, run: (s) => { s.inject('fcm', 'throttle'); burst(s); } },
      { id: 'smsA-down-no-fallback', label: 'SMS A down, no fallback', desc: 'Maya’s code is retried on SMS A at 300, 600, and 1,200 ms, all failing. With only one provider, the platform gives up.', sw: { fallback: false }, run: (s) => { s.inject('smsA', 'down'); s.schedule(500, () => mayaSend(s, 'otp')); } },
      { id: 'smsA-down-fallback', label: 'SMS A down, fail over to B', desc: `The first failure sends the code through SMS B, at $${PRICE.smsB} instead of $${PRICE.smsA}. All SMS traffic moves; the bill shows it.`, run: (s) => { s.inject('smsA', 'down'); s.schedule(500, () => mayaSend(s, 'otp')); } },
      { id: 'async-failure', label: 'SMS A accepts, then fails', desc: `SMS A answers “accepted” and the dashboard says sent. No “delivered” receipt comes. After ${DLR_WAIT / 1000} s the platform resends through B. Maya gets her code, late; the “failed” receipt arrives after that and changes nothing.`, run: (s) => { s.inject('smsA', 'asyncFail'); s.schedule(500, () => mayaSend(s, 'otp')); } },
      { id: 'receipts-out-of-order', label: 'Receipts out of order, latest wins', desc: '“Delivered” lands, then a retried “sent” overwrites it. The status now says the text was never delivered, so the platform resends through B. Maya gets two codes and the bill shows two messages.', sw: { sm: false }, run: (s) => { s.inject('receipts', 'reorder'); s.schedule(500, () => mayaSend(s, 'otp')); } },
      { id: 'receipts-state-machine', label: 'Receipts out of order, state machine', desc: 'Same late “sent”. Status only moves forward, so “sent” after “delivered” is ignored. One code.', run: (s) => { s.inject('receipts', 'reorder'); s.schedule(500, () => mayaSend(s, 'otp')); } },
    ]),
    initialState: () => ({
      config: { breaker: true, isolate: true, bucket: true, fallback: true, sm: true },
      msgs: {}, busy: { shared: 0, apns: 0, fcm: 0, sms: 0 }, inflight: { apns: 0, fcm: 0, smsA: 0, smsB: 0 },
      br: { apns: { state: 'closed', fails: 0, until: 0 }, fcm: { state: 'closed', fails: 0, until: 0 }, smsA: { state: 'closed', fails: 0, until: 0 }, smsB: { state: 'closed', fails: 0, until: 0 } },
      tokens: 10, tokT: 0, fcmPauseUntil: 0, fcmWin: { w: -1, n: 0 },
      cost: 0, receipts: [], seq: 0, bg: 0,
      stats: { calls: { apns: 0, fcm: 0, smsA: 0, smsB: 0 }, fastFails: 0, timeouts: 0, r429: 0, dead: 0, burstDead: 0, burstDone: 0, retries: 0, toInbox: 0, failovers: 0, dlrResends: 0, ignored: 0, sms: { smsA: 0, smsB: 0 }, deliveredCount: 0 },
    }),
    initialUI: () => ({ phone: { pushes: [], sms: [], inbox: [], banner: null } }),
    actions: {
      otp(sim) { mayaSend(sim, 'otp'); },
      push(sim) { mayaSend(sim, 'push'); },
      burst(sim) { burst(sim); },
    },
    handlers: {
      breaker: {
        send: function* (ctx, p) {
          const st = ctx.state;
          const b = st.br[p.provider];
          const now = ctx.now();
          if (p.provider === 'apns' && ctx.mode('stuckOpen')) { st.stats.fastFails++; ctx.fail('CIRCUIT_OPEN', 'The APNs breaker is open.'); }
          let probe = false;
          if (st.config.breaker && b.state !== 'closed') {
            if (b.state === 'open' && now >= b.until) { b.state = 'half'; probe = true; ctx.log({ op: `${PNAME[p.provider]} breaker half-open: probe`, status: 'note', detail: 'One call goes through to test the provider. Everything else still fails fast.' }); }
            else { st.stats.fastFails++; ctx.fail('CIRCUIT_OPEN', `The ${PNAME[p.provider]} breaker is open.`); }
          }
          st.stats.calls[p.provider]++;
          const r = yield ctx.call(p.provider, 'send', p, { timeout: PROVIDER_TIMEOUT, quiet: p.maya || probe ? false : 'all' });
          const bad = !r.ok && ['TIMEOUT', 'UNAVAILABLE'].includes(r.error.code);
          if (!r.ok && r.error.code === 'TIMEOUT') st.stats.timeouts++;
          if (st.config.breaker) {
            if (bad) {
              b.fails++;
              if (probe || (b.state === 'closed' && b.fails >= TRIP)) {
                b.state = 'open';
                b.until = ctx.now() + OPEN_MS;
                ctx.log({ op: `${PNAME[p.provider]} breaker opened`, status: 'fault', detail: probe ? 'The probe failed too. Open for another 1.5 s.' : `${TRIP} failures in a row. Calls to ${PNAME[p.provider]} now fail fast for ${OPEN_MS / 1000} s.` });
              }
            } else if (r.ok) {
              if (b.state !== 'closed') ctx.log({ op: `${PNAME[p.provider]} breaker closed`, status: 'recovered', detail: 'The probe succeeded. Traffic flows again.' });
              b.state = 'closed';
              b.fails = 0;
            } else if (probe) b.state = 'open';
          }
          return ctx.must(r);
        },
      },
      apns: {
        send: function* (ctx, p) {
          if (!p.maya) return { ok: true };
          return ctx.must(yield ctx.call('phone', 'push', p, { timeout: 500 }));
        },
      },
      fcm: {
        send(ctx) {
          const st = ctx.state;
          if (ctx.mode('throttle')) {
            const w = Math.floor(ctx.now() / 1000);
            if (st.fcmWin.w !== w) st.fcmWin = { w, n: 0 };
            if (st.fcmWin.n >= FCM_QUOTA) ctx.fail('RATE_LIMITED', `429: quota of ${FCM_QUOTA} a second exceeded.`, { retryAfter: (w + 1) * 1000 - ctx.now() });
            st.fcmWin.n++;
          }
          return { ok: true };
        },
      },
      smsA: { send: function* (ctx, p) { return yield* smsSend(ctx, p, 'smsA'); } },
      smsB: { send: function* (ctx, p) { return yield* smsSend(ctx, p, 'smsB'); } },
      receipts: {
        post(ctx, p) {
          const st = ctx.state;
          const m = st.msgs[p.id];
          if (!m) return { ignored: true };
          st.receipts.unshift({ id: p.id, status: p.status, provider: p.provider, t: ctx.now(), applied: true });
          if (st.receipts.length > 12) st.receipts.pop();
          if (st.config.sm && ORDER[p.status] <= (ORDER[m.status] || 0)) {
            st.stats.ignored++;
            st.receipts[0].applied = false;
            ctx.log({ op: `receipt “${p.status}” ignored`, status: 'dup', detail: `${p.id} is already “${m.status}”. Status only moves forward.` });
            return { ignored: true };
          }
          if (!st.config.sm && m.status === 'delivered' && p.status !== 'delivered') ctx.log({ op: `status ${m.status} → ${p.status}`, status: 'fault', detail: `The latest receipt wins, so ${p.id} now looks undelivered.` });
          if (p.status === 'delivered') st.stats.deliveredCount++;
          m.status = p.status;
          m.history.push([ctx.now(), `${PNAME[p.provider]}: ${p.status}`]);
          if (p.status === 'delivered') ctx.sim.setLedger(ctx.actionId, 'async', 'yes', `Delivered (receipt from ${PNAME[p.provider]}).`);
          return { applied: true };
        },
      },
      phone: {
        push(ctx, p) {
          const st = ctx.state;
          const m = st.msgs[p.id];
          const ms = ctx.now() - m.t0;
          m.done = ctx.now();
          ctx.ui.phone.pushes.unshift({ id: p.id, title: 'Your order has shipped', text: 'Arriving Thursday.', ms });
          ctx.ui.phone.banner = { title: 'Your order has shipped', body: 'Arriving Thursday.', tone: 'ok', t: ctx.now() };
          return { shown: true };
        },
        sms(ctx, p) {
          const st = ctx.state;
          const m = st.msgs[p.id];
          const ms = ctx.now() - m.t0;
          if (m.done == null) m.done = ctx.now();
          ctx.ui.phone.sms.unshift({ id: p.id, provider: p.provider, text: 'Your sign-in code is 482 913', ms });
          ctx.ui.phone.banner = { title: 'Messages', body: `Your sign-in code is 482 913 (via ${PNAME[p.provider]})`, tone: 'ok', t: ctx.now() };
          return { shown: true };
        },
      },
    },
    setup(sim) {
      // One dispatcher per queue: take as many jobs as there are free slots, hold a slot per send.
      for (const qid of QUEUES) {
        const poolId = QPOOL[qid];
        sim.spawn(function* (ctx) {
          for (;;) {
            const st = ctx.state;
            const free = poolSize(ctx.sim, poolId) - st.busy[poolId];
            if (free <= 0 || !ctx.sim.queueStats(qid).depth) { yield ctx.wait(5); continue; }
            const { msgs } = yield ctx.take(qid, 'pool', free);
            ctx.ack(qid, 'pool');
            for (const m of msgs) {
              st.busy[poolId]++;
              ctx.spawn(function* (c) {
                yield* sendJob(c, m);
                c.state.busy[poolId]--;
              }, { quiet: m.payload.maya ? false : 'all', actionId: m.actionId });
            }
          }
        }, { self: 'pool', quiet: 'all' });
      }
      for (const ch of ['ios', 'android', 'sms']) {
        Y.load(sim, 'console', () => RATE[ch], (c, n) => {
          enqueueJob(c.sim, { id: `${ch}${n}`, ch, kind: 'bg', maya: false, t0: c.now(), attempt: 1 });
          return (function* () {})();
        });
      }
    },
    consistency(sim) {
      const st = sim.state;
      const ui = sim.ui.phone;
      const now = sim.now;
      const msgs = Object.values(st.msgs);
      for (const m of msgs.filter((x) => x.ch === 'sms')) {
        const n = ui.sms.filter((x) => x.id === m.id).length;
        if (n > 1) return { key: 'wrong', label: `Maya got the same code twice, through ${ui.sms.map((x) => PNAME[x.provider]).reverse().join(' and then ')}. A late “sent” receipt overwrote “delivered”, so the platform believed the first text was lost. Two messages billed.` };
      }
      if (st.stats.burstDead) return { key: 'stale', label: `${st.stats.burstDead} of the ${BURST} Android pushes were dropped. Each 429 was retried 50 ms later, inside the same second, until four attempts were gone. ${st.stats.r429} rejections in all.` };
      if (sim.nodes.breaker.modes.stuckOpen && msgs.some((m) => m.ch === 'ios' && m.inbox)) return { key: 'stale', label: 'APNs is healthy, but its breaker is stuck open. Every iOS push goes to the inbox instead of the lock screen.' };
      for (const m of msgs) {
        const slo = m.ch === 'sms' ? OTP_SLO : PUSH_SLO;
        const what = m.ch === 'sms' ? 'The sign-in code' : 'Maya’s push';
        if (m.done != null && m.done - m.t0 > slo) {
          if (m.ch === 'sms' && m.resent) return { key: 'stale', label: `${what} arrived after ${((m.done - m.t0) / 1000).toFixed(1)} s through SMS B. SMS A said “accepted” and the carrier dropped it; the platform only found out because no “delivered” receipt came. Accepted is not delivered.` };
          return { key: 'stale', label: `${what} took ${((m.done - m.t0) / 1000).toFixed(1)} s. ${st.config.isolate ? '' : 'Every shared slot was held by a slow or hanging APNs call.'}` };
        }
        if (m.done == null && (m.status === 'dead' || now - m.t0 > slo)) {
          if (m.status === 'dead') return { key: 'stale', label: `${what} was never sent. SMS A failed four times and no other provider is configured.` };
          const q = sim.queueStats(routeQueue(st, m.ch));
          return { key: 'stale', label: `${what} has waited ${((now - m.t0) / 1000).toFixed(1)} s. ${!st.config.isolate ? `The shared pool is full of calls waiting on APNs, and ${q.depth} jobs are queued behind them.` : `${q.depth} jobs are queued ahead of it.`}` };
        }
      }
      if (!msgs.length && !st.stats.burstDone) return { key: 'ok', label: 'Background traffic only. Every provider is answering.' };
      const pending = msgs.find((m) => m.done == null && !m.inbox && m.status !== 'dead');
      if (pending) return { key: 'ok', label: `${pending.ch === 'sms' ? 'Maya’s code' : 'Maya’s push'} is on its way: ${SDL.fmtMs(now - pending.t0)} so far.` };
      const sms = msgs.find((m) => m.ch === 'sms' && m.done != null);
      const push = msgs.find((m) => m.ch === 'ios');
      const parts = [];
      if (push && push.inbox) parts.push(`The APNs breaker is ${st.br.apns.state === 'closed' ? 'closed again' : 'open'}: Maya’s push failed fast and is waiting in her in-app inbox.`);
      else if (push && push.done != null) parts.push(`Push delivered in ${SDL.fmtMs(push.done - push.t0)}.`);
      if (sms) parts.push(`Code delivered in ${SDL.fmtMs(sms.done - sms.t0)} through ${PNAME[ui.sms[0].provider]}${st.stats.ignored ? `; ${st.stats.ignored} out-of-order receipt${st.stats.ignored > 1 ? 's were' : ' was'} ignored` : ''}.`);
      if (st.stats.failovers) parts.push(`${st.stats.failovers} SMS failed over to B; SMS spend is $${st.cost.toFixed(2)}.`);
      if (sim.nodes.apns.modes.slow && st.config.isolate) parts.push(`iOS pushes are queued in their own partition (${sim.queueStats('q_apns').depth} waiting) because APNs is slow; that is contained to iOS.`);
      if (st.stats.burstDone && sim.nodes.fcm.modes.throttle) parts.push(`${st.stats.burstDone} of ${BURST} deal pushes sent at the quota, ${st.stats.r429} rejections, none dropped.`);
      return { key: 'ok', label: parts.join(' ') || 'Everything delivered.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const otp = Object.values(st.msgs).filter((m) => m.ch === 'sms').pop();
      const q = st.config.isolate ? ['q_apns', 'q_fcm', 'q_sms'].reduce((a, k) => a + sim.queueStats(k).depth, 0) + sim.queueStats('q_shared').depth : sim.queueStats('q_shared').depth;
      return [
        { label: 'Sign-in code', value: otp ? (otp.done != null ? SDL.fmtMs(otp.done - otp.t0) : 'waiting') : 'n/a', tone: otp && (otp.done == null ? sim.now - otp.t0 > OTP_SLO : otp.done - otp.t0 > OTP_SLO) ? 'fail' : '' },
        { label: 'APNs breaker', value: st.br.apns.state === 'half' ? 'half-open' : st.br.apns.state, tone: st.br.apns.state !== 'closed' ? 'warn' : '' },
        { label: 'Slots busy', value: st.config.isolate ? `${st.busy.apns}/${st.busy.fcm}/${st.busy.sms}` : `${st.busy.shared}/${poolSize(sim, 'shared')}`, tone: !st.config.isolate && st.busy.shared >= poolSize(sim, 'shared') ? 'fail' : '' },
        { label: 'Jobs waiting', value: q, tone: q > 50 ? 'warn' : '' },
        { label: 'Timeouts', value: st.stats.timeouts, tone: st.stats.timeouts ? 'warn' : '' },
        { label: 'Failed fast', value: st.stats.fastFails },
        { label: '429s', value: st.stats.r429, tone: st.stats.r429 ? 'warn' : '' },
        { label: 'Dropped', value: st.stats.dead, tone: st.stats.dead ? 'fail' : '' },
        { label: 'SMS spend', value: `$${st.cost.toFixed(2)}` },
        { label: 'Receipts ignored', value: st.stats.ignored },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s iPhone']], {
          note: 'Maya asks for a code on the phone. The dashboard shows each provider’s breaker, slots, and calls, and the receipts as they arrive.',
          side: `<p class="ops-title">Provider dashboard</p><div class="ops-traffic">
              ${Y.btn('push', 'Push to Maya', {})}
              ${Y.btn('burst', `Price drop to ${BURST} Android users`, { cls: 'secondary' })}
            </div><div data-ref="dash"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const ui = sim.ui.phone;
        const body = `<p class="app-sub">Lock screen (${ui.pushes.length})</p>${ui.pushes.slice(0, 3).map((n) => `<div class="app-card is-ok"><strong>${esc(n.title)}</strong><span class="app-sub">${esc(n.text)} · ${SDL.fmtMs(n.ms)}</span></div>`).join('') || '<p class="app-sub">Nothing.</p>'}
          <p class="app-sub">Messages (${ui.sms.length})</p>${ui.sms.slice(0, 3).map((n) => `<div class="app-card ${ui.sms.length > 1 ? 'is-warn' : ''}"><strong>${esc(n.text)}</strong><span class="app-sub">via ${PNAME[n.provider]} · ${SDL.fmtMs(n.ms)}</span></div>`).join('') || '<p class="app-sub">No texts.</p>'}
          <p class="app-sub">App inbox (${ui.inbox.length})</p>${ui.inbox.slice(0, 2).map((n) => `<div class="app-card"><strong>${esc(n.title)}</strong><span class="app-sub">push failed, kept here</span></div>`).join('') || '<p class="app-sub">Empty.</p>'}`;
        Y.paint(el, sim, 'phone', { head: '<div><p class="app-title">Maya</p><p class="app-sub">iPhone</p></div>', act: `<div class="app-sec">${Y.btn('otp', 'Request sign-in code', {})}</div>`, body }, {}, ui.banner);
        const c = sim.scenario.consistency(sim);
        const poolOf = { apns: 'apns', fcm: 'fcm', smsA: 'sms', smsB: 'sms' };
        const rows = ['apns', 'fcm', 'smsA', 'smsB'].map((p) => {
          const b = st.br[p];
          const n = sim.nodes[p];
          const down = n.modes.hang || n.modes.down;
          const pid = st.config.isolate ? poolOf[p] : 'shared';
          const busy = st.inflight[p];
          const size = poolSize(sim, pid);
          const bs = p === 'apns' && sim.nodes.breaker.modes.stuckOpen ? 'stuck open' : !st.config.breaker ? 'off' : b.state === 'half' ? 'half-open' : b.state;
          const tone = down || bs === 'open' || bs === 'stuck open' ? 'fail' : Object.keys(n.modes).length || bs === 'half-open' ? 'warn' : 'ok';
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name"><strong>${PNAME[p]}</strong><span>breaker ${bs} · ${st.stats.calls[p].toLocaleString('en-US')} calls</span></div><div class="ops-bar"><i style="width:${Math.min(100, Math.round((100 * busy) / size))}%"></i></div><span class="ops-val">${busy} in flight of ${size} ${st.config.isolate ? (poolOf[p] === 'sms' ? 'SMS' : PNAME[p]) : 'shared'} slots${p.startsWith('sms') ? ` · $${(st.stats.sms[p] * PRICE[p]).toFixed(2)}` : ''}</span></div>`;
        }).join('');
        const rec = st.receipts.slice(0, 6).map((r) => `<span class="kv-file ${r.applied ? 'has-key' : ''}">${r.id} · ${r.status} · ${PNAME[r.provider]}${r.applied ? '' : ' · ignored'}</span>`).join('');
        SDL.ui.paintSections(el.querySelector('[data-ref="dash"]'), {
          rows: `<div class="ops-shards">${rows}</div>`,
          rec: `<p class="ops-title">Receipts</p><div class="kv-files">${rec || '<span class="app-sub">None yet. Only Maya’s texts are tracked here.</span>'}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
