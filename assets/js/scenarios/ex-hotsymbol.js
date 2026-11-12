/*
 * Hot symbols, sharding, and load shedding.
 * Sixteen symbols live on four engine partitions, one thread each. News hits
 * MEME and one member’s algorithm sends a hundred times the usual flow. The
 * partition that owns MEME also owns ACME, so Maya’s quiet ACME order waits
 * behind the flood. Isolating MEME on its own partition (a live move, with or
 * without draining), shedding when a partition is backed up, and a fair
 * queue per participant each change what Maya sees.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const PARTS = ['p1', 'p2', 'p3', 'p4'];
  const SPARE = 'p5';
  const SYMBOLS = {
    p1: ['ACME', 'MEME', 'BOLT', 'CORE'], p2: ['DELTA', 'ECHO', 'FOXI', 'GLOW'],
    p3: ['HALO', 'IRIS', 'JOLT', 'KITE'], p4: ['LUMA', 'MIST', 'NOVA', 'OPAL'],
  };
  const ALL = PARTS.flatMap((p) => SYMBOLS[p]);
  const PX = { ACME: 5020, MEME: 1240 };
  const SERVICE_MS = 2; // one thread, 500 orders a second
  const NORMAL = 15; // orders per second per symbol
  const FLOOD = 2000; // Zed’s algorithm on MEME
  const SHED_MS = 300;
  const FAIR_CAP = 10; // in-flight orders per participant on a backed-up partition
  const FAIR_FROM_MS = 100;
  const HOLD_MAX = 1500; // orders the router will hold for one symbol during a move
  const AUTO_RATE = 250; // orders per second on one symbol that triggers isolation
  const px = (c) => '$' + (c / 100).toFixed(2);
  const NAMES = { p1: 'Partition 1', p2: 'Partition 2', p3: 'Partition 3', p4: 'Partition 4', p5: 'Partition 5 (spare)' };

  function startOrder(sim, symbol) {
    const st = sim.state;
    sim.startAction(`Maya: buy 100 ${symbol}`, function* (ctx) {
      const u = ctx.ui.maya;
      const id = `maya-${++st.clientSeq}`;
      const rec = { id, symbol, qty: 100, status: 'sending', reason: '', ms: 0, partition: '' };
      u.orders.push(rec); u.pending++;
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'Client order id; the gateway deduplicates.'] });
      const t0 = ctx.now();
      const r = yield ctx.call('gateway', 'newOrder', { clientOrderId: id, owner: 'maya', symbol, qty: 100 }, { timeout: 1600 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending--; rec.ms = ctx.now() - t0;
      const part = st.map[symbol];
      const shared = Object.keys(st.map).filter((s) => st.map[s] === part && s !== symbol);
      if (r.ok) {
        rec.status = 'filled'; rec.px = r.value.px; rec.partition = r.value.partition;
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Sequenced #${r.value.seq} for ${symbol} on ${NAMES[r.value.partition]}.`], async: 'n/a' });
        const w = ctx.sim.queueWait(r.value.partition);
        ctx.explain(`Filled in ${SDL.fmtMs(rec.ms)} on ${NAMES[r.value.partition]}${shared.length ? `, which also owns ${shared.join(', ')}` : ', which owns nothing else'}. ${st.flood && r.value.partition === st.map.MEME ? `MEME’s flood shares that thread; the order waited ${SDL.fmtMs(w)} behind it.` : st.flood ? `MEME’s flood is on ${NAMES[st.map.MEME]}; this partition never saw it.` : 'A quiet partition answers in a round trip.'}${r.value.fair ? ' The fair queue admitted it while Zed’s algorithm sat at its cap.' : ''}`);
      } else {
        rec.status = 'rejected'; rec.reason = r.error.message; rec.code = r.error.code; rec.partition = part;
        Y.failed(ctx, r.error.code === 'BUSY' ? 'Refused at once with “busy”, not after a long wait.' : 'The order failed.');
        const why = {
          TIMEOUT: `${NAMES[part]} owns ${symbol}${shared.includes('MEME') || symbol === 'MEME' ? ' and MEME. Every MEME order from Zed’s algorithm sits in the same single-threaded queue' : ''}; the order waited ${SDL.fmtMs(rec.ms)} and the broker gave up. Nobody knows whether it will still execute.`,
          BUSY: `${NAMES[part]}’s queue is over ${SHED_MS} ms, so the router refused the order immediately instead of letting it time out. Quick, honest, and retryable; but Maya still cannot trade ${symbol}.`,
          WRONG_PARTITION: `The router’s map still says ${symbol} is on ${NAMES[st.routerMap[symbol]]}; the partition said it no longer owns the symbol, and the router could not refresh its map.`,
          UNAVAILABLE: `${NAMES[part]} is down. Every symbol it owns is untradeable; the other partitions are fine.`,
        }[r.error.code];
        ctx.explain(why || r.error.message);
      }
    }, { self: 'maya' });
  }

  function startMove(sim, symbol, to, why) {
    const st = sim.state;
    if (st.moving[symbol] || st.map[symbol] === to) return;
    const from = st.map[symbol];
    sim.startAction(`${why || 'Operator'}: move ${symbol} ${NAMES[from]} → ${NAMES[to]}`, function* (ctx) {
      Y.L(ctx, { displayed: 'n/a', retrySafe: ['yes', 'Export and import are keyed by symbol and epoch.'] });
      const t0 = ctx.now();
      let held = 0;
      if (st.config.drain) {
        st.moving[symbol] = true;
        ctx.log({ op: `hold new ${symbol} orders`, status: 'note', detail: `The router holds new ${symbol} orders in arrival order while ${NAMES[from]} finishes the ones already queued.` });
        let waited = 0;
        while ((st.inflight[from][symbol] || 0) > 0 && waited < 4000) { yield ctx.wait(20); waited += 20; }
        held = st.held[symbol] || 0;
        ctx.log({ op: `${NAMES[from]} drained of ${symbol}`, status: 'ok', detail: `No ${symbol} order is in flight at ${NAMES[from]}; ${held} new orders are waiting at the router.` });
      }
      if (st.config.drain) {
        const ex = yield ctx.call(from, 'export', { symbol }, { timeout: 3000 });
        if (!ex.ok) { st.moving[symbol] = false; releaseHeld(ctx.sim, symbol); Y.failed(ctx, 'The move was abandoned; the symbol stays where it was.'); return; }
        st.owner[symbol] = to; st.epoch[symbol]++;
        ctx.must(yield ctx.call(to, 'import', { symbol, book: ex.value.book, epoch: st.epoch[symbol] }, { timeout: 800 }));
      } else {
        // Flip first, copy the book from the controller’s snapshot, and let the old partition clean up when it gets to it.
        const snap = Object.assign({}, st.books[from][symbol]);
        st.owner[symbol] = to; st.epoch[symbol]++;
        ctx.must(yield ctx.call(to, 'import', { symbol, book: snap, epoch: st.epoch[symbol] }, { timeout: 800 }));
        ctx.spawn(function* (c) { yield c.call(from, 'export', { symbol }, { timeout: 6000, quiet: true }); });
      }
      st.map[symbol] = to;
      const rf = yield ctx.call('router', 'refresh', { map: Object.assign({}, st.map) }, { timeout: 400 });
      st.moving[symbol] = false;
      releaseHeld(ctx.sim, symbol);
      st.stats.moves++;
      Y.L(ctx, { accepted: 'yes', committed: ['yes', `${symbol} now sequences on ${NAMES[to]} (epoch ${st.epoch[symbol]}).`], async: 'n/a' });
      ctx.explain(`${symbol} moved in ${SDL.fmtMs(ctx.now() - t0)}. ${st.config.drain ? `Draining first meant ${held} new orders waited at the router, but every order kept its place in line.` : `Without draining, ${symbol} orders already queued at ${NAMES[from]} are rejected as “not owner” when their turn comes and resubmitted to ${NAMES[to]}, behind orders that arrived after them.`}${rf.ok ? '' : ' The router did not take the new map: it will learn by being told “not owner”.'}${to === SPARE ? ` ACME and the rest of ${NAMES[from]} no longer share a thread with ${symbol}.` : ''}`);
    }, { self: 'ctrl' });
  }

  function setFlood(sim, on) { sim.state.flood = on; sim.note(on ? `News on MEME: Zed’s algorithm sends ${Y.num(FLOOD)} orders a second.` : 'Zed’s algorithm stopped.'); }

  const sc = (SDL.scenarios['ex-hotsymbol'] = {
    id: 'ex-hotsymbol',
    seed: 505,
    productWidth: 640,
    minHopMs: 5,
    intro: 'Start the MEME flood, then buy ACME from Maya’s phone and watch it wait behind MEME on the same partition. Move MEME to the spare partition live, with and without draining, then add shedding and a fair queue.',
    topology: {
      width: 1160, height: 620,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'Finch broker app', x: 90, y: 100, latency: 1, role: 'Buys ACME and MEME.', owns: ['What Maya sees'] },
        { id: 'members', label: 'Other members', kind: 'client', sub: `${NORMAL}/s per symbol`, x: 90, y: 300, latency: 1, role: `Steady background flow: ${NORMAL} orders a second on each of ${ALL.length} symbols.`, owns: ['Their orders'] },
        { id: 'zed', label: 'Zed Capital', kind: 'client', sub: 'Algorithm on MEME', x: 90, y: 500, latency: 1, role: `When the news hits, sends ${Y.num(FLOOD)} MEME orders a second.`, owns: ['Its orders'] },
        { id: 'gateway', label: 'Order entry gateway', kind: 'gateway', sub: 'Dedupe, forward', x: 330, y: 300, latency: 1, role: 'Deduplicates by client order id and hands orders to the router.', ops: [{ name: 'newOrder', desc: 'Forward.' }], owns: ['Client order ids'] },
        { id: 'router', label: 'Symbol router', kind: 'service', sub: 'Symbol → partition', x: 560, y: 300, latency: 1, role: 'Holds a copy of the partition map. Sheds when a partition is backed up; with the fair queue, caps each participant’s in-flight orders on a backed-up partition.', ops: [{ name: 'route', desc: 'Send to the owning partition.' }, { name: 'refresh', desc: 'Take a new map.' }], owns: ['Map copy', 'In-flight counts'] },
        { id: 'ctrl', label: 'Partition controller', kind: 'service', sub: 'Owns the map', x: 560, y: 100, latency: 2, role: 'The authority on which partition owns which symbol. Moves a symbol: drain, export, import, flip, refresh the router.', ops: [{ name: 'getMap', desc: 'Current map.' }], owns: ['The map', 'Epochs'] },
        { id: 'p1', label: 'Partition 1', kind: 'worker', sub: SYMBOLS.p1.join(' '), x: 240, y: 540, latency: 1, serviceMs: SERVICE_MS, role: `One thread, ${SERVICE_MS} ms per order: ${1000 / SERVICE_MS} a second for every symbol it owns together.`, ops: [{ name: 'submit', desc: 'Sequence and fill.' }, { name: 'export', desc: 'Hand a book over.' }, { name: 'import', desc: 'Take a book.' }], owns: ['Books for its symbols'] },
        { id: 'p2', label: 'Partition 2', kind: 'worker', sub: SYMBOLS.p2.join(' '), x: 440, y: 540, latency: 1, serviceMs: SERVICE_MS, role: 'Same capacity.', ops: [{ name: 'submit', desc: 'Sequence and fill.' }], owns: ['Books for its symbols'] },
        { id: 'p3', label: 'Partition 3', kind: 'worker', sub: SYMBOLS.p3.join(' '), x: 640, y: 540, latency: 1, serviceMs: SERVICE_MS, role: 'Same capacity.', ops: [{ name: 'submit', desc: 'Sequence and fill.' }], owns: ['Books for its symbols'] },
        { id: 'p4', label: 'Partition 4', kind: 'worker', sub: SYMBOLS.p4.join(' '), x: 840, y: 540, latency: 1, serviceMs: SERVICE_MS, role: 'Same capacity.', ops: [{ name: 'submit', desc: 'Sequence and fill.' }], owns: ['Books for its symbols'] },
        { id: 'p5', label: 'Partition 5', kind: 'worker', sub: 'spare', x: 1040, y: 540, latency: 1, serviceMs: SERVICE_MS, role: 'An idle partition kept for exactly this: a symbol that needs a thread of its own. It cannot make one book faster than one thread.', ops: [{ name: 'submit', desc: 'Sequence and fill.' }, { name: 'import', desc: 'Take a book.' }], owns: ['Nothing until a move'] },
      ],
      edges: [
        { from: 'maya', to: 'gateway', latency: 40 },
        { from: 'members', to: 'gateway', latency: 1 },
        { from: 'zed', to: 'gateway', latency: 1 },
        { from: 'gateway', to: 'router', latency: 1 },
        { from: 'router', to: 'ctrl', latency: 1 },
        { from: 'ctrl', to: 'p1', latency: 1, via: [[700, 100], [700, 440], [240, 440]] },
        { from: 'ctrl', to: 'p5', latency: 1, via: [[1040, 100]] },
        { from: 'router', to: 'p1', latency: 1 },
        { from: 'router', to: 'p2', latency: 1 },
        { from: 'router', to: 'p3', latency: 1 },
        { from: 'router', to: 'p4', latency: 1 },
        { from: 'router', to: 'p5', latency: 1 },
      ],
      queues: [],
    },
    modeLabels: { staleMap: 'Ignoring map updates' },
    failures: [
      { id: 'p1-slow', node: 'p1', mode: 'slow', params: { factor: 10 }, label: 'Partition 1 slow', desc: 'Every symbol on it waits, flood or not.' },
      { id: 'p1-down', node: 'p1', mode: 'down', label: 'Partition 1 down', desc: 'ACME, MEME, BOLT, CORE untradeable; the rest unaffected.' },
      { id: 'router-stale', node: 'router', mode: 'staleMap', label: 'Router map stale', desc: 'The router keeps its old map after a move; partitions answer “not owner”.' },
      { id: 'ctrl-down', node: 'ctrl', mode: 'down', label: 'Controller down', desc: 'No moves; the router cannot refresh.' },
      { id: 'gateway-down', node: 'gateway', mode: 'down', label: 'Gateway down', desc: 'Nobody can send orders.' },
    ],
    switches: Y.switches([
      ['autoIsolate', 'Isolate a hot symbol automatically', `When one symbol is offered more than ${AUTO_RATE} orders a second (half a partition’s capacity) and shares its partition, the controller moves it to the spare partition.`],
      ['drain', 'Drain before flipping the map', 'Hold new orders at the router until the old partition has finished the queued ones, then flip. Off: flip at once; queued orders are rejected and resubmitted behind newer ones.'],
      ['shed', `Shed when a partition is over ${SHED_MS} ms`, 'The router refuses new orders for a backed-up partition with “busy” instead of letting them queue and time out.'],
      ['fairQueue', `Fair queue (${FAIR_CAP} in flight per participant)`, `On a partition more than ${FAIR_FROM_MS} ms behind, no participant may have more than ${FAIR_CAP} orders in flight. One member’s flood cannot fill the queue.`],
    ]),
    presets: Y.presets({ autoIsolate: false, drain: true, shed: false, fairQueue: false }, [
      { id: 'normal', label: 'Quiet market', desc: `${NORMAL} orders a second per symbol, 60 per partition against a capacity of 500. Maya’s ACME order fills in one round trip.`, run: (s) => s.schedule(600, () => startOrder(s, 'ACME')) },
      { id: 'flood', label: 'MEME flood, shared partition', desc: `Zed sends ${Y.num(FLOOD)} MEME orders a second to a partition that does 500. Maya’s ACME order shares that thread and times out behind MEME.`, run: (s) => { s.schedule(200, () => setFlood(s, true)); s.schedule(2000, () => startOrder(s, 'ACME')); s.schedule(4500, () => setFlood(s, false)); } },
      { id: 'flood-isolate', label: 'MEME isolated, ACME fine', desc: 'The operator moves MEME to the spare partition as the news breaks. ACME fills at once. MEME orders still queue and time out: one book is one thread, and isolation does not make it faster.', run: (s) => { s.schedule(200, () => setFlood(s, true)); s.schedule(300, () => startMove(s, 'MEME', SPARE)); s.schedule(2500, () => startOrder(s, 'ACME')); s.schedule(4500, () => setFlood(s, false)); } },
      { id: 'flood-shed', label: 'Isolated and shedding', desc: `MEME has its own partition and the router sheds when it is over ${SHED_MS} ms. Maya’s MEME order is refused in milliseconds with “busy”, not lost after a second and a half.`, sw: { shed: true }, run: (s) => { s.schedule(200, () => setFlood(s, true)); s.schedule(300, () => startMove(s, 'MEME', SPARE)); s.schedule(2500, () => startOrder(s, 'ACME')); s.schedule(3200, () => startOrder(s, 'MEME')); s.schedule(5500, () => setFlood(s, false)); } },
      { id: 'flood-fair', label: 'Fair queue: Maya trades MEME', desc: `Zed may have ${FAIR_CAP} MEME orders in flight, no more; the rest are refused at the router. The partition’s queue stays short and Maya’s MEME order fills.`, sw: { shed: true, fairQueue: true }, run: (s) => { s.schedule(200, () => setFlood(s, true)); s.schedule(300, () => startMove(s, 'MEME', SPARE)); s.schedule(2500, () => startOrder(s, 'ACME')); s.schedule(3200, () => startOrder(s, 'MEME')); s.schedule(5500, () => setFlood(s, false)); } },
      { id: 'flood-auto', label: 'Automatic isolation', desc: `Nobody is watching. The controller sees MEME offered more than ${AUTO_RATE} orders a second, drains it and moves it to the spare. ACME recovers; shedding and the fair queue handle MEME.`, sw: { autoIsolate: true, shed: true, fairQueue: true }, run: (s) => { s.schedule(200, () => setFlood(s, true)); s.schedule(3000, () => startOrder(s, 'ACME')); s.schedule(3600, () => startOrder(s, 'MEME')); s.schedule(5500, () => setFlood(s, false)); } },
      { id: 'move-drain', label: 'Live move with draining', desc: 'Normal traffic. MEME moves to the spare partition: new MEME orders are held at the router until the old partition finishes the queued ones. Every order keeps its place in line.', run: (s) => { s.schedule(500, () => startMove(s, 'MEME', SPARE)); s.schedule(1500, () => startOrder(s, 'MEME')); } },
      { id: 'move-nodrain', label: 'Live move without draining', desc: 'The map flips at once. MEME orders already queued at Partition 1 are rejected as “not owner” when their turn comes and resubmitted to Partition 5, behind orders that arrived later: time priority is lost.', sw: { drain: false }, run: (s) => { s.schedule(200, () => setFlood(s, true)); s.schedule(500, () => startMove(s, 'MEME', SPARE)); s.schedule(900, () => setFlood(s, false)); s.schedule(2500, () => startOrder(s, 'MEME')); } },
      { id: 'stale-map', label: 'Router map stale after a move', desc: 'MEME moves, but the router ignores the new map. Partition 1 answers “not owner”, the router cannot refresh, and Maya’s MEME order is rejected until the map is fixed.', run: (s) => { s.inject('router', 'staleMap', true, 3500); s.schedule(300, () => startMove(s, 'MEME', SPARE)); s.schedule(1500, () => startOrder(s, 'MEME')); } },
      { id: 'p1-down', label: 'Partition 1 down', desc: 'Four symbols untradeable, twelve unaffected. Blast radius is the partition, which is the point of partitioning.', run: (s) => { s.inject('p1', 'down'); s.schedule(500, () => startOrder(s, 'ACME')); } },
    ]),
    initialState: () => {
      const map = {}; for (const p of PARTS) for (const s of SYMBOLS[p]) map[s] = p;
      const books = {}; for (const p of PARTS.concat([SPARE])) books[p] = {};
      for (const p of PARTS) for (const s of SYMBOLS[p]) books[p][s] = { resting: 1000 };
      const inflight = {}; for (const p of PARTS.concat([SPARE])) inflight[p] = {};
      const epoch = {}; for (const s of ALL) epoch[s] = 1;
      return {
        config: { autoIsolate: false, drain: true, shed: false, fairQueue: false },
        map, routerMap: Object.assign({}, map), owner: Object.assign({}, map), epoch, books,
        inflight, inflightOwner: {}, held: {}, holdQueue: {}, moving: {}, clientSeq: 0, arrivals: 0, seen: {}, flood: false,
        seqBySym: {}, lastArr: {}, window: {}, rates: {},
        stats: { fills: 0, timeouts: 0, shed: 0, fairRefused: 0, notOwner: 0, resubmitted: 0, priorityViolations: 0, moves: 0, floodSent: 0, autoMoves: 0, holdRefused: 0 },
      };
    },
    initialUI: () => ({ maya: { pending: 0, orders: [] } }),
    actions: {
      order(sim, a) { startOrder(sim, a.symbol); },
      flood(sim, a) { setFlood(sim, !!a.on); },
      move(sim, a) { startMove(sim, a.symbol || 'MEME', a.to || SPARE); },
    },
    handlers: {
      gateway: {
        newOrder: function* (ctx, p) {
          const st = ctx.state;
          const key = `${p.owner}/${p.clientOrderId}`;
          if (st.seen[key]) return st.seen[key];
          const r = ctx.must(yield ctx.call('router', 'route', p, { timeout: 1500, quiet: p.quiet }));
          st.seen[key] = r;
          return r;
        },
      },
      router: {
        route: function* (ctx, p) {
          const st = ctx.state;
          const sym = p.symbol;
          const arr = ++st.arrivals;
          st.window[sym] = (st.window[sym] || 0) + 1;
          if (st.moving[sym]) {
            // Parked in arrival order. When the move completes, the router dispatches the whole line in one go, so nobody overtakes. The buffer is bounded.
            const q = (st.holdQueue[sym] = st.holdQueue[sym] || []);
            if (q.length >= HOLD_MAX) { st.stats.holdRefused++; ctx.fail('BUSY', `The router is already holding ${Y.num(HOLD_MAX)} ${sym} orders for the move.`); }
            const entry = { p, arr, result: null };
            q.push(entry);
            st.held[sym] = q.length;
            while (!entry.result) yield ctx.wait(10);
            if (!entry.result.ok) ctx.fail(entry.result.error.code, entry.result.error.message);
            return entry.result.value;
          }
          const r = yield* dispatch(ctx, p, arr);
          if (!r.ok) ctx.fail(r.error.code, r.error.message);
          return r.value;
        },
        refresh(ctx, p) {
          if (ctx.mode('staleMap')) { ctx.log({ op: 'map update ignored', status: 'warn', detail: 'The router kept its stale copy of the map.' }); return { applied: false }; }
          ctx.state.routerMap = Object.assign({}, p.map);
          return { applied: true };
        },
      },
      ctrl: { getMap(ctx) { return { map: Object.assign({}, ctx.state.map) }; } },
      p1: partition('p1'), p2: partition('p2'), p3: partition('p3'), p4: partition('p4'), p5: partition('p5'),
    },
    setup(sim) {
      let i = 0;
      Y.load(sim, 'members', () => NORMAL * ALL.length, function* (ctx) {
        const n = ++i;
        const r = yield ctx.call('gateway', 'newOrder', { clientOrderId: `m-${n}`, owner: `m${n % 40}`, symbol: ALL[n % ALL.length], qty: 10, quiet: 'all' }, { timeout: 1600, quiet: 'all' });
        if (!r.ok && r.error.code === 'TIMEOUT') ctx.state.stats.timeouts++;
      });
      Y.load(sim, 'zed', (s) => (s.state.flood ? FLOOD : 0), function* (ctx, n) {
        ctx.state.stats.floodSent++;
        const r = yield ctx.call('gateway', 'newOrder', { clientOrderId: `z-${n}`, owner: 'zed', symbol: 'MEME', qty: 10, quiet: 'all' }, { timeout: 1600, quiet: 'all' });
        if (!r.ok && r.error.code === 'TIMEOUT') ctx.state.stats.timeouts++;
      });
      // Controller: rate watch for automatic isolation.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(500);
          const st = ctx.state;
          for (const s of ALL) { st.rates[s] = (st.window[s] || 0) * 2; st.window[s] = 0; }
          if (!st.config.autoIsolate || !ctx.alive()) continue;
          const hot = ALL.find((s) => st.rates[s] > AUTO_RATE && Object.values(st.map).filter((p) => p === st.map[s]).length > 1);
          if (hot && !Object.values(st.map).includes(SPARE) && !st.moving[hot]) { st.stats.autoMoves++; startMove(ctx.sim, hot, SPARE, 'Controller'); }
        }
      }, { self: 'ctrl', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.maya;
      if (st.stats.priorityViolations) return { key: 'wrong', label: `${st.stats.priorityViolations} order${st.stats.priorityViolations === 1 ? '' : 's'} lost time priority: queued at the old partition before the move, rejected as “not owner”, and sequenced on the new one after later arrivals.` };
      if (u.pending) return { key: 'stale', label: 'Maya’s order is in flight.' };
      const last = u.orders[u.orders.length - 1];
      if (last && last.code === 'TIMEOUT') return { key: 'stale', label: `Maya’s ${last.symbol} order timed out after ${SDL.fmtMs(last.ms)} behind ${Y.num(st.stats.floodSent)} MEME orders on ${NAMES[last.partition]}. Nobody knows whether it will still execute.` };
      if (last && last.code === 'WRONG_PARTITION') return { key: 'stale', label: st.routerMap[last.symbol] !== st.map[last.symbol] ? `The router’s map is stale: ${last.symbol} orders go to ${NAMES[st.routerMap[last.symbol]]}, which no longer owns it.` : `Maya’s ${last.symbol} order was rejected while the router’s map was stale. The map has since been refreshed; she has to resend.` };
      if (last && last.code === 'UNAVAILABLE') return { key: 'stale', label: `${NAMES[st.map[last.symbol]]} is down: ${Object.keys(st.map).filter((s) => st.map[s] === st.map[last.symbol]).join(', ')} cannot trade.` };
      const slow = PARTS.concat([SPARE]).filter((p) => sim.queueWait(p) > SHED_MS);
      if (slow.length && !st.config.shed) return { key: 'stale', label: `${slow.map((p) => NAMES[p]).join(', ')} ${slow.length === 1 ? 'is' : 'are'} more than ${SHED_MS} ms behind and nothing refuses new orders: ${Y.num(st.stats.timeouts)} orders have timed out, unknown to their senders.` };
      const meme = st.map.MEME;
      const sharing = Object.keys(st.map).filter((s) => st.map[s] === meme && s !== 'MEME');
      return { key: 'ok', label: `Every sequenced order kept its time priority${st.stats.moves ? ` through ${st.stats.moves} live move${st.stats.moves === 1 ? '' : 's'}` : ''}. MEME is on ${NAMES[meme]}${sharing.length ? ` with ${sharing.join(', ')}` : ' alone'}${st.stats.shed + st.stats.fairRefused ? `; ${Y.num(st.stats.shed + st.stats.fairRefused)} orders were refused at the router instead of timing out` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const out = PARTS.concat([SPARE]).map((p) => { const w = sim.queueWait(p); return { label: `${NAMES[p].replace(' (spare)', '')} queue`, value: SDL.fmtMs(w), tone: sim.nodes[p].modes.down ? 'fail' : w > SHED_MS ? 'fail' : w > FAIR_FROM_MS ? 'warn' : 'ok' }; });
      out.push({ label: 'MEME orders/s', value: Y.num(st.rates.MEME || 0), tone: (st.rates.MEME || 0) > AUTO_RATE ? 'warn' : '' });
      out.push({ label: 'Timed out', value: Y.num(st.stats.timeouts), tone: st.stats.timeouts ? 'fail' : '' });
      out.push({ label: 'Refused at the router', value: Y.num(st.stats.shed + st.stats.fairRefused) });
      out.push({ label: 'Priority violations', value: st.stats.priorityViolations, tone: st.stats.priorityViolations ? 'fail' : '' });
      return out;
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Maya trades ACME and MEME. The console shows the five partitions: how long a new order would wait on each, and which symbols each one owns.',
          side: `<p class="ops-title">Engine partitions</p><div class="ops-traffic">${Y.btn('flood', 'News on MEME: start flood', { arg: { on: true } })}${Y.btn('flood', 'Stop flood', { arg: { on: false }, cls: 'secondary' })}${Y.btn('move', 'Move MEME to the spare partition', { arg: { symbol: 'MEME', to: SPARE }, cls: 'go' })}${Y.btn('move', 'Move MEME back to Partition 1', { arg: { symbol: 'MEME', to: 'p1' }, cls: 'secondary' })}</div><div data-ref="parts"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.maya;
        const card = (o) => `<div class="app-card ${o.status === 'filled' ? 'is-ok' : o.status === 'rejected' ? 'is-fail' : ''}"><span class="app-kv"><strong>Buy 100 ${o.symbol}</strong><span>${o.status === 'sending' ? '<span class="spinner"></span>' : `${esc(o.status)} · ${SDL.fmtMs(o.ms)}`}</span></span><span class="app-sub">${esc(o.status === 'filled' ? `${px(o.px)} on ${NAMES[o.partition]}` : o.reason)}</span></div>`;
        const wl = ['ACME', 'MEME'].map((s) => { const p = st.map[s]; const w = sim.queueWait(p); return `<div class="app-card ${sim.nodes[p].modes.down ? 'is-fail' : w > SHED_MS ? 'is-hot' : ''}"><span class="app-kv"><strong>${s}</strong><span>${px(PX[s])}</span></span><span class="app-sub">${NAMES[p]}${st.moving[s] ? ' · moving…' : ''} · ${sim.nodes[p].modes.down ? 'down' : `${SDL.fmtMs(w)} queue`}${s === 'MEME' && st.flood ? ` · ${Y.num(st.rates.MEME || 0)}/s` : ''}</span></div>`; }).join('');
        Y.paint(el, sim, 'maya', {
          head: '<div><p class="app-title">Finch</p><p class="app-sub">Maya · watchlist</p></div>',
          watch: wl,
          ticket: `<div class="app-row">${Y.btn('order', 'Buy 100 ACME', { arg: { symbol: 'ACME' } })}${Y.btn('order', 'Buy 100 MEME', { arg: { symbol: 'MEME' }, cls: 'secondary' })}</div>`,
          orders: u.orders.length ? `<p class="app-sub">Orders</p>${u.orders.slice(-3).reverse().map(card).join('')}` : '<p class="app-sub">No orders yet.</p>',
        }, {});
        const rows = PARTS.concat([SPARE]).map((p) => { const syms = Object.keys(st.map).filter((s) => st.map[s] === p); return `<div class="ops-row" data-part="${p}"><div class="ops-name"><strong>${esc(NAMES[p].replace(' (spare)', ''))}</strong><span>${syms.length ? syms.map((s) => (s === 'MEME' && st.flood ? `<strong>${s}</strong>` : s)).join(' ') : 'no symbols'}</span></div><div class="ops-bar"><i data-live-width="w-${p}"></i></div><span class="ops-val" data-live="v-${p}"></span></div>`; }).join('');
        const live = {};
        for (const p of PARTS.concat([SPARE])) { const w = sim.queueWait(p); live[`w-${p}`] = `${Math.min(100, (w / 2000) * 100)}%`; live[`v-${p}`] = sim.nodes[p].modes.down ? 'down' : `${SDL.fmtMs(w)} wait · ${Y.num((st.books[p] && Object.values(st.books[p]).reduce((a, b) => a + (b.fills || 0), 0)) || 0)} fills`; }
        const c = sim.scenario.consistency(sim);
        const box = el.querySelector('[data-ref="parts"]');
        SDL.ui.paintSections(box, {
          rows: `<div class="ops-shards">${rows}</div>`,
          stats: `<p class="app-sub">${st.flood ? `Zed: ${Y.num(FLOOD)}/s on MEME · ` : ''}${Y.num(st.stats.timeouts)} timed out · ${Y.num(st.stats.shed)} shed · ${Y.num(st.stats.fairRefused)} over the fair cap${st.stats.holdRefused ? ` · ${Y.num(st.stats.holdRefused)} refused while holding for a move` : ''} · ${st.stats.resubmitted} resubmitted after a move${st.config.autoIsolate ? ' · auto-isolation on' : ''}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, live);
        box.querySelectorAll('.ops-row').forEach((r) => { const w = sim.queueWait(r.dataset.part); r.dataset.tone = sim.nodes[r.dataset.part].modes.down ? 'fail' : w > SHED_MS ? 'fail' : w > FAIR_FROM_MS ? 'warn' : 'ok'; });
      },
    },
  });

  /** The router’s path for one order once it is not being held: fair queue, shedding, then the owning partition (resubmitting once on “not owner”). Returns a call-style result. */
  function* dispatch(ctx, p, arr) {
    const st = ctx.state;
    const sym = p.symbol;
    const err = (code, message) => ({ ok: false, error: { code, message } });
    let part = st.routerMap[sym];
    let fair = false;
    const w = ctx.sim.queueWait(part);
    if (st.config.fairQueue && w > FAIR_FROM_MS) {
      const io = (st.inflightOwner[part] = st.inflightOwner[part] || {});
      if ((io[p.owner] || 0) >= FAIR_CAP) { st.stats.fairRefused++; return err('BUSY', `${p.owner === 'maya' ? 'Maya' : p.owner} already has ${FAIR_CAP} orders in flight on ${NAMES[part]}.`); }
      fair = true;
    }
    if (st.config.shed && w > SHED_MS) { st.stats.shed++; return err('BUSY', `${NAMES[part]} is ${SDL.fmtMs(w)} behind; the order is refused rather than queued.`); }
    for (let attempt = 0; attempt < 2; attempt++) {
      // In flight at a partition until the partition itself processes it: a caller that gives up does not make the order go away.
      st.inflight[part][sym] = (st.inflight[part][sym] || 0) + 1;
      const io = (st.inflightOwner[part] = st.inflightOwner[part] || {});
      io[p.owner] = (io[p.owner] || 0) + 1;
      const r = yield ctx.call(part, 'submit', { symbol: sym, qty: p.qty, owner: p.owner, arr, resubmit: attempt > 0 }, { timeout: 1400, quiet: p.quiet });
      io[p.owner]--;
      if (!r.ok && r.error.code === 'UNAVAILABLE') st.inflight[part][sym]--;
      if (r.ok) return { ok: true, value: Object.assign({ partition: part, fair }, r.value) };
      if (r.error.code !== 'NOT_OWNER') return r;
      st.stats.notOwner++;
      const m = yield ctx.call('ctrl', 'getMap', {}, { timeout: 300, quiet: p.quiet });
      if (m.ok && !ctx.mode('staleMap', 'router')) st.routerMap = Object.assign({}, m.value.map);
      if (st.routerMap[sym] === part) return err('WRONG_PARTITION', `${NAMES[part]} says it does not own ${sym}, and the router’s map still points there.`);
      part = st.routerMap[sym];
      st.stats.resubmitted++;
      if (!p.quiet) ctx.log({ op: `resubmit ${sym} to ${NAMES[part]}`, status: 'retry', detail: 'The old partition no longer owns the symbol. The order goes to the back of the new partition’s queue.' });
    }
    return err('WRONG_PARTITION', 'No partition would take the order.');
  }
  /** Dispatch every held order for a symbol, in arrival order, in one tick. */
  function releaseHeld(sim, sym) {
    const st = sim.state;
    const list = st.holdQueue[sym] || [];
    st.holdQueue[sym] = [];
    st.held[sym] = 0;
    for (const e of list) sim.spawn(function* (c) { e.result = yield* dispatch(c, e.p, e.arr); }, { self: 'router', quiet: 'all' });
  }

  function partition(id) {
    return {
      submit(ctx, p) {
        const st = ctx.state;
        const sym = p.symbol;
        st.inflight[id][sym] = Math.max(0, (st.inflight[id][sym] || 0) - 1);
        if (st.owner[sym] !== id || !st.books[id][sym]) ctx.fail('NOT_OWNER', `${NAMES[id]} does not own ${sym}.`);
        const b = st.books[id][sym];
        const seq = (st.seqBySym[sym] = (st.seqBySym[sym] || 0) + 1);
        if (p.arr < (st.lastArr[sym] || 0)) { st.stats.priorityViolations++; if (p.resubmit && p.owner === 'maya') ctx.log({ op: 'priority lost', status: 'warn', detail: `Order ${p.arr} sequenced after order ${st.lastArr[sym]}, which arrived later.` }); }
        st.lastArr[sym] = Math.max(st.lastArr[sym] || 0, p.arr);
        b.fills = (b.fills || 0) + 1;
        st.stats.fills++;
        return { seq, px: PX[sym] || 1000, epoch: st.epoch[sym] };
      },
      export(ctx, p) {
        const st = ctx.state;
        const b = st.books[id][p.symbol];
        if (!b) ctx.fail('NOT_OWNER', `${NAMES[id]} has no book for ${p.symbol}.`);
        delete st.books[id][p.symbol];
        return { book: b };
      },
      import(ctx, p) { ctx.state.books[id][p.symbol] = p.book; return { ok: true }; },
    };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
