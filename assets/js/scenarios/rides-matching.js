/*
 * Deep dive: matching and dispatch.
 *
 * Greedy: each request takes the best available driver the moment it arrives.
 * Batched: requests wait up to 1 s, then one assignment minimises total pickup
 * time across the whole batch (exhaustive search; batches here are small).
 *
 * Also modelled: compare-and-set reservations, offers that drivers accept or
 * decline, offer storms at low acceptance, fairness weighting by trips today,
 * and falling back to greedy when the batch matcher stalls.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;

  const DRIVERS0 = {
    D1: { x: 1, y: 1, trips: 4 }, D2: { x: 6, y: 1, trips: 0 }, D3: { x: 3, y: 3, trips: 6 },
    D4: { x: 7, y: 4, trips: 1 }, D5: { x: 1, y: 5, trips: 2 }, D6: { x: 5, y: 5, trips: 3 },
  };
  const WAVES = [
    [{ x: 4, y: 2 }, { x: 2, y: 3 }, { x: 6, y: 4 }, { x: 1, y: 4 }],
    [{ x: 5, y: 1 }, { x: 3, y: 4 }, { x: 7, y: 2 }, { x: 0, y: 2 }],
    [{ x: 2, y: 1 }, { x: 6, y: 5 }, { x: 4, y: 4 }, { x: 1, y: 3 }],
  ];
  const BATCH_MS = 1000;
  const OFFER_MS = 2500;
  const BUSY_MS = 4000;
  const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  // A river runs between columns 3 and 4; the only bridge is on row 3.
  const BRIDGE_Y = 3;
  const westOf = (p) => p.x <= 3;
  const roadDist = (a, b) => (westOf(a) === westOf(b) ? dist(a, b) : Math.abs(a.x - b.x) + Math.abs(a.y - BRIDGE_Y) + Math.abs(b.y - BRIDGE_Y));
  const trueEta = (a, b) => roadDist(a, b) * 2 + 1;

  function cost(st, rider, driverId) {
    const d = st.drivers[driverId];
    return trueEta(rider, d) + (st.config.fairness ? d.trips * 3 : 0);
  }
  /** Minimum total cost assignment of riders to distinct drivers (exhaustive; n ≤ 6). */
  function bestAssignment(st, riders, drivers) {
    let best = null;
    const used = new Set();
    const pick = [];
    const rec = (i, total) => {
      if (best && total >= best.total) return;
      if (i === riders.length) { best = { total, pick: pick.slice() }; return; }
      let any = false;
      for (const d of drivers) {
        if (used.has(d)) continue;
        any = true;
        used.add(d); pick.push(d);
        rec(i + 1, total + cost(st, st.riders[riders[i]], d));
        used.delete(d); pick.pop();
      }
      if (!any) { pick.push(null); rec(i + 1, total + 100); pick.pop(); }
    };
    rec(0, 0);
    return best ? riders.map((r, i) => [r, best.pick[i]]) : [];
  }

  /** Reserve, offer, wait for an answer, assign. Returns true when matched. */
  function* offerAndAssign(ctx, riderId, driverId) {
    const st = ctx.state;
    const res = yield ctx.call('driverstate', 'reserve', { driver: driverId, rider: riderId }, { timeout: 500 });
    if (!res.ok || !res.value.reserved) {
      if (res.ok) ctx.log({ op: `${driverId} unavailable`, status: 'note', detail: `${driverId} is ${res.value.reason}; compare-and-set refused the reservation for ${riderId}.` });
      return false;
    }
    const offerId = 'o' + ++st.seq.offer;
    st.offers[offerId] = { id: offerId, rider: riderId, driver: driverId, status: 'pending', expires: ctx.now() + OFFER_MS };
    st.riders[riderId].offeredTo = driverId;
    st.stats.offers++;
    const o = yield ctx.call('offers', 'send', { offerId, driver: driverId, rider: riderId }, { timeout: 800 });
    if (!o.ok) {
      st.offers[offerId].status = 'undeliverable';
      yield ctx.call('driverstate', 'release', { driver: driverId, rider: riderId }, { timeout: 500 });
      st.riders[riderId].offeredTo = null;
      return false;
    }
    while (st.offers[offerId].status === 'pending' && ctx.now() < st.offers[offerId].expires) yield ctx.wait(100);
    const status = st.offers[offerId].status === 'pending' ? 'expired' : st.offers[offerId].status;
    st.offers[offerId].status = status;
    st.riders[riderId].offeredTo = null;
    if (status !== 'accepted') {
      st.stats.declines++;
      ctx.log({ op: `${driverId} ${status}`, status: 'retry', detail: `${driverId} ${status === 'declined' ? 'declined' : 'did not answer'} the offer for ${riderId}. Releasing and trying again.` });
      yield ctx.call('driverstate', 'release', { driver: driverId, rider: riderId }, { timeout: 500 });
      return false;
    }
    const a = yield ctx.call('driverstate', 'assign', { driver: driverId, rider: riderId }, { timeout: 500 });
    if (!a.ok) { ctx.log({ op: 'assignment conflict', status: 'err', error: a.error, detail: `${driverId} accepted, but the reservation was no longer valid.` }); return false; }
    const r = st.riders[riderId];
    Object.assign(r, { status: 'matched', driver: driverId, matchedAt: ctx.now(), eta: trueEta(r, st.drivers[driverId]) });
    ctx.sim.setLedger(r.actionId, 'async', st.ridersOf(r.actionId).every((x) => st.riders[x].status === 'matched') ? 'yes' : 'pending', 'Every rider in this wave has a driver.');
    const sim = ctx.sim;
    sim.schedule(BUSY_MS, () => {
      const d = st.drivers[driverId];
      Object.assign(d, { status: 'available', x: r.x, y: r.y, rider: null, version: d.version + 1 });
      d.trips++;
    });
    return true;
  }

  function* greedyMatch(ctx, riderId) {
    const st = ctx.state;
    for (let attempt = 0; attempt < 6; attempt++) {
      const n = ctx.must(yield ctx.call('geoindex', 'available', {}, { timeout: 600 }));
      if (!n.drivers.length) { yield ctx.wait(400); continue; }
      let ranked;
      const r = yield ctx.call('eta', 'rank', { rider: riderId, drivers: n.drivers }, { timeout: 500 });
      if (r.ok) ranked = r.value;
      else {
        ranked = n.drivers.slice().sort((a, b) => dist(st.riders[riderId], st.drivers[a]) - dist(st.riders[riderId], st.drivers[b]) || (a < b ? -1 : 1));
        ctx.log({ op: 'ETA fallback', status: 'note', detail: 'The ETA service timed out; ranking by straight-line distance instead. That ignores the river, so a driver “close” across the water may be far by road.' });
      }
      const tried = st.riders[riderId].tried;
      const pick = ranked.find((d) => !tried.includes(d));
      if (!pick) { tried.length = 0; yield ctx.wait(300); continue; }
      tried.push(pick);
      if (yield* offerAndAssign(ctx, riderId, pick)) return true;
    }
    st.riders[riderId].status = 'unmatched';
    return false;
  }

  function startWave(sim, size) {
    const st = sim.state;
    const w = WAVES[st.wave % WAVES.length].slice(0, size || 4);
    st.wave++;
    const ids = w.map(() => 'R' + ++st.seq.rider);
    sim.startAction(`Wave ${st.wave}: ${ids.length} riders request`, function* (ctx) {
      ctx.ledger('displayed', 'yes', 'Each rider sees “Finding your driver”.');
      ctx.ledger('retrySafe', 'yes', 'Requests carry idempotency keys (see the trip lifecycle deep dive).');
      const procs = [];
      for (let i = 0; i < w.length; i++) {
        if (i) yield ctx.wait(150);
        const id = ids[i];
        st.riders[id] = { id, x: w[i].x, y: w[i].y, status: 'waiting', requestedAt: ctx.now(), tried: [], actionId: ctx.actionId };
        procs.push(ctx.spawn(function* (c) { return yield c.call('gateway', 'request', { rider: id }, { timeout: 1500 }); }));
      }
      const rs = yield ctx.join(procs);
      const ok = rs.filter((x) => x.ok && x.value.ok).length;
      ctx.ledger('accepted', ok === w.length ? 'yes' : 'no', `${ok} of ${w.length} requests accepted.`);
      ctx.ledger('committed', ok ? 'yes' : 'no', 'Trips recorded; matching continues in the background.');
      ctx.explain(st.config.batched
        ? `${w.length} riders arrived within ${150 * (w.length - 1)} ms. The batch matcher waits up to ${BATCH_MS / 1000} s, then assigns drivers to minimise the batch’s total pickup time.`
        : `${w.length} riders arrived ${150} ms apart. Greedy matching gives each one the best driver available at that instant, even if that driver would serve a later rider much better.`);
    }, { self: 'riders', detail: `A wave of ${w.length} riders requests rides across the city.` });
    sim.state.waveRiders[sim.ledger[sim.ledger.length - 1].id] = ids;
  }

  const sc = (SDL.scenarios['rides-matching'] = {
    id: 'rides-matching',
    seed: 53,
    productWidth: 600,
    intro: 'Send a wave of riders and watch the board: dashed lines are offers, solid lines are matches. Then switch to batched matching and send the next wave to compare total pickup time.',
    topology: {
      width: 1100,
      height: 560,
      nodes: [
        { id: 'riders', label: 'Rider apps', sub: 'Request rides', kind: 'client', x: 100, y: 90, latency: 1, role: 'Riders requesting rides from the board.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Rider traffic', kind: 'gateway', x: 320, y: 90, latency: 2, role: 'Routes ride requests.', ops: [{ name: 'request', desc: 'Forward to trips.' }], owns: ['Nothing durable'] },
        { id: 'trip', label: 'Trip service', sub: 'Creates trips', kind: 'service', x: 540, y: 90, latency: 5, role: 'Records the request, then hands it to the dispatcher.', ops: [{ name: 'create', desc: 'New trip, then dispatch.' }], owns: ['trips'] },
        { id: 'batcher', label: 'Batch matcher', sub: 'Every 1 s', kind: 'worker', x: 760, y: 90, latency: 6, role: 'Collects requests for up to one second, then solves one assignment that minimises total pickup time.', ops: [{ name: 'tick', desc: 'Assign the current batch.' }], owns: ['Pending batch'] },
        { id: 'eta', label: 'ETA service', sub: 'Pickup times', kind: 'service', x: 980, y: 90, latency: 6, role: 'Pickup time from each driver to each rider.', ops: [{ name: 'rank', desc: 'Drivers for one rider, best first.' }, { name: 'matrix', desc: 'Every rider × driver pair.' }], owns: ['Road graph'] },
        { id: 'geoindex', label: 'Geo index', sub: 'Available drivers', kind: 'cache', x: 320, y: 280, latency: 3, role: 'Which drivers are available and where.', ops: [{ name: 'available', desc: 'Available drivers.' }], owns: ['Driver positions'] },
        { id: 'dispatch', label: 'Dispatcher', sub: 'Greedy path', kind: 'service', x: 540, y: 280, latency: 4, role: 'In greedy mode, matches each request immediately. In batched mode, queues it for the batch matcher.', ops: [{ name: 'match', desc: 'Match one request.' }], owns: ['Open offers'] },
        { id: 'driverstate', label: 'Driver state', sub: 'Compare-and-set', kind: 'db', x: 760, y: 280, latency: 4, role: 'Driver availability with versions. A reservation succeeds only if the driver is still available.', ops: [{ name: 'reserve', desc: 'available → offered.' }, { name: 'assign', desc: 'offered → on trip.' }, { name: 'release', desc: 'offered → available.' }], owns: ['driver_status'] },
        { id: 'drivers', label: 'Driver apps', sub: 'Accept or decline', kind: 'client', x: 100, y: 470, latency: 1, role: 'Each driver accepts or declines an offer within about a second.', ops: [{ name: 'offer', desc: 'Show an offer.' }], owns: ['Their decision'] },
        { id: 'realtime', label: 'Realtime gateway', sub: 'Offers out', kind: 'gateway', x: 320, y: 470, latency: 3, role: 'Delivers offers to driver phones.', ops: [{ name: 'offer', desc: 'Push an offer.' }], owns: ['Connections'] },
        { id: 'offers', label: 'Offer service', sub: 'Tracks offers', kind: 'service', x: 540, y: 470, latency: 3, role: 'Sends offers with a deadline and records answers.', ops: [{ name: 'send', desc: 'Send one offer.' }], owns: ['Offer deadlines'] },
      ],
      edges: [
        { from: 'riders', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'trip', latency: 4 },
        { from: 'trip', to: 'dispatch', latency: 4 },
        { from: 'dispatch', to: 'geoindex', latency: 3 },
        { from: 'dispatch', to: 'eta', latency: 4 },
        { from: 'dispatch', to: 'driverstate', latency: 3 },
        { from: 'dispatch', to: 'batcher', latency: 4, label: 'batched' },
        { from: 'batcher', to: 'eta', latency: 4 },
        { from: 'batcher', to: 'driverstate', latency: 3 },
        { from: 'batcher', to: 'geoindex', latency: 4, via: [[760, 185], [320, 185]] },
        { from: 'dispatch', to: 'offers', latency: 3 },
        { from: 'batcher', to: 'offers', latency: 4 },
        { from: 'offers', to: 'realtime', latency: 3 },
        { from: 'realtime', to: 'drivers', latency: 30 },
      ],
    },

    failures: [
      { id: 'eta-slow', node: 'eta', mode: 'slow', params: { factor: 120 }, label: 'ETA service slow', desc: 'Ranking falls back to straight-line distance, which ignores roads.' },
      { id: 'batcher-paused', node: 'batcher', mode: 'paused', label: 'Batch matcher stalled', desc: 'Batched requests wait; the dispatcher can fall back to greedy.' },
      { id: 'offers-down', node: 'offers', mode: 'down', label: 'Offer service down', desc: 'Offers cannot reach drivers. Requests keep retrying.' },
      { id: 'geo-down', node: 'geoindex', mode: 'down', label: 'Geo index down', desc: 'No candidates at all; matching stops.' },
      { id: 'realtime-down', node: 'realtime', mode: 'down', label: 'Realtime gateway down', desc: 'Driver phones are unreachable.' },
    ],

    switches: [
      { id: 'batched', label: 'Batched matching', desc: `Wait up to ${BATCH_MS / 1000} s and optimise the whole batch. Off: greedy, one request at a time.`, get: (s) => s.state.config.batched, set: (s, on) => { s.state.config.batched = on; } },
      { id: 'cas', label: 'Atomic reservations (compare-and-set)', desc: 'Off: two requests can reserve the same driver.', get: (s) => s.state.config.cas, set: (s, on) => { s.state.config.cas = on; } },
      { id: 'fairness', label: 'Fairness: prefer drivers with fewer trips', desc: 'Adds 3 min per trip already done today. Spreads earnings, at the cost of longer pickups.', get: (s) => s.state.config.fairness, set: (s, on) => { s.state.config.fairness = on; } },
      { id: 'fallback', label: 'Fall back to greedy if batching stalls', desc: 'Requests waiting over 2.5 s are matched greedily.', get: (s) => s.state.config.fallback, set: (s, on) => { s.state.config.fallback = on; } },
    ],

    presets: (function () {
      const base = (sim, sw, accept) => {
        sim.restoreAll();
        const def = { batched: false, cas: true, fairness: false, fallback: true };
        for (const [id, on] of Object.entries(Object.assign(def, sw || {}))) sim.do('setSwitch', { id, on });
        sim.do('setAcceptance', { rate: accept || 1 });
      };
      return [
        { id: 'greedy', label: 'Greedy wave', desc: 'Four riders, 150 ms apart. Each takes the nearest driver at that moment.', run: (s) => { base(s); startWave(s); } },
        { id: 'batched', label: 'Batched wave', desc: 'The same four riders, matched together. Total pickup time drops; each waits up to 1 s longer.', run: (s) => { base(s, { batched: true }); startWave(s); } },
        { id: 'storm', label: 'Low acceptance (offer storm)', desc: 'Drivers accept only 40% of offers. Watch offers per match climb and wait times stretch.', run: (s) => { base(s, {}, 0.4); startWave(s); } },
        { id: 'no-cas', label: 'Double dispatch without compare-and-set', desc: 'Two simultaneous requests both reserve the same driver.', run: (s) => { base(s, { cas: false }); s.do('pair', {}); } },
        { id: 'cas', label: 'Same race, with compare-and-set', desc: 'Only one reservation succeeds; the other rider moves on.', run: (s) => { base(s); s.do('pair', {}); } },
        { id: 'fair', label: 'Small waves with fairness', desc: 'Three waves of two riders. Drivers with fewer trips today get priority: more trips go to the least-busy drivers, but total pickup time rises. Fairness has a price.', run: (s) => { base(s, { batched: true, fairness: true }); startWave(s, 2); s.schedule(5200, () => startWave(s, 2)); s.schedule(10400, () => startWave(s, 2)); } },
        { id: 'unfair', label: 'Small waves without fairness', desc: 'The same waves matched on pickup time alone. The busiest drivers stay busiest.', run: (s) => { base(s, { batched: true }); startWave(s, 2); s.schedule(5200, () => startWave(s, 2)); s.schedule(10400, () => startWave(s, 2)); } },
        { id: 'stall', label: 'Batch matcher stalls', desc: 'Batched requests wait 2.5 s, then the dispatcher falls back to greedy and matches them.', run: (s) => { base(s, { batched: true }); s.inject('batcher', 'paused'); startWave(s); } },
        { id: 'eta-ok', label: 'Road-aware ETA', desc: 'A rider just east of the river. The ETA service knows D3 can cross at the bridge in 9 min.', run: (s) => { base(s); s.do('single', { x: 4, y: 0, busy: ['D2'] }); } },
        { id: 'eta-slow', label: 'ETA slow: straight-line fallback', desc: 'Same rider, but ranking falls back to straight-line distance. D1 looks as close as D3, but it is 15 min away by road.', run: (s) => { base(s); s.inject('eta', 'slow', { factor: 120 }); s.do('single', { x: 4, y: 0, busy: ['D2'] }); } },
      ];
    })(),

    initialState: () => {
      const drivers = {};
      for (const [id, d] of Object.entries(DRIVERS0)) drivers[id] = Object.assign({ status: 'available', version: 1, rider: null }, d);
      const st = {
        config: { batched: false, cas: true, fairness: false, fallback: true },
        acceptRate: 1,
        drivers, riders: {}, offers: {}, pending: [], wave: 0, waveRiders: {},
        seq: { rider: 0, offer: 0 },
        stats: { offers: 0, declines: 0, doubleBooked: 0 },
      };
      Object.defineProperty(st, 'ridersOf', { enumerable: false, value: (aid) => st.waveRiders[aid] || [] });
      return st;
    },
    initialUI: () => ({}),

    actions: {
      wave(sim, a) { startWave(sim, a && a.size); },
      single(sim, a) {
        const st = sim.state;
        for (const id of a.busy || []) st.drivers[id].status = 'busy';
        const id = 'R' + ++st.seq.rider;
        sim.startAction(`${id} requests a ride`, function* (ctx) {
          ctx.ledger('displayed', 'yes');
          st.riders[id] = { id, x: a.x, y: a.y, status: 'waiting', requestedAt: ctx.now(), tried: [], actionId: ctx.actionId };
          const r = yield ctx.call('gateway', 'request', { rider: id }, { timeout: 1500 });
          ctx.ledger('accepted', r.ok ? 'yes' : 'no');
          ctx.ledger('committed', r.ok ? 'yes' : 'no');
          ctx.ledger('retrySafe', 'yes');
        }, { self: 'riders' });
        st.waveRiders[sim.ledger[sim.ledger.length - 1].id] = [id];
      },
      setAcceptance(sim, a) { sim.state.acceptRate = a.rate; sim.note(`Drivers now accept about ${Math.round(a.rate * 100)}% of offers.`); },
      pair(sim) {
        // Two riders at the same corner, one free driver nearby.
        const st = sim.state;
        for (const id of Object.keys(st.drivers)) if (id !== 'D3') st.drivers[id].status = 'busy';
        const ids = ['R' + ++st.seq.rider, 'R' + ++st.seq.rider];
        sim.startAction('Two riders request at once', function* (ctx) {
          ctx.ledger('displayed', 'yes');
          for (const id of ids) st.riders[id] = { id, x: 3, y: 2, status: 'waiting', requestedAt: ctx.now(), tried: [], actionId: ctx.actionId };
          const ps = ids.map((id) => ctx.spawn(function* (c) { return yield c.call('gateway', 'request', { rider: id }, { timeout: 1500 }); }));
          yield ctx.join(ps);
          ctx.ledger('accepted', 'yes');
          ctx.ledger('committed', 'yes');
          ctx.ledger('retrySafe', 'yes');
        }, { self: 'riders', detail: 'Two riders at the same corner request in the same instant. Only D3 is free.' });
        st.waveRiders[sim.ledger[sim.ledger.length - 1].id] = ids;
      },
    },

    handlers: {
      gateway: { request: function* (ctx, p) { return ctx.must(yield ctx.call('trip', 'create', p, { timeout: 1200 })); } },
      trip: {
        create(ctx, p) {
          ctx.spawn(function* (c) {
            yield c.call('dispatch', 'match', p, { timeout: 30000, quiet: true });
          });
          return { ok: true, rider: p.rider };
        },
      },
      dispatch: {
        match: function* (ctx, p) {
          const st = ctx.state;
          if (st.config.batched) {
            st.pending.push(p.rider);
            ctx.must(yield ctx.call('batcher', 'enqueue', p, { timeout: 500 }));
            // Fallback: if the batcher has not matched this rider in 2.5 s, match greedily.
            const t0 = ctx.now();
            while (st.riders[p.rider].status === 'waiting' && ctx.now() - t0 < 2500) yield ctx.wait(100);
            if (st.riders[p.rider].status === 'waiting' && st.config.fallback && st.pending.includes(p.rider)) {
              st.pending = st.pending.filter((r) => r !== p.rider);
              ctx.log({ op: `fallback for ${p.rider}`, status: 'retry', detail: `${p.rider} waited 2.5 s without a batch result. The dispatcher matches it greedily instead of leaving the rider stranded.` });
              ctx.explain('The batch matcher stalled. Without a fallback, every batched request would wait indefinitely; with one, riders get a slightly worse but immediate greedy match.');
              return yield* greedyMatch(ctx, p.rider);
            }
            return true;
          }
          return yield* greedyMatch(ctx, p.rider);
        },
      },
      batcher: { enqueue(ctx, p) { return { queued: p.rider }; } },
      geoindex: {
        available(ctx) { return { drivers: Object.entries(ctx.state.drivers).filter(([, d]) => d.status === 'available').map(([id]) => id) }; },
      },
      eta: {
        rank(ctx, p) {
          const st = ctx.state;
          const r = st.riders[p.rider];
          return p.drivers.slice().sort((a, b) => cost(st, r, a) - cost(st, r, b) || (a < b ? -1 : 1));
        },
        matrix(ctx, p) { return { ok: true, riders: p.riders, drivers: p.drivers }; },
      },
      driverstate: {
        reserve(ctx, p) {
          const st = ctx.state;
          const d = st.drivers[p.driver];
          if (st.config.cas ? d.status !== 'available' : !['available', 'offered'].includes(d.status)) return { reserved: false, reason: d.status };
          if (!st.config.cas && d.status === 'offered') st.stats.doubleBooked++;
          d.status = 'offered';
          d.rider = p.rider;
          d.version++;
          return { reserved: true };
        },
        assign(ctx, p) {
          const st = ctx.state;
          const d = st.drivers[p.driver];
          if (st.config.cas && (d.status !== 'offered' || d.rider !== p.rider)) ctx.fail('CONFLICT', `${p.driver} is no longer reserved for ${p.rider}.`);
          d.status = 'busy';
          d.rider = p.rider;
          d.version++;
          return { assigned: true };
        },
        release(ctx, p) {
          const d = ctx.state.drivers[p.driver];
          if (d.status === 'offered' && d.rider === p.rider) { d.status = 'available'; d.rider = null; d.version++; }
          return { status: d.status };
        },
      },
      offers: { send: function* (ctx, p) { return ctx.must(yield ctx.call('realtime', 'offer', p, { timeout: 600 })); } },
      realtime: { offer: function* (ctx, p) { return ctx.must(yield ctx.call('drivers', 'offer', p, { timeout: 500 })); } },
      drivers: {
        offer(ctx, p) {
          const sim = ctx.sim;
          const accept = sim.rng() < sim.state.acceptRate;
          const delay = 500 + Math.round(sim.rng() * 700);
          sim.schedule(delay, () => {
            const o = sim.state.offers[p.offerId];
            if (o && o.status === 'pending') o.status = accept ? 'accepted' : 'declined';
          });
          return { shown: true };
        },
      },
    },

    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(BATCH_MS);
          const st = ctx.state;
          if (!st.pending.length || ctx.sim.nodes.batcher.modes.paused || ctx.sim.nodes.batcher.modes.down) continue;
          const riders = st.pending.splice(0);
          const n = yield ctx.call('geoindex', 'available', {}, { timeout: 600 });
          if (!n.ok || !n.value.drivers.length) { st.pending.unshift(...riders); continue; }
          yield ctx.call('eta', 'matrix', { riders, drivers: n.value.drivers }, { timeout: 800 });
          const plan = bestAssignment(st, riders, n.value.drivers);
          ctx.log({ op: `batch of ${riders.length} solved`, status: 'note', detail: plan.map(([r, d]) => `${r}→${d || 'none'}`).join(', ') + `. Total pickup ${plan.reduce((a, [r, d]) => a + (d ? trueEta(st.riders[r], st.drivers[d]) : 0), 0)} min.` });
          const procs = plan.map(([r, d]) => ctx.spawn(function* (c) {
            if (!d || !(yield* offerAndAssign(c, r, d))) { if (st.riders[r].status === 'waiting') st.pending.push(r); }
          }));
          yield ctx.join(procs);
        }
      }, { self: 'batcher' });
    },

    consistency(sim) {
      const st = sim.state;
      const byDriver = {};
      for (const r of Object.values(st.riders)) if (r.status === 'matched' && st.drivers[r.driver].status === 'busy') (byDriver[r.driver] = byDriver[r.driver] || []).push(r.id);
      const dbl = Object.entries(byDriver).find(([, rs]) => rs.length > 1);
      if (dbl) return { key: 'wrong', label: `Double dispatch: ${dbl[0]} is assigned to ${dbl[1].join(' and ')}.` };
      const waiting = Object.values(st.riders).filter((r) => r.status === 'waiting');
      if (waiting.length) return { key: 'stale', label: `${waiting.length} rider${waiting.length > 1 ? 's are' : ' is'} still waiting for a driver.` };
      return { key: 'ok', label: 'Every rider has exactly one driver and no driver has two riders.' };
    },

    metrics(snap, sim) {
      const st = sim.state;
      const m = Object.values(st.riders).filter((r) => r.status === 'matched');
      const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      const eta = avg(m.map((r) => r.eta));
      const wait = avg(m.map((r) => r.matchedAt - r.requestedAt));
      const trips = Object.values(st.drivers).map((d) => d.trips);
      return [
        { label: 'Riders matched', value: `${m.length} of ${Object.keys(st.riders).length}` },
        { label: 'Average pickup ETA', value: eta == null ? 'n/a' : `${eta.toFixed(1)} min` },
        { label: 'Total pickup time', value: `${m.reduce((a, r) => a + r.eta, 0)} min` },
        { label: 'Average time to match', value: wait == null ? 'n/a' : `${(wait / 1000).toFixed(1)} s` },
        { label: 'Offers per match', value: m.length ? (st.stats.offers / m.length).toFixed(1) : 'n/a', tone: m.length && st.stats.offers / m.length > 1.5 ? 'warn' : '' },
        { label: 'Driver trips today, max minus min', value: Math.max(...trips) - Math.min(...trips) },
        { label: 'New trips to the 3 least-busy drivers', value: `${['D2', 'D4', 'D5'].reduce((a, id) => a + st.drivers[id].trips - DRIVERS0[id].trips, 0)} of ${Object.values(st.drivers).reduce((a, d) => a + d.trips, 0) - Object.values(DRIVERS0).reduce((a, d) => a + d.trips, 0)}` },
      ];
    },

    product: {
      mount(el, sim) {
        el.innerHTML = `
          <p class="panel-note phones-note">The dispatch board shows riders (circles) and drivers (squares, with trips done today). Dashed lines are offers waiting for an answer; solid lines are matches. The only bridge over the river is on the middle row.</p>
          <div class="ops-console">
            <div class="ops-traffic">
              <button class="btn btn-primary" data-act="wave">Send a wave of 4 riders</button>
              <button class="btn ops-tbtn" data-act="setAcceptance" data-arg='{"rate":1}' data-rate="1">Drivers accept every offer</button>
              <button class="btn ops-tbtn" data-act="setAcceptance" data-arg='{"rate":0.4}' data-rate="0.4">Drivers accept 40%</button>
            </div>
            <div data-ref="board"></div>
            <div data-ref="table"></div>
          </div>`;
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-act]');
          if (!b || b.disabled) return;
          sim.dispatch(b.dataset.act, b.dataset.arg ? JSON.parse(b.dataset.arg) : {});
        });
      },
      render(el, sim) {
        const st = sim.state;
        el.querySelectorAll('[data-rate]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === st.acceptRate)));
        const C = 52;
        const cx = (v) => v * C + C / 2;
        let s = `<svg class="board" viewBox="0 0 ${8 * C} ${6 * C}" role="img" aria-label="Dispatch board">`;
        for (let x = 0; x <= 8; x++) s += `<line class="map-street" x1="${x * C}" y1="0" x2="${x * C}" y2="${6 * C}"/>`;
        for (let y = 0; y <= 6; y++) s += `<line class="map-street" x1="0" y1="${y * C}" x2="${8 * C}" y2="${y * C}"/>`;
        s += `<rect class="board-river" x="${4 * C - 7}" y="0" width="14" height="${6 * C}"/><rect class="board-bridge" x="${4 * C - 10}" y="${BRIDGE_Y * C + C / 2 - 6}" width="20" height="12" rx="2"/><text class="board-label" x="${4 * C}" y="12" text-anchor="middle">river</text>`;
        for (const r of Object.values(st.riders)) {
          if (r.status === 'matched' && sim.now - r.matchedAt < BUSY_MS) {
            const d = st.drivers[r.driver];
            s += `<line class="board-match" x1="${cx(r.x)}" y1="${cx(r.y)}" x2="${cx(d.status === 'busy' ? d.x : r.x)}" y2="${cx(d.status === 'busy' ? d.y : r.y)}"/>`;
          } else if (r.offeredTo) {
            const d = st.drivers[r.offeredTo];
            s += `<line class="board-offer" x1="${cx(r.x)}" y1="${cx(r.y)}" x2="${cx(d.x)}" y2="${cx(d.y)}"/>`;
          }
        }
        for (const [id, d] of Object.entries(st.drivers)) {
          s += `<g class="board-driver st-${d.status}"><rect x="${cx(d.x) - 15}" y="${cx(d.y) - 11}" width="30" height="22" rx="5"/><text x="${cx(d.x)}" y="${cx(d.y) + 1}" text-anchor="middle">${id}</text><text class="board-trips" x="${cx(d.x)}" y="${cx(d.y) + 9}" text-anchor="middle">${d.trips} trips</text></g>`;
        }
        for (const r of Object.values(st.riders)) {
          if (r.status === 'matched' && sim.now - r.matchedAt >= BUSY_MS) continue;
          s += `<g class="board-rider st-${r.status}"><circle cx="${cx(r.x)}" cy="${cx(r.y)}" r="12"/><text x="${cx(r.x)}" y="${cx(r.y) + 4}" text-anchor="middle">${r.id}</text></g>`;
        }
        s += '</svg>';
        const recent = Object.values(st.riders).slice(-8).reverse();
        const table = recent.length
          ? `<table class="ledger board-table"><thead><tr><th>Rider</th><th>Status</th><th>Driver</th><th>Pickup</th><th>Waited</th></tr></thead><tbody>${recent.map((r) => `<tr><td>${r.id}</td><td>${{ waiting: r.offeredTo ? `Offer to ${r.offeredTo}` : 'Waiting', matched: 'Matched', unmatched: 'No driver' }[r.status]}</td><td>${r.driver || ''}</td><td>${r.eta ? r.eta + ' min' : ''}</td><td>${r.matchedAt ? ((r.matchedAt - r.requestedAt) / 1000).toFixed(1) + ' s' : ''}</td></tr>`).join('')}</tbody></table>`
          : '<p class="empty">No riders yet. Send a wave.</p>';
        SDL.ui.paintSections(el.querySelector('[data-ref="board"]'), { board: s }, {});
        SDL.ui.paintSections(el.querySelector('[data-ref="table"]'), { table }, {});
      },
    },
  });
  sc.bestAssignment = bestAssignment;
})(typeof window !== 'undefined' ? window : globalThis);
