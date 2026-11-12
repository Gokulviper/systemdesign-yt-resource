/*
 * Deep dive: ETA and routing.
 *
 * A road graph of 8 × 6 intersections. Main Street (row 2) and Fourth Avenue
 * (column 4) are fast; other streets are slow. The routing engine runs
 * Dijkstra over estimated speeds. Traffic speeds are estimated from driver GPS
 * probes. Every ETA is also compared with the "actual" drive time computed
 * from the true speeds, so accuracy is measurable.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;

  const W = 8;
  const H = 6;
  const PLACES = {
    home: { label: 'Home', x: 0, y: 5 }, office: { label: 'Office', x: 7, y: 0 }, mall: { label: 'Mall', x: 3, y: 1 },
    stadium: { label: 'Stadium', x: 6, y: 4 }, station: { label: 'Station', x: 1, y: 1 }, park: { label: 'Park', x: 4, y: 5 },
  };
  const POPULAR = [['home', 'office'], ['station', 'stadium'], ['mall', 'park'], ['home', 'mall'], ['office', 'park'], ['station', 'office'], ['stadium', 'home'], ['park', 'station']];
  const BLOCK_KM = 0.5;
  const CACHE_TTL = 30000;
  const CLOSED = ['v-4-2', 'v-4-3'];
  const key = (x, y) => `${x},${y}`;

  const EDGES = {};
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) EDGES[`h-${x}-${y}`] = { a: key(x, y), b: key(x + 1, y), base: y === 2 ? 50 : 25, x1: x, y1: y, x2: x + 1, y2: y };
  for (let x = 0; x < W; x++) for (let y = 0; y < H - 1; y++) EDGES[`v-${x}-${y}`] = { a: key(x, y), b: key(x, y + 1), base: x === 4 ? 50 : 25, x1: x, y1: y, x2: x, y2: y + 1 };
  const EDGE_IDS = Object.keys(EDGES);
  const minutes = (speed) => (BLOCK_KM / speed) * 60;

  function trueSpeed(st, id) {
    const e = EDGES[id];
    let s = e.base;
    if (st.world.jam && id.startsWith('h-') && e.y1 === 2 && e.x1 >= 1 && e.x1 <= 5) s *= 0.12;
    return s;
  }
  /** Dijkstra over the given speeds, skipping closed edges. */
  function route(from, to, speeds, closed) {
    const dist = {};
    const prev = {};
    const done = new Set();
    dist[from] = 0;
    for (;;) {
      let u = null;
      for (const k of Object.keys(dist)) if (!done.has(k) && (u === null || dist[k] < dist[u])) u = k;
      if (u === null || u === to) break;
      done.add(u);
      for (const id of EDGE_IDS) {
        const e = EDGES[id];
        if (closed.includes(id) || (e.a !== u && e.b !== u)) continue;
        const v = e.a === u ? e.b : e.a;
        const d = dist[u] + minutes(speeds[id]);
        if (dist[v] === undefined || d < dist[v]) { dist[v] = d; prev[v] = [u, id]; }
      }
    }
    const path = [];
    let c = to;
    while (prev[c]) { path.unshift(prev[c][1]); c = prev[c][0]; }
    return { minutes: Math.round(dist[to] * 10) / 10, path };
  }
  function actualMinutes(st, path) {
    let m = 0;
    for (const id of path) m += st.world.closed.includes(id) ? 15 : minutes(trueSpeed(st, id));
    return Math.round(m * 10) / 10;
  }
  const baseSpeeds = () => Object.fromEntries(EDGE_IDS.map((id) => [id, EDGES[id].base]));

  function* etaFlow(ctx, from, to, mine) {
    const t0 = ctx.now();
    const r = yield ctx.call('gateway', 'eta', { from, to }, { timeout: 2000, quiet: mine ? false : 'all' });
    ctx.sim.recordOutcome(r.ok, ctx.now() - t0);
    if (r.ok) {
      const st = ctx.state;
      const actual = r.value.path ? actualMinutes(st, r.value.path) : null;
      if (actual != null) { st.errors.push(Math.abs(r.value.minutes - actual) / actual); if (st.errors.length > 60) st.errors.shift(); }
      return Object.assign({ actual }, r.value);
    }
    return null;
  }

  function startEta(sim) {
    const ui = sim.ui.rider;
    const from = ui.from;
    const to = ui.to;
    sim.startAction(`Rider: ETA ${PLACES[from].label} to ${PLACES[to].label}`, function* (ctx) {
      const u = ctx.ui.rider;
      u.busy = true;
      ctx.ledger('displayed', 'pending');
      ctx.ledger('committed', 'n/a', 'An ETA is a read.');
      ctx.ledger('async', 'n/a');
      ctx.ledger('retrySafe', 'yes');
      const r = yield* etaFlow(ctx, from, to, true);
      u.busy = false;
      if (r) {
        u.result = r;
        ctx.ledger('displayed', 'yes', `Shows ${r.minutes} min (actual drive ${r.actual ?? '?'} min).`);
        ctx.ledger('accepted', 'yes');
        const err = r.actual ? Math.round(((r.minutes - r.actual) / r.actual) * 100) : null;
        const notes = {
          cache: 'It came from the route cache, so no routing work was done.',
          router: 'The routing engine ran a shortest-path search over the current speed estimates.',
          fallback: 'Routing was too slow, so the service returned a rough straight-line estimate instead of a route.',
        };
        ctx.explain(`${notes[r.source]} ${err == null ? '' : Math.abs(err) <= 15 ? `It is within ${Math.abs(err)}% of the actual drive time.` : `It is ${Math.abs(err)}% ${err < 0 ? 'too optimistic' : 'too pessimistic'}: predicted ${r.minutes} min, actual ${r.actual} min.`}`);
      } else {
        u.result = { error: true };
        ctx.ledger('displayed', 'no');
        ctx.ledger('accepted', 'no', null, { ifPending: true });
        ctx.explain('No ETA could be produced in time and the fallback is off.');
      }
    }, { self: 'rider' });
  }

  const sc = (SDL.scenarios['rides-eta'] = {
    id: 'rides-eta',
    seed: 97,
    productWidth: 640,
    intro: 'Pick two places and get an ETA; the route is drawn on both maps. Then cause a jam on Main Street and compare traffic-aware routing with free-flow routing, or turn on rush hour and watch the cache carry the load.',
    topology: {
      width: 1160,
      height: 600,
      nodes: [
        { id: 'rider', label: 'Rider app', sub: 'Asks for ETAs', kind: 'client', x: 100, y: 90, latency: 1, role: 'Asks for a route and arrival time.', owns: ['Nothing'] },
        { id: 'crowd', label: 'Other riders', sub: 'Rush-hour load', kind: 'client', x: 100, y: 300, latency: 1, role: 'Everyone else asking for ETAs, mostly between popular places.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Rider traffic', kind: 'gateway', x: 330, y: 90, latency: 2, role: 'Routes ETA requests.', ops: [{ name: 'eta', desc: 'Forward.' }], owns: ['Nothing durable'] },
        { id: 'eta', label: 'ETA service', sub: 'Cache, then route', kind: 'service', x: 560, y: 90, latency: 3, role: 'Checks the route cache, asks the routing engine on a miss, and falls back to a straight-line estimate if routing is too slow.', ops: [{ name: 'estimate', desc: 'Minutes and route between two places.' }], owns: ['Fallback rules'] },
        { id: 'cache', label: 'Route cache', sub: '30 s entries', kind: 'cache', x: 790, y: 90, latency: 2, role: 'Recent routes keyed by origin and destination, optionally also by traffic and map version.', ops: [{ name: 'get', desc: 'Cached route.' }, { name: 'set', desc: 'Store a route.' }], owns: ['route[from, to, version]'] },
        { id: 'router', label: 'Routing engine', sub: 'Shortest paths', kind: 'service', x: 560, y: 300, latency: 3, serviceMs: 40, servers: 2, role: 'Dijkstra over the road graph with current speed estimates. Each search costs about 40 ms; two workers give about 50 per second.', ops: [{ name: 'route', desc: 'Fastest path.' }], owns: ['Loaded copy of the road graph'] },
        { id: 'traffic', label: 'Traffic service', sub: 'Speed per road', kind: 'cache', x: 790, y: 300, latency: 2, role: 'Current estimated speed on every road segment, with a version that changes when traffic shifts.', ops: [{ name: 'speeds', desc: 'Snapshot of estimated speeds.' }], owns: ['speed[segment]', 'trafficVersion'] },
        { id: 'mapdata', label: 'Map data', sub: 'Road graph', kind: 'db', x: 330, y: 300, latency: 6, role: 'The authoritative road network, including closures.', ops: [{ name: 'graph', desc: 'Current graph and its version.' }], owns: ['roads', 'closures'] },
        { id: 'probes', label: 'Speed probes', sub: 'From driver GPS', kind: 'queue', x: 1020, y: 490, latency: 3, queue: 'probes', role: 'Speed samples from drivers’ GPS traces.', ops: [{ name: 'publish', desc: 'Append samples.' }], owns: ['probe log'] },
        { id: 'aggregator', label: 'Traffic aggregator', sub: 'Smooths probes', kind: 'worker', x: 790, y: 490, latency: 4, role: 'Turns probe samples into smoothed speed estimates and bumps the traffic version on big changes.', ops: [{ name: 'consume', desc: 'Update estimates.' }], owns: ['Its offset'] },
        { id: 'fleet', label: 'Driver phones', sub: 'GPS traces', kind: 'client', x: 1020, y: 300, latency: 1, role: 'Every driving car reports how fast it is moving on which road.', owns: ['GPS'] },
      ],
      edges: [
        { from: 'rider', to: 'gateway', latency: 30 },
        { from: 'crowd', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'eta', latency: 3 },
        { from: 'eta', to: 'cache', latency: 2 },
        { from: 'eta', to: 'router', latency: 3 },
        { from: 'router', to: 'traffic', latency: 2 },
        { from: 'router', to: 'mapdata', latency: 4 },
        { from: 'fleet', to: 'probes', latency: 25 },
        { from: 'probes', to: 'aggregator', latency: 3 },
        { from: 'aggregator', to: 'traffic', latency: 3 },
      ],
      queues: [{ id: 'probes', broker: 'probes', label: 'probes', groups: ['aggregator'] }],
    },

    failures: [
      { id: 'router-slow', node: 'router', mode: 'slow', params: { factor: 15 }, label: 'Routing engine slow', desc: 'Each search takes 15 times longer.' },
      { id: 'traffic-down', node: 'traffic', mode: 'down', label: 'Traffic service down', desc: 'Routing falls back to free-flow speeds and turns optimistic.' },
      { id: 'agg-paused', node: 'aggregator', mode: 'paused', label: 'Traffic aggregator stalled', desc: 'Estimates freeze while real traffic changes.' },
      { id: 'cache-down', node: 'cache', mode: 'down', label: 'Route cache down', desc: 'Every ETA needs a routing search.' },
      { id: 'map-down', node: 'mapdata', mode: 'down', label: 'Map data unavailable', desc: 'The routing engine keeps using the graph it already loaded.' },
    ],

    switches: [
      { id: 'cache', label: 'Route cache', desc: 'Reuse routes for repeated origin and destination pairs.', get: (s) => s.state.config.cache, set: (s, on) => { s.state.config.cache = on; } },
      { id: 'traffic', label: 'Traffic-aware routing', desc: 'Off: route on posted speed limits, as if roads were empty.', get: (s) => s.state.config.traffic, set: (s, on) => { s.state.config.traffic = on; } },
      { id: 'versioned', label: 'Cache keys include traffic and map version', desc: 'Off: a cached route survives a jam or a closure for its full 30 s.', get: (s) => s.state.config.versioned, set: (s, on) => { s.state.config.versioned = on; } },
      { id: 'fallback', label: 'Straight-line fallback when routing is slow', desc: 'Off: the rider waits, or gets nothing.', get: (s) => s.state.config.fallback, set: (s, on) => { s.state.config.fallback = on; } },
    ],

    presets: (function () {
      const base = (sim, sw, from, to) => {
        sim.restoreAll();
        const def = { cache: true, traffic: true, versioned: true, fallback: true };
        for (const [id, on] of Object.entries(Object.assign(def, sw || {}))) sim.do('setSwitch', { id, on });
        sim.do('world', { jam: false, closed: false, rush: false });
        Object.assign(sim.ui.rider, { from: from || 'home', to: to || 'office' });
      };
      return [
        { id: 'normal', label: 'A normal ETA', desc: 'Home to Office on empty roads: the route uses Main Street and is accurate.', run: (s) => { base(s); s.schedule(300, () => startEta(s)); } },
        { id: 'rush', label: 'Rush hour with the cache', desc: 'About 60 ETA requests per second, mostly popular pairs. The cache answers most; the routing engine stays calm.', run: (s) => { base(s); s.do('world', { rush: true }); s.schedule(2500, () => startEta(s)); } },
        { id: 'rush-nocache', label: 'Rush hour without the cache', desc: 'Every request needs a routing search. The engine saturates and ETAs fall back to rough estimates.', run: (s) => { base(s, { cache: false }); s.do('world', { rush: true }); s.schedule(2500, () => startEta(s)); } },
        { id: 'jam', label: 'Jam on Main Street, traffic-aware', desc: 'Probes reveal the jam; the next route avoids Main Street and stays accurate.', run: (s) => { base(s); s.do('world', { jam: true }); s.schedule(2500, () => startEta(s)); } },
        { id: 'jam-blind', label: 'Jam on Main Street, free-flow routing', desc: 'Routing ignores traffic: it sends the rider into the jam and promises an arrival time that is far too early.', run: (s) => { base(s, { traffic: false }); s.do('world', { jam: true }); s.schedule(2500, () => startEta(s)); } },
        { id: 'jam-cache', label: 'Cached route goes stale in a jam', desc: 'The route was cached before the jam, and the cache key ignores traffic version, so the stale route keeps being served.', run: (s) => { base(s, { versioned: false }); startEta(s); s.schedule(800, () => s.do('world', { jam: true })); s.schedule(3500, () => startEta(s)); } },
        { id: 'stale-traffic', label: 'Traffic data stalls', desc: 'The aggregator stops just as the jam begins. Routing still believes Main Street is clear.', run: (s) => { base(s); s.inject('aggregator', 'paused'); s.do('world', { jam: true }); s.schedule(2500, () => startEta(s)); } },
        { id: 'closure', label: 'Road closure', desc: 'Fourth Avenue closes. The map updates, the routing engine reloads, and the route detours.', run: (s) => { base(s, {}, 'mall', 'park'); s.do('world', { closed: true }); s.schedule(600, () => startEta(s)); } },
        { id: 'closure-stale', label: 'Closure, map data unavailable', desc: 'The routing engine cannot load the new map and routes through the closed road. The real drive takes a 15-minute detour.', run: (s) => { base(s, {}, 'mall', 'park'); s.inject('mapdata', 'down'); s.do('world', { closed: true }); s.schedule(600, () => startEta(s)); } },
      ];
    })(),

    initialState: () => ({
      config: { cache: true, traffic: true, versioned: true, fallback: true },
      world: { jam: false, closed: [], rush: false },
      map: { version: 1, closed: [] },
      routerMap: { version: 1, closed: [] },
      est: baseSpeeds(),
      trafficVersion: 1,
      cache: {},
      errors: [],
      acc: 0, probeTick: 0, seq: 0,
    }),
    initialUI: () => ({ rider: { from: 'home', to: 'office', busy: false, result: null } }),

    actions: {
      eta(sim) { startEta(sim); },
      pick(sim, a) { sim.ui.rider[a.field] = a.value; sim.ui.rider.result = null; },
      world(sim, a) {
        const st = sim.state;
        if (a.jam != null) { st.world.jam = a.jam; if (a.jam) sim.note('A crash on Main Street: traffic there crawls at about 6 km/h. Only probe data will reveal it.'); }
        if (a.closed != null) {
          st.world.closed = a.closed ? CLOSED.slice() : [];
          st.map = { version: st.map.version + 1, closed: st.world.closed.slice() };
          if (a.closed) sim.note('Fourth Avenue is closed between rows 2 and 4. The map is updated to a new version.');
        }
        if (a.rush != null) { st.world.rush = a.rush; if (a.rush) sim.note('Rush hour: about 60 ETA requests per second.'); }
      },
    },

    handlers: {
      gateway: { eta: function* (ctx, p) { return ctx.must(yield ctx.call('eta', 'estimate', p, { timeout: 1800 })); } },
      eta: {
        estimate: function* (ctx, p) {
          const st = ctx.state;
          const k = `${p.from}>${p.to}` + (st.config.versioned ? `@t${st.trafficVersion}@m${st.map.version}` : '');
          if (st.config.cache) {
            const c = yield ctx.call('cache', 'get', { key: k }, { timeout: 200 });
            if (c.ok && c.value.hit) { ctx.count('cacheHit'); return Object.assign({}, c.value.route, { source: 'cache' }); }
            ctx.count('cacheMiss');
          }
          const r = yield ctx.call('router', 'route', p, { timeout: 600 });
          if (r.ok) {
            if (st.config.cache) yield ctx.call('cache', 'set', { key: k, route: r.value }, { timeout: 200 });
            return Object.assign({}, r.value, { source: 'router' });
          }
          if (!st.config.fallback) ctx.must(r);
          const a = PLACES[p.from];
          const b = PLACES[p.to];
          const blocks = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
          return { minutes: Math.round(blocks * minutes(25) * 1.3 * 10) / 10, path: null, source: 'fallback' };
        },
      },
      cache: {
        get(ctx, p) { const e = ctx.state.cache[p.key]; return e && ctx.now() - e.t < CACHE_TTL ? { hit: true, route: e.route } : { hit: false }; },
        set(ctx, p) { ctx.state.cache[p.key] = { t: ctx.now(), route: p.route }; return { stored: true }; },
      },
      router: {
        route: function* (ctx, p) {
          const st = ctx.state;
          if (st.routerMap.version !== st.map.version) {
            const g = yield ctx.call('mapdata', 'graph', {}, { timeout: 300, quiet: true });
            if (g.ok) st.routerMap = g.value;
          }
          let speeds = baseSpeeds();
          if (st.config.traffic) {
            const t = yield ctx.call('traffic', 'speeds', {}, { timeout: 200, quiet: true });
            if (t.ok) speeds = t.value.speeds;
          }
          const a = PLACES[p.from];
          const b = PLACES[p.to];
          return route(key(a.x, a.y), key(b.x, b.y), speeds, st.routerMap.closed);
        },
      },
      traffic: { speeds(ctx) { return { speeds: Object.assign({}, ctx.state.est), version: ctx.state.trafficVersion }; } },
      mapdata: { graph(ctx) { return { version: ctx.state.map.version, closed: ctx.state.map.closed.slice() }; } },
      probes: { publish(ctx, p) { ctx.sim.enqueue('probes', { type: 'samples', payload: p, quiet: true }); return { appended: p.samples.length }; } },
    },

    setup(sim) {
      // Drivers report speeds on a rotating set of segments, Main Street included.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(300);
          const st = ctx.state;
          const samples = [];
          for (let i = 0; i < 6; i++) {
            const id = i < 2 ? `h-${1 + ((st.probeTick + i) % 5)}-2` : EDGE_IDS[(st.probeTick * 7 + i * 13) % EDGE_IDS.length];
            if (st.world.closed.includes(id)) continue;
            samples.push({ id, speed: trueSpeed(st, id) * (0.9 + 0.2 * ctx.rand()) });
          }
          st.probeTick++;
          yield ctx.call('probes', 'publish', { samples }, { timeout: 300, quiet: 'all' });
        }
      }, { self: 'fleet', quiet: 'all' });
      // Aggregator: smooth samples into estimates; bump the version on big changes.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('probes', 'aggregator');
          const st = ctx.state;
          let big = false;
          for (const s of msg.payload.samples) {
            const prev = st.est[s.id];
            const next = prev + 0.5 * (s.speed - prev);
            if (Math.abs(next - prev) / prev > 0.2) big = true;
            st.est[s.id] = next;
          }
          if (big) {
            st.trafficVersion++;
            if (st.trafficVersion % 3 === 0) ctx.log({ op: `traffic version ${st.trafficVersion}`, status: 'note', detail: 'Estimated speeds changed noticeably. Routes cached with older versions will no longer match.' });
          }
          ctx.ack('probes', 'aggregator');
        }
      }, { self: 'aggregator' });
      // Rush hour: other riders asking for popular routes.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(50);
          const st = ctx.state;
          if (!st.world.rush) continue;
          st.acc += 60 * 0.05;
          while (st.acc >= 1) {
            st.acc -= 1;
            const pair = POPULAR[++st.seq % POPULAR.length];
            ctx.spawn((c) => etaFlow(c, pair[0], pair[1], false), { quiet: 'all' });
          }
        }
      }, { self: 'crowd', quiet: 'all' });
    },

    consistency(sim) {
      const st = sim.state;
      if (st.routerMap.version !== st.map.version) return { key: 'stale', label: `The routing engine is on map version ${st.routerMap.version}; the current map is version ${st.map.version}. It can route through closed roads.` };
      const r = sim.ui.rider.result;
      if (r && r.actual && Math.abs(r.minutes - r.actual) / r.actual > 0.3) return { key: 'stale', label: `The last ETA promised ${r.minutes} min; the actual drive is ${r.actual} min.` };
      if (r && r.source === 'fallback') return { key: 'stale', label: 'The last ETA is a rough fallback estimate, not a computed route.' };
      return { key: 'ok', label: 'ETAs match real drive times within 30%.' };
    },

    metrics(snap, sim) {
      const st = sim.state;
      const avgErr = st.errors.length ? st.errors.reduce((a, b) => a + b, 0) / st.errors.length : null;
      const w = sim.queueWait('router');
      return [
        { label: 'Average ETA error (recent)', value: avgErr == null ? 'n/a' : `${Math.round(avgErr * 100)}%`, tone: avgErr > 0.3 ? 'fail' : avgErr > 0.15 ? 'warn' : 'ok' },
        { label: 'Routing engine queue', value: SDL.fmtMs(w), tone: w > 500 ? 'fail' : w > 100 ? 'warn' : 'ok' },
        { label: 'Traffic version', value: st.trafficVersion },
        { label: 'Main Street speed (estimated)', value: `${Math.round(st.est['h-3-2'])} km/h`, tone: st.est['h-3-2'] < 20 ? 'fail' : '' },
      ];
    },

    product: {
      mount(el, sim) {
        el.innerHTML = `
          <p class="panel-note phones-note">The phone shows the ETA and route. The traffic map shows what the system believes about each road (colour) and the route it picked (dark line).</p>
          <div class="hk-wrap">
            ${SDL.ui.phone.frame('rider', 'Rider phone')}
            <div class="ops-console">
              <p class="ops-title">Traffic map</p>
              <div class="ops-traffic" data-ref="world"></div>
              <div data-ref="map"></div>
              <p class="surge-meta">Colours show estimated speed: green near the limit, amber slow, red crawling. Hatched roads are closed.</p>
            </div>
          </div>`;
        SDL.ui.phone.wire(el.querySelector('.phone'));
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-act]');
          if (!b || b.disabled) return;
          sim.dispatch(b.dataset.act, b.dataset.arg ? JSON.parse(b.dataset.arg) : {});
        });
        el.addEventListener('change', (e) => { if (e.target.dataset.field) sim.dispatch('pick', { field: e.target.dataset.field, value: e.target.value }); });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.rider;
        const ph = el.querySelector('.phone');
        SDL.ui.phone.render(ph, sim, 'rider', null, false);
        const opts = (sel) => Object.entries(PLACES).map(([k, p]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${p.label}</option>`).join('');
        let body = `<div class="app-row"><label for="ef">From</label><select id="ef" data-field="from"${u.busy ? ' disabled' : ''}>${opts(u.from)}</select></div>
          <div class="app-row"><label for="et">To</label><select id="et" data-field="to"${u.busy ? ' disabled' : ''}>${opts(u.to)}</select></div>
          <button class="app-btn" data-act="eta"${u.busy || u.from === u.to ? ' disabled' : ''}>${u.busy ? '<span class="spinner"></span>Calculating…' : 'Get ETA'}</button>`;
        const r = u.result;
        if (r && !r.error) {
          const off = r.actual ? (r.minutes - r.actual) / r.actual : 0;
          body += `<div class="app-card ${Math.abs(off) > 0.3 || r.source === 'fallback' ? 'is-hot' : 'is-ok'}"><span class="app-kv"><strong>Arrive in</strong><span class="app-price">${Math.round(r.minutes)} min</span></span>
            <span class="app-kv"><span>Source</span><span>${{ cache: 'Route cache', router: 'Routing engine', fallback: 'Rough estimate' }[r.source]}</span></span>
            ${r.actual != null ? `<span class="app-kv"><span>Actual drive</span><span>${Math.round(r.actual)} min</span></span>` : '<span class="app-sub">No route: straight-line guess</span>'}</div>`;
        }
        if (r && r.error) body += '<div class="app-card is-fail"><strong>Couldn’t calculate an ETA</strong></div>';
        SDL.ui.phone.paint(ph, { head: '<div><p class="app-title">RideNow</p><p class="app-sub">Where to?</p></div>', body }, {});

        const world = `<button class="btn ops-tbtn" data-act="world" data-arg='{"jam":${!st.world.jam}}' aria-pressed="${st.world.jam}">Crash on Main Street</button>
          <button class="btn ops-tbtn" data-act="world" data-arg='{"closed":${!st.world.closed.length}}' aria-pressed="${!!st.world.closed.length}">Close Fourth Avenue</button>
          <button class="btn ops-tbtn" data-act="world" data-arg='{"rush":${!st.world.rush}}' aria-pressed="${st.world.rush}">Rush hour</button>`;
        SDL.ui.paintSections(el.querySelector('[data-ref="world"]'), { world }, {});
        const C = 46;
        const P = (v) => v * C + 18;
        const onPath = new Set(r && r.path ? r.path : []);
        let s = `<svg class="board" viewBox="0 0 ${(W - 1) * C + 36} ${(H - 1) * C + 36}" role="img" aria-label="Traffic map">`;
        for (const id of EDGE_IDS) {
          const e = EDGES[id];
          const ratio = st.est[id] / e.base;
          const cls = st.world.closed.includes(id) ? 'road-closed' : ratio < 0.35 ? 'road-red' : ratio < 0.75 ? 'road-amber' : 'road-green';
          s += `<line class="road ${cls}${e.base > 30 ? ' road-major' : ''}" x1="${P(e.x1)}" y1="${P(e.y1)}" x2="${P(e.x2)}" y2="${P(e.y2)}"/>`;
        }
        for (const id of onPath) { const e = EDGES[id]; s += `<line class="road-route" x1="${P(e.x1)}" y1="${P(e.y1)}" x2="${P(e.x2)}" y2="${P(e.y2)}"/>`; }
        for (const p of Object.values(PLACES)) s += `<circle class="road-place" cx="${P(p.x)}" cy="${P(p.y)}" r="5"/><text class="board-label" x="${P(p.x)}" y="${P(p.y) - 9}" text-anchor="middle">${esc(p.label)}</text>`;
        s += `<text class="board-label" x="${P(0.4)}" y="${P(2) + 13}">Main St</text><text class="board-label" x="${P(4) + 6}" y="${P(4.6)}">4th Ave</text></svg>`;
        SDL.ui.paintSections(el.querySelector('[data-ref="map"]'), { map: s }, {});
      },
    },
  });
  sc.route = route;
})(typeof window !== 'undefined' ? window : globalThis);
