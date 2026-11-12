/*
 * Sandbox scenario: a shared counter with a transactional outbox and a
 * read-model projector. It is deliberately generic so it can teach the
 * simulator controls and exercise every engine path before the topic labs.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;

  function* clientAdd(ctx, key, label) {
    const sim = ctx.sim;
    const ui = sim.ui;
    ui.inFlight++;
    ui.status = 'sending';
    ui.message = `Sending "${label}" with idempotency key ${key}.`;
    ctx.ledger('displayed', 'pending', 'Pessimistic UI: the total does not change until the server confirms.');
    ctx.ledger('retrySafe', 'yes', `Every attempt carries key ${key}, so the database applies it at most once.`);
    const t0 = ctx.now();
    const r = yield* ctx.retry({ attempts: 3, baseMs: 150 }, function* () {
      return yield ctx.call('gateway', 'add', { key, delta: 1 }, { timeout: 1200 });
    });
    ui.inFlight--;
    ctx.recordOutcome(r.ok, ctx.now() - t0);
    const st = sim.state;
    if (r.ok) {
      ui.status = 'saved';
      ui.message = r.value.replayed
        ? `Saved. The database recognised key ${key} and returned the original result instead of adding again.`
        : `Saved. The database total is ${r.value.total}.`;
      ctx.ledger('displayed', 'yes', 'Shows "Saved" because the server confirmed the commit.');
      ctx.ledger('accepted', 'yes', null, { ifPending: true });
      ctx.explain(
        st.read.total < st.db.total
          ? 'The write is durable in the database. The displayed total still lags, because the projector has not applied the event yet. This gap is eventual consistency.'
          : 'The write committed and the projector has already caught up, so the displayed total matches the database.'
      );
    } else if (r.error.code === 'TIMEOUT') {
      ui.status = 'unknown';
      ui.message = `No answer after ${r.attempts} attempts. The add may or may not have committed. Retrying is safe: key ${key} prevents a double add.`;
      ctx.ledger('displayed', 'unknown', 'Shows "Outcome unknown". The client cannot tell whether the commit happened.');
      ctx.ledger('accepted', 'no', null, { ifPending: true });
      ctx.ledger('committed', 'no', null, { ifPending: true });
      ctx.ledger('async', 'n/a', null, { ifPending: true });
      const committed = sim.ledgerEntry(ctx.actionId).layers.committed === 'yes';
      ctx.explain(
        committed
          ? 'The database did commit, but every reply was lost on the way back. The client sees a timeout, not a failure. Retry with the same key to learn the real outcome without adding twice.'
          : 'Nothing committed and the client cannot know that. It reports an unknown outcome rather than a failure, and keeps the key so a retry is safe.'
      );
    } else {
      ui.status = 'failed';
      ui.message = `Not saved: ${r.error.message} Nothing was committed, so you can try again.`;
      ctx.ledger('displayed', 'no', 'Shows "Not saved" with the reason.');
      ctx.ledger('accepted', 'no', null, { ifPending: true });
      ctx.ledger('committed', 'no', null, { ifPending: true });
      ctx.ledger('async', 'n/a', null, { ifPending: true });
      ctx.explain(
        `The request failed with ${r.error.code} after ${r.attempts} attempt${r.attempts > 1 ? 's' : ''}. Bounded retries stopped it from hammering a broken dependency. No data changed.`
      );
    }
    ui.last = { key, status: ui.status };
  }

  function startAdd(sim, opts) {
    opts = opts || {};
    const key = opts.key || 'tally-' + (++sim.state.keySeq);
    const label = opts.label || 'Add one';
    sim.startAction(label, (ctx) => clientAdd(ctx, key, label), {
      detail: `User pressed "${label}" (idempotency key ${key}).`,
    });
  }

  SDL.scenarios.sandbox = {
    id: 'sandbox',
    seed: 7,
    intro:
      'Press "Add one". The request travels to the database, an event leaves through the outbox, and the projector updates the total you see. Then inject a failure and press it again.',
    topology: {
      width: 1120,
      height: 430,
      nodes: [
        {
          id: 'client', label: 'Browser', sub: 'Team tally page', kind: 'client', x: 100, y: 95, latency: 1,
          role: 'Renders the tally, sends adds with an idempotency key, retries timeouts, and receives pushed totals.',
          ops: [{ name: 'push', desc: 'Receives the latest projected total.' }],
          owns: ['What the user sees'],
        },
        {
          id: 'gateway', label: 'API gateway', sub: 'Edge entry point', kind: 'gateway', x: 400, y: 95, latency: 6,
          role: 'Terminates client connections, checks the request has an idempotency key, and forwards it.',
          ops: [{ name: 'add', desc: 'Validate and forward to the counter service.' }],
          owns: ['Nothing durable'],
        },
        {
          id: 'api', label: 'Counter service', sub: 'Business logic', kind: 'service', x: 700, y: 95, latency: 10,
          role: 'Accepts add requests and writes them to the database in one transaction with an outbox row.',
          ops: [{ name: 'add', desc: 'Commit one increment, keyed by idempotency key.' }],
          owns: ['Write rules for the counter'],
        },
        {
          id: 'db', label: 'Counter database', sub: 'Source of truth', kind: 'db', x: 1010, y: 95, latency: 25,
          role: 'Stores the authoritative total, the idempotency keys already applied, and the outbox of unsent events.',
          ops: [
            { name: 'commit', desc: 'Increment, record the key, and append an outbox event atomically.' },
            { name: 'outbox tail', desc: 'Streams committed outbox events to the relay.' },
          ],
          owns: ['counter.total', 'idempotency_keys', 'outbox'],
        },
        {
          id: 'relay', label: 'Outbox relay', sub: 'Outbox to broker', kind: 'worker', x: 1010, y: 315, latency: 8,
          role: 'Reads committed outbox events and publishes them to the broker, retrying until the broker accepts.',
          ops: [{ name: 'publish loop', desc: 'Tail outbox, publish, then advance.' }],
          owns: ['Its read position in the outbox'],
        },
        {
          id: 'broker', label: 'Event broker', sub: 'counter-events', kind: 'queue', x: 700, y: 315, latency: 6, queue: 'events',
          role: 'Durably stores counter events in order and delivers them to consumer groups at least once.',
          ops: [{ name: 'publish', desc: 'Append an event to counter-events.' }],
          owns: ['counter-events log'],
        },
        {
          id: 'projector', label: 'Projector', sub: 'Consumer group', kind: 'worker', x: 400, y: 315, latency: 12,
          role: 'Consumes counter events, applies them to the read model, and pushes the new total to browsers.',
          ops: [{ name: 'consume', desc: 'Apply event, push total, acknowledge.' }],
          owns: ['Its consumer offset'],
        },
        {
          id: 'readdb', label: 'Read model', sub: 'Displayed total', kind: 'cache', x: 100, y: 315, latency: 5,
          role: 'Holds the total shown to users. It may lag the database and must ignore duplicate events.',
          ops: [{ name: 'apply', desc: 'Add the event delta unless this event was already applied.' }],
          owns: ['display.total', 'applied_event_ids'],
        },
      ],
      edges: [
        { from: 'client', to: 'gateway', latency: 40, label: 'HTTPS' },
        { from: 'gateway', to: 'api', latency: 10 },
        { from: 'api', to: 'db', latency: 12 },
        { from: 'db', to: 'relay', latency: 14, label: 'outbox tail' },
        { from: 'relay', to: 'broker', latency: 12 },
        { from: 'broker', to: 'projector', latency: 12 },
        { from: 'projector', to: 'readdb', latency: 8 },
        { from: 'projector', to: 'client', latency: 40, label: 'push' },
      ],
      queues: [
        { id: 'outbox', broker: 'db', label: 'outbox', groups: ['relay'] },
        { id: 'events', broker: 'broker', label: 'counter-events', groups: ['projector'] },
      ],
    },

    failures: [
      { id: 'api-down', node: 'api', mode: 'down', label: 'Counter service unavailable', desc: 'Connections are refused. The gateway gets an immediate error.' },
      { id: 'db-down', node: 'db', mode: 'down', label: 'Database unavailable', desc: 'Writes fail fast. Nothing commits and the outbox cannot be read.' },
      { id: 'db-slow', node: 'db', mode: 'slow', params: { factor: 30 }, label: 'Database very slow', desc: 'Each query takes 30 times longer, so callers start timing out.' },
      { id: 'db-drop', node: 'db', mode: 'dropResponse', label: 'Database replies lost', desc: 'Commits succeed but replies never arrive. Callers see timeouts.' },
      { id: 'broker-down', node: 'broker', mode: 'down', label: 'Broker unavailable', desc: 'The relay cannot publish. Events wait safely in the outbox.' },
      { id: 'broker-dup', node: 'broker', mode: 'duplicate', label: 'Broker duplicates events', desc: 'Every event is appended twice, as after a producer retry.' },
      { id: 'projector-paused', node: 'projector', mode: 'paused', label: 'Projector paused', desc: 'The consumer stops reading. Queue depth and lag grow.' },
    ],

    presets: [
      {
        id: 'healthy', label: 'Healthy add',
        desc: 'Restores everything, then sends one add along the green path.',
        run(sim) { sim.restoreAll(); startAdd(sim); },
      },
      {
        id: 'db-down', label: 'Database unavailable',
        desc: 'Three bounded attempts fail. The client shows "Not saved" and nothing commits.',
        run(sim) { sim.restoreAll(); sim.inject('db', 'down'); startAdd(sim); },
      },
      {
        id: 'lost-reply', label: 'Timeout after commit',
        desc: 'Replies are lost for 1.5 s. The first attempt commits; the third attempt, using the same key, gets the original result back.',
        run(sim) { sim.restoreAll(); sim.inject('db', 'dropResponse', true, 1500); startAdd(sim); },
      },
      {
        id: 'broker-down', label: 'Broker outage',
        desc: 'The add commits, but the displayed total stays stale until the broker returns after 3 s.',
        run(sim) { sim.restoreAll(); sim.inject('broker', 'down', true, 3000); startAdd(sim); },
      },
      {
        id: 'duplicate', label: 'Duplicate event',
        desc: 'The broker delivers the event twice. The projector skips the copy.',
        run(sim) { sim.restoreAll(); sim.do('setDedupe', { on: true }); sim.inject('broker', 'duplicate'); startAdd(sim); },
      },
      {
        id: 'no-dedupe', label: 'Duplicate without deduplication',
        desc: 'Same duplicate, but the projector does not check event IDs. The displayed total overcounts.',
        run(sim) { sim.restoreAll(); sim.do('setDedupe', { on: false }); sim.inject('broker', 'duplicate'); startAdd(sim); },
      },
      {
        id: 'lag', label: 'Consumer lag',
        desc: 'The projector pauses for 3 s while five adds commit. Depth grows, then drains.',
        run(sim) { sim.restoreAll(); sim.inject('projector', 'paused', true, 3000); sim.do('burst', {}); },
      },
    ],

    initialState: () => ({
      keySeq: 0,
      config: { dedupe: true },
      db: { total: 0, version: 0, keys: {} },
      read: { total: 0, applied: {} },
    }),
    initialUI: () => ({ displayed: 0, status: 'idle', message: 'Ready. Nothing has been sent yet.', inFlight: 0, last: null }),

    actions: {
      add(sim) { startAdd(sim); },
      burst(sim) {
        for (let i = 0; i < 5; i++) sim.schedule(i * 60, () => startAdd(sim, { label: `Add one (${i + 1} of 5)` }));
      },
      retryLast(sim) {
        const last = sim.ui.last;
        if (!last) return;
        startAdd(sim, { key: last.key, label: 'Retry with the same key' });
      },
      setDedupe(sim, args) {
        sim.state.config.dedupe = !!args.on;
        sim.note(args.on ? 'Projector now skips events it has already applied.' : 'Projector now applies every delivery, including duplicates.');
      },
    },

    handlers: {
      client: {
        push(ctx, p) {
          ctx.ui.displayed = p.total;
        },
      },
      gateway: {
        add: function* (ctx, p) {
          if (!p.key) ctx.fail('BAD_REQUEST', 'Missing idempotency key.');
          return ctx.must(yield ctx.call('api', 'add', p, { timeout: 900 }));
        },
      },
      api: {
        add: function* (ctx, p) {
          ctx.ledger('accepted', 'yes', 'The counter service accepted and validated the request.');
          return ctx.must(yield ctx.call('db', 'commit', p, { timeout: 600 }));
        },
      },
      db: {
        commit(ctx, p) {
          const db = ctx.state.db;
          if (db.keys[p.key]) return { total: db.keys[p.key].total, replayed: true };
          db.total += p.delta;
          db.version++;
          const eventId = 'evt-' + db.version;
          db.keys[p.key] = { total: db.total };
          ctx.sim.enqueue('outbox', {
            type: 'counter.incremented',
            eventId,
            payload: { eventId, delta: p.delta, key: p.key },
            actionId: ctx.actionId,
          });
          ctx.ledger('committed', 'yes', 'The increment and its outbox event committed in one transaction.');
          return { total: db.total, version: db.version };
        },
      },
      broker: {
        publish(ctx, p) {
          ctx.sim.enqueue('events', { type: 'counter.incremented', eventId: p.eventId, payload: p, actionId: ctx.actionId });
          return { accepted: true };
        },
      },
      readdb: {
        apply(ctx, p) {
          const r = ctx.state.read;
          if (ctx.state.config.dedupe && r.applied[p.eventId]) return { duplicate: true, total: r.total };
          const repeat = !!r.applied[p.eventId];
          r.applied[p.eventId] = true;
          r.total += p.delta;
          return { duplicate: false, repeatApplied: repeat, total: r.total };
        },
      },
    },

    setup(sim) {
      // Outbox relay: tails committed events and publishes until the broker accepts.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('outbox', 'relay');
          let backoff = 100;
          for (;;) {
            const r = yield ctx.call('broker', 'publish', msg.payload, { timeout: 500, actionId: msg.actionId });
            if (r.ok) break;
            ctx.sim.retries++;
            ctx.log({
              op: 'publish retry', status: 'retry', actionId: msg.actionId, error: r.error,
              detail: `The broker refused ${msg.eventId}. It stays in the outbox; retrying in ${backoff} ms. Nothing is lost.`,
            });
            ctx.explain('The add already committed, so the change is safe. The broker is down, so its event waits in the outbox and the relay keeps retrying. The displayed total is stale until the event gets through.');
            yield ctx.wait(backoff);
            backoff = Math.min(2000, backoff * 2);
          }
          ctx.ack('outbox', 'relay');
        }
      }, { self: 'relay' });

      // Projector: applies events to the read model and pushes the total.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('events', 'projector');
          const r = yield ctx.call('readdb', 'apply', msg.payload, { timeout: 500, actionId: msg.actionId });
          if (!r.ok) {
            ctx.nack('events', 'projector');
            yield ctx.wait(200);
            continue;
          }
          const st = ctx.state;
          if (r.value.duplicate) {
            ctx.log({ op: 'duplicate skipped', status: 'dup', actionId: msg.actionId, detail: `${msg.payload.eventId} was already applied, so the projector ignored this copy.` });
            ctx.explain('The broker delivered the same event twice. The projector remembers applied event IDs, so the copy changed nothing. At-least-once delivery plus an idempotent consumer gives a correct count.');
          } else if (r.value.repeatApplied) {
            ctx.log({ op: 'duplicate applied', status: 'err', actionId: msg.actionId, detail: `${msg.payload.eventId} was applied a second time. The read model now overcounts.` });
            ctx.explain(`Deduplication is off, so the duplicate was counted twice. The read model shows ${st.read.total} while the database holds ${st.db.total}. Replaying events cannot fix this without event IDs.`);
          } else {
            ctx.sim.setLedger(msg.actionId, 'async', 'yes', 'The read model and pushed total include this add.');
            if (st.read.total === st.db.total) ctx.explain(`The projector applied ${msg.payload.eventId}. The displayed total now matches the database.`);
            else ctx.explain(`The projector applied ${msg.payload.eventId}. It is still ${st.db.total - st.read.total} behind the database.`);
          }
          yield ctx.call('client', 'push', { total: r.value.total }, { timeout: 300, actionId: msg.actionId });
          ctx.ack('events', 'projector');
        }
      }, { self: 'projector' });
    },

    consistency(sim) {
      const d = sim.state.db.total;
      const r = sim.state.read.total;
      if (r === d) return { key: 'ok', label: `Consistent: displayed ${r}, database ${d}.` };
      if (r < d) return { key: 'stale', label: `Stale: displayed ${r}, database ${d}. ${d - r} change${d - r > 1 ? 's' : ''} not yet projected.` };
      return { key: 'wrong', label: `Incorrect: displayed ${r}, database ${d}. The read model double counted.` };
    },

    product: {
      mount(el, sim) {
        el.innerHTML = `
          <div class="mock mock-tally">
            <p class="mock-kicker">Team tally</p>
            <p class="tally-number" data-ref="displayed" aria-live="polite">0</p>
            <p class="tally-caption">Displayed total, from the read model</p>
            <div class="mock-actions">
              <button class="btn btn-primary" data-act="add">Add one</button>
              <button class="btn" data-act="burst">Add five quickly</button>
              <button class="btn" data-act="retryLast" aria-describedby="retry-hint">Retry with the same key</button>
            </div>
            <p class="mock-hint" id="retry-hint" data-ref="retryHint"></p>
            <p class="mock-status" data-ref="status" role="status"></p>
            <label class="check"><input type="checkbox" data-ref="dedupe" checked> Projector skips duplicate events</label>
            <dl class="mock-truth">
              <div><dt>Database total</dt><dd data-ref="dbtotal">0</dd></div>
              <div><dt>Requests in flight</dt><dd data-ref="inflight">0</dd></div>
            </dl>
            <p class="mock-footnote">The database total is shown for learning. A real user only sees the displayed total.</p>
          </div>`;
        el.querySelectorAll('[data-act]').forEach((b) =>
          b.addEventListener('click', () => sim.dispatch(b.dataset.act, {}))
        );
        el.querySelector('[data-ref="dedupe"]').addEventListener('change', (e) =>
          sim.dispatch('setDedupe', { on: e.target.checked })
        );
      },
      render(el, sim) {
        const ui = sim.ui;
        const q = (r) => el.querySelector(`[data-ref="${r}"]`);
        const num = q('displayed');
        if (num.textContent !== String(ui.displayed)) {
          num.textContent = ui.displayed;
          num.classList.remove('bump');
          void num.offsetWidth; // restart the animation
          num.classList.add('bump');
        }
        q('dbtotal').textContent = sim.state.db.total;
        q('inflight').textContent = ui.inFlight;
        const st = q('status');
        st.textContent = ui.message;
        st.dataset.tone = { saved: 'ok', failed: 'fail', unknown: 'warn', sending: 'work' }[ui.status] || '';
        q('dedupe').checked = sim.state.config.dedupe;
        const retry = el.querySelector('[data-act="retryLast"]');
        retry.disabled = !(ui.last && (ui.last.status === 'unknown' || ui.last.status === 'failed'));
        q('retryHint').textContent = retry.disabled
          ? 'Retry becomes available when an add fails or its outcome is unknown.'
          : `Retry re-sends key ${ui.last.key}. The database will not add twice.`;
      },
    },
  };

  SDL.scenarios.sandbox.startAdd = startAdd;
})(typeof window !== 'undefined' ? window : globalThis);
