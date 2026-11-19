/*
 * End-to-end: search, book, and stay.
 * Maya searches Lake Tahoe for New Year (nights Dec 30, Dec 31, Jan 1), opens
 * Lena's Lakeside cabin, gets a quote, and taps “Confirm and pay”. The booking
 * service holds every night in the calendar database (one row per night, unique
 * per listing and date), authorises the card, and confirms. The confirmation
 * commits an outbox row with the nights; a relay moves it to the event bus,
 * which feeds Lena's notifications, the search index, and the message thread.
 * With request to book, the nights are held as “pending” until Lena accepts or
 * the request expires (24 h, shortened to 4 s here) and the authorisation is voided.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const NIGHTS = ['Dec 30', 'Dec 31', 'Jan 1'];
  const STRIP = ['Dec 29', 'Dec 30', 'Dec 31', 'Jan 1', 'Jan 2'];
  const LISTINGS = [
    { id: 'cabin', name: 'Lakeside cabin', area: 'South Lake Tahoe', price: 310, hue: 160, host: 'Lena' },
    { id: 'aframe', name: 'A-frame near the slopes', area: 'Stateline', price: 280, hue: 30, host: 'Sam' },
    { id: 'loft', name: 'Tahoe City loft', area: 'Tahoe City', price: 240, hue: 260, host: 'Ana' },
  ];
  const CLEANING = 120;
  const FEE = 0.14;
  const HOLD_MS = 3000; // a hold during checkout
  const REQ_MS = 4000; // stands in for the 24 hours a host has to answer
  const NAME = { maya: 'Maya', dev: 'Dev' };
  const total = (l) => { const base = l.price * NIGHTS.length; return Math.round(base + CLEANING + (base + CLEANING) * FEE); };
  const cabin = LISTINGS[0];
  const usd = (n) => '$' + Number(n).toLocaleString('en-US');

  /** Nights the calendar database considers taken (held, pending, or booked), with the booking that owns each. */
  const taken = (st, now) => {
    const out = {};
    for (const b of Object.values(st.cal)) {
      if (b.status === 'held' && b.exp <= now) continue;
      if (['held', 'pending', 'confirmed'].includes(b.status)) for (const n of b.nights) (out[n] = out[n] || []).push(b.id);
    }
    return out;
  };
  const booked = (st) => Object.values(st.cal).filter((b) => b.status === 'confirmed' || b.status === 'pending');

  /* ---------------- guest flows ---------------- */
  function search(sim, who) {
    sim.startAction(`${NAME[who]}: search Lake Tahoe, Dec 30 – Jan 2`, function* (ctx) {
      const u = ctx.ui[who];
      Object.assign(u, { stage: 'searching', message: '', tone: '' });
      const r = yield ctx.call('api', 'search', { nights: NIGHTS }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      if (!r.ok) { Object.assign(u, { stage: 'home', message: `Search failed: ${r.error.message}`, tone: 'fail' }); Y.failed(ctx, 'No results.'); return; }
      Object.assign(u, { stage: 'results', results: r.value.ids });
      Y.L(ctx, { displayed: ['yes', `${r.value.ids.length} stays.`], accepted: 'n/a', committed: ['n/a', 'Read only.'], async: 'n/a', retrySafe: ['yes', 'Read only.'] });
      ctx.explain(r.value.ids.includes('cabin') && NIGHTS.some((n) => taken(ctx.state, ctx.now())[n])
        ? 'The search index still lists the cabin as free. It learns about bookings from the event bus, and the indexer is behind. Nothing is wrong yet: the quote checks the calendar database itself.'
        : `The search index answered from its copy of every listing’s free nights. ${r.value.ids.includes('cabin') ? 'The cabin is free for all three nights.' : 'The cabin is gone from the results: its nights are booked.'}`);
    }, { self: who });
  }

  function open(sim, who) {
    sim.startAction(`${NAME[who]}: open the Lakeside cabin`, function* (ctx) {
      const u = ctx.ui[who];
      Object.assign(u, { stage: 'quoting', message: '', tone: '' });
      const r = yield ctx.call('api', 'quote', { who, listing: 'cabin', nights: NIGHTS }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      if (!r.ok) {
        Object.assign(u, { stage: 'results', message: r.error.code === 'NIGHTS_TAKEN' ? 'Those dates were just booked. Try other dates.' : `Couldn’t get a price: ${r.error.message}`, tone: 'fail' });
        Y.failed(ctx, r.error.code === 'NIGHTS_TAKEN' ? 'Shows “dates just booked”.' : 'No price.');
        ctx.explain(r.error.code === 'NIGHTS_TAKEN'
          ? 'Search showed the cabin, but the quote reads the calendar database, which knows the nights are taken. The guest is told before entering card details. Search may lag; the booking path never trusts it.'
          : `The quote failed with ${r.error.code}.`);
        return;
      }
      Object.assign(u, { stage: 'listing', quote: r.value });
      Y.L(ctx, { displayed: ['yes', `${usd(r.value.total)} total.`], accepted: ['yes', `Quote ${r.value.id}.`], committed: ['n/a', 'A quote reserves nothing.'], async: 'n/a', retrySafe: ['yes', 'Read only.'] });
      ctx.explain(`The pricing service checked the calendar database (not the search index) and priced 3 nights at $${cabin.price}, a $${CLEANING} cleaning fee, and a ${FEE * 100}% service fee: ${usd(r.value.total)}. A quote holds no nights; it only says what “Confirm and pay” will charge.`);
    }, { self: who });
  }

  function pay(sim, who) {
    const u = sim.ui[who];
    if (u.stage !== 'listing' && u.stage !== 'failed') return;
    const instant = sim.state.config.instant;
    sim.startAction(`${NAME[who]}: ${instant ? 'confirm and pay' : 'request to book'} ${usd(u.quote ? u.quote.total : total(cabin))}`, function* (ctx) {
      const v = ctx.ui[who];
      Object.assign(v, { stage: 'paying', message: '', tone: '' });
      Y.L(ctx, { displayed: ['pending', instant ? '“Confirming…”.' : '“Sending request…”.'], retrySafe: ['yes', 'The quote id is the idempotency key for this checkout.'] });
      const r = yield ctx.call('api', 'reserve', { who, quoteId: v.quote ? v.quote.id : null, nights: NIGHTS, instant }, { timeout: 4000 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) {
        const b = r.value;
        Object.assign(v, { stage: b.status === 'pending' ? 'requested' : 'confirmed', booking: b.id, message: '', tone: '' });
        Y.L(ctx, { displayed: 'yes', accepted: ['yes', `Booking ${b.id}.`], committed: ['yes', b.status === 'pending' ? 'Nights held as “pending”; card authorised, not charged.' : 'Nights booked and the card charged.'], async: ['pending', 'Lena, search, and messages follow from the event.'] });
        ctx.explain(b.racy
          ? `The booking service read the calendar (“free”), then wrote ${b.id}. Between the read and the write the other guest did the same, so both bookings were written for the same nights. Nothing in the database stopped it.`
          : b.status === 'pending'
            ? `The nights are held as “pending” and the card is authorised but not charged. Lena has 24 hours (4 s here) to accept; if Lena does not answer, the request expires, the nights come back, and the authorisation is voided.`
            : `Each night was claimed with one insert into a table that allows one row per listing and night. All three rows went in, the card was charged, and the confirmation committed ${ctx.state.config.outbox ? 'with an outbox row in the same transaction' : 'and then the event was published separately'}.`);
        return;
      }
      const code = r.error.code;
      Object.assign(v, { stage: 'failed', message: code === 'NIGHTS_TAKEN' ? 'Someone just booked these dates. You weren’t charged.' : code === 'CARD_DECLINED' ? 'Your card was declined. You weren’t charged.' : `Something went wrong: ${r.error.message} You weren’t charged.`, tone: 'fail' });
      Y.failed(ctx, 'No booking. Nothing charged.');
      ctx.explain(code === 'NIGHTS_TAKEN'
        ? `The insert for ${r.error.detail || 'a night'} hit the unique constraint: another booking already owns it. The database refused, so ${NAME[who]} was told before any money moved.`
        : code === 'CARD_DECLINED'
          ? 'The card was declined after the nights were held, so the booking service released the hold straight away. The nights are free again.'
          : code === 'CRASHED'
            ? `The booking service crashed after holding the nights and before charging the card. Nobody released the hold, so the nights stay blocked until it expires (${HOLD_MS / 1000} s here). Then they are free again.`
            : `The reservation failed with ${code}. Nothing was charged.`);
    }, { self: who });
  }

  function hostAnswer(sim, accept) {
    const b = Object.values(sim.state.cal).find((x) => x.status === 'pending');
    if (!b) return;
    sim.startAction(`Lena: ${accept ? 'accept' : 'decline'} ${NAME[b.who]}’s request`, function* (ctx) {
      Y.L(ctx, { displayed: ['pending', 'Sending.'], retrySafe: ['yes', 'Accepting twice finds the booking already confirmed.'] });
      const r = yield ctx.call('api', accept ? 'accept' : 'decline', { id: b.id }, { timeout: 2000 });
      if (!r.ok) { Y.failed(ctx, r.error.message); ctx.ui.lena.message = r.error.code === 'NOT_PENDING' ? 'This request already expired.' : r.error.message; return; }
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', accept ? 'Confirmed; card captured.' : 'Declined; nights released, authorisation voided.'], async: 'yes' });
      ctx.explain(accept ? `Lena accepted inside the window. The pending nights became booked and the authorisation was captured.` : 'Lena declined. The nights are free and the authorisation was voided.');
    }, { self: 'lena' });
  }

  const at = (sim, ms, fn) => sim.schedule(ms, () => fn(sim));
  const book = (sim, who, t0, payAt) => { at(sim, t0, (s) => search(s, who)); at(sim, t0 + 300, (s) => open(s, who)); at(sim, payAt, (s) => pay(s, who)); };

  /* ---------------- server side ---------------- */
  function publish(ctx, type, b) {
    const ev = { type, eventId: `${b.id}:${type}`, payload: { id: b.id, who: b.who, nights: b.nights, type }, actionId: b.actionId };
    if (ctx.state.config.outbox) { ctx.sim.enqueue('outbox', ev); b.published = true; }
    return ev;
  }

  SDL.scenarios['bnb-book'] = {
    id: 'bnb-book',
    seed: 4101,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Book the Lakeside cabin from Maya’s phone: search, open it, then “Confirm and pay”. Watch the nights turn booked in Lena’s calendar, Lena’s notification arrive, and the cabin leave search. Then race Dev for the same nights, take the event bus down, or switch to request to book.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'Guest app', kind: 'client', x: 90, y: 90, latency: 1, role: 'Searches, opens a listing, and confirms a booking.', owns: ['What Maya sees'] },
        { id: 'dev', label: 'Dev’s phone', sub: 'Guest app', kind: 'client', x: 90, y: 300, latency: 1, role: 'Wants the same nights.', owns: ['What Dev sees'] },
        { id: 'lena', label: 'Lena’s phone', sub: 'Host app', kind: 'client', x: 90, y: 510, latency: 1, role: 'Receives booking notifications and answers requests.', ops: [{ name: 'notify', desc: 'Push a notification.' }], owns: ['What Lena sees'] },
        { id: 'api', label: 'API gateway', sub: 'Auth, routing', kind: 'gateway', x: 290, y: 300, latency: 2, role: 'Authenticates guests and hosts and routes search, quote, reserve, and accept calls.', ops: [{ name: 'search', desc: 'Search.' }, { name: 'quote', desc: 'Price a stay.' }, { name: 'reserve', desc: 'Confirm and pay.' }, { name: 'accept', desc: 'Host accepts.' }], owns: ['Nothing durable'] },
        { id: 'search', label: 'Search service', sub: 'Place + dates', kind: 'service', x: 500, y: 90, latency: 3, role: 'Asks the search index for listings free on every night of the stay.', ops: [{ name: 'query', desc: 'Find listings.' }], owns: ['Nothing durable'] },
        { id: 'index', label: 'Search index', sub: 'Free nights per listing', kind: 'store', x: 720, y: 90, latency: 4, role: 'A copy of every listing with a bitmap of free nights, kept up to date from booking events. Fast, and a little behind.', ops: [{ name: 'query', desc: 'Listings free on these nights.' }], owns: ['Listing documents (copy)'] },
        { id: 'pricing', label: 'Pricing service', sub: 'Quotes', kind: 'service', x: 500, y: 225, latency: 3, role: 'Checks the calendar database and prices the stay: nightly rate, cleaning fee, service fee.', ops: [{ name: 'quote', desc: 'Price a stay.' }], owns: ['Quotes'] },
        { id: 'booking', label: 'Booking service', sub: 'Hold, charge, confirm', kind: 'service', x: 500, y: 380, latency: 3, role: 'Holds the nights, authorises the card, and confirms. Releases the hold if anything fails. Expires requests the host did not answer.', ops: [{ name: 'reserve', desc: 'Hold, authorise, confirm.' }, { name: 'accept', desc: 'Confirm a request.' }], owns: ['Booking state machine'] },
        { id: 'calendar', label: 'Calendar database', sub: 'One row per night', kind: 'db', x: 720, y: 300, latency: 6, role: 'Bookings and their nights. With the unique rule, a night can belong to one booking only; the database refuses a second. The outbox lives here too.', ops: [{ name: 'holdIf', desc: 'Insert night rows; fails if any exists.' }, { name: 'read', desc: 'Which nights are taken.' }, { name: 'insert', desc: 'Insert rows without a check.' }, { name: 'confirm', desc: 'Held → booked, plus outbox row.' }], owns: ['bookings', 'nights (listing, date) unique', 'outbox'] },
        { id: 'payments', label: 'Payments', sub: 'Card provider', kind: 'service', x: 720, y: 480, latency: 60, role: 'Authorises, captures, and voids card payments (the payments lab covers the money path in detail).', ops: [{ name: 'authorize', desc: 'Hold money on the card.' }, { name: 'capture', desc: 'Take it.' }, { name: 'void', desc: 'Release it.' }], owns: ['Authorisations'] },
        { id: 'bus', label: 'Event bus', sub: 'Booking events', kind: 'queue', x: 940, y: 300, latency: 3, role: 'Delivers booking events to everyone who reacts to them. The outbox relay feeds it.', ops: [{ name: 'publish', desc: 'Append an event (dual-write path).' }], owns: ['events'] },
        { id: 'messaging', label: 'Messaging', sub: 'Host–guest threads', kind: 'service', x: 940, y: 120, latency: 3, role: 'Opens a conversation between guest and host when a booking is confirmed (the direct messages lab covers delivery).', owns: ['threads'] },
        { id: 'notifier', label: 'Notification worker', sub: 'Push to hosts', kind: 'worker', x: 940, y: 480, latency: 3, role: 'Tells the host about new bookings and requests.', owns: ['Nothing durable'] },
      ],
      edges: [
        { from: 'maya', to: 'api', latency: 40, label: 'mobile network' },
        { from: 'dev', to: 'api', latency: 40 },
        { from: 'lena', to: 'api', latency: 40 },
        { from: 'api', to: 'search', latency: 3 },
        { from: 'search', to: 'index', latency: 3 },
        { from: 'api', to: 'pricing', latency: 3 },
        { from: 'pricing', to: 'calendar', latency: 3 },
        { from: 'api', to: 'booking', latency: 3 },
        { from: 'booking', to: 'calendar', latency: 3 },
        { from: 'booking', to: 'payments', latency: 20 },
        { from: 'calendar', to: 'bus', latency: 3, label: 'outbox relay' },
        { from: 'booking', to: 'bus', latency: 3, via: [[850, 380], [850, 330]], label: 'dual write' },
        { from: 'bus', to: 'index', latency: 3, via: [[830, 260], [830, 90]] },
        { from: 'bus', to: 'messaging', latency: 3 },
        { from: 'bus', to: 'notifier', latency: 3 },
        { from: 'notifier', to: 'lena', latency: 30, via: [[940, 570], [90, 570]] },
      ],
      queues: [
        { id: 'outbox', broker: 'calendar', label: 'outbox', groups: ['bus'] },
        { id: 'events', broker: 'bus', label: 'booking events', groups: ['notifier', 'index', 'messaging'] },
      ],
    },
    modeLabels: { crashAfterHold: 'Crashes after the next hold' },
    failures: [
      { id: 'index-lag', node: 'index', mode: 'paused', label: 'Search index lagging', desc: 'Search still shows nights that are booked. Quotes read the calendar, so nobody can book them.' },
      { id: 'index-down', node: 'index', mode: 'down', label: 'Search index down', desc: 'Search fails. Guests with a quote can still book.' },
      { id: 'pay-slow', node: 'payments', mode: 'slow', params: { factor: 10 }, label: 'Payment provider slow', desc: '“Confirming…” takes longer; the nights stay held meanwhile.' },
      { id: 'declined', node: 'payments', mode: 'reject', params: { code: 'CARD_DECLINED', message: 'The card was declined.' }, label: 'Cards declined', desc: 'The hold is released straight away.' },
      { id: 'crash', node: 'booking', mode: 'crashAfterHold', label: 'Booking service crashes after a hold', desc: 'The nights stay held until the hold expires.' },
      { id: 'bus-down', node: 'bus', mode: 'down', label: 'Event bus down', desc: 'With an outbox, events wait in the database. With a dual write, the event is lost.' },
      { id: 'notifier-paused', node: 'notifier', mode: 'paused', label: 'Notification worker paused', desc: 'Lena is not told yet. Events wait on the bus.' },
      { id: 'calendar-down', node: 'calendar', mode: 'down', label: 'Calendar database down', desc: 'No quotes, no bookings. Search still answers from its copy.' },
    ],
    switches: Y.switches([
      ['instant', 'Instant book', 'Confirm straight away. Off: request to book; the host has 24 hours (4 s here) to accept.'],
      ['unique', 'One row per night, unique', 'The database refuses a second booking for any night. Off: read the calendar, then insert (check then insert).'],
      ['outbox', 'Outbox in the same transaction', 'The confirmation and its event commit together; a relay publishes it. Off: publish after the commit (a dual write).'],
    ]),
    presets: Y.presets({ instant: true, unique: true, outbox: true }, [
      { id: 'instant', label: 'Book the cabin', desc: 'Search, quote, hold three nights, charge, confirm. Lena is notified, the cabin leaves search, and a message thread opens.', run: (s) => { book(s, 'maya', 0, 800); at(s, 2500, (x) => search(x, 'dev')); } },
      { id: 'race', label: 'Maya and Dev want the same nights', desc: 'Both tap “Confirm and pay” 20 ms apart. Dev’s first night collides with Maya’s row, the database refuses it, and Dev is told before any money moves.', run: (s) => { book(s, 'maya', 0, 800); book(s, 'dev', 0, 820); } },
      { id: 'race-bad', label: 'Same race, check then insert', desc: 'Both read “free” before either writes. Both bookings are written and both cards charged: three nights sold twice.', sw: { unique: false }, run: (s) => { book(s, 'maya', 0, 800); book(s, 'dev', 0, 820); } },
      { id: 'index-lag', label: 'Search behind the calendar', desc: 'Maya books, but the indexer is paused. Dev still sees the cabin in search; Dev’s quote checks the calendar and says the dates were just booked.', run: (s) => { s.inject('index', 'paused'); book(s, 'maya', 0, 800); at(s, 1800, (x) => search(x, 'dev')); at(s, 2200, (x) => open(x, 'dev')); } },
      { id: 'declined', label: 'Card declined', desc: 'The nights are held, the card is declined, and the hold is released at once. Nothing booked, nothing charged.', run: (s) => { s.inject('payments', 'reject', { code: 'CARD_DECLINED', message: 'The card was declined.' }); book(s, 'maya', 0, 800); } },
      { id: 'crash-hold', label: 'Crash after the hold', desc: 'The booking service crashes between holding the nights and charging. The nights stay blocked until the hold expires 3 s later, then Maya books them.', run: (s) => { s.inject('booking', 'crashAfterHold'); book(s, 'maya', 0, 800); at(s, 4800, (x) => pay(x, 'maya')); } },
      { id: 'dual-write-bus-down', label: 'Event bus down, dual write', desc: 'The booking commits, then publishing the event fails. Maya is charged and confirmed, but Lena is never told and the cabin stays in search.', sw: { outbox: false }, run: (s) => { s.inject('bus', 'down', true, 2000); book(s, 'maya', 0, 800); } },
      { id: 'outbox-bus-down', label: 'Event bus down, outbox', desc: 'Same outage. The event committed with the booking, so the relay publishes it when the bus is back. Lena is told 2 s late.', run: (s) => { s.inject('bus', 'down', true, 2000); book(s, 'maya', 0, 800); } },
      { id: 'request-accepted', label: 'Request to book, Lena accepts', desc: 'The nights are held as pending and the card authorised. Lena accepts inside the window and the card is captured.', sw: { instant: false }, run: (s) => { book(s, 'maya', 0, 800); at(s, 2200, (x) => hostAnswer(x, true)); } },
      { id: 'request-expires', label: 'Request to book, Lena silent', desc: 'Lena never answers. After 24 hours (4 s here) the request expires: the nights come back and the authorisation is voided.', sw: { instant: false }, run: (s) => { book(s, 'maya', 0, 800); } },
    ]),
    initialState: () => ({
      config: { instant: true, unique: true, outbox: true },
      cal: {}, quotes: {}, auths: {}, lost: [], threads: {},
      idx: { cabin: [] },
      seq: { b: 0, q: 0, a: 0 },
      stats: { refused: 0, expired: 0, released: 0 },
    }),
    initialUI: () => {
      const guest = () => ({ stage: 'home', results: [], quote: null, booking: null, message: '', tone: '' });
      return { maya: guest(), dev: guest(), lena: { notes: [], message: '' } };
    },
    actions: {
      search(sim, a) { search(sim, a.who || 'maya'); },
      open(sim, a) { open(sim, a.who || 'maya'); },
      pay(sim, a) { pay(sim, a.who || 'maya'); },
      back(sim, a) { Object.assign(sim.ui[a.who], { stage: 'home', results: [], quote: null, message: '', tone: '' }); },
      accept(sim) { hostAnswer(sim, true); },
      decline(sim) { hostAnswer(sim, false); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        search: function* (ctx, p) { return ctx.must(yield ctx.call('search', 'query', p, { timeout: 800 })); },
        quote: function* (ctx, p) { return ctx.must(yield ctx.call('pricing', 'quote', p, { timeout: 1200 })); },
        reserve: function* (ctx, p) { return ctx.must(yield ctx.call('booking', 'reserve', p, { timeout: 3800 })); },
        accept: function* (ctx, p) { return ctx.must(yield ctx.call('booking', 'accept', p, { timeout: 1800 })); },
        decline: function* (ctx, p) { return ctx.must(yield ctx.call('booking', 'decline', p, { timeout: 1800 })); },
      },
      search: { query: function* (ctx, p) { return ctx.must(yield ctx.call('index', 'query', p, { timeout: 600 })); } },
      index: {
        query(ctx, p) {
          const busy = ctx.state.idx.cabin;
          return { ids: LISTINGS.filter((l) => l.id !== 'cabin' || !p.nights.some((n) => busy.includes(n))).map((l) => l.id) };
        },
      },
      pricing: {
        quote: function* (ctx, p) {
          const t = ctx.must(yield ctx.call('calendar', 'read', {}, { timeout: 800 }));
          const clash = p.nights.find((n) => t.taken[n]);
          if (clash) ctx.fail('NIGHTS_TAKEN', `${clash} is already booked.`, clash);
          const id = `q${++ctx.state.seq.q}`;
          ctx.state.quotes[id] = { id, who: p.who, total: total(cabin) };
          return { id, total: total(cabin), nightly: cabin.price };
        },
      },
      booking: {
        reserve: function* (ctx, p) {
          const st = ctx.state;
          const id = `B${++st.seq.b}`;
          let racy = false;
          if (st.config.unique) ctx.must(yield ctx.call('calendar', 'holdIf', { id, who: p.who, nights: p.nights, actionId: ctx.actionId }, { timeout: 800 }));
          else {
            const t = ctx.must(yield ctx.call('calendar', 'read', {}, { timeout: 800 }));
            const clash = p.nights.find((n) => t.taken[n]);
            if (clash) { st.stats.refused++; ctx.fail('NIGHTS_TAKEN', `${clash} is already booked.`, clash); }
            yield ctx.wait(40); // builds the booking rows; the read is already out of date
            ctx.must(yield ctx.call('calendar', 'insert', { id, who: p.who, nights: p.nights, actionId: ctx.actionId }, { timeout: 800 }));
            racy = !!Object.values(st.cal).find((b) => b.id !== id && b.status !== 'released' && b.status !== 'expired' && b.nights.some((n) => p.nights.includes(n)));
          }
          if (ctx.mode('crashAfterHold')) {
            ctx.sim.restore('booking', 'crashAfterHold');
            ctx.log({ op: `crashed holding ${id}`, status: 'err', detail: `The process died after the night rows were written and before the card was charged. Nobody will release ${id}: its hold expires on its own.` });
            st.cal[id].orphan = true;
            ctx.fail('CRASHED', 'The booking service restarted mid-request.');
          }
          const au = yield ctx.call('payments', 'authorize', { booking: id, amount: total(cabin) }, { timeout: 2500 });
          if (!au.ok) {
            yield ctx.call('calendar', 'release', { id }, { timeout: 800 });
            ctx.must(au);
          }
          st.cal[id].auth = au.value.authId;
          if (!p.instant) {
            ctx.must(yield ctx.call('calendar', 'markPending', { id, deadline: ctx.now() + REQ_MS }, { timeout: 800 }));
            yield* afterCommit(ctx, id, 'requested');
            return { id, status: 'pending', racy };
          }
          ctx.must(yield ctx.call('calendar', 'confirm', { id }, { timeout: 800 }));
          yield ctx.call('payments', 'capture', { authId: au.value.authId }, { timeout: 2500 });
          yield* afterCommit(ctx, id, 'confirmed');
          return { id, status: 'confirmed', racy };
        },
        accept: function* (ctx, p) {
          const r = ctx.must(yield ctx.call('calendar', 'decide', { id: p.id, to: 'confirmed' }, { timeout: 800 }));
          yield ctx.call('payments', 'capture', { authId: r.auth }, { timeout: 2500 });
          yield* afterCommit(ctx, p.id, 'confirmed');
          return { id: p.id };
        },
        decline: function* (ctx, p) {
          const r = ctx.must(yield ctx.call('calendar', 'decide', { id: p.id, to: 'declined' }, { timeout: 800 }));
          yield ctx.call('payments', 'void', { authId: r.auth }, { timeout: 2500 });
          yield* afterCommit(ctx, p.id, 'declined');
          return { id: p.id };
        },
      },
      calendar: {
        read(ctx) { return { taken: taken(ctx.state, ctx.now()) }; },
        holdIf(ctx, p) {
          const st = ctx.state;
          const t = taken(st, ctx.now());
          const clash = p.nights.find((n) => t[n]);
          if (clash) {
            st.stats.refused++;
            ctx.log({ op: `unique (cabin, ${clash}) refused ${p.id}`, status: 'err', detail: `${clash} already belongs to ${t[clash][0]}. The insert fails, so ${p.id} holds nothing.` });
            ctx.fail('NIGHTS_TAKEN', `${clash} is already booked.`, clash);
          }
          return insertRows(ctx, p);
        },
        insert(ctx, p) { return insertRows(ctx, p); },
        release(ctx, p) { const b = ctx.state.cal[p.id]; if (b && b.status === 'held') { b.status = 'released'; ctx.state.stats.released++; } return { released: true }; },
        markPending(ctx, p) {
          const b = ctx.state.cal[p.id];
          if (!b || b.status !== 'held') ctx.fail('HOLD_GONE', 'The hold expired.');
          Object.assign(b, { status: 'pending', deadline: p.deadline });
          publish(ctx, 'requested', b);
          return { ok: true };
        },
        confirm(ctx, p) {
          const b = ctx.state.cal[p.id];
          if (!b || b.status !== 'held') ctx.fail('HOLD_GONE', 'The hold expired before payment finished.');
          b.status = 'confirmed';
          publish(ctx, 'confirmed', b);
          return { ok: true };
        },
        /** Host decision or expiry: only a pending request can change, so accept and expiry cannot both win. */
        decide(ctx, p) {
          const b = ctx.state.cal[p.id];
          if (!b || b.status !== 'pending') ctx.fail('NOT_PENDING', 'The request is no longer pending.');
          b.status = p.to;
          if (p.to === 'expired') ctx.state.stats.expired++;
          publish(ctx, p.to, b);
          return { auth: b.auth };
        },
        sweep(ctx) {
          const due = Object.values(ctx.state.cal).filter((b) => b.status === 'held' && b.exp <= ctx.now());
          for (const b of due) { b.status = 'released'; ctx.state.stats.released++; }
          return { released: due.map((b) => b.id) };
        },
      },
      payments: {
        authorize(ctx, p) { const id = `au${++ctx.state.seq.a}`; ctx.state.auths[id] = { id, booking: p.booking, amount: p.amount, status: 'authorized' }; return { authId: id }; },
        capture(ctx, p) { const a = ctx.state.auths[p.authId]; if (a) a.status = 'captured'; return { ok: true }; },
        void(ctx, p) { const a = ctx.state.auths[p.authId]; if (a) a.status = 'voided'; return { ok: true }; },
      },
      bus: { publish(ctx, p) { ctx.sim.enqueue('events', p); return { ok: true }; } },
      lena: {
        notify(ctx, p) {
          const u = ctx.ui.lena;
          const text = { confirmed: `New booking: ${NAME[p.who]}, Dec 30 – Jan 2`, requested: `Request from ${NAME[p.who]}: Dec 30 – Jan 2`, expired: `${NAME[p.who]}’s request expired`, declined: `You declined ${NAME[p.who]}` }[p.type];
          u.notes.unshift({ id: p.id, type: p.type, text, t: ctx.now() });
          if (u.notes.length > 4) u.notes.pop();
          ctx.state.cal[p.id].told = (ctx.state.cal[p.id].told || 0) + 1;
          return { ok: true };
        },
      },
      messaging: { open(ctx, p) { ctx.state.threads[p.id] = true; return { ok: true }; } },
    },
    setup(sim) {
      Y.relay(sim, 'outbox', 'bus', 'bus', 'events');
      Y.consumer(sim, 'events', 'notifier', 'notifier', function* (ctx, msg) {
        const r = yield ctx.call('lena', 'notify', msg.payload, { timeout: 800, actionId: msg.actionId });
        markFx(ctx, msg.payload.id, 'told');
        return r.ok;
      }, () => true);
      Y.consumer(sim, 'events', 'index', 'index', function* (ctx, msg) {
        yield ctx.wait(60);
        const p = msg.payload;
        const idx = ctx.state.idx.cabin;
        if (p.type === 'confirmed' || p.type === 'requested') { for (const n of p.nights) if (!idx.includes(n)) idx.push(n); }
        else for (const n of p.nights) { const i = idx.indexOf(n); if (i >= 0) idx.splice(i, 1); }
        ctx.log({ op: `index: cabin ${p.type === 'confirmed' || p.type === 'requested' ? 'hidden for' : 'free again on'} ${p.nights.join(', ')}`, status: 'ok', actionId: msg.actionId, detail: 'The search index applied the booking event.' });
        markFx(ctx, p.id, 'indexed');
        return true;
      }, () => true);
      Y.consumer(sim, 'events', 'messaging', 'messaging', function* (ctx, msg) {
        if (msg.payload.type !== 'confirmed') return true;
        yield ctx.call('messaging', 'open', msg.payload, { timeout: 800, actionId: msg.actionId, quiet: true });
        markFx(ctx, msg.payload.id, 'thread');
        return true;
      }, () => true);
      // Booking service housekeeping: release expired holds, expire unanswered requests.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(250);
          const r = yield ctx.call('calendar', 'sweep', {}, { timeout: 800, quiet: 'all' });
          if (r.ok && r.value.released.length) ctx.log({ op: `hold ${r.value.released.join(', ')} expired`, status: 'ok', detail: 'Nobody completed this checkout, so its nights are free again.' });
          const due = Object.values(ctx.state.cal).filter((b) => b.status === 'pending' && b.deadline <= ctx.now());
          for (const b of due) {
            const d = yield ctx.call('calendar', 'decide', { id: b.id, to: 'expired' }, { timeout: 800, quiet: true, actionId: b.actionId });
            if (d.ok) {
              yield ctx.call('payments', 'void', { authId: d.value.auth }, { timeout: 2500, quiet: true, actionId: b.actionId });
              ctx.log({ op: `request ${b.id} expired`, status: 'ok', actionId: b.actionId, detail: 'Lena did not answer in time. The nights are free and the authorisation on Maya’s card is voided.' });
              const g = ctx.ui[b.who];
              if (g.booking === b.id) Object.assign(g, { stage: 'failed', message: 'Lena didn’t respond in time. Your card wasn’t charged.', tone: 'fail' });
              yield* afterCommit(ctx, b.id, 'expired');
            }
          }
        }
      }, { self: 'booking', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const owners = {};
      for (const b of booked(st)) for (const n of b.nights) (owners[n] = owners[n] || []).push(b);
      const dbl = Object.entries(owners).filter(([, bs]) => bs.length > 1);
      if (dbl.length) return { key: 'wrong', label: `${dbl.map(([n]) => n).join(', ')} ${dbl.length > 1 ? 'are' : 'is'} sold twice: ${dbl[0][1].map((b) => `${NAME[b.who]} (${b.id})`).join(' and ')}. Both were charged; one will arrive to find the other in the cabin.` };
      const lost = booked(st).find((b) => st.lost.includes(b.id));
      if (lost) return { key: 'wrong', label: `${lost.id} is confirmed and ${NAME[lost.who]} was charged, but its event was never published: Lena does not know a guest is coming, and the cabin is still in search for those nights.` };
      const orphan = Object.values(st.cal).find((b) => b.orphan && b.status === 'held' && b.exp > sim.now);
      if (orphan) return { key: 'stale', label: `${orphan.nights.join(', ')} are held by ${orphan.id}, a checkout that crashed. Nobody can book them until the hold expires in ${((orphan.exp - sim.now) / 1000).toFixed(1)} s.` };
      const qd = sim.queueStats('outbox').depth + sim.queueStats('events').depth;
      const live = booked(st);
      const notTold = live.find((b) => !b.told);
      if (notTold) return { key: 'stale', label: `${notTold.id} is ${notTold.status === 'pending' ? 'waiting for Lena' : 'confirmed'}, but Lena has not been told yet: ${sim.nodes.bus.modes.down ? 'the event bus is down and the event waits in the outbox' : sim.nodes.notifier.modes.paused ? 'the notification worker is paused' : 'the event is on its way'}.` };
      const want = live.reduce((a, b) => a.concat(b.nights), []);
      const idx = st.idx.cabin;
      if (want.some((n) => !idx.includes(n)) || idx.some((n) => !want.includes(n))) return { key: 'stale', label: `Search ${want.some((n) => !idx.includes(n)) ? 'still shows the cabin as free on nights that are booked' : 'still hides the cabin on nights that are free again'}: the index follows booking events and is behind. Quotes read the calendar, so nobody can book a taken night.` };
      if (qd) return { key: 'stale', label: `${qd} booking event${qd > 1 ? 's are' : ' is'} waiting to be delivered.` };
      const pend = live.find((b) => b.status === 'pending');
      if (pend) return { key: 'ok', label: `${pend.id} is waiting for Lena. Its nights are held as pending and Maya’s card is authorised, not charged.` };
      if (!Object.keys(st.cal).length) return { key: 'ok', label: 'Search and book to start.' };
      return { key: 'ok', label: 'Every night belongs to at most one booking, the host was told about each booking, and search agrees with the calendar.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const owners = {};
      for (const b of booked(st)) for (const n of b.nights) owners[n] = (owners[n] || 0) + 1;
      const dbl = Object.values(owners).filter((n) => n > 1).length;
      const held = Object.values(st.cal).filter((b) => b.status === 'held' && b.exp > sim.now).length;
      const charged = Object.values(st.auths).filter((a) => a.status === 'captured').length;
      const lat = sim.requests.map((r) => r.latency);
      return [
        { label: 'Confirmed bookings', value: Object.values(st.cal).filter((b) => b.status === 'confirmed').length },
        { label: 'Nights sold twice', value: dbl, tone: dbl ? 'fail' : 'ok' },
        { label: 'Refused by the unique rule', value: st.stats.refused },
        { label: 'Holds in checkout', value: held, tone: held ? 'warn' : '' },
        { label: 'Cards charged', value: charged },
        { label: 'Events waiting', value: sim.queueStats('outbox').depth + sim.queueStats('events').depth, tone: sim.queueStats('outbox').depth + sim.queueStats('events').depth ? 'warn' : '' },
        { label: 'Request p99', value: lat.length ? SDL.fmtMs(SDL.percentile(lat.slice().sort((a, b) => a - b), 99)) : '–' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['lena', 'Lena’s phone']], {
          note: 'Maya is booking; Lena hosts the Lakeside cabin. Dev (below) wants the same nights.',
          below: '<div class="ops-console" data-ref="dev"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const guestScreen = (who, compact) => {
          const u = sim.ui[who];
          const a = { who };
          const off = !!sim.nodes[who].modes.down;
          const card = (l) => `<div class="yt-card"><div class="yt-thumb" style="--h:${l.hue}"><span aria-hidden="true">⌂</span></div><div><strong>${esc(l.name)}</strong><p class="app-sub">${esc(l.area)} · $${l.price} night</p></div></div>`;
          let body = '';
          if (u.stage === 'home') body = `<p class="app-sub">Lake Tahoe · Dec 30 – Jan 2 · 2 guests</p>${Y.btn('search', 'Search', { arg: a, disabled: off })}`;
          if (u.stage === 'searching' || u.stage === 'quoting' || u.stage === 'paying') body = `<div class="app-card is-work"><strong><span class="spinner"></span>${u.stage === 'searching' ? 'Searching…' : u.stage === 'quoting' ? 'Checking dates and price…' : st.config.instant ? 'Confirming…' : 'Sending request…'}</strong></div>`;
          if (u.stage === 'results') {
            const list = u.results.map((id) => LISTINGS.find((l) => l.id === id));
            body = `<p class="app-sub">${list.length} stays · Dec 30 – Jan 2</p>${compact ? list.map((l) => `<span class="app-sub">${l.id === 'cabin' ? '✓ ' : ''}${esc(l.name)}</span>`).join(' · ') : list.map(card).join('')}
              ${list.some((l) => l.id === 'cabin') ? Y.btn('open', 'Open Lakeside cabin', { arg: a }) : '<p class="app-sub">✕ Lakeside cabin is not available.</p>'}`;
          }
          if (u.stage === 'listing' || u.stage === 'failed') {
            const q = u.quote;
            body = `${compact ? '' : card(cabin)}<div class="app-card"><span class="app-kv"><span>$${cabin.price} × 3 nights</span><span>$${cabin.price * 3}</span></span><span class="app-kv"><span>Cleaning fee</span><span>$${CLEANING}</span></span><span class="app-kv"><span>Service fee</span><span>${q ? usd(q.total - cabin.price * 3 - CLEANING) : '–'}</span></span><span class="app-kv"><strong>Total</strong><strong>${usd(q ? q.total : total(cabin))}</strong></span></div>
              ${q ? Y.btn('pay', st.config.instant ? 'Confirm and pay' : 'Request to book', { arg: a, cls: 'go' }) : ''}${Y.btn('back', 'Back', { arg: a, cls: 'secondary' })}`;
          }
          if (u.stage === 'confirmed' || u.stage === 'requested') {
            const b = st.cal[u.booking];
            const done = b && b.status === 'confirmed';
            body = `<div class="app-card ${done ? 'is-ok' : 'is-hot'}"><strong>${done ? '✓ You’re going to Lake Tahoe' : '⏱ Request sent'}</strong><span class="app-sub">Lakeside cabin · Dec 30 – Jan 2 · ${esc(u.booking)}</span>
              <span class="app-sub">${done ? `Charged ${usd(total(cabin))}` : `Card authorised, not charged · <span data-live="dl-${who}"></span>`}</span></div>
              ${done ? `<p class="app-sub">${st.threads[u.booking] ? '💬 Chat with Lena is open' : '… Opening a chat with Lena'}</p>` : ''}`;
          }
          return body + Y.msg(u.message, u.tone);
        };
        const live = {};
        for (const who of ['maya', 'dev']) { const b = st.cal[sim.ui[who].booking]; live[`dl-${who}`] = b && b.status === 'pending' ? `Lena has ${(Math.max(0, b.deadline - sim.now) / 1000).toFixed(1)} s to answer` : ''; }
        Y.paint(el, sim, 'maya', { head: '<div><p class="app-title">Stays</p><p class="app-sub">Maya · guest</p></div>', body: guestScreen('maya') }, live);
        // Lena: calendar strip, notifications, pending request
        const lu = sim.ui.lena;
        const t = taken(st, sim.now);
        const cell = (n) => {
          const ids = t[n] || [];
          const bs = ids.map((id) => st.cal[id]);
          const k = !bs.length ? 'free' : bs.length > 1 ? 'twice' : bs[0].status === 'held' ? 'held' : bs[0].status === 'pending' ? 'pending' : 'booked';
          const tone = { free: '', held: 'warn', pending: 'warn', booked: 'ok', twice: 'fail' }[k];
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name">${n}<span>${{ free: 'free', held: `held by ${ids[0]}`, pending: `pending ${ids[0]}`, booked: `booked ${ids[0]}`, twice: `✕ ${ids.join(' + ')}` }[k]}</span></div></div>`;
        };
        const pend = Object.values(st.cal).find((b) => b.status === 'pending');
        Y.paint(el, sim, 'lena', {
          head: '<div><p class="app-title">Hosting</p><p class="app-sub">Lena · Lakeside cabin</p></div>',
          cal: `<div class="ops-shards">${STRIP.map(cell).join('')}</div>`,
          req: pend ? `<div class="app-card is-hot"><strong>⏱ ${NAME[pend.who]} wants Dec 30 – Jan 2</strong><span class="app-sub"><span data-live="lena-dl"></span></span></div><div class="app-row">${Y.btn('accept', 'Accept', { cls: 'go' })}${Y.btn('decline', 'Decline', { cls: 'secondary' })}</div>` : '',
          notes: lu.notes.length ? lu.notes.map((n) => `<div class="app-card ${n.type === 'confirmed' ? 'is-ok' : ''}"><strong>${esc(n.text)}</strong></div>`).join('') : '<p class="app-sub">No notifications.</p>',
          msg: Y.msg(lu.message, 'fail'),
        }, { 'lena-dl': pend ? `${(Math.max(0, pend.deadline - sim.now) / 1000).toFixed(1)} s left to answer` : '' });
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="dev"]'), {
          title: '<p class="ops-title">Dev’s phone · same dates, same cabin</p>',
          body: `<div>${guestScreen('dev', true)}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, live);
      },
    },
  };

  function insertRows(ctx, p) {
    const st = ctx.state;
    st.cal[p.id] = { id: p.id, who: p.who, nights: p.nights.slice(), status: 'held', exp: ctx.now() + HOLD_MS, actionId: p.actionId };
    return { id: p.id };
  }
  function markFx(ctx, id, k) {
    const b = ctx.state.cal[id];
    if (!b) return;
    b.fx = b.fx || {};
    b.fx[k] = true;
    if (b.status === 'confirmed' && b.fx.told && b.fx.indexed && b.fx.thread) ctx.sim.setLedger(b.actionId, 'async', 'yes', 'Lena told, search updated, chat open.');
  }
  /** After a commit: with an outbox the event is already in the database; with a dual write publish it now. */
  function* afterCommit(ctx, id, type) {
    const st = ctx.state;
    if (st.config.outbox) return;
    const b = st.cal[id];
    const r = yield ctx.call('bus', 'publish', { type, eventId: `${id}:${type}`, payload: { id, who: b.who, nights: b.nights, type }, actionId: b.actionId }, { timeout: 600 });
    if (!r.ok) {
      st.lost.push(id);
      ctx.log({ op: `${id}: committed, event lost`, status: 'err', detail: 'A dual write: the booking is already committed in the calendar database, but publishing its event failed. Nothing will retry it.' });
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
