/*
 * Deep dive: surge pricing.
 *
 * Demand: every price check publishes a demand event for its pickup zone.
 * Supply: driver phones report which zone they are in.
 * The aggregator keeps a 5 s demand window and a 3 s supply window per zone,
 * computes a raw multiplier every 500 ms, applies policy caps and optional
 * smoothing, and writes the result to the surge store. Pricing reads it and
 * saves a quote; booking redeems the quote so the shown price is the paid price.
 * Drivers respond to surge by moving toward surging zones, closing the loop.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;

  const ZONES = {
    home: { label: 'Suburbs', dist: 5, base: 0.6, drivers: 6 },
    stadium: { label: 'Stadium', dist: 3, base: 0.3, drivers: 4 },
    downtown: { label: 'Downtown', dist: 2, base: 1.0, drivers: 8 },
    airport: { label: 'Airport', dist: 7, base: 0.6, drivers: 5 },
  };
  const ZONE_IDS = Object.keys(ZONES);
  const EVENTS = {
    normal: { label: 'Normal evening' },
    concert: { label: 'Concert ends at the stadium', ms: 7000 },
    rain: { label: 'Rainstorm citywide', ms: 9000 },
  };
  const DEMAND_WINDOW = 5000;
  const SUPPLY_WINDOW = 3000;
  const TICK = 500;
  const QUOTE_MS = 8000;
  const STALE_SURGE_MS = 4000;
  const money = (v) => '$' + Number(v).toFixed(2);
  const fareFor = (zone, m) => Math.round((2.5 + 1.6 * ZONES[zone].dist) * m * 100) / 100;
  const r1 = (v) => Math.round(v * 10) / 10;

  function demandRate(st, zone, now) {
    let r = ZONES[zone].base;
    if (st.event === 'concert' && now < st.eventUntil && zone === 'stadium') r += 8;
    if (st.event === 'rain' && now < st.eventUntil) r *= 7;
    return r;
  }

  function* quoteFlow(ctx, zone, mine) {
    const t0 = ctx.now();
    const r = yield ctx.call('gateway', 'quote', { zone }, { timeout: 1500, quiet: mine ? false : 'all' });
    if (!mine) ctx.sim.recordOutcome(r.ok, ctx.now() - t0);
    return r;
  }

  function startQuote(sim) {
    const zone = sim.ui.phone.zone;
    sim.startAction('Rider: see price', function* (ctx) {
      const ui = ctx.ui.phone;
      ui.busy = true;
      ui.booking = null;
      ctx.ledger('displayed', 'pending', 'Shows a loading state.');
      ctx.ledger('async', 'n/a');
      ctx.ledger('retrySafe', 'yes', 'A new quote is safe to request any time.');
      const t0 = ctx.now();
      const r = yield* quoteFlow(ctx, zone, true);
      ctx.recordOutcome(r.ok, ctx.now() - t0);
      ui.busy = false;
      if (r.ok) {
        const q = r.value;
        ui.quote = q;
        ctx.ledger('displayed', 'yes', `Shows ${money(q.fare)} at ${q.multiplier.toFixed(1)}×, locked for ${QUOTE_MS / 1000} s.`);
        ctx.ledger('accepted', 'yes');
        ctx.ledger('committed', 'yes', 'The quote is saved so booking can honour this exact price.');
        const flags = [];
        if (q.fallback) flags.push('the surge store did not answer, so the base fare was used');
        if (q.stale) flags.push(`the surge data was older than ${STALE_SURGE_MS / 1000} s, so the fail-safe ignored it`);
        ctx.explain(
          `Pricing read ${q.multiplier.toFixed(1)}× for ${ZONES[zone].label} from the surge store` +
            (flags.length ? `, but ${flags.join(' and ')}.` : '.') +
            ` The quote is saved with an expiry. In a real app the lock lasts a couple of minutes; here it is ${QUOTE_MS / 1000} s so you can watch it run out. This price check also counted as one unit of demand for ${ZONES[zone].label}.`
        );
      } else {
        ui.quote = null;
        ui.error = r.error.message;
        ctx.ledger('displayed', 'no', 'Shows that prices are unavailable.');
        ctx.ledger('accepted', 'no', null, { ifPending: true });
        ctx.ledger('committed', 'no', null, { ifPending: true });
        ctx.explain(`No price could be quoted: ${r.error.message}`);
      }
    }, { self: 'rider', detail: `Rider tapped “See price” from ${ZONES[zone].label}.` });
  }

  function startBook(sim) {
    const q = sim.ui.phone.quote;
    if (!q) return;
    sim.startAction('Rider: book at quoted price', function* (ctx) {
      const ui = ctx.ui.phone;
      ui.busy = true;
      ctx.ledger('displayed', 'pending');
      ctx.ledger('async', 'n/a');
      ctx.ledger('retrySafe', 'yes', 'Redeeming the same quote twice is rejected, so a retry cannot book twice.');
      const t0 = ctx.now();
      const r = yield ctx.call('gateway', 'book', { quoteId: q.quoteId }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, ctx.now() - t0);
      ui.busy = false;
      if (r.ok) {
        ui.booking = r.value;
        ui.quote = null;
        const higher = r.value.charged > r.value.quoted;
        ctx.ledger('displayed', 'yes', `Shows the ride booked at ${money(r.value.charged)}.`);
        ctx.ledger('accepted', 'yes');
        ctx.ledger('committed', 'yes', 'The booking stored the charged fare.');
        ctx.explain(higher
          ? `The price lock is off, so the trip service re-read surge at booking time: the rider saw ${money(r.value.quoted)} but is charged ${money(r.value.charged)}. That breaks trust, and in many places it breaks consumer law.`
          : `The trip service redeemed quote ${q.quoteId} and charged exactly ${money(r.value.charged)}, even if surge changed since the rider looked.`);
      } else {
        ui.error = r.error.code === 'QUOTE_EXPIRED' ? 'That price expired. Check the new price.' : r.error.message;
        ui.quote = null;
        ctx.ledger('displayed', 'no', 'Asks the rider to check the price again.');
        ctx.ledger('accepted', 'no', null, { ifPending: true });
        ctx.ledger('committed', 'no', null, { ifPending: true });
        ctx.explain(r.error.code === 'QUOTE_EXPIRED' ? 'The quote’s lock ran out, so booking refused it and the app asks for a fresh price. The rider never pays a price they were not shown.' : `Booking failed: ${r.error.message}`);
      }
    }, { self: 'rider', detail: `Rider tapped “Book” with quote ${q.quoteId}.` });
  }

  function startEvent(sim, kind) {
    const st = sim.state;
    st.event = kind;
    st.eventUntil = kind === 'normal' ? 0 : sim.now + EVENTS[kind].ms;
    sim.note(kind === 'normal' ? 'Demand back to a normal evening.' : `${EVENTS[kind].label}: demand changes for ${EVENTS[kind].ms / 1000} s.`);
  }

  const sc = (SDL.scenarios['rides-surge'] = {
    id: 'rides-surge',
    seed: 31,
    productWidth: 600,
    intro: 'Trigger “Concert ends at the stadium” and watch the stadium tile: demand jumps, supply lags, the multiplier climbs, then drivers arrive and it settles. Check a price on the phone at any point.',
    topology: {
      width: 1160,
      height: 600,
      nodes: [
        { id: 'rider', label: 'Your rider app', sub: 'Phone in the sidebar', kind: 'client', x: 100, y: 90, latency: 1, role: 'Checks prices and books at the quoted fare.', owns: ['Nothing'] },
        { id: 'crowd', label: 'Other riders', sub: 'Background price checks', kind: 'client', x: 100, y: 300, latency: 1, role: 'Everyone else checking prices. Their checks are the demand signal.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Rider traffic', kind: 'gateway', x: 330, y: 90, latency: 2, role: 'Routes price checks to pricing and bookings to the trip service.', ops: [{ name: 'quote', desc: 'Price check.' }, { name: 'book', desc: 'Book with a quote.' }], owns: ['Nothing durable'] },
        { id: 'pricing', label: 'Pricing', sub: 'Quotes', kind: 'service', x: 560, y: 90, latency: 5, role: 'Reads the zone multiplier, builds a fare, saves a quote, and publishes a demand event.', ops: [{ name: 'quote', desc: 'Fare = (base + per-km × distance) × surge.' }], owns: ['Fare rules'] },
        { id: 'quotes', label: 'Quote store', sub: 'Price locks', kind: 'db', x: 790, y: 90, latency: 6, role: 'Saved quotes with expiry. A quote can be redeemed once, before it expires.', ops: [{ name: 'save', desc: 'Store a quote.' }, { name: 'redeem', desc: 'Use a quote once.' }], owns: ['quotes'] },
        { id: 'trip', label: 'Trip service', sub: 'Bookings', kind: 'service', x: 1020, y: 90, latency: 6, role: 'Books a ride by redeeming a quote. With the price lock off, it re-reads surge instead.', ops: [{ name: 'book', desc: 'Redeem a quote and charge its fare.' }], owns: ['bookings'] },
        { id: 'surgestore', label: 'Surge store', sub: 'Multiplier per zone', kind: 'cache', x: 560, y: 290, latency: 2, role: 'The current multiplier for each zone and when it was computed.', ops: [{ name: 'get', desc: 'Multiplier and its age.' }, { name: 'set', desc: 'Replace multipliers.' }], owns: ['multiplier[zone]', 'computedAt'] },
        { id: 'policy', label: 'Surge policy', sub: 'Caps and rules', kind: 'service', x: 1020, y: 290, latency: 4, role: 'Business and legal limits: the maximum multiplier, and an emergency cap.', ops: [{ name: 'limits', desc: 'Current cap.' }], owns: ['caps'] },
        { id: 'demand', label: 'Demand events', sub: 'Price checks', kind: 'queue', x: 330, y: 490, latency: 3, queue: 'demand', role: 'A log of price checks per zone.', ops: [{ name: 'publish', desc: 'Append a demand event.' }], owns: ['demand log'] },
        { id: 'aggregator', label: 'Surge aggregator', sub: 'Every 500 ms', kind: 'worker', x: 560, y: 490, latency: 4, role: 'Counts demand (5 s window) and supply (3 s window) per zone, computes multipliers, applies policy and smoothing.', ops: [{ name: 'tick', desc: 'Recompute every zone.' }], owns: ['Windows of demand and supply'] },
        { id: 'supply', label: 'Supply events', sub: 'Driver positions', kind: 'queue', x: 790, y: 490, latency: 3, queue: 'supply', role: 'A log of which zone each available driver is in.', ops: [{ name: 'publish', desc: 'Append driver positions.' }], owns: ['supply log'] },
        { id: 'fleet', label: 'Driver phones', sub: 'Report zone', kind: 'client', x: 1020, y: 490, latency: 1, role: 'Available drivers report their zone every 500 ms, and drift toward surging zones.', owns: ['Driver positions'] },
      ],
      edges: [
        { from: 'rider', to: 'gateway', latency: 30 },
        { from: 'crowd', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'pricing', latency: 4 },
        { from: 'gateway', to: 'trip', latency: 4, label: 'book', via: [[330, 22], [1020, 22]] },
        { from: 'pricing', to: 'quotes', latency: 4 },
        { from: 'trip', to: 'quotes', latency: 4 },
        { from: 'pricing', to: 'surgestore', latency: 3 },
        { from: 'trip', to: 'surgestore', latency: 4 },
        { from: 'pricing', to: 'demand', latency: 4, via: [[440, 200]] },
        { from: 'demand', to: 'aggregator', latency: 4 },
        { from: 'supply', to: 'aggregator', latency: 4 },
        { from: 'fleet', to: 'supply', latency: 25 },
        { from: 'aggregator', to: 'surgestore', latency: 3 },
        { from: 'aggregator', to: 'policy', latency: 4 },
      ],
      queues: [
        { id: 'demand', broker: 'demand', label: 'demand', groups: ['aggregator'] },
        { id: 'supply', broker: 'supply', label: 'supply', groups: ['aggregator'] },
      ],
    },

    failures: [
      { id: 'store-down', node: 'surgestore', mode: 'down', label: 'Surge store unavailable', desc: 'Pricing cannot read multipliers: base fare or refusal, depending on the switch.' },
      { id: 'agg-paused', node: 'aggregator', mode: 'paused', label: 'Aggregator stalled', desc: 'Multipliers freeze while the real situation changes.' },
      { id: 'supply-down', node: 'supply', mode: 'down', label: 'Supply stream down', desc: 'The aggregator stops seeing drivers. Without a fail-safe, supply looks like zero and surge maxes out everywhere.' },
      { id: 'demand-down', node: 'demand', mode: 'down', label: 'Demand stream down', desc: 'Price checks are not counted. Surge silently drops even when demand is real.' },
      { id: 'policy-down', node: 'policy', mode: 'down', label: 'Surge policy unavailable', desc: 'The aggregator keeps using the last caps it received.' },
      { id: 'quotes-down', node: 'quotes', mode: 'down', label: 'Quote store down', desc: 'No quote can be saved, so no price can be shown or booked.' },
    ],

    switches: [
      { id: 'smoothing', label: 'Smooth multiplier changes', desc: 'Move 35% toward the new value each tick, so prices do not flicker.', get: (s) => s.state.config.smoothing, set: (s, on) => { s.state.config.smoothing = on; } },
      { id: 'priceLock', label: 'Lock the quoted price', desc: 'Booking charges the quote. Off: booking re-reads surge and may charge more.', get: (s) => s.state.config.priceLock, set: (s, on) => { s.state.config.priceLock = on; } },
      { id: 'failSafe', label: 'Fail safe on missing or stale data', desc: 'No surge from a zone without recent supply data, or from multipliers older than 4 s.', get: (s) => s.state.config.failSafe, set: (s, on) => { s.state.config.failSafe = on; } },
      { id: 'baseFare', label: 'Base fare if the surge store is down', desc: 'Off: pricing refuses to quote instead.', get: (s) => s.state.config.baseFare, set: (s, on) => { s.state.config.baseFare = on; } },
      { id: 'emergencyCap', label: 'Emergency cap at 1.5×', desc: 'A policy limit, for example during a disaster or a regulatory order.', get: (s) => s.state.config.emergencyCap, set: (s, on) => { s.state.config.emergencyCap = on; } },
    ],

    presets: (function () {
      const base = (sim, sw) => {
        sim.restoreAll();
        const def = { smoothing: true, priceLock: true, failSafe: true, baseFare: true, emergencyCap: false };
        for (const [id, on] of Object.entries(Object.assign(def, sw || {}))) sim.do('setSwitch', { id, on });
        startEvent(sim, 'normal');
      };
      return [
        { id: 'normal', label: 'Normal evening', desc: 'Demand and supply roughly balanced. Every zone at 1.0×.', run: (s) => { base(s); s.ui.phone.zone = 'downtown'; s.schedule(1500, () => startQuote(s)); } },
        { id: 'concert', label: 'Concert ends', desc: 'Stadium demand jumps 25 times. The multiplier climbs to the cap, drivers head over, and it settles.', run: (s) => { base(s); startEvent(s, 'concert'); s.ui.phone.zone = 'stadium'; s.schedule(2500, () => startQuote(s)); } },
        { id: 'no-smoothing', label: 'Concert, no smoothing', desc: 'Raw multipliers jump from 1.0× to the cap in about a second, and crash back when the crowd leaves. Compare the sparkline with the smoothed run.', run: (s) => { base(s, { smoothing: false }); startEvent(s, 'concert'); s.ui.phone.zone = 'stadium'; } },
        { id: 'lock', label: 'Price changes after the quote', desc: 'The rider quotes at the stadium before the concert ends, then books as surge spikes. The lock honours the old price.', run: (s) => { base(s); s.ui.phone.zone = 'stadium'; startQuote(s); s.schedule(400, () => startEvent(s, 'concert')); s.schedule(3200, () => startBook(s)); } },
        { id: 'no-lock', label: 'Same, without a price lock', desc: 'Booking re-reads surge and charges more than the rider was shown.', run: (s) => { base(s, { priceLock: false }); s.ui.phone.zone = 'stadium'; startQuote(s); s.schedule(400, () => startEvent(s, 'concert')); s.schedule(3200, () => startBook(s)); } },
        { id: 'expired', label: 'Quote expires', desc: 'The rider waits too long. Booking refuses the stale quote and asks for a fresh price.', run: (s) => { base(s); s.ui.phone.zone = 'downtown'; startQuote(s); s.schedule(QUOTE_MS + 800, () => startBook(s)); } },
        { id: 'supply-out', label: 'Supply stream outage', desc: 'Drivers disappear from the aggregator’s view. The fail-safe holds prices at 1.0× instead of a false surge.', run: (s) => { base(s); s.schedule(1000, () => s.inject('supply', 'down')); s.ui.phone.zone = 'downtown'; s.schedule(5000, () => startQuote(s)); } },
        { id: 'false-surge', label: 'Supply outage, no fail-safe', desc: 'Missing supply looks like zero drivers, so every zone jumps to the cap. Riders are overcharged for a data problem.', run: (s) => { base(s, { failSafe: false }); s.schedule(1000, () => s.inject('supply', 'down')); s.ui.phone.zone = 'downtown'; s.schedule(5000, () => startQuote(s)); } },
        { id: 'stalled', label: 'Aggregator stalls mid-spike', desc: 'Surge freezes at its peak after the concert crowd leaves. The fail-safe stops pricing from trusting the frozen value.', run: (s) => { base(s); startEvent(s, 'concert'); s.schedule(3000, () => s.inject('aggregator', 'paused')); s.ui.phone.zone = 'stadium'; s.schedule(8500, () => startQuote(s)); } },
        { id: 'emergency', label: 'Emergency cap', desc: 'A citywide storm with the emergency cap on: multipliers stop at 1.5×.', run: (s) => { base(s, { emergencyCap: true }); startEvent(s, 'rain'); s.ui.phone.zone = 'downtown'; s.schedule(5500, () => startQuote(s)); } },
        { id: 'storm', label: 'Storm, no cap', desc: 'The same storm without the emergency cap, for comparison.', run: (s) => { base(s); startEvent(s, 'rain'); s.ui.phone.zone = 'downtown'; s.schedule(5500, () => startQuote(s)); } },
      ];
    })(),

    initialState: () => {
      const drivers = {};
      let n = 0;
      for (const z of ZONE_IDS) for (let i = 0; i < ZONES[z].drivers; i++) drivers['d' + ++n] = z;
      const mult = {};
      const history = {};
      for (const z of ZONE_IDS) { mult[z] = 1; history[z] = [1]; }
      return {
        config: { smoothing: true, priceLock: true, failSafe: true, baseFare: true, emergencyCap: false },
        event: 'normal', eventUntil: 0,
        drivers,
        store: { mult: Object.assign({}, mult), computedAt: 0, unknown: {} },
        agg: { demand: [], seen: {}, lastSupplyAt: 0, mult: Object.assign({}, mult), limits: { cap: 3 } },
        calc: {},
        history,
        quotes: {}, bookings: [],
        seq: { quote: 0 },
        stats: { demandLost: 0, supplyLost: 0, moves: 0 },
      };
    },
    initialUI: () => ({ phone: { zone: 'stadium', busy: false, quote: null, booking: null, error: null } }),

    actions: {
      event(sim, a) { startEvent(sim, a.kind); },
      quote(sim) { sim.ui.phone.error = null; startQuote(sim); },
      book(sim) { startBook(sim); },
      phoneZone(sim, a) { Object.assign(sim.ui.phone, { zone: a.value, quote: null, booking: null, error: null }); },
    },

    handlers: {
      gateway: {
        quote: function* (ctx, p) { return ctx.must(yield ctx.call('pricing', 'quote', p, { timeout: 1200 })); },
        book: function* (ctx, p) { return ctx.must(yield ctx.call('trip', 'book', p, { timeout: 1200 })); },
      },
      pricing: {
        quote: function* (ctx, p) {
          const st = ctx.state;
          let multiplier = 1;
          let fallback = false;
          let stale = false;
          const s = yield ctx.call('surgestore', 'get', { zone: p.zone }, { timeout: 300 });
          if (s.ok) {
            multiplier = s.value.multiplier;
            if (st.config.failSafe && s.value.computedAt > 0 && ctx.now() - s.value.computedAt > STALE_SURGE_MS) { multiplier = 1; stale = true; }
          } else if (st.config.baseFare) fallback = true;
          else ctx.fail('PRICING_UNAVAILABLE', 'Surge data is unavailable, so no price can be quoted right now.');
          const quoteId = 'q-' + ++st.seq.quote;
          const q = { quoteId, zone: p.zone, multiplier, fare: fareFor(p.zone, multiplier), expiresAt: ctx.now() + QUOTE_MS, fallback, stale };
          ctx.must(yield ctx.call('quotes', 'save', q, { timeout: 400 }));
          const d = yield ctx.call('demand', 'publish', { zone: p.zone }, { timeout: 300 });
          if (!d.ok) st.stats.demandLost++;
          return q;
        },
      },
      quotes: {
        save(ctx, q) { ctx.state.quotes[q.quoteId] = Object.assign({ used: false }, q); return { saved: q.quoteId }; },
        redeem(ctx, p) {
          const q = ctx.state.quotes[p.quoteId];
          if (!q) ctx.fail('NOT_FOUND', 'Unknown quote.');
          if (q.used) ctx.fail('ALREADY_USED', 'This quote was already used.');
          if (ctx.state.config.priceLock && ctx.now() > q.expiresAt) ctx.fail('QUOTE_EXPIRED', 'The quoted price has expired.');
          q.used = true;
          return q;
        },
      },
      trip: {
        book: function* (ctx, p) {
          const st = ctx.state;
          const q = ctx.must(yield ctx.call('quotes', 'redeem', p, { timeout: 400 }));
          let charged = q.fare;
          if (!st.config.priceLock) {
            const s = yield ctx.call('surgestore', 'get', { zone: q.zone }, { timeout: 300 });
            if (s.ok) charged = fareFor(q.zone, s.value.multiplier);
          }
          const b = { quoteId: q.quoteId, zone: q.zone, quoted: q.fare, charged };
          st.bookings.push(b);
          return b;
        },
      },
      surgestore: {
        get(ctx, p) { const s = ctx.state.store; return { multiplier: s.mult[p.zone] || 1, computedAt: s.computedAt, unknown: !!s.unknown[p.zone] }; },
        set(ctx, p) { Object.assign(ctx.state.store, { mult: p.mult, computedAt: ctx.now(), unknown: p.unknown }); return { zones: Object.keys(p.mult).length }; },
      },
      policy: {
        limits(ctx) { return { cap: ctx.state.config.emergencyCap ? 1.5 : 3 }; },
      },
      demand: {
        publish(ctx, p) { ctx.sim.enqueue('demand', { type: 'demand', payload: { zone: p.zone }, quiet: true }); return { appended: true }; },
      },
      supply: {
        publish(ctx, p) { ctx.sim.enqueue('supply', { type: 'supply', payload: p, quiet: true }); return { appended: true }; },
      },
    },

    setup(sim) {
      // Other riders: random price checks at each zone's current demand rate.
      sim.spawn(function* (ctx) {
        for (;;) {
          const st = ctx.state;
          for (const z of ZONE_IDS) {
            if (ctx.rand() < demandRate(st, z, ctx.now()) * 0.05) ctx.spawn((c) => quoteFlow(c, z, false), { quiet: 'all' });
          }
          if (st.event !== 'normal' && ctx.now() >= st.eventUntil) st.event = 'normal';
          yield ctx.wait(50);
        }
      }, { self: 'crowd', quiet: 'all' });

      // Drivers: report zones every 500 ms; every 2 s one drives toward the strongest surge.
      sim.spawn(function* (ctx) {
        let tick = 0;
        for (;;) {
          const st = ctx.state;
          tick++;
          if (tick % 4 === 0) {
            const m = st.store.mult;
            const hot = ZONE_IDS.slice().sort((a, b) => m[b] - m[a])[0];
            if (m[hot] >= 1.3) {
              const counts = {};
              for (const z of Object.values(st.drivers)) counts[z] = (counts[z] || 0) + 1;
              const donor = ZONE_IDS.filter((z) => z !== hot && (counts[z] || 0) > 2).sort((a, b) => m[a] - m[b] || (counts[b] || 0) - (counts[a] || 0))[0];
              const id = donor && Object.keys(st.drivers).find((d) => st.drivers[d] === donor);
              if (id) {
                st.drivers[id] = hot;
                st.stats.moves++;
                ctx.log({ op: 'driver repositioned', status: 'note', detail: `A driver left ${ZONES[donor].label} for ${ZONES[hot].label}, drawn by ${m[hot].toFixed(1)}× surge. Higher prices pull supply in.` });
              }
            }
          }
          const r = yield ctx.call('supply', 'publish', { drivers: Object.assign({}, st.drivers) }, { timeout: 300, quiet: 'all' });
          if (!r.ok) st.stats.supplyLost++;
          yield ctx.wait(500);
        }
      }, { self: 'fleet', quiet: 'all' });

      // Aggregator: consume both streams into its windows.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('demand', 'aggregator');
          ctx.state.agg.demand.push({ zone: msg.payload.zone, t: ctx.now() });
          ctx.ack('demand', 'aggregator');
        }
      }, { self: 'aggregator' });
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('supply', 'aggregator');
          const a = ctx.state.agg;
          for (const [d, z] of Object.entries(msg.payload.drivers)) a.seen[d] = { zone: z, t: ctx.now() };
          a.lastSupplyAt = ctx.now();
          ctx.ack('supply', 'aggregator');
        }
      }, { self: 'aggregator' });

      // Aggregator tick: compute, cap, smooth, write.
      sim.spawn(function* (ctx) {
        let policyFailing = false;
        for (;;) {
          yield ctx.wait(TICK);
          if (ctx.sim.nodes.aggregator.modes.paused || ctx.sim.nodes.aggregator.modes.down) continue;
          const st = ctx.state;
          const a = st.agg;
          const now = ctx.now();
          a.demand = a.demand.filter((d) => now - d.t < DEMAND_WINDOW);
          const lim = yield ctx.call('policy', 'limits', {}, { timeout: 300, quiet: true });
          if (lim.ok) { a.limits = lim.value; if (policyFailing) { policyFailing = false; ctx.log({ op: 'policy reachable again', status: 'recovered' }); } }
          else if (!policyFailing) { policyFailing = true; ctx.log({ op: 'policy unavailable', status: 'err', error: lim.error, detail: `Using the last known cap of ${a.limits.cap}×.` }); }
          const supplyFresh = now - a.lastSupplyAt < SUPPLY_WINDOW;
          const mult = {};
          const unknown = {};
          for (const z of ZONE_IDS) {
            const demand = a.demand.filter((d) => d.zone === z).length;
            const supply = Object.values(a.seen).filter((s) => s.zone === z && now - s.t < SUPPLY_WINDOW).length;
            let raw;
            if (!supplyFresh && st.config.failSafe) { raw = 1; unknown[z] = true; }
            else raw = 1 + Math.max(0, demand / Math.max(0.5, supply) - 1) * 0.5;
            raw = Math.min(a.limits.cap, Math.max(1, raw));
            const prev = a.mult[z] || 1;
            const next = st.config.smoothing ? prev + 0.35 * (raw - prev) : raw;
            mult[z] = Math.min(a.limits.cap, Math.max(1, r1(next)));
            st.calc[z] = { demand, supply, raw: r1(raw), unknown: !!unknown[z] };
          }
          const changed = ZONE_IDS.filter((z) => mult[z] !== a.mult[z]);
          a.mult = mult;
          const w = yield ctx.call('surgestore', 'set', { mult, unknown }, { timeout: 300, quiet: true });
          if (w.ok) for (const z of ZONE_IDS) { st.history[z].push(mult[z]); if (st.history[z].length > 40) st.history[z].shift(); }
          if (changed.length && w.ok) {
            const z = changed.sort((x, y) => Math.abs(mult[y] - 1) - Math.abs(mult[x] - 1))[0];
            ctx.log({ op: 'surge recalculated', status: 'note', detail: `${ZONES[z].label}: ${mult[z].toFixed(1)}× (demand ${st.calc[z].demand} in 5 s, supply ${st.calc[z].supply} drivers, raw ${st.calc[z].raw.toFixed(1)}×${st.config.smoothing ? ', smoothed' : ''}).` });
          }
        }
      }, { self: 'aggregator' });
    },

    consistency(sim) {
      const st = sim.state;
      const over = st.bookings.find((b) => b.charged > b.quoted);
      if (over) return { key: 'wrong', label: `A rider was shown ${money(over.quoted)} but charged ${money(over.charged)}.` };
      const age = sim.now - st.store.computedAt;
      if (st.store.computedAt > 0 && age > STALE_SURGE_MS) return { key: 'stale', label: `Multipliers were computed ${(age / 1000).toFixed(1)} s ago and no longer reflect the city.` };
      const falseSurge = ZONE_IDS.filter((z) => st.calc[z] && st.calc[z].supply === 0 && st.store.mult[z] > 1.5);
      if (falseSurge.length) return { key: 'wrong', label: `False surge: ${falseSurge.map((z) => ZONES[z].label).join(', ')} at the cap because supply data is missing, not because drivers are.` };
      if (Object.keys(st.store.unknown || {}).length) return { key: 'stale', label: 'Supply data is missing, so the fail-safe is holding every zone at 1.0×.' };
      if (st.stats.demandLost > 0 && sim.nodes.demand.modes.down) return { key: 'stale', label: `${st.stats.demandLost} price checks were not counted as demand. Surge is undercounting.` };
      return { key: 'ok', label: 'Multipliers are fresh and every booking charged its quoted price.' };
    },

    metrics(snap, sim) {
      const st = sim.state;
      return ZONE_IDS.map((z) => ({ label: `${ZONES[z].label} surge`, value: `${(st.store.mult[z] || 1).toFixed(1)}×`, tone: st.store.mult[z] >= 2 ? 'fail' : st.store.mult[z] > 1 ? 'warn' : 'ok' }))
        .concat([
          { label: 'Surge data age', value: st.store.computedAt ? `${((sim.now - st.store.computedAt) / 1000).toFixed(1)} s` : 'n/a', tone: st.store.computedAt && sim.now - st.store.computedAt > STALE_SURGE_MS ? 'fail' : '' },
          { label: 'Drivers repositioned', value: st.stats.moves },
          { label: 'Demand events lost', value: st.stats.demandLost, tone: st.stats.demandLost ? 'warn' : '' },
        ]);
    },

    product: {
      mount(el, sim) {
        el.innerHTML = `
          <p class="panel-note phones-note">Trigger a city event, watch the zone tiles, and check a price on the phone. Each tile shows the multiplier, its demand and supply, and its recent history.</p>
          <div class="hk-wrap">
            ${SDL.ui.phone.frame('rider', 'Rider phone')}
            <div class="ops-console">
              <p class="ops-title">Surge by zone</p>
              <div class="ops-traffic" role="group" aria-label="City events">
                ${Object.entries(EVENTS).map(([k, e]) => `<button class="btn ops-tbtn" data-act="event" data-arg='{"kind":"${k}"}' data-kind="${k}">${e.label}</button>`).join('')}
              </div>
              <div class="surge-tiles" data-ref="tiles"></div>
            </div>
          </div>`;
        SDL.ui.phone.wire(el.querySelector('.phone'));
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-act]');
          if (!b || b.disabled) return;
          sim.dispatch(b.dataset.act, b.dataset.arg ? JSON.parse(b.dataset.arg) : {});
        });
        el.addEventListener('change', (e) => { if (e.target.dataset.field === 'zone') sim.dispatch('phoneZone', { value: e.target.value }); });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const ui = sim.ui.phone;
        const ph = el.querySelector('.phone');
        SDL.ui.phone.render(ph, sim, 'rider', null, !!sim.nodes.rider.modes.down);
        let body = `<div class="app-row"><label for="sz">From</label><select id="sz" data-field="zone"${ui.busy ? ' disabled' : ''}>${Object.entries(ZONES).map(([k, z]) => `<option value="${k}"${k === ui.zone ? ' selected' : ''}>${z.label}</option>`).join('')}</select></div>
          <p class="app-sub">To City centre</p>
          <button class="app-btn${ui.quote ? ' secondary' : ''}" data-act="quote"${ui.busy ? ' disabled' : ''}>${ui.busy && !ui.quote ? '<span class="spinner"></span>Checking price…' : 'See price'}</button>`;
        const live = {};
        if (ui.quote) {
          const q = ui.quote;
          const left = Math.max(0, q.expiresAt - sim.now);
          live.lock = left > 0 ? `Price locked for ${Math.ceil(left / 1000)} s` : 'Price lock expired';
          live.lockW = `${(left / QUOTE_MS) * 100}%`;
          body += `<div class="app-card${q.multiplier > 1 ? ' is-hot' : ''}">
            <span class="app-kv"><strong>Standard</strong><span class="app-price">${money(q.fare)}</span></span>
            <span class="app-kv"><span>${q.multiplier > 1 ? `⚡ ${q.multiplier.toFixed(1)}× surge` : 'No surge'}</span><span>${esc(q.quoteId)}</span></span>
            ${q.fallback ? '<span class="app-sub">Surge unavailable: base fare</span>' : ''}${q.stale ? '<span class="app-sub">Surge data stale: base fare</span>' : ''}
            <span class="app-sub" data-live="lock"></span><div class="app-countdown"><i data-live-width="lockW"></i></div></div>
            <button class="app-btn" data-act="book"${ui.busy ? ' disabled' : ''}>Book at ${money(q.fare)}</button>`;
        }
        if (ui.booking) body += `<div class="app-card ${ui.booking.charged > ui.booking.quoted ? 'is-fail' : 'is-ok'}"><strong>Ride booked</strong><span class="app-kv"><span>Quoted</span><span>${money(ui.booking.quoted)}</span></span><span class="app-kv"><span>Charged</span><span>${money(ui.booking.charged)}</span></span></div>`;
        if (ui.error) body += `<p class="app-msg" data-tone="fail">${esc(ui.error)}</p>`;
        SDL.ui.phone.paint(ph, { head: '<div><p class="app-title">RideNow</p><p class="app-sub">Prices update with demand</p></div>', body }, live);

        el.querySelectorAll('.ops-tbtn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === (st.event === 'normal' || sim.now >= st.eventUntil ? 'normal' : st.event))));
        const tiles = ZONE_IDS.map((z) => {
          const m = st.store.mult[z] || 1;
          const c = st.calc[z] || { demand: 0, supply: 0 };
          const h = st.history[z];
          const pts = h.map((v, i) => `${(i / Math.max(1, h.length - 1)) * 100},${30 - ((v - 1) / 2) * 28}`).join(' ');
          const tone = c.unknown ? 'muted' : m >= 2 ? 'fail' : m > 1 ? 'warn' : 'ok';
          return `<div class="surge-tile" data-tone="${tone}">
            <div class="surge-head"><strong>${ZONES[z].label}</strong><span class="surge-mult">${c.unknown ? '?' : m.toFixed(1) + '×'}</span></div>
            <svg class="surge-spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>
            <span class="surge-meta">Demand ${c.demand}, supply ${c.supply}${c.unknown ? ', no supply data' : ''}</span>
          </div>`;
        }).join('');
        SDL.ui.paintSections(el.querySelector('[data-ref="tiles"]'), { tiles }, {});
      },
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
