/*
 * A campaign to two million people.
 * A segment query feeds four fan-out shards. Each shard reads a page of
 * recipients, builds one job per person, and commits the jobs together with
 * its checkpoint, never running more than a few pages ahead of the senders.
 * Senders pace the blast so the product's own backend survives everyone
 * opening the app at once. A shard that crashes restarts from its checkpoint
 * or from the beginning; an opt-out that arrives mid-flight is honoured only
 * if preferences are read at send time; a cancel stops queued jobs only if
 * senders check the campaign before each batch.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const SHARDS = 4;
  const PAGES = 6;
  const PAGE = 50;
  const TOTAL = SHARDS * PAGES * PAGE; // 1,200 recipients, each standing for many real people
  const SCALE = Math.round(2000000 / TOTAL);
  const MAYA = { shard: 1, page: 1, i: 10 };
  const AHEAD = 150; // fan-out keeps at most this many jobs queued
  const PACE = 120; // sends per second when paced
  const BATCH = 10;
  const UNPACED_BATCH = 40;
  const OPEN_P = 0.4; // share of recipients who open the app soon after the push
  const BASE_LOAD = 30; // ordinary app traffic per second
  const RESTART_MS = 800;
  const OPEN_TIMEOUT = 1500;

  const real = (n) => (Math.round((n * SCALE) / 1000) * 1000).toLocaleString('en-US');
  const uid = (shard, page, i) => (shard === MAYA.shard && page === MAYA.page && i === MAYA.i ? 'maya' : `u${shard}-${page}-${i}`);

  function startCampaign(sim) {
    const st = sim.state;
    if (st.camp.status !== 'draft') return;
    sim.startAction('Marketing: start “Spring sale” to the segment', function* (ctx) {
      Y.L(ctx, { displayed: ['n/a'], retrySafe: ['yes', 'Starting a running campaign is a no-op.'] });
      const r = yield ctx.call('campaigns', 'start', {}, { timeout: 600 });
      if (!r.ok) { Y.failed(ctx, `Campaigns answered ${r.error.code}.`); return; }
      Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', `${TOTAL.toLocaleString('en-US')} recipients across ${SHARDS} shards.`] });
      ctx.explain(`The segment has ${TOTAL.toLocaleString('en-US')} recipients here, each standing for about ${SCALE.toLocaleString('en-US')} real people. ${SHARDS} fan-out shards read it a page at a time; senders ${st.config.pace ? `pace it at ${PACE} a second` : 'send as fast as they can'}.`);
    }, { self: 'console' });
  }

  function control(sim, op) {
    const label = { pause: 'Marketing: pause the campaign', resume: 'Marketing: resume', cancel: 'Marketing: cancel, the price in the copy is wrong' }[op];
    sim.startAction(label, function* (ctx) {
      Y.L(ctx, { displayed: ['n/a'], retrySafe: 'yes' });
      const r = yield ctx.call('campaigns', op, {}, { timeout: 600 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['yes', `Campaign ${r.value.status}.`] });
      if (op === 'cancel') ctx.explain(`Cancelled with ${ctx.sim.queueStats('sends').depth} jobs already queued. ${ctx.state.config.cancelQueued ? 'Senders check the campaign before every batch, so those are dropped.' : 'Fan-out stops, but senders do not check the campaign: every queued job still goes out.'}`);
    }, { self: 'console' });
  }

  function optOut(sim) {
    sim.startAction('Maya: turn off promotional notifications', function* (ctx) {
      Y.L(ctx, { displayed: ['yes', 'The toggle flips at once.'], retrySafe: 'yes' });
      const r = yield ctx.call('users', 'optOut', { user: 'maya' }, { timeout: 600 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['n/a'] });
      const job = ctx.state.built.maya;
      ctx.explain(job ? `Maya’s job was built ${SDL.fmtMs(ctx.now() - job)} ago and is still waiting in the queue. ${ctx.state.config.optAtSend ? 'Senders read preferences at send time, so it will be suppressed.' : 'Preferences were read when the page was built; nothing checks them again.'}` : 'Her page has not been built yet, so fan-out will skip her.');
    }, { self: 'phone' });
  }

  const sc = (SDL.scenarios['nt-campaign'] = {
    id: 'nt-campaign',
    seed: 1217,
    minHopMs: 5,
    productWidth: 660,
    intro: `Start the campaign and watch four shards fan it out while the senders pace it. Then turn pacing off and watch the app backend, crash a shard with and without checkpoints, opt Maya out mid-flight, or cancel with jobs already queued.`,
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'console', label: 'Campaign console', sub: 'Start, pause, cancel', kind: 'client', x: 90, y: 90, latency: 1, role: 'The marketing team’s controls.', owns: ['Nothing'] },
        { id: 'campaigns', label: 'Campaigns', sub: 'Status: the one switch', kind: 'service', x: 300, y: 90, latency: 3, role: 'Holds the campaign row and its status: running, paused, cancelled, done. Fan-out and senders read it.', ops: [{ name: 'start', desc: 'Start fan-out.' }, { name: 'pause', desc: 'Pause.' }, { name: 'resume', desc: 'Resume.' }, { name: 'cancel', desc: 'Cancel.' }, { name: 'status', desc: 'Read status.' }], owns: ['campaign row'] },
        { id: 'fanout', label: 'Fan-out shards', sub: `${SHARDS} shards, ≤${AHEAD} jobs ahead`, kind: 'worker', x: 560, y: 90, latency: 2, role: `Each shard reads its slice of the segment a page of ${PAGE} at a time, skips people it has already built in this run, and commits the jobs. It waits while more than ${AHEAD} jobs are queued, so it never runs far ahead of sending.`, owns: ['In-memory “already built” set'] },
        { id: 'users', label: 'Users and preferences', sub: 'Segment query + opt-outs', kind: 'db', x: 560, y: 280, latency: 20, role: 'Returns a page of the segment, filtered by current opt-outs, and answers preference checks.', ops: [{ name: 'page', desc: 'One page of the segment.' }, { name: 'pref', desc: 'Is this person opted in?' }, { name: 'optOut', desc: 'Record an opt-out.' }], owns: ['users', 'preferences'] },
        { id: 'checkpoints', label: 'Checkpoints', sub: 'Jobs + page, one write', kind: 'db', x: 820, y: 90, latency: 6, role: 'Stores a page’s jobs and the shard’s checkpoint in one transaction, so a restarted shard resumes after the last committed page and never repeats one.', ops: [{ name: 'commit', desc: 'Commit a page.' }], owns: ['checkpoint per shard', 'job outbox'] },
        { id: 'sendq', label: 'Send queue', sub: 'Campaign jobs', kind: 'queue', x: 1060, y: 90, latency: 2, queue: 'sends', role: 'One job per recipient.', owns: ['campaign jobs'] },
        { id: 'senders', label: 'Senders', sub: `Paced at ${PACE}/s, or flat out`, kind: 'worker', x: 1060, y: 280, latency: 2, role: `Take a batch, check the campaign and each recipient’s preference, send. Paced: ${PACE} a second. Unpaced: as fast as the provider answers.`, owns: ['Pacing'] },
        { id: 'apns', label: 'Push provider', sub: 'APNs / FCM', kind: 'service', x: 820, y: 280, latency: 30, role: 'Delivers the pushes.', ops: [{ name: 'send', desc: 'Deliver a push.' }], owns: ['Nothing of ours'] },
        { id: 'crowd', label: 'Recipients’ phones', sub: `${Math.round(OPEN_P * 100)}% open the app`, kind: 'client', x: 560, y: 470, latency: 1, role: `About ${Math.round(OPEN_P * 100)}% of recipients open the app within a second or so of the push, on top of ${BASE_LOAD} ordinary requests a second.`, owns: ['Nothing'] },
        { id: 'backend', label: 'App backend', sub: 'About 100 requests/s', kind: 'service', x: 300, y: 470, latency: 2, serviceMs: 20, servers: 2, role: 'The product’s own API. It was sized for normal traffic, not for a campaign’s worth of people opening the app in the same few seconds. Requests queue when both workers are busy.', ops: [{ name: 'open', desc: 'Load the home screen.' }], owns: ['Everything else in the product'] },
        { id: 'phone', label: 'Maya’s phone', sub: 'In the segment', kind: 'client', x: 90, y: 470, latency: 1, role: 'One recipient. She can turn promotions off.', ops: [{ name: 'push', desc: 'Show a push.' }], owns: ['Nothing'] },
      ],
      edges: [
        { from: 'console', to: 'campaigns', latency: 20, label: 'HTTPS' },
        { from: 'campaigns', to: 'fanout', latency: 2 },
        { from: 'fanout', to: 'users', latency: 2 },
        { from: 'fanout', to: 'checkpoints', latency: 2 },
        { from: 'checkpoints', to: 'sendq', latency: 2 },
        { from: 'fanout', to: 'sendq', latency: 2, via: [[560, 30], [1060, 30]] },
        { from: 'sendq', to: 'senders', latency: 2 },
        { from: 'senders', to: 'campaigns', latency: 2, via: [[1120, 280], [1120, 180], [300, 180]] },
        { from: 'senders', to: 'users', latency: 2, via: [[1060, 360], [560, 360]] },
        { from: 'senders', to: 'apns', latency: 3 },
        { from: 'apns', to: 'crowd', latency: 30, via: [[820, 470]] },
        { from: 'apns', to: 'phone', latency: 30, via: [[900, 280], [900, 540], [90, 540]] },
        { from: 'crowd', to: 'backend', latency: 10 },
        { from: 'phone', to: 'users', latency: 25, via: [[90, 400], [520, 400], [520, 330]] },
      ],
      queues: [{ id: 'sends', broker: 'sendq', label: 'campaign jobs', groups: ['senders'] }],
    },
    modeLabels: { crash: 'Shard 1 crashes after its next page', dupRows: 'Segment returns duplicate rows' },
    failures: [
      { id: 'fanout-crash', node: 'fanout', mode: 'crash', label: 'Fan-out shard crash', desc: `Shard 1 dies after committing its next page and is restarted ${RESTART_MS} ms later, with an empty memory.` },
      { id: 'checkpoints-down', node: 'checkpoints', mode: 'down', label: 'Checkpoint store down', desc: 'Shards cannot commit pages, so fan-out stalls. Already queued jobs keep sending.' },
      { id: 'segment-slow', node: 'users', mode: 'slow', params: { factor: 15 }, label: 'Segment query slow', desc: 'Each page takes about 300 ms. Fan-out may fall behind the senders.' },
      { id: 'backend-slow', node: 'backend', mode: 'slow', params: { factor: 3 }, label: 'App backend overloaded', desc: 'The product’s API runs at a third of its capacity, from something else entirely.' },
      { id: 'senders-paused', node: 'senders', mode: 'paused', label: 'Senders paused', desc: 'The queue fills to its limit and fan-out waits. Nothing is lost.' },
      { id: 'dup-rows', node: 'users', mode: 'dupRows', label: 'Duplicate segment rows', desc: 'A join in the segment query returns some people twice (two email addresses, one person).' },
    ],
    switches: Y.switches([
      ['checkpoint', 'Checkpoints', 'Commit each page’s jobs and the shard’s checkpoint in one write; a restarted shard resumes after the last page. Off: progress lives only in the worker’s memory.'],
      ['pace', 'Pacing', `Send at ${PACE} a second. Off: as fast as the provider answers.`],
      ['optAtSend', 'Preferences at send time', 'Senders re-check each recipient’s preference just before sending. Off: only the segment query filters opt-outs, when the page is built.'],
      ['cancelQueued', 'Cancel stops queued jobs', 'Senders check the campaign before each batch and drop jobs of a cancelled or paused campaign. Off: cancel only stops fan-out.'],
    ]),
    presets: Y.presets({ checkpoint: true, pace: true, optAtSend: true, cancelQueued: true }, [
      { id: 'paced', label: 'Paced campaign', desc: `${PACE} sends a second. About ${Math.round(PACE * OPEN_P)} people a second open the app on top of the normal ${BASE_LOAD}; the backend has room.`, run: (s) => startCampaign(s) },
      { id: 'unpaced-herd', label: 'Unpaced: the thundering herd', desc: 'Senders go flat out. The pushes land within a few seconds, and so do the people opening the app. The product’s own backend queues past its timeout: the campaign worked and the app fell over.', sw: { pace: false }, run: (s) => startCampaign(s) },
      { id: 'crash-no-checkpoint', label: 'Shard crash, no checkpoint', desc: `Shard 1 dies after its second page and restarts with nothing in memory. It starts again from page 1, and everyone on its first pages, Maya included, gets the push twice.`, sw: { checkpoint: false }, run: (s) => { s.inject('fanout', 'crash'); startCampaign(s); } },
      { id: 'crash-checkpoint', label: 'Shard crash, with checkpoints', desc: 'Same crash. The restarted shard reads its checkpoint and resumes at the next page. Nobody gets it twice.', run: (s) => { s.inject('fanout', 'crash'); startCampaign(s); } },
      { id: 'optout-at-fanout', label: 'Maya opts out mid-campaign, checked at fan-out', desc: 'Her job was built before she flipped the toggle. Nothing reads her preference again, so the push arrives a second after she said no.', sw: { optAtSend: false }, run: (s) => { startCampaign(s); s.schedule(1200, () => optOut(s)); } },
      { id: 'optout-at-send', label: 'Maya opts out mid-campaign, checked at send', desc: 'Same timing. The sender reads her preference just before sending and suppresses it.', run: (s) => { startCampaign(s); s.schedule(1200, () => optOut(s)); } },
      { id: 'cancel-drains', label: 'Cancel with jobs queued', desc: `The copy has the wrong price. Cancel stops fan-out, and senders see the cancelled status at their next batch and drop every job already queued. The batch already in flight finishes; nothing after it goes out.`, run: (s) => { startCampaign(s); s.schedule(3000, () => control(s, 'cancel')); } },
      { id: 'cancel-ignores-queue', label: 'Cancel that only stops fan-out', desc: 'Same cancel. Fan-out stops, but the senders never look at the campaign, so every queued job still goes out with the wrong price.', sw: { cancelQueued: false }, run: (s) => { startCampaign(s); s.schedule(3000, () => control(s, 'cancel')); } },
      { id: 'dup-rows', label: 'Duplicate rows in the segment', desc: 'The segment query returns some people twice. The shard’s “already built” set skips the second row, so each person gets one job.', run: (s) => { s.inject('users', 'dupRows'); startCampaign(s); } },
      { id: 'checkpoints-down', label: 'Checkpoint store down for 2 s', desc: 'Shards cannot commit, so fan-out stops; the senders drain what is queued and then wait. When the store returns, fan-out continues from the last committed page. Late, not lost.', run: (s) => { startCampaign(s); s.schedule(1000, () => s.inject('checkpoints', 'down', true, 2000)); } },
    ]),
    initialState: () => ({
      config: { checkpoint: true, pace: true, optAtSend: true, cancelQueued: true },
      camp: { status: 'draft', t0: null, cancelledAt: null },
      ckpt: [-1, -1, -1, -1], mem: [-1, -1, -1, -1], shardDone: [false, false, false, false], run: [0, 0, 0, 0],
      optedOut: {}, sentTo: {}, built: {}, sendTimes: [],
      stats: { built: 0, sent: 0, dups: 0, suppressed: 0, dropped: 0, afterCancel: 0, dupRowsSkipped: 0, opens: 0, openFails: 0, crashes: 0, commitFails: 0, peakWait: 0 },
    }),
    initialUI: () => ({ phone: { pushes: [], promos: true, banner: null } }),
    actions: {
      start(sim) { startCampaign(sim); },
      pause(sim) { control(sim, 'pause'); },
      resume(sim) { control(sim, 'resume'); },
      cancel(sim) { control(sim, 'cancel'); },
      optOut(sim) { optOut(sim); },
    },
    handlers: {
      campaigns: {
        start(ctx) {
          const st = ctx.state;
          st.camp.status = 'running';
          st.camp.t0 = ctx.now();
          for (let s = 0; s < SHARDS; s++) shard(ctx.sim, s, ctx.actionId);
          return { status: 'running' };
        },
        pause(ctx) { if (ctx.state.camp.status === 'running') ctx.state.camp.status = 'paused'; return { status: ctx.state.camp.status }; },
        resume(ctx) { if (ctx.state.camp.status === 'paused') ctx.state.camp.status = 'running'; return { status: ctx.state.camp.status }; },
        cancel(ctx) { const c = ctx.state.camp; if (c.status === 'running' || c.status === 'paused') { c.status = 'cancelled'; c.cancelledAt = ctx.now(); } return { status: c.status }; },
        status(ctx) { return { status: ctx.state.camp.status }; },
      },
      users: {
        page(ctx, p) {
          const st = ctx.state;
          const rows = [];
          for (let i = 0; i < PAGE; i++) {
            const u = uid(p.shard, p.page, i);
            if (!st.optedOut[u]) rows.push(u);
          }
          if (ctx.mode('dupRows')) rows.push(...rows.slice(8, 12));
          return { rows };
        },
        pref(ctx, p) { return { optedIn: !ctx.state.optedOut[p.user] }; },
        optOut(ctx, p) { ctx.state.optedOut[p.user] = true; ctx.ui.phone.promos = false; return { optedOut: true }; },
      },
      checkpoints: {
        commit(ctx, p) {
          const st = ctx.state;
          st.ckpt[p.shard] = p.page;
          for (const u of p.users) ctx.sim.enqueue('sends', { type: 'campaign', eventId: `spring:${u}`, quiet: u !== 'maya', payload: { user: u, shard: p.shard, page: p.page }, actionId: p.aid });
          return { checkpoint: p.page };
        },
      },
      apns: {
        send: function* (ctx, p) {
          if (p.user !== 'maya') return { delivered: true };
          return ctx.must(yield ctx.call('phone', 'push', p, { timeout: 500 }));
        },
      },
      phone: {
        push(ctx, p) {
          const ui = ctx.ui.phone;
          ui.pushes.unshift({ t: ctx.now(), optedOut: !!ctx.state.optedOut.maya, afterCancel: ctx.state.camp.status === 'cancelled', n: ui.pushes.length + 1 });
          ui.banner = { title: 'Spring sale: 30% off everything', body: 'This weekend only.', tone: '', t: ctx.now() };
          return { shown: true };
        },
      },
      backend: { open() { return { home: true }; } },
    },
    setup(sim) {
      // Senders: one batch at a time, paced or flat out.
      sim.spawn(function* (ctx) {
        for (;;) {
          const st = ctx.state;
          const { msgs } = yield ctx.take('sends', 'senders', st.config.pace ? BATCH : UNPACED_BATCH);
          const t0 = ctx.now();
          if (st.config.cancelQueued) {
            const r = yield ctx.call('campaigns', 'status', {}, { timeout: 300, quiet: 'all' });
            const status = r.ok ? r.value.status : 'running';
            if (status === 'cancelled') {
              st.stats.dropped += msgs.length;
              if (msgs.some((m) => m.payload.user === 'maya') || st.stats.dropped === msgs.length) ctx.log({ op: `cancelled: ${msgs.length} queued jobs dropped`, status: 'drop', detail: 'The campaign is cancelled. Senders drop its jobs instead of sending them.' });
              ctx.ack('sends', 'senders');
              continue;
            }
            if (status === 'paused') { ctx.nack('sends', 'senders'); yield ctx.wait(100); continue; }
          }
          const procs = msgs.map((m) => ctx.spawn(function* (c) {
            const u = m.payload.user;
            const maya = u === 'maya';
            if (c.state.config.optAtSend) {
              const r = yield c.call('users', 'pref', { user: u }, { timeout: 300, quiet: maya ? false : 'all' });
              if (r.ok && !r.value.optedIn) {
                c.state.stats.suppressed++;
                if (maya) c.log({ op: 'suppressed: opted out', status: 'drop', detail: 'Maya turned promotions off after her job was built. The sender read her preference just now and skipped her.' });
                return;
              }
            }
            const s = yield c.call('apns', 'send', { user: u }, { timeout: 800, quiet: maya ? false : 'all' });
            if (!s.ok) return;
            const cs = c.state;
            cs.stats.sent++;
            cs.sendTimes.push(c.now());
            if (cs.sendTimes.length > 400) cs.sendTimes.shift();
            if (cs.camp.status === 'cancelled' && cs.camp.cancelledAt < t0) cs.stats.afterCancel++;
            cs.sentTo[u] = (cs.sentTo[u] || 0) + 1;
            if (cs.sentTo[u] === 2) cs.stats.dups++;
            if (c.rand() < OPEN_P) {
              const delay = 150 + Math.round(c.rand() * 500);
              c.spawn(function* (o) {
                yield o.wait(delay);
                const t = o.now();
                const r = yield o.call('backend', 'open', {}, { timeout: OPEN_TIMEOUT, quiet: 'all' });
                o.state.stats.opens++;
                if (!r.ok) o.state.stats.openFails++;
                void t;
              }, { self: 'crowd', quiet: 'all' });
            }
          }, { quiet: m.payload.user === 'maya' ? false : 'all', actionId: m.actionId }));
          yield ctx.join(procs);
          ctx.ack('sends', 'senders');
          if (st.config.pace) {
            const left = (msgs.length * 1000) / PACE - (ctx.now() - t0);
            if (left > 0) yield ctx.wait(left);
          }
        }
      }, { self: 'senders', quiet: 'all' });
      // Ordinary app traffic.
      Y.load(sim, 'crowd', () => BASE_LOAD, function* (c) {
        const r = yield c.call('backend', 'open', {}, { timeout: OPEN_TIMEOUT, quiet: 'all' });
        if (!r.ok) c.state.stats.openFails++;
      });
      // Track how far behind the backend is.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const w = ctx.sim.queueWait('backend');
          if (w > ctx.state.stats.peakWait) ctx.state.stats.peakWait = w;
        }
      }, { self: 'backend', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const ui = sim.ui.phone;
      if (st.stats.dups) return { key: 'wrong', label: `${st.stats.dups.toLocaleString('en-US')} people got the campaign twice${st.sentTo.maya > 1 ? ', Maya among them' : ''}, about ${real(st.stats.dups)} at real scale. Shard 1 restarted with no checkpoint and rebuilt pages it had already sent.` };
      const mayaAfter = ui.pushes.find((x) => x.optedOut);
      if (mayaAfter) return { key: 'wrong', label: 'Maya turned promotions off, and the push arrived anyway. Her job was built before the opt-out and nothing read her preference again. For marketing, that is a compliance problem, not a delay.' };
      if (st.stats.afterCancel) return { key: 'wrong', label: `The campaign was cancelled for a wrong price, and ${st.stats.afterCancel.toLocaleString('en-US')} more people got it afterwards, about ${real(st.stats.afterCancel)} at real scale. Cancel stopped fan-out; the queued jobs went out anyway.` };
      if (st.camp.status === 'draft') return { key: 'ok', label: 'Campaign not started.' };
      if (st.stats.openFails || st.stats.peakWait > 1000) return { key: 'stale', label: `The campaign reached people faster than the app could serve them. The app backend’s queue peaked at ${(st.stats.peakWait / 1000).toFixed(1)} s${st.stats.openFails ? ` and ${st.stats.openFails.toLocaleString('en-US')} home-screen loads timed out` : ', close to the point where loads time out'}, for campaign recipients and everyone else using the app.` };
      const depth = sim.queueStats('sends').depth;
      const remaining = TOTAL - st.stats.sent - st.stats.suppressed - st.stats.dropped;
      if (sim.nodes.checkpoints.modes.down && st.camp.status === 'running' && remaining > 0) return { key: 'stale', label: `Fan-out is stalled: the checkpoint store is down, so no new pages commit. ${depth} jobs left in the queue.` };
      if (sim.nodes.senders.modes.paused && remaining > 0) return { key: 'stale', label: `Senders are paused with ${depth} jobs queued. Nothing is lost; fan-out waits for room.` };
      const parts = [];
      if (st.camp.status === 'cancelled') parts.push(`Cancelled. ${st.stats.dropped.toLocaleString('en-US')} queued jobs were dropped by the senders; nothing went out after the cancel.`);
      else if (remaining <= 0 || st.camp.status === 'done') parts.push(`Done: ${st.stats.sent.toLocaleString('en-US')} sent, about ${real(st.stats.sent)} at real scale.`);
      else parts.push(`${st.stats.sent.toLocaleString('en-US')} of ${TOTAL.toLocaleString('en-US')} sent at ${PACE} a second.`);
      if (st.stats.crashes) parts.push(`Shard 1 crashed and resumed from its checkpoint; nobody got it twice.`);
      if (st.stats.suppressed) parts.push(`Maya’s opt-out was honoured at send time.`);
      if (st.stats.dupRowsSkipped) parts.push(`${st.stats.dupRowsSkipped} duplicate segment rows were skipped.`);
      if (st.stats.commitFails) parts.push('The checkpoint store was down for a while; fan-out resumed from the last committed page.');
      parts.push(`App backend queue peaked at ${SDL.fmtMs(st.stats.peakWait)}.`);
      return { key: 'ok', label: parts.join(' ') };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const recent = st.sendTimes.filter((t) => sim.now - t <= 1000).length;
      const w = sim.queueWait('backend');
      return [
        { label: 'Sent', value: st.stats.sent.toLocaleString('en-US') },
        { label: 'Remaining', value: Math.max(0, TOTAL - st.stats.sent - st.stats.suppressed - st.stats.dropped).toLocaleString('en-US') },
        { label: 'Sends per second', value: recent },
        { label: 'Got it twice', value: st.stats.dups, tone: st.stats.dups ? 'fail' : '' },
        { label: 'Sent after cancel', value: st.stats.afterCancel, tone: st.stats.afterCancel ? 'fail' : '' },
        { label: 'Suppressed (opted out)', value: st.stats.suppressed },
        { label: 'Backend queue', value: SDL.fmtMs(w), tone: w > 1000 ? 'fail' : w > 300 ? 'warn' : '' },
        { label: 'Home loads timed out', value: st.stats.openFails, tone: st.stats.openFails ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone']], {
          note: 'Maya can turn promotions off at any point. The console runs the campaign and shows each shard’s progress and the app backend’s health.',
          side: `<p class="ops-title">Campaign console</p><div class="ops-traffic" data-ref="ctl"></div><div data-ref="camp"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const ui = sim.ui.phone;
        const s = st.camp.status;
        Y.paint(el, sim, 'phone', {
          head: '<div><p class="app-title">Maya</p><p class="app-sub">Shop app</p></div>',
          act: `<div class="app-sec">${Y.btn('optOut', ui.promos ? 'Turn off promotions' : 'Promotions are off', { disabled: !ui.promos })}</div>`,
          body: `<p class="app-sub">Notifications (${ui.pushes.length})</p>${ui.pushes.map((n) => `<div class="app-card ${n.optedOut || n.afterCancel || n.n > 1 ? 'is-warn' : ''}"><strong>Spring sale: 30% off everything</strong><span class="app-sub">${n.optedOut ? 'after she opted out' : n.afterCancel ? 'after the campaign was cancelled' : n.n > 1 ? 'again' : 'This weekend only.'}</span></div>`).join('') || '<p class="app-sub">Nothing yet.</p>'}`,
        }, {}, ui.banner);
        const ctl = el.querySelector('[data-ref="ctl"]');
        const ctlHtml = `${Y.btn('start', 'Start', { disabled: s !== 'draft' })}${Y.btn('pause', 'Pause', { cls: 'secondary', disabled: s !== 'running' })}${Y.btn('resume', 'Resume', { cls: 'secondary', disabled: s !== 'paused' })}${Y.btn('cancel', 'Cancel', { cls: 'secondary', disabled: s !== 'running' && s !== 'paused' })}`;
        if (ctl.dataset.html !== ctlHtml) { ctl.innerHTML = ctlHtml; ctl.dataset.html = ctlHtml; }
        const c = sim.scenario.consistency(sim);
        const done = st.stats.sent + st.stats.suppressed + st.stats.dropped;
        const shards = [0, 1, 2, 3].map((k) => {
          const pg = st.config.checkpoint ? st.ckpt[k] : st.mem[k];
          const tone = st.shardDone[k] ? 'ok' : st.run[k] > 1 ? 'warn' : 'ok';
          return `<span class="kv-file ${st.shardDone[k] ? 'has-key' : ''}">shard ${k} · ${st.shardDone[k] ? 'done' : `page ${pg + 1} of ${PAGES}`}${st.run[k] > 1 ? ` · run ${st.run[k]}` : ''}${tone === 'warn' ? ' · restarted' : ''}</span>`;
        }).join('');
        const w = sim.queueWait('backend');
        SDL.ui.paintSections(el.querySelector('[data-ref="camp"]'), {
          prog: `<div class="ops-row" data-tone="${s === 'cancelled' ? 'warn' : 'ok'}"><div class="ops-name"><strong>Spring sale · ${s}</strong><span>${done.toLocaleString('en-US')} of ${TOTAL.toLocaleString('en-US')} · ${sim.queueStats('sends').depth} queued</span></div><div class="ops-bar"><i style="width:${Math.min(100, Math.round((100 * done) / TOTAL))}%"></i></div></div>`,
          shards: `<p class="ops-title">Fan-out ${st.config.checkpoint ? '(checkpoints)' : '(progress in memory)'}</p><div class="kv-files">${shards}</div>`,
          backend: `<div class="ops-row" data-tone="${w > 1000 || st.stats.openFails ? 'fail' : w > 300 ? 'warn' : 'ok'}"><div class="ops-name"><strong>App backend</strong><span>queue ${SDL.fmtMs(w)} · peak ${SDL.fmtMs(st.stats.peakWait)} · ${st.stats.openFails} timed out</span></div><div class="ops-bar"><i style="width:${Math.min(100, Math.round(w / 15))}%"></i></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });

  // One fan-out shard run. A crash ends the run; the supervisor starts a new one with an empty memory.
  function shard(sim, k, aid) {
    const st = sim.state;
    const run = ++st.run[k];
    sim.spawn(function* (ctx) {
      const s = ctx.state;
      const seen = {};
      let page = s.config.checkpoint ? s.ckpt[k] + 1 : 0;
      if (run > 1) ctx.log({ op: `shard ${k} restarted at page ${page + 1}`, status: 'recovered', detail: s.config.checkpoint ? `The checkpoint says page ${page} was committed. Resume after it.` : 'No checkpoint, and the old process’s memory is gone. Start from the first page.' });
      while (page < PAGES) {
        const status = s.camp.status;
        if (status === 'cancelled') return;
        if (status === 'paused' || ctx.sim.queueStats('sends').depth > AHEAD) { yield ctx.wait(50); continue; }
        const r = yield ctx.call('users', 'page', { shard: k, page }, { timeout: 2000, quiet: 'all' });
        if (!r.ok) { yield ctx.wait(200); continue; }
        const users = [];
        const inPage = {};
        let dupes = 0;
        for (const u of r.value.rows) {
          if (seen[u] || inPage[u]) { dupes++; continue; }
          inPage[u] = true;
          users.push(u);
        }
        if (s.config.checkpoint) {
          const c = yield ctx.call('checkpoints', 'commit', { shard: k, page, users, aid }, { timeout: 500, quiet: true });
          if (!c.ok) { s.stats.commitFails++; yield ctx.wait(300); continue; }
        } else {
          for (const u of users) ctx.sim.enqueue('sends', { type: 'campaign', eventId: `spring:${u}`, quiet: u !== 'maya', payload: { user: u, shard: k, page }, actionId: aid });
          s.mem[k] = page;
        }
        // Only a committed page counts as built: a failed commit is retried with the same people.
        for (const u of users) seen[u] = true;
        if (users.includes('maya')) s.built.maya = ctx.now();
        s.stats.dupRowsSkipped += dupes;
        s.stats.built += users.length;
        if (k === 1 && page >= 1 && ctx.mode('crash')) {
          ctx.sim.restore('fanout', 'crash');
          s.stats.crashes++;
          ctx.log({ op: `shard ${k} crashed after page ${page + 1}`, status: 'fault', detail: `Page ${page + 1} was ${s.config.checkpoint ? 'committed with its checkpoint' : 'queued; progress was only in memory'}. A new process starts in ${RESTART_MS} ms.` });
          s.mem[k] = -1;
          ctx.sim.schedule(RESTART_MS, () => { if (ctx.sim.state.camp.status !== 'cancelled') shard(ctx.sim, k, aid); });
          return;
        }
        page++;
      }
      s.shardDone[k] = true;
      if (s.shardDone.every(Boolean)) ctx.log({ op: 'fan-out complete', status: 'ok', detail: 'Every shard has built every page. Senders drain the rest.' });
    }, { self: 'fanout', actionId: aid, quiet: 'all' });
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
