/*
 * Deep dive: trip lifecycle and events.
 *
 * The trip service changes a trip with read → validate → conditional write.
 * With optimistic concurrency the write only succeeds if the version is
 * unchanged, so a simultaneous cancel and start cannot both win.
 * Events leave through a transactional outbox (or, with the switch off, a
 * dual write that can lose them). Consumers deduplicate by event ID, and the
 * rider app ignores updates older than what it already shows.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;

  const NEXT = {
    REQUESTED: ['ACCEPTED', 'CANCELLED'],
    ACCEPTED: ['ARRIVED', 'CANCELLED'],
    ARRIVED: ['IN_PROGRESS', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED'],
  };
  const STEPS = ['REQUESTED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'];
  const LABEL = { REQUESTED: 'Finding a driver', ACCEPTED: 'Driver on the way', ARRIVED: 'Driver has arrived', IN_PROGRESS: 'On trip', COMPLETED: 'Trip complete', CANCELLED: 'Cancelled' };
  const FARE = 14.2;
  const FEE = 5;
  const money = (v) => '$' + Number(v).toFixed(2);

  function view(sim, who) { return sim.ui[who]; }

  /** A rider or driver asks to move the trip to a new state, based on the version they last saw. */
  function startTransition(sim, who, to, label) {
    const v = view(sim, who);
    if (!v.trip) return;
    const expected = v.version;
    const trip = v.trip;
    sim.startAction(label, function* (ctx) {
      ctx.ledger('displayed', 'pending');
      ctx.ledger('retrySafe', 'yes', 'The same transition with the same expected version is idempotent; a stale one gets a conflict.');
      const r = yield ctx.call('gateway', 'transition', { trip, to, by: who, expectedVersion: expected }, { timeout: 1500 });
      const ui = view(ctx.sim, who);
      if (r.ok) {
        if (r.value.version > ui.version) Object.assign(ui, { status: r.value.status, version: r.value.version, fee: r.value.fee });
        ui.message = to === 'CANCELLED' ? (r.value.fee ? `Cancelled. A ${money(r.value.fee)} fee applies because the driver was already on the way.` : 'Cancelled at no charge.') : LABEL[to] + '.';
        ui.tone = 'ok';
        ctx.ledger('displayed', 'yes');
        ctx.ledger('accepted', 'yes');
        ctx.ledger('async', 'pending', 'Consumers (notifications, receipts, analytics) react to the event.');
      } else {
        ui.message = r.error.code === 'CONFLICT' ? `Couldn’t ${label.split(': ')[1]}: the trip changed a moment ago. Showing the latest state.` : `Couldn’t update the trip: ${r.error.message}`;
        ui.tone = 'fail';
        ctx.ledger('displayed', 'no', r.error.code === 'CONFLICT' ? 'Shows that someone else changed the trip first.' : 'Shows an error.');
        ctx.ledger('accepted', 'no', null, { ifPending: true });
        ctx.ledger('committed', 'no', null, { ifPending: true });
        ctx.ledger('async', 'n/a');
        if (r.error.code === 'CONFLICT') ctx.explain(`Optimistic concurrency: the ${who} asked for ${to} based on version ${expected}, but the trip had already moved on. The write was refused instead of silently overwriting the other change.`);
      }
    }, { self: who, detail: `${who === 'rider' ? 'Rider' : 'Driver'} asks for ${to} (based on version ${expected}).` });
  }

  function startRequest(sim) {
    sim.startAction('Rider: request ride', function* (ctx) {
      const ui = ctx.ui.rider;
      ctx.ledger('displayed', 'pending');
      ctx.ledger('retrySafe', 'yes');
      const r = yield ctx.call('gateway', 'create', { rider: 'Sam' }, { timeout: 1500 });
      if (r.ok) {
        Object.assign(ui, { trip: r.value.trip, status: 'REQUESTED', version: r.value.version, fee: 0, message: 'Finding your driver…', tone: 'work' });
        Object.assign(ctx.ui.driver, { trip: null, status: null, version: 0 });
        ctx.ledger('displayed', 'yes');
        ctx.ledger('accepted', 'yes');
        ctx.ledger('async', 'pending');
      } else {
        ui.message = `Couldn’t request: ${r.error.message}`;
        ui.tone = 'fail';
        ctx.ledger('displayed', 'no');
        ctx.ledger('accepted', 'no', null, { ifPending: true });
        ctx.ledger('committed', 'no', null, { ifPending: true });
        ctx.ledger('async', 'n/a');
      }
    }, { self: 'rider' });
  }

  const sc = (SDL.scenarios['rides-trips'] = {
    id: 'rides-trips',
    seed: 61,
    productWidth: 560,
    intro: 'Request a ride on the rider phone; a driver is matched automatically. Move the trip forward from the driver phone, or cancel from either phone, and watch every change leave through the outbox to three consumers.',
    topology: {
      width: 1160,
      height: 580,
      nodes: [
        { id: 'rider', label: 'Rider app', sub: 'Phone, left', kind: 'client', x: 100, y: 80, latency: 1, role: 'Requests and can cancel. Shows trip updates, ignoring any older than what it already shows (when ordering is on).', ops: [{ name: 'push', desc: 'Trip update.' }], owns: ['Last version seen'] },
        { id: 'driver', label: 'Driver app', sub: 'Phone, right', kind: 'client', x: 100, y: 480, latency: 1, role: 'Moves the trip forward or cancels it.', ops: [{ name: 'push', desc: 'Trip update.' }], owns: ['Last version seen'] },
        { id: 'gateway', label: 'API gateway', sub: 'HTTPS from both apps', kind: 'gateway', x: 330, y: 80, latency: 2, role: 'Routes trip commands from both phones.', ops: [{ name: 'create', desc: 'New trip.' }, { name: 'transition', desc: 'Change state.' }], owns: ['Nothing durable'] },
        { id: 'realtime', label: 'Realtime gateway', sub: 'Pushes to phones', kind: 'gateway', x: 330, y: 280, latency: 3, role: 'Delivers trip updates to both phones.', ops: [{ name: 'push', desc: 'Update out.' }], owns: ['Connections'] },
        { id: 'trip', label: 'Trip service', sub: 'State machine', kind: 'service', x: 560, y: 80, latency: 5, role: 'Reads the trip, checks the transition is allowed, and writes it back conditionally on the version it read.', ops: [{ name: 'create', desc: 'Insert a trip.' }, { name: 'transition', desc: 'Read, validate, conditional write.' }], owns: ['Trip rules', 'Cancellation fees'] },
        { id: 'tripdb', label: 'Trip database', sub: 'Trips and outbox', kind: 'db', x: 790, y: 80, latency: 10, role: 'Trips with a version number. Each change and its event are written in one transaction.', ops: [{ name: 'get', desc: 'Read a trip.' }, { name: 'write', desc: 'Conditional write plus outbox event.' }], owns: ['trips', 'outbox'] },
        { id: 'relay', label: 'Outbox relay', sub: 'Publishes events', kind: 'worker', x: 790, y: 280, latency: 4, role: 'Moves committed outbox events to the broker.', ops: [{ name: 'relay', desc: 'Outbox → broker.' }], owns: ['Outbox position'] },
        { id: 'events', label: 'Trip events', sub: 'Event broker', kind: 'queue', x: 1020, y: 280, latency: 4, queue: 'tripEvents', role: 'Fans each event out to three consumers, at least once.', ops: [{ name: 'publish', desc: 'Append an event.' }], owns: ['trip-events log'] },
        { id: 'notify', label: 'Notifications', sub: 'Pushes updates', kind: 'worker', x: 560, y: 480, latency: 4, role: 'Turns events into pushes for both phones.', ops: [{ name: 'consume', desc: 'Event → push.' }], owns: ['Processed event IDs'] },
        { id: 'receipts', label: 'Receipts', sub: 'Emails receipts', kind: 'worker', x: 790, y: 480, latency: 5, role: 'Emails a receipt for completed trips and cancellation fees. Must never send two.', ops: [{ name: 'consume', desc: 'Event → receipt.' }], owns: ['Receipts sent', 'Processed event IDs'] },
        { id: 'analytics', label: 'Analytics', sub: 'Counts trips', kind: 'worker', x: 1020, y: 480, latency: 4, role: 'Counts trips by outcome for dashboards.', ops: [{ name: 'consume', desc: 'Count the event.' }], owns: ['Counters', 'Processed event IDs'] },
      ],
      edges: [
        { from: 'rider', to: 'gateway', latency: 30 },
        { from: 'driver', to: 'gateway', latency: 30, via: [[230, 480], [230, 130]] },
        { from: 'rider', to: 'realtime', latency: 30 },
        { from: 'driver', to: 'realtime', latency: 30 },
        { from: 'gateway', to: 'trip', latency: 4 },
        { from: 'trip', to: 'tripdb', latency: 5 },
        { from: 'tripdb', to: 'relay', latency: 5, label: 'outbox' },
        { from: 'relay', to: 'events', latency: 5 },
        { from: 'trip', to: 'events', latency: 6, label: 'dual write' },
        { from: 'events', to: 'notify', latency: 5 },
        { from: 'events', to: 'receipts', latency: 5 },
        { from: 'events', to: 'analytics', latency: 5 },
        { from: 'notify', to: 'realtime', latency: 4 },
      ],
      queues: [
        { id: 'outbox', broker: 'tripdb', label: 'outbox', groups: ['relay'] },
        { id: 'tripEvents', broker: 'events', label: 'trip-events', groups: ['notify', 'receipts', 'analytics'] },
      ],
    },
    modeLabels: { reorder: 'Reordering pushes' },

    failures: [
      { id: 'db-down', node: 'tripdb', mode: 'down', label: 'Trip database down', desc: 'No trip can be created or changed. Both phones get clean errors.' },
      { id: 'relay-paused', node: 'relay', mode: 'paused', label: 'Outbox relay stalled', desc: 'Trips keep changing; their events wait in the outbox.' },
      { id: 'events-down', node: 'events', mode: 'down', label: 'Event broker down', desc: 'With the outbox, events wait. With a dual write, they are lost.' },
      { id: 'events-dup', node: 'events', mode: 'duplicate', label: 'Events delivered twice', desc: 'As after a relay crash between publishing and marking an event sent.' },
      { id: 'reorder', node: 'realtime', mode: 'reorder', label: 'Pushes arrive out of order', desc: 'Every other push to the rider is delayed, so an older update can arrive after a newer one.' },
      { id: 'receipts-paused', node: 'receipts', mode: 'paused', label: 'Receipts consumer paused', desc: 'Receipts lag; nothing else is affected.' },
    ],

    switches: [
      { id: 'occ', label: 'Optimistic concurrency (version check)', desc: 'Writes succeed only if the trip is still at the version that was read.', get: (s) => s.state.config.occ, set: (s, on) => { s.state.config.occ = on; } },
      { id: 'outbox', label: 'Transactional outbox', desc: 'Off: commit, then publish separately (a dual write). If the publish fails, the event is gone.', get: (s) => s.state.config.outbox, set: (s, on) => { s.state.config.outbox = on; } },
      { id: 'dedupe', label: 'Consumers deduplicate by event ID', desc: 'Off: a redelivered event sends a second receipt and double counts.', get: (s) => s.state.config.dedupe, set: (s, on) => { s.state.config.dedupe = on; } },
      { id: 'ordering', label: 'Phones ignore older versions', desc: 'Off: a late, older update moves the screen backwards.', get: (s) => s.state.config.ordering, set: (s, on) => { s.state.config.ordering = on; } },
    ],

    presets: (function () {
      const base = (sim, sw) => {
        sim.restoreAll();
        const def = { occ: true, outbox: true, dedupe: true, ordering: true };
        for (const [id, on] of Object.entries(Object.assign(def, sw || {}))) sim.do('setSwitch', { id, on });
        startRequest(sim);
      };
      const drive = (sim, steps) => steps.forEach(([t, who, to, label]) => sim.schedule(t, () => startTransition(sim, who, to, label)));
      const full = [[2200, 'driver', 'ARRIVED', 'Driver: arrived'], [3400, 'driver', 'IN_PROGRESS', 'Driver: start trip'], [4600, 'driver', 'COMPLETED', 'Driver: complete trip']];
      return [
        { id: 'happy', label: 'A complete trip', desc: 'Request, auto-match, arrive, start, complete. Each change produces one event, three consumers, one receipt.', run: (s) => { base(s); drive(s, full); } },
        { id: 'cancel-free', label: 'Rider cancels before a match', desc: 'Cancelled while still REQUESTED: no fee, no receipt needed.', run: (s) => { base(s); drive(s, [[400, 'rider', 'CANCELLED', 'Rider: cancel']]); } },
        { id: 'cancel-fee', label: 'Rider cancels after a match', desc: 'The driver is already on the way: a cancellation fee and a receipt.', run: (s) => { base(s); drive(s, [[2000, 'rider', 'CANCELLED', 'Rider: cancel']]); } },
        { id: 'race', label: 'Cancel and start at the same moment', desc: 'At the pickup, the rider cancels as the driver starts the trip. Optimistic concurrency lets exactly one win.', run: (s) => { base(s); drive(s, [[2200, 'driver', 'ARRIVED', 'Driver: arrived'], [3600, 'rider', 'CANCELLED', 'Rider: cancel'], [3600, 'driver', 'IN_PROGRESS', 'Driver: start trip']]); } },
        { id: 'race-bad', label: 'Same race, no version check', desc: 'Both read ARRIVED, both write. The trip ends up cancelled while the driver thinks it started: a lost update.', run: (s) => { base(s, { occ: false }); drive(s, [[2200, 'driver', 'ARRIVED', 'Driver: arrived'], [3600, 'rider', 'CANCELLED', 'Rider: cancel'], [3600, 'driver', 'IN_PROGRESS', 'Driver: start trip']]); } },
        { id: 'dups', label: 'Duplicate events, deduplicated', desc: 'Every event arrives twice. Consumers recognise the repeats: one receipt, correct counts.', run: (s) => { base(s); s.inject('events', 'duplicate'); drive(s, full); } },
        { id: 'dups-bad', label: 'Duplicate events, no deduplication', desc: 'The rider gets two receipts and analytics double counts.', run: (s) => { base(s, { dedupe: false }); s.inject('events', 'duplicate'); drive(s, full); } },
        { id: 'order', label: 'Out-of-order pushes, ordering on', desc: 'Late, older pushes are ignored by the phones.', run: (s) => { base(s); s.inject('realtime', 'reorder'); drive(s, full); } },
        { id: 'order-bad', label: 'Out-of-order pushes, ordering off', desc: 'A late “driver arrived” lands after “on trip” and the rider’s screen goes backwards.', run: (s) => { base(s, { ordering: false }); s.inject('realtime', 'reorder'); drive(s, full); } },
        { id: 'broker-outbox', label: 'Broker down, with outbox', desc: 'The trip completes; its events wait in the outbox and arrive once the broker returns.', run: (s) => { base(s); s.schedule(1500, () => s.inject('events', 'down', true, 4500)); drive(s, full); } },
        { id: 'broker-dual', label: 'Broker down, dual write', desc: 'The same outage without an outbox: the completion event is lost, so no receipt is ever sent.', run: (s) => { base(s, { outbox: false }); s.schedule(1500, () => s.inject('events', 'down', true, 4500)); drive(s, full); } },
      ];
    })(),

    initialState: () => ({
      config: { occ: true, outbox: true, dedupe: true, ordering: true },
      trips: {}, seq: { trip: 0, event: 0 },
      emitted: {}, lost: [],
      processed: { notify: {}, receipts: {}, analytics: {} },
      receipts: {}, counts: {}, dupSkipped: 0, staleIgnored: 0,
    }),
    initialUI: () => ({
      rider: { trip: null, status: null, version: 0, fee: 0, message: 'Tap “Request ride”.', tone: '', banner: null, regressions: 0 },
      driver: { trip: null, status: null, version: 0, message: 'Waiting for a trip.', tone: '', banner: null, regressions: 0 },
    }),

    actions: {
      request(sim) { startRequest(sim); },
      transition(sim, a) { startTransition(sim, a.who, a.to, a.label); },
    },

    handlers: {
      rider: { push: (ctx, p) => applyPush(ctx, 'rider', p) },
      driver: { push: (ctx, p) => applyPush(ctx, 'driver', p) },
      gateway: {
        create: function* (ctx, p) { return ctx.must(yield ctx.call('trip', 'create', p, { timeout: 1200 })); },
        transition: function* (ctx, p) { return ctx.must(yield ctx.call('trip', 'transition', p, { timeout: 1200 })); },
      },
      trip: {
        create: function* (ctx, p) {
          const st = ctx.state;
          const id = 'trip-' + (st.seq.trip + 1);
          const row = ctx.must(yield ctx.call('tripdb', 'insert', { id, rider: p.rider }, { timeout: 600 }));
          if (!st.config.outbox) yield* dualPublish(ctx, row, 'trip.requested');
          // Matching is covered in its own deep dive; here a driver is assigned after 0.9 s.
          ctx.spawn(function* (c) {
            yield c.wait(900);
            const r = yield* changeTrip(c, { trip: id, to: 'ACCEPTED', by: 'dispatch', expectedVersion: row.version });
            if (r.ok) c.log({ op: 'driver matched', status: 'ok', detail: `Priya was matched to ${id}.` });
          }, { self: 'trip' });
          return row;
        },
        transition: function* (ctx, p) {
          const r = yield* changeTrip(ctx, p);
          return ctx.must(r);
        },
      },
      tripdb: {
        insert(ctx, p) {
          const st = ctx.state;
          st.seq.trip++;
          const t = { id: p.id, rider: p.rider, status: 'REQUESTED', version: 1, fee: 0 };
          st.trips[p.id] = t;
          if (st.config.outbox) emit(ctx, t, 'trip.requested');
          ctx.ledger('committed', 'yes', 'The trip row and its outbox event committed together.');
          return Object.assign({ trip: t.id }, t);
        },
        get(ctx, p) {
          const t = ctx.state.trips[p.trip];
          if (!t) ctx.fail('NOT_FOUND', 'No such trip.');
          return Object.assign({}, t);
        },
        write(ctx, p) {
          const st = ctx.state;
          const t = st.trips[p.trip];
          if (st.config.occ && t.version !== p.readVersion) ctx.fail('CONFLICT', `Trip is at version ${t.version}, not ${p.readVersion}.`);
          t.status = p.to;
          t.version++;
          if (p.fee) t.fee = p.fee;
          if (st.config.outbox) emit(ctx, t, 'trip.' + p.to.toLowerCase());
          ctx.ledger('committed', 'yes', `Trip is now ${p.to} (version ${t.version}).`, { ifPending: true });
          return Object.assign({ trip: t.id }, t);
        },
      },
      events: {
        publish(ctx, p) { ctx.sim.enqueue('tripEvents', { type: p.type, eventId: p.eventId, payload: p, actionId: ctx.actionId }); return { appended: true }; },
      },
      realtime: {
        push: function* (ctx, p) {
          if (ctx.mode('reorder') && p.to === 'rider' && p.version % 2 === 0) yield ctx.wait(1400);
          return ctx.must(yield ctx.call(p.to, 'push', p, { timeout: 500 }));
        },
      },
    },

    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('outbox', 'relay');
          ctx.sim.enqueue('tripEvents', { type: msg.type, eventId: msg.eventId, payload: msg.payload, actionId: msg.actionId });
          ctx.ack('outbox', 'relay');
        }
      }, { self: 'relay' });
      let pushSeq = 0;
      consumer(sim, 'notify', function* (ctx, msg) {
        const p = msg.payload;
        for (const to of ['rider', 'driver']) {
          if (to === 'driver' && p.status === 'REQUESTED') continue;
          ctx.spawn(function* (c) { yield c.call('realtime', 'push', Object.assign({ to, seq: ++pushSeq }, p), { timeout: 2500 }); });
        }
      });
      consumer(sim, 'receipts', function* (ctx, msg) {
        const p = msg.payload;
        if (p.status === 'COMPLETED' || (p.status === 'CANCELLED' && p.fee)) {
          const st = ctx.state;
          st.receipts[p.trip] = (st.receipts[p.trip] || 0) + 1;
          ctx.log({ op: `receipt #${st.receipts[p.trip]} sent`, status: st.receipts[p.trip] > 1 ? 'err' : 'ok', actionId: msg.actionId, detail: st.receipts[p.trip] > 1 ? `A second receipt for ${p.trip} was emailed. The rider now thinks they paid twice.` : `Emailed a receipt for ${p.trip}: ${money(p.status === 'COMPLETED' ? FARE : p.fee)}.` });
        }
      });
      consumer(sim, 'analytics', function* (ctx, msg) {
        const st = ctx.state;
        st.counts[msg.payload.status] = (st.counts[msg.payload.status] || 0) + 1;
      });
    },

    consistency(sim) {
      const st = sim.state;
      for (const [id, evs] of Object.entries(st.emitted)) {
        if (evs.includes('trip.in_progress') && evs.includes('trip.cancelled')) return { key: 'wrong', label: `${id} was both started and cancelled. The driver is driving a trip the rider cancelled: a lost update.` };
      }
      const twice = Object.entries(st.receipts).find(([, n]) => n > 1);
      if (twice) return { key: 'wrong', label: `${twice[0]} produced ${twice[1]} receipts.` };
      if (st.lost.length) return { key: 'wrong', label: `${st.lost.length} event${st.lost.length > 1 ? 's were' : ' was'} lost by a dual write (${st.lost.join(', ')}). Consumers will never learn about ${st.lost.length > 1 ? 'them' : 'it'}.` };
      for (const who of ['rider', 'driver']) {
        const v = sim.ui[who];
        const t = v.trip && st.trips[v.trip];
        if (t && v.status !== t.status) return { key: 'stale', label: `The ${who} app shows ${v.status}; the database says ${t.status}.` };
      }
      const backlog = sim.queueStats('outbox').depth + sim.queueStats('tripEvents').depth;
      if (backlog) return { key: 'stale', label: `${backlog} event${backlog > 1 ? 's are' : ' is'} still waiting to be processed.` };
      return { key: 'ok', label: 'Database, both phones, receipts and analytics agree.' };
    },

    metrics(snap, sim) {
      const st = sim.state;
      const receipts = Object.values(st.receipts).reduce((a, b) => a + b, 0);
      return [
        { label: 'Events emitted', value: Object.values(st.emitted).reduce((a, e) => a + e.length, 0) },
        { label: 'Receipts sent', value: receipts, tone: Object.values(st.receipts).some((n) => n > 1) ? 'fail' : '' },
        { label: 'Duplicates skipped', value: st.dupSkipped },
        { label: 'Older updates ignored', value: st.staleIgnored },
        { label: 'Screens moved backwards', value: sim.ui.rider.regressions + sim.ui.driver.regressions, tone: sim.ui.rider.regressions + sim.ui.driver.regressions ? 'fail' : '' },
        { label: 'Events lost', value: st.lost.length, tone: st.lost.length ? 'fail' : '' },
      ];
    },

    product: {
      mount(el, sim) {
        const P = SDL.ui.phone;
        el.innerHTML = `
          <p class="panel-note phones-note">Both phones can change the trip. The bar under each phone shows what the three consumers have done.</p>
          <div class="phones">${P.frame('rider', 'Rider phone')}${P.frame('driver', 'Driver phone')}</div>
          <div class="consumer-strip" data-ref="consumers"></div>`;
        el.querySelectorAll('.phone').forEach((ph) => P.wire(ph));
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-act]');
          if (!b || b.disabled) return;
          sim.dispatch(b.dataset.act, b.dataset.arg ? JSON.parse(b.dataset.arg) : {});
        });
      },
      render(el, sim) {
        const P = SDL.ui.phone;
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const who of ['rider', 'driver']) {
          const v = sim.ui[who];
          const ph = el.querySelector(`[data-phone="${who}"]`);
          P.render(ph, sim, who, v.banner, false);
          const idx = STEPS.indexOf(v.status);
          let body = v.trip ? `<div class="app-steps" aria-label="Trip progress">${STEPS.map((s, i) => `<span class="${v.status === 'CANCELLED' ? '' : i < idx ? 'done' : i === idx ? 'now' : ''}"></span>`).join('')}</div>
            <div class="app-card ${v.status === 'CANCELLED' ? 'is-fail' : v.status === 'COMPLETED' ? 'is-ok' : 'is-work'}"><strong>${esc(LABEL[v.status] || 'Waiting')}</strong><span class="app-kv"><span>${esc(v.trip)}</span><span>version ${v.version}</span></span>${v.fee ? `<span class="app-kv"><span>Cancellation fee</span><span>${money(v.fee)}</span></span>` : ''}</div>` : '';
          const act = (to, label, cls) => `<button class="app-btn ${cls || ''}" data-act="transition" data-arg='${JSON.stringify({ who, to, label: `${who === 'rider' ? 'Rider' : 'Driver'}: ${label.toLowerCase()}` })}'>${label}</button>`;
          if (who === 'rider') {
            if (!v.trip || ['COMPLETED', 'CANCELLED'].includes(v.status)) body += '<button class="app-btn" data-act="request">Request ride</button>';
            else if (['REQUESTED', 'ACCEPTED', 'ARRIVED'].includes(v.status)) body += act('CANCELLED', 'Cancel ride', 'secondary');
          } else if (v.trip) {
            const next = { ACCEPTED: ['ARRIVED', 'Arrived'], ARRIVED: ['IN_PROGRESS', 'Start trip'], IN_PROGRESS: ['COMPLETED', 'Complete trip'] }[v.status];
            if (next) body += `<div class="app-row">${act(next[0], next[1], 'go')}${v.status !== 'IN_PROGRESS' ? act('CANCELLED', 'Cancel', 'secondary') : ''}</div>`;
          }
          body += `<p class="app-msg" data-tone="${v.tone}">${esc(v.message)}</p>`;
          P.paint(ph, { head: `<div><p class="app-title">${who === 'rider' ? 'RideNow' : 'RideNow Driver'}</p><p class="app-sub">${who === 'rider' ? 'Sam' : 'Priya, Blue Prius'}</p></div>`, body }, {});
        }
        const receipts = Object.values(st.receipts).reduce((a, b) => a + b, 0);
        const strip = `<span><b>Receipts</b> ${receipts}</span><span><b>Analytics</b> ${Object.entries(st.counts).map(([k, n]) => `${k.toLowerCase()} ${n}`).join(', ') || 'nothing yet'}</span><span><b>Duplicates skipped</b> ${st.dupSkipped}</span><span><b>Outbox</b> ${sim.queueStats('outbox').depth} waiting</span>`;
        SDL.ui.paintSections(el.querySelector('[data-ref="consumers"]'), { strip }, {});
      },
    },
  });

  /* ---------- helpers that need the scenario object ---------- */
  function emit(ctx, t, type) {
    const st = ctx.state;
    const eventId = 'evt-' + ++st.seq.event;
    (st.emitted[t.id] = st.emitted[t.id] || []).push(type);
    const payload = { eventId, trip: t.id, status: t.status, version: t.version, fee: t.fee };
    if (st.config.outbox) ctx.sim.enqueue('outbox', { type, eventId, payload, actionId: ctx.actionId });
    return payload;
  }
  function* dualPublish(ctx, row, type) {
    const st = ctx.state;
    const eventId = 'evt-' + ++st.seq.event;
    (st.emitted[row.trip || row.id] = st.emitted[row.trip || row.id] || []).push(type);
    const payload = { eventId, type, trip: row.trip || row.id, status: row.status, version: row.version, fee: row.fee };
    const r = yield ctx.call('events', 'publish', payload, { timeout: 400 });
    if (!r.ok) {
      st.lost.push(`${type} for ${payload.trip}`);
      ctx.log({ op: `${type} lost`, status: 'err', error: r.error, detail: 'The trip change committed, but publishing its event failed and there is no outbox to retry from. The event is gone.' });
      ctx.explain('Dual write: the database commit succeeded, then the separate publish to the broker failed. Nothing records that the event still needs sending, so consumers never hear about it. A transactional outbox writes the event in the same transaction as the trip change, so it can always be retried.');
    }
  }
  /** Read, validate, conditional write. Without OCC the write ignores the version it read. */
  function* changeTrip(ctx, p) {
    const st = ctx.state;
    const g = yield ctx.call('tripdb', 'get', { trip: p.trip }, { timeout: 500 });
    if (!g.ok) return g;
    const t = g.value;
    if (st.config.occ && p.expectedVersion != null && t.version !== p.expectedVersion) return { ok: false, error: { code: 'CONFLICT', message: `The trip is at version ${t.version}; you saw ${p.expectedVersion}.` } };
    if (!(NEXT[t.status] || []).includes(p.to)) return { ok: false, error: { code: t.status === p.to ? 'ALREADY_DONE' : 'INVALID_TRANSITION', message: `A trip cannot go from ${t.status} to ${p.to}.` } };
    const fee = p.to === 'CANCELLED' && p.by === 'rider' && t.status !== 'REQUESTED' ? FEE : 0;
    yield ctx.wait(60); // validation and fee calculation take a moment: the race window
    const w = yield ctx.call('tripdb', 'write', { trip: p.trip, to: p.to, readVersion: t.version, fee }, { timeout: 500 });
    if (w.ok && !st.config.outbox) yield* dualPublish(ctx, w.value, 'trip.' + p.to.toLowerCase());
    return w;
  }
  function consumer(sim, name, handle) {
    sim.spawn(function* (ctx) {
      for (;;) {
        const { msg } = yield ctx.take('tripEvents', name);
        const st = ctx.state;
        if (st.config.dedupe && st.processed[name][msg.eventId]) {
          st.dupSkipped++;
          ctx.log({ op: `duplicate ${msg.eventId} skipped`, status: 'dup', actionId: msg.actionId, detail: `${sim.nodes[name].label} has already processed ${msg.eventId}.` });
          ctx.ack('tripEvents', name);
          continue;
        }
        st.processed[name][msg.eventId] = true;
        yield* handle(ctx, msg);
        ctx.ack('tripEvents', name);
      }
    }, { self: name });
  }
  function applyPush(ctx, who, p) {
    const st = ctx.state;
    const v = ctx.ui[who];
    if (!v.trip && who === 'driver' && p.status === 'ACCEPTED') Object.assign(v, { trip: p.trip, status: null, version: 0 });
    if (p.trip !== v.trip) return { ignored: 'other trip' };
    if (p.version <= v.version) {
      if (st.config.ordering) { st.staleIgnored++; return { ignored: 'older' }; }
      if (p.version < v.version) {
        v.regressions++;
        ctx.log({ op: `${who} screen went backwards`, status: 'err', detail: `An older update (version ${p.version}, ${p.status}) arrived after version ${v.version} and replaced it.` });
        ctx.explain(`Pushes arrived out of order and the ${who} app applied an older one, so the screen jumped back to “${LABEL[p.status]}”. Comparing version numbers before applying an update prevents this.`);
      }
    }
    Object.assign(v, { status: p.status, version: p.version, fee: p.fee || v.fee });
    v.banner = { title: LABEL[p.status], body: `${p.trip}, version ${p.version}`, tone: p.status === 'CANCELLED' ? 'fail' : 'ok', t: ctx.now() };
    if (p.status !== 'CANCELLED' || !v.message.startsWith('Cancelled')) { v.message = LABEL[p.status] + '.'; v.tone = p.status === 'CANCELLED' ? 'fail' : 'ok'; }
    return { shown: p.status };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
