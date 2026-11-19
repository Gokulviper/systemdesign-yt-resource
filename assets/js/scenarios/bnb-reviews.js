/*
 * Double-blind reviews.
 * After checkout Maya reviews the Lakeside cabin and Lena reviews Maya as a
 * guest. Neither sees the other's review until both have submitted or the
 * 14-day window closes; then both publish together. Published guest reviews
 * go on an event bus to an aggregator that keeps the listing's average, which
 * the listing page reads through a cache. Phones read their own review from
 * the primary or from an asynchronous replica. The questions: is the reveal
 * decided in one transaction, is closing the window atomic with late
 * submissions, does the aggregator count each event once, and can Maya see
 * the review just written? Simulated time is scaled: 1 s stands for one day.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const DAY = 1000;
  const WINDOW = 14 * DAY;
  const REPL_MS = 200;
  const CACHE_TTL = 500;
  const BASE = { sum: 226, count: 47 }; // earlier guest reviews: 4.81
  const NAME = { maya: 'Maya', lena: 'Lena' };
  const OTHER = { maya: 'lena', lena: 'maya' };
  const TEXT = { maya: 'Lovely cabin and a great view, but the heating was broken for a night.', lena: 'Maya left the cabin spotless. Welcome back any time.' };
  const STARS = { maya: 3, lena: 5 };

  const avg = (a) => (a.count ? a.sum / a.count : 0);
  const fmtAvg = (a) => `★ ${avg(a).toFixed(2)} (${a.count})`;
  const guestRows = (db) => Object.values(db.reviews).filter((r) => r.by === 'maya');
  const truth = (st) => {
    const pub = guestRows(st.db).filter((r) => r.status === 'published');
    return { sum: BASE.sum + pub.reduce((a, r) => a + r.stars, 0), count: BASE.count + pub.length };
  };
  const days = (ms) => `${Math.max(0, ms / DAY).toFixed(1)} days`;

  /** The window closes `ms` from now; the scheduler fires at that exact moment. */
  function window_(sim, ms) {
    const st = sim.state;
    st.db.closesAt = sim.now + ms;
    const at = st.db.closesAt;
    sim.schedule(ms, () => close(sim, at));
  }

  /* ---------------- flows ---------------- */
  function view(sim, who) {
    sim.spawn(function* (ctx) {
      const r = yield ctx.call('api', 'mine', { who }, { timeout: 600, quiet: 'all' });
      if (r.ok) Object.assign(ctx.ui[who], { mine: r.value.mine, other: r.value.other, closed: r.value.closed, closesAt: r.value.closesAt, from: r.value.from });
      const c = yield ctx.call('api', 'listing', {}, { timeout: 600, quiet: 'all' });
      if (c.ok) ctx.ui.listing = c.value;
    }, { self: who, quiet: 'all' });
  }

  function submit(sim, who) {
    const u = sim.ui[who];
    if (u.busy || u.mine) return; // the phone believes this review exists
    u.busy = true;
    sim.startAction(`${NAME[who]}: submit a review (${u.stars} stars)`, function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: ['no', 'The reviews table has no unique key per stay and author: a second submit is a second review.'] });
      const r = yield ctx.call('api', 'submit', { who, stars: Number(u.stars), text: TEXT[who] }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.busy = false;
      if (!r.ok) {
        Object.assign(u, { message: r.error.code === 'WINDOW_CLOSED' ? 'The review window has closed.' : `Couldn’t submit: ${r.error.message}`, tone: 'fail' });
        Y.failed(ctx, r.error.message);
        ctx.explain(r.error.code === 'WINDOW_CLOSED' ? `Closing the window and checking it are the same atomic flag, so ${NAME[who]}’s late review is refused. ${NAME[OTHER[who]]}’s review was published at the close, and nobody can write after reading it.` : `Failed with ${r.error.code}.`);
        return;
      }
      const v = r.value;
      Object.assign(u, { message: v.revealed ? 'Thanks! Both reviews are now public.' : `Thanks! Your review stays hidden until ${NAME[OTHER[who]]} submits or the window closes.`, tone: '' });
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Review ${v.id}${v.revealed ? ', revealed with the other' : ', hidden'}.`], async: v.revealed && who === 'maya' ? ['pending', 'The listing rating updates when the aggregator applies the event.'] : 'n/a' });
      ctx.explain(v.broken
        ? `${NAME[who]} wrote this after ${NAME[OTHER[who]]}’s review was already public: the scheduler published it at the deadline but had not yet marked the window closed, and submissions only check that flag. The point of a blind review is gone.`
        : v.revealed
          ? `${NAME[OTHER[who]]} had already submitted, so ${ctx.state.config.atomic ? 'the same transaction that inserted this review saw it and published both' : 'the read before the insert saw it, and both were published'}.`
          : v.raced
            ? `The service read “${NAME[OTHER[who]]} has not submitted”, then inserted. ${NAME[OTHER[who]]}’s submit did the same in between, so each insert thought it was first. Both reviews now wait for the deadline.`
            : `Hidden until ${NAME[OTHER[who]]} submits or the window closes in ${days(ctx.state.db.closesAt - ctx.now())}.`);
      view(ctx.sim, who);
    }, { self: who });
  }

  function remove(sim) {
    sim.startAction('Trust and safety: remove Maya’s review (it contained a phone number)', function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'Moderation.'], retrySafe: 'yes' });
      const r = yield ctx.call('review', 'remove', { by: 'maya' }, { timeout: 1000 });
      if (r.ok) { Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', 'The aggregator subtracts it.'] }); ctx.explain('The review is marked removed and a “review.removed” event goes on the bus. The aggregator subtracts its stars, so the listing average is recomputed without it.'); }
      else Y.failed(ctx, r.error.message);
    }, { self: 'lena' });
  }

  /** The window closes: publish every hidden review. */
  function close(sim, at) {
    const st = sim.state;
    if (at !== st.db.closesAt) return;
    if (sim.nodes.scheduler.modes.paused) { st.missed = true; return; }
    const runs = sim.nodes.scheduler.modes.twice ? 2 : 1;
    for (let i = 0; i < runs; i++) {
      sim.spawn(function* (ctx) {
        if (ctx.state.config.cas) {
          const r = ctx.must(yield ctx.call('primary', 'close', {}, { timeout: 800 }));
          ctx.log({ op: r.already ? 'window already closed' : `window closed: ${r.published.length} review${r.published.length === 1 ? '' : 's'} published`, status: r.already ? 'dup' : 'ok', detail: r.already ? 'The compare-and-set found it closed; nothing to do.' : 'Closing and publishing happened in one step; any later submission sees “closed”.' });
          return;
        }
        const s0 = ctx.must(yield ctx.call('primary', 'read', {}, { timeout: 800 }));
        if (s0.closed) return;
        const p = ctx.must(yield ctx.call('primary', 'publishHidden', {}, { timeout: 800 }));
        ctx.log({ op: `deadline: ${p.published.length} review${p.published.length === 1 ? '' : 's'} published`, status: 'ok', detail: 'Published first; the window is marked closed after the notifications go out.' });
        yield ctx.wait(300); // send notifications, then mark closed
        yield ctx.call('primary', 'setClosed', {}, { timeout: 800 });
      }, { self: 'scheduler', quiet: 'all' });
    }
  }

  SDL.scenarios['bnb-reviews'] = {
    id: 'bnb-reviews',
    seed: 4849,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Submit Maya’s review, then Lena’s: neither sees the other’s until both are in, then both publish and the listing average updates. Then submit both at the same moment, submit late as the window closes, or deliver the rating event twice.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'Guest', kind: 'client', x: 90, y: 110, latency: 1, role: 'Reviews the cabin. Shows Maya’s own review and, once public, Lena’s.', owns: ['What Maya sees'] },
        { id: 'lena', label: 'Lena’s phone', sub: 'Host', kind: 'client', x: 90, y: 480, latency: 1, role: 'Reviews Maya as a guest. Shows Lena’s own review and, once public, Maya’s.', owns: ['What Lena sees'] },
        { id: 'api', label: 'API gateway', sub: 'Routing', kind: 'gateway', x: 280, y: 300, latency: 2, role: 'Routes submissions, own-review reads, and the listing page.', ops: [{ name: 'submit', desc: 'Submit a review.' }, { name: 'mine', desc: 'My review and the other’s if public.' }, { name: 'listing', desc: 'Listing rating.' }], owns: ['Nothing durable'] },
        { id: 'review', label: 'Review service', sub: 'Hidden until both', kind: 'service', x: 480, y: 300, latency: 3, role: 'Stores reviews hidden and reveals both when the second arrives, in one transaction or by reading first.', ops: [{ name: 'submit', desc: 'Insert and maybe reveal.' }, { name: 'mine', desc: 'Read for a phone.' }, { name: 'remove', desc: 'Moderation.' }], owns: ['Reveal rules'] },
        { id: 'primary', label: 'Review primary', sub: 'Reviews + window', kind: 'db', x: 700, y: 200, latency: 5, role: 'Reviews for the stay and the window’s “closed” flag.', ops: [{ name: 'submit', desc: 'Insert in one transaction.' }, { name: 'read', desc: 'Read the stay.' }, { name: 'close', desc: 'Close the window (compare-and-set).' }], owns: ['reviews', 'window'] },
        { id: 'replica', label: 'Review replica', sub: 'Asynchronous', kind: 'db', x: 700, y: 420, latency: 5, role: 'A copy of the primary, a moment behind. Cheaper reads for phones.', ops: [{ name: 'read', desc: 'Read the stay.' }], owns: ['reviews (copy)'] },
        { id: 'scheduler', label: 'Reveal scheduler', sub: 'Closes the window', kind: 'worker', x: 480, y: 90, latency: 2, role: 'At the deadline, closes the window and publishes every hidden review.', owns: ['Nothing durable'] },
        { id: 'bus', label: 'Event bus', sub: 'review events', kind: 'queue', x: 920, y: 200, latency: 3, queue: 'events', role: 'review.published and review.removed events.', owns: ['events'] },
        { id: 'aggregator', label: 'Rating aggregator', sub: 'Listing average', kind: 'worker', x: 920, y: 420, latency: 3, role: 'Adds and subtracts guest ratings, optionally skipping events it has already applied.', owns: ['Listing rating (sum, count)'] },
        { id: 'cache', label: 'Listing page cache', sub: `${CACHE_TTL / 1000} s`, kind: 'cache', x: 280, y: 90, latency: 2, role: 'The rating shown on the listing page.', ops: [{ name: 'get', desc: 'Cached rating.' }], owns: ['cached rating'] },
      ],
      edges: [
        { from: 'maya', to: 'api', latency: 40 },
        { from: 'lena', to: 'api', latency: 40 },
        { from: 'api', to: 'review', latency: 3 },
        { from: 'api', to: 'cache', latency: 3 },
        { from: 'review', to: 'primary', latency: 3 },
        { from: 'review', to: 'replica', latency: 3 },
        { from: 'primary', to: 'replica', latency: 3, label: 'replication' },
        { from: 'scheduler', to: 'primary', latency: 3 },
        { from: 'primary', to: 'bus', latency: 3 },
        { from: 'bus', to: 'aggregator', latency: 3 },
        { from: 'cache', to: 'aggregator', latency: 3, via: [[1060, 90], [1060, 420]] },
      ],
      queues: [{ id: 'events', broker: 'bus', label: 'events', groups: ['aggregator'] }],
    },
    modeLabels: { twice: 'Firing twice', dup: 'Delivering the next event twice', lag: 'Replication stopped', stale: 'Ignoring expiry' },
    failures: [
      { id: 'sched-paused', node: 'scheduler', mode: 'paused', label: 'Reveal scheduler paused', desc: 'The deadline passes and nothing publishes the hidden reviews.' },
      { id: 'sched-twice', node: 'scheduler', mode: 'twice', label: 'Scheduler fires twice', desc: 'Two instances close the same window.' },
      { id: 'dup', node: 'bus', mode: 'dup', label: 'Next event delivered twice', desc: 'At-least-once delivery: the aggregator gets the same event again.' },
      { id: 'agg-paused', node: 'aggregator', mode: 'paused', label: 'Aggregator paused', desc: 'New ratings do not reach the listing average.' },
      { id: 'cache-stale', node: 'cache', mode: 'stale', label: 'Listing cache ignores expiry', desc: 'The listing page keeps an old rating.' },
      { id: 'replica-lag', node: 'replica', mode: 'lag', label: 'Replica lagging', desc: 'Phones that read the replica do not see reviews just written.' },
      { id: 'primary-slow', node: 'primary', mode: 'slow', params: { factor: 20 }, label: 'Review primary slow', desc: 'Every submission and the reveal take longer.' },
    ],
    switches: Y.switches([
      ['atomic', 'Reveal in one transaction', 'Insert the review and check for the other side’s in the same transaction. Off: read first, then insert.'],
      ['cas', 'Close the window with compare-and-set', 'One atomic step marks the window closed and publishes; submissions check the same flag. Off: publish, then mark closed afterwards.'],
      ['dedupe', 'Aggregator skips repeated events', 'Remember applied event ids. Off: apply whatever arrives.'],
      ['readPrimary', 'Read your own review from the primary', 'A phone reads its own review from the primary. Off: from the replica.'],
    ]),
    presets: Y.presets({ atomic: true, cas: true, dedupe: true, readPrimary: true }, [
      { id: 'both', label: 'Both submit', desc: 'Maya submits, Lena submits a moment later. Lena’s insert sees Maya’s review, and both publish together. The listing average goes from 4.81 to 4.77.', run: (s) => { submit(s, 'maya'); s.schedule(300, () => submit(s, 'lena')); } },
      { id: 'simul-rtw', label: 'Simultaneous submit, read then write', desc: 'Both tap Submit at once. Each read says “the other hasn’t submitted”, so neither reveals: both reviews stay hidden until the deadline, 14 days away.', sw: { atomic: false }, run: (s) => { submit(s, 'maya'); submit(s, 'lena'); } },
      { id: 'simul-atomic', label: 'Simultaneous submit, one transaction', desc: 'Same taps. The second transaction sees the first review and publishes both.', run: (s) => { submit(s, 'maya'); submit(s, 'lena'); } },
      { id: 'late-blind', label: 'Late submission, no compare-and-set', desc: 'One day is left. Maya has submitted. At the deadline Maya’s review is published, the window is not yet marked closed, and Lena reads Maya’s review and then submits.', sw: { cas: false }, run: (s) => { window_(s, DAY); submit(s, 'maya'); s.schedule(DAY + 60, () => submit(s, 'lena')); } },
      { id: 'late-cas', label: 'Late submission, compare-and-set', desc: 'Same timing. Closing is one atomic step, so Lena’s submission is refused.', run: (s) => { window_(s, DAY); submit(s, 'maya'); s.schedule(DAY + 60, () => submit(s, 'lena')); } },
      { id: 'only-maya', label: 'Only Maya submits', desc: 'Lena never reviews. When the window closes a day later, Maya’s review publishes on its own.', run: (s) => { window_(s, DAY); submit(s, 'maya'); } },
      { id: 'sched-paused', label: 'Reveal scheduler paused', desc: 'Same, but the scheduler is paused. The deadline passes and Maya’s review stays hidden.', run: (s) => { s.inject('scheduler', 'paused'); window_(s, DAY); submit(s, 'maya'); } },
      { id: 'dup-nodedupe', label: 'Duplicate event, no dedupe', desc: 'The bus delivers Maya’s rating event twice and the aggregator adds 3 stars twice: the listing shows 4.73 instead of 4.77.', sw: { dedupe: false }, run: (s) => { s.inject('bus', 'dup'); submit(s, 'maya'); s.schedule(300, () => submit(s, 'lena')); } },
      { id: 'dup-dedupe', label: 'Duplicate event, dedupe', desc: 'Same duplicate. The aggregator has applied that event id already and skips it.', run: (s) => { s.inject('bus', 'dup'); submit(s, 'maya'); s.schedule(300, () => submit(s, 'lena')); } },
      { id: 'replica-lag', label: 'Replica lag, Maya submits again', desc: 'Maya’s phone reads the lagging replica, doesn’t find the review, and shows the form again. Maya submits a second time; there is no unique key per stay and author, so there are now two reviews.', sw: { readPrimary: false }, run: (s) => { s.inject('replica', 'lag'); submit(s, 'maya'); s.schedule(800, () => submit(s, 'maya')); } },
      { id: 'moderation', label: 'Moderator removes a review', desc: 'Both reviews publish; Maya’s is then removed for containing a phone number. The aggregator subtracts it and the average returns to 4.81.', run: (s) => { submit(s, 'maya'); s.schedule(300, () => submit(s, 'lena')); s.schedule(1500, () => remove(s)); } },
      { id: 'agg-paused', label: 'Aggregator paused', desc: 'Both reviews publish, but the aggregator is paused: the listing still says 4.81.', run: (s) => { s.inject('aggregator', 'paused'); submit(s, 'maya'); s.schedule(300, () => submit(s, 'lena')); } },
    ]),
    initialState: () => ({
      config: { atomic: true, cas: true, dedupe: true, readPrimary: true },
      db: { reviews: {}, closed: false, closesAt: WINDOW, ver: 0 },
      replica: { reviews: {}, closed: false, closesAt: WINDOW, ver: 0 },
      agg: Object.assign({}, BASE), applied: {}, cacheEntry: null,
      broken: null, missed: false, raced: 0,
      stats: { dupSkipped: 0, events: 0 },
      seq: { r: 0, ev: 0 },
    }),
    initialUI: () => {
      const g = (who) => ({ stars: STARS[who], mine: null, other: null, closed: false, closesAt: WINDOW, busy: false, message: '', tone: '', from: '' });
      return { maya: g('maya'), lena: g('lena'), listing: { sum: BASE.sum, count: BASE.count } };
    },
    actions: {
      submit(sim, a) { submit(sim, a.who || 'maya'); },
      remove(sim) { remove(sim); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        submit: function* (ctx, p) { return ctx.must(yield ctx.call('review', 'submit', p, { timeout: 1400 })); },
        mine: function* (ctx, p) { return ctx.must(yield ctx.call('review', 'mine', p, { timeout: 500, quiet: 'all' })); },
        listing: function* (ctx) { return ctx.must(yield ctx.call('cache', 'get', {}, { timeout: 500, quiet: 'all' })); },
      },
      review: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          if (st.config.atomic) return ctx.must(yield ctx.call('primary', 'submit', p, { timeout: 1000 }));
          const r = ctx.must(yield ctx.call('primary', 'read', {}, { timeout: 800 }));
          if (r.closed) ctx.fail('WINDOW_CLOSED', 'The review window has closed.');
          const otherIn = Object.values(r.reviews).some((x) => x.by === OTHER[p.who]);
          yield ctx.wait(40); // validate, check for banned words
          return ctx.must(yield ctx.call('primary', 'insert', Object.assign({ reveal: otherIn }, p), { timeout: 1000 }));
        },
        mine: function* (ctx, p) {
          const src = ctx.state.config.readPrimary ? 'primary' : 'replica';
          const r = ctx.must(yield ctx.call(src, 'read', {}, { timeout: 400, quiet: 'all' }));
          const all = Object.values(r.reviews);
          const mine = all.filter((x) => x.by === p.who).pop() || null;
          const other = all.find((x) => x.by === OTHER[p.who] && x.status === 'published') || null;
          return { mine, other, closed: r.closed, closesAt: r.closesAt, from: src };
        },
        remove: function* (ctx, p) { return ctx.must(yield ctx.call('primary', 'remove', p, { timeout: 800 })); },
      },
      primary: {
        read(ctx) { return SDL.clone(ctx.state.db); },
        submit(ctx, p) {
          const db = ctx.state.db;
          if (db.closed) ctx.fail('WINDOW_CLOSED', 'The review window has closed.');
          const rv = insert(ctx, p);
          const other = Object.values(db.reviews).find((x) => x.by === OTHER[p.who] && x.status === 'hidden');
          if (other) publish(ctx, other);
          if (other || rv.broken) publish(ctx, rv); // the other side is already public: nothing left to wait for
          return { id: rv.id, revealed: !!other || rv.broken, broken: rv.broken };
        },
        insert(ctx, p) {
          const db = ctx.state.db;
          if (ctx.state.config.cas && db.closed) ctx.fail('WINDOW_CLOSED', 'The review window has closed.');
          const rv = insert(ctx, p);
          const other = Object.values(db.reviews).find((x) => x.by === OTHER[p.who] && x.status === 'hidden');
          if (rv.broken) { publish(ctx, rv); return { id: rv.id, revealed: true, broken: true }; }
          if (p.reveal && other) { publish(ctx, other); publish(ctx, rv); return { id: rv.id, revealed: true, broken: rv.broken }; }
          if (other) ctx.state.raced++;
          return { id: rv.id, revealed: false, raced: !!other, broken: rv.broken };
        },
        close(ctx) {
          const db = ctx.state.db;
          if (db.closed) return { already: true, published: [] };
          db.closed = true;
          db.ver++;
          const hidden = Object.values(db.reviews).filter((x) => x.status === 'hidden');
          for (const r of hidden) publish(ctx, r);
          return { already: false, published: hidden.map((r) => r.id) };
        },
        publishHidden(ctx) {
          const hidden = Object.values(ctx.state.db.reviews).filter((x) => x.status === 'hidden');
          for (const r of hidden) publish(ctx, r);
          return { published: hidden.map((r) => r.id) };
        },
        setClosed(ctx) { ctx.state.db.closed = true; ctx.state.db.ver++; return { ok: true }; },
        remove(ctx, p) {
          const st = ctx.state;
          const r = Object.values(st.db.reviews).find((x) => x.by === p.by && x.status === 'published');
          if (!r) ctx.fail('NOT_FOUND', 'No published review to remove.');
          r.status = 'removed';
          st.db.ver++;
          ctx.sim.enqueue('events', { eventId: `rm-${r.id}`, type: 'review.removed', payload: { id: r.id, by: r.by, stars: r.stars } });
          return { id: r.id };
        },
      },
      replica: { read(ctx) { return SDL.clone(ctx.state.replica); } },
      cache: {
        get(ctx) {
          const st = ctx.state;
          if (st.cacheEntry && (ctx.now() - st.cacheEntry.at < CACHE_TTL || ctx.mode('stale'))) return st.cacheEntry.v;
          st.cacheEntry = { at: ctx.now(), v: { sum: st.agg.sum, count: st.agg.count } };
          return st.cacheEntry.v;
        },
      },
    },
    setup(sim) {
      window_(sim, WINDOW);
      // Replication: copy the primary every 0.2 s unless the replica is lagging.
      sim.spawn(function* (ctx) {
        for (;;) { yield ctx.wait(REPL_MS); if (!ctx.mode('lag', 'replica')) ctx.state.replica = SDL.clone(ctx.state.db); }
      }, { self: 'primary', quiet: 'all' });
      // Aggregator: apply rating events, skipping repeats when dedupe is on.
      sim.spawn(function* (ctx) {
        for (;;) {
          if (ctx.mode('paused') || !ctx.sim.queueStats('events').depth) { yield ctx.wait(20); continue; }
          const { msg } = yield ctx.take('events', 'aggregator');
          const st = ctx.state;
          const e = msg.payload;
          if (st.config.dedupe && st.applied[msg.eventId]) {
            st.stats.dupSkipped++;
            ctx.log({ op: `${msg.eventId} skipped (already applied)`, status: 'dup', detail: 'The bus delivered it again; the aggregator remembers the event id.' });
          } else if (e.by === 'maya') {
            const sign = msg.type === 'review.removed' ? -1 : 1;
            st.agg.sum += sign * e.stars;
            st.agg.count += sign;
            st.applied[msg.eventId] = true;
            ctx.log({ op: `${msg.type === 'review.removed' ? 'subtracted' : 'added'} ${e.stars} stars: ${avg(st.agg).toFixed(2)}`, status: 'ok', detail: `Listing average over ${st.agg.count} reviews.` });
          }
          ctx.ack('events', 'aggregator');
        }
      }, { self: 'aggregator', quiet: 'all' });
      // A paused scheduler catches up when it resumes.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const st = ctx.state;
          if (st.missed && !ctx.mode('paused', 'scheduler')) { st.missed = false; close(ctx.sim, st.db.closesAt); }
        }
      }, { self: 'scheduler', quiet: 'all' });
      // Phones refresh every 0.3 s.
      sim.spawn(function* (ctx) { for (;;) { yield ctx.wait(300); view(ctx.sim, 'maya'); view(ctx.sim, 'lena'); } }, { self: 'api', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const mine = guestRows(st.db).filter((r) => r.status !== 'removed');
      if (mine.length > 1) return { key: 'wrong', label: `Maya has ${mine.length} reviews of the same stay: the phone read the lagging replica, showed the form again, and the second submit went in. There is no unique key per stay and author, so both count.` };
      if (st.broken) return { key: 'wrong', label: `${NAME[st.broken.who]} submitted after ${NAME[OTHER[st.broken.who]]}’s review was public: the deadline published it before marking the window closed, and the late submission only checked that flag. The review is no longer blind.` };
      const t = truth(st);
      const pending = sim.queueStats('events').depth;
      if ((t.sum !== st.agg.sum || t.count !== st.agg.count) && !pending && !sim.nodes.aggregator.modes.paused) return { key: 'wrong', label: `The listing says ${fmtAvg(st.agg)}; the published reviews give ${fmtAvg(t)}. The same rating event was applied twice and nothing will undo it.` };
      const all = Object.values(st.db.reviews);
      const hidden = all.filter((r) => r.status === 'hidden');
      if (hidden.length && !st.db.closed && sim.now > st.db.closesAt + 200) return { key: 'stale', label: `The window closed ${days(sim.now - st.db.closesAt)} ago and ${hidden.map((r) => `${NAME[r.by]}’s review`).join(' and ')} is still hidden: the reveal scheduler is paused. It publishes late when it resumes.` };
      if (hidden.length === 2) return { key: 'stale', label: `Both reviews are in and both are hidden: each submission read “the other hasn’t submitted” before either inserted. They wait for the deadline in ${days(st.db.closesAt - sim.now)}.` };
      if (t.sum !== st.agg.sum || t.count !== st.agg.count) return { key: 'stale', label: `The listing says ${fmtAvg(st.agg)}; the published reviews give ${fmtAvg(t)}. ${sim.nodes.aggregator.modes.paused ? 'The aggregator is paused.' : `${pending} event${pending === 1 ? '' : 's'} waiting.`}` };
      if (!all.length) return { key: 'ok', label: 'Submit a review on either phone to start.' };
      const pub = all.filter((r) => r.status === 'published');
      const removed = all.filter((r) => r.status === 'removed');
      return { key: 'ok', label: `${pub.length ? `${pub.map((r) => `${NAME[r.by]}’s`).join(' and ')} review${pub.length > 1 ? 's are' : ' is'} public` : 'No review is public yet'}${hidden.length ? `; ${NAME[hidden[0].by]}’s is hidden until the other side submits` : ''}${removed.length ? '; Maya’s review was removed' : ''}. The listing shows ${fmtAvg(st.agg)}, matching the published reviews.${st.stats.dupSkipped ? ' A repeated event was skipped.' : ''}` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const all = Object.values(st.db.reviews);
      const t = truth(st);
      const both = all.filter((r) => r.status !== 'removed');
      const reveal = both.length === 2 && both.every((r) => r.publishedAt) ? Math.max(...both.map((r) => r.publishedAt)) - Math.max(...both.map((r) => r.at)) : null;
      return [
        { label: 'Hidden', value: all.filter((r) => r.status === 'hidden').length },
        { label: 'Published', value: all.filter((r) => r.status === 'published').length },
        { label: 'Listing shows', value: fmtAvg(st.agg) },
        { label: 'True average', value: fmtAvg(t), tone: t.sum !== st.agg.sum || t.count !== st.agg.count ? 'warn' : 'ok' },
        { label: 'Reveal lag', value: reveal == null ? '–' : SDL.fmtMs(reveal) },
        { label: 'Repeated events skipped', value: st.stats.dupSkipped },
        { label: 'Window closes in', value: st.db.closed ? 'closed' : days(st.db.closesAt - sim.now) },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['lena', 'Lena’s phone']], {
          note: 'Each side reviews the other. The listing page below shows the rating guests see.',
          below: '<div class="ops-console" data-ref="listing"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const who of ['maya', 'lena']) {
          const u = sim.ui[who];
          const card = (r, title) => `<div class="ops-row" data-tone="${r.status === 'hidden' ? 'warn' : ''}"><div class="ops-name">${esc(title)} · ${'★'.repeat(r.stars)}<span>${esc(r.text)} (${r.status})</span></div></div>`;
          const form = u.mine
            ? card(u.mine, 'Your review')
            : u.closed ? '<p class="app-sub">The review window has closed.</p>' : `<div class="app-row"><label for="bnb-stars-${who}">Stars</label><select id="bnb-stars-${who}" data-field="${who}.stars">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}"${Number(u.stars) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
                <p class="app-sub">“${esc(TEXT[who])}”</p>${Y.btn('submit', u.busy ? 'Submitting…' : 'Submit review', { arg: { who }, cls: 'go', disabled: u.busy })}`;
          Y.paint(el, sim, who, {
            head: `<div><p class="app-title">${who === 'maya' ? 'Review your stay' : 'Review your guest'}</p><p class="app-sub">${who === 'maya' ? 'Lakeside cabin' : 'Maya'} · ${u.closed ? 'window closed' : `hidden until both submit or ${days(u.closesAt - sim.now)}`}${u.from === 'replica' ? ' · read from the replica' : ''}</p></div>`,
            form,
            other: u.other ? card(u.other, `${NAME[OTHER[who]]}’s review`) : `<p class="app-sub">${NAME[OTHER[who]]}’s review appears here once both are public.</p>`,
            msg: Y.msg(u.message, u.tone),
          }, {});
        }
        const L = sim.ui.listing;
        const c = sim.scenario.consistency(sim);
        const pub = Object.values(st.db.reviews).filter((r) => r.by === 'maya' && r.status === 'published');
        SDL.ui.paintSections(el.querySelector('[data-ref="listing"]'), {
          title: `<p class="ops-title">Listing page · Lakeside cabin · ${fmtAvg(L)}</p>`,
          rows: `<div class="ops-shards">${pub.map((r) => `<div class="ops-row"><div class="ops-name">Maya · ${'★'.repeat(r.stars)}<span>${esc(r.text)}</span></div></div>`).join('') || '<p class="app-sub">No new guest reviews yet.</p>'}</div>
            <div class="app-row">${Y.btn('remove', 'Trust and safety: remove Maya’s review', { cls: 'secondary', disabled: !pub.length })}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };

  function insert(ctx, p) {
    const st = ctx.state;
    const id = `R${++st.seq.r}`;
    const other = Object.values(st.db.reviews).find((x) => x.by === OTHER[p.who] && x.status === 'published');
    const rv = { id, by: p.who, stars: p.stars, text: p.text, status: 'hidden', at: ctx.now(), publishedAt: null, broken: !!other };
    if (other && !st.broken) st.broken = { who: p.who, at: ctx.now() };
    st.db.reviews[id] = rv;
    st.db.ver++;
    return rv;
  }
  function publish(ctx, r) {
    const st = ctx.state;
    r.status = 'published';
    r.publishedAt = ctx.now();
    st.db.ver++;
    const ev = { eventId: `pub-${r.id}`, type: 'review.published', payload: { id: r.id, by: r.by, stars: r.stars } };
    ctx.sim.enqueue('events', ev);
    if (ctx.mode('dup', 'bus') && r.by === 'maya') {
      ctx.sim.restore('bus', 'dup');
      ctx.sim.enqueue('events', Object.assign({}, ev));
      ctx.log({ op: `${ev.eventId} delivered twice`, status: 'fault', detail: 'At-least-once delivery: the same event is on the bus again.' });
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
