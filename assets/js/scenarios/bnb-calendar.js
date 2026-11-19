/*
 * Availability: never sell a night twice.
 * Lena's Lakeside cabin. Maya wants Dec 30 – Jan 2 (nights Dec 30, Dec 31,
 * Jan 1); Dev wants Jan 1 – Jan 3 (Jan 1, Jan 2): one night overlaps. The
 * calendar database stores one row per (listing, night). A booking holds its
 * rows, authorises the card, then confirms. The design question is how a
 * second booking is refused: a unique constraint on the row, a read followed by
 * an insert, or a lock on the whole listing. The primary replicates to a
 * replica that serves the phones' availability views and is promoted when the
 * primary dies. Nights are calendar dates in the listing's time zone; storing
 * them as UTC timestamps computed on the guest's phone breaks the comparison.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const DAYS = ['Dec 29', 'Dec 30', 'Dec 31', 'Jan 1', 'Jan 2', 'Jan 3'];
  const STAY = { maya: [1, 2, 3], dev: [3, 4] };
  const TZ = { maya: 0, dev: 9 }; // guest phones: London (UTC+0) and Tokyo (UTC+9)
  const TZNAME = { maya: 'London', dev: 'Tokyo' };
  const LISTING_TZ = -8; // America/Los_Angeles in winter
  const NAME = { maya: 'Maya', dev: 'Dev', lena: 'Lena' };
  const HOLD_MS = 2000;
  const PAY_MS = 150; // card authorisation; the reserve lab covers it
  const REPL_MS = 250;
  const LOCK_HOLD = 60;
  const GUESTS = 30;

  const range = (who) => `${DAYS[STAY[who][0]]} – ${DAYS[STAY[who][STAY[who].length - 1] + 1]}`;
  const live = (b) => b && (b.status === 'confirmed' || b.status === 'held');
  /** The key a night is stored under: a local date, or (the bug) a UTC instant computed from the guest's phone. */
  const keyOf = (st, who, d) => (st.config.localDates || who === 'lena' ? `D${d}` : `T${d * 24 - (TZ[who] || 0)}`);
  /** Which day Lena's calendar shows a stored key on (it reads dates in the listing's time zone). */
  const hostDay = (k) => (k[0] === 'D' ? Number(k.slice(1)) : Math.floor((Number(k.slice(1)) + LISTING_TZ) / 24));
  const label = (d) => DAYS[d] || `Feb ${d - 39}`;
  const leader = (st) => st.leader;
  const db = (ctx) => ctx.state.db[ctx.self];
  const owner = (dbx, k) => dbx.rows.filter((r) => r.k === k && live(dbx.bookings[r.b])).map((r) => r.b);

  /* ---------------- flows ---------------- */
  function view(sim, who) {
    sim.spawn(function* (ctx) {
      const r = yield ctx.call('api', 'view', { who }, { timeout: 800, quiet: 'all' });
      if (r.ok) ctx.ui[who].view = r.value;
    }, { self: who, quiet: 'all' });
  }

  function reserve(sim, who) {
    const u = sim.ui[who];
    if (u.busy) return;
    u.busy = true;
    const key = `${who}-${++sim.state.seq.key}`;
    sim.startAction(`${NAME[who]}: reserve ${range(who)}`, function* (ctx) {
      const cfg = ctx.state.config;
      const v = ctx.ui[who];
      Object.assign(v, { stage: 'working', message: '', tone: '' });
      Y.L(ctx, { displayed: ['pending', '“Reserving…”.'], retrySafe: [cfg.idem ? 'yes' : 'no', cfg.idem ? `Idempotency key ${key}: a retry returns the booking it made.` : 'No key: a retry is a brand-new booking attempt.'] });
      for (let a = 1; a <= 3; a++) {
        const r = yield ctx.call('api', 'reserve', { who, days: STAY[who], key: cfg.idem ? key : null }, { timeout: 2500 });
        ctx.recordOutcome(r.ok, r.latency);
        if (r.ok) {
          Object.assign(v, { stage: 'booked', booking: r.value.id, message: '', tone: '' });
          Y.L(ctx, { displayed: 'yes', accepted: ['yes', `Booking ${r.value.id}.`], committed: ['yes', r.value.existing ? 'Committed by the first attempt; the retry found it by its key.' : `${STAY[who].length} night rows, confirmed.`], async: 'n/a' });
          ctx.explain(r.value.existing
            ? `The first attempt committed ${r.value.id}, but its reply was lost. The retry carried the same idempotency key, so the booking service returned ${r.value.id} instead of trying to book again.`
            : r.value.racy
              ? `The booking service read the calendar (“free”), waited, then inserted. The other booking did the same in between, so both sets of rows went in. Nothing in the database said no.`
              : r.value.lockWait > 200
                ? `${r.value.id} waited ${r.value.lockWait} ms for the listing lock before it could check and insert. Correct, but every booking for this listing waits in one line, even those for other dates.`
                : `${r.value.id} holds ${STAY[who].map((d) => DAYS[d]).join(', ')}. ${cfg.unique ? 'Each night went in as a row that only one booking may own, so the database itself refuses any overlap.' : ''}`);
          break;
        }
        if (r.error.code === 'TIMEOUT' && a < 3) {
          ctx.log({ op: 'no answer: retry', status: 'retry', detail: `The phone did not hear back and tries again${cfg.idem ? ` with the same key ${key}` : ' with nothing linking it to the first attempt'}.` });
          yield ctx.wait(300);
          continue;
        }
        const own = r.error.code === 'NIGHTS_TAKEN' && r.error.detail && r.error.detail.who === who;
        if (own) ctx.state.selfConflict.push(who);
        Object.assign(v, { stage: 'failed', message: r.error.code === 'NIGHTS_TAKEN' ? `${r.error.message} Try other dates.` : r.error.code === 'CRASHED' ? 'Something went wrong. You weren’t charged.' : `Couldn’t reserve: ${r.error.message}`, tone: 'fail' });
        Y.failed(ctx, own ? 'Shows “taken”, though the first attempt booked it.' : 'No booking.');
        ctx.explain(own
          ? `The first attempt booked these nights; its reply was lost. The retry had no key, so it looked like a new booking and collided with ${NAME[who]}’s own rows. ${NAME[who]} now sees “taken” while holding a booking, and may book somewhere else as well.`
          : r.error.code === 'NIGHTS_TAKEN'
            ? `${r.error.detail ? label(r.error.detail.day) : 'A night'} already belongs to ${r.error.detail ? r.error.detail.owner : 'another booking'}${r.error.detail && r.error.detail.expired ? `, a hold that expired ${((ctx.now() - r.error.detail.exp) / 1000).toFixed(1)} s ago. The expiry worker is paused, so nothing released it: ${NAME[who]} is turned away from a free night` : ''}. The database refused the insert, so no night is shared.`
            : r.error.code === 'CRASHED'
              ? `The booking service crashed after holding the nights. The hold expires in ${HOLD_MS / 1000} s unless the expiry worker is paused.`
              : `It failed with ${r.error.code}.`);
        break;
      }
      v.busy = false;
      view(ctx.sim, who);
    }, { self: who });
  }

  function block(sim) {
    sim.startAction('Lena: block Jan 1 (a friend is staying)', function* (ctx) {
      Y.L(ctx, { displayed: ['pending', 'Saving.'], retrySafe: ['yes', 'Blocking a blocked night changes nothing.'] });
      const r = yield ctx.call('api', 'reserve', { who: 'lena', days: [3], key: null, block: true }, { timeout: 2500 });
      if (r.ok) { ctx.ui.lena.message = 'Jan 1 is blocked.'; Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', 'A block row for Jan 1.'], async: 'n/a' }); ctx.explain('Lena’s block is just another row for Jan 1. It went in first, so a guest asking for Jan 1 now collides with it.'); }
      else { ctx.ui.lena.message = `Couldn’t block: ${r.error.message}`; Y.failed(ctx, r.error.message); ctx.explain(`Lena’s block collided with ${r.error.detail ? r.error.detail.owner : 'a booking'}: the guest’s row for Jan 1 went in first. Same rule for hosts and guests: one row per night.`); }
    }, { self: 'lena' });
  }

  /** Thirty other guests booking single February nights within 0.6 s: a busy listing, no overlaps. */
  function rush(sim) {
    for (let i = 0; i < GUESTS; i++) {
      sim.schedule(i * 20, () => sim.spawn(function* (ctx) {
        const r = yield ctx.call('booking', 'reserve', { who: `g${i}`, days: [40 + i], key: null }, { timeout: 4000, quiet: 'all' });
        ctx.recordOutcome(r.ok, r.latency);
        ctx.state.rush.push({ ok: r.ok, ms: r.latency });
      }, { self: 'api', quiet: 'all' }));
    }
    sim.note(`${GUESTS} other guests start booking February nights, one every 20 ms.`);
  }

  /* ---------------- database (same code on primary and replica) ---------------- */
  function snapshot(dbx) { return SDL.clone(dbx); }
  function replicate(ctx) {
    const st = ctx.state;
    if (ctx.self !== st.leader || ctx.self !== 'primary') return null;
    const snap = snapshot(db(ctx));
    if (st.config.syncRep) return snap; // the caller ships it before answering
    ctx.spawn(function* (c) {
      yield c.wait(REPL_MS);
      while (c.mode('lag', 'replica')) yield c.wait(200);
      if (c.mode('down', 'primary')) return; // the primary died first: this change never left it
      yield c.call('replica', 'apply', snap, { timeout: 1000, quiet: 'all' });
    }, { self: 'primary', quiet: 'all' });
    return null;
  }
  const dbOps = {
    read(ctx) { return { rows: db(ctx).rows, bookings: db(ctx).bookings }; },
    findKey(ctx, p) { const b = Object.values(db(ctx).bookings).find((x) => x.key === p.key); return b ? { id: b.id } : null; },
    insert: function* (ctx, p) {
      const d = db(ctx);
      if (p.unique) {
        for (const r of p.rows) {
          const o = owner(d, r.k);
          if (o.length) {
            const ob = d.bookings[o[0]];
            ctx.state.stats.refused++;
            ctx.log({ op: `unique (cabin, ${label(r.d)}) refused ${p.b.id}`, status: 'err', detail: `${label(r.d)} already belongs to ${ob.id} (${NAME[ob.who] || 'another guest'}). The whole insert fails.` });
            ctx.fail('NIGHTS_TAKEN', `${label(r.d)} is taken.`, { day: r.d, owner: ob.id, who: ob.who, expired: ob.status === 'held' && ob.exp < ctx.now(), exp: ob.exp });
          }
        }
      }
      d.bookings[p.b.id] = Object.assign({}, p.b, { status: p.b.block ? 'confirmed' : 'held', exp: ctx.now() + HOLD_MS });
      for (const r of p.rows) d.rows.push({ k: r.k, d: r.d, b: p.b.id });
      d.ver++;
      yield* ship(ctx);
      return { id: p.b.id };
    },
    confirm: function* (ctx, p) {
      const b = db(ctx).bookings[p.id];
      if (!b || b.status !== 'held') ctx.fail('HOLD_GONE', 'The hold expired before payment finished.');
      b.status = 'confirmed';
      db(ctx).ver++;
      yield* ship(ctx);
      if (ctx.mode('crashAfterCommit')) {
        ctx.sim.restore(ctx.self, 'crashAfterCommit');
        ctx.sim.schedule(30, () => ctx.sim.inject(ctx.self, 'down'));
        ctx.log({ op: `crashes 30 ms after committing ${p.id}`, status: 'err', detail: ctx.state.config.syncRep ? 'The replica already acknowledged the commit.' : `Asynchronous replication ships changes every ${REPL_MS} ms; ${p.id} has not left this machine.` });
      }
      return { ok: true };
    },
    expire: function* (ctx) {
      const due = Object.values(db(ctx).bookings).filter((b) => b.status === 'held' && b.exp <= ctx.now());
      for (const b of due) b.status = 'expired';
      if (due.length) { db(ctx).ver++; yield* ship(ctx); }
      return { released: due.map((b) => b.id) };
    },
    apply(ctx, p) {
      const st = ctx.state;
      if (ctx.self === st.leader) return { ignored: true };
      if (p.ver > st.db.replica.ver) st.db.replica = p;
      return { ver: st.db.replica.ver };
    },
  };
  function* ship(ctx) {
    const snap = replicate(ctx);
    if (snap) {
      const r = yield ctx.call('replica', 'apply', snap, { timeout: 800, quiet: 'all' });
      if (!r.ok) ctx.log({ op: 'replica did not acknowledge', status: 'err', detail: 'Synchronous replication: the commit waits for the replica. It is unreachable, so this commit is not acknowledged to the caller.' });
      ctx.must(r);
    }
  }

  SDL.scenarios['bnb-calendar'] = {
    id: 'bnb-calendar',
    seed: 4211,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Tap “Reserve” on Maya’s phone, then on Dev’s: Jan 1 is in both stays, and the calendar database refuses the second. Then switch the unique rule off, block a night from Lena’s console, crash the primary, or store nights as UTC timestamps.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'London · Dec 30 – Jan 2', kind: 'client', x: 90, y: 90, latency: 1, role: 'Wants Dec 30, Dec 31, and Jan 1. Retries when it hears nothing back.', owns: ['What Maya sees'] },
        { id: 'dev', label: 'Dev’s phone', sub: 'Tokyo · Jan 1 – Jan 3', kind: 'client', x: 90, y: 300, latency: 1, role: 'Wants Jan 1 and Jan 2. Jan 1 overlaps Maya’s stay.', owns: ['What Dev sees'] },
        { id: 'lena', label: 'Lena’s console', sub: 'Host calendar', kind: 'client', x: 90, y: 510, latency: 1, role: 'Blocks nights. Reads dates in the listing’s time zone (Los Angeles).', owns: ['What Lena sees'] },
        { id: 'api', label: 'API gateway', sub: 'Routing', kind: 'gateway', x: 290, y: 300, latency: 2, role: 'Routes reservations to the booking service and availability views to the replica.', ops: [{ name: 'reserve', desc: 'Book nights.' }, { name: 'view', desc: 'Availability (replica).' }], owns: ['Nothing durable'] },
        { id: 'booking', label: 'Booking service', sub: 'Hold, pay, confirm', kind: 'service', x: 500, y: 300, latency: 3, role: 'Turns a stay into night rows, then authorises the card and confirms. How it stops a second booking depends on the switches.', ops: [{ name: 'reserve', desc: 'Book nights.' }], owns: ['Listing lock (when on)'] },
        { id: 'listing', label: 'Listing settings', sub: 'Time zone, rules', kind: 'service', x: 500, y: 90, latency: 3, role: 'Knows the listing’s time zone (America/Los_Angeles) and house rules.', ops: [{ name: 'get', desc: 'Read settings.' }], owns: ['Listing settings'] },
        { id: 'primary', label: 'Calendar primary', sub: 'Rows: (listing, night)', kind: 'db', x: 740, y: 230, latency: 6, serviceMs: 4, servers: 8, role: 'One row per booked night. With the unique rule on, a second row for the same night is refused. Replicates to the replica.', ops: [{ name: 'insert', desc: 'Insert night rows (unique or not).' }, { name: 'read', desc: 'Read the calendar.' }, { name: 'confirm', desc: 'Held → confirmed.' }, { name: 'expire', desc: 'Expire old holds.' }], owns: ['bookings', 'nights'] },
        { id: 'replica', label: 'Calendar replica', sub: 'Views + standby', kind: 'db', x: 740, y: 470, latency: 6, role: 'Asynchronous (or synchronous) copy. Serves availability views and is promoted if the primary dies.', ops: [{ name: 'apply', desc: 'Apply replicated changes.' }, { name: 'read', desc: 'Read the calendar.' }], owns: ['bookings (copy)', 'nights (copy)'] },
        { id: 'sweeper', label: 'Hold expiry worker', sub: 'Every 0.25 s', kind: 'worker', x: 980, y: 120, latency: 3, role: 'Expires holds whose checkout never finished, so their nights come back.', owns: ['Nothing durable'] },
        { id: 'failover', label: 'Failover controller', sub: 'Promotes the replica', kind: 'worker', x: 980, y: 380, latency: 3, role: 'Watches the primary. If it stays down for 0.3 s, promotes the replica and points the booking service at it.', owns: ['Which database is the leader'] },
      ],
      edges: [
        { from: 'maya', to: 'api', latency: 40, label: 'mobile network' },
        { from: 'dev', to: 'api', latency: 40 },
        { from: 'lena', to: 'api', latency: 40 },
        { from: 'api', to: 'booking', latency: 3 },
        { from: 'api', to: 'replica', latency: 3, via: [[290, 560], [740, 560]], label: 'views' },
        { from: 'booking', to: 'listing', latency: 3 },
        { from: 'booking', to: 'primary', latency: 3 },
        { from: 'booking', to: 'replica', latency: 3, via: [[600, 300], [600, 470]] },
        { from: 'primary', to: 'replica', latency: 3, label: 'replication' },
        { from: 'sweeper', to: 'primary', latency: 3 },
        { from: 'sweeper', to: 'replica', latency: 3, via: [[1080, 120], [1080, 470]] },
        { from: 'failover', to: 'primary', latency: 3 },
        { from: 'failover', to: 'replica', latency: 3 },
      ],
      queues: [],
    },
    modeLabels: { lag: 'Replication lagging', slowGap: 'Slow between read and insert', crashAfterHold: 'Crashes after the next hold', loseNextReply: 'Loses the next reply', crashAfterCommit: 'Crashes after the next commit' },
    failures: [
      { id: 'replica-lag', node: 'replica', mode: 'lag', label: 'Replica lagging', desc: 'Phones show nights as free that are booked. Bookings go to the primary, so nothing is sold twice.' },
      { id: 'slow-gap', node: 'booking', mode: 'slowGap', label: 'Slow between read and insert', desc: 'With check then insert, the window for a race grows from 40 ms to 400 ms.' },
      { id: 'sweeper-paused', node: 'sweeper', mode: 'paused', label: 'Hold expiry worker paused', desc: 'Abandoned holds are never released.' },
      { id: 'crash-hold', node: 'booking', mode: 'crashAfterHold', label: 'Booking service crashes after a hold', desc: 'The nights stay held until the hold expires.' },
      { id: 'lose-reply', node: 'booking', mode: 'loseNextReply', label: 'Booking reply lost', desc: 'The booking commits; the phone hears nothing and retries.' },
      { id: 'primary-crash', node: 'primary', mode: 'crashAfterCommit', label: 'Primary crashes after the next commit', desc: 'The failover controller promotes the replica. Asynchronous replication may not have shipped the last commit.' },
      { id: 'primary-slow', node: 'primary', mode: 'slow', params: { factor: 20 }, label: 'Primary slow', desc: 'Every insert waits; holds and locks are held longer.' },
      { id: 'listing-down', node: 'listing', mode: 'down', label: 'Listing settings down', desc: 'Without the listing’s rules and time zone, the booking service refuses to book.' },
    ],
    switches: Y.switches([
      ['unique', 'One row per night, unique', 'The database refuses a second row for any night. Off: read the calendar, then insert (check then insert), unless the listing is locked.'],
      ['lock', 'Lock the whole listing', 'Each booking takes the listing’s lock, checks, and inserts. Always correct, but bookings for different dates wait for each other.'],
      ['idem', 'Idempotency key on reserve', 'A retried reservation returns the booking the first attempt made. Off: a retry is a new attempt.'],
      ['syncRep', 'Synchronous replication', 'A commit waits until the replica has it, so failover loses nothing. Off: ship changes every 0.25 s.'],
      ['localDates', 'Nights as local dates', 'Store “Jan 1” as a date in the listing’s time zone. Off: store the UTC instant of midnight on the guest’s phone.'],
    ]),
    presets: Y.presets({ unique: true, lock: false, idem: true, syncRep: false, localDates: true }, [
      { id: 'overlap-unique', label: 'Overlapping stays, unique rows', desc: 'Maya and Dev reserve 20 ms apart. Dev’s row for Jan 1 hits Maya’s, the database refuses it, and Dev is told Jan 1 is taken.', run: (s) => { reserve(s, 'maya'); s.schedule(20, () => reserve(s, 'dev')); } },
      { id: 'overlap-check-insert', label: 'Overlapping stays, check then insert', desc: 'Both read “Jan 1 free” before either inserts. Both bookings go in: Jan 1 is sold twice.', sw: { unique: false }, run: (s) => { reserve(s, 'maya'); s.schedule(20, () => reserve(s, 'dev')); } },
      { id: 'hot-lock', label: 'Listing lock, 30 more guests', desc: 'Thirty guests book different February nights within 0.6 s. With a listing lock they queue one by one: correct, but the last waits over a second.', sw: { lock: true }, run: (s) => { rush(s); } },
      { id: 'hot-unique', label: 'Unique rows, 30 more guests', desc: 'Same thirty guests. Their nights never overlap, so the unique rows let them all commit in parallel.', run: (s) => { rush(s); } },
      { id: 'host-block', label: 'Lena blocks Jan 1 mid-booking', desc: 'Maya reserves; 40 ms later Lena blocks Jan 1. Maya’s row went in first, so Lena’s block is refused. Hosts and guests follow one rule.', run: (s) => { reserve(s, 'maya'); s.schedule(40, () => block(s)); } },
      { id: 'expiry-paused', label: 'Abandoned hold, expiry worker paused', desc: 'Maya’s checkout crashes after the hold. The hold expires at 2 s, but nothing releases it, and Dev is refused Jan 1, a night nobody booked.', run: (s) => { s.inject('sweeper', 'paused'); s.inject('booking', 'crashAfterHold'); reserve(s, 'maya'); s.schedule(3000, () => reserve(s, 'dev')); } },
      { id: 'retry-no-key', label: 'Reply lost, retry without a key', desc: 'Maya’s booking commits; the reply is lost. The retry collides with Maya’s own rows, and Maya’s phone says the nights are taken.', sw: { idem: false }, run: (s) => { s.inject('booking', 'loseNextReply'); reserve(s, 'maya'); } },
      { id: 'retry-key', label: 'Reply lost, retry with a key', desc: 'Same lost reply. The retry carries the same key and gets Maya’s booking back.', run: (s) => { s.inject('booking', 'loseNextReply'); reserve(s, 'maya'); } },
      { id: 'failover-async', label: 'Primary dies, asynchronous replication', desc: 'Maya’s booking commits and the primary dies before shipping it. The replica is promoted without it, and Dev books Jan 1: Maya holds a confirmation for nights the calendar no longer has.', run: (s) => { s.inject('primary', 'crashAfterCommit'); reserve(s, 'maya'); s.schedule(1500, () => reserve(s, 'dev')); } },
      { id: 'failover-sync', label: 'Primary dies, synchronous replication', desc: 'Same crash. The replica acknowledged Maya’s booking before it was confirmed, so the promoted replica refuses Dev’s Jan 1.', sw: { syncRep: true }, run: (s) => { s.inject('primary', 'crashAfterCommit'); reserve(s, 'maya'); s.schedule(1500, () => reserve(s, 'dev')); } },
      { id: 'utc-nights', label: 'Nights stored as UTC timestamps', desc: 'Maya books from London, Dev from Tokyo. Their “Jan 1” become different instants, the unique rule sees no clash, and Lena’s calendar shows Maya arriving a day early.', sw: { localDates: false }, run: (s) => { reserve(s, 'maya'); s.schedule(600, () => reserve(s, 'dev')); } },
      { id: 'replica-lag', label: 'Availability from a lagging replica', desc: 'Maya books. Dev’s phone reads the replica and still shows Jan 1 free; Dev’s reservation goes to the primary and is refused.', run: (s) => { s.inject('replica', 'lag'); reserve(s, 'maya'); s.schedule(800, () => view(s, 'dev')); s.schedule(1200, () => reserve(s, 'dev')); } },
    ]),
    initialState: () => {
      const empty = () => ({ rows: [], bookings: {}, ver: 0 });
      return {
        config: { unique: true, lock: false, idem: true, syncRep: false, localDates: true },
        db: { primary: empty(), replica: empty() },
        leader: 'primary', downSince: null, failovers: [], lostInFailover: [],
        lockFree: 0, rush: [], selfConflict: [], confirmed: {},
        seq: { b: 0, key: 0 },
        stats: { refused: 0, expired: 0, lockWait: [] },
      };
    },
    initialUI: () => {
      const g = () => ({ stage: 'idle', booking: null, view: null, busy: false, message: '', tone: '' });
      return { maya: g(), dev: g(), lena: { message: '' } };
    },
    actions: {
      reserve(sim, a) { reserve(sim, a.who || 'maya'); },
      block(sim) { block(sim); },
      rush(sim) { rush(sim); },
      view(sim, a) { view(sim, a.who || 'maya'); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        reserve: function* (ctx, p) { return ctx.must(yield ctx.call('booking', 'reserve', p, { timeout: 2400 })); },
        view: function* (ctx, p) {
          const r = ctx.must(yield ctx.call('replica', 'read', {}, { timeout: 600, quiet: 'all' }));
          const out = {};
          for (const d of STAY[p.who]) { const k = keyOf(ctx.state, p.who, d); out[d] = r.rows.some((x) => x.k === k && live(r.bookings[x.b])); }
          return { taken: out, t: ctx.now() };
        },
      },
      booking: {
        reserve: function* (ctx, p) {
          const st = ctx.state;
          const cfg = st.config;
          ctx.must(yield ctx.call('listing', 'get', {}, { timeout: 600, quiet: true }));
          const L = st.leader;
          if (p.key) {
            const f = ctx.must(yield ctx.call(L, 'findKey', { key: p.key }, { timeout: 800 }));
            if (f) { ctx.log({ op: `key ${p.key}: same booking ${f.id}`, status: 'dup', detail: 'The first attempt already committed. The retry gets its booking back; nothing is inserted.' }); return { id: f.id, existing: true }; }
          }
          const id = p.block ? `X${++st.seq.b}` : `B${++st.seq.b}`;
          const rows = p.days.map((d) => ({ d, k: keyOf(st, p.who, d) }));
          const b = { id, who: p.who, intent: p.days.slice(), key: p.key, block: !!p.block };
          let racy = false;
          let lockWait = 0;
          if (cfg.lock) {
            const start = Math.max(ctx.now(), st.lockFree);
            st.lockFree = start + LOCK_HOLD;
            lockWait = start - ctx.now();
            st.stats.lockWait.push(lockWait);
            if (lockWait) yield ctx.wait(lockWait);
          }
          if (cfg.unique && !cfg.lock) ctx.must(yield ctx.call(L, 'insert', { b, rows, unique: true }, { timeout: 1500 }));
          else {
            const cur = ctx.must(yield ctx.call(L, 'read', {}, { timeout: 1500 }));
            for (const r of rows) {
              const o = cur.rows.filter((x) => x.k === r.k && live(cur.bookings[x.b]));
              if (o.length) {
                st.stats.refused++;
                const ob = cur.bookings[o[0].b];
                ctx.fail('NIGHTS_TAKEN', `${label(r.d)} is taken.`, { day: r.d, owner: ob.id, who: ob.who, expired: ob.status === 'held' && ob.exp < ctx.now(), exp: ob.exp });
              }
            }
            if (!cfg.lock) yield ctx.wait(ctx.mode('slowGap') ? 400 : 40); // builds the rows; the read is already out of date
            ctx.must(yield ctx.call(L, 'insert', { b, rows, unique: false }, { timeout: 1500 }));
            const after = st.db[L];
            racy = rows.some((r) => owner(after, r.k).length > 1);
          }
          if (p.block) return { id };
          if (ctx.mode('crashAfterHold')) {
            ctx.sim.restore('booking', 'crashAfterHold');
            ctx.log({ op: `crashed holding ${id}`, status: 'err', detail: `The process died after inserting the rows and before confirming. Nobody will release ${id}; only the expiry worker can.` });
            ctx.fail('CRASHED', 'The booking service restarted mid-request.');
          }
          yield ctx.wait(PAY_MS); // authorise the card
          ctx.must(yield ctx.call(st.leader, 'confirm', { id }, { timeout: 1500 }));
          st.confirmed[id] = { who: p.who, intent: p.days.slice(), at: ctx.now() };
          if (ctx.mode('loseNextReply')) {
            ctx.sim.restore('booking', 'loseNextReply');
            ctx.log({ op: `reply for ${id} lost`, status: 'lost', detail: `${id} is committed, but the reply never reaches the phone in time. The phone cannot tell whether it booked.` });
            yield ctx.wait(3000);
          }
          return { id, racy, lockWait };
        },
      },
      listing: { get() { return { tz: 'America/Los_Angeles', minNights: 1 }; } },
      primary: dbOps,
      replica: dbOps,
    },
    setup(sim) {
      // Expiry worker
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(250);
          if (ctx.mode('paused')) continue;
          const r = yield ctx.call(ctx.state.leader, 'expire', {}, { timeout: 800, quiet: 'all' });
          if (r.ok && r.value.released.length) { ctx.state.stats.expired += r.value.released.length; ctx.log({ op: `hold ${r.value.released.join(', ')} expired`, status: 'ok', detail: 'That checkout never finished. Its nights are free again.' }); }
        }
      }, { self: 'sweeper', quiet: 'all' });
      // Failover controller
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const st = ctx.state;
          if (st.leader !== 'primary') continue;
          if (!ctx.sim.nodes.primary.modes.down) { st.downSince = null; continue; }
          if (st.downSince == null) st.downSince = ctx.now();
          if (ctx.now() - st.downSince < 300) continue;
          const pri = st.db.primary;
          const rep = st.db.replica;
          const lost = Object.keys(pri.bookings).filter((id) => !rep.bookings[id] || (pri.bookings[id].status === 'confirmed' && rep.bookings[id].status !== 'confirmed'));
          st.leader = 'replica';
          st.lostInFailover = lost;
          st.failovers.push(ctx.now());
          ctx.log({ op: 'promoted the replica', status: lost.length ? 'err' : 'ok', detail: lost.length ? `The replica becomes the leader without ${lost.join(', ')}: those commits never left the old primary.` : 'The replica had every commit. Nothing is lost.' });
        }
      }, { self: 'failover', quiet: 'all' });
      // Phones refresh their availability view every second.
      sim.spawn(function* (ctx) {
        for (;;) { view(ctx.sim, 'maya'); view(ctx.sim, 'dev'); yield ctx.wait(1000); }
      }, { self: 'api', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const L = st.db[st.leader];
      const liveB = Object.values(L.bookings).filter(live);
      const byDay = {};
      for (const b of liveB) for (const d of b.intent) (byDay[d] = byDay[d] || []).push(b);
      const dbl = Object.entries(byDay).find(([, bs]) => bs.length > 1);
      const lost = Object.keys(st.confirmed).filter((id) => !L.bookings[id] || !live(L.bookings[id]));
      if (lost.length) {
        const c0 = st.confirmed[lost[0]];
        const taker = liveB.find((b) => b.intent.some((d) => c0.intent.includes(d)));
        return { key: 'wrong', label: `${NAME[c0.who]} holds a confirmation for ${lost[0]}, but failover lost it: the promoted replica never received it.${taker ? ` ${NAME[taker.who] || taker.who} has since booked ${taker.intent.filter((d) => c0.intent.includes(d)).map(label).join(', ')}: sold twice.` : ' Its nights look free to everyone.'}` };
      }
      if (dbl) {
        const utc = !st.config.localDates;
        return { key: 'wrong', label: `${label(Number(dbl[0]))} is sold twice: ${dbl[1].map((b) => `${NAME[b.who] || b.who} (${b.id})`).join(' and ')}.${utc ? ' The rows were stored under different UTC instants, so the unique rule saw no clash; Lena’s calendar even shows Maya arriving on Dec 29.' : ''}` };
      }
      const stuck = Object.values(L.bookings).find((b) => b.status === 'held' && b.exp < sim.now - 300);
      if (stuck) return { key: 'stale', label: `${stuck.id}’s hold expired ${((sim.now - stuck.exp) / 1000).toFixed(1)} s ago and still blocks ${stuck.intent.map(label).join(', ')}: the expiry worker is paused. Guests are turned away from nights nobody booked.` };
      const self = st.selfConflict[0];
      if (self) return { key: 'stale', label: `${NAME[self]} has a booking, but ${NAME[self]}’s phone says the nights are taken: the retry without a key collided with ${NAME[self]}’s own rows. ${NAME[self]} may book somewhere else as well.` };
      if (st.db.replica.ver !== L.ver && st.leader === 'primary') return { key: 'stale', label: `The replica is ${L.ver - st.db.replica.ver} change${L.ver - st.db.replica.ver > 1 ? 's' : ''} behind. Phones may show nights as free that are booked; bookings check the primary, so none is sold twice.` };
      if (!liveB.length && !st.rush.length) return { key: 'ok', label: 'Reserve on either phone to start.' };
      const waits = st.rush.map((r) => r.ms).sort((a, b) => a - b);
      return { key: 'ok', label: `Every night belongs to at most one booking.${waits.length ? ` ${st.rush.length} February bookings took up to ${SDL.fmtMs(waits[waits.length - 1])} each${st.config.lock ? ', waiting in line for the listing lock' : ''}.` : ''}` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const L = st.db[st.leader];
      const byDay = {};
      for (const b of Object.values(L.bookings).filter(live)) for (const d of b.intent) byDay[d] = (byDay[d] || 0) + 1;
      const dbl = Object.values(byDay).filter((n) => n > 1).length;
      const lat = st.rush.map((r) => r.ms).sort((a, b) => a - b);
      const lw = st.stats.lockWait.slice().sort((a, b) => a - b);
      return [
        { label: 'Nights sold twice', value: dbl, tone: dbl ? 'fail' : 'ok' },
        { label: 'Refused (taken)', value: st.stats.refused },
        { label: 'Holds expired', value: st.stats.expired },
        { label: 'Leader', value: st.leader === 'primary' ? 'Primary' : 'Replica (promoted)', tone: st.leader === 'primary' ? '' : 'warn' },
        { label: 'Replica behind by', value: `${Math.max(0, L.ver - st.db.replica.ver)} changes`, tone: L.ver > st.db.replica.ver && st.leader === 'primary' ? 'warn' : '' },
        { label: 'Booking p99 (busy listing)', value: lat.length ? SDL.fmtMs(SDL.percentile(lat, 99)) : '–', tone: lat.length && SDL.percentile(lat, 99) > 800 ? 'warn' : '' },
        { label: 'Lock wait p99', value: lw.length ? SDL.fmtMs(SDL.percentile(lw, 99)) : '–' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['dev', 'Dev’s phone']], {
          note: 'Two guests, one cabin, one shared night (Jan 1). Phones show availability from the replica. Lena’s console below shows the calendar as the leader database has it.',
          below: '<div class="ops-console" data-ref="lena"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const who of ['maya', 'dev']) {
          const u = sim.ui[who];
          const vw = u.view;
          const nights = STAY[who].map((d) => `<div class="ops-row" data-tone="${vw && vw.taken[d] ? 'warn' : ''}"><div class="ops-name">${DAYS[d]}<span>${!vw ? '…' : vw.taken[d] ? 'unavailable' : 'available'}</span></div></div>`).join('');
          let stage = Y.btn('reserve', `Reserve ${range(who)}`, { arg: { who }, cls: 'go', disabled: u.busy });
          if (u.stage === 'working') stage = '<div class="app-card is-work"><strong><span class="spinner"></span>Reserving…</strong></div>';
          if (u.stage === 'booked') stage = `<div class="app-card is-ok"><strong>✓ Booked ${range(who)}</strong><span class="app-sub">${esc(u.booking)} · Lakeside cabin</span></div>`;
          Y.paint(el, sim, who, {
            head: `<div><p class="app-title">Lakeside cabin</p><p class="app-sub">${NAME[who]} · ${TZNAME[who]} · ${STAY[who].length} nights</p></div>`,
            nights: `<p class="app-sub">Your nights (from the replica${sim.nodes.replica.modes.lag ? ', lagging' : ''})</p><div class="ops-shards">${nights}</div>`,
            stage, msg: Y.msg(u.message, u.tone),
          }, {});
        }
        const L = st.db[st.leader];
        const cell = (d) => {
          const ids = Array.from(new Set(L.rows.filter((r) => hostDay(r.k) === d && live(L.bookings[r.b])).map((r) => r.b)));
          const bs = ids.map((id) => L.bookings[id]);
          const tone = bs.length > 1 ? 'fail' : !bs.length ? '' : bs[0].block ? '' : bs[0].status === 'held' ? 'warn' : 'ok';
          const txt = !bs.length ? 'free' : bs.map((b) => b.block ? 'blocked by Lena' : `${b.status === 'held' ? (b.exp < sim.now ? 'held past expiry' : 'held') : 'booked'} ${NAME[b.who] || b.who}`).join(' + ');
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name">${DAYS[d]}<span>${bs.length > 1 ? '✕ ' : ''}${esc(txt)}</span></div></div>`;
        };
        const c = sim.scenario.consistency(sim);
        const feb = Object.values(L.bookings).filter((b) => /^g/.test(b.who) && live(b)).length;
        SDL.ui.paintSections(el.querySelector('[data-ref="lena"]'), {
          title: `<p class="ops-title">Lena’s calendar · Lakeside cabin · times in Los Angeles · leader: ${st.leader === 'primary' ? 'primary' : 'replica (promoted)'}</p>`,
          grid: `<div class="ops-shards">${[0, 1, 2, 3, 4, 5].map(cell).join('')}</div>${feb ? `<p class="app-sub">February: ${feb} other bookings</p>` : ''}`,
          act: `<div class="app-row">${Y.btn('block', 'Block Jan 1', { cls: 'secondary' })}${Y.btn('rush', `${GUESTS} guests book February`, { cls: 'secondary' })}</div>${Y.msg(sim.ui.lena.message, '')}`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
