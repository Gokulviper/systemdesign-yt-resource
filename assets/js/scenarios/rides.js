/*
 * Ride hailing: request to drop-off.
 *
 * A reference design with 19 components. Two phones (rider and driver) are
 * the user interface; every tap becomes a request that travels the diagram.
 *
 * Mechanisms modelled:
 *  - continuous driver location pings, a cell-based geo index with stale expiry
 *  - a geo event stream feeding a surge calculator (demand vs supply per cell)
 *  - pricing quotes with surge, ETA fallback, and base-fare fallback
 *  - idempotent trip creation with a transactional outbox
 *  - dispatch: nearest drivers, ETA ranking, compare-and-set reservation,
 *    offers with timeouts, next-driver fallback
 *  - trip state machine, realtime pushes to the rider, payments with
 *    idempotent retries against an external provider
 *  - the airport hot key, and a cell-split mitigation
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;

  const GRID = { w: 8, h: 6 };
  const PLACES = {
    home: { label: 'Home', x: 1, y: 4 },
    mall: { label: 'Riverside Mall', x: 4, y: 1 },
    downtown: { label: 'Downtown', x: 5, y: 3 },
    airport: { label: 'Airport', x: 7, y: 5 },
  };
  const AIRPORT_CELL = 'c7-5';
  const STALE_MS = 3000;
  const OFFER_MS = 5000;
  const PING_MS = 600;
  const FLEET_MS = 1500;
  const DEMAND_WINDOW = 5000;
  const HOT = { factor: 12 };
  const HOT_SPLIT = { factor: 1.5 };

  const cellOf = (x, y) => `c${x}-${y}`;
  const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const fareFor = (d, m) => Math.round((2.5 + 1.6 * d) * m * 100) / 100;
  const money = (v) => '$' + Number(v).toFixed(2);
  const clone = (v) => JSON.parse(JSON.stringify(v));

  const DRIVERS = {
    d1: { name: 'Priya', car: 'Blue Prius' },
    d2: { name: 'Marco', car: 'White Corolla' },
    d3: { name: 'Aisha', car: 'Grey Ioniq' },
    d4: { name: 'Ken', car: 'Black Camry' },
    d5: { name: 'Lena', car: 'Red Civic' },
    a1: { name: 'Airport driver 1', car: 'Taxi' },
    a2: { name: 'Airport driver 2', car: 'Taxi' },
    a3: { name: 'Airport driver 3', car: 'Taxi' },
  };
  const START = { d1: { x: 2, y: 3 }, d2: { x: 5, y: 1 }, d3: { x: 6, y: 4 }, d4: { x: 7, y: 5 }, d5: { x: 0, y: 1 }, a1: { x: 7, y: 5 }, a2: { x: 7, y: 5 }, a3: { x: 6, y: 5 } };
  const FLEET = ['d2', 'd3', 'd4', 'd5'];
  const NEXT = {
    REQUESTED: ['ACCEPTED', 'NO_DRIVERS', 'CANCELLED'],
    ACCEPTED: ['ARRIVED', 'CANCELLED'],
    ARRIVED: ['IN_PROGRESS'],
    IN_PROGRESS: ['COMPLETED'],
  };
  const ACTIVE = ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS'];
  const STEP_ORDER = ['REQUESTED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'];
  const name = (id) => (DRIVERS[id] ? DRIVERS[id].name : id);
  const blocks = (n) => `${n} block${n === 1 ? '' : 's'}`;

  /* ---------------- shared flows ---------------- */

  function rowOf(t) {
    return {
      trip: t.id, rider: t.rider, status: t.status, version: t.version, driver: t.driver, driverName: t.driverName,
      car: t.car, etaMin: t.etaMin, fare: t.fare, pickup: t.pickup, dropoff: t.dropoff,
      pickupLabel: t.pickupLabel, dropoffLabel: t.dropoffLabel, requestActionId: t.requestActionId,
    };
  }
  function outbox(ctx, t, type) {
    ctx.sim.enqueue('outbox', { type, payload: rowOf(t), actionId: ctx.actionId });
  }

  /** Dispatch runs in the background after a trip is created. */
  function* runDispatch(c, row) {
    const r = yield* c.retry(
      { attempts: 3, baseMs: 300, retryable: (x) => x.error && ['UNAVAILABLE', 'TIMEOUT'].includes(x.error.code) },
      function* () {
        return yield c.call('dispatch', 'match', {
          trip: row.trip, pickup: row.pickup, dropoff: row.dropoff, fare: row.fare,
          pickupLabel: row.pickupLabel, dropoffLabel: row.dropoffLabel,
        }, { timeout: 30000 });
      }
    );
    delete c.state.dispatching[row.trip];
    if (!r.ok) {
      yield c.call('tripdb', 'transition', { trip: row.trip, to: 'NO_DRIVERS', reason: r.error.message }, { timeout: 600 });
      c.explain(`Matching for ${row.trip} gave up: ${r.error.message} The trip is marked "no drivers" and the rider is told to try again. Nothing was charged.`);
    }
  }

  /** Rider (real phone or simulated) asks for a price. Returns the quote or null. */
  function* estimateFlow(ctx, rider, pickup, dropoff, updateUI) {
    const ui = ctx.ui.rider;
    if (updateUI) {
      ui.quoting = true;
      ui.quote = null;
      ui.message = 'Getting prices…';
      ui.tone = 'work';
      ctx.ledger('displayed', 'pending', 'Shows a loading state while prices are fetched.');
      ctx.ledger('committed', 'n/a', 'A price check is a read: nothing durable is written except a short-lived quote.');
      ctx.ledger('async', 'n/a');
      ctx.ledger('retrySafe', 'yes', 'Reads are always safe to retry.');
    }
    const t0 = ctx.now();
    const r = yield* ctx.retry({ attempts: 2, baseMs: 150 }, function* () {
      return yield ctx.call('gateway', 'estimate', { rider, pickup, dropoff }, { timeout: 1500 });
    });
    if (updateUI) ctx.recordOutcome(r.ok, ctx.now() - t0);
    if (!updateUI) return r.ok ? r.value : null;
    ui.quoting = false;
    if (r.ok) {
      const q = r.value;
      ui.quote = q;
      ui.lastQuoteId = q.quoteId;
      ui.message = q.multiplier > 1 ? `Prices are higher right now: ${q.multiplier.toFixed(1)}× surge near ${PLACES[pickup].label}.` : 'Prices loaded.';
      ui.tone = q.multiplier > 1 ? 'warn' : 'ok';
      ctx.ledger('displayed', 'yes', `Shows ${money(q.fare)}${q.multiplier > 1 ? ` with ${q.multiplier.toFixed(1)}× surge` : ''}.`);
      ctx.ledger('accepted', 'yes', null, { ifPending: true });
      const notes = [];
      if (q.surgeFallback) notes.push('the surge store did not answer, so pricing used the base fare');
      if (q.etaFallback) notes.push('the ETA service was slow, so the trip length is a straight-line estimate');
      ctx.explain(
        `Pricing combined the trip distance from the ETA service with the surge multiplier for cell ${q.cell}` +
          (notes.length ? `, but ${notes.join(' and ')}.` : '.') +
          ` The quote is saved for 2 minutes so the price the rider sees is the price they pay.`
      );
    } else {
      ui.message = `Couldn’t get prices: ${r.error.message}`;
      ui.tone = 'fail';
      ctx.ledger('displayed', 'no', 'Shows an error; no quote.');
      ctx.ledger('accepted', 'no', null, { ifPending: true });
      ctx.explain(`The price request failed with ${r.error.code}. Without a quote the rider cannot book, so this failure blocks the core flow.`);
    }
    return r.ok ? r.value : null;
  }

  /** Rider requests a ride using a quote. */
  function* requestFlow(ctx, rider, quoteId, key, updateUI) {
    const ui = ctx.ui.rider;
    if (updateUI) {
      ui.requesting = true;
      ui.message = 'Requesting your ride…';
      ui.tone = 'work';
      ui.lastKey = key;
      ctx.ledger('displayed', 'pending', 'Pessimistic UI: the app waits for the server before showing “Finding your driver”.');
      ctx.ledger('retrySafe', 'yes', `Every attempt carries request key ${key}, so retries cannot create a second trip.`);
    }
    const t0 = ctx.now();
    let r = yield* ctx.retry({ attempts: 3, baseMs: 200 }, function* () {
      return yield ctx.call('gateway', 'request', { rider, quoteId, key }, { timeout: 1500 });
    });
    if (!r.ok && r.error.code === 'TIMEOUT') {
      // Unknown outcome: ask the server whether the request exists before telling the rider anything.
      ctx.log({ op: 'status check', status: 'note', detail: `No answer after ${r.attempts} attempts. Checking whether trip key ${key} exists before reporting failure.` });
      const s = yield ctx.call('gateway', 'status', { key }, { timeout: 1500 });
      if (s.ok && s.value.found) r = { ok: true, value: { trip: s.value.trip, status: s.value.status, recovered: true }, attempts: r.attempts };
    }
    if (!updateUI) return r;
    ctx.recordOutcome(r.ok, ctx.now() - t0);
    ui.requesting = false;
    if (r.ok) {
      ui.tripId = r.value.trip;
      ui.status = r.value.status;
      ui.version = 0;
      ui.driver = null;
      ui.car = null;
      ui.paid = null;
      ui.quote = null;
      ui.message = r.value.recovered ? 'Your request went through after all. Finding your driver…' : 'Finding your driver…';
      ui.tone = 'work';
      ctx.ledger('displayed', 'yes', r.value.recovered ? 'Shows “Finding your driver” after a status check resolved the timeout.' : 'Shows “Finding your driver”.');
      ctx.ledger('accepted', 'yes', null, { ifPending: true });
      ctx.explain(
        `Trip ${r.value.trip} is saved in the trip database${r.value.replayed ? ' (a retry with the same key returned the existing trip instead of creating a second one)' : ''}. ` +
          'The rider gets an answer immediately; matching continues in the background and its result arrives as a push.'
      );
    } else {
      ui.message = r.error.code === 'TIMEOUT'
        ? 'We couldn’t confirm your request. You haven’t been charged. Try again; it’s safe.'
        : `Couldn’t request a ride: ${r.error.message}`;
      ui.tone = 'fail';
      ctx.ledger('displayed', r.error.code === 'TIMEOUT' ? 'unknown' : 'no', 'Shows an error with a safe retry.');
      ctx.ledger('accepted', 'no', null, { ifPending: true });
      ctx.ledger('committed', 'no', null, { ifPending: true });
      ctx.ledger('async', 'n/a', null, { ifPending: true });
      ctx.explain(`The ride request failed with ${r.error.code}. No trip exists, no driver was contacted, and nothing was charged.`);
    }
    return r;
  }

  function startEstimate(sim) {
    const ui = sim.ui.rider;
    const p = ui.pickup;
    const d = ui.dropoff;
    sim.startAction('Rider: see prices', (ctx) => estimateFlow(ctx, 'rA', p, d, true), {
      self: 'rider', detail: `Rider tapped “See prices” for ${PLACES[p].label} to ${PLACES[d].label}.`,
    });
  }
  function startRequest(sim) {
    const ui = sim.ui.rider;
    if (!ui.lastQuoteId) return;
    const key = 'ride-' + ++sim.state.seq.key;
    const qid = ui.lastQuoteId;
    sim.startAction('Rider: request ride', (ctx) => requestFlow(ctx, 'rA', qid, key, true), {
      self: 'rider', detail: `Rider tapped “Request” (request key ${key}).`,
    });
  }
  /** See prices, then request, as one guided sequence. */
  function startQuickBook(sim) {
    const ui = sim.ui.rider;
    const p = ui.pickup;
    const d = ui.dropoff;
    sim.startAction('Rider: see prices', function* (ctx) {
      const q = yield* estimateFlow(ctx, 'rA', p, d, true);
      if (q) yield ctx.wait(250);
      if (q) startRequest(ctx.sim);
    }, { self: 'rider', detail: `Rider checks the price for ${PLACES[p].label} to ${PLACES[d].label}, then requests.` });
  }
  function startRiderB(sim, pickup, dropoff) {
    const key = 'ride-b-' + ++sim.state.seq.key;
    sim.startAction('Rider B (simulated): request', function* (ctx) {
      const q = yield* estimateFlow(ctx, 'rB', pickup, dropoff, false);
      if (!q) return;
      const r = yield* requestFlow(ctx, 'rB', q.quoteId, key, false);
      ctx.ledger('displayed', r.ok ? 'yes' : 'no', 'A second, simulated rider. Their phone is not shown.');
    }, { self: 'rider', detail: 'A second rider nearby requests at the same moment.' });
  }

  /* driver phone actions */
  function startPingLoop(sim) {
    if (sim.state.pingLoop) return;
    sim.state.pingLoop = true;
    sim.spawn(function* (ctx) {
      const ui = ctx.ui.driver;
      const st = ctx.state;
      while (ui.online) {
        yield ctx.wait(PING_MS);
        if (!ui.online) break;
        const pos = st.pos.d1;
        const t = ui.trip;
        let target = null;
        if (t && t.status === 'ACCEPTED') target = t.pickup;
        else if (t && t.status === 'IN_PROGRESS') target = t.dropoff;
        if (target && dist(pos, target) > 0) {
          if (pos.x !== target.x) pos.x += Math.sign(target.x - pos.x);
          else pos.y += Math.sign(target.y - pos.y);
        }
        if (ctx.sim.nodes.driver.modes.down) {
          if (ui.link === 'online') ctx.log({ op: 'phone lost signal', status: 'err', detail: 'The driver’s phone has no signal. GPS keeps moving the car, but no location updates leave the phone.' });
          ui.link = 'no signal';
          ui.pingFails++;
        } else {
          const r = yield ctx.call('realtime', 'ping', { driver: 'd1', x: pos.x, y: pos.y }, { timeout: 800, quiet: true });
          if (r.ok) {
            ui.pings++;
            if (ui.link !== 'online') {
              if (ui.pings > 1) ctx.log({ op: 'location updates resumed', status: 'recovered', detail: 'Pings are getting through again; the geo index has a fresh position.' });
              ui.link = 'online';
            }
            if (ui.pings === 1 || ui.pings % 5 === 0) {
              ctx.log({ op: `location update #${ui.pings}`, status: 'ok', detail: `Sent GPS position (${pos.x}, ${pos.y}) in ${cellOf(pos.x, pos.y)}. The phone sends one every ${PING_MS} ms while online; most are hidden here to keep the timeline readable.` });
            }
          } else {
            ui.pingFails++;
            if (ui.link === 'online') ctx.log({ op: 'location updates failing', status: 'err', error: r.error, detail: `Pings are failing. After ${STALE_MS / 1000} s without one, dispatch treats this driver as stale and stops offering rides.` });
            ui.link = 'reconnecting';
          }
        }
        if (ui.autoDrive && t && !ui.busy) {
          if (t.status === 'ACCEPTED' && dist(pos, t.pickup) === 0) startDriverStep(ctx.sim, 'ARRIVED');
          else if (t.status === 'ARRIVED') startDriverStep(ctx.sim, 'IN_PROGRESS');
          else if (t.status === 'IN_PROGRESS' && dist(pos, t.dropoff) === 0) startDriverStep(ctx.sim, 'COMPLETED');
        }
      }
      st.pingLoop = false;
    }, { self: 'driver' });
  }
  function startGoOnline(sim, on) {
    sim.startAction(on ? 'Driver: go online' : 'Driver: go offline', function* (ctx) {
      const ui = ctx.ui.driver;
      ui.connecting = true;
      ctx.ledger('displayed', 'pending', on ? 'Shows “Connecting…”.' : 'Shows “Going offline…”.');
      const r = yield ctx.call('realtime', 'connect', { driver: 'd1', status: on ? 'available' : 'offline' }, { timeout: 1200 });
      ui.connecting = false;
      if (r.ok) {
        ui.online = on;
        ui.link = on ? 'online' : 'offline';
        ui.message = on ? 'You’re online. Your phone now reports its location continuously.' : 'You’re offline.';
        ctx.ledger('displayed', 'yes', on ? 'Shows “Online”.' : 'Shows “Offline”.');
        ctx.ledger('accepted', 'yes');
        ctx.ledger('committed', 'yes', 'Driver state store updated the availability.');
        ctx.ledger('async', 'n/a');
        ctx.ledger('retrySafe', 'yes', 'Setting a status is idempotent.');
        if (on) startPingLoop(ctx.sim);
        ctx.explain(on
          ? `The driver is available. From now on the phone sends a GPS ping every ${PING_MS} ms: realtime gateway → location service → geo index (fast path) and geo event stream (for surge). Watch the small packets repeat along the bottom of the diagram.`
          : 'The driver is offline, so dispatch will skip them even though their last location is still in the geo index.');
      } else {
        ui.message = `Couldn’t change status: ${r.error.message}`;
        ctx.ledger('displayed', 'no');
        ctx.ledger('accepted', 'no', null, { ifPending: true });
        ctx.ledger('committed', 'no', null, { ifPending: true });
        ctx.ledger('async', 'n/a');
        ctx.ledger('retrySafe', 'yes');
      }
    }, { self: 'driver' });
  }
  function startDriverAnswer(sim, accept) {
    const o = sim.ui.driver.offer;
    if (!o) return;
    sim.startAction(accept ? 'Driver: accept ride' : 'Driver: decline ride', function* (ctx) {
      const ui = ctx.ui.driver;
      ui.offer = null;
      ui.busy = true;
      const r = yield ctx.call('realtime', accept ? 'accept' : 'decline', { offerId: o.offerId, driver: 'd1' }, { timeout: 1000 });
      ui.busy = false;
      ctx.ledger('async', 'n/a');
      ctx.ledger('retrySafe', 'yes', 'Answering the same offer twice has no extra effect.');
      if (r.ok && accept) {
        ui.trip = { id: o.trip, status: 'ACCEPTED', pickup: o.pickup, dropoff: o.dropoff, fare: o.fare, pickupLabel: o.pickupLabel, dropoffLabel: o.dropoffLabel };
        ui.message = `Head to ${o.pickupLabel}. The car moves one block with every location update.`;
        ctx.ledger('displayed', 'yes', 'Shows navigation to the pickup.');
        ctx.ledger('accepted', 'yes', 'Dispatch recorded the acceptance.');
        ctx.ledger('committed', 'yes', 'Dispatch then assigns the driver and the trip database records ACCEPTED.');
      } else if (r.ok) {
        ui.message = 'Declined. Dispatch offers the ride to the next driver.';
        ctx.ledger('displayed', 'yes');
        ctx.ledger('accepted', 'yes');
        ctx.ledger('committed', 'n/a');
      } else {
        ui.message = `This offer is no longer available (${r.error.code}).`;
        ctx.ledger('displayed', 'no', 'Shows that the offer expired.');
        ctx.ledger('accepted', 'no');
        ctx.ledger('committed', 'no');
      }
    }, { self: 'driver', detail: `Driver tapped ${accept ? 'Accept' : 'Decline'} on offer ${o.offerId}.` });
  }
  const STEP_LABEL = { ARRIVED: 'arrived at pickup', IN_PROGRESS: 'start trip', COMPLETED: 'complete trip' };
  function startDriverStep(sim, to) {
    const t = sim.ui.driver.trip;
    if (!t) return;
    sim.ui.driver.busy = true;
    sim.startAction(`Driver: ${STEP_LABEL[to]}`, function* (ctx) {
      const ui = ctx.ui.driver;
      const r = yield ctx.call('realtime', 'tripEvent', { trip: t.id, to, driver: 'd1' }, { timeout: 2000 });
      ui.busy = false;
      ctx.ledger('retrySafe', 'yes', 'The trip state machine ignores a repeat of the same transition.');
      if (r.ok) {
        ctx.ledger('displayed', 'yes');
        ctx.ledger('accepted', 'yes', null, { ifPending: true });
        if (to === 'COMPLETED') {
          ui.earnings += t.fare;
          ui.trip = null;
          ui.message = `Trip complete. You earned ${money(t.fare)}. Payment is collected in the background.`;
          ctx.ledger('async', 'pending', 'Payment and the rider receipt happen asynchronously.');
          ctx.explain('The trip is COMPLETED in the trip database. A trip.completed event leaves through the outbox; payments and notifications consume it independently, so a slow payment provider never blocks the driver.');
        } else {
          ui.trip.status = to;
          ui.message = to === 'ARRIVED' ? 'Waiting for the rider.' : `Driving to ${t.dropoffLabel}.`;
          ctx.ledger('async', 'n/a');
        }
      } else {
        ui.message = `Couldn’t update the trip: ${r.error.message}`;
        ctx.ledger('displayed', 'no');
        ctx.ledger('accepted', 'no', null, { ifPending: true });
        ctx.ledger('committed', 'no', null, { ifPending: true });
        ctx.ledger('async', 'n/a');
      }
    }, { self: 'driver' });
  }

  /** Burst of airport traffic: many location pings and price checks in one cell. */
  function startRush(sim, ms) {
    const st = sim.state;
    st.rush.until = sim.now + ms;
    if (st.rush.running) return;
    st.rush.running = true;
    sim.note(`Airport rush: about 14 location updates and 7 price checks per second hit cell ${AIRPORT_CELL} for ${ms / 1000} s.`);
    sim.spawn(function* (ctx) {
      let i = 0;
      while (ctx.now() < st.rush.until) {
        i++;
        const id = ['a1', 'a2', 'a3'][i % 3];
        const p = st.pos[id];
        ctx.spawn(function* (c) {
          yield c.call('location', 'update', { driver: id, x: p.x, y: p.y }, { timeout: 800, quiet: 'all' });
        }, { self: 'realtime', quiet: 'all' });
        if (i % 2 === 0) {
          ctx.spawn(function* (c) {
            yield c.call('pricing', 'quote', { rider: 'crowd', pickup: 'airport', dropoff: 'downtown' }, { timeout: 1200, quiet: 'all' });
          }, { self: 'gateway', quiet: 'all' });
        }
        yield ctx.wait(70);
      }
      st.rush.running = false;
      ctx.log({ op: 'airport rush ended', status: 'note', detail: 'Traffic at the airport is back to normal. Demand drops out of the 5 s surge window shortly.' });
    }, { self: 'realtime', quiet: 'all' });
  }

  function setDriverOnlineInstant(sim, pos) {
    // Used by guided scenarios to start from a known position.
    sim.state.pos.d1 = clone(pos);
    startGoOnline(sim, true);
  }

  /* ---------------- map drawing for both phones ---------------- */
  function mapSvg(opts) {
    const C = 26;
    const W = GRID.w * C;
    const H = GRID.h * C;
    const cx = (x) => x * C + C / 2;
    const cy = (y) => y * C + C / 2;
    let s = `<svg class="app-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.label}">`;
    if (opts.surge) for (const [cell, m] of Object.entries(opts.surge)) {
      const [, x, y] = cell.match(/c(\d+)-(\d+)/);
      s += `<rect class="map-surge" x="${x * C}" y="${y * C}" width="${C}" height="${C}" style="opacity:${Math.min(1, (m - 1) / 1.5 + 0.25)}"/>`;
    }
    for (let x = 0; x <= GRID.w; x++) s += `<line class="map-street" x1="${x * C}" y1="0" x2="${x * C}" y2="${H}"/>`;
    for (let y = 0; y <= GRID.h; y++) s += `<line class="map-street" x1="0" y1="${y * C}" x2="${W}" y2="${y * C}"/>`;
    for (const p of Object.values(PLACES)) s += `<text class="map-place" x="${cx(p.x)}" y="${cy(p.y) + 11}" text-anchor="middle">${p.label.split(' ')[0]}</text>`;
    if (opts.route) s += `<polyline class="map-route" points="${cx(opts.route[0].x)},${cy(opts.route[0].y)} ${cx(opts.route[1].x)},${cy(opts.route[0].y)} ${cx(opts.route[1].x)},${cy(opts.route[1].y)}"/>`;
    if (opts.pickup) s += `<circle class="map-pickup" cx="${cx(opts.pickup.x)}" cy="${cy(opts.pickup.y)}" r="5"/>`;
    if (opts.dropoff) s += `<rect class="map-dropoff" x="${cx(opts.dropoff.x) - 4.5}" y="${cy(opts.dropoff.y) - 4.5}" width="9" height="9" rx="1"/>`;
    for (const car of opts.cars || []) s += `<rect class="map-car ${car.cls || ''}" x="${cx(car.x) - 6}" y="${cy(car.y) - 4}" width="12" height="8" rx="3"/>`;
    return s + '</svg>';
  }

  /* ---------------- scenario ---------------- */
  const sc = (SDL.scenarios['ride-hailing'] = {
    id: 'ride-hailing',
    seed: 11,
    productWidth: 560,
    intro: 'Tap “Go online” on the driver phone to start continuous location updates, then pick a destination on the rider phone and tap “See prices” and “Request”. Or run a guided scenario.',

    topology: {
      width: 1160,
      height: 700,
      nodes: [
        { id: 'rider', label: 'Rider app', sub: 'Phone, left', kind: 'client', x: 100, y: 80, latency: 1,
          role: 'Shows prices and trip progress. Sends requests over HTTPS with an idempotency key, and receives pushes over a WebSocket.',
          ops: [{ name: 'push', desc: 'Trip updates and driver locations from the realtime gateway.' }], owns: ['What the rider sees'] },
        { id: 'realtime', label: 'Realtime gateway', sub: 'WebSockets to phones', kind: 'gateway', x: 100, y: 400, latency: 3,
          role: 'Holds a long-lived connection to every phone. Carries driver pings in, and offers and trip updates out.',
          ops: [{ name: 'ping', desc: 'Driver location in.' }, { name: 'offer', desc: 'Ride offer out to a driver.' }, { name: 'push', desc: 'Trip update out to a rider or driver.' }],
          owns: ['Connection registry: which server holds which phone'] },
        { id: 'driver', label: 'Driver app', sub: 'Phone, right', kind: 'client', x: 100, y: 590, latency: 1,
          role: 'Reports GPS every 600 ms while online, receives offers, and moves the trip through its states.',
          ops: [{ name: 'offer', desc: 'Shows a ride request with a countdown.' }], owns: ['GPS position'] },
        { id: 'gateway', label: 'API gateway', sub: 'Auth, rate limits', kind: 'gateway', x: 330, y: 80, latency: 5,
          role: 'Authenticates riders, applies per-user rate limits, and routes HTTPS calls to services.',
          ops: [{ name: 'estimate', desc: 'Forward to pricing.' }, { name: 'request', desc: 'Forward to the trip service.' }, { name: 'status', desc: 'Look up a trip by request key.' }],
          owns: ['Rate-limit counters'] },
        { id: 'pricing', label: 'Pricing', sub: 'Fares and quotes', kind: 'service', x: 330, y: 235, latency: 8,
          role: 'Builds a fare from distance and the surge multiplier for the pickup cell, and saves a quote so the price is honoured.',
          ops: [{ name: 'quote', desc: 'Fare = (base + per-block × distance) × surge.' }], owns: ['Quotes (2 minute lifetime)'] },
        { id: 'surge', label: 'Surge store', sub: 'Multiplier per cell', kind: 'cache', x: 330, y: 420, latency: 3,
          role: 'An in-memory store of the current surge multiplier for each map cell, plus recent demand counts.',
          ops: [{ name: 'quote', desc: 'Record one unit of demand and return the multiplier.' }, { name: 'set', desc: 'Replace multipliers (from the surge calculator).' }],
          owns: ['surge_multiplier[cell]', 'demand events (5 s window)'] },
        { id: 'location', label: 'Location service', sub: 'Ingests GPS pings', kind: 'service', x: 330, y: 590, latency: 4,
          role: 'Receives every driver ping, updates the geo index synchronously, publishes to the geo stream, and forwards positions to riders on active trips.',
          ops: [{ name: 'update', desc: 'One driver ping.' }, { name: 'pingBatch', desc: 'Many pings at once.' }],
          owns: ['Driver-to-rider subscriptions for live tracking'] },
        { id: 'trip', label: 'Trip service', sub: 'Trip lifecycle', kind: 'service', x: 560, y: 80, latency: 8,
          role: 'Creates trips idempotently, starts matching in the background, and enforces the trip state machine.',
          ops: [{ name: 'create', desc: 'New trip from a quote and request key.' }, { name: 'assign', desc: 'Record the matched driver.' }, { name: 'transition', desc: 'ARRIVED, IN_PROGRESS, COMPLETED.' }],
          owns: ['Trip rules'] },
        { id: 'dispatch', label: 'Dispatch', sub: 'Matching, driver API', kind: 'service', x: 560, y: 235, latency: 8,
          role: 'Finds nearby drivers, ranks them by ETA, reserves one atomically, sends an offer, and waits; on timeout or decline it moves to the next driver.',
          ops: [{ name: 'match', desc: 'Find, rank, reserve, offer, assign.' }, { name: 'accept', desc: 'Driver accepted an offer.' }, { name: 'tripEvent', desc: 'Driver moved the trip forward.' }],
          owns: ['Open offers and their deadlines'] },
        { id: 'geoindex', label: 'Geo index', sub: 'Drivers by map cell', kind: 'cache', x: 560, y: 420, latency: 8,
          role: 'An in-memory spatial index (cells like H3 or geohash) answering “which drivers are near this point?”. Entries older than 3 s are ignored.',
          ops: [{ name: 'upsert', desc: 'Latest position for a driver.' }, { name: 'nearby', desc: 'Fresh drivers within a radius.' }],
          owns: ['driver → cell, position, last seen'] },
        { id: 'locstream', label: 'Geo event stream', sub: 'Partitioned by cell', kind: 'queue', x: 560, y: 590, latency: 4, queue: 'geo',
          role: 'A durable log of location events, partitioned by cell. Consumers such as the surge calculator read it without slowing the ping path.',
          ops: [{ name: 'publish', desc: 'Append a location event.' }], owns: ['geo-events log'] },
        { id: 'tripdb', label: 'Trip database', sub: 'Source of truth', kind: 'db', x: 790, y: 80, latency: 18,
          role: 'Stores trips, their status and version, request keys for idempotency, and an outbox of trip events written in the same transaction.',
          ops: [{ name: 'create', desc: 'Insert a trip unless the request key exists.' }, { name: 'transition', desc: 'Validated status change plus outbox event.' }],
          owns: ['trips', 'request_keys', 'outbox'] },
        { id: 'driverstate', label: 'Driver state', sub: 'Availability, CAS', kind: 'db', x: 790, y: 235, latency: 6,
          role: 'Each driver’s availability with a version number. Reservations use compare-and-set, so two trips can never reserve the same driver.',
          ops: [{ name: 'reserve', desc: 'available → offered, only if still available.' }, { name: 'assign', desc: 'offered → on trip.' }, { name: 'release', desc: 'offered → available.' }],
          owns: ['driver_status', 'version'] },
        { id: 'eta', label: 'ETA and routing', sub: 'Road graph', kind: 'service', x: 790, y: 420, latency: 12,
          role: 'Computes trip distance and time, and ranks candidate drivers by time to pickup rather than straight-line distance.',
          ops: [{ name: 'route', desc: 'Distance and minutes between two points.' }, { name: 'rank', desc: 'Sort candidates by ETA to pickup.' }],
          owns: ['Road graph and traffic model'] },
        { id: 'surgecalc', label: 'Surge calculator', sub: 'Stream consumer', kind: 'worker', x: 790, y: 590, latency: 6,
          role: 'Consumes the geo stream to track supply per cell, reads recent demand, and writes new multipliers to the surge store.',
          ops: [{ name: 'consume', desc: 'Update supply, recompute surge.' }], owns: ['Its stream offset', 'Supply per cell'] },
        { id: 'events', label: 'Trip events', sub: 'Event broker', kind: 'queue', x: 1020, y: 80, latency: 5, queue: 'tripEvents',
          role: 'Receives trip events from the outbox and fans them out to payments and notifications, at least once.',
          ops: [{ name: 'publish', desc: 'Append an event.' }], owns: ['trip-events log'] },
        { id: 'payments', label: 'Payments', sub: 'Charges riders', kind: 'worker', x: 1020, y: 235, latency: 8,
          role: 'On trip.completed, charges the rider through the provider with an idempotency key, retrying until it succeeds.',
          ops: [{ name: 'consume', desc: 'Charge for completed trips.' }], owns: ['Payment records'] },
        { id: 'provider', label: 'Payment provider', sub: 'External PSP', kind: 'service', x: 1020, y: 420, latency: 30,
          role: 'An external card processor. It deduplicates charges by idempotency key.',
          ops: [{ name: 'charge', desc: 'Charge a card once per key.' }], owns: ['Charges'] },
        { id: 'notify', label: 'Notifications', sub: 'Event consumer', kind: 'worker', x: 1020, y: 590, latency: 6,
          role: 'Turns trip events into pushes for the rider’s phone through the realtime gateway, retrying while the phone is unreachable.',
          ops: [{ name: 'consume', desc: 'Event → push.' }], owns: ['Its stream offset'] },
      ],
      edges: [
        { from: 'rider', to: 'gateway', latency: 40, label: 'HTTPS' },
        { from: 'rider', to: 'realtime', latency: 35, label: 'WebSocket' },
        { from: 'driver', to: 'realtime', latency: 35, label: 'WebSocket' },
        { from: 'realtime', to: 'location', latency: 8, label: 'pings' },
        { from: 'realtime', to: 'dispatch', latency: 8, label: 'offers', via: [[440, 330]] },
        { from: 'gateway', to: 'pricing', latency: 6 },
        { from: 'gateway', to: 'trip', latency: 6 },
        { from: 'pricing', to: 'surge', latency: 4 },
        { from: 'pricing', to: 'eta', latency: 8 },
        { from: 'trip', to: 'tripdb', latency: 8 },
        { from: 'trip', to: 'dispatch', latency: 6 },
        { from: 'dispatch', to: 'geoindex', latency: 5 },
        { from: 'dispatch', to: 'eta', latency: 6 },
        { from: 'dispatch', to: 'driverstate', latency: 5 },
        { from: 'location', to: 'geoindex', latency: 5 },
        { from: 'location', to: 'locstream', latency: 6 },
        { from: 'locstream', to: 'surgecalc', latency: 8 },
        { from: 'surgecalc', to: 'surge', latency: 8, via: [[790, 508], [330, 508]] },
        { from: 'tripdb', to: 'events', latency: 10, label: 'outbox' },
        { from: 'events', to: 'payments', latency: 8 },
        { from: 'payments', to: 'provider', latency: 40, label: 'HTTPS' },
        { from: 'events', to: 'notify', latency: 10, via: [[1125, 80], [1125, 590]] },
        { from: 'notify', to: 'realtime', latency: 25, label: 'push', via: [[1020, 672], [210, 672], [210, 400]] },
      ],
      queues: [
        { id: 'geo', broker: 'locstream', label: 'geo-events', groups: ['surge'] },
        { id: 'outbox', broker: 'tripdb', label: 'outbox', groups: ['events'] },
        { id: 'tripEvents', broker: 'events', label: 'trip-events', groups: ['notify', 'payments'] },
      ],
    },

    modeLabels: { hot: 'Hot shard (airport)' },

    failures: [
      { id: 'realtime-down', node: 'realtime', mode: 'down', label: 'Realtime gateway down', desc: 'No pings in, no offers or pushes out. Drivers go stale; riders stop getting updates.' },
      { id: 'driver-signal', node: 'driver', mode: 'down', label: 'Driver phone loses signal', desc: 'The car keeps moving but its pings stop. Offers to this driver cannot be delivered.' },
      { id: 'location-down', node: 'location', mode: 'down', label: 'Location service down', desc: 'Every driver’s position goes stale after 3 s, so matching finds nobody.' },
      { id: 'stream-down', node: 'locstream', mode: 'down', label: 'Geo event stream down', desc: 'The geo index still updates, but surge stops seeing supply. Multipliers go stale.' },
      { id: 'geo-hot', node: 'geoindex', mode: 'hot', params: HOT, label: 'Hot shard at the airport', desc: 'One shard owns the airport cell. Requests queue behind each other once traffic exceeds what it can serve.' },
      { id: 'geo-slow', node: 'geoindex', mode: 'slow', params: { factor: 15 }, label: 'Geo index slow', desc: 'Nearby-driver searches take 15 times longer.' },
      { id: 'surge-down', node: 'surge', mode: 'down', label: 'Surge store unavailable', desc: 'Pricing cannot read multipliers. Depending on the design switch, it charges base fare or refuses.' },
      { id: 'surgecalc-paused', node: 'surgecalc', mode: 'paused', label: 'Surge calculator paused', desc: 'Multipliers freeze and the geo stream backs up.' },
      { id: 'eta-slow', node: 'eta', mode: 'slow', params: { factor: 40 }, label: 'ETA service slow', desc: 'Callers time out and fall back to straight-line estimates.' },
      { id: 'dispatch-down', node: 'dispatch', mode: 'down', label: 'Dispatch down', desc: 'Trips are created but matching cannot start; after retries the trip ends with no driver.' },
      { id: 'tripdb-down', node: 'tripdb', mode: 'down', label: 'Trip database down', desc: 'Ride requests fail cleanly. Nothing is created or charged.' },
      { id: 'tripdb-drop', node: 'tripdb', mode: 'dropResponse', label: 'Trip database replies lost', desc: 'The trip is saved but the reply never arrives. Retries must not create a second trip.' },
      { id: 'events-down', node: 'events', mode: 'down', label: 'Trip event broker down', desc: 'Trips still progress; rider pushes and payments wait in the outbox.' },
      { id: 'notify-paused', node: 'notify', mode: 'paused', label: 'Notifications paused', desc: 'The rider app stops getting trip updates until it resumes.' },
      { id: 'provider-down', node: 'provider', mode: 'down', label: 'Payment provider down', desc: 'Trips complete; charges are retried in the background with the same key.' },
      { id: 'rate-limit', node: 'gateway', mode: 'reject', params: { code: 'RATE_LIMITED', message: 'Too many requests from this rider. Try again shortly.' }, label: 'Rate limit hit', desc: 'The gateway rejects rider calls with 429 before they reach any service.' },
    ],

    switches: [
      { id: 'cas', label: 'Atomic driver reservation (compare-and-set)', desc: 'Off: two trips can reserve the same driver at once.', get: (s) => s.state.config.cas, set: (s, on) => { s.state.config.cas = on; } },
      { id: 'idempotentCreate', label: 'Idempotency key on ride requests', desc: 'Off: a retried request can create a second trip.', get: (s) => s.state.config.idempotentCreate, set: (s, on) => { s.state.config.idempotentCreate = on; } },
      { id: 'idempotentCharge', label: 'Idempotency key on payment charges', desc: 'Off: a retried charge can bill the rider twice.', get: (s) => s.state.config.idempotentCharge, set: (s, on) => { s.state.config.idempotentCharge = on; } },
      { id: 'baseFareFallback', label: 'Base fare when surge is unavailable', desc: 'Off: pricing refuses to quote when the surge store is down.', get: (s) => s.state.config.baseFareFallback, set: (s, on) => { s.state.config.baseFareFallback = on; } },
      {
        id: 'splitHotCell', label: 'Split the airport into finer cells', desc: 'Spreads the hot key over four shards instead of one.',
        get: (s) => s.state.config.splitHotCell,
        set: (s, on) => {
          s.state.config.splitHotCell = on;
          if (s.nodes.geoindex.modes.hot) s.nodes.geoindex.modes.hot = on ? HOT_SPLIT : HOT;
        },
      },
    ],

    presets: [
      { id: 'happy', label: 'Full ride, start to finish', desc: 'Driver goes online, rider books Home to Airport, driver accepts, drives, completes, rider is charged once.',
        run(sim) { sim.restoreAll(); sim.ui.driver.autoAccept = true; sim.ui.driver.autoDrive = true; setDriverOnlineInstant(sim, START.d1); sim.ui.rider.pickup = 'home'; sim.ui.rider.dropoff = 'airport'; sim.schedule(900, () => startQuickBook(sim)); } },
      { id: 'online', label: 'Continuous location updates', desc: 'Driver goes online and pings every 600 ms. Watch pings feed the geo index and the surge stream.',
        run(sim) { sim.restoreAll(); setDriverOnlineInstant(sim, sim.state.pos.d1); } },
      { id: 'surge', label: 'Surge at the airport', desc: 'A flight lands: demand at the airport jumps. The surge calculator raises the multiplier and the rider’s price goes up.',
        run(sim) { sim.restoreAll(); startRush(sim, 2500); sim.ui.rider.pickup = 'airport'; sim.ui.rider.dropoff = 'downtown'; sim.schedule(2700, () => startEstimate(sim)); } },
      { id: 'hotkey', label: 'Airport hot key', desc: 'The rush lands on the single shard that owns the airport cell. Its latency explodes and matching slows down.',
        run(sim) { sim.restoreAll(); sim.do('setSwitch', { id: 'splitHotCell', on: false }); sim.inject('geoindex', 'hot', HOT); startRush(sim, 4000); sim.ui.rider.pickup = 'airport'; sim.ui.rider.dropoff = 'downtown'; sim.schedule(1200, () => startQuickBook(sim)); } },
      { id: 'hotfix', label: 'Hot key, with cells split', desc: 'Same rush, but the airport is split across four shards. Latency stays low.',
        run(sim) { sim.restoreAll(); sim.do('setSwitch', { id: 'splitHotCell', on: true }); sim.inject('geoindex', 'hot', HOT_SPLIT); startRush(sim, 4000); sim.ui.rider.pickup = 'airport'; sim.ui.rider.dropoff = 'downtown'; sim.schedule(1200, () => startQuickBook(sim)); } },
      { id: 'race', label: 'Two riders, one driver', desc: 'Only Aisha is free near Downtown and two riders request at the same instant. Compare-and-set lets exactly one reserve her.',
        run(sim) { sim.restoreAll(); for (const id of ['d2', 'd4', 'd5']) sim.state.drivers[id].status = 'onTrip'; sim.ui.rider.pickup = 'downtown'; sim.ui.rider.dropoff = 'mall'; startQuickBook(sim); startRiderB(sim, 'downtown', 'airport'); } },
      { id: 'timeout', label: 'Driver ignores the offer', desc: 'The offer goes to your driver phone. Leave it: after 5 s dispatch releases you and offers the next driver.',
        run(sim) { sim.restoreAll(); sim.ui.driver.autoAccept = false; setDriverOnlineInstant(sim, START.d1); sim.ui.rider.pickup = 'home'; sim.ui.rider.dropoff = 'mall'; sim.schedule(900, () => startQuickBook(sim)); } },
      { id: 'stale', label: 'Location service down', desc: 'Pings stop landing. After 3 s every driver is stale, so matching finds no one even though drivers are on the road.',
        run(sim) { sim.restoreAll(); sim.ui.rider.pickup = 'downtown'; sim.ui.rider.dropoff = 'home'; sim.schedule(300, () => sim.inject('location', 'down')); sim.schedule(3700, () => startQuickBook(sim)); } },
      { id: 'surge-down', label: 'Surge store down', desc: 'Pricing cannot read the multiplier and falls back to base fare, trading revenue for availability.',
        run(sim) { sim.restoreAll(); sim.inject('surge', 'down'); sim.ui.rider.pickup = 'mall'; sim.ui.rider.dropoff = 'airport'; startEstimate(sim); } },
      { id: 'lost-trip', label: 'Trip saved, reply lost', desc: 'The first request commits but its reply is lost. The retry returns the same trip, so the rider is never double-booked.',
        run(sim) { sim.restoreAll(); sim.ui.driver.autoAccept = true; setDriverOnlineInstant(sim, START.d1); sim.ui.rider.pickup = 'home'; sim.ui.rider.dropoff = 'downtown'; sim.schedule(900, () => { sim.inject('tripdb', 'dropResponse', true, 1200); startQuickBook(sim); }); } },
      { id: 'payment', label: 'Payment provider down', desc: 'The ride completes normally. The charge fails and is retried with the same key until the provider recovers, then the rider is charged exactly once.',
        run(sim) { sim.restoreAll(); sim.inject('provider', 'down', true, 13000); sim.ui.driver.autoAccept = true; sim.ui.driver.autoDrive = true; setDriverOnlineInstant(sim, START.d1); sim.ui.rider.pickup = 'home'; sim.ui.rider.dropoff = 'downtown'; sim.schedule(900, () => startQuickBook(sim)); } },
      { id: 'events-down', label: 'Trip event broker down', desc: 'The driver accepts and drives as normal, but the rider’s phone hears nothing until the broker returns; then the updates arrive in order.',
        run(sim) { sim.restoreAll(); sim.ui.driver.autoAccept = true; sim.ui.driver.autoDrive = true; setDriverOnlineInstant(sim, START.d1); sim.ui.rider.pickup = 'home'; sim.ui.rider.dropoff = 'downtown'; sim.schedule(900, () => { sim.inject('events', 'down', true, 3500); startQuickBook(sim); }); } },
    ],

    initialState: () => {
      const drivers = {};
      for (const id of Object.keys(DRIVERS)) drivers[id] = { status: FLEET.includes(id) ? 'available' : id === 'd1' ? 'offline' : 'onTrip', version: 1, trip: null, offerTrip: null };
      return {
        seq: { trip: 0, quote: 0, offer: 0, key: 0 },
        config: { cas: true, idempotentCreate: true, idempotentCharge: true, baseFareFallback: true, splitHotCell: false },
        pos: clone(START),
        geo: {},
        drivers,
        quotes: {},
        trips: {},
        tripKeys: {},
        dispatching: {},
        offers: {},
        surge: { mult: {}, demand: [], updatedAt: 0 },
        surgeView: {},
        charges: {},
        paidTrips: {},
        stats: { pings: 0, staleSkipped: 0, streamDrops: 0 },
        rush: { until: 0, running: false },
        pingLoop: false,
      };
    },
    initialUI: () => ({
      rider: { pickup: 'home', dropoff: 'airport', quote: null, quoting: false, requesting: false, lastQuoteId: null, lastKey: null, tripId: null, status: null, version: 0, driver: null, car: null, eta: null, paid: null, message: 'Where to? Pick a destination and tap “See prices”.', tone: '', banner: null },
      driver: { online: false, connecting: false, link: 'offline', pings: 0, pingFails: 0, offer: null, trip: null, autoAccept: false, autoDrive: false, busy: false, earnings: 0, message: 'You’re offline. Go online to receive requests.', banner: null },
    }),

    actions: {
      riderSet(sim, a) { sim.ui.rider[a.field] = a.value; sim.ui.rider.quote = null; },
      estimate(sim) { startEstimate(sim); },
      request(sim) { startRequest(sim); },
      quickBook(sim) { startQuickBook(sim); },
      riderReset(sim) { Object.assign(sim.ui.rider, { tripId: null, status: null, driver: null, car: null, paid: null, quote: null, lastQuoteId: null, message: 'Where to next?', tone: '' }); },
      goOnline(sim) { startGoOnline(sim, true); },
      goOffline(sim) { startGoOnline(sim, false); },
      accept(sim) { startDriverAnswer(sim, true); },
      decline(sim) { startDriverAnswer(sim, false); },
      driverStep(sim, a) { startDriverStep(sim, a.to); },
      driverOption(sim, a) { sim.ui.driver[a.key] = !!a.on; },
      rush(sim, a) { startRush(sim, a.ms || 3000); },
    },

    handlers: {
      /* phones */
      rider: {
        push(ctx, p) {
          const ui = ctx.ui.rider;
          if (p.to !== 'rA') return { ignored: 'another rider' };
          if (p.type === 'driverLocation') {
            if (p.trip === ui.tripId) ui.car = { x: p.x, y: p.y };
            return { shown: true };
          }
          if (p.trip !== ui.tripId) return { ignored: 'older trip' };
          if (p.version != null) {
            if (p.version <= ui.version) return { ignored: 'out of date' };
            ui.version = p.version;
          }
          const banner = (title, body, tone) => (ui.banner = { title, body, tone, t: ctx.now() });
          switch (p.type) {
            case 'trip.accepted':
              ui.status = 'ACCEPTED';
              ui.driver = { name: p.driverName, car: p.car };
              ui.eta = p.etaMin;
              ui.message = `${p.driverName} is on the way in a ${p.car}.`;
              ui.tone = 'ok';
              banner('Driver on the way', `${p.driverName}, ${p.car}, about ${p.etaMin} min`, 'ok');
              ctx.sim.setLedger(p.requestActionId, 'async', 'yes', 'Matching finished and the rider was pushed the driver’s details.');
              ctx.explain(`${p.driverName} accepted. Dispatch reserved them with compare-and-set, the trip database recorded ACCEPTED, and the event travelled outbox → trip events → notifications → realtime gateway → this phone. From now on the rider sees the car move with every driver ping.`);
              break;
            case 'trip.arrived': ui.status = 'ARRIVED'; ui.message = 'Your driver has arrived.'; ui.tone = 'ok'; banner('Your driver is here', `${ui.driver ? ui.driver.car : ''}`, 'ok'); break;
            case 'trip.in_progress': ui.status = 'IN_PROGRESS'; ui.message = `On the way to ${p.dropoffLabel}.`; ui.tone = 'work'; break;
            case 'trip.completed': ui.status = 'COMPLETED'; ui.paid = false; ui.message = `You’ve arrived. Fare ${money(p.fare)}.`; ui.tone = 'ok'; banner('Trip complete', `Fare ${money(p.fare)}`, 'ok'); break;
            case 'trip.no_drivers':
              ui.status = 'NO_DRIVERS';
              ui.message = 'No drivers are available right now. You weren’t charged.';
              ui.tone = 'fail';
              banner('No drivers available', 'Please try again in a moment', 'fail');
              ctx.sim.setLedger(p.requestActionId, 'async', 'no', 'Matching ended without a driver; the rider was told.');
              break;
            case 'payment.captured': ui.paid = true; banner('Receipt', `${money(p.amount)} charged to your card`, 'ok'); break;
            default: break;
          }
          return { shown: p.type };
        },
      },
      driver: {
        offer(ctx, p) {
          const ui = ctx.ui.driver;
          ui.offer = Object.assign({}, p, { receivedAt: ctx.now() });
          ui.banner = { title: 'New ride request', body: `${p.pickupLabel} to ${p.dropoffLabel}, ${money(p.fare)}`, tone: 'warn', t: ctx.now() };
          if (ui.autoAccept) ctx.sim.schedule(900, () => startDriverAnswer(ctx.sim, true));
          return { shown: true };
        },
        push(ctx, p) {
          const ui = ctx.ui.driver;
          if (p.type === 'offer.expired' && ui.offer && ui.offer.offerId === p.offerId) {
            ui.offer = null;
            ui.message = 'You missed a request. It went to the next driver.';
            ui.banner = { title: 'Request expired', body: 'Offered to another driver', tone: 'warn', t: ctx.now() };
          }
          if (p.type === 'offer.revoked') {
            ui.trip = null;
            ui.message = 'That ride was assigned elsewhere.';
            ui.banner = { title: 'Ride cancelled', body: 'Another driver was assigned', tone: 'fail', t: ctx.now() };
          }
          return { ok: true };
        },
      },

      /* edge */
      gateway: {
        estimate: function* (ctx, p) { return ctx.must(yield ctx.call('pricing', 'quote', p, { timeout: 1200 })); },
        request: function* (ctx, p) { return ctx.must(yield ctx.call('trip', 'create', p, { timeout: 1200 })); },
        status: function* (ctx, p) { return ctx.must(yield ctx.call('trip', 'lookup', p, { timeout: 1000 })); },
      },
      realtime: {
        ping: function* (ctx, p) { return ctx.must(yield ctx.call('location', 'update', p, { timeout: 600 })); },
        connect: function* (ctx, p) { return ctx.must(yield ctx.call('dispatch', 'driverStatus', p, { timeout: 800 })); },
        accept: function* (ctx, p) { return ctx.must(yield ctx.call('dispatch', 'accept', p, { timeout: 600 })); },
        decline: function* (ctx, p) { return ctx.must(yield ctx.call('dispatch', 'decline', p, { timeout: 600 })); },
        tripEvent: function* (ctx, p) { return ctx.must(yield ctx.call('dispatch', 'tripEvent', p, { timeout: 1600 })); },
        push: function* (ctx, p) {
          if (p.to === 'rA') return ctx.must(yield ctx.call('rider', 'push', p, { timeout: 500 }));
          if (p.to === 'd1') return ctx.must(yield ctx.call('driver', 'push', p, { timeout: 500 }));
          return { delivered: 'to a simulated phone' };
        },
        offer: function* (ctx, p) {
          if (p.driver === 'd1') return ctx.must(yield ctx.call('driver', 'offer', p, { timeout: 500 }));
          const sim = ctx.sim;
          sim.schedule(1200, () => {
            const o = sim.state.offers[p.offerId];
            if (o && o.status === 'pending') {
              o.status = 'accepted';
              sim._log({ node: 'realtime', op: `${name(p.driver)} accepted`, status: 'ok', actionId: o.actionId, detail: `Simulated driver ${name(p.driver)} tapped Accept on ${p.offerId}.` });
            }
          });
          return { delivered: true, to: name(p.driver) };
        },
      },

      /* pricing */
      pricing: {
        quote: function* (ctx, p) {
          const st = ctx.state;
          const from = PLACES[p.pickup];
          const to = PLACES[p.dropoff];
          const cell = cellOf(from.x, from.y);
          let multiplier = 1;
          let surgeFallback = false;
          const s = yield ctx.call('surge', 'quote', { cell }, { timeout: 300 });
          if (s.ok) multiplier = s.value.multiplier;
          else if (st.config.baseFareFallback) surgeFallback = true;
          else ctx.fail('PRICING_UNAVAILABLE', 'Surge prices are unavailable, so no fare can be quoted.');
          let distance;
          let minutes;
          let etaFallback = false;
          const r = yield ctx.call('eta', 'route', { from, to }, { timeout: 400 });
          if (r.ok) ({ distance, minutes } = r.value);
          else { distance = dist(from, to); minutes = distance * 2 + 2; etaFallback = true; }
          const quoteId = 'q-' + ++st.seq.quote;
          const q = {
            quoteId, cell, multiplier, surgeFallback, etaFallback, distance, minutes,
            fare: fareFor(distance, multiplier), pickup: { x: from.x, y: from.y }, dropoff: { x: to.x, y: to.y },
            pickupLabel: from.label, dropoffLabel: to.label, expiresAt: ctx.now() + 120000,
          };
          st.quotes[quoteId] = q;
          return q;
        },
      },
      surge: {
        quote(ctx, p) {
          const s = ctx.state.surge;
          s.demand.push({ cell: p.cell, t: ctx.now() });
          s.demand = s.demand.filter((d) => ctx.now() - d.t < DEMAND_WINDOW);
          return { multiplier: s.mult[p.cell] || 1, updatedAt: s.updatedAt };
        },
        demand(ctx) {
          const out = {};
          for (const d of ctx.state.surge.demand) if (ctx.now() - d.t < DEMAND_WINDOW) out[d.cell] = (out[d.cell] || 0) + 1;
          return out;
        },
        set(ctx, p) {
          ctx.state.surge.mult = p.mult;
          ctx.state.surge.updatedAt = ctx.now();
          return { cells: Object.keys(p.mult).length };
        },
      },
      eta: {
        route(ctx, p) { const d = dist(p.from, p.to); return { distance: d, minutes: d * 2 + 1 }; },
        rank(ctx, p) {
          return p.candidates.map((c) => Object.assign({}, c, { eta: dist(c, p.pickup) * 2 + 1 })).sort((a, b) => a.eta - b.eta || (a.id < b.id ? -1 : 1));
        },
      },

      /* location */
      location: {
        update: function* (ctx, p) {
          const st = ctx.state;
          st.stats.pings++;
          ctx.must(yield ctx.call('geoindex', 'upsert', p, { timeout: 400 }));
          const s = yield ctx.call('locstream', 'publish', { pings: [{ driver: p.driver, x: p.x, y: p.y }] }, { timeout: 300 });
          if (!s.ok) st.stats.streamDrops++;
          // Live tracking: forward to the rider of an active trip (subscription fed by trip events; simplified).
          const d = st.drivers[p.driver];
          const t = d && d.trip ? st.trips[d.trip] : null;
          if (t && ACTIVE.includes(t.status)) yield ctx.call('realtime', 'push', { to: t.rider, type: 'driverLocation', trip: t.id, x: p.x, y: p.y }, { timeout: 400 });
          return { stored: true, streamed: s.ok };
        },
        pingBatch: function* (ctx, p) {
          const st = ctx.state;
          st.stats.pings += p.pings.length;
          ctx.must(yield ctx.call('geoindex', 'upsertMany', p, { timeout: 500 }));
          const s = yield ctx.call('locstream', 'publish', p, { timeout: 300 });
          if (!s.ok) st.stats.streamDrops += p.pings.length;
          return { stored: p.pings.length, streamed: s.ok };
        },
      },
      geoindex: {
        upsert(ctx, p) { ctx.state.geo[p.driver] = { x: p.x, y: p.y, cell: cellOf(p.x, p.y), lastSeen: ctx.now() }; return { cell: cellOf(p.x, p.y) }; },
        upsertMany(ctx, p) { for (const q of p.pings) ctx.state.geo[q.driver] = { x: q.x, y: q.y, cell: cellOf(q.x, q.y), lastSeen: ctx.now() }; return { count: p.pings.length }; },
        nearby(ctx, p) {
          const drivers = [];
          const stale = [];
          for (const [id, g] of Object.entries(ctx.state.geo)) {
            if (Math.abs(g.x - p.x) + Math.abs(g.y - p.y) > p.radius) continue;
            if (ctx.now() - g.lastSeen > STALE_MS) { stale.push(id); continue; }
            drivers.push({ id, x: g.x, y: g.y, d: Math.abs(g.x - p.x) + Math.abs(g.y - p.y) });
          }
          ctx.state.stats.staleSkipped += stale.length;
          return { drivers, stale };
        },
      },
      locstream: {
        publish(ctx, p) { ctx.sim.enqueue('geo', { type: 'location', payload: p, quiet: true }); return { appended: true }; },
      },

      /* trips */
      trip: {
        create: function* (ctx, p) {
          const st = ctx.state;
          const q = st.quotes[p.quoteId];
          if (!q) ctx.fail('QUOTE_NOT_FOUND', 'That price has expired. Get a new price.');
          ctx.ledger('accepted', 'yes', 'The trip service validated the quote.');
          const row = ctx.must(yield ctx.call('tripdb', 'create', {
            key: p.key, rider: p.rider, fare: q.fare, multiplier: q.multiplier, pickup: q.pickup, dropoff: q.dropoff,
            pickupLabel: q.pickupLabel, dropoffLabel: q.dropoffLabel, requestActionId: ctx.actionId,
          }, { timeout: 500 }));
          if (row.status === 'REQUESTED' && !st.dispatching[row.trip]) {
            st.dispatching[row.trip] = true;
            ctx.spawn((c) => runDispatch(c, row), { self: 'trip' });
          }
          return { trip: row.trip, status: row.status, replayed: !!row.replayed };
        },
        assign: function* (ctx, p) { return ctx.must(yield ctx.call('tripdb', 'transition', Object.assign({ to: 'ACCEPTED' }, p), { timeout: 500 })); },
        transition: function* (ctx, p) { return ctx.must(yield ctx.call('tripdb', 'transition', p, { timeout: 500 })); },
        lookup: function* (ctx, p) { return ctx.must(yield ctx.call('tripdb', 'byKey', p, { timeout: 500 })); },
      },
      tripdb: {
        create(ctx, p) {
          const st = ctx.state;
          if (st.config.idempotentCreate && st.tripKeys[p.key]) return Object.assign(rowOf(st.trips[st.tripKeys[p.key]]), { replayed: true });
          const id = 'trip-' + ++st.seq.trip;
          const t = Object.assign({ id, status: 'REQUESTED', version: 1, driver: null, createdAt: ctx.now() }, p);
          st.trips[id] = t;
          st.tripKeys[p.key] = id;
          outbox(ctx, t, 'trip.requested');
          ctx.ledger('committed', 'yes', 'The trip row, its request key, and a trip.requested outbox event were written in one transaction.');
          return rowOf(t);
        },
        transition(ctx, p) {
          const t = ctx.state.trips[p.trip];
          if (!t) ctx.fail('NOT_FOUND', `Trip ${p.trip} does not exist.`);
          if (t.status === p.to) return Object.assign(rowOf(t), { replayed: true });
          if (!(NEXT[t.status] || []).includes(p.to)) ctx.fail('INVALID_TRANSITION', `A trip cannot go from ${t.status} to ${p.to}.`);
          t.status = p.to;
          t.version++;
          if (p.driver) Object.assign(t, { driver: p.driver, driverName: p.driverName, car: p.car, etaMin: p.etaMin });
          if (p.reason) t.reason = p.reason;
          outbox(ctx, t, 'trip.' + p.to.toLowerCase());
          ctx.ledger('committed', 'yes', `Trip ${t.id} is now ${p.to} (version ${t.version}), with its event in the outbox.`, { ifPending: true });
          return rowOf(t);
        },
        byKey(ctx, p) {
          const id = ctx.state.tripKeys[p.key];
          return id ? Object.assign({ found: true }, rowOf(ctx.state.trips[id])) : { found: false };
        },
      },

      /* matching */
      dispatch: {
        driverStatus: function* (ctx, p) { return ctx.must(yield ctx.call('driverstate', 'setStatus', p, { timeout: 400 })); },
        accept(ctx, p) {
          const o = ctx.state.offers[p.offerId];
          if (!o) ctx.fail('NOT_FOUND', 'Unknown offer.');
          if (o.status !== 'pending') ctx.fail('OFFER_EXPIRED', `Offer ${p.offerId} is already ${o.status}.`);
          o.status = 'accepted';
          return { offerId: o.id, trip: o.trip };
        },
        decline(ctx, p) {
          const o = ctx.state.offers[p.offerId];
          if (o && o.status === 'pending') o.status = 'declined';
          return { offerId: p.offerId };
        },
        tripEvent: function* (ctx, p) {
          const r = ctx.must(yield ctx.call('trip', 'transition', { trip: p.trip, to: p.to }, { timeout: 1200 }));
          if (p.to === 'COMPLETED') yield ctx.call('driverstate', 'setStatus', { driver: p.driver, status: 'available' }, { timeout: 400 });
          return r;
        },
        match: function* (ctx, p) {
          const st = ctx.state;
          const tried = new Set();
          for (let round = 1; round <= 2; round++) {
            const n = ctx.must(yield ctx.call('geoindex', 'nearby', { x: p.pickup.x, y: p.pickup.y, radius: 6 }, { timeout: 700 }));
            if (n.stale.length) ctx.log({ op: 'stale drivers ignored', status: 'note', detail: `${n.stale.map(name).join(', ')} ${n.stale.length > 1 ? 'have' : 'has'} not sent a location for over ${STALE_MS / 1000} s, so dispatch will not offer them rides.` });
            let ranked;
            const r = yield ctx.call('eta', 'rank', { pickup: p.pickup, candidates: n.drivers }, { timeout: 500 });
            if (r.ok) ranked = r.value;
            else {
              ranked = n.drivers.slice().sort((a, b) => a.d - b.d).map((c) => Object.assign({ eta: c.d * 2 + 1 }, c));
              ctx.log({ op: 'ETA fallback', status: 'note', detail: 'The ETA service did not answer in time, so candidates are ranked by straight-line distance.' });
            }
            for (const c of ranked) {
              if (tried.has(c.id)) continue;
              tried.add(c.id);
              const res = yield ctx.call('driverstate', 'reserve', { driver: c.id, trip: p.trip }, { timeout: 400 });
              if (!res.ok) continue;
              if (!res.value.reserved) {
                ctx.log({ op: `skip ${name(c.id)}`, status: 'note', detail: `${name(c.id)} is ${res.value.reason === 'onTrip' ? 'busy' : res.value.reason}. Trying the next closest driver.` });
                continue;
              }
              const offerId = 'offer-' + ++st.seq.offer;
              const offer = (st.offers[offerId] = { id: offerId, driver: c.id, trip: p.trip, status: 'pending', expires: ctx.now() + OFFER_MS, actionId: ctx.actionId });
              const o = yield ctx.call('realtime', 'offer', {
                offerId, driver: c.id, trip: p.trip, fare: p.fare, pickup: p.pickup, dropoff: p.dropoff,
                pickupLabel: p.pickupLabel, dropoffLabel: p.dropoffLabel, etaMin: c.eta, expires: offer.expires,
              }, { timeout: 600 });
              if (!o.ok) {
                offer.status = 'undeliverable';
                yield ctx.call('driverstate', 'release', { driver: c.id, trip: p.trip }, { timeout: 400 });
                ctx.log({ op: 'offer undeliverable', status: 'retry', detail: `Could not reach ${name(c.id)}’s phone (${o.error.code}). Released them; trying the next driver.` });
                continue;
              }
              while (offer.status === 'pending' && ctx.now() < offer.expires) yield ctx.wait(100);
              if (offer.status !== 'accepted') {
                const why = offer.status === 'pending' ? `did not answer within ${OFFER_MS / 1000} s` : 'declined';
                if (offer.status === 'pending') offer.status = 'expired';
                ctx.log({ op: `offer ${offer.status}`, status: 'retry', detail: `${name(c.id)} ${why}. Releasing the reservation and offering the next driver.` });
                if (c.id === 'd1') yield ctx.call('realtime', 'push', { to: 'd1', type: 'offer.expired', offerId }, { timeout: 400 });
                yield ctx.call('driverstate', 'release', { driver: c.id, trip: p.trip }, { timeout: 400 });
                continue;
              }
              const a = yield ctx.call('driverstate', 'assign', { driver: c.id, trip: p.trip }, { timeout: 400 });
              if (!a.ok) {
                ctx.log({ op: 'assignment conflict', status: 'err', error: a.error, detail: `${name(c.id)} accepted, but the reservation was no longer valid. Telling the driver and moving on.` });
                if (c.id === 'd1') yield ctx.call('realtime', 'push', { to: 'd1', type: 'offer.revoked', offerId }, { timeout: 400 });
                continue;
              }
              ctx.must(yield ctx.call('trip', 'assign', { trip: p.trip, driver: c.id, driverName: name(c.id), car: DRIVERS[c.id].car, etaMin: c.eta }, { timeout: 800 }));
              return { driver: c.id, offerId };
            }
          }
          ctx.fail('NO_DRIVERS', 'No nearby driver was available to accept.');
        },
      },
      driverstate: {
        setStatus(ctx, p) {
          const d = ctx.state.drivers[p.driver];
          d.status = p.status;
          d.version++;
          d.offerTrip = null;
          if (p.status !== 'onTrip') d.trip = null;
          return { status: d.status, version: d.version };
        },
        reserve(ctx, p) {
          const st = ctx.state;
          const d = st.drivers[p.driver];
          if (!d) return { reserved: false, reason: 'unknown' };
          if (st.config.cas) {
            if (d.status !== 'available') return { reserved: false, reason: d.status };
          } else if (d.status !== 'available' && d.status !== 'offered') {
            // Without compare-and-set, a reservation overwrites one that is still in flight.
            return { reserved: false, reason: d.status };
          }
          d.status = 'offered';
          d.offerTrip = p.trip;
          d.version++;
          return { reserved: true, version: d.version };
        },
        assign(ctx, p) {
          const st = ctx.state;
          const d = st.drivers[p.driver];
          if (st.config.cas && (d.status !== 'offered' || d.offerTrip !== p.trip)) ctx.fail('CONFLICT', `${name(p.driver)} is no longer reserved for ${p.trip}.`);
          d.status = 'onTrip';
          d.trip = p.trip;
          d.version++;
          return { status: d.status, version: d.version };
        },
        release(ctx, p) {
          const d = ctx.state.drivers[p.driver];
          if (d.status === 'offered' && d.offerTrip === p.trip) {
            d.status = 'available';
            d.offerTrip = null;
            d.version++;
          }
          return { status: d.status };
        },
      },

      /* after the trip */
      events: {
        publish(ctx, p) { ctx.sim.enqueue('tripEvents', { type: p.type, payload: p, actionId: ctx.actionId }); return { appended: true }; },
      },
      provider: {
        charge(ctx, p) {
          const st = ctx.state;
          if (st.charges[p.key]) return Object.assign({ replayed: true }, st.charges[p.key]);
          st.charges[p.key] = { chargeId: 'ch-' + (Object.keys(st.charges).length + 1), trip: p.trip, amount: p.amount, t: ctx.now() };
          return st.charges[p.key];
        },
      },
    },

    setup(sim) {
      // Simulated fleet: their phones report positions every 1.5 s (hidden from the timeline).
      sim.spawn(function* (ctx) {
        let failing = false;
        for (;;) {
          const st = ctx.state;
          const pings = FLEET.map((id) => ({ driver: id, x: st.pos[id].x, y: st.pos[id].y }));
          const r = ctx.sim.nodes.realtime.modes.down
            ? { ok: false, error: { code: 'UNAVAILABLE', message: 'Realtime gateway is down.' } }
            : yield ctx.call('location', 'pingBatch', { pings }, { timeout: 800, quiet: 'all' });
          if (!r.ok && !failing) {
            failing = true;
            ctx.log({ op: 'fleet locations failing', status: 'err', error: r.error, detail: `Location updates from the ${FLEET.length} simulated drivers are not getting through. Their positions go stale after ${STALE_MS / 1000} s.` });
          } else if (r.ok && failing) {
            failing = false;
            ctx.log({ op: 'fleet locations restored', status: 'recovered', detail: 'Simulated drivers are reporting positions again.' });
          }
          yield ctx.wait(FLEET_MS);
        }
      }, { self: 'realtime', quiet: 'all' });

      // Outbox relay: committed trip events move to the broker.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('outbox', 'events');
          ctx.sim.enqueue('tripEvents', { type: msg.type, payload: msg.payload, actionId: msg.actionId });
          ctx.ack('outbox', 'events');
        }
      }, { self: 'events' });

      // Notifications: every trip event becomes a push to the rider's phone.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('tripEvents', 'notify');
          if (msg.type === 'trip.requested') { ctx.ack('tripEvents', 'notify'); continue; }
          let backoff = 150;
          for (let attempt = 1; attempt <= 6; attempt++) {
            const r = yield ctx.call('realtime', 'push', Object.assign({ to: msg.payload.rider, type: msg.type }, msg.payload), { timeout: 700, actionId: msg.actionId });
            if (r.ok) break;
            ctx.sim.retries++;
            ctx.log({ op: 'push retry', status: 'retry', error: r.error, actionId: msg.actionId, detail: `Could not deliver ${msg.type} to the rider’s phone. The trip itself is saved; retrying in ${backoff} ms.` });
            yield ctx.wait(backoff);
            backoff = Math.min(2000, backoff * 2);
          }
          ctx.ack('tripEvents', 'notify');
        }
      }, { self: 'notify' });

      // Payments: charge completed trips, retrying with an idempotency key.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('tripEvents', 'payments');
          if (msg.type !== 'trip.completed') { ctx.ack('tripEvents', 'payments'); continue; }
          const ev = msg.payload;
          const st = ctx.state;
          let backoff = 250;
          let attempt = 0;
          for (;;) {
            attempt++;
            const key = st.config.idempotentCharge ? `pay-${ev.trip}` : `pay-${ev.trip}-try${attempt}`;
            const r = yield ctx.call('provider', 'charge', { key, trip: ev.trip, amount: ev.fare }, { timeout: 700, actionId: msg.actionId });
            if (r.ok) break;
            ctx.sim.retries++;
            ctx.log({ op: 'charge retry', status: 'retry', error: r.error, actionId: msg.actionId, detail: `Charging ${money(ev.fare)} for ${ev.trip} failed. The ride is complete; retrying in ${backoff} ms with key ${key}${st.config.idempotentCharge ? ', so the rider cannot be charged twice' : ''}.` });
            ctx.explain(`The trip is finished and the driver has moved on. Only the charge is waiting: payments keeps retrying with backoff${st.config.idempotentCharge ? ' and the same idempotency key, so even a charge that succeeded without a reply cannot bill the rider twice' : '. The idempotency switch is off, so each attempt uses a new key'}.`);
            yield ctx.wait(backoff);
            backoff = Math.min(2000, backoff * 2);
          }
          st.paidTrips[ev.trip] = true;
          ctx.sim.setLedger(ev.requestActionId, 'async', 'yes', 'Driver assigned, trip completed, rider charged and sent a receipt.');
          for (;;) {
            const r = yield ctx.call('events', 'publish', { type: 'payment.captured', trip: ev.trip, to: ev.rider, rider: ev.rider, amount: ev.fare }, { timeout: 500, actionId: msg.actionId });
            if (r.ok) break;
            yield ctx.wait(500);
          }
          ctx.ack('tripEvents', 'payments');
        }
      }, { self: 'payments' });

      // Surge calculator: supply from the geo stream, demand from the surge store.
      sim.spawn(function* (ctx) {
        let lastCalc = -1000;
        for (;;) {
          const { msg } = yield ctx.take('geo', 'surge');
          const st = ctx.state;
          const view = st.surgeView;
          for (const q of msg.payload.pings) {
            for (const c of Object.keys(view)) delete view[c][q.driver];
            const cell = cellOf(q.x, q.y);
            (view[cell] = view[cell] || {})[q.driver] = ctx.now();
          }
          if (ctx.now() - lastCalc >= 300) {
            lastCalc = ctx.now();
            const dm = yield ctx.call('surge', 'demand', {}, { timeout: 300, quiet: true });
            if (dm.ok) {
              const mult = {};
              const cells = new Set(Object.keys(dm.value).concat(Object.keys(view)));
              for (const c of cells) {
                const demand = dm.value[c] || 0;
                const supply = Math.max(1, Object.values(view[c] || {}).filter((t) => ctx.now() - t < STALE_MS * 2).length);
                const m = Math.min(3, Math.max(1, Math.round((1 + Math.max(0, demand / supply - 1) * 0.25) * 10) / 10));
                if (m > 1) mult[c] = m;
              }
              const before = st.surge.mult[AIRPORT_CELL] || 1;
              const s = yield ctx.call('surge', 'set', { mult }, { timeout: 300, quiet: true });
              const after = mult[AIRPORT_CELL] || 1;
              if (s.ok && before !== after) {
                ctx.log({ op: 'surge recalculated', status: 'note', detail: `Airport surge ${after > before ? 'rose' : 'fell'} from ${before.toFixed(1)}× to ${after.toFixed(1)}× (demand ${dm.value[AIRPORT_CELL] || 0} in the last 5 s versus supply ${Object.keys(view[AIRPORT_CELL] || {}).length}).` });
                if (after > before) ctx.explain(`Surge is a feedback loop: price checks at the airport count as demand, driver pings count as supply. Demand now outstrips supply ${(dm.value[AIRPORT_CELL] || 0)} to ${Object.keys(view[AIRPORT_CELL] || {}).length}, so the airport multiplier is ${after.toFixed(1)}×. Higher prices dampen demand and pull drivers in.`);
              }
            }
          }
          ctx.ack('geo', 'surge');
        }
      }, { self: 'surgecalc' });
    },

    consistency(sim) {
      const st = sim.state;
      const active = Object.values(st.trips).filter((t) => ACTIVE.includes(t.status));
      const byDriver = {};
      for (const t of active) (byDriver[t.driver] = byDriver[t.driver] || []).push(t.id);
      const dbl = Object.entries(byDriver).find(([, ts]) => ts.length > 1);
      if (dbl) return { key: 'wrong', label: `Double dispatch: ${name(dbl[0])} is assigned to ${dbl[1].join(' and ')} at once.` };
      const chargesByTrip = {};
      for (const c of Object.values(st.charges)) chargesByTrip[c.trip] = (chargesByTrip[c.trip] || 0) + 1;
      const twice = Object.entries(chargesByTrip).find(([, n]) => n > 1);
      if (twice) return { key: 'wrong', label: `Double charge: the rider was charged ${twice[1]} times for ${twice[0]}.` };
      const riderOpen = Object.values(st.trips).filter((t) => t.rider === 'rA' && ['REQUESTED'].concat(ACTIVE).includes(t.status));
      if (riderOpen.length > 1) return { key: 'wrong', label: `Double booking: one request created ${riderOpen.map((t) => t.id).join(' and ')}.` };
      const ui = sim.ui.rider;
      if (ui.tripId && st.trips[ui.tripId] && ui.status !== st.trips[ui.tripId].status) {
        return { key: 'stale', label: `Rider app shows ${ui.status}; the trip database says ${st.trips[ui.tripId].status}.` };
      }
      const unpaid = Object.values(st.trips).filter((t) => t.status === 'COMPLETED' && !st.paidTrips[t.id]);
      if (unpaid.length) return { key: 'stale', label: `${unpaid.map((t) => t.id).join(', ')} completed; payment still pending.` };
      return { key: 'ok', label: 'Rider app, trip database, driver state and payments agree.' };
    },

    metrics(snap, sim) {
      const st = sim.state;
      const m = st.surge.mult[AIRPORT_CELL] || 1;
      const lat = sim.nodes.geoindex.stats.lat.slice(-60).sort((a, b) => a - b);
      const p95 = SDL.percentile(lat, 95);
      const active = Object.values(st.trips).filter((t) => ACTIVE.includes(t.status)).length;
      const pending = Object.values(st.trips).filter((t) => t.status === 'COMPLETED' && !st.paidTrips[t.id]).length;
      return [
        { label: 'Airport surge', value: `${m.toFixed(1)}×`, tone: m > 1 ? 'warn' : 'ok' },
        { label: 'Geo index P95 (recent)', value: SDL.fmtMs(p95), tone: p95 > 100 ? 'fail' : p95 > 30 ? 'warn' : 'ok' },
        { label: 'Location updates received', value: st.stats.pings },
        { label: 'Stale drivers skipped', value: st.stats.staleSkipped, tone: st.stats.staleSkipped ? 'warn' : '' },
        { label: 'Active trips', value: active },
        { label: 'Payments pending', value: pending, tone: pending ? 'warn' : '' },
      ];
    },

    /* ---------------- the two phones ---------------- */
    product: {
      mount(el, sim) {
        const P = SDL.ui.phone;
        el.innerHTML = `
          <p class="panel-note phones-note">Tap the phones. Every tap sends a real request through the diagram; the arrows in each status bar light up while data leaves (↑) or arrives (↓).</p>
          <div class="phones">${P.frame('rider', 'Rider phone')}${P.frame('driver', 'Driver phone')}</div>`;
        el.querySelectorAll('.phone').forEach((ph) => P.wire(ph));
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-act]');
          if (!b || b.disabled) return;
          const args = b.dataset.arg ? JSON.parse(b.dataset.arg) : {};
          sim.dispatch(b.dataset.act, args);
        });
        el.addEventListener('change', (e) => {
          const t = e.target;
          if (t.dataset.field) sim.dispatch('riderSet', { field: t.dataset.field, value: t.value });
          if (t.dataset.opt) sim.dispatch('driverOption', { key: t.dataset.opt, on: t.checked });
        });
        this._keys = {};
      },
      render(el, sim) {
        const P = SDL.ui.phone;
        const esc = SDL.ui.esc;
        const st = sim.state;
        const r = sim.ui.rider;
        const d = sim.ui.driver;
        const riderEl = el.querySelector('[data-phone="rider"]');
        const driverEl = el.querySelector('[data-phone="driver"]');
        P.render(riderEl, sim, 'rider', r.banner, !!sim.nodes.rider.modes.down);
        P.render(driverEl, sim, 'driver', d.banner, !!sim.nodes.driver.modes.down);

        /* rider screen */
        const tripActive = r.tripId && !['COMPLETED', 'NO_DRIVERS'].includes(r.status);
        const pickup = PLACES[r.pickup];
        const dropoff = PLACES[r.dropoff];
        const opts = (sel) => Object.entries(PLACES).map(([k, p]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(p.label)}</option>`).join('');
        const rHead = `<div><p class="app-title">RideNow</p><p class="app-sub">Good morning, Sam</p></div>`;
        const rMap = mapSvg({ label: 'Rider map', pickup, dropoff, route: [pickup, dropoff], cars: r.car ? [{ x: r.car.x, y: r.car.y }] : [] });
        let rs = '';
        if (!r.tripId || !tripActive) {
          if (r.status === 'COMPLETED') {
            rs += `<div class="app-card is-ok"><strong>You’ve arrived</strong><span class="app-kv"><span>Fare</span><span>${money(st.trips[r.tripId] ? st.trips[r.tripId].fare : 0)}</span></span>
              <span class="app-kv"><span>Payment</span><span>${r.paid ? '✓ Paid' : '<span class="spinner"></span>Pending'}</span></span></div>
              <button class="app-btn secondary" data-act="riderReset">Book another ride</button>`;
          } else {
            const busy = r.quoting || r.requesting;
            rs += `<div class="app-row"><label for="rf">From</label><select id="rf" data-field="pickup"${busy ? ' disabled' : ''}>${opts(r.pickup)}</select></div>
              <div class="app-row"><label for="rt">To</label><select id="rt" data-field="dropoff"${busy ? ' disabled' : ''}>${opts(r.dropoff)}</select></div>`;
            if (r.status === 'NO_DRIVERS') rs += `<div class="app-card is-fail"><strong>No drivers available</strong><span class="app-sub">You weren’t charged. Try again.</span></div>`;
            rs += `<button class="app-btn${r.quote ? ' secondary' : ''}" data-act="estimate"${busy || r.pickup === r.dropoff ? ' disabled' : ''}>${r.quoting ? '<span class="spinner"></span>Getting prices…' : 'See prices'}</button>`;
            if (r.quote) {
              const q = r.quote;
              rs += `<div class="app-card${q.multiplier > 1 ? ' is-hot' : ''}">
                <span class="app-kv"><strong>Standard</strong><span class="app-price">${money(q.fare)}</span></span>
                <span class="app-kv"><span>${q.multiplier > 1 ? `⚡ ${q.multiplier.toFixed(1)}× surge` : 'No surge'}</span><span>${q.minutes} min trip</span></span>
                ${q.surgeFallback ? '<span class="app-sub">Surge unavailable: base fare applied</span>' : ''}
                ${q.etaFallback ? '<span class="app-sub">Estimated time is approximate</span>' : ''}
              </div>
              <button class="app-btn" data-act="request"${busy ? ' disabled' : ''}>${r.requesting ? '<span class="spinner"></span>Requesting…' : `Request Standard, ${money(q.fare)}`}</button>`;
            }
          }
        } else {
          const idx = STEP_ORDER.indexOf(r.status);
          rs += `<div class="app-steps" aria-label="Trip progress">${STEP_ORDER.map((s, i) => `<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}"></span>`).join('')}</div>`;
          if (r.status === 'REQUESTED') rs += `<div class="app-card is-work"><strong><span class="spinner"></span>Finding your driver…</strong><span class="app-sub">${esc(r.tripId)}: matching runs in the background</span></div>`;
          else {
            const lines = { ACCEPTED: `${esc(r.driver.name)} is on the way`, ARRIVED: `${esc(r.driver.name)} has arrived`, IN_PROGRESS: `Heading to ${esc(dropoff.label)}` };
            rs += `<div class="app-card is-ok"><strong>${lines[r.status] || esc(r.status)}</strong><span class="app-kv"><span>Car</span><span>${esc(r.driver ? r.driver.car : '')}</span></span>${r.status === 'ACCEPTED' ? `<span class="app-kv"><span>Pickup ETA</span><span>${r.eta} min</span></span>` : ''}</div>`;
          }
        }
        if (!tripActive || r.tone === 'fail' || r.tone === 'warn') rs += `<p class="app-msg" data-tone="${r.tone}">${esc(r.message)}</p>`;
        this._paint(riderEl, { head: rHead, map: rMap, body: rs }, {});

        /* driver screen */
        const pos = st.pos.d1;
        const link = d.online ? d.link : 'offline';
        const dot = link === 'online' ? 'on' : link === 'offline' ? '' : 'bad';
        const dHead = `<div><p class="app-title">RideNow Driver</p><p class="app-sub"><span class="app-dot ${dot}"></span>${d.connecting ? 'Connecting…' : { online: 'Online', offline: 'Offline', reconnecting: 'Reconnecting…', 'no signal': 'No signal' }[link]}${d.online ? `, <span data-live="pings"></span> location updates sent` : ''}</p></div>`;
        const dt = d.trip;
        const dMap = mapSvg({
          label: 'Driver map', surge: st.surge.mult,
          pickup: dt ? dt.pickup : d.offer ? d.offer.pickup : null,
          dropoff: dt ? dt.dropoff : d.offer ? d.offer.dropoff : null,
          cars: [{ x: pos.x, y: pos.y, cls: 'is-you' }],
        });
        let ds = '';
        const live = { pings: String(d.pings) };
        if (d.offer) {
          const left = Math.max(0, d.offer.expires - sim.now);
          live.countdown = `${(left / OFFER_MS) * 100}%`;
          live.countdownLabel = `${Math.ceil(left / 1000)} seconds left`;
          ds += `<div class="app-card is-hot"><strong>New request, ${money(d.offer.fare)}</strong>
            <span class="app-sub">${esc(d.offer.pickupLabel)} to ${esc(d.offer.dropoffLabel)}, ${d.offer.etaMin} min to pickup</span>
            <div class="app-countdown" data-live-label="countdownLabel"><i data-live-width="countdown"></i></div></div>
            <div class="app-row"><button class="app-btn go" style="flex:1" data-act="accept">Accept</button><button class="app-btn secondary" data-act="decline">Decline</button></div>`;
        } else if (dt) {
          const atPickup = dist(pos, dt.pickup) === 0;
          const atDrop = dist(pos, dt.dropoff) === 0;
          let btn = '';
          if (dt.status === 'ACCEPTED') btn = `<button class="app-btn" data-act="driverStep" data-arg='{"to":"ARRIVED"}'${!atPickup || d.busy ? ' disabled' : ''}>${atPickup ? 'Arrived at pickup' : `Driving to pickup, ${blocks(dist(pos, dt.pickup))} away`}</button>`;
          if (dt.status === 'ARRIVED') btn = `<button class="app-btn" data-act="driverStep" data-arg='{"to":"IN_PROGRESS"}'${d.busy ? ' disabled' : ''}>Start trip</button>`;
          if (dt.status === 'IN_PROGRESS') btn = `<button class="app-btn go" data-act="driverStep" data-arg='{"to":"COMPLETED"}'${!atDrop || d.busy ? ' disabled' : ''}>${atDrop ? 'Complete trip' : `Driving to ${esc(dt.dropoffLabel)}, ${blocks(dist(pos, dt.dropoff))} away`}</button>`;
          ds += `<div class="app-card is-work"><strong>${esc(dt.id)}: ${{ ACCEPTED: 'Pick up Sam', ARRIVED: 'Waiting for Sam', IN_PROGRESS: 'On trip' }[dt.status]}</strong><span class="app-sub">${esc(dt.pickupLabel)} to ${esc(dt.dropoffLabel)}, ${money(dt.fare)}</span></div>${btn}`;
        } else if (d.online) {
          ds += `<div class="app-card"><strong>Waiting for requests</strong><span class="app-sub">Orange cells on the map are surging.</span></div>`;
        }
        ds += `<label class="app-toggle"><input type="checkbox" data-opt="autoAccept"${d.autoAccept ? ' checked' : ''}> Auto-accept offers</label>
          <label class="app-toggle"><input type="checkbox" data-opt="autoDrive"${d.autoDrive ? ' checked' : ''}> Auto-drive (demo)</label>`;
        ds += d.online
          ? `<button class="app-btn secondary" data-act="goOffline"${d.connecting || dt ? ' disabled' : ''}>Go offline</button>`
          : `<button class="app-btn go" data-act="goOnline"${d.connecting ? ' disabled' : ''}>Go online</button>`;
        ds += `<p class="app-sub">${esc(d.message)}${d.earnings ? ` Earned today: ${money(d.earnings)}.` : ''}</p>`;
        this._paint(driverEl, { head: dHead, map: dMap, body: ds }, live);
      },
      /**
       * Paint a phone screen in independent sections so a moving car or a
       * ticking countdown never rebuilds the buttons under the user's finger.
       * Sections are replaced only when their markup changes; values in `live`
       * are written in place every frame.
       */
      _paint(phoneEl, sections, live) {
        const screen = phoneEl.querySelector('.phone-screen');
        for (const [name, html] of Object.entries(sections)) {
          let sec = screen.querySelector(`:scope > [data-sec="${name}"]`);
          if (!sec) {
            sec = document.createElement('div');
            sec.dataset.sec = name;
            sec.className = 'app-sec';
            screen.appendChild(sec);
          }
          if (sec._html === html) continue;
          sec._html = html;
          const a = document.activeElement;
          const key = a && sec.contains(a) ? a.dataset.act || a.dataset.field || a.dataset.opt : null;
          sec.innerHTML = html;
          if (key) {
            const again = sec.querySelector(`[data-act="${key}"], [data-field="${key}"], [data-opt="${key}"]`);
            if (again && !again.disabled) again.focus();
          }
        }
        screen.querySelectorAll('[data-live]').forEach((n) => { const v = live[n.dataset.live]; if (v != null && n.textContent !== v) n.textContent = v; });
        screen.querySelectorAll('[data-live-width]').forEach((n) => { const v = live[n.dataset.liveWidth]; if (v != null) n.style.width = v; });
        screen.querySelectorAll('[data-live-label]').forEach((n) => { const v = live[n.dataset.liveLabel]; if (v != null) n.setAttribute('aria-label', v); });
      },
    },
  });

  sc.PLACES = PLACES;
  sc.AIRPORT_CELL = AIRPORT_CELL;
})(typeof window !== 'undefined' ? window : globalThis);
