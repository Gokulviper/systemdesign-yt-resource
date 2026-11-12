/*
 * Deep dive: driver location tracking.
 *
 * One ping takes two paths:
 *  fast path   location service → geo index (latest position, for dispatch)
 *              and → realtime gateway → rider phone (live tracking)
 *  durable path location stream → trail writer → trip trail store (every point,
 *              for receipts, fare disputes, and safety)
 *
 * Mechanisms: phone-side buffering while offline, timestamp checks against
 * out-of-order pings, adaptive ping rate when parked, skipping unchanged
 * positions at the server, and TTL-based staleness for dispatch.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;

  const ROUTE = [];
  for (let x = 1; x <= 6; x++) ROUTE.push({ x, y: 1 });
  for (let y = 2; y <= 4; y++) ROUTE.push({ x: 6, y });
  for (let x = 5; x >= 1; x--) ROUTE.push({ x, y: 4 });
  for (let y = 3; y >= 2; y--) ROUTE.push({ x: 1, y });
  const MOVING_MS = 1000;
  const PARKED_MS = 4000;
  const STALE_MS = 6000;
  const FLEET = ['f1', 'f2', 'f3', 'f4', 'f5'];
  const FLEET_POS = { f1: { x: 2, y: 2 }, f2: { x: 5, y: 3 }, f3: { x: 3, y: 5 }, f4: { x: 7, y: 0 }, f5: { x: 0, y: 5 } };

  function mapSvg(opts) {
    const C = 26;
    const W = 8 * C;
    const H = 6 * C;
    const cx = (v) => v * C + C / 2;
    let s = `<svg class="app-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.label}">`;
    for (let x = 0; x <= 8; x++) s += `<line class="map-street" x1="${x * C}" y1="0" x2="${x * C}" y2="${H}"/>`;
    for (let y = 0; y <= 6; y++) s += `<line class="map-street" x1="0" y1="${y * C}" x2="${W}" y2="${y * C}"/>`;
    if (opts.trail && opts.trail.length > 1) s += `<polyline class="map-route" points="${opts.trail.map((p) => `${cx(p.x)},${cx(p.y)}`).join(' ')}"/>`;
    for (const g of opts.gaps || []) s += `<circle cx="${cx(g.x)}" cy="${cx(g.y)}" r="3" class="map-gap"/>`;
    for (const car of opts.cars || []) s += `<rect class="map-car ${car.cls || ''}" x="${cx(car.x) - 6}" y="${cx(car.y) - 4}" width="12" height="8" rx="3"/>`;
    return s + '</svg>';
  }

  function startOnline(sim) {
    sim.startAction('Driver: go online', function* (ctx) {
      const ui = ctx.ui.driver;
      ui.online = true;
      ui.driving = true;
      ctx.ledger('displayed', 'yes', 'Shows “Online”.');
      ctx.ledger('accepted', 'yes');
      ctx.ledger('committed', 'n/a', 'Each ping is its own write; see the timeline.');
      ctx.ledger('async', 'n/a');
      ctx.ledger('retrySafe', 'yes');
      ctx.explain(`The phone now sends a GPS ping every ${MOVING_MS / 1000} s while driving. Each ping updates the geo index (dispatch’s view), moves the car on the rider’s phone, and is appended to the trip trail through the stream.`);
      startPingLoop(ctx.sim);
    }, { self: 'driver' });
  }

  function startPingLoop(sim) {
    if (sim.state.loop) return;
    sim.state.loop = true;
    sim.spawn(function* (ctx) {
      const st = ctx.state;
      const ui = ctx.ui.driver;
      let lastSent = -Infinity;
      while (ui.online) {
        yield ctx.wait(250);
        const interval = !ui.driving && st.config.adaptive ? PARKED_MS : MOVING_MS;
        if (ctx.now() - lastSent < interval) continue;
        lastSent = ctx.now();
        if (ui.driving) { st.step = (st.step + 1) % ROUTE.length; st.pos = Object.assign({}, ROUTE[st.step]); }
        const point = { driver: 'd1', seq: ++st.seq, t: ctx.now(), x: st.pos.x, y: st.pos.y };
        st.sent.push(point);
        ui.pings++;
        if (ctx.sim.nodes.driver.modes.down) {
          if (st.config.buffer) { st.buffer.push(point); ui.link = 'buffering'; }
          else { st.lostOnPhone.push(point); ui.link = 'no signal'; }
          continue;
        }
        if (st.buffer.length) {
          const batch = st.buffer.splice(0);
          ctx.log({ op: `upload ${batch.length} buffered pings`, status: 'note', detail: `Signal is back. The phone uploads ${batch.length} points it recorded offline in one batch, so the trip trail has no gap.` });
          ctx.explain('While the phone had no signal, it kept recording GPS points locally. Now it sends them as one batch: the trail store backfills the gap, while the geo index and the rider’s map only take the newest point.');
          yield ctx.call('realtime', 'batch', { points: batch }, { timeout: 3000 });
        }
        ui.link = 'online';
        // Pings are fire-and-forget over the WebSocket: the phone does not wait
        // for one to finish before sending the next, so a delayed ping can be overtaken.
        ctx.spawn(function* (c) {
          const r = yield c.call('realtime', 'ping', point, { timeout: 3000, quiet: point.seq % 5 === 1 ? false : true });
          if (!r.ok) ui.link = 'retrying';
        });
      }
      st.loop = false;
    }, { self: 'driver' });
  }

  const sc = (SDL.scenarios['rides-location'] = {
    id: 'rides-location',
    seed: 41,
    productWidth: 560,
    intro: 'Tap “Go online” on the driver phone and watch each ping split into the fast path (geo index and the rider’s map) and the durable path (stream and trail store). Then drive into a tunnel with the guided scenarios.',
    topology: {
      width: 1160,
      height: 560,
      nodes: [
        { id: 'driver', label: 'Driver app', sub: 'Sends GPS', kind: 'client', x: 100, y: 90, latency: 1, role: 'Sends a GPS ping every second while driving. Can buffer points while offline and upload them later.', owns: ['GPS readings', 'Offline buffer'] },
        { id: 'rider', label: 'Rider app', sub: 'Live tracking', kind: 'client', x: 100, y: 300, latency: 1, role: 'Shows the driver’s car moving in near real time.', ops: [{ name: 'push', desc: 'New driver position.' }], owns: ['What the rider sees'] },
        { id: 'realtime', label: 'Realtime gateway', sub: 'WebSockets', kind: 'gateway', x: 330, y: 90, latency: 3, role: 'Holds phone connections; carries pings in and live positions out.', ops: [{ name: 'ping', desc: 'One point in.' }, { name: 'batch', desc: 'Buffered points in.' }, { name: 'push', desc: 'Position out to a rider.' }], owns: ['Connection registry'] },
        { id: 'fleet', label: 'Other drivers', sub: 'Background pings', kind: 'client', x: 330, y: 470, latency: 1, role: 'Five other drivers pinging once a second.', owns: ['Their GPS'] },
        { id: 'location', label: 'Location service', sub: 'Splits each ping', kind: 'service', x: 560, y: 90, latency: 4, role: 'Writes the latest position to the geo index, appends every point to the stream, and pushes positions to riders on a trip.', ops: [{ name: 'ping', desc: 'Handle one point.' }, { name: 'batch', desc: 'Handle buffered points.' }], owns: ['Last accepted position per driver'] },
        { id: 'geoindex', label: 'Geo index', sub: 'Latest position', kind: 'cache', x: 790, y: 90, latency: 4, role: 'In-memory latest position per driver, used by dispatch. Positions older than 6 s count as stale.', ops: [{ name: 'upsert', desc: 'Store a newer position.' }, { name: 'touch', desc: 'Refresh freshness without a write.' }], owns: ['driver → position, timestamp'] },
        { id: 'dispatch', label: 'Dispatch', sub: 'Reads positions', kind: 'service', x: 1020, y: 90, latency: 4, role: 'Looks up nearby fresh drivers once a second. A driver with a stale position is invisible to it.', ops: [{ name: 'scan', desc: 'Count fresh drivers.' }], owns: ['Nothing durable'] },
        { id: 'stream', label: 'Location stream', sub: 'Every point', kind: 'queue', x: 560, y: 300, latency: 3, queue: 'points', role: 'A durable log of every GPS point, partitioned by driver.', ops: [{ name: 'publish', desc: 'Append points.' }], owns: ['points log'] },
        { id: 'trailwriter', label: 'Trail writer', sub: 'Stream consumer', kind: 'worker', x: 790, y: 300, latency: 4, role: 'Writes points to the trail store in timestamp order, ignoring duplicates.', ops: [{ name: 'consume', desc: 'Append to the trail.' }], owns: ['Its stream offset'] },
        { id: 'traildb', label: 'Trip trail store', sub: 'Durable history', kind: 'db', x: 1020, y: 300, latency: 8, role: 'Every point of every trip, used for receipts, fare disputes, and safety reviews.', ops: [{ name: 'append', desc: 'Store points, deduplicated by sequence.' }], owns: ['trails'] },
      ],
      edges: [
        { from: 'driver', to: 'realtime', latency: 35, label: 'pings' },
        { from: 'rider', to: 'realtime', latency: 35, label: 'live' },
        { from: 'fleet', to: 'realtime', latency: 35 },
        { from: 'realtime', to: 'location', latency: 5 },
        { from: 'location', to: 'geoindex', latency: 4, label: 'fast path' },
        { from: 'location', to: 'stream', latency: 5, label: 'durable path' },
        { from: 'stream', to: 'trailwriter', latency: 5 },
        { from: 'trailwriter', to: 'traildb', latency: 6 },
        { from: 'dispatch', to: 'geoindex', latency: 4 },
      ],
      queues: [{ id: 'points', broker: 'stream', label: 'points', groups: ['trail'] }],
    },
    modeLabels: { reorder: 'Reordering pings' },

    failures: [
      { id: 'signal', node: 'driver', mode: 'down', label: 'Driver drives into a tunnel', desc: 'No signal. The phone buffers points or loses them, depending on the switch.' },
      { id: 'reorder', node: 'realtime', mode: 'reorder', label: 'Network reorders pings', desc: 'Every other ping is delayed 1.5 s, so older points arrive after newer ones.' },
      { id: 'geo-down', node: 'geoindex', mode: 'down', label: 'Geo index down', desc: 'Dispatch loses sight of drivers after 6 s. Live tracking and the trail keep working.' },
      { id: 'stream-down', node: 'stream', mode: 'down', label: 'Location stream down', desc: 'Live tracking is fine, but points never reach the trail store.' },
      { id: 'writer-paused', node: 'trailwriter', mode: 'paused', label: 'Trail writer paused', desc: 'The stream backs up; the trail catches up when it resumes.' },
      { id: 'loc-slow', node: 'location', mode: 'slow', params: { factor: 30 }, label: 'Location service slow', desc: 'Every ping takes longer; live tracking lags.' },
    ],

    switches: [
      { id: 'tsCheck', label: 'Reject pings older than the stored one', desc: 'Compare timestamps so a delayed ping cannot move the car backwards.', get: (s) => s.state.config.tsCheck, set: (s, on) => { s.state.config.tsCheck = on; } },
      { id: 'buffer', label: 'Buffer pings on the phone while offline', desc: 'Off: points recorded without signal are lost.', get: (s) => s.state.config.buffer, set: (s, on) => { s.state.config.buffer = on; } },
      { id: 'adaptive', label: 'Slow pings when parked', desc: `Ping every ${PARKED_MS / 1000} s instead of ${MOVING_MS / 1000} s when the car is not moving.`, get: (s) => s.state.config.adaptive, set: (s, on) => { s.state.config.adaptive = on; } },
      { id: 'skip', label: 'Skip unchanged positions at the server', desc: 'Refresh freshness without rewriting the geo index.', get: (s) => s.state.config.skip, set: (s, on) => { s.state.config.skip = on; } },
    ],

    presets: (function () {
      const base = (sim, sw) => {
        sim.restoreAll();
        const def = { tsCheck: true, buffer: true, adaptive: true, skip: true };
        for (const [id, on] of Object.entries(Object.assign(def, sw || {}))) sim.do('setSwitch', { id, on });
        startOnline(sim);
      };
      return [
        { id: 'driving', label: 'Normal driving', desc: 'A ping a second. Watch each one split into the fast path and the durable path.', run: (s) => base(s) },
        { id: 'tunnel', label: 'Tunnel, with buffering', desc: 'Three seconds without signal. The phone records offline, then uploads a batch; the trail has no gap.', run: (s) => { base(s); s.schedule(2500, () => s.inject('driver', 'down', true, 3200)); } },
        { id: 'tunnel-lost', label: 'Tunnel, without buffering', desc: 'The same tunnel, but points recorded offline are thrown away. The trail has a permanent gap.', run: (s) => { base(s, { buffer: false }); s.schedule(2500, () => s.inject('driver', 'down', true, 3200)); } },
        { id: 'reorder-bad', label: 'Out-of-order pings, no timestamp check', desc: 'A delayed ping overwrites a newer one: the car jumps backwards on the rider’s map and in the index.', run: (s) => { base(s, { tsCheck: false }); s.inject('realtime', 'reorder'); } },
        { id: 'reorder-ok', label: 'Out-of-order pings, with timestamp check', desc: 'Older pings are recognised and dropped from the live view; the trail still stores them in order.', run: (s) => { base(s); s.inject('realtime', 'reorder'); } },
        { id: 'parked', label: 'Parked in the airport queue', desc: 'The driver waits without moving. Adaptive pings and server-side skipping cut the load with no loss of freshness.', run: (s) => { base(s); s.schedule(1500, () => s.do('setDriving', { on: false })); } },
        { id: 'geo-down', label: 'Geo index down', desc: 'Dispatch loses the driver after 6 s, but the rider still sees the car and the trail is complete.', run: (s) => { base(s); s.schedule(1500, () => s.inject('geoindex', 'down')); } },
        { id: 'stream-down', label: 'Location stream down', desc: 'Live tracking is fine. The trail silently loses points while the stream is down.', run: (s) => { base(s); s.schedule(1500, () => s.inject('stream', 'down', true, 3000)); } },
        { id: 'writer-paused', label: 'Trail writer stalls', desc: 'Points pile up in the stream for 4 s, then the writer catches up with nothing lost.', run: (s) => { base(s); s.schedule(1500, () => s.inject('trailwriter', 'paused', true, 4000)); } },
      ];
    })(),

    initialState: () => ({
      config: { tsCheck: true, buffer: true, adaptive: true, skip: true },
      step: 0, pos: Object.assign({}, ROUTE[0]), seq: 0, loop: false,
      sent: [], buffer: [], lostOnPhone: [], lostInStream: 0,
      geo: {}, trail: {}, visible: 0,
      stats: { writes: 0, skipped: 0, rejected: 0, backwards: 0 },
    }),
    initialUI: () => ({
      driver: { online: false, driving: true, pings: 0, link: 'offline' },
      rider: { car: null, trail: [], lastAt: null, jumps: 0 },
    }),

    actions: {
      online(sim) { startOnline(sim); },
      offline(sim) { sim.ui.driver.online = false; sim.ui.driver.link = 'offline'; sim.note('Driver went offline; pings stop.'); },
      setDriving(sim, a) { sim.ui.driver.driving = !!a.on; sim.note(a.on ? 'Driver is moving again.' : 'Driver parked.'); },
    },

    handlers: {
      rider: {
        push(ctx, p) {
          const ui = ctx.ui.rider;
          if (ui.car && p.t < ui.lastT) {
            ui.jumps++;
            ctx.explain('An older ping reached the rider after a newer one, and nothing checked its timestamp, so the car jumped backwards on the map. A timestamp (or sequence number) comparison prevents this.');
          }
          ui.car = { x: p.x, y: p.y };
          ui.lastT = p.t;
          ui.lastAt = ctx.now();
          ui.trail.push({ x: p.x, y: p.y });
          if (ui.trail.length > 12) ui.trail.shift();
          return { shown: true };
        },
      },
      realtime: {
        ping: function* (ctx, p) {
          if (ctx.mode('reorder') && p.seq % 2 === 0) yield ctx.wait(1500);
          return ctx.must(yield ctx.call('location', 'ping', p, { timeout: 2500 }));
        },
        batch: function* (ctx, p) { return ctx.must(yield ctx.call('location', 'batch', p, { timeout: 2500 })); },
        fleet: function* (ctx, p) { return ctx.must(yield ctx.call('location', 'fleet', p, { timeout: 2000 })); },
        push: function* (ctx, p) { return ctx.must(yield ctx.call('rider', 'push', p, { timeout: 500 })); },
      },
      location: {
        ping: function* (ctx, p) {
          const st = ctx.state;
          const pub = yield ctx.call('stream', 'publish', { points: [p] }, { timeout: 400 });
          if (!pub.ok) st.lostInStream++;
          const g = yield ctx.call('geoindex', 'upsert', p, { timeout: 400 });
          if (g.ok && g.value.rejected) {
            ctx.log({ op: `ping #${p.seq} rejected`, status: 'note', detail: `Ping #${p.seq} is older than the stored position (#${g.value.storedSeq}). The live view ignores it; the trail still keeps it.` });
            ctx.explain('A delayed ping arrived after a newer one. The geo index compared timestamps and kept the newer position, so neither dispatch nor the rider sees the car jump backwards. The trail writer still stores the old point in its proper place.');
            return { accepted: false };
          }
          yield ctx.call('realtime', 'push', p, { timeout: 600 });
          return { accepted: true, indexed: g.ok, trailed: pub.ok };
        },
        batch: function* (ctx, p) {
          const st = ctx.state;
          const pub = yield ctx.call('stream', 'publish', { points: p.points }, { timeout: 600 });
          if (!pub.ok) st.lostInStream += p.points.length;
          const latest = p.points[p.points.length - 1];
          yield ctx.call('geoindex', 'upsert', latest, { timeout: 400 });
          return { stored: p.points.length };
        },
        fleet: function* (ctx, p) { return ctx.must(yield ctx.call('geoindex', 'upsertMany', p, { timeout: 400 })); },
      },
      geoindex: {
        upsert(ctx, p) {
          const st = ctx.state;
          const cur = st.geo[p.driver];
          if (cur && p.t < cur.t) {
            if (st.config.tsCheck) { st.stats.rejected++; return { rejected: true, storedSeq: cur.seq }; }
            st.stats.backwards++;
          }
          if (st.config.skip && cur && cur.x === p.x && cur.y === p.y && p.t >= cur.t) {
            cur.t = p.t;
            cur.seen = ctx.now();
            st.stats.skipped++;
            return { touched: true };
          }
          st.geo[p.driver] = { x: p.x, y: p.y, t: p.t, seq: p.seq, seen: ctx.now() };
          st.stats.writes++;
          return { stored: true };
        },
        upsertMany(ctx, p) { for (const q of p.points) ctx.state.geo[q.driver] = { x: q.x, y: q.y, t: ctx.now(), seq: 0, seen: ctx.now() }; return { count: p.points.length }; },
        scan(ctx) { return { fresh: Object.values(ctx.state.geo).filter((g) => ctx.now() - g.seen < STALE_MS).length, d1: !!(ctx.state.geo.d1 && ctx.now() - ctx.state.geo.d1.seen < STALE_MS) }; },
      },
      stream: { publish(ctx, p) { ctx.sim.enqueue('points', { type: 'points', payload: p, quiet: true }); return { appended: p.points.length }; } },
      traildb: {
        append(ctx, p) {
          for (const q of p.points) ctx.state.trail[q.seq] = q;
          return { stored: Object.keys(ctx.state.trail).length };
        },
      },
      dispatch: {},
    },

    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(1000);
          const points = FLEET.map((id) => Object.assign({ driver: id }, FLEET_POS[id]));
          yield ctx.call('realtime', 'fleet', { points }, { timeout: 1500, quiet: 'all' });
        }
      }, { self: 'fleet', quiet: 'all' });
      sim.spawn(function* (ctx) {
        let seen = null;
        for (;;) {
          yield ctx.wait(1000);
          const r = yield ctx.call('geoindex', 'scan', {}, { timeout: 500, quiet: 'all' });
          const st = ctx.state;
          st.visible = r.ok ? r.value.fresh : 0;
          const d1 = r.ok && r.value.d1;
          if (ctx.ui.driver.online && seen !== null && d1 !== seen) {
            ctx.log({ op: d1 ? 'driver visible to dispatch' : 'driver invisible to dispatch', status: d1 ? 'recovered' : 'err', detail: d1 ? 'A fresh position is back in the geo index.' : `Dispatch has no position for the driver newer than ${STALE_MS / 1000} s, so it will not offer them rides.` });
          }
          seen = d1;
        }
      }, { self: 'dispatch', quiet: 'all' });
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('points', 'trail');
          const r = yield ctx.call('traildb', 'append', msg.payload, { timeout: 800, quiet: true });
          if (r.ok) ctx.ack('points', 'trail');
          else { ctx.nack('points', 'trail'); yield ctx.wait(300); }
        }
      }, { self: 'trailwriter' });
    },

    consistency(sim) {
      const st = sim.state;
      if (st.stats.backwards > 0) return { key: 'wrong', label: `The geo index moved the driver backwards ${st.stats.backwards} time${st.stats.backwards > 1 ? 's' : ''}: an older ping overwrote a newer one.` };
      const lost = st.lostOnPhone.length + st.lostInStream;
      if (lost > 0) return { key: 'wrong', label: `The trip trail is permanently missing ${lost} point${lost > 1 ? 's' : ''}. Fare disputes and safety reviews for this trip are incomplete.` };
      const delivered = st.sent.length - st.buffer.length;
      const stored = Object.keys(st.trail).length;
      if (stored < delivered) return { key: 'stale', label: `The trail store has ${stored} of ${delivered} delivered points; the rest are still on their way.` };
      if (st.buffer.length) return { key: 'stale', label: `${st.buffer.length} points are buffered on the phone, waiting for signal.` };
      const g = st.geo.d1;
      if (sim.ui.driver.online && (!g || sim.now - g.seen > STALE_MS)) return { key: 'stale', label: `The driver is online, but the geo index has no position newer than ${STALE_MS / 1000} s, so dispatch cannot see them.` };
      return { key: 'ok', label: 'Live position, geo index, and trip trail all agree.' };
    },

    metrics(snap, sim) {
      const st = sim.state;
      const ui = sim.ui;
      const age = ui.rider.lastAt == null ? null : sim.now - ui.rider.lastAt;
      return [
        { label: 'Pings sent by phone', value: st.sent.length },
        { label: 'Geo index writes', value: st.stats.writes },
        { label: 'Writes skipped (unchanged)', value: st.stats.skipped, tone: st.stats.skipped ? 'ok' : '' },
        { label: 'Older pings rejected', value: st.stats.rejected },
        { label: 'Trail points stored', value: `${Object.keys(st.trail).length} of ${st.sent.length}`, tone: st.lostOnPhone.length + st.lostInStream ? 'fail' : '' },
        { label: 'Live tracking age', value: age == null ? 'n/a' : `${(age / 1000).toFixed(1)} s`, tone: age > 3000 ? 'warn' : 'ok' },
        { label: 'Drivers visible to dispatch', value: `${st.visible} of 6`, tone: st.visible < 6 && ui.driver.online ? 'warn' : '' },
      ];
    },

    product: {
      mount(el, sim) {
        const P = SDL.ui.phone;
        el.innerHTML = `
          <p class="panel-note phones-note">The driver phone sends; the rider phone shows what arrives. Dots on the rider’s map mark points missing from the trip trail.</p>
          <div class="phones">${P.frame('driver', 'Driver phone')}${P.frame('rider', 'Rider phone')}</div>`;
        el.querySelectorAll('.phone').forEach((ph) => P.wire(ph));
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-act]');
          if (!b || b.disabled) return;
          sim.dispatch(b.dataset.act, b.dataset.arg ? JSON.parse(b.dataset.arg) : {});
        });
      },
      render(el, sim) {
        const P = SDL.ui.phone;
        const st = sim.state;
        const d = sim.ui.driver;
        const r = sim.ui.rider;
        const dEl = el.querySelector('[data-phone="driver"]');
        const rEl = el.querySelector('[data-phone="rider"]');
        P.render(dEl, sim, 'driver', null, !!sim.nodes.driver.modes.down);
        P.render(rEl, sim, 'rider', null, !!sim.nodes.rider.modes.down);
        const linkText = { offline: 'Offline', online: 'Online', buffering: 'No signal, saving points', 'no signal': 'No signal, points lost', retrying: 'Retrying' }[d.link] || d.link;
        const dot = d.link === 'online' ? 'on' : d.link === 'offline' ? '' : 'bad';
        let dBody = `<div class="app-card"><span class="app-kv"><span>Status</span><span><span class="app-dot ${dot}"></span>${linkText}</span></span>
          <span class="app-kv"><span>Pings sent</span><span data-live="pings"></span></span>
          <span class="app-kv"><span>Saved offline</span><span data-live="buf"></span></span></div>`;
        dBody += d.online
          ? `<div class="app-row"><button class="app-btn${d.driving ? '' : ' go'}" style="flex:1" data-act="setDriving" data-arg='{"on":${!d.driving}}'>${d.driving ? 'Park' : 'Start driving'}</button><button class="app-btn secondary" data-act="offline">Go offline</button></div>`
          : '<button class="app-btn go" data-act="online">Go online</button>';
        dBody += `<p class="app-sub">${d.online ? (d.driving ? `Driving: one ping every ${MOVING_MS / 1000} s.` : `Parked: one ping every ${(st.config.adaptive ? PARKED_MS : MOVING_MS) / 1000} s.`) : 'Go online to start sending your location.'}</p>`;
        P.paint(dEl, {
          head: '<div><p class="app-title">RideNow Driver</p><p class="app-sub">Priya, Blue Prius</p></div>',
          map: mapSvg({ label: 'Driver map', cars: [{ x: st.pos.x, y: st.pos.y, cls: 'is-you' }] }),
          body: dBody,
        }, { pings: String(d.pings), buf: String(st.buffer.length) });

        const missing = st.lostOnPhone.concat([]).map((p) => ({ x: p.x, y: p.y }));
        const age = r.lastAt == null ? null : sim.now - r.lastAt;
        const rBody = `<div class="app-card ${age != null && age > 3000 ? 'is-hot' : r.car ? 'is-ok' : ''}"><strong>${r.car ? 'Priya is on the way' : 'Waiting for your driver’s location'}</strong>
          <span class="app-kv"><span>Last update</span><span data-live="age"></span></span>
          <span class="app-kv"><span>Car jumped backwards</span><span>${r.jumps}</span></span></div>
          <div class="app-card"><span class="app-kv"><span>Trip trail stored</span><span data-live="trail"></span></span></div>`;
        P.paint(rEl, {
          head: '<div><p class="app-title">RideNow</p><p class="app-sub">Tracking your driver</p></div>',
          map: mapSvg({ label: 'Rider map', trail: r.trail, gaps: missing, cars: r.car ? [{ x: r.car.x, y: r.car.y }] : [] }),
          body: rBody,
        }, { age: age == null ? 'n/a' : `${(age / 1000).toFixed(1)} s ago`, trail: `${Object.keys(st.trail).length} of ${st.sent.length} points` });
      },
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
