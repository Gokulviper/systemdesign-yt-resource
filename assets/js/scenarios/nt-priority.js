/*
 * Priority lanes, per-user caps, quiet hours, and digests.
 * A promo blast to 1,500 people lands a moment before Maya asks for a sign-in
 * code. With one queue the code waits behind every promo; with three lanes
 * (critical, transactional, marketing) and weighted pickup it goes first.
 * Then the gates at the worker: a per-user cap that folds extra promos into a
 * digest, quiet hours that defer everything except security messages, a
 * limiter that fails open, and shedding promos that are too old to matter.
 * The classifier decides the lane and the gates, so a mistagged OTP or a
 * wrong time zone there undoes all of it.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const BLAST = 1500; // people in the demo segment
  const MAYA_AT = 900; // Maya's position in the blast
  const BATCH = 10; // jobs a worker pool round sends at once
  const ROUND_MS = 40; // about how long one round takes when healthy
  const OTP_SLO = 3000;
  const CAP = 2; // marketing pushes per user per window
  const DIGEST_MS = 1500; // how long the digester collects before sending one summary
  const SHED_MS = 8000; // promos older than this are dropped (a healthy blast drains in about 6 s)
  const MAX_ATTEMPTS = 5;
  const LANE_NAME = { crit: 'critical lane', txn: 'transactional lane', mkt: 'marketing lane' };
  const CLASS_LANE = { critical: 'crit', transactional: 'txn', marketing: 'mkt' };
  const KINDS = {
    otp: { cls: 'critical', title: 'Your sign-in code is 482 913', text: 'It expires in 5 minutes.' },
    order: { cls: 'transactional', title: 'Your order has shipped', text: 'Arriving Thursday.' },
    promo: { cls: 'marketing', title: 'Weekend sale: 20% off shoes', text: 'Ends Sunday.' },
  };
  const TEAMS = ['Shoes', 'Kitchen', 'Books', 'Garden', 'Toys', 'Travel'];

  const lanesOn = (st) => st.config.lanes;
  const laneFor = (st, cls) => (lanesOn(st) ? CLASS_LANE[cls] : 'txn');

  function send(sim, kind, opts) {
    opts = opts || {};
    const st = sim.state;
    const k = KINDS[kind];
    const who = kind === 'otp' ? 'Maya: request a sign-in code' : kind === 'order' ? 'Orders team: “order shipped” to Maya' : `${opts.team || 'Shoes'} team: promo to Maya`;
    sim.startAction(who, function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'The phone shows the result.'], retrySafe: ['yes', 'Idempotency key per request.'] });
      const r = yield ctx.call('api', 'send', { kind, title: opts.team ? `${opts.team}: ${opts.title || 'new offers inside'}` : k.title, text: k.text }, { timeout: 800 });
      ctx.recordOutcome(r.ok, r.latency);
      if (!r.ok) { Y.failed(ctx, `The API answered ${r.error.code}.`); return; }
      Y.L(ctx, { accepted: ['yes', `Classified ${r.value.cls}.`], committed: 'yes', async: ['pending', `Queued in the ${LANE_NAME[r.value.lane]}.`] });
      ctx.explain(`Classified as ${r.value.cls}${r.value.mistag ? ' (the template is tagged wrongly)' : ''} and queued in the ${LANE_NAME[r.value.lane]}${lanesOn(st) ? '' : ', which with lanes off is the only queue'}, behind ${r.value.ahead.toLocaleString('en-US')} job${r.value.ahead === 1 ? '' : 's'}.`);
    }, { self: kind === 'otp' ? 'phone' : 'console' });
  }

  function blast(sim) {
    sim.startAction(`Growth team: promo blast to ${BLAST.toLocaleString('en-US')} people`, function* (ctx) {
      Y.L(ctx, { displayed: ['n/a'], retrySafe: ['yes', 'Campaign id is the idempotency key.'] });
      const r = yield ctx.call('api', 'blast', {}, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, `The API answered ${r.error.code}.`); return; }
      Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', `${BLAST.toLocaleString('en-US')} jobs in the ${LANE_NAME[r.value.lane]}.`] });
      ctx.explain(`${BLAST.toLocaleString('en-US')} promo jobs went into the ${LANE_NAME[r.value.lane]}. Each stands for many real recipients; the worker pool sends about ${Math.round((BATCH * 1000) / (ROUND_MS + 2))} a second.`);
    }, { self: 'console' });
  }

  function sixPromos(sim) {
    TEAMS.forEach((team, i) => sim.schedule(i * 150, () => send(sim, 'promo', { team, title: ['20% off running shoes', 'New pans in stock', 'Bestsellers this week', 'Seeds are back', 'Toy sale starts now', 'Weekend getaways'][i] })));
  }

  function record(st, lane, ms) {
    const a = (st.lat[lane] = st.lat[lane] || []);
    a.push(ms);
    if (a.length > 3000) a.shift();
  }

  function* sendOne(c, m, lane) {
    const st = c.state;
    const p = m.payload;
    const maya = p.user === 'maya';
    const aid = m.actionId;
    const waited = c.now() - p.t0;
    if (p.cls === 'marketing' && st.config.shed && waited > SHED_MS) {
      st.stats.shed++;
      if (maya) {
        st.mayaShed.push(p);
        c.log({ op: `${p.kind === 'otp' ? 'sign-in code' : 'promo'} shed`, status: 'drop', actionId: aid, detail: `Waited ${SDL.fmtMs(waited)} in the ${LANE_NAME[lane]}, past the ${SHED_MS / 1000} s send-by time for marketing. Dropped instead of sent.` });
        c.sim.setLedger(aid, 'async', 'no', 'Shed: too old to send.');
      }
      return;
    }
    if (maya && p.cls !== 'critical') {
      if (st.config.quiet && p.night) {
        st.deferred.push({ title: p.title, cls: p.cls });
        c.log({ op: `deferred to 08:00`, status: 'note', actionId: aid, detail: `It is 23:30 for Maya and this is ${p.cls}. Held until her quiet hours end.` });
        c.sim.setLedger(aid, 'async', 'yes', 'Deferred to 08:00 (quiet hours).');
        return;
      }
      if (p.cls === 'marketing' && st.config.cap) {
        const r = yield c.call('limiter', 'hit', { user: 'maya' }, { timeout: 300 });
        if (!r.ok) {
          st.stats.failOpen++;
          c.log({ op: 'limiter unreachable: fail open', status: 'retry', actionId: aid, detail: `${r.error.code}. The worker sends anyway rather than block the queue. For marketing that means no cap at all.` });
        } else if (r.value.count > CAP) {
          if (st.config.digest) {
            yield c.call('digester', 'add', { title: p.title }, { timeout: 300 });
            st.stats.digested++;
            c.sim.setLedger(aid, 'async', 'yes', 'Folded into a digest.');
            return;
          }
          st.stats.capped++;
          c.log({ op: 'over the cap: dropped', status: 'drop', actionId: aid, detail: `Maya’s ${r.value.count}th marketing push in this window; the cap is ${CAP}. No digest, so it is dropped.` });
          c.sim.setLedger(aid, 'async', 'no', 'Dropped by the per-user cap.');
          return;
        }
      }
    }
    const slow = c.sim.nodes.workers.modes.slow;
    if (slow) yield c.wait(ROUND_MS * ((slow.factor || 4) - 1)); // rendering and lookups take longer
    const r = yield c.call('apns', 'send', { user: p.user, title: p.title, text: p.text, cls: p.cls, kind: p.kind, lane, t0: p.t0, night: p.night }, { timeout: 800 });
    if (!r.ok) {
      const attempt = (p.attempt || 1) + 1;
      st.stats.retries++;
      if (attempt > MAX_ATTEMPTS) { st.stats.dead++; return; }
      c.spawn(function* (cc) {
        yield cc.wait(200 * attempt);
        cc.sim.enqueue(lane, { type: p.kind, eventId: `${p.id}#${attempt}`, payload: Object.assign({}, p, { attempt }), actionId: aid, quiet: !maya });
      }, { quiet: 'all' });
      return;
    }
    record(st, lane, c.now() - p.t0);
    if (maya) c.sim.setLedger(aid, 'async', 'yes', `Delivered from the ${LANE_NAME[lane]}.`);
  }

  const sc = (SDL.scenarios['nt-priority'] = {
    id: 'nt-priority',
    seed: 1031,
    minHopMs: 5,
    productWidth: 640,
    intro: `Launch the promo blast to ${BLAST.toLocaleString('en-US')} people, then ask for a sign-in code on Maya’s phone. With lanes the code goes first; with one queue it waits for the blast. Then let six teams promo Maya at once, or move her clock to 23:30.`,
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'console', label: 'Product teams', sub: 'Growth, orders, shoes…', kind: 'client', x: 90, y: 90, latency: 1, role: 'Every team sends through the same platform. None of them knows what the others are sending.', owns: ['Their own campaigns'] },
        { id: 'phone', label: 'Maya’s phone', sub: 'Clock decides quiet hours', kind: 'client', x: 90, y: 450, latency: 1, role: 'Asks for sign-in codes and receives everything else. Its local time decides quiet hours.', ops: [{ name: 'push', desc: 'Show a push.' }], owns: ['Local time'] },
        { id: 'api', label: 'Notification API', sub: 'Accepts requests', kind: 'gateway', x: 300, y: 90, latency: 3, role: 'Accepts single sends and campaigns.', ops: [{ name: 'send', desc: 'One notification.' }, { name: 'blast', desc: 'A campaign.' }], owns: ['Nothing durable'] },
        { id: 'classifier', label: 'Classifier', sub: 'Class, lane, time', kind: 'service', x: 300, y: 270, latency: 3, role: 'Reads the template’s class (critical, transactional, marketing) and the user’s time zone, and picks the lane. Everything downstream trusts its answer.', ops: [{ name: 'route', desc: 'Pick a lane.' }, { name: 'blast', desc: 'Enqueue a campaign.' }], owns: ['Template classes', 'User time zones'] },
        { id: 'critq', label: 'Critical lane', sub: 'Codes, security', kind: 'queue', x: 540, y: 90, latency: 2, queue: 'crit', role: 'Sign-in codes and security alerts. Always picked first.', owns: ['critical jobs'] },
        { id: 'txnq', label: 'Transactional lane', sub: 'Orders, or all if no lanes', kind: 'queue', x: 540, y: 270, latency: 2, queue: 'txn', role: 'Order and account updates. With lanes off, every job goes here in arrival order.', owns: ['transactional jobs'] },
        { id: 'mktq', label: 'Marketing lane', sub: 'Promos, campaigns', kind: 'queue', x: 540, y: 450, latency: 2, queue: 'mkt', role: 'Promotions and campaigns. Picked one round in five when transactional work is waiting, so it is slowed but never starved.', owns: ['marketing jobs'] },
        { id: 'workers', label: 'Worker pool', sub: `${BATCH} sends per round`, kind: 'worker', x: 780, y: 270, latency: 2, role: `Picks a lane each round: critical if anything is waiting, otherwise transactional four rounds in five and marketing one in five. Sends up to ${BATCH} at once. Applies the gates: quiet hours, per-user cap, shedding.`, owns: ['Lane weights', 'Gates'] },
        { id: 'limiter', label: 'Per-user limiter', sub: `${CAP} promos per window`, kind: 'cache', x: 780, y: 90, latency: 2, role: `Counts marketing pushes per user. Above ${CAP}, the worker folds the rest into a digest or drops them.`, ops: [{ name: 'hit', desc: 'Count one more.' }], owns: ['Counters per user'] },
        { id: 'digester', label: 'Digester', sub: `One summary per ${DIGEST_MS / 1000} s`, kind: 'worker', x: 780, y: 450, latency: 2, role: 'Collects promos that were over the cap and sends one summary push.', ops: [{ name: 'add', desc: 'Hold a promo.' }], owns: ['Pending digests'] },
        { id: 'apns', label: 'Push provider', sub: 'APNs / FCM', kind: 'service', x: 1020, y: 270, latency: 25, role: 'Delivers pushes. Can throttle a sender.', ops: [{ name: 'send', desc: 'Deliver a push.' }], owns: ['Nothing of ours'] },
      ],
      edges: [
        { from: 'console', to: 'api', latency: 20, label: 'HTTPS' },
        { from: 'phone', to: 'api', latency: 25, via: [[200, 450], [200, 160], [300, 160]] },
        { from: 'api', to: 'classifier', latency: 2 },
        { from: 'classifier', to: 'critq', latency: 2, via: [[420, 270], [420, 90]] },
        { from: 'classifier', to: 'txnq', latency: 2 },
        { from: 'classifier', to: 'mktq', latency: 2, via: [[420, 270], [420, 450]] },
        { from: 'critq', to: 'workers', latency: 2, via: [[660, 90], [660, 250]] },
        { from: 'txnq', to: 'workers', latency: 2 },
        { from: 'mktq', to: 'workers', latency: 2, via: [[660, 450], [660, 290]] },
        { from: 'workers', to: 'limiter', latency: 2 },
        { from: 'workers', to: 'digester', latency: 2 },
        { from: 'workers', to: 'apns', latency: 4 },
        { from: 'digester', to: 'apns', latency: 4, via: [[1020, 450]] },
        { from: 'apns', to: 'phone', latency: 30, via: [[1100, 270], [1100, 530], [90, 530]] },
      ],
      queues: [
        { id: 'crit', broker: 'critq', label: 'critical jobs', groups: ['workers'] },
        { id: 'txn', broker: 'txnq', label: 'transactional jobs', groups: ['workers'] },
        { id: 'mkt', broker: 'mktq', label: 'marketing jobs', groups: ['workers'] },
      ],
    },
    modeLabels: { flood: 'Another campaign: 250 promos a second', mistag: 'OTP template tagged marketing', wrongTz: 'Using the server’s time zone', throttle: 'Throttling: every third push 429' },
    failures: [
      { id: 'flood', node: 'api', mode: 'flood', label: 'Marketing flood', desc: 'Another team’s campaign adds 250 promo jobs a second for as long as this is on.' },
      { id: 'workers-slow', node: 'workers', mode: 'slow', params: { factor: 4 }, label: 'Workers slow (4×)', desc: 'Each round takes four times as long. Capacity drops to a quarter.' },
      { id: 'limiter-down', node: 'limiter', mode: 'down', label: 'Limiter down', desc: 'The worker cannot count. It fails open: sends without a cap.' },
      { id: 'digester-paused', node: 'digester', mode: 'paused', label: 'Digester paused', desc: 'Promos over the cap pile up in the digester. Nothing is lost; the summary waits.' },
      { id: 'mistag', node: 'classifier', mode: 'mistag', label: 'OTP template tagged marketing', desc: 'A template change marked the sign-in code as marketing. It goes to the marketing lane and through every marketing gate.' },
      { id: 'wrong-tz', node: 'classifier', mode: 'wrongTz', label: 'Classifier uses the server’s time zone', desc: 'Local time is computed in UTC, not Maya’s zone. At 23:30 for her it looks like mid-afternoon.' },
      { id: 'throttle', node: 'apns', mode: 'throttle', label: 'Push provider throttles', desc: 'Every third push is rejected with 429. The worker retries it later in the same lane.' },
    ],
    switches: Y.switches([
      ['lanes', 'Priority lanes', 'Critical, transactional, and marketing queues with weighted pickup. Off: one queue in arrival order.'],
      ['cap', 'Per-user cap', `At most ${CAP} marketing pushes per user per window. Off: every promo is sent.`],
      ['digest', 'Digest over the cap', 'Promos over the cap become one summary push. Off: they are dropped.'],
      ['quiet', 'Quiet hours', 'Between 22:00 and 08:00 local time, defer everything except critical. Off: send whenever.'],
      ['shed', 'Shed stale marketing', `Drop promos that waited more than ${SHED_MS / 1000} s instead of sending them late. Off: send every promo, however late.`],
    ]),
    presets: Y.presets({ lanes: true, cap: true, digest: true, quiet: true, shed: true }, [
      { id: 'otp-alone', label: 'Sign-in code on a quiet system', desc: 'Maya asks for a code. Critical lane, picked at once, on her phone in about 100 ms.', run: (s) => send(s, 'otp') },
      { id: 'otp-behind-flood', label: 'Code behind the blast, one queue', desc: `The blast puts ${BLAST.toLocaleString('en-US')} promos in the only queue, then Maya asks for a code. It waits for every promo ahead of it: several seconds, long past the point where she gives up.`, sw: { lanes: false }, run: (s) => { blast(s); s.schedule(300, () => send(s, 'otp')); } },
      { id: 'otp-with-lanes', label: 'Code behind the blast, with lanes', desc: 'Same blast, same code. The code goes to the critical lane and the worker picks it next round. The blast keeps draining around it.', run: (s) => { blast(s); s.schedule(300, () => send(s, 'otp')); } },
      { id: 'mistagged-otp', label: 'Code tagged as marketing', desc: 'A template change tagged the sign-in code as marketing. Lanes work exactly as designed: the code waits in the marketing lane behind the whole blast. The classifier is the single point that decides everything.', run: (s) => { s.inject('classifier', 'mistag'); blast(s); s.schedule(300, () => send(s, 'otp')); } },
      { id: 'cap-off', label: 'Six teams promo Maya, no cap', desc: 'Six teams each send Maya a promo within a second. Each is reasonable alone; together her phone buzzes six times.', sw: { cap: false }, run: (s) => sixPromos(s) },
      { id: 'cap-digest', label: 'Six teams promo Maya, cap and digest', desc: `The first ${CAP} go through. The limiter says the rest are over the cap, and the digester turns them into one summary push.`, run: (s) => sixPromos(s) },
      { id: 'limiter-down', label: 'Limiter down: fail open', desc: 'Same six promos with the limiter unreachable. The worker sends anyway rather than stall the lane. Failing open is right for codes and order updates; for marketing it means no cap at all.', run: (s) => { s.inject('limiter', 'down'); sixPromos(s); } },
      { id: 'quiet-defer', label: 'Quiet hours defer a promo and an update', desc: 'It is 23:30 for Maya. The promo and the shipping update are held until 08:00.', run: (s) => { s.ui.phone.clock = 'night'; send(s, 'promo'); s.schedule(200, () => send(s, 'order')); } },
      { id: 'quiet-critical', label: 'Quiet hours let the code through', desc: 'At 23:30 Maya asks for a code herself. Critical messages bypass quiet hours.', run: (s) => { s.ui.phone.clock = 'night'; send(s, 'otp'); } },
      { id: 'wrong-tz', label: 'Quiet hours in the wrong time zone', desc: 'The classifier computes local time in UTC. For Maya it is 23:30; for the classifier it is mid-afternoon. The promo and the update arrive at night.', run: (s) => { s.ui.phone.clock = 'night'; s.inject('classifier', 'wrongTz'); send(s, 'promo'); s.schedule(200, () => send(s, 'order')); } },
      { id: 'shed-under-load', label: 'Workers at a quarter speed, shed marketing', desc: `The workers slow to a quarter, the blast arrives, then an order update and a code. Critical and transactional go first; promos older than ${SHED_MS / 1000} s are dropped instead of sent hours late, which also frees the workers.`, run: (s) => { s.inject('workers', 'slow', { factor: 4 }); blast(s); s.schedule(300, () => send(s, 'order')); s.schedule(500, () => send(s, 'otp')); } },
    ]),
    initialState: () => ({
      config: { lanes: true, cap: true, digest: true, quiet: true, shed: true },
      counts: {}, digest: [], deferred: [], mayaShed: [], otps: [], lat: {},
      stats: { shed: 0, capped: 0, digested: 0, failOpen: 0, retries: 0, dead: 0, digests: 0, providerCalls: 0, throttled: 0 },
      seq: 0,
    }),
    initialUI: () => ({ phone: { clock: 'day', pushes: [], banner: null } }),
    actions: {
      otp(sim) { send(sim, 'otp'); },
      order(sim) { send(sim, 'order'); },
      promo(sim) { send(sim, 'promo'); },
      blast(sim) { blast(sim); },
      six(sim) { sixPromos(sim); },
      clock(sim) { sim.ui.phone.clock = sim.ui.phone.clock === 'night' ? 'day' : 'night'; },
    },
    handlers: {
      api: {
        send: function* (ctx, p) { return ctx.must(yield ctx.call('classifier', 'route', p, { timeout: 500 })); },
        blast: function* (ctx) { return ctx.must(yield ctx.call('classifier', 'blast', {}, { timeout: 1000 })); },
      },
      classifier: {
        route(ctx, p) {
          const st = ctx.state;
          const mistag = p.kind === 'otp' && !!ctx.mode('mistag');
          const cls = mistag ? 'marketing' : KINDS[p.kind].cls;
          const night = ctx.ui.phone.clock === 'night' && !ctx.mode('wrongTz');
          const lane = laneFor(st, cls);
          const id = `${p.kind}-${++st.seq}`;
          const ahead = ctx.sim.queueStats(lane).depth;
          if (p.kind === 'otp') st.otps.push({ id, t: ctx.now(), lane, ms: null });
          ctx.sim.enqueue(lane, { type: p.kind, eventId: id, payload: { id, user: 'maya', kind: p.kind, cls, night, t0: ctx.now(), title: p.title, text: p.text }, actionId: ctx.actionId });
          if (ctx.ui.phone.clock === 'night' && ctx.mode('wrongTz')) ctx.log({ op: 'local time: 15:30 (UTC)', status: 'fault', actionId: ctx.actionId, detail: 'Maya’s profile says another zone, but the classifier used the server’s clock. Not quiet hours, as far as it knows.' });
          return { lane, cls, mistag, ahead };
        },
        blast(ctx) {
          const st = ctx.state;
          const lane = laneFor(st, 'marketing');
          for (let i = 0; i < BLAST; i++) {
            const maya = i === MAYA_AT;
            const k = KINDS.promo;
            ctx.sim.enqueue(lane, { type: 'promo', eventId: `b${i}`, quiet: !maya, payload: { id: `b${i}`, user: maya ? 'maya' : `u${i}`, kind: 'promo', cls: 'marketing', night: maya && ctx.ui.phone.clock === 'night' && !ctx.mode('wrongTz'), t0: ctx.now(), title: k.title, text: k.text }, actionId: ctx.actionId });
          }
          return { lane, count: BLAST };
        },
      },
      limiter: {
        hit(ctx, p) { const c = (ctx.state.counts[p.user] = (ctx.state.counts[p.user] || 0) + 1); return { count: c }; },
      },
      digester: {
        add(ctx, p) { ctx.state.digest.push({ title: p.title, t: ctx.now() }); return { held: ctx.state.digest.length }; },
      },
      apns: {
        send: function* (ctx, p) {
          const st = ctx.state;
          st.stats.providerCalls++;
          if (ctx.mode('throttle') && st.stats.providerCalls % 3 === 0) { st.stats.throttled++; ctx.fail('RATE_LIMITED', '429: this sender is over its rate.'); }
          if (p.user !== 'maya') return { delivered: true };
          return ctx.must(yield ctx.call('phone', 'push', p, { timeout: 500 }));
        },
      },
      phone: {
        push(ctx, p) {
          const st = ctx.state;
          const ui = ctx.ui.phone;
          const ms = ctx.now() - p.t0;
          ui.pushes.unshift({ title: p.title, text: p.text, cls: p.cls, kind: p.kind, lane: p.lane, digest: !!p.digest, at: ui.clock, ms, t: ctx.now() });
          ui.banner = { title: p.title, body: p.text, tone: p.cls === 'critical' ? 'ok' : '', t: ctx.now() };
          if (p.kind === 'otp') { const o = st.otps.find((x) => x.ms == null); if (o) o.ms = ms; }
          return { shown: true };
        },
      },
    },
    setup(sim) {
      // The worker pool: pick a lane, take a batch, send it in parallel, acknowledge.
      sim.spawn(function* (ctx) {
        let turn = 0;
        for (;;) {
          const d = (l) => ctx.sim.queueStats(l).depth;
          let lane = null;
          if (d('crit')) lane = 'crit';
          else if (d('txn') && d('mkt')) lane = turn++ % 5 < 4 ? 'txn' : 'mkt';
          else if (d('txn')) lane = 'txn';
          else if (d('mkt')) lane = 'mkt';
          if (!lane) { yield ctx.wait(10); continue; }
          const { msgs } = yield ctx.take(lane, 'workers', BATCH);
          const procs = msgs.map((m) => ctx.spawn((c) => sendOne(c, m, lane), { quiet: m.payload.user === 'maya' ? false : 'all', actionId: m.actionId }));
          yield ctx.join(procs);
          ctx.ack(lane, 'workers');
        }
      }, { self: 'workers', quiet: true });
      // The digester sends one summary for whatever it holds once the oldest has waited long enough.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const st = ctx.state;
          if (!st.digest.length || ctx.mode('paused') || ctx.now() - st.digest[0].t < DIGEST_MS) continue;
          const items = st.digest.splice(0);
          st.stats.digests++;
          const r = yield ctx.call('apns', 'send', { user: 'maya', digest: true, cls: 'marketing', kind: 'digest', lane: 'mkt', t0: items[0].t, title: `${items.length} more offers for you`, text: items.map((x) => x.title.split(':')[0]).join(', ') }, { timeout: 800 });
          if (!r.ok) st.digest.unshift(...items);
        }
      }, { self: 'digester' });
      // Another team's campaign while the flood failure is on.
      Y.load(sim, 'api', (s) => (s.nodes.api.modes.flood ? 250 : 0), (c, n) => {
        const st = c.state;
        const lane = laneFor(st, 'marketing');
        c.sim.enqueue(lane, { type: 'promo', eventId: `f${n}`, quiet: true, payload: { id: `f${n}`, user: `f${n}`, kind: 'promo', cls: 'marketing', night: false, t0: c.now(), title: 'Flash sale', text: '' } });
        return (function* () {})();
      });
    },
    consistency(sim) {
      const st = sim.state;
      const P = sim.ui.phone.pushes;
      const night = P.filter((x) => x.at === 'night' && x.cls !== 'critical');
      if (night.length) return { key: 'stale', label: `Maya’s phone lit up at 23:30 with “${night[night.length - 1].title}”${night.length > 1 ? ` and ${night.length - 1} more` : ''}. ${sim.nodes.classifier.modes.wrongTz ? 'Quiet hours are on, but the classifier read the time in the server’s zone, where it was mid-afternoon.' : 'Quiet hours are off.'}` };
      const mk = P.filter((x) => x.cls === 'marketing' && !x.digest && x.kind !== 'otp');
      if (mk.length > CAP) return { key: 'stale', label: `Maya got ${mk.length} marketing pushes in about a second. ${st.stats.failOpen ? 'The limiter was unreachable and the worker failed open, so there was no cap.' : 'Nothing counts pushes per person.'} Each team behaved; together they teach Maya to switch notifications off.` };
      for (const o of st.otps) {
        const lane = LANE_NAME[o.lane];
        if (o.ms != null && o.ms > OTP_SLO) return { key: 'stale', label: `The sign-in code took ${(o.ms / 1000).toFixed(1)} s, waiting behind the blast in the ${lane}. Codes need to land in a couple of seconds; by now Maya has probably asked for another one.` };
        if (o.ms == null && sim.now - o.t > OTP_SLO) {
          const shed = st.mayaShed.some((x) => x.kind === 'otp');
          return { key: 'stale', label: shed ? 'The sign-in code was tagged marketing, so it queued in the marketing lane behind the blast and was then shed as a stale promo. Maya never got it.' : `The sign-in code has waited ${((sim.now - o.t) / 1000).toFixed(1)} s in the ${lane}, behind ${sim.queueStats(o.lane).depth.toLocaleString('en-US')} jobs.` };
        }
      }
      if (st.digest.length && sim.nodes.digester.modes.paused) return { key: 'stale', label: `${st.digest.length} promos are waiting in the paused digester. Nothing is lost; the summary goes out when it resumes.` };
      const otp = st.otps.find((o) => o.ms != null);
      const otpTxt = otp ? `The code reached Maya in ${SDL.fmtMs(otp.ms)}${sim.ui.phone.clock === 'night' ? ', at 23:30: critical messages bypass quiet hours' : ''}.` : '';
      if (st.stats.shed && otp) return { key: 'ok', label: `${otpTxt} ${st.stats.shed.toLocaleString('en-US')} promos that waited more than ${SHED_MS / 1000} s were shed instead of sent late, which gave the slow workers back to the lanes that matter.` };
      if (otp && sim.queueStats('mkt').depth) return { key: 'ok', label: `${otpTxt} The blast is still draining in the marketing lane: ${sim.queueStats('mkt').depth.toLocaleString('en-US')} left.` };
      if (otp) return { key: 'ok', label: otpTxt };
      if (st.deferred.length) return { key: 'ok', label: `${st.deferred.length} message${st.deferred.length > 1 ? 's are' : ' is'} held until 08:00 Maya’s time. Nothing woke her up.` };
      if (st.stats.digests) return { key: 'ok', label: `Maya got ${mk.length} promos and one digest that summarises ${st.stats.digested} more. Same information, one buzz instead of ${st.stats.digested}.` };
      if (P.length) return { key: 'ok', label: `${P.length} push${P.length > 1 ? 'es' : ''} delivered, within the cap.` };
      return { key: 'ok', label: 'Nothing sent yet.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const p99 = (l) => { const a = (st.lat[l] || []).slice().sort((x, y) => x - y); return a.length ? SDL.fmtMs(SDL.percentile(a, 99)) : 'n/a'; };
      const otp = st.otps[st.otps.length - 1];
      return [
        { label: 'Sign-in code', value: otp ? (otp.ms != null ? SDL.fmtMs(otp.ms) : 'waiting') : 'n/a', tone: otp && (otp.ms == null ? sim.now - otp.t > OTP_SLO : otp.ms > OTP_SLO) ? 'fail' : '' },
        { label: 'p99 critical', value: p99('crit') },
        { label: 'p99 transactional', value: p99('txn') },
        { label: 'p99 marketing', value: p99('mkt') },
        { label: 'Waiting jobs', value: (sim.queueStats('crit').depth + sim.queueStats('txn').depth + sim.queueStats('mkt').depth).toLocaleString('en-US') },
        { label: 'Pushes to Maya', value: sim.ui.phone.pushes.length },
        { label: 'Deferred to 08:00', value: st.deferred.length },
        { label: 'Folded into digest', value: st.stats.digested },
        { label: 'Shed', value: st.stats.shed.toLocaleString('en-US'), tone: st.stats.shed ? 'warn' : '' },
        { label: 'Limiter failed open', value: st.stats.failOpen, tone: st.stats.failOpen ? 'warn' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone']], {
          note: 'Maya asks for a code on the phone. The console sends as the other teams and shows what is waiting in each lane.',
          side: `<p class="ops-title">Product teams</p><div class="ops-traffic">
              ${Y.btn('blast', `Promo blast to ${BLAST.toLocaleString('en-US')}`, {})}
              ${Y.btn('order', 'Order update to Maya', { cls: 'secondary' })}
              ${Y.btn('six', 'Six teams promo Maya', { cls: 'secondary' })}
            </div><div data-ref="lanes"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const ui = sim.ui.phone;
        const night = ui.clock === 'night';
        const tag = { critical: 'Security', transactional: 'Order', marketing: 'Offer' };
        const card = (n) => `<div class="app-card ${n.cls === 'critical' ? 'is-ok' : ''}"><strong>${esc(n.title)}</strong><span class="app-sub">${esc(n.text)}</span><span class="app-sub">${n.digest ? 'Digest' : tag[n.cls]} · ${n.at === 'night' ? 'at 23:30' : 'daytime'} · ${SDL.fmtMs(n.ms)}</span></div>`;
        Y.paint(el, sim, 'phone', {
          head: `<div><p class="app-title">${night ? '23:30' : '14:05'}</p><p class="app-sub">Maya · ${night ? 'quiet hours' : 'daytime'}</p></div>`,
          act: `<div class="app-sec">${Y.btn('otp', 'Request sign-in code', {})}${Y.btn('clock', night ? 'Set clock to 14:05' : 'Set clock to 23:30', { cls: 'secondary' })}</div>`,
          body: `<p class="app-sub">Notifications (${ui.pushes.length})</p>${ui.pushes.slice(0, 6).map(card).join('') || '<p class="app-sub">Nothing yet.</p>'}${ui.pushes.length > 6 ? `<p class="app-sub">and ${ui.pushes.length - 6} more</p>` : ''}`,
        }, {}, ui.banner);
        const c = sim.scenario.consistency(sim);
        const lanes = (st.config.lanes ? ['crit', 'txn', 'mkt'] : ['txn']).map((l) => {
          const q = sim.queueStats(l);
          const tone = q.lag > OTP_SLO ? 'fail' : q.lag > 1000 ? 'warn' : 'ok';
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name"><strong>${st.config.lanes ? LANE_NAME[l].replace(/^./, (x) => x.toUpperCase()) : 'One queue for everything'}</strong><span>${q.depth.toLocaleString('en-US')} waiting · oldest ${SDL.fmtMs(q.lag)}</span></div><div class="ops-bar"><i style="width:${Math.min(100, Math.round((100 * q.depth) / BLAST))}%"></i></div></div>`;
        }).join('');
        const gates = [
          `cap ${st.config.cap ? `${CAP} per window` : 'off'}${st.counts.maya ? ` · Maya at ${st.counts.maya}` : ''}`,
          `digest ${st.config.digest ? `holding ${st.digest.length}` : 'off'}`,
          `quiet hours ${st.config.quiet ? `on · ${st.deferred.length} deferred` : 'off'}`,
          `shed ${st.config.shed ? `${st.stats.shed.toLocaleString('en-US')} dropped` : 'off'}`,
        ].map((g) => `<span class="kv-file">${g}</span>`).join('');
        SDL.ui.paintSections(el.querySelector('[data-ref="lanes"]'), {
          title: `<p class="ops-title">${st.config.lanes ? 'Lanes' : 'Queue'}</p>`,
          rows: `<div class="ops-shards">${lanes}</div>`,
          gates: `<p class="ops-title">Gates at the worker</p><div class="kv-files">${gates}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
