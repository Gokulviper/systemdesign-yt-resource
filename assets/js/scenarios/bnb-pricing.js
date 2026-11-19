/*
 * The price you saw is the price you pay.
 * Maya, paying in euros, books Lena's Lakeside cabin for three nights. The
 * pricing service builds a quote: nightly prices from the price database, a
 * cleaning fee, a service fee, occupancy tax from the tax service, and an
 * exchange rate from the FX service. The quote is stored with an expiry and
 * its id travels to "Confirm and pay". Whether confirm honours the quote or
 * re-prices from scratch, whether the rate is locked, how tax failures are
 * handled, whether a smart-pricing batch is checked before it is applied, and
 * how euro amounts are rounded decide whether Maya is charged what Maya saw.
 * All money is integer cents.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const NIGHTS = ['Dec 30', 'Dec 31', 'Jan 1'];
  const BASE = 399;
  const CLEAN = 15000;
  const FEE = 0.14;
  const TAX = 0.1;
  const RATE = 0.91367;
  const QUOTE_TTL = 3000; // stands in for 30 minutes
  const FX_MAX_AGE = 1000; // a rate older than this is not used
  const FLOOR = 50;

  const fmt = (cents, cur) => (cur === 'EUR' ? '€' : '$') + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd = (n) => '$' + Number(n).toLocaleString('en-US');
  const sum = (a) => a.reduce((x, y) => x + y, 0);

  /** Price a stay. nightly: dollars per night; rate: USD→EUR or null for USD; tax: rate or null when unknown. */
  function price(nightly, cur, rate, tax, roundLines) {
    const n = nightly.map((p) => p * 100);
    const base = sum(n) + CLEAN;
    const fee = Math.round(base * FEE);
    const taxC = tax == null ? 0 : Math.round(base * tax);
    const usdLines = { nights: sum(n), clean: CLEAN, fee, tax: taxC };
    const usdTotal = sum(Object.values(usdLines));
    if (cur === 'USD') return { cur, rate: null, perNight: n, lines: usdLines, usdLines, total: usdTotal, usdTotal, linesSum: usdTotal };
    const perNight = n.map((x) => Math.round(x * rate));
    const lines = { nights: sum(perNight), clean: Math.round(CLEAN * rate), fee: Math.round(fee * rate), tax: Math.round(taxC * rate) };
    const linesSum = sum(Object.values(lines));
    return { cur, rate, perNight, lines, usdLines, usdTotal, linesSum, total: roundLines ? linesSum : Math.round(usdTotal * rate) };
  }

  /* ---------------- flows ---------------- */
  function listing(sim) {
    sim.spawn(function* (ctx) {
      const r = yield ctx.call('api', 'listing', {}, { timeout: 800, quiet: 'all' });
      if (r.ok) ctx.ui.maya.search = r.value.from;
    }, { self: 'maya', quiet: 'all' });
  }

  function quote(sim, why) {
    const u = sim.ui.maya;
    if (u.busy) return;
    u.busy = true;
    const cur = u.cur;
    sim.startAction(`Maya: see the price in ${cur === 'EUR' ? 'euros' : 'dollars'}${why ? ` (${why})` : ''}`, function* (ctx) {
      Object.assign(u, { stage: 'quoting', message: why ? u.message : '', tone: why ? u.tone : '' });
      Y.L(ctx, { displayed: 'pending', committed: ['n/a', 'A quote charges nothing.'], async: 'n/a', retrySafe: 'yes' });
      const seen = u.search;
      const r = yield ctx.call('api', 'quote', { cur }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.busy = false;
      if (!r.ok) {
        const msg = { FX_STALE: 'We can’t show prices in euros right now. Try dollars, or try again shortly.', FX_DOWN: 'We can’t show prices in euros right now.', TAX_DOWN: 'We can’t price this stay right now. Try again in a few minutes.' }[r.error.code] || `Couldn’t get a price: ${r.error.message}`;
        Object.assign(u, { stage: 'browse', message: msg, tone: 'fail', quote: null });
        ctx.state.refused.push(r.error.code);
        Y.failed(ctx, 'No price shown.');
        ctx.explain(r.error.code === 'FX_STALE'
          ? `The newest euro rate is ${(r.error.detail.age / 1000).toFixed(1)} s old (the limit is ${FX_MAX_AGE / 1000} s; minutes in production). Quoting with it could charge the wrong amount, so euro quotes are refused until the feed recovers. Dollar quotes still work.`
          : r.error.code === 'TAX_DOWN'
            ? 'The tax service did not answer, and tax fails closed: no quote without the tax line. Nobody can book this listing until it recovers, but nobody is undercharged either.'
            : `The quote failed with ${r.error.code}.`);
        return;
      }
      const q = r.value;
      const flagged = seen != null && q.nightly[0] !== seen;
      Object.assign(u, { stage: 'quoted', quote: q, flagged: flagged ? { seen, now: q.nightly[0] } : u.flagged });
      if (!why) Object.assign(u, { message: flagged ? `The price went up since you searched: ${usd(seen)} → ${usd(q.nightly[0])} a night.` : '', tone: flagged ? 'warn' : '' });
      Y.L(ctx, { displayed: ['yes', `${fmt(q.total, q.cur)}, quote ${q.id}.`], accepted: 'yes' });
      ctx.explain(`Quote ${q.id}: ${NIGHTS.length} nights at ${usd(q.nightly[0])}, cleaning, a ${FEE * 100}% service fee, and ${q.taxMissing ? 'no tax (the tax service was down and tax fails open)' : `${TAX * 100}% occupancy tax`}${q.cur === 'EUR' ? `, converted at ${q.rate}` : ''}. It is stored for ${QUOTE_TTL / 1000} s (30 minutes in production) and its id goes with “Confirm and pay”.${flagged ? ` Search still showed ${usd(seen)}: the search index has not received Lena’s new price. The quote reads the price database, so Maya is told before paying.` : ''}`);
    }, { self: 'maya' });
  }

  function pay(sim) {
    const u = sim.ui.maya;
    if (u.busy || !u.quote) return;
    u.busy = true;
    const q = u.quote;
    sim.startAction(`Maya: confirm and pay ${fmt(q.total, q.cur)}`, function* (ctx) {
      const st = ctx.state;
      Object.assign(u, { stage: 'paying' });
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', `The quote id ${q.id} identifies this payment.`] });
      const r = yield ctx.call('api', 'confirm', { quoteId: q.id, shown: q.total, cur: q.cur, linesShown: q.linesSum }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.busy = false;
      if (!r.ok && r.error.code === 'QUOTE_EXPIRED') {
        Object.assign(u, { stage: 'browse', message: 'Your quote expired, so here is the current price. Nothing was charged.', tone: 'warn', quote: null });
        Y.failed(ctx, 'Quote expired; nothing charged.');
        ctx.explain(`Quote ${q.id} expired ${r.error.detail.ago != null ? `${(r.error.detail.ago / 1000).toFixed(1)} s ago` : '(it is gone from the quote store)'}. The pricing service will not charge an expired quote, so the phone asks for a new one and shows it before Maya pays.`);
        st.requotes++;
        quote(ctx.sim, 'quote expired');
        return;
      }
      if (!r.ok) { Object.assign(u, { stage: 'quoted', message: `Payment failed: ${r.error.message}`, tone: 'fail' }); Y.failed(ctx, r.error.message); return; }
      const c = r.value;
      Object.assign(u, { stage: 'paid', charged: c, message: c.charged !== q.total ? `Your card was charged ${fmt(c.charged, c.cur)}.` : '', tone: c.charged !== q.total ? 'fail' : '' });
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Charged ${fmt(c.charged, c.cur)}.`], async: 'n/a' });
      let why;
      if (c.charged !== q.total) {
        why = c.how === 'reprice'
          ? `Confirm re-priced the stay from scratch. Lena had raised the price to ${usd(c.nightly[0])} after the quote, so Maya paid ${fmt(c.charged - q.total, c.cur)} more than the total on screen.`
          : `The quote kept the dollar amounts but not the rate. Confirm converted ${fmt(c.usdTotal, 'USD')} at today’s ${c.rate} instead of the quoted ${q.rate}: ${fmt(Math.abs(c.charged - q.total), c.cur)} ${c.charged > q.total ? 'more' : 'less'} than shown.`;
      } else if (c.linesSum !== c.charged) {
        why = `The charge matches the total, but the breakdown does not: each line was converted and rounded on its own (${fmt(c.linesSum, c.cur)}), while the total was converted once (${fmt(c.charged, c.cur)}). Off by ${fmt(Math.abs(c.charged - c.linesSum), c.cur)}, enough for a support ticket and a failed audit.`;
      } else if (c.taxMissing) {
        why = `Maya paid exactly what was shown, but no tax was collected: the tax service was down and tax fails open. The platform still owes ${fmt(c.taxOwed, 'USD')} to the county.`;
      } else {
        why = `Charged the quoted ${fmt(c.charged, c.cur)}.${c.absorbed ? ` The rate moved since the quote; it was locked in ${q.id}, so the platform absorbs ${fmt(Math.abs(c.absorbed), 'EUR')}.` : ''}${c.priceMoved ? ` Lena’s new price (${usd(c.priceMoved)}) applies to new quotes; this one was honoured.` : ''}`;
      }
      ctx.explain(why);
    }, { self: 'maya' });
  }

  function setPrice(sim, p) {
    sim.startAction(`Lena: set the nightly price to ${usd(p)}`, function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call('pricedb', 'set', { nightly: NIGHTS.map(() => p), by: 'Lena' }, { timeout: 1000 });
      if (r.ok) { sim.ui.lena.message = `Nightly price is ${usd(p)}.`; Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'yes', async: ['pending', 'Search shows it after the next index sync.'] }); }
      else Y.failed(ctx, r.error.message);
    }, { self: 'lena' });
  }

  function batch(sim, bad) {
    sim.startAction(bad ? 'Smart pricing: nightly batch (bad: dollars read as cents)' : 'Smart pricing: nightly batch (New Year +15%)', function* (ctx) {
      const st = ctx.state;
      const cur = st.prices.nightly;
      const proposed = bad ? cur.map(() => 1) : cur.map((p, i) => (i === 1 ? Math.round(p * 1.15) : p));
      Y.L(ctx, { displayed: ['n/a', 'A background job.'], retrySafe: 'yes' });
      const r = yield ctx.call('pricedb', 'set', { nightly: proposed, by: 'smart pricing', batch: true }, { timeout: 1000 });
      if (r.ok) {
        sim.ui.lena.message = `Smart pricing set ${NIGHTS.map((d, i) => `${d} ${usd(proposed[i])}`).join(', ')}.`;
        Y.L(ctx, { accepted: 'yes', committed: 'yes' });
        ctx.explain(bad ? 'The batch wrote $1 for every night. Nothing checked it: the cabin is bookable for New Year at $1 a night until someone notices.' : 'A routine batch: New Year’s Eve goes up 15%. It passed the guardrails.');
      } else {
        st.rejected.push(r.error.message);
        sim.ui.lena.message = `Smart pricing batch rejected: ${r.error.message}`;
        Y.failed(ctx, 'Batch rejected.');
        ctx.explain(`The guardrail compared the batch with the current prices and refused it: ${r.error.message} Prices stay as they were and someone is paged.`);
      }
    }, { self: 'batch' });
  }

  function fxMove(sim) {
    sim.state.fx.rate = 0.95;
    sim.note('The euro falls about 4%: $1 now costs €0.95 instead of €0.91367.');
  }

  SDL.scenarios['bnb-pricing'] = {
    id: 'bnb-pricing',
    seed: 4513,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Tap “See price” on Maya’s phone, then “Confirm and pay”: the charge is the quoted total. Then raise the price from Lena’s console between the two, move the euro, take the tax service down, or run a bad smart-pricing batch.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'Berlin · pays in euros', kind: 'client', x: 90, y: 110, latency: 1, role: 'Sees a search price, asks for a quote, then confirms and pays the quoted total.', owns: ['What Maya sees'] },
        { id: 'lena', label: 'Lena’s console', sub: 'Lakeside cabin', kind: 'client', x: 90, y: 480, latency: 1, role: 'Sets the nightly price.', owns: ['What Lena sees'] },
        { id: 'api', label: 'API gateway', sub: 'Routing', kind: 'gateway', x: 280, y: 110, latency: 2, role: 'Routes searches to the index and quotes and payments to pricing.', ops: [{ name: 'listing', desc: 'Search card.' }, { name: 'quote', desc: 'Price a stay.' }, { name: 'confirm', desc: 'Pay a quote.' }], owns: ['Nothing durable'] },
        { id: 'pricing', label: 'Pricing service', sub: 'Quotes and charges', kind: 'service', x: 500, y: 260, latency: 3, role: 'Builds quotes from prices, fees, tax, and FX, stores them with an expiry, and charges a quote on confirm.', ops: [{ name: 'quote', desc: 'Build and store a quote.' }, { name: 'confirm', desc: 'Charge a quote.' }], owns: ['Fee rules', 'Rounding rule'] },
        { id: 'fx', label: 'FX rates', sub: 'Feed every 0.25 s', kind: 'service', x: 760, y: 60, latency: 4, role: 'The latest USD → EUR rate and how old it is.', ops: [{ name: 'rate', desc: 'Latest rate.' }], owns: ['Exchange rates'] },
        { id: 'tax', label: 'Tax rules', sub: 'Occupancy tax', kind: 'service', x: 760, y: 200, latency: 6, role: 'The occupancy tax for the listing’s address and dates.', ops: [{ name: 'rate', desc: 'Tax rate.' }], owns: ['Tax tables'] },
        { id: 'quotes', label: 'Quote store', sub: `Expires after ${QUOTE_TTL / 1000} s`, kind: 'cache', x: 760, y: 340, latency: 2, role: 'Quotes by id: nightly prices, fees, tax, rate, and total. Expired quotes are not charged.', ops: [{ name: 'put', desc: 'Store a quote.' }, { name: 'get', desc: 'Read a quote.' }], owns: ['quotes'] },
        { id: 'pricedb', label: 'Price database', sub: 'Nightly prices', kind: 'db', x: 500, y: 480, latency: 5, role: 'The price of each night. Batches can be checked by guardrails before they are written.', ops: [{ name: 'get', desc: 'Nightly prices.' }, { name: 'set', desc: 'Change prices.' }], owns: ['nightly prices'] },
        { id: 'index', label: 'Search index', sub: '“From” price', kind: 'store', x: 280, y: 300, latency: 4, role: 'The price shown on the search card. Synced from the price database every 0.5 s.', ops: [{ name: 'get', desc: 'Search card price.' }], owns: ['search card prices'] },
        { id: 'batch', label: 'Smart pricing', sub: 'Nightly batch', kind: 'worker', x: 980, y: 480, latency: 3, role: 'Proposes new nightly prices from demand.', owns: ['Nothing durable'] },
      ],
      edges: [
        { from: 'maya', to: 'api', latency: 40, label: 'mobile network' },
        { from: 'lena', to: 'pricedb', latency: 40 },
        { from: 'api', to: 'index', latency: 3 },
        { from: 'api', to: 'pricing', latency: 3 },
        { from: 'pricing', to: 'fx', latency: 3 },
        { from: 'pricing', to: 'tax', latency: 3 },
        { from: 'pricing', to: 'quotes', latency: 2 },
        { from: 'pricing', to: 'pricedb', latency: 3 },
        { from: 'pricedb', to: 'index', latency: 3, label: 'sync' },
        { from: 'batch', to: 'pricedb', latency: 3 },
      ],
      queues: [],
    },
    modeLabels: { stale: 'Feed stopped', evict: 'Evicting quotes', lag: 'Sync paused' },
    failures: [
      { id: 'fx-stale', node: 'fx', mode: 'stale', label: 'FX feed stale', desc: 'The rate stops updating. After a while euro quotes are refused.' },
      { id: 'fx-down', node: 'fx', mode: 'down', label: 'FX service down', desc: 'No rate at all: euro quotes fail.' },
      { id: 'tax-down', node: 'tax', mode: 'down', label: 'Tax service down', desc: 'Quotes fail closed, or go out without tax if tax fails open.' },
      { id: 'evict', node: 'quotes', mode: 'evict', label: 'Quote store evicting', desc: 'Memory pressure: stored quotes disappear before they expire.' },
      { id: 'index-lag', node: 'index', mode: 'lag', label: 'Index price sync paused', desc: 'Search cards keep the old price.' },
      { id: 'pricedb-slow', node: 'pricedb', mode: 'slow', params: { factor: 30 }, label: 'Price database slow', desc: 'Quotes and re-pricing wait on every read.' },
    ],
    switches: Y.switches([
      ['quote', 'Charge the stored quote', 'Confirm charges the quote by id, if it has not expired. Off: confirm re-prices the stay from scratch.'],
      ['fxLock', 'Lock the rate in the quote', 'The euro total is fixed when quoted; the platform absorbs rate moves. Off: confirm converts the dollar total at today’s rate.'],
      ['guard', 'Guardrails on price batches', `Refuse a batch that sets a night below ${usd(FLOOR)} or moves it more than 50%. Off: write whatever the batch says.`],
      ['taxClosed', 'Tax fails closed', 'No quote without the tax line. Off: quote and charge without tax when the tax service is down.'],
      ['roundLines', 'Charge the sum of the rounded lines', 'Convert and round each line, and charge their sum, so the breakdown always adds up. Off: convert the total once.'],
    ]),
    presets: Y.presets({ quote: true, fxLock: true, guard: true, taxClosed: true, roundLines: true }, [
      { id: 'pay', label: 'Quote in euros and pay', desc: 'Three nights at $399, cleaning, service fee, and tax, in euros. Maya pays exactly the quoted total, and the breakdown adds up to it.', run: (s) => { quote(s); s.schedule(1200, () => pay(s)); } },
      { id: 'raise-quote', label: 'Lena raises the price, stored quote', desc: 'Lena sets $449 while Maya is on the checkout screen. Confirm charges the stored quote: $399 a night, as shown.', run: (s) => { quote(s); s.schedule(400, () => setPrice(s, 449)); s.schedule(1200, () => pay(s)); } },
      { id: 'raise-reprice', label: 'Lena raises the price, re-price at confirm', desc: 'Same change. Confirm prices the stay again and charges $449 a night: more than the total Maya agreed to.', sw: { quote: false }, run: (s) => { quote(s); s.schedule(400, () => setPrice(s, 449)); s.schedule(1200, () => pay(s)); } },
      { id: 'expired', label: 'Quote expires', desc: 'Maya waits past the quote’s expiry, then taps pay. Nothing is charged; the phone shows a fresh quote, and Maya pays that.', run: (s) => { quote(s); s.schedule(4000, () => pay(s)); s.schedule(5200, () => pay(s)); } },
      { id: 'fx-unlocked', label: 'Euro moves, rate not locked', desc: 'The euro falls 4% between quote and pay. Confirm converts at the new rate: Maya pays about €60 more than shown.', sw: { fxLock: false }, run: (s) => { quote(s); s.schedule(400, () => fxMove(s)); s.schedule(1200, () => pay(s)); } },
      { id: 'fx-locked', label: 'Euro moves, rate locked', desc: 'Same move. The quote carried its rate, so Maya pays the quoted euros and the platform absorbs the difference.', run: (s) => { quote(s); s.schedule(400, () => fxMove(s)); s.schedule(1200, () => pay(s)); } },
      { id: 'fx-stale', label: 'FX feed stale', desc: 'The rate feed stops. Once the rate is too old, euro quotes are refused. Correct, but Maya can only see dollars.', run: (s) => { s.inject('fx', 'stale'); s.schedule(1500, () => quote(s)); } },
      { id: 'tax-closed', label: 'Tax service down, fail closed', desc: 'No tax rate, no quote. Nobody can book the cabin until the tax service is back.', run: (s) => { s.inject('tax', 'down'); quote(s); } },
      { id: 'tax-open', label: 'Tax service down, fail open', desc: 'The quote goes out without tax and Maya pays it. The county is still owed its tax.', sw: { taxClosed: false }, run: (s) => { s.inject('tax', 'down'); quote(s); s.schedule(1200, () => pay(s)); } },
      { id: 'batch-bad', label: '$1 batch, no guardrail', desc: 'A smart-pricing bug reads dollars as cents and writes $1 for every New Year night. Maya’s quote says $1 a night.', sw: { guard: false }, run: (s) => { batch(s, true); s.schedule(800, () => quote(s)); } },
      { id: 'batch-guard', label: '$1 batch, guardrail', desc: 'Same batch. The guardrail sees a 99% drop below the floor and refuses it. Maya’s quote is $399 a night.', run: (s) => { batch(s, true); s.schedule(800, () => quote(s)); } },
      { id: 'index-lag', label: 'Search shows the old price', desc: 'Lena raises the price while the index sync is paused. Search still says $399; the quote says $449 and tells Maya before payment.', run: (s) => { s.inject('index', 'lag'); setPrice(s, 449); s.schedule(400, () => listing(s)); s.schedule(800, () => quote(s)); } },
      { id: 'rounding', label: 'Convert the total once', desc: 'Each line is converted and rounded for the breakdown, but the charge converts the dollar total once. They differ by a cent.', sw: { roundLines: false }, run: (s) => { quote(s); s.schedule(1200, () => pay(s)); } },
    ]),
    initialState: () => ({
      config: { quote: true, fxLock: true, guard: true, taxClosed: true, roundLines: true },
      prices: { nightly: NIGHTS.map(() => BASE), ver: 1 },
      index: { from: BASE, ver: 1 },
      fx: { rate: RATE, at: 0 },
      quotes: {}, charges: [], refused: [], rejected: [], requotes: 0,
      seq: { q: 0 },
    }),
    initialUI: () => ({
      maya: { cur: 'EUR', stage: 'browse', search: BASE, quote: null, charged: null, flagged: null, busy: false, message: '', tone: '' },
      lena: { message: '' },
    }),
    actions: {
      quote(sim) { quote(sim); },
      pay(sim) { pay(sim); },
      price(sim, a) { setPrice(sim, a.p); },
      batch(sim, a) { batch(sim, !!a.bad); },
      fx(sim) { fxMove(sim); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        listing: function* (ctx) { return ctx.must(yield ctx.call('index', 'get', {}, { timeout: 600, quiet: 'all' })); },
        quote: function* (ctx, p) { return ctx.must(yield ctx.call('pricing', 'quote', p, { timeout: 1400 })); },
        confirm: function* (ctx, p) { return ctx.must(yield ctx.call('pricing', 'confirm', p, { timeout: 1400 })); },
      },
      pricing: {
        quote: function* (ctx, p) {
          const st = ctx.state;
          const cfg = st.config;
          const pr = ctx.must(yield ctx.call('pricedb', 'get', {}, { timeout: 1000 }));
          let rate = null;
          if (p.cur === 'EUR') {
            const fx = yield ctx.call('fx', 'rate', {}, { timeout: 300 });
            if (!fx.ok) ctx.fail('FX_DOWN', 'No exchange rate.');
            if (fx.value.age > FX_MAX_AGE) {
              ctx.log({ op: `euro rate is ${(fx.value.age / 1000).toFixed(1)} s old: refused`, status: 'err', detail: `Rates older than ${FX_MAX_AGE / 1000} s are not used for quotes.` });
              ctx.fail('FX_STALE', 'The exchange rate is out of date.', { age: fx.value.age });
            }
            rate = fx.value.rate;
          }
          const tx = yield ctx.call('tax', 'rate', {}, { timeout: 300 });
          let tax = TAX;
          let taxMissing = false;
          if (!tx.ok) {
            if (cfg.taxClosed) ctx.fail('TAX_DOWN', 'Tax rules unavailable.');
            tax = null;
            taxMissing = true;
            ctx.log({ op: 'tax unavailable: quoting without it', status: 'err', detail: 'Tax fails open: the quote has no tax line.' });
          }
          const pz = price(pr.nightly, p.cur, rate, tax, cfg.roundLines);
          const q = Object.assign({ id: `Q${++st.seq.q}`, nightly: pr.nightly.slice(), taxRate: tax, taxMissing, exp: ctx.now() + QUOTE_TTL }, pz);
          ctx.must(yield ctx.call('quotes', 'put', q, { timeout: 300 }));
          return q;
        },
        confirm: function* (ctx, p) {
          const st = ctx.state;
          const cfg = st.config;
          let q = null;
          if (cfg.quote) {
            const g = ctx.must(yield ctx.call('quotes', 'get', { id: p.quoteId }, { timeout: 300 }));
            if (!g.quote) ctx.fail('QUOTE_EXPIRED', 'The quote expired.', { ago: g.ago });
            q = g.quote;
          }
          let charge;
          let how;
          let absorbed = 0;
          if (q) {
            how = 'quote';
            if (q.cur === 'EUR' && !cfg.fxLock) {
              const fx = ctx.must(yield ctx.call('fx', 'rate', {}, { timeout: 300 }));
              charge = price(q.nightly, 'EUR', fx.rate, q.taxRate, cfg.roundLines);
            } else {
              charge = q;
              if (q.cur === 'EUR' && st.fx.rate !== q.rate) absorbed = price(q.nightly, 'EUR', st.fx.rate, q.taxRate, cfg.roundLines).total - q.total;
            }
          } else {
            how = 'reprice';
            const pr = ctx.must(yield ctx.call('pricedb', 'get', {}, { timeout: 1000 }));
            let rate = null;
            if (p.cur === 'EUR') rate = ctx.must(yield ctx.call('fx', 'rate', {}, { timeout: 300 })).rate;
            const tx = yield ctx.call('tax', 'rate', {}, { timeout: 300 });
            charge = Object.assign({ nightly: pr.nightly.slice(), taxMissing: !tx.ok }, price(pr.nightly, p.cur, rate, tx.ok ? TAX : null, cfg.roundLines));
          }
          const nightly = charge.nightly || q.nightly;
          const taxMissing = q ? q.taxMissing : charge.taxMissing;
          const rec = {
            quoteId: p.quoteId, how, cur: p.cur, shown: p.shown, linesShown: p.linesShown,
            charged: charge.total, linesSum: charge.linesSum,
            usdTotal: charge.usdTotal, rate: charge.rate, nightly, taxMissing,
            taxOwed: taxMissing ? Math.round((sum(nightly.map((x) => x * 100)) + CLEAN) * TAX) : 0,
            absorbed, priceMoved: q && st.prices.nightly[0] !== q.nightly[0] ? st.prices.nightly[0] : 0,
          };
          st.charges.push(rec);
          ctx.log({ op: `charged ${fmt(rec.charged, rec.cur)}`, status: rec.charged === rec.shown ? 'ok' : 'err', detail: `Shown ${fmt(rec.shown, rec.cur)}; ${how === 'quote' ? `charged from quote ${p.quoteId}` : 're-priced at confirm'}.` });
          return rec;
        },
      },
      fx: { rate(ctx) { return { rate: ctx.state.fx.rate, age: ctx.now() - ctx.state.fx.at }; } },
      tax: { rate() { return { rate: TAX }; } },
      quotes: {
        put(ctx, q) { ctx.state.quotes[q.id] = SDL.clone(q); return { ok: true }; },
        get(ctx, p) {
          const q = ctx.state.quotes[p.id];
          if (!q || ctx.mode('evict')) return { quote: null, ago: null };
          if (q.exp <= ctx.now()) return { quote: null, ago: ctx.now() - q.exp };
          return { quote: q };
        },
      },
      pricedb: {
        get(ctx) { return { nightly: ctx.state.prices.nightly.slice(), ver: ctx.state.prices.ver }; },
        set(ctx, p) {
          const st = ctx.state;
          if (p.batch && st.config.guard) {
            const bad = p.nightly.map((n, i) => ({ n, was: st.prices.nightly[i], d: NIGHTS[i] })).filter((x) => x.n < FLOOR || Math.abs(x.n - x.was) / x.was > 0.5);
            if (bad.length) {
              ctx.log({ op: `batch refused: ${bad.length} night${bad.length > 1 ? 's' : ''} out of bounds`, status: 'err', detail: bad.map((x) => `${x.d} ${usd(x.was)} → ${usd(x.n)}`).join(', ') });
              ctx.fail('GUARDRAIL', `${bad.length} night${bad.length > 1 ? 's' : ''} would drop ${Math.floor((1 - bad[0].n / bad[0].was) * 100)}%, to ${usd(bad[0].n)}, below the ${usd(FLOOR)} floor.`);
            }
          }
          st.prices.nightly = p.nightly.slice();
          st.prices.ver++;
          return { ver: st.prices.ver };
        },
      },
      index: { get(ctx) { return { from: ctx.state.index.from }; } },
    },
    setup(sim) {
      // FX feed: a fresh rate every 0.25 s unless the feed has stopped.
      sim.spawn(function* (ctx) {
        for (;;) { if (!ctx.mode('stale') && !ctx.mode('down')) ctx.state.fx.at = ctx.now(); yield ctx.wait(250); }
      }, { self: 'fx', quiet: 'all' });
      // Index sync: copy the lowest nightly price to the search card every 0.5 s.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(500);
          const st = ctx.state;
          if (ctx.sim.nodes.index.modes.lag || st.index.ver === st.prices.ver) continue;
          st.index = { from: Math.min(...st.prices.nightly), ver: st.prices.ver };
        }
      }, { self: 'pricedb', quiet: 'all' });
      // Maya's search card refreshes every second.
      sim.spawn(function* (ctx) { for (;;) { yield ctx.wait(1000); listing(ctx.sim); } }, { self: 'api', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.maya;
      const low = st.prices.nightly.findIndex((n) => n < FLOOR);
      if (low >= 0) return { key: 'wrong', label: `${NIGHTS[low]} is bookable at ${usd(st.prices.nightly[low])} a night: the smart-pricing batch was written without a check. Every guest who books now gets New Year for almost nothing.` };
      for (const c of st.charges) {
        if (c.charged !== c.shown) return { key: 'wrong', label: `Maya was shown ${fmt(c.shown, c.cur)} and charged ${fmt(c.charged, c.cur)}: ${c.how === 'reprice' ? 'confirm re-priced the stay after Lena raised the price' : 'confirm converted at a rate that had moved since the quote'}.` };
        if (c.taxMissing) return { key: 'wrong', label: `Maya paid ${fmt(c.charged, c.cur)} with no tax in it: the tax service was down and tax fails open. ${fmt(c.taxOwed, 'USD')} of occupancy tax is owed and was never collected.` };
        if (c.linesSum !== c.charged) return { key: 'wrong', label: `The breakdown adds up to ${fmt(c.linesSum, c.cur)}, the charge is ${fmt(c.charged, c.cur)}: lines were rounded one by one, the total once. The receipt does not add up.` };
      }
      if (st.refused.length && !st.charges.length) {
        const code = st.refused[st.refused.length - 1];
        return { key: 'stale', label: code === 'TAX_DOWN' ? 'Nobody can get a price for the cabin: tax fails closed while the tax service is down. No one is undercharged; bookings wait.' : 'Euro quotes are refused while the exchange rate is out of date. Dollar quotes still work; nobody is charged at a wrong rate.' };
      }
      if (st.index.from !== Math.min(...st.prices.nightly)) return { key: 'stale', label: `Search shows ${usd(st.index.from)} a night; the price is ${usd(Math.min(...st.prices.nightly))}. The quote reads the price database and told Maya before payment${u.flagged ? '' : ' (once Maya asks for one)'}.` };
      const c = st.charges[st.charges.length - 1];
      if (!c) return { key: 'ok', label: st.rejected.length ? `The smart-pricing batch was refused: ${st.rejected[0]} Prices are unchanged at ${usd(st.prices.nightly[0])}.` : u.quote ? `Quote ${u.quote.id} shows ${fmt(u.quote.total, u.quote.cur)}; its lines add up to it.` : 'Tap “See price” on Maya’s phone to start.' };
      return { key: 'ok', label: `Maya was charged ${fmt(c.charged, c.cur)}, exactly the quoted total, and the breakdown adds up to it.${c.absorbed ? ` The platform absorbed ${fmt(Math.abs(c.absorbed), 'EUR')} of rate movement.` : ''}${c.priceMoved ? ` Lena’s new ${usd(c.priceMoved)} applies to new quotes.` : ''}${st.requotes ? ' The first quote expired and was replaced before payment.' : ''}` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const c = st.charges[st.charges.length - 1];
      const diff = c ? c.charged - c.shown : 0;
      return [
        { label: 'Shown', value: c ? fmt(c.shown, c.cur) : sim.ui.maya.quote ? fmt(sim.ui.maya.quote.total, sim.ui.maya.quote.cur) : '–' },
        { label: 'Charged', value: c ? fmt(c.charged, c.cur) : '–' },
        { label: 'Difference', value: c ? fmt(Math.abs(diff), c.cur) : '–', tone: diff ? 'fail' : c ? 'ok' : '' },
        { label: 'Breakdown minus charge', value: c ? fmt(Math.abs(c.linesSum - c.charged), c.cur) : '–', tone: c && c.linesSum !== c.charged ? 'fail' : '' },
        { label: 'Quotes expired', value: st.requotes },
        { label: 'Quotes refused', value: st.refused.length, tone: st.refused.length ? 'warn' : '' },
        { label: 'Batches rejected', value: st.rejected.length },
        { label: 'Euro rate age', value: `${((sim.now - st.fx.at) / 1000).toFixed(1)} s`, tone: sim.now - st.fx.at > FX_MAX_AGE ? 'warn' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Maya checks out in euros. Lena’s console changes the nightly price and runs smart pricing; the markets row moves the exchange rate.',
          side: `<p class="ops-title">Lena’s console · Lakeside cabin</p><div class="ops-traffic">
              ${Y.btn('price', 'Set $449 a night', { arg: { p: 449 } })}
              ${Y.btn('price', 'Back to $399', { arg: { p: 399 }, cls: 'secondary' })}
              ${Y.btn('batch', 'Smart pricing: New Year +15%', { cls: 'secondary' })}
              ${Y.btn('batch', 'Smart pricing: bad batch ($1)', { arg: { bad: true }, cls: 'secondary' })}
              ${Y.btn('fx', 'Markets: euro falls 4%', { cls: 'secondary' })}
            </div><div data-ref="prices"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.maya;
        const q = u.quote;
        const curSel = `<div class="app-row"><label for="bnb-cur">Currency</label><select id="bnb-cur" data-field="maya.cur"${u.busy ? ' disabled' : ''}>${['EUR', 'USD'].map((c) => `<option value="${c}"${c === u.cur ? ' selected' : ''}>${c === 'EUR' ? 'Euro (€)' : 'US dollar ($)'}</option>`).join('')}</select></div>`;
        const card = `<div class="ops-row"><div class="ops-name">Lakeside cabin · Tahoe City<span>Search: ${usd(u.search)} a night</span></div></div>`;
        let body = '';
        if (q) {
          const per = q.perNight.every((x) => x === q.perNight[0]) ? `${fmt(q.perNight[0], q.cur)} × ${NIGHTS.length} nights` : `${NIGHTS.length} nights`;
          const row = (a, b) => `<div class="ops-row"><div class="ops-name">${a}<span>${b}</span></div></div>`;
          body = `<div class="ops-shards">${row(per, fmt(q.lines.nights, q.cur))}${row('Cleaning fee', fmt(q.lines.clean, q.cur))}${row('Service fee', fmt(q.lines.fee, q.cur))}${row(q.taxMissing ? 'Taxes' : 'Occupancy tax', q.taxMissing ? 'not included' : fmt(q.lines.tax, q.cur))}</div>
            <p class="app-price">Total ${fmt(q.total, q.cur)}</p><p class="app-sub">Quote ${esc(q.id)}${q.rate ? ` · rate ${q.rate}` : ''} · ${q.exp > sim.now ? `expires in ${((q.exp - sim.now) / 1000).toFixed(1)} s` : 'expired'}</p>`;
        }
        let stage = Y.btn('quote', u.stage === 'quoting' ? 'Getting price…' : 'See price', { cls: q ? 'secondary' : 'go', disabled: u.busy });
        if (q && u.stage === 'quoted') stage = `${Y.btn('pay', 'Confirm and pay', { cls: 'go', disabled: u.busy })}${Y.btn('quote', 'Refresh price', { cls: 'secondary', disabled: u.busy })}`;
        if (u.stage === 'paying') stage = '<div class="app-card is-work"><strong><span class="spinner"></span>Paying…</strong></div>';
        if (u.stage === 'paid') stage = `<div class="app-card is-${u.charged.charged === u.charged.shown ? 'ok' : 'fail'}"><strong>${u.charged.charged === u.charged.shown ? '✓' : '✕'} Charged ${fmt(u.charged.charged, u.charged.cur)}</strong><span class="app-sub">Lakeside cabin · Dec 30 – Jan 2</span></div>`;
        Y.paint(el, sim, 'maya', {
          head: '<div><p class="app-title">Checkout</p><p class="app-sub">Dec 30 – Jan 2 · 3 nights</p></div>',
          cur: curSel, card, body, stage, msg: Y.msg(u.message, u.tone),
        }, {});
        const c = sim.scenario.consistency(sim);
        const low = st.prices.nightly.some((n) => n < FLOOR);
        SDL.ui.paintSections(el.querySelector('[data-ref="prices"]'), {
          rows: `<div class="ops-shards">
            <div class="ops-row" data-tone="${low ? 'fail' : ''}"><div class="ops-name">Price database · v${st.prices.ver}<span>${NIGHTS.map((d, i) => `${d} ${usd(st.prices.nightly[i])}`).join(', ')}</span></div></div>
            <div class="ops-row" data-tone="${st.index.from !== Math.min(...st.prices.nightly) ? 'warn' : ''}"><div class="ops-name">Search card<span>from ${usd(st.index.from)} a night${sim.nodes.index.modes.lag ? ' · sync paused' : ''}</span></div></div>
            <div class="ops-row"><div class="ops-name">Euro rate<span>${st.fx.rate} · <span data-live="age"></span> old</span></div></div>
          </div>${Y.msg(sim.ui.lena.message, '')}`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, { age: `${((sim.now - st.fx.at) / 1000).toFixed(1)} s` });
      },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
