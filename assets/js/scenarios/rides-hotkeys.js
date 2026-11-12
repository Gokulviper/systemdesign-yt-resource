/*
 * Deep dive: hot keys and geo sharding.
 *
 * Four geo shards, each owning one zone of the city, each with real capacity
 * (one worker, 16 ms per request, so about 60 requests/s). Nothing is broken:
 * the hot key emerges when flights land and airport traffic concentrates on
 * the one shard that owns the airport.
 *
 * Five mitigations, each a design switch:
 *  coalesce  drop pings from drivers who have not moved (cuts writes)
 *  split     split the airport into sub-cells spread over all shards
 *  replica   send airport reads to a read replica (writes still hit the primary)
 *  cache     cache nearby-driver results for 500 ms (reads only)
 *  shed      router drops low-priority pings when a shard is backed up
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;

  const ZONES = {
    north: { label: 'North', shard: 'shardA' },
    downtown: { label: 'Downtown', shard: 'shardB' },
    airport: { label: 'Airport', shard: 'shardC' },
    south: { label: 'South', shard: 'shardD' },
  };
  const SHARDS = ['shardA', 'shardB', 'shardC', 'shardD'];
  const TRAFFIC = {
    normal: { label: 'Normal day', airportPings: 6, airportSearches: 2 },
    flight: { label: '1 flight landed', airportPings: 40, airportSearches: 12 },
    rush: { label: '3 flights landed', airportPings: 85, airportSearches: 24 },
  };
  const CITY_PINGS = 16;
  const CITY_SEARCHES = 3;
  const CITY_ZONES = ['north', 'downtown', 'south'];
  const FRESH_MS = 5000;
  const CACHE_TTL = 500;
  const SHED_WAIT = 120;
  const REPLICA_LAG = 200;
  const ms = (v) => `${Math.round(v).toLocaleString('en-US')} ms`;

  function routeWrite(st, zone, driver) {
    if (zone === 'airport' && st.config.split) return SHARDS[(parseInt(driver.replace(/\D/g, ''), 10) || 0) % 4];
    return ZONES[zone].shard;
  }

  /** One nearby-driver search, from your phone or another rider. */
  function* searchFlow(ctx, zone, mine) {
    const t0 = ctx.now();
    const r = yield ctx.call('gateway', 'nearby', { zone }, { timeout: 2500, quiet: mine ? false : 'all' });
    ctx.sim.recordOutcome(r.ok, ctx.now() - t0);
    return r;
  }

  function startPhoneSearch(sim) {
    const zone = sim.ui.phone.zone;
    sim.startAction('Rider: find a ride', function* (ctx) {
      const ui = ctx.ui.phone;
      ui.searching = true;
      ctx.ledger('displayed', 'pending', 'Shows “Looking for drivers…”.');
      ctx.ledger('committed', 'n/a', 'A search is a read; nothing is written.');
      ctx.ledger('async', 'n/a');
      ctx.ledger('retrySafe', 'yes', 'Reads are safe to retry.');
      const t0 = ctx.now();
      const r = yield* searchFlow(ctx, zone, true);
      ui.searching = false;
      const took = ctx.now() - t0;
      const st = ctx.state;
      const waitC = ctx.sim.queueWait('shardC');
      if (r.ok) {
        ui.result = { ok: true, count: r.value.count, took, source: r.value.source, zone };
        ctx.ledger('displayed', 'yes', `Shows ${r.value.count} drivers after ${ms(took)}.`);
        ctx.ledger('accepted', 'yes');
        const fixes = Object.entries(st.config).filter(([, v]) => v).map(([k]) => k);
        ctx.explain(
          zone === 'airport'
            ? `The search took ${ms(took)} and was answered by ${r.value.source}. ` +
              (waitC > 300 && !st.config.split
                ? `The airport shard has a ${ms(waitC)} queue: every ping and search for the airport lands on that one shard while the other three sit idle. That is a hot key.`
                : fixes.length
                  ? `Active mitigations: ${fixes.join(', ')}. The airport shard’s queue is ${ms(waitC)}.`
                  : 'Traffic is light, so the airport shard keeps up.')
            : `The search took ${ms(took)}. ${ZONES[zone].label} lives on ${sim.nodes[ZONES[zone].shard].label}, which is not affected by airport traffic${st.config.split ? '' : ' unless the airport is split across shards'}.`
        );
      } else {
        ui.result = { ok: false, error: r.error, took, zone };
        ctx.ledger('displayed', 'no', `Shows “Couldn’t find drivers” (${r.error.code}).`);
        ctx.ledger('accepted', 'no', null, { ifPending: true });
        ctx.explain(`The search failed with ${r.error.code} after ${ms(took)}. ${r.error.code === 'TIMEOUT' ? 'It waited in the airport shard’s queue behind hundreds of location pings until the caller gave up.' : r.error.message}`);
      }
    }, { self: 'rider', detail: `Rider tapped “Find a ride” at ${ZONES[zone].label}.` });
  }

  const sc = (SDL.scenarios['rides-hotkeys'] = {
    id: 'rides-hotkeys',
    seed: 23,
    productWidth: 600,
    intro: 'Land flights at the airport with the traffic buttons, then tap “Find a ride” on the phone. Watch the airport shard’s queue grow while the others idle, then try each mitigation in Design switches.',
    topology: {
      width: 1160,
      height: 650,
      nodes: [
        { id: 'rider', label: 'Your rider app', sub: 'Phone in the sidebar', kind: 'client', x: 100, y: 80, latency: 1, role: 'Searches for nearby drivers when you tap “Find a ride”.', owns: ['Nothing'] },
        { id: 'crowd', label: 'Other riders', sub: 'Background searches', kind: 'client', x: 100, y: 240, latency: 1, role: 'Every other rider in the city searching for drivers. Airport searches rise when flights land.', owns: ['Nothing'] },
        { id: 'fleet', label: 'Driver phones', sub: 'Background pings', kind: 'client', x: 100, y: 430, latency: 1, role: 'Every driver’s phone sending GPS pings. Drivers queued at the airport barely move but keep pinging.', owns: ['GPS positions'] },
        { id: 'gateway', label: 'API gateway', sub: 'Rider traffic', kind: 'gateway', x: 330, y: 160, latency: 2, role: 'Routes rider searches to the nearby-search service.', ops: [{ name: 'nearby', desc: 'Forward a search.' }], owns: ['Nothing durable'] },
        { id: 'location', label: 'Location ingest', sub: 'Accepts pings', kind: 'service', x: 330, y: 430, latency: 3, role: 'Accepts pings and forwards them as writes. With coalescing on, drops pings from drivers who have not moved.', ops: [{ name: 'ping', desc: 'One driver position.' }], owns: ['Last forwarded position per driver'] },
        { id: 'dispatch', label: 'Nearby search', sub: 'Reads the geo index', kind: 'service', x: 560, y: 160, latency: 3, role: 'Answers “which drivers are near here?”. With caching on, reuses a result for 500 ms.', ops: [{ name: 'nearby', desc: 'Count fresh drivers in a zone.' }], owns: ['Nothing durable'] },
        { id: 'cache', label: 'Nearby cache', sub: '500 ms results', kind: 'cache', x: 790, y: 80, latency: 2, role: 'Short-lived cache of search results, keyed by zone.', ops: [{ name: 'get', desc: 'Cached result if younger than 500 ms.' }, { name: 'set', desc: 'Store a result.' }], owns: ['result[zone]'] },
        { id: 'router', label: 'Shard router', sub: 'Zone → shard', kind: 'gateway', x: 620, y: 330, latency: 2, role: 'Maps each zone (or sub-cell) to the shard that owns it. With shedding on, drops low-priority pings for a backed-up shard.', ops: [{ name: 'write', desc: 'Route a ping.' }, { name: 'search', desc: 'Route a search to one or more shards.' }], owns: ['Shard map'] },
        { id: 'replica', label: 'Airport replica', sub: 'Read-only copy', kind: 'cache', x: 1030, y: 330, latency: 3, serviceMs: 16, role: 'A read-only copy of the airport shard. Serves searches; lags the primary by at least 200 ms.', ops: [{ name: 'nearby', desc: 'Search the copy.' }], owns: ['Copy of airport drivers'] },
        { id: 'shardA', label: 'Shard A', sub: 'Owns North', kind: 'db', x: 380, y: 575, latency: 3, serviceMs: 16, role: 'Geo index shard owning the North zone. One worker, 16 ms per request: about 60 requests per second.', ops: [{ name: 'upsert', desc: 'Store a driver position.' }, { name: 'nearby', desc: 'Count drivers in a zone.' }], owns: ['Drivers in North'] },
        { id: 'shardB', label: 'Shard B', sub: 'Owns Downtown', kind: 'db', x: 600, y: 575, latency: 3, serviceMs: 16, role: 'Geo index shard owning Downtown. Same capacity as every shard.', ops: [{ name: 'upsert', desc: 'Store a driver position.' }, { name: 'nearby', desc: 'Count drivers in a zone.' }], owns: ['Drivers in Downtown'] },
        { id: 'shardC', label: 'Shard C', sub: 'Owns Airport', kind: 'db', x: 820, y: 575, latency: 3, serviceMs: 16, role: 'Geo index shard owning the airport. This is where the hot key lands.', ops: [{ name: 'upsert', desc: 'Store a driver position.' }, { name: 'nearby', desc: 'Count drivers in a zone.' }], owns: ['Drivers at the Airport'] },
        { id: 'shardD', label: 'Shard D', sub: 'Owns South', kind: 'db', x: 1040, y: 575, latency: 3, serviceMs: 16, role: 'Geo index shard owning South.', ops: [{ name: 'upsert', desc: 'Store a driver position.' }, { name: 'nearby', desc: 'Count drivers in a zone.' }], owns: ['Drivers in South'] },
      ],
      edges: [
        { from: 'rider', to: 'gateway', latency: 30 },
        { from: 'crowd', to: 'gateway', latency: 30 },
        { from: 'fleet', to: 'location', latency: 30, label: 'pings' },
        { from: 'gateway', to: 'dispatch', latency: 5 },
        { from: 'dispatch', to: 'cache', latency: 4 },
        { from: 'dispatch', to: 'router', latency: 4 },
        { from: 'location', to: 'router', latency: 4 },
        { from: 'router', to: 'shardA', latency: 4 },
        { from: 'router', to: 'shardB', latency: 4 },
        { from: 'router', to: 'shardC', latency: 4 },
        { from: 'router', to: 'shardD', latency: 4 },
        { from: 'router', to: 'replica', latency: 4 },
        { from: 'shardC', to: 'replica', latency: 10, label: 'replication' },
      ],
    },

    failures: [
      { id: 'c-down', node: 'shardC', mode: 'down', label: 'Airport shard down', desc: 'Airport pings are lost. Searches fail unless the replica can serve them.' },
      { id: 'b-down', node: 'shardB', mode: 'down', label: 'Downtown shard down', desc: 'Only Downtown is affected. Other zones keep working.' },
      { id: 'replica-down', node: 'replica', mode: 'down', label: 'Airport replica down', desc: 'Reads fall back to the primary airport shard.' },
      { id: 'cache-down', node: 'cache', mode: 'down', label: 'Nearby cache down', desc: 'Every search goes to the shards.' },
      { id: 'router-slow', node: 'router', mode: 'slow', params: { factor: 20 }, label: 'Shard router slow', desc: 'Adds latency to every ping and search.' },
    ],

    switches: [
      { id: 'coalesce', label: 'Coalesce pings from parked drivers', desc: 'Drivers queued at the airport barely move. Skip their pings unless they moved or 3 s passed.', get: (s) => s.state.config.coalesce, set: (s, on) => { s.state.config.coalesce = on; } },
      { id: 'split', label: 'Split the airport across all shards', desc: 'Four airport sub-cells, one per shard. Airport searches query two sub-cells.', get: (s) => s.state.config.split, set: (s, on) => { s.state.config.split = on; } },
      { id: 'replica', label: 'Read replica for the airport', desc: 'Airport searches read a replica. Writes still hit the primary.', get: (s) => s.state.config.replica, set: (s, on) => { s.state.config.replica = on; } },
      { id: 'cache', label: 'Cache search results for 500 ms', desc: 'Repeated searches for the same zone skip the shards.', get: (s) => s.state.config.cache, set: (s, on) => { s.state.config.cache = on; } },
      { id: 'shed', label: 'Shed low-priority pings under load', desc: `Drop pings for a shard whose queue exceeds ${SHED_WAIT} ms. Searches are never shed.`, get: (s) => s.state.config.shed, set: (s, on) => { s.state.config.shed = on; } },
    ],

    presets: (function () {
      const base = (sim, traffic, sw) => {
        sim.restoreAll();
        for (const id of ['coalesce', 'split', 'replica', 'cache', 'shed']) sim.do('setSwitch', { id, on: !!(sw && sw[id]) });
        sim.do('setTraffic', { level: traffic });
        sim.ui.phone.zone = 'airport';
        sim.schedule(2500, () => startPhoneSearch(sim));
      };
      return [
        { id: 'normal', label: 'Normal day', desc: 'Light traffic everywhere. Every shard keeps up; a search takes about 200 ms.', run: (s) => base(s, 'normal') },
        { id: 'flight', label: 'One flight lands', desc: 'Airport traffic jumps to about 50 requests/s. Shard C runs near capacity; the others idle.', run: (s) => base(s, 'flight') },
        { id: 'rush', label: 'Three flights land (hot key)', desc: 'About 110 requests/s for the airport against a 60/s shard. Its queue grows every second and searches time out.', run: (s) => base(s, 'rush') },
        { id: 'fix-coalesce', label: 'Fix: coalesce parked pings', desc: 'Queued airport drivers stop flooding the shard. Writes drop by about 80%.', run: (s) => base(s, 'rush', { coalesce: true }) },
        { id: 'fix-split', label: 'Fix: split the airport', desc: 'Airport load spreads over four shards. Each carries about a quarter.', run: (s) => base(s, 'rush', { split: true }) },
        { id: 'fix-reads', label: 'Fix reads only: replica and cache', desc: 'Searches get fast, but pings still overload shard C. Read fixes do not cure a write hot key.', run: (s) => base(s, 'rush', { replica: true, cache: true }) },
        { id: 'fix-shed', label: 'Fix: shed pings under load', desc: 'Shard C stays usable by dropping low-priority pings. The cost: airport positions get staler.', run: (s) => base(s, 'rush', { shed: true }) },
        { id: 'fix-all', label: 'All mitigations together', desc: 'Coalescing, splitting, a replica, caching, and shedding as a backstop.', run: (s) => base(s, 'rush', { coalesce: true, split: true, replica: true, cache: true, shed: true }) },
        { id: 'shard-down', label: 'Airport shard fails', desc: 'Shard C fails 1.5 s in. Searches keep working from the replica, but its copy freezes: positions age and drivers drop out after 5 s.', run: (s) => { base(s, 'normal', { replica: true }); s.schedule(1500, () => s.inject('shardC', 'down')); } },
      ];
    })(),

    initialState: () => ({
      config: { coalesce: false, split: false, replica: false, cache: false, shed: false },
      traffic: 'normal',
      index: { shardA: {}, shardB: {}, shardC: {}, shardD: {} },
      replica: {},
      replicaAppliedAt: 0,
      lastSent: {},
      cache: {},
      acc: { cityPing: 0, airportPing: 0, citySearch: 0, airportSearch: 0 },
      seq: { ping: 0, search: 0 },
      stats: { pings: 0, coalesced: 0, shed: 0, lostWrites: 0 },
    }),
    initialUI: () => ({ phone: { zone: 'airport', searching: false, result: null } }),

    actions: {
      setTraffic(sim, a) {
        sim.state.traffic = a.level;
        sim.note(`Traffic set to “${TRAFFIC[a.level].label}”: about ${TRAFFIC[a.level].airportPings + TRAFFIC[a.level].airportSearches} airport requests per second.`);
      },
      find(sim) { startPhoneSearch(sim); },
      phoneZone(sim, a) { sim.ui.phone.zone = a.value; sim.ui.phone.result = null; },
    },

    handlers: {
      gateway: { nearby: function* (ctx, p) { return ctx.must(yield ctx.call('dispatch', 'nearby', p, { timeout: 2300 })); } },
      dispatch: {
        nearby: function* (ctx, p) {
          const st = ctx.state;
          if (st.config.cache) {
            const c = yield ctx.call('cache', 'get', { zone: p.zone }, { timeout: 200 });
            if (c.ok && c.value.hit) { ctx.count('cacheHit'); return Object.assign({}, c.value.result, { source: 'the nearby cache' }); }
            ctx.count('cacheMiss');
          }
          const r = ctx.must(yield ctx.call('router', 'search', p, { timeout: 2100 }));
          if (st.config.cache) yield ctx.call('cache', 'set', { zone: p.zone, result: r }, { timeout: 200 });
          return r;
        },
      },
      cache: {
        get(ctx, p) {
          const e = ctx.state.cache[p.zone];
          return e && ctx.now() - e.t < CACHE_TTL ? { hit: true, result: e.result } : { hit: false };
        },
        set(ctx, p) { ctx.state.cache[p.zone] = { t: ctx.now(), result: p.result }; return { stored: true }; },
      },
      location: {
        ping: function* (ctx, p) {
          const st = ctx.state;
          st.stats.pings++;
          if (st.config.coalesce && !p.moving) {
            const last = st.lastSent[p.driver];
            if (last != null && ctx.now() - last < 3000) { st.stats.coalesced++; return { coalesced: true }; }
          }
          st.lastSent[p.driver] = ctx.now();
          return ctx.must(yield ctx.call('router', 'write', p, { timeout: 2000 }));
        },
      },
      router: {
        write: function* (ctx, p) {
          const st = ctx.state;
          const shard = routeWrite(st, p.zone, p.driver);
          if (st.config.shed && ctx.sim.queueWait(shard) > SHED_WAIT) { st.stats.shed++; return { shed: true, shard }; }
          const r = yield ctx.call(shard, 'upsert', p, { timeout: 1900 });
          if (!r.ok) st.stats.lostWrites++;
          return ctx.must(r);
        },
        search: function* (ctx, p) {
          const st = ctx.state;
          if (p.zone === 'airport' && st.config.split) {
            const n = ++st.seq.search;
            const targets = [SHARDS[n % 4], SHARDS[(n + 1) % 4]];
            const subs = targets.map((sh) => ctx.spawn(function* (c) { return c.must(yield c.call(sh, 'nearby', p, { timeout: 1900 })); }));
            const rs = yield ctx.join(subs);
            const bad = rs.find((x) => !x.ok);
            if (bad) ctx.fail(bad.error.code, bad.error.message);
            return { count: rs.reduce((a, x) => a + x.value.count, 0), source: `two sub-cells on ${targets.map((t) => ctx.sim.nodes[t].label).join(' and ')}` };
          }
          if (p.zone === 'airport' && st.config.replica && !ctx.sim.nodes.replica.modes.down) {
            const r = ctx.must(yield ctx.call('replica', 'nearby', p, { timeout: 1900 }));
            return Object.assign(r, { source: 'the airport read replica' });
          }
          const shard = ZONES[p.zone].shard;
          const r = yield ctx.call(shard, 'nearby', p, { timeout: 1900 });
          if (!r.ok && p.zone === 'airport' && st.config.replica && r.error.code === 'UNAVAILABLE') {
            const f = ctx.must(yield ctx.call('replica', 'nearby', p, { timeout: 1900 }));
            return Object.assign(f, { source: 'the replica, because shard C is down' });
          }
          return Object.assign(ctx.must(r), { source: ctx.sim.nodes[shard].label });
        },
      },
      shardA: shardHandlers('shardA'),
      shardB: shardHandlers('shardB'),
      shardC: shardHandlers('shardC'),
      shardD: shardHandlers('shardD'),
      replica: {
        nearby(ctx, p) {
          const fresh = Object.values(ctx.state.replica).filter((d) => d.zone === p.zone && ctx.now() - d.t < FRESH_MS);
          return { count: fresh.length };
        },
      },
    },

    setup(sim) {
      // Background drivers: steady city pings plus airport pings at the traffic level.
      sim.spawn(function* (ctx) {
        for (;;) {
          const st = ctx.state;
          const t = TRAFFIC[st.traffic];
          st.acc.cityPing += CITY_PINGS * 0.05;
          st.acc.airportPing += t.airportPings * 0.05;
          while (st.acc.cityPing >= 1) {
            st.acc.cityPing -= 1;
            const n = ++st.seq.ping;
            const p = { driver: 'c' + (n % 20), zone: CITY_ZONES[n % 3], moving: true, sentAt: ctx.now() };
            ctx.spawn(function* (c) { yield c.call('location', 'ping', p, { timeout: 2000, quiet: 'all' }); }, { quiet: 'all' });
          }
          while (st.acc.airportPing >= 1) {
            st.acc.airportPing -= 1;
            const n = ++st.seq.ping;
            const p = { driver: 'q' + (n % 30), zone: 'airport', moving: n % 10 === 0, sentAt: ctx.now() };
            ctx.spawn(function* (c) { yield c.call('location', 'ping', p, { timeout: 2000, quiet: 'all' }); }, { quiet: 'all' });
          }
          yield ctx.wait(50);
        }
      }, { self: 'fleet', quiet: 'all' });
      // Background riders: searches, more at the airport when flights land.
      sim.spawn(function* (ctx) {
        for (;;) {
          const st = ctx.state;
          const t = TRAFFIC[st.traffic];
          st.acc.citySearch += CITY_SEARCHES * 0.05;
          st.acc.airportSearch += t.airportSearches * 0.05;
          while (st.acc.citySearch >= 1) {
            st.acc.citySearch -= 1;
            const zone = CITY_ZONES[++st.seq.search % 3];
            ctx.spawn((c) => searchFlow(c, zone, false), { quiet: 'all' });
          }
          while (st.acc.airportSearch >= 1) {
            st.acc.airportSearch -= 1;
            ctx.spawn((c) => searchFlow(c, 'airport', false), { quiet: 'all' });
          }
          yield ctx.wait(50);
        }
      }, { self: 'crowd', quiet: 'all' });
    },

    consistency(sim) {
      const st = sim.state;
      if (st.stats.lostWrites > 0 && sim.nodes.shardC.modes.down) return { key: 'stale', label: `${st.stats.lostWrites} pings could not be stored while a shard was down; those positions are going stale.` };
      if (st.config.shed && st.stats.shed > 0) return { key: 'stale', label: `${st.stats.shed} pings shed so far. Searches stay fast, but some airport positions are older than usual.` };
      const lag = (entries) => {
        const sent = entries.filter((d) => d.zone === 'airport' && d.sent != null).map((d) => d.sent);
        return sent.length ? sim.now - Math.max(...sent) : 0;
      };
      const primary = Object.values(st.index).reduce((a, sh) => a.concat(Object.values(sh)), []);
      const pLag = lag(primary);
      if (pLag > 1000) return { key: 'stale', label: `The newest airport position in the index was sent ${ms(pLag)} ago. Pings wait so long in the hot shard’s queue that dispatch sees where drivers were, not where they are.` };
      if (st.config.replica) {
        const rLag = lag(Object.values(st.replica));
        if (rLag > 1000) return { key: 'stale', label: `The airport replica’s newest position is ${ms(rLag)} old. Searches are fast but read stale data.` };
      }
      return { key: 'ok', label: 'Every accepted ping is stored on its shard.' };
    },

    metrics(snap, sim) {
      const st = sim.state;
      const out = SHARDS.map((s) => {
        const w = sim.queueWait(s);
        return { label: `${sim.nodes[s].label} queue`, value: ms(w), tone: w > 500 ? 'fail' : w > 80 ? 'warn' : 'ok' };
      });
      out.push({ label: 'Airport traffic', value: TRAFFIC[st.traffic].label, tone: st.traffic === 'rush' ? 'fail' : st.traffic === 'flight' ? 'warn' : '' });
      out.push({ label: 'Pings coalesced', value: st.stats.coalesced });
      out.push({ label: 'Pings shed', value: st.stats.shed, tone: st.stats.shed ? 'warn' : '' });
      return out;
    },

    product: {
      mount(el, sim) {
        el.innerHTML = `
          <p class="panel-note phones-note">Set the airport traffic, then search from the phone. The shard bars show how long a new request would wait on each shard right now.</p>
          <div class="hk-wrap">
            ${SDL.ui.phone.frame('rider', 'Rider phone')}
            <div class="ops-console" data-ref="ops">
              <p class="ops-title">Geo index operations</p>
              <div class="ops-traffic" role="group" aria-label="Airport traffic">
                ${Object.entries(TRAFFIC).map(([k, t]) => `<button class="btn ops-tbtn" data-act="setTraffic" data-arg='{"level":"${k}"}' data-level="${k}">${t.label}</button>`).join('')}
              </div>
              <div class="ops-shards" data-ref="shards"></div>
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
        const ph = el.querySelector('.phone');
        const ui = sim.ui.phone;
        SDL.ui.phone.render(ph, sim, 'rider', null, !!sim.nodes.rider.modes.down);
        let body = `<div class="app-row"><label for="hz">You’re at</label><select id="hz" data-field="zone"${ui.searching ? ' disabled' : ''}>${Object.entries(ZONES).map(([k, z]) => `<option value="${k}"${k === ui.zone ? ' selected' : ''}>${z.label}</option>`).join('')}</select></div>
          <button class="app-btn" data-act="find"${ui.searching ? ' disabled' : ''}>${ui.searching ? '<span class="spinner"></span>Looking for drivers…' : 'Find a ride'}</button>`;
        if (ui.result && ui.result.ok) body += `<div class="app-card ${ui.result.took > 1000 ? 'is-hot' : 'is-ok'}"><strong>${ui.result.count} drivers nearby</strong><span class="app-kv"><span>Search took</span><span>${ms(ui.result.took)}</span></span><span class="app-sub">Answered by ${esc(ui.result.source)}</span></div>`;
        if (ui.result && !ui.result.ok) body += `<div class="app-card is-fail"><strong>Couldn’t find drivers</strong><span class="app-sub">${esc(ui.result.error.code)} after ${ms(ui.result.took)}. Try again.</span></div>`;
        SDL.ui.phone.paint(ph, { head: '<div><p class="app-title">RideNow</p><p class="app-sub">Arriving travellers welcome</p></div>', body }, {});
        // operations console
        const st = sim.state;
        el.querySelectorAll('.ops-tbtn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.level === st.traffic)));
        const owns = (s) => {
          const z = Object.entries(ZONES).filter(([, v]) => v.shard === s).map(([, v]) => v.label);
          if (st.config.split && s !== 'shardC') z.push('¼ Airport');
          if (st.config.split && s === 'shardC') return ['¼ Airport'];
          return z;
        };
        const rows = SHARDS.concat(st.config.replica ? ['replica'] : []).map((s) => `
          <div class="ops-row" data-shard="${s}">
            <div class="ops-name"><strong>${esc(sim.nodes[s].label)}</strong><span>${esc(s === 'replica' ? 'Airport reads' : owns(s).join(', '))}</span></div>
            <div class="ops-bar"><i data-live-width="w-${s}"></i></div>
            <span class="ops-val" data-live="v-${s}"></span>
          </div>`).join('');
        const live = {};
        for (const s of SHARDS.concat(['replica'])) {
          const w = sim.queueWait(s);
          live[`w-${s}`] = `${Math.min(100, (w / 2000) * 100)}%`;
          live[`v-${s}`] = sim.nodes[s].modes.down ? 'down' : `${ms(w)} wait`;
        }
        const opsEl = el.querySelector('[data-ref="shards"]');
        SDL.ui.paintSections(opsEl, { rows }, live);
        opsEl.querySelectorAll('.ops-row').forEach((r) => {
          const w = sim.queueWait(r.dataset.shard);
          r.dataset.tone = sim.nodes[r.dataset.shard].modes.down ? 'fail' : w > 500 ? 'fail' : w > 80 ? 'warn' : 'ok';
        });
      },
    },
  });

  function shardHandlers(shard) {
    return {
      upsert(ctx, p) {
        const st = ctx.state;
        st.index[shard][p.driver] = { zone: p.zone, t: ctx.now(), sent: p.sentAt };
        if (shard === 'shardC' || (p.zone === 'airport')) {
          // Asynchronous replication to the airport replica.
          const sim = ctx.sim;
          const copy = { zone: p.zone, t: ctx.now(), sent: p.sentAt };
          sim.schedule(REPLICA_LAG, () => {
            if (sim.nodes.replica.modes.down) return;
            st.replica[p.driver] = copy;
            st.replicaAppliedAt = sim.now;
          });
        }
        return { stored: true };
      },
      nearby(ctx, p) {
        const fresh = Object.values(ctx.state.index[shard]).filter((d) => d.zone === p.zone && ctx.now() - d.t < FRESH_MS);
        return { count: fresh.length };
      },
    };
  }
  sc.TRAFFIC = TRAFFIC;
})(typeof window !== 'undefined' ? window : globalThis);
