/*
 * Circuit breakers and auctions.
 * Limit up/limit down: a band around a reference price inside which trades
 * may print. A fill that would cross the band halts the stock instead. After
 * the halt the stock reopens through a call auction: orders collect, one
 * clearing price maximises the volume that can trade, everything crosses at
 * that price, and continuous trading resumes. The reference price comes from
 * a cache that can go stale, and the band calculator can go down.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const B = Y.book;

  const BAND = 0.05;
  const HALT_MS = 2000;
  const AUCTION_MS = 1500;
  const REF_WINDOW = 8; // reference = mean of the last 8 prints older than REF_LAG (a slow average: a two-second panic cannot move it)
  const REF_LAG = 2000;
  const OPEN_REF = 5000;
  const px = (c) => '$' + (c / 100).toFixed(2);

  const LIQUIDITY = [
    ['sell', 5020, 300], ['sell', 5030, 300], ['sell', 5040, 300], ['sell', 5100, 300], ['sell', 5200, 300], ['sell', 5300, 300],
    ['buy', 4990, 300], ['buy', 4980, 300], ['buy', 4950, 300], ['buy', 4900, 300], ['buy', 4850, 300], ['buy', 4800, 300], ['buy', 4700, 500], ['buy', 4600, 500],
  ];

  /** The true reference price: mean of recent prints that are old enough to count. */
  function trueRef(st, now) {
    const old = st.prints.filter((p) => now - p.t >= REF_LAG).slice(-REF_WINDOW);
    if (!old.length) return OPEN_REF;
    return Math.round(old.reduce((s, p) => s + p.px, 0) / old.length);
  }
  const bandsFor = (ref) => ({ ref, lo: Math.round(ref * (1 - BAND)), hi: Math.round(ref * (1 + BAND)) });

  function startOrder(sim, owner, o, opts) {
    opts = opts || {};
    const st = sim.state;
    const label = `${owner === 'maya' ? 'Maya' : owner === 'quill' ? 'Quill' : 'Nova'}: ${o.side} ${o.qty} ${o.px == null ? 'at market' : `limit ${px(o.px)}`}`;
    sim.startAction(label, function* (ctx) {
      const u = ctx.ui[owner];
      const id = `${owner}-${++st.clientSeq}`;
      const rec = { id, side: o.side, qty: o.qty, px: o.px, status: 'sending', detail: '' };
      if (u) u.orders.push(rec);
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call('gateway', 'newOrder', { id, owner, side: o.side, px: o.px, qty: o.qty }, { timeout: 1500, quiet: opts.quiet });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) {
        const v = r.value;
        rec.status = v.status; rec.detail = v.filled ? `${v.filled} filled @ ${px(v.avgPx)}${v.remaining ? `, ${v.remaining} ${v.status === 'queued' ? 'queued for the auction' : v.status === 'halted' ? 'cancelled by the halt' : 'rest'}` : ''}` : v.status === 'queued' ? 'queued for the auction' : v.reason || '';
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'yes', async: v.status === 'queued' ? ['pending', 'Fills at the auction.'] : 'n/a' });
        if (!opts.quiet) ctx.explain(v.status === 'queued' ? `Trading is ${st.phase}. The order was accepted into the auction book and will cross at the single clearing price when the stock reopens.` : v.halted ? `The order filled down to ${px(v.lastPx)} and the next fill would have printed at ${px(v.haltPx)}, outside the band ${px(v.bands.lo)}–${px(v.bands.hi)} around a reference of ${px(v.bands.ref)}. The engine halted ACME instead of printing it; the halt lasts ${HALT_MS / 1000} s and ${st.config.reopenAuction ? 'then a reopening auction collects orders for another ' + AUCTION_MS / 1000 + ' s' : 'then trading resumes where it left off'}.` : v.filled ? `${v.filled} filled at an average of ${px(v.avgPx)}, all inside the band ${px(v.bands.lo)}–${px(v.bands.hi)}${v.outside ? `, except ${v.outside} print${v.outside === 1 ? '' : 's'} outside it: with the bands off nothing stopped them` : ''}.` : `Rests at ${px(o.px)}.`);
      } else {
        rec.status = 'rejected'; rec.detail = r.error.message;
        Y.failed(ctx, r.error.code === 'HALTED' ? 'Rejected: trading is halted.' : 'Rejected.');
        if (!opts.quiet) ctx.explain(r.error.code === 'HALTED' ? 'The stock is halted and this venue rejects new orders during a halt. Maya can resend when it reopens; nothing was recorded.' : r.error.message);
      }
    }, { self: owner === 'nova' ? 'quill' : owner });
  }

  function startChunks(sim, owner, side, chunks, qty, every, px0) {
    sim.note(owner === 'quill' ? `Quill dumps ${chunks * qty} shares in ${chunks} market orders, one every ${every} ms.` : `Nova buys ${chunks * qty} shares in ${chunks} market orders, one every ${every} ms.`);
    for (let i = 0; i < chunks; i++) sim.schedule(i * every, () => startOrder(sim, owner, { side, qty, px: px0 == null ? null : px0 }, { quiet: true }));
  }

  /** Uncross the auction: one price that maximises executable volume; ties go to the price nearest the reference. */
  function uncross(sim, ctx) {
    const st = sim.state;
    const book = st.book;
    const buys = book.bids.map((o) => ({ id: o.id, owner: o.owner, px: o.px, qty: o.remaining, resting: true })).concat(st.auctionOrders.filter((o) => o.side === 'buy').map((o) => ({ id: o.id, owner: o.owner, px: o.px == null ? Infinity : o.px, qty: o.qty, resting: false, o })));
    const sells = book.asks.map((o) => ({ id: o.id, owner: o.owner, px: o.px, qty: o.remaining, resting: true })).concat(st.auctionOrders.filter((o) => o.side === 'sell').map((o) => ({ id: o.id, owner: o.owner, px: o.px == null ? 0 : o.px, qty: o.qty, resting: false, o })));
    const ref = trueRef(st, sim.now);
    const candidates = Array.from(new Set(buys.concat(sells).map((o) => o.px).filter((p) => Number.isFinite(p) && p > 0)));
    let best = null;
    for (const p of candidates) {
      const bq = buys.filter((o) => o.px >= p).reduce((s, o) => s + o.qty, 0);
      const sq = sells.filter((o) => o.px <= p).reduce((s, o) => s + o.qty, 0);
      const vol = Math.min(bq, sq);
      if (!best || vol > best.vol || (vol === best.vol && Math.abs(p - ref) < Math.abs(best.px - ref))) best = { px: p, vol };
    }
    const result = { px: best ? best.px : null, vol: best ? best.vol : 0, buyers: 0, sellers: 0 };
    if (best && best.vol > 0) {
      const p = best.px;
      buys.sort((a, b) => b.px - a.px); sells.sort((a, b) => a.px - b.px);
      let bi = 0, si = 0, left = best.vol;
      const take = (side, o, q) => { o.qty -= q; if (o.resting) { const r = book.byId[o.id]; if (r) { r.remaining -= q; if (r.remaining === 0) B.remove(book, o.id); } } else { o.o.filled += q; } };
      while (left > 0 && bi < buys.length && si < sells.length) {
        const b = buys[bi], s = sells[si];
        const q = Math.min(b.qty, s.qty, left);
        take('buy', b, q); take('sell', s, q); left -= q;
        st.prints.push({ px: p, qty: q, t: sim.now, phase: 'auction', buyer: b.owner, seller: s.owner });
        st.stats.auctionVolume += q;
        if (b.qty === 0) bi++;
        if (s.qty === 0) si++;
      }
    }
    // Whatever did not cross rests in the continuous book.
    for (const o of st.auctionOrders) {
      const left = o.qty - o.filled;
      if (left > 0 && o.px != null) B.rest(book, { id: o.id, owner: o.owner, side: o.side, px: o.px, qty: o.qty, remaining: left, tif: 'gtc', seq: o.seq });
      o.status = o.filled === o.qty ? 'filled' : o.px != null ? (o.filled ? 'partial' : 'resting') : o.filled ? 'partial' : 'cancelled';
      const u = sim.ui[o.owner];
      const rec = u && u.orders.find((x) => x.id === o.id);
      if (rec) { rec.status = o.status; rec.detail = o.filled ? `${o.filled} filled @ ${px(result.px)} in the auction` : o.px != null ? `rests at ${px(o.px)}` : 'market order: no auction volume, cancelled'; }
    }
    st.auctionOrders = [];
    st.lastUncross = result;
    st.stats.auctions++;
    st.reopenCheck = false; // the auction, not a sweep, set the reopening price
    sim.note(result.vol ? `Auction uncrossed at ${px(result.px)}: ${result.vol} shares at one price. Continuous trading resumes.` : 'Auction found no crossing volume. Continuous trading resumes with the book as it is.');
    if (ctx) ctx.log({ op: `uncross @ ${result.px == null ? '–' : px(result.px)}`, status: 'ok', detail: `${result.vol} shares; candidates ${candidates.length}; reference ${px(ref)}.` });
    publish(sim);
  }

  function publish(sim) {
    const st = sim.state;
    const best = B.best(st.book);
    sim.spawn(function* (c) { yield c.call('mdpub', 'publish', { phase: st.phase, bid: best.bid, ask: best.ask, last: st.prints.length ? st.prints[st.prints.length - 1].px : null }, { timeout: 300, quiet: 'all' }); }, { self: 'engine', quiet: 'all' });
  }

  function halt(sim, ctx, bands, haltPx) {
    const st = sim.state;
    st.phase = 'halted';
    st.halts.push({ t: sim.now, px: haltPx, bands });
    st.stats.halts++;
    st.lastPxBeforeHalt = st.prints.length ? st.prints[st.prints.length - 1].px : OPEN_REF;
    const real = bandsFor(trueRef(st, sim.now));
    if (haltPx >= real.lo && haltPx <= real.hi) { st.stats.wrongHalts++; ctx.log({ op: 'halt on a stale reference', status: 'warn', detail: `Halted at ${px(haltPx)} because the cached reference was ${px(bands.ref)} (band ${px(bands.lo)}–${px(bands.hi)}). The true reference is ${px(real.ref)}: the print was inside the real band ${px(real.lo)}–${px(real.hi)}.` }); }
    ctx.log({ op: `ACME halted at ${px(haltPx)}`, status: 'warn', detail: `Outside the band ${px(bands.lo)}–${px(bands.hi)} (reference ${px(bands.ref)}). Halt for ${HALT_MS} ms, then ${st.config.reopenAuction ? 'a reopening auction' : 'continuous trading'}.` });
    sim.spawn(function* (c) {
      yield c.wait(HALT_MS);
      if (st.config.reopenAuction) {
        st.phase = 'auction';
        c.log({ op: 'reopening auction begins', status: 'note', detail: `Orders collect for ${AUCTION_MS} ms; nothing prints until the uncross.` });
        publish(sim);
        yield c.wait(AUCTION_MS);
        const r = yield c.call('auction', 'uncross', {}, { timeout: 800 });
        if (!r.ok) c.log({ op: 'uncross failed', status: 'err', detail: r.error.message });
      } else {
        st.stats.reopensWithoutAuction++;
        c.log({ op: 'trading resumes without an auction', status: 'note', detail: 'The next order sweeps whatever is in the book.' });
      }
      st.phase = 'open';
      st.reopenCheck = true;
      // Orders queued while halted (and not auctioned) are processed now, in order.
      const queued = st.auctionOrders.splice(0);
      for (const o of queued) c.spawn(function* (cx) {
        const r = yield cx.call('gateway', 'newOrder', Object.assign({ requeued: true }, o), { timeout: 1500, quiet: true });
        const u = sim.ui[o.owner];
        const rec = u && u.orders.find((x) => x.id === o.id);
        if (rec && r.ok) { rec.status = r.value.status; rec.detail = r.value.filled ? `${r.value.filled} filled @ ${px(r.value.avgPx)} after the reopen` : r.value.status; }
        else if (rec) { rec.status = 'rejected'; rec.detail = r.error.message; }
      });
      publish(sim);
    }, { self: 'engine' });
  }

  const sc = (SDL.scenarios['ex-halt'] = {
    id: 'ex-halt',
    seed: 1987,
    productWidth: 620,
    intro: 'Let Quill dump 2,000 shares and watch the price hit the lower band, halt, and reopen through an auction. Turn the bands off, feed the calculator a stale reference, or reopen without an auction.',
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'Finch broker app', x: 90, y: 120, latency: 1, role: 'Buys 100 at market, sometimes during a halt.', owns: ['What Maya sees'] },
        { id: 'quill', label: 'Quill and Nova', kind: 'client', sub: 'Members with size', x: 90, y: 420, latency: 1, role: 'Quill dumps stock; Nova buys it up.', owns: ['Their orders'] },
        { id: 'gateway', label: 'Order entry gateway', kind: 'gateway', sub: 'Member sessions', x: 320, y: 270, latency: 1, role: 'Validates and forwards to the sequencer.', ops: [{ name: 'newOrder', desc: 'Forward an order.' }], owns: ['Sessions'] },
        { id: 'sequencer', label: 'Sequencer', kind: 'service', sub: 'Stamps and journals', x: 540, y: 270, latency: 1, role: 'Sequence numbers and the journal.', ops: [{ name: 'submit', desc: 'Sequence one message.' }], owns: ['Sequence counter'] },
        { id: 'engine', label: 'Matching engine', kind: 'worker', sub: 'Checks the band before every fill', x: 760, y: 270, latency: 1, serviceMs: 1, role: 'Matches in continuous trading, halts when a fill would leave the band, and holds orders for the auction.', ops: [{ name: 'process', desc: 'Apply one order.' }], owns: ['The book', 'trading phase'] },
        { id: 'bands', label: 'Band calculator', kind: 'service', sub: `±${BAND * 100}% of the reference`, x: 760, y: 90, latency: 2, role: 'Computes limit up/limit down bands from the reference price.', ops: [{ name: 'get', desc: 'Current bands.' }], owns: ['Nothing durable'] },
        { id: 'refcache', label: 'Reference price', kind: 'cache', sub: `Slow average of the tape`, x: 980, y: 90, latency: 1, role: 'The reference price the bands are built on, refreshed from the tape every half second.', ops: [{ name: 'get', desc: 'Reference price.' }, { name: 'set', desc: 'Refresh.' }], owns: ['reference'] },
        { id: 'auction', label: 'Auction engine', kind: 'worker', sub: 'Uncrossing', x: 760, y: 450, latency: 3, role: 'Finds the one price that maximises executable volume and crosses everything at it.', ops: [{ name: 'uncross', desc: 'Compute and execute the clearing price.' }], owns: ['Auction book'] },
        { id: 'mdpub', label: 'Market data', kind: 'service', sub: 'Phase, bands, prints', x: 980, y: 270, latency: 1, role: 'Tells everyone the trading phase, the bands, and each print.', ops: [{ name: 'publish', desc: 'Publish.' }], owns: ['Nothing durable'] },
      ],
      edges: [
        { from: 'maya', to: 'gateway', latency: 40 },
        { from: 'quill', to: 'gateway', latency: 1 },
        { from: 'gateway', to: 'sequencer', latency: 1 },
        { from: 'sequencer', to: 'engine', latency: 1 },
        { from: 'engine', to: 'bands', latency: 1 },
        { from: 'bands', to: 'refcache', latency: 1 },
        { from: 'engine', to: 'auction', latency: 1 },
        { from: 'engine', to: 'mdpub', latency: 1 },
        { from: 'auction', to: 'mdpub', latency: 1, via: [[980, 450]] },
        { from: 'engine', to: 'gateway', latency: 1, label: 'requeue', via: [[760, 360], [430, 360], [430, 270]] },
      ],
      queues: [],
    },
    failures: [
      { id: 'bands-down', node: 'bands', mode: 'down', label: 'Band calculator down', desc: 'The engine keeps using the last bands it saw.' },
      { id: 'ref-stale', node: 'refcache', mode: 'stale', label: 'Reference price stale', desc: 'The cache stops refreshing; bands sit around an old price.' },
      { id: 'auction-slow', node: 'auction', mode: 'slow', params: { factor: 60 }, label: 'Auction engine slow', desc: 'The reopen takes longer.' },
      { id: 'mdpub-down', node: 'mdpub', mode: 'down', label: 'Market data down', desc: 'Nobody is told about the halt.' },
      { id: 'engine-slow', node: 'engine', mode: 'slow', params: { factor: 60 }, label: 'Engine slow', desc: 'A dump queues up.' },
    ],
    switches: Y.switches([
      ['luld', 'Limit up/limit down bands', `A fill that would print more than ${BAND * 100}% from the reference halts the stock instead. Off: anything prints.`],
      ['reopenAuction', 'Reopen through an auction', `After the ${HALT_MS / 1000} s halt, collect orders for ${AUCTION_MS / 1000} s and cross them at one clearing price. Off: resume continuous trading at once.`],
      ['queueDuringHalt', 'Accept orders during a halt', 'Orders arriving while halted wait for the reopen. Off: they are rejected.'],
    ]),
    presets: Y.presets({ luld: true, reopenAuction: true, queueDuringHalt: true }, [
      { id: 'normal', label: 'A quiet buy', desc: 'Maya buys 100 at $50.20, well inside the band. Nothing to see, which is the point.', run: (s) => startOrder(s, 'maya', { side: 'buy', qty: 100, px: null }) },
      { id: 'panic', label: 'Dump, halt, auction', desc: 'Quill sells 2,000 shares in ten market orders. The tenth would print at $47.00, below the band, so the engine halts. Maya’s buy during the halt waits; the reopening auction crosses everything at one price.', run: (s) => { startChunks(s, 'quill', 'sell', 10, 200, 150); s.schedule(2200, () => startOrder(s, 'maya', { side: 'buy', qty: 100, px: null })); } },
      { id: 'panic-noluld', label: 'Dump with the bands off', desc: 'Same dump, nothing stops it: the tenth order prints at $47.00 and the next at $46.00, 8% below where the stock was two seconds earlier.', sw: { luld: false }, run: (s) => { startChunks(s, 'quill', 'sell', 11, 200, 150); s.schedule(2200, () => startOrder(s, 'maya', { side: 'buy', qty: 100, px: null })); } },
      { id: 'halt-reject', label: 'Order during a halt, rejected', desc: 'The venue rejects orders while halted. Maya’s buy is refused and she must resend after the reopen.', sw: { queueDuringHalt: false }, run: (s) => { startChunks(s, 'quill', 'sell', 10, 200, 150); s.schedule(2200, () => startOrder(s, 'maya', { side: 'buy', qty: 100, px: null })); } },
      { id: 'reopen-noauction', label: 'Reopen without an auction', desc: 'After the halt, continuous trading resumes at once. The queued orders sweep the book again and the first print gaps.', sw: { reopenAuction: false }, run: (s) => { startChunks(s, 'quill', 'sell', 10, 200, 150); s.schedule(2200, () => startOrder(s, 'maya', { side: 'buy', qty: 100, px: null })); } },
      { id: 'rally', label: 'A rally with a fresh reference', desc: 'Nova buys 1,800 shares in six orders over four seconds. The reference follows the tape, the band moves up with it, and the last fill at $53.00 is inside it: no halt.', run: (s) => { startChunks(s, 'nova', 'buy', 5, 300, 450); s.schedule(4200, () => startOrder(s, 'nova', { side: 'buy', qty: 300, px: null })); } },
      { id: 'rally-stale', label: 'A rally with a stale reference', desc: 'Same rally, but the reference cache stopped refreshing at $50.00. The band tops out at $52.50 and the fill at $53.00 halts the stock, although the real reference is above $50.70. A halt nobody needed.', run: (s) => { s.inject('refcache', 'stale'); startChunks(s, 'nova', 'buy', 5, 300, 450); s.schedule(4200, () => startOrder(s, 'nova', { side: 'buy', qty: 300, px: null })); } },
      { id: 'bands-down', label: 'Band calculator down', desc: 'The engine cannot get fresh bands and keeps the last ones. Trading continues, protected by numbers that are slowly going stale.', run: (s) => { s.inject('bands', 'down'); startOrder(s, 'maya', { side: 'buy', qty: 100, px: null }); } },
      { id: 'opening', label: 'Opening auction', desc: 'Before the open, orders collect without printing: Quill sells 400 at $49.80, Maya and Nova buy at market. At 9:30 the uncross finds the single price where the most shares trade.', run: (s) => { s.state.phase = 'auction'; s.note('Pre-open: orders collect, nothing prints until 9:30.'); startOrder(s, 'quill', { side: 'sell', qty: 400, px: 4980 }); s.schedule(400, () => startOrder(s, 'maya', { side: 'buy', qty: 100, px: null })); s.schedule(800, () => startOrder(s, 'nova', { side: 'buy', qty: 300, px: 4990 })); s.schedule(2500, () => openMarket(s)); } },
    ]),
    initialState: () => {
      const book = B.create();
      LIQUIDITY.forEach(([side, p, qty], i) => B.rest(book, { id: 'L' + i, owner: 'crowd', side, px: p, qty, remaining: qty, tif: 'gtc', seq: i + 1 }));
      return {
        config: { luld: true, reopenAuction: true, queueDuringHalt: true },
        book, seq: LIQUIDITY.length, clientSeq: 0, phase: 'open', prints: [], halts: [], auctionOrders: [], lastUncross: null, lastPxBeforeHalt: null,
        cachedRef: OPEN_REF, lastBands: bandsFor(OPEN_REF),
        stats: { halts: 0, wrongHalts: 0, outsideBand: 0, rejectedHalted: 0, queuedHalted: 0, auctions: 0, auctionVolume: 0, bandsFrozen: 0, reopensWithoutAuction: 0, reopenGap: 0 },
      };
    },
    initialUI: () => ({ maya: { orders: [] }, quill: { orders: [] }, nova: { orders: [] }, md: { phase: 'open', bid: 4990, ask: 5020, last: null } }),
    actions: {
      order(sim, a) { startOrder(sim, a.owner, { side: a.side, qty: a.qty, px: a.px == null ? null : a.px }); },
      dump(sim) { startChunks(sim, 'quill', 'sell', 10, 200, 150); },
      rally(sim) { startChunks(sim, 'nova', 'buy', 6, 300, 450); },
      open(sim) { openMarket(sim); },
    },
    handlers: {
      gateway: { newOrder: function* (ctx, p) { return ctx.must(yield ctx.call('sequencer', 'submit', p, { timeout: 1300, quiet: p.quiet })); } },
      sequencer: { submit: function* (ctx, p) { const seq = ++ctx.state.seq; return ctx.must(yield ctx.call('engine', 'process', Object.assign({ seq }, p), { timeout: 1200, quiet: p.quiet })); } },
      engine: {
        process: function* (ctx, p) {
          const st = ctx.state;
          if (st.phase !== 'open') {
            if (!st.config.queueDuringHalt && st.phase === 'halted') { st.stats.rejectedHalted++; ctx.fail('HALTED', 'Trading in ACME is halted; the order is rejected.'); }
            st.stats.queuedHalted++;
            st.auctionOrders.push({ id: p.id, owner: p.owner, side: p.side, px: p.px, qty: p.qty, filled: 0, seq: p.seq });
            return { status: 'queued', filled: 0, avgPx: 0, remaining: p.qty };
          }
          let bands;
          const b = yield ctx.call('bands', 'get', {}, { timeout: 300, quiet: p.quiet });
          if (b.ok) { bands = b.value; st.lastBands = bands; } else { bands = st.lastBands; st.stats.bandsFrozen++; }
          const opts = st.config.luld ? { collar: { ref: bands.ref, pct: BAND } } : {};
          const res = B.match(st.book, { id: p.id, owner: p.owner, side: p.side, px: p.px, qty: p.qty, tif: 'gtc', seq: p.seq }, opts);
          const real = bandsFor(trueRef(st, ctx.now()));
          let filled = 0, notional = 0, outside = 0;
          for (const f of res.fills) {
            if (st.reopenCheck && st.lastPxBeforeHalt != null) { st.reopenCheck = false; const gap = Math.round(((f.px - st.lastPxBeforeHalt) / st.lastPxBeforeHalt) * 1000) / 10; if (Math.abs(gap) > 1.5) st.stats.reopenGap = gap; }
            filled += f.qty; notional += f.qty * f.px;
            if (f.px < real.lo || f.px > real.hi) { outside++; st.stats.outsideBand++; }
            st.prints.push({ px: f.px, qty: f.qty, t: ctx.now(), phase: 'open', buyer: f.side === 'buy' ? p.owner : f.makerOwner, seller: f.side === 'buy' ? f.makerOwner : p.owner });
          }
          const out = { status: res.status, filled, avgPx: filled ? Math.round(notional / filled) : 0, remaining: res.remaining, bands, outside, reason: res.reason };
          if (res.reason && /collar/.test(res.reason)) {
            // The next fill would leave the band: halt instead of printing it.
            const opp = p.side === 'buy' ? st.book.asks : st.book.bids;
            const haltPx = opp.length ? opp[0].px : (p.side === 'buy' ? bands.hi : bands.lo);
            Object.assign(out, { halted: true, haltPx, lastPx: filled ? res.fills[res.fills.length - 1].px : (st.prints.length ? st.prints[st.prints.length - 1].px : OPEN_REF) });
            halt(ctx.sim, ctx, bands, haltPx);
            if (res.remaining > 0) {
              if (st.config.queueDuringHalt) { st.auctionOrders.push({ id: p.id, owner: p.owner, side: p.side, px: p.px, qty: res.remaining, filled: 0, seq: p.seq }); out.status = 'queued'; } else out.status = 'halted';
            }
          }
          if (!p.quiet || res.fills.length) ctx.log({ op: `#${p.seq} ${p.owner} ${p.side} ${p.qty} ${p.px == null ? 'market' : px(p.px)} → ${out.status}`, status: out.halted ? 'warn' : 'ok', detail: res.fills.length ? `${res.fills.map((f) => `${f.qty} @ ${px(f.px)}`).join(', ')}${outside ? ` (${outside} outside the band)` : ''}.` : res.reason || 'Rests.' });
          publish(ctx.sim);
          return out;
        },
      },
      bands: { get: function* (ctx) { const r = ctx.must(yield ctx.call('refcache', 'get', {}, { timeout: 200, quiet: ctx.quiet })); return bandsFor(r.ref); } },
      refcache: {
        get(ctx) { return { ref: ctx.state.cachedRef }; },
        set(ctx, p) { if (ctx.mode('stale')) return { ignored: true }; ctx.state.cachedRef = p.ref; return { ok: true }; },
      },
      auction: { uncross(ctx) { uncross(ctx.sim, ctx); return { px: ctx.state.lastUncross.px, vol: ctx.state.lastUncross.vol }; } },
      mdpub: { publish(ctx, p) { Object.assign(ctx.ui.md, p); return { ok: true }; } },
    },
    setup(sim) {
      // The reference price cache refreshes from the tape every half second.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(500);
          const ref = trueRef(ctx.state, ctx.now());
          yield ctx.call('refcache', 'set', { ref }, { timeout: 200, quiet: 'all' });
        }
      }, { self: 'bands', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      if (st.stats.outsideBand) return { key: 'wrong', label: `${st.stats.outsideBand} print${st.stats.outsideBand === 1 ? '' : 's'} outside the ${BAND * 100}% band with no halt. The rule exists; the engine did not apply it.` };
      if (st.stats.wrongHalts) return { key: 'wrong', label: `ACME was halted on a stale reference price: the print was inside the real band. A halt that cost everyone ${HALT_MS / 1000 + AUCTION_MS / 1000} s for nothing.` };
      if (st.phase === 'halted') return { key: 'stale', label: `ACME is halted after a print would have left the band. Reopening ${st.config.reopenAuction ? 'through an auction' : 'directly'} in a moment.` };
      if (st.phase === 'auction') return { key: 'stale', label: `Auction in progress: ${st.auctionOrders.length} order${st.auctionOrders.length === 1 ? '' : 's'} collecting; nothing prints until the uncross.` };
      if (sim.nodes.bands.modes.down) return { key: 'stale', label: `The band calculator is down; the engine is using bands computed earlier (${px(st.lastBands.lo)}–${px(st.lastBands.hi)}). Safe for now, wrong if the price moves.` };
      if (st.stats.reopensWithoutAuction && st.stats.reopenGap) return { key: 'stale', label: `Reopened without an auction and the first print gapped ${st.stats.reopenGap}%: price discovery by sweeping, not by auction.` };
      const u = sim.ui.maya;
      if (u.orders.some((o) => o.status === 'sending')) return { key: 'stale', label: 'Maya’s order is in flight.' };
      return { key: 'ok', label: `Every print is inside the band${st.stats.halts ? `, ${st.stats.halts} halt${st.stats.halts === 1 ? '' : 's'} reopened through ${st.stats.auctions} auction${st.stats.auctions === 1 ? '' : 's'}` : ''}${st.stats.rejectedHalted ? `; ${st.stats.rejectedHalted} order${st.stats.rejectedHalted === 1 ? '' : 's'} rejected during the halt as designed` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const bands = st.lastBands;
      const last = st.prints.length ? st.prints[st.prints.length - 1].px : null;
      return [
        { label: 'Phase', value: st.phase, tone: st.phase === 'open' ? 'ok' : 'warn' },
        { label: 'Last print', value: last == null ? '–' : px(last) },
        { label: 'Band', value: `${px(bands.lo)}–${px(bands.hi)}`, tone: st.stats.wrongHalts ? 'fail' : '' },
        { label: 'Reference (true / cached)', value: `${px(trueRef(st, sim.now))} / ${px(st.cachedRef)}`, tone: Math.abs(trueRef(st, sim.now) - st.cachedRef) > 50 ? 'warn' : '' },
        { label: 'Halts', value: st.stats.halts },
        { label: 'Prints outside the band', value: st.stats.outsideBand, tone: st.stats.outsideBand ? 'fail' : '' },
        { label: 'Auction volume', value: st.stats.auctionVolume },
        { label: 'Orders queued during halts', value: st.stats.queuedHalted },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Maya buys from her phone. The console drives Quill’s dump and Nova’s rally and shows the tape against the bands.',
          side: `<p class="ops-title">Tape and bands</p><div data-ref="tape"></div><div class="ops-traffic">${Y.btn('dump', 'Quill: dump 2,000 in 10 orders')}${Y.btn('rally', 'Nova: buy 1,800 in 6 orders', { cls: 'secondary' })}${Y.btn('open', 'Open the market (uncross)', { cls: 'secondary' })}</div><div data-ref="members"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.maya;
        const md = sim.ui.md;
        const bands = st.lastBands;
        const card = (o) => `<div class="app-card ${o.status === 'filled' ? 'is-ok' : o.status === 'rejected' ? 'is-fail' : o.status === 'queued' ? 'is-hot' : ''}"><span class="app-kv"><strong>${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.qty} ${o.px == null ? 'market' : px(o.px)}</strong><span>${o.status === 'sending' ? '<span class="spinner"></span>' : esc(o.status)}</span></span><span class="app-sub">${esc(o.detail)}</span></div>`;
        Y.paint(el, sim, 'maya', {
          head: '<div><p class="app-title">Finch</p><p class="app-sub">Maya · ACME</p></div>',
          price: `<div class="app-card ${md.phase !== 'open' ? 'is-fail' : ''}"><span class="app-kv"><strong>ACME ${md.phase === 'open' ? '' : md.phase === 'halted' ? '⏸ halted' : '◷ auction'}</strong><span>${md.last == null ? 'no prints' : `last ${px(md.last)}`}</span></span><span class="app-sub">bid ${md.bid == null ? '–' : px(md.bid)} × ask ${md.ask == null ? '–' : px(md.ask)} · band ${px(bands.lo)}–${px(bands.hi)}</span></div>`,
          ticket: Y.btn('order', 'Buy 100 at market', { arg: { owner: 'maya', side: 'buy', qty: 100, px: null } }),
          orders: u.orders.length ? `<p class="app-sub">Orders</p>${u.orders.slice(-3).reverse().map(card).join('')}` : '<p class="app-sub">No orders yet.</p>',
        }, {});
        const prints = st.prints.slice(-30);
        const lo = Math.min(bands.lo, ...prints.map((p) => p.px)) - 20, hi = Math.max(bands.hi, ...prints.map((p) => p.px)) + 20;
        const y = (v) => Math.round(((hi - v) / (hi - lo)) * 100);
        const bars = prints.map((p) => `<span title="${px(p.px)}" style="flex:1;min-width:4px;height:${100 - y(p.px)}%;background:${p.phase === 'auction' ? '#7c3aed' : p.px < bands.lo || p.px > bands.hi ? '#dc2626' : 'currentColor'};opacity:.75;border-radius:2px 2px 0 0"></span>`).join('');
        const line = (v, label, above) => `<span style="position:absolute;left:0;right:0;top:${y(v)}%;border-top:1px dashed #d97706;font-size:10px;line-height:1;padding-left:2px;opacity:.9${above ? ';transform:translateY(-100%);border-top:0;border-bottom:1px dashed #d97706' : ''}">${label} ${px(v)}</span>`;
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="tape"]'), {
          chart: `<div style="position:relative;height:110px;margin:14px 0 10px;display:flex;align-items:flex-end;gap:2px;padding:0 0 2px;border-bottom:1px solid currentColor;opacity:.9">${bars || '<span class="app-sub">no prints yet</span>'}${line(bands.hi, 'limit up')}${line(bands.lo, 'limit down', true)}</div>`,
          status: `<p class="app-sub">Phase <strong>${esc(st.phase)}</strong> · reference true ${px(trueRef(st, sim.now))}, cached ${px(st.cachedRef)} · ${st.prints.length} prints · ${st.stats.halts} halt${st.stats.halts === 1 ? '' : 's'}${st.lastUncross ? ` · last uncross ${st.lastUncross.px == null ? 'none' : `${px(st.lastUncross.px)} × ${st.lastUncross.vol}`}` : ''}${st.auctionOrders.length ? ` · ${st.auctionOrders.length} in the auction book` : ''}</p>`,
        }, {});
        SDL.ui.paintSections(el.querySelector('[data-ref="members"]'), {
          q: `<p class="app-sub">Quill</p>${sim.ui.quill.orders.slice(-2).reverse().map(card).join('') || '<p class="app-sub">no orders</p>'}<p class="app-sub">Nova</p>${sim.ui.nova.orders.slice(-2).reverse().map(card).join('') || '<p class="app-sub">no orders</p>'}`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });

  function openMarket(sim) {
    const st = sim.state;
    if (st.phase !== 'auction') { sim.note('The market is already open.'); return; }
    sim.spawn(function* (ctx) {
      const r = yield ctx.call('auction', 'uncross', {}, { timeout: 800 });
      st.phase = 'open';
      if (!r.ok) ctx.log({ op: 'uncross failed', status: 'err', detail: r.error.message });
      publish(sim);
    }, { self: 'engine' });
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
