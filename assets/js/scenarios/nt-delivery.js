/*
 * At-least-once, idempotency, and the dead-letter queue.
 * Inside the send worker: take a job, render, check the dedupe store, call
 * the provider, mark the key, acknowledge. Every gap between two of those
 * steps is a place a crash turns "once" into "twice" or "never". Two things
 * keep the phone honest: a dedupe store at the worker and a collapse id on
 * the push itself, so a duplicate that gets past the store replaces the one
 * on the lock screen instead of stacking. Keys expire, teams retry, templates
 * break: each has a scenario here.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const TITLE = 'Your order has shipped';
  const TEXT = 'Arriving Thursday. Track it in the app.';
  const MAX_ATTEMPTS = 4;
  const DEDUPE_TTL = 2000; // how long the dedupe store remembers a key
  const DISMISS_MS = 2500; // Maya clears the lock screen this long after a push
  const LATE_DUP_MS = 3000; // a broker redelivery that arrives this late
  const STAGES = ['taken', 'rendered', 'checked', 'sent', 'marked', 'acked'];

  function startSend(sim, opts) {
    opts = opts || {};
    const st = sim.state;
    const idem = opts.idem || `ship-${++st.seq.idem}`;
    sim.startAction(opts.retry ? 'Checkout team: retry the same request' : opts.poison ? 'Checkout team: send with a broken template' : 'Checkout team: send “order shipped”', function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'The team sees the API reply; the phone shows the result.'], retrySafe: [st.config.idem ? 'yes' : 'no', st.config.idem ? `Idempotency key ${idem}.` : 'No idempotency key: a retry creates a second notification.'] });
      const r = yield ctx.call('api', 'send', { idem, poison: !!opts.poison, user: 'maya' }, { timeout: 700 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) {
        Y.L(ctx, { accepted: ['yes', r.value.existing ? `202, existing id ${r.value.nid} (same key).` : `202, id ${r.value.nid}.`], committed: 'yes', async: ['pending', 'Delivery is asynchronous.'] });
        ctx.explain(r.value.existing ? `The API found key ${idem} already stored and returned the same id. No second notification.` : `202 in ${Math.round(r.latency)} ms. The outbox row becomes a push job.`);
      } else {
        Y.failed(ctx, `The team got ${r.error.code}.`);
        if (opts.autoRetry && r.error.code === 'TIMEOUT') {
          ctx.explain('The reply was lost, so the team’s client times out and retries the call. Whether that creates a second notification depends on the idempotency key.');
          ctx.sim.schedule(400, () => startSend(ctx.sim, { idem, retry: true }));
        } else ctx.explain(`The API answered ${r.error.code}.`);
      }
    }, { self: 'console' });
  }

  function lateDuplicate(sim, delay) {
    // The broker redelivers an already-acknowledged job much later (a stuck replica catches up).
    sim.schedule(delay, () => {
      const q = sim.queues.sends;
      const first = q.msgs[0];
      if (!first) return;
      sim.state.lateDups++;
      sim.enqueue('sends', { type: 'send', eventId: first.eventId, payload: first.payload, actionId: first.actionId, late: true });
      sim.note(`The broker redelivered ${first.eventId} ${delay} ms after the first delivery.`);
    });
  }

  const sc = (SDL.scenarios['nt-delivery'] = {
    id: 'nt-delivery',
    seed: 823,
    minHopMs: 5,
    productWidth: 660,
    intro: 'Send one order update and follow the job through the worker’s six stages. Then crash the worker between “sent” and “marked”, lose the provider’s reply, retry from the team without a key, let the dedupe key expire, or poison the template and watch the queue with and without a dead-letter queue.',
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'console', label: 'Checkout team', sub: 'Caller', kind: 'client', x: 90, y: 90, latency: 1, role: 'Calls the API. Its HTTP client retries on timeout, like every HTTP client.', owns: ['Idempotency keys'] },
        { id: 'api', label: 'Notification API', sub: 'Idempotency at intake', kind: 'gateway', x: 300, y: 90, latency: 3, role: 'Looks the idempotency key up before creating anything. The same key returns the same id.', ops: [{ name: 'send', desc: 'Accept a request.' }], owns: ['Nothing durable'] },
        { id: 'notifdb', label: 'Notification store', sub: 'Requests + outbox', kind: 'db', x: 520, y: 90, latency: 8, queue: 'outbox', role: 'Request rows keyed by idempotency key, and the outbox rows the relay drains.', ops: [{ name: 'write', desc: 'Store request + outbox row.' }], owns: ['requests', 'outbox'] },
        { id: 'relay', label: 'Outbox relay', sub: 'Rows → jobs', kind: 'worker', x: 740, y: 90, latency: 3, role: 'Turns outbox rows into push jobs.', owns: ['Relay offset'] },
        { id: 'sendq', label: 'Send queue', sub: 'At least once', kind: 'queue', x: 960, y: 90, latency: 3, queue: 'sends', role: 'Delivers each job at least once. A job that is not acknowledged comes back; a broker replica that catches up late can redeliver one that was.', owns: ['send jobs'] },
        { id: 'workerA', label: 'Worker A', sub: 'Six stages per job', kind: 'worker', x: 740, y: 270, latency: 4, role: 'One of two workers in the consumer group. Six stages per job; a crash between any two is a scenario here.', owns: ['In-flight job'] },
        { id: 'workerB', label: 'Worker B', sub: 'Same group', kind: 'worker', x: 960, y: 270, latency: 4, role: 'Takes whatever Worker A does not, including Worker A’s unacknowledged job after a crash.', owns: ['In-flight job'] },
        { id: 'dedupe', label: 'Dedupe store', sub: `Keys expire after ${DEDUPE_TTL / 1000} s`, kind: 'cache', x: 520, y: 270, latency: 4, role: 'Remembers (notification, channel) keys that were sent. Checked before the provider is called, written after. Keys have a TTL, so it only protects against duplicates that arrive soon enough.', ops: [{ name: 'check', desc: 'Has this key been sent?' }, { name: 'mark', desc: 'Record a sent key.' }], owns: ['sent keys'] },
        { id: 'dlq', label: 'Dead letters', sub: 'For a human', kind: 'queue', x: 960, y: 450, latency: 2, queue: 'dead', role: 'Jobs that failed every attempt, parked so the queue can move.', ops: [{ name: 'publish', desc: 'Park a job.' }], owns: ['dead jobs'] },
        { id: 'apns', label: 'Push provider', sub: 'Collapse id', kind: 'service', x: 520, y: 450, latency: 30, role: 'Accepts a push and delivers it to the phone. A push with the same collapse id as one still on the lock screen replaces it instead of stacking.', ops: [{ name: 'send', desc: 'Deliver a push.' }], owns: ['Nothing of ours'] },
        { id: 'phone', label: 'Maya’s phone', sub: 'Lock screen', kind: 'client', x: 90, y: 450, latency: 1, role: `Shows pushes. Maya clears the lock screen about ${DISMISS_MS / 1000} s after a push arrives; after that, a duplicate has nothing to collapse into.`, ops: [{ name: 'push', desc: 'Show a push.' }], owns: ['Nothing'] },
      ],
      edges: [
        { from: 'console', to: 'api', latency: 30, label: 'HTTPS' },
        { from: 'api', to: 'notifdb', latency: 4 },
        { from: 'notifdb', to: 'relay', latency: 4 },
        { from: 'relay', to: 'sendq', latency: 4 },
        { from: 'sendq', to: 'workerA', latency: 3 },
        { from: 'sendq', to: 'workerB', latency: 3 },
        { from: 'workerA', to: 'dedupe', latency: 4 },
        { from: 'workerB', to: 'dedupe', latency: 4, via: [[740, 350], [520, 350]] },
        { from: 'workerA', to: 'apns', latency: 4 },
        { from: 'workerB', to: 'apns', latency: 4, via: [[850, 400]] },
        { from: 'workerA', to: 'dlq', latency: 3 },
        { from: 'workerB', to: 'dlq', latency: 3 },
        { from: 'apns', to: 'phone', latency: 30 },
      ],
      queues: [
        { id: 'outbox', broker: 'notifdb', label: 'outbox rows', groups: ['relay'] },
        { id: 'sends', broker: 'sendq', label: 'push jobs', groups: ['workers'] },
        { id: 'dead', broker: 'dlq', label: 'dead letters', groups: [] },
      ],
    },
    modeLabels: { crashAfterSend: 'Crashes after the next provider accept', crashBeforeSend: 'Crashes before the next provider call' },
    failures: [
      { id: 'crash-after', node: 'workerA', mode: 'crashAfterSend', label: 'Worker crash after provider accept', desc: 'The next job is sent, then the worker dies before marking or acknowledging. The other worker gets it again.' },
      { id: 'crash-before', node: 'workerA', mode: 'crashBeforeSend', label: 'Worker crash before the provider call', desc: 'The next job is taken and rendered, then the worker dies. The other worker gets it; nothing was sent, so nothing is duplicated.' },
      { id: 'apns-drop', node: 'apns', mode: 'dropResponse', label: 'Provider reply lost', desc: 'The provider accepts and delivers, but its reply never reaches the worker. The worker sees a timeout.' },
      { id: 'apns-down', node: 'apns', mode: 'down', label: 'Push provider down', desc: 'Every send fails. Retries follow the retry policy.' },
      { id: 'dedupe-down', node: 'dedupe', mode: 'down', label: 'Dedupe store down', desc: 'The worker cannot check or mark keys. It fails closed: the job waits.' },
      { id: 'api-drop', node: 'api', mode: 'dropResponse', label: 'API reply lost', desc: 'The request is stored but the team sees a timeout and its client retries.' },
      { id: 'relay-paused', node: 'relay', mode: 'paused', label: 'Relay paused', desc: 'Outbox rows wait. Nothing is lost.' },
      { id: 'sendq-dup', node: 'sendq', mode: 'duplicate', label: 'Queue delivers twice, immediately', desc: 'Every job is appended twice. The dedupe store catches the copy.' },
    ],
    switches: Y.switches([
      ['idem', 'Idempotency key at intake', 'The API stores requests by the team’s key and returns the existing id for a repeat. Off: every call creates a notification.'],
      ['dedupe', 'Dedupe store and collapse id', 'The worker checks the key before sending, marks it after, and sends the key as the push’s collapse id so a late duplicate replaces rather than stacks. Off: every delivery of a job is a fresh push.'],
      ['backoff', 'Retry with backoff', 'Failed sends are retried at 300, 600, 1200, 2400 ms. Off: retried immediately, so four attempts are spent in under a second.'],
      ['dlq', 'Dead-letter failing jobs', `After ${MAX_ATTEMPTS} attempts, park the job and move on. Off: keep retrying the same job at the head of the queue.`],
    ]),
    presets: Y.presets({ idem: true, dedupe: true, backoff: true, dlq: true }, [
      { id: 'clean', label: 'One send, six stages', desc: 'Taken, rendered, checked (no key), sent, marked, acknowledged. One push, about 200 ms after the team’s call.', run: (s) => startSend(s) },
      { id: 'retry-no-key', label: 'Team retries after a lost reply, no key', desc: 'The API’s reply is lost; the team’s client retries the call. Without an idempotency key the API creates a second notification. Two pushes with different ids: nothing downstream can tell they are the same.', sw: { idem: false }, run: (s) => { s.inject('api', 'dropResponse', true, 300); startSend(s, { autoRetry: true }); } },
      { id: 'retry-key', label: 'Team retries after a lost reply, with a key', desc: 'Same lost reply, same retry. The API finds the key and returns the existing id. One push.', run: (s) => { s.inject('api', 'dropResponse', true, 300); startSend(s, { autoRetry: true }); } },
      { id: 'crash-no-dedupe', label: 'Crash after accept, no dedupe', desc: 'Worker A sends, then dies before acknowledging. Worker B gets the job and sends again. Two pushes on the lock screen.', sw: { dedupe: false }, run: (s) => { s.inject('workerA', 'crashAfterSend'); startSend(s); } },
      { id: 'crash-dedupe', label: 'Crash after accept, with dedupe and collapse id', desc: 'Worker A died before marking the key, so the store cannot help: Worker B sends again. But the push carries the same collapse id, and the phone replaces the first one. Two provider calls, one notification.', run: (s) => { s.inject('workerA', 'crashAfterSend'); startSend(s); } },
      { id: 'dropped-reply', label: 'Provider accepted, reply lost', desc: 'The push lands, but the worker sees a timeout and retries. The store has no mark yet; the second send collapses into the first on the phone. The provider’s reply is not the truth about delivery.', run: (s) => { s.inject('apns', 'dropResponse', true, 200); startSend(s); } },
      { id: 'dedupe-down', label: 'Dedupe store down for 2 s', desc: 'The worker cannot check the key, so it waits rather than guess. The push arrives late, once. Failing closed is the right default for “did we already send this?”.', run: (s) => { s.inject('dedupe', 'down', true, 2000); startSend(s); } },
      { id: 'late-dup', label: 'Broker redelivers 3 s later, key expired', desc: `A broker replica catches up and redelivers an acknowledged job after ${LATE_DUP_MS / 1000} s. The dedupe key expired at ${DEDUPE_TTL / 1000} s and Maya had already cleared the lock screen, so there is nothing to collapse into. A second push.`, run: (s) => { startSend(s); lateDuplicate(s, LATE_DUP_MS); } },
      { id: 'poison-dlq', label: 'Broken template, dead-lettered', desc: 'The render step throws on every attempt. After four attempts the job is parked and the next notification flows.', run: (s) => { startSend(s, { poison: true }); s.schedule(600, () => startSend(s)); } },
      { id: 'poison-blocks', label: 'Broken template blocks the queue', desc: 'Without a dead-letter queue the same job is retried at the head of the queue for ever. The good notification behind it never moves.', sw: { dlq: false }, run: (s) => { startSend(s, { poison: true }); s.schedule(600, () => startSend(s)); } },
      { id: 'immediate-retries', label: 'Provider down 1.5 s, immediate retries', desc: 'Four attempts are spent in under a second while the provider is still down. The job dead-letters although the outage was short.', sw: { backoff: false }, run: (s) => { s.inject('apns', 'down', true, 1500); startSend(s); } },
      { id: 'backoff', label: 'Provider down 1.5 s, backoff', desc: 'Attempts at 300, 600, and 1200 ms spread across the outage; the fourth lands after the provider is back. One push, late.', run: (s) => { s.inject('apns', 'down', true, 1500); startSend(s); } },
    ]),
    initialState: () => ({
      config: { idem: true, dedupe: true, backoff: true, dlq: true },
      byIdem: {}, requests: {}, jobs: {}, marks: {}, attempts: {}, dead: [], lateDups: 0,
      stats: { requests: 0, providerCalls: 0, retries: 0, dupSkipped: 0, collapsed: 0, dismissed: 0 },
      seq: { idem: 0, n: 0, job: 0 },
    }),
    initialUI: () => ({ phone: { pushes: [], dismissed: [], banner: null } }),
    actions: {
      send(sim, a) { startSend(sim, a); },
    },
    handlers: {
      api: {
        send: function* (ctx, p) {
          const st = ctx.state;
          if (st.config.idem && st.byIdem[p.idem]) {
            ctx.log({ op: `key ${p.idem} seen`, status: 'dup', actionId: ctx.actionId, detail: `Request ${st.byIdem[p.idem]} already exists for this key. Returning it instead of creating another.` });
            return { nid: st.byIdem[p.idem], existing: true };
          }
          const nid = `n${++st.seq.n}`;
          ctx.must(yield ctx.call('notifdb', 'write', { nid, idem: p.idem, poison: p.poison }, { timeout: 600 }));
          return { nid, existing: false };
        },
      },
      notifdb: {
        write(ctx, p) {
          const st = ctx.state;
          st.requests[p.nid] = { id: p.nid, idem: p.idem, t: ctx.now(), poison: p.poison };
          st.byIdem[p.idem] = p.nid;
          st.stats.requests++;
          ctx.sim.enqueue('outbox', { type: 'notification', eventId: p.nid, payload: { nid: p.nid, poison: p.poison }, actionId: ctx.actionId });
          return { stored: true };
        },
      },
      dedupe: {
        check(ctx, p) {
          const m = ctx.state.marks[p.key];
          if (m && ctx.now() - m > DEDUPE_TTL) { delete ctx.state.marks[p.key]; return { seen: false, expired: true }; }
          return { seen: !!m };
        },
        mark(ctx, p) { ctx.state.marks[p.key] = ctx.now(); return { marked: true }; },
      },
      apns: { send: function* (ctx, p) { ctx.state.stats.providerCalls++; return ctx.must(yield ctx.call('phone', 'push', p, { timeout: 500 })); } },
      phone: {
        push(ctx, p) {
          const ui = ctx.ui.phone;
          const st = ctx.state;
          const ms = ctx.now() - st.requests[p.nid].t;
          const existing = p.collapseId ? ui.pushes.find((x) => x.collapseId === p.collapseId) : null;
          if (existing) {
            st.stats.collapsed++;
            Object.assign(existing, { t: ctx.now(), ms, replaced: (existing.replaced || 0) + 1 });
            ctx.log({ op: `push collapsed into ${p.collapseId}`, status: 'dup', actionId: ctx.actionId, detail: 'A notification with this collapse id is still on the lock screen. The phone replaces it; Maya sees one.' });
          } else {
            const entry = { key: p.key, nid: p.nid, collapseId: p.collapseId || null, title: p.title, text: p.text, t: ctx.now(), ms };
            ui.pushes.unshift(entry);
            ui.banner = { title: p.title, body: p.text, tone: 'ok', t: ctx.now() };
            ctx.spawn(function* (c) {
              yield c.wait(DISMISS_MS);
              const i = ui.pushes.indexOf(entry);
              if (i >= 0) { ui.pushes.splice(i, 1); ui.dismissed.unshift(entry); st.stats.dismissed++; }
            }, { self: 'phone', quiet: true });
          }
          st.shown = (st.shown || 0) + (existing ? 0 : 1);
          return { shown: !existing, collapsed: !!existing };
        },
      },
    },
    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('outbox', 'relay');
          const key = `${msg.payload.nid}/push`;
          ctx.state.jobs[key] = { key, nid: msg.payload.nid, stage: 'queued', worker: null, deliveries: 0, history: [] };
          ctx.sim.enqueue('sends', { type: 'send', eventId: key, payload: { nid: msg.payload.nid, key, poison: msg.payload.poison }, actionId: msg.actionId });
          ctx.ack('outbox', 'relay');
        }
      }, { self: 'relay' });
      // Two workers in one consumer group. Each job runs through six stages.
      const worker = (self) => Y.consumer(sim, 'sends', 'workers', self, function* (ctx, msg) {
        const st = ctx.state;
        const p = msg.payload;
        const job = st.jobs[p.key];
        const n = ctx.sim.nodes[self].label;
        job.deliveries++;
        job.worker = self;
        const stage = (s) => { job.stage = s; job.history.push([ctx.now(), self, s]); };
        stage('taken');
        if (msg.late) ctx.log({ op: `${p.key} redelivered late`, status: 'note', actionId: msg.actionId, detail: `${n} took a job the group acknowledged ${LATE_DUP_MS / 1000} s ago.` });
        const attempt = (st.attempts[p.key] = (st.attempts[p.key] || 0) + 1);
        if (attempt > 1 && !msg.late && !msg.duplicate) st.stats.retries++;
        yield ctx.wait(6); // render
        if (p.poison) {
          ctx.log({ op: `${p.key} render failed`, status: 'fail', actionId: msg.actionId, detail: `${n}: the template references a field this request does not have. Attempt ${attempt}.` });
          if (st.config.dlq && attempt >= MAX_ATTEMPTS) {
            stage('dead');
            st.dead.push({ key: p.key, why: 'Template error', t: ctx.now() });
            ctx.sim.enqueue('dead', { type: 'dead', eventId: p.key, payload: p, actionId: msg.actionId });
            ctx.log({ op: `${p.key} dead-lettered`, status: 'fault', actionId: msg.actionId, detail: `Template error after ${attempt} attempts. Parked; the queue moves on.` });
            ctx.sim.setLedger(msg.actionId, 'async', 'no', 'Dead-lettered: template error.');
            return true;
          }
          stage('retrying');
          return false;
        }
        stage('rendered');
        if (ctx.mode('crashBeforeSend')) {
          ctx.sim.restore(self, 'crashBeforeSend');
          ctx.log({ op: `${n} crashed before sending ${p.key}`, status: 'fault', actionId: msg.actionId, detail: 'Rendered, not sent. The job is unacknowledged and comes back to the group.' });
          stage('crashed');
          return false;
        }
        if (st.config.dedupe) {
          const c = yield ctx.call('dedupe', 'check', { key: p.key }, { timeout: 500, actionId: msg.actionId });
          if (!c.ok) {
            ctx.log({ op: `${p.key} waits: dedupe store ${c.error.code}`, status: 'retry', actionId: msg.actionId, detail: 'Cannot tell whether this was sent. Failing closed: try again shortly rather than risk a duplicate.' });
            stage('retrying');
            return false;
          }
          if (c.value.seen) {
            st.stats.dupSkipped++;
            stage('acked');
            ctx.log({ op: `${p.key} already sent`, status: 'dup', actionId: msg.actionId, detail: 'The dedupe store has this key. Skipped before any provider call.' });
            return true;
          }
          if (c.value.expired) ctx.log({ op: `${p.key} key expired`, status: 'note', actionId: msg.actionId, detail: `The store did remember this key once, but it expired after ${DEDUPE_TTL / 1000} s. As far as the worker knows, this is a first send.` });
        }
        stage('checked');
        const r = yield ctx.call('apns', 'send', { nid: p.nid, key: p.key, title: TITLE, text: TEXT, collapseId: st.config.dedupe ? p.key : null }, { timeout: 600, actionId: msg.actionId });
        if (r.ok && ctx.mode('crashAfterSend')) {
          ctx.sim.restore(self, 'crashAfterSend');
          ctx.log({ op: `${n} crashed after ${p.key} was accepted`, status: 'fault', actionId: msg.actionId, detail: 'The provider said yes. The key was not marked and the job was not acknowledged: the other worker will send it again.' });
          stage('crashed');
          return false;
        }
        if (!r.ok) {
          if (attempt >= MAX_ATTEMPTS) {
            if (st.config.dlq) {
              stage('dead');
              st.dead.push({ key: p.key, why: 'Provider unavailable', t: ctx.now() });
              ctx.sim.enqueue('dead', { type: 'dead', eventId: p.key, payload: p, actionId: msg.actionId });
              ctx.log({ op: `${p.key} dead-lettered`, status: 'fault', actionId: msg.actionId, detail: `Provider ${r.error.code} on all ${attempt} attempts. Parked.` });
              ctx.sim.setLedger(msg.actionId, 'async', 'no', 'Dead-lettered: provider unavailable.');
              return true;
            }
            stage('retrying');
            return false;
          }
          const delay = st.config.backoff ? 300 * 2 ** (attempt - 1) : 0;
          stage('retrying');
          ctx.log({ op: `${p.key} retry ${delay ? `in ${delay} ms` : 'now'}`, status: 'retry', actionId: msg.actionId, detail: `${r.error.message} Attempt ${attempt} of ${MAX_ATTEMPTS}.` });
          ctx.spawn(function* (c) {
            if (delay) yield c.wait(delay);
            c.sim.enqueue('sends', { type: 'send', eventId: `${p.key}#${++c.state.seq.job}`, payload: p, actionId: msg.actionId });
          }, { self, quiet: true });
          return true;
        }
        stage('sent');
        if (st.config.dedupe) {
          const m = yield ctx.call('dedupe', 'mark', { key: p.key }, { timeout: 500, actionId: msg.actionId });
          if (!m.ok) { ctx.log({ op: `${p.key} mark failed`, status: 'fault', actionId: msg.actionId, detail: 'Sent but not marked. A later redelivery would send again.' }); }
          else stage('marked');
        }
        stage('acked');
        ctx.sim.setLedger(msg.actionId, 'async', 'yes', r.value.collapsed ? 'Delivered (collapsed into the first push).' : 'Delivered.');
        return true;
      });
      worker('workerA');
      worker('workerB');
    },
    consistency(sim) {
      const st = sim.state;
      const ui = sim.ui.phone;
      const all = ui.pushes.concat(ui.dismissed);
      const byNid = {};
      for (const x of all) byNid[x.nid] = (byNid[x.nid] || 0) + 1;
      const twice = Object.keys(byNid).find((k) => byNid[k] > 1);
      if (twice) return { key: 'wrong', label: `Maya saw “${TITLE}” twice for the same request (${twice}). ${st.lateDups ? 'The redelivery came after the dedupe key expired and after she had cleared the lock screen.' : 'Nothing remembered the first send and nothing on the phone collapsed the second.'}` };
      const idems = {};
      for (const r of Object.values(st.requests)) idems[r.idem] = (idems[r.idem] || 0) + 1;
      const dupIdem = Object.keys(idems).find((k) => idems[k] > 1);
      if (dupIdem && Object.keys(byNid).length > 1) return { key: 'wrong', label: `The team’s retry created a second notification for key ${dupIdem}. Two pushes with different ids: the worker’s dedupe store cannot tell they are the same message.` };
      const jobs = Object.values(st.jobs);
      if (!Object.keys(st.requests).length) return { key: 'ok', label: 'Nothing sent yet.' };
      const good = jobs.filter((j) => !st.requests[j.nid].poison);
      const unsent = good.filter((j) => !all.some((x) => x.nid === j.nid));
      const deadGood = good.filter((j) => j.stage === 'dead');
      if (deadGood.length) return { key: 'stale', label: `${deadGood[0].key} is dead-lettered: ${st.attempts[deadGood[0].key]} attempts${st.config.backoff ? '' : ' in well under a second'} while the provider was down. The message never reached Maya; a human has to replay it.` };
      if (unsent.length) {
        const blocked = jobs.some((j) => st.requests[j.nid].poison && j.stage === 'retrying' && !st.config.dlq);
        if (blocked) return { key: 'stale', label: 'The queue is blocked by a job that fails every attempt. The good notification behind it will never be delivered.' };
        return { key: 'stale', label: `${unsent.length} notification${unsent.length > 1 ? 's' : ''} still on the way${jobs.some((j) => j.stage === 'retrying') ? ', being retried' : ''}.` };
      }
      const pending = Object.keys(st.requests).filter((nid) => !st.jobs[`${nid}/push`]);
      if (pending.length) return { key: 'stale', label: 'A request is waiting in the outbox.' };
      if (st.dead.length) return { key: 'ok', label: `The broken-template job is dead-lettered for a human, and the notification behind it was delivered once. ${st.stats.collapsed ? 'One push was collapsed on the phone.' : ''}` };
      if (st.stats.collapsed) return { key: 'ok', label: `The provider was called ${st.stats.providerCalls} times for one message; the collapse id meant Maya saw it once. At-least-once underneath, once on the lock screen.` };
      if (st.stats.dupSkipped) return { key: 'ok', label: 'A duplicate delivery was skipped by the dedupe store before any provider call. One push.' };
      return { key: 'ok', label: `One push, once, ${all[0] ? SDL.fmtMs(all[0].ms) : ''} after the team’s call.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const ui = sim.ui.phone;
      const shown = ui.pushes.length + ui.dismissed.length;
      return [
        { label: 'Requests stored', value: st.stats.requests, tone: st.stats.requests > 1 && Object.keys(st.jobs).length > 1 && Object.values(st.requests).every((r) => !r.poison) ? 'warn' : '' },
        { label: 'Provider calls', value: st.stats.providerCalls },
        { label: 'Pushes Maya saw', value: shown, tone: shown > Object.keys(st.requests).filter((n) => !st.requests[n].poison).length ? 'fail' : '' },
        { label: 'Collapsed on phone', value: st.stats.collapsed },
        { label: 'Skipped by dedupe', value: st.stats.dupSkipped },
        { label: 'Retries', value: st.stats.retries, tone: st.stats.retries ? 'warn' : '' },
        { label: 'Dead letters', value: st.dead.length, tone: st.dead.length ? 'warn' : '' },
        { label: 'Dedupe keys live', value: Object.keys(st.marks).filter((k) => sim.now - st.marks[k] <= DEDUPE_TTL).length },
        { label: 'Queue depth', value: sim.queueStats('sends').depth },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone']], {
          note: 'The console shows each job’s six stages and which worker ran them, the dedupe store with key ages, and the dead letters. The phone clears its lock screen a few seconds after a push.',
          side: `<p class="ops-title">Checkout team</p><div class="ops-traffic">
              ${Y.btn('send', 'Send “order shipped”', {})}
              ${Y.btn('send', 'Send with a broken template', { arg: { poison: true }, cls: 'secondary' })}
            </div><div data-ref="jobs"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const ui = sim.ui.phone;
        const card = (n, cls) => `<div class="app-card ${cls || ''}"><strong>${esc(n.title)}</strong><span class="app-sub">${esc(n.text)}</span><span class="app-sub">${SDL.fmtMs(n.ms)} after the call${n.replaced ? ` · replaced ${n.replaced}×` : ''}</span></div>`;
        const body = `<p class="app-sub">Lock screen (${ui.pushes.length})</p>${ui.pushes.map((n) => card(n, 'is-ok')).join('') || '<p class="app-sub">Nothing on the lock screen.</p>'}
          <p class="app-sub">Cleared earlier (${ui.dismissed.length})</p>${ui.dismissed.slice(0, 4).map((n) => card(n)).join('') || '<p class="app-sub">Nothing yet.</p>'}`;
        Y.paint(el, sim, 'phone', { head: '<div><p class="app-title">Notifications</p><p class="app-sub">Maya</p></div>', body }, {}, ui.banner);
        const c = sim.scenario.consistency(sim);
        const rows = Object.values(st.jobs).slice(-5).map((j) => {
          const stageIdx = STAGES.indexOf(j.stage);
          const chips = STAGES.map((s, i) => `<span class="kv-file ${i <= stageIdx ? 'has-key' : ''}">${s}</span>`).join('');
          const tone = j.stage === 'dead' ? 'fail' : j.stage === 'acked' ? 'ok' : 'warn';
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name">${j.key} · ${j.worker ? sim.nodes[j.worker].label : 'queued'} · ${j.deliveries} deliver${j.deliveries === 1 ? 'y' : 'ies'}<span>${j.stage === 'dead' ? 'dead-lettered' : j.stage === 'crashed' ? 'worker crashed, job will come back' : j.stage === 'retrying' ? 'retrying' : ''}</span></div><div class="kv-files">${chips}</div></div>`;
        }).join('');
        const marks = Object.entries(st.marks).map(([k, t]) => { const age = sim.now - t; return `<span class="kv-file ${age <= DEDUPE_TTL ? 'has-key' : ''}">${k} · ${age <= DEDUPE_TTL ? `${((DEDUPE_TTL - age) / 1000).toFixed(1)} s left` : 'expired'}</span>`; }).join('');
        SDL.ui.paintSections(el.querySelector('[data-ref="jobs"]'), {
          title: '<p class="ops-title">Jobs</p>',
          rows: `<div class="ops-shards">${rows || '<p class="app-sub">No jobs yet.</p>'}</div>`,
          marks: `<p class="ops-title">Dedupe store</p><div class="kv-files">${marks || '<span class="app-sub">Empty.</span>'}</div>`,
          dead: st.dead.length ? `<p class="ops-title">Dead letters</p><div class="kv-files">${st.dead.map((d) => `<span class="kv-file">${d.key} · ${esc(d.why)}</span>`).join('')}</div>` : '',
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
