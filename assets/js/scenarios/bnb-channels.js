/*
 * One cabin, two websites: calendar sync.
 * Lena lists the Lakeside cabin here and on StayFinder (a fictional other
 * site). Each site exports an iCal feed of its bookings and imports the
 * other's. Our importer polls StayFinder's feed (every 2 h, or every 15 min)
 * and can also take webhooks pushed by StayFinder; StayFinder polls our
 * export, which sits behind a cache. Until a booking on one site reaches the
 * other, both can sell the same night. Maya books here; Omar books on
 * StayFinder. Simulated time is scaled: 1.5 s stands for one hour.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const DAYS = ['Dec 29', 'Dec 30', 'Dec 31', 'Jan 1', 'Jan 2'];
  const MAYA = [1, 2, 3];
  const OMAR = [2];
  const HOUR = 1500;
  const POLL_SLOW = 2 * HOUR;
  const POLL_FAST = HOUR / 4;
  const NAME = { maya: 'Maya', omar: 'Omar', lena: 'Lena' };

  const ago = (ms) => {
    const min = Math.round((ms / HOUR) * 60);
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
  };
  const list = (ds) => ds.map((d) => DAYS[d]).join(', ');
  const sfTaken = (st) => Object.keys(st.sf.bookings).map(Number).filter((d) => st.sf.bookings[d]);
  const ourTaken = (st) => Object.keys(st.cal.bookings).map(Number).filter((d) => st.cal.bookings[d]);

  /** The last poll happened (POLL − next) ms ago; the next one is `next` ms away. */
  function phase(sim, next) {
    const st = sim.state;
    st.nextPoll = sim.now + next;
    st.lastSync = sim.now - (st.config.fastPoll ? POLL_FAST : POLL_SLOW) + next;
  }
  /** Omar booked Dec 31 on StayFinder yesterday, and it has been imported. */
  function seedOmar(sim) {
    const st = sim.state;
    for (const d of OMAR) st.sf.bookings[d] = 'omar';
    st.sf.seq++;
    st.imported = { nights: OMAR.slice(), seq: st.sf.seq };
    st.lastGood = OMAR.slice();
  }

  /* ---------------- flows ---------------- */
  function mayaBook(sim) {
    const u = sim.ui.maya;
    if (u.busy) return;
    u.busy = true;
    sim.startAction('Maya: book Dec 30 – Jan 2 here', function* (ctx) {
      const cfg = ctx.state.config;
      Object.assign(u, { stage: 'working', message: '', tone: '' });
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call('booking', 'book', { who: 'maya', nights: MAYA }, { timeout: 2000 });
      ctx.recordOutcome(r.ok, r.latency);
      u.busy = false;
      if (r.ok) {
        Object.assign(u, { stage: 'booked' });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', 'Three nights in our calendar.'], async: ['pending', 'StayFinder learns at its next poll of our export.'] });
        const clash = MAYA.filter((d) => ctx.state.sf.bookings[d]);
        ctx.explain(clash.length
          ? `Our calendar had no block for ${list(clash)}: ${NAME[ctx.state.sf.bookings[clash[0]]]}’s StayFinder booking ${ctx.state.importMiss || 'had not been imported yet'}. Nothing here could know. ${list(clash)} is now sold on both sites.`
          : `Booked. ${cfg.recheck ? 'StayFinder confirmed the nights were free just before we committed. ' : ''}StayFinder will block these nights when it next polls our export.`);
      } else {
        Object.assign(u, { stage: 'failed', message: `${r.error.message} Try other dates.`, tone: 'fail' });
        Y.failed(ctx, 'Not booked.');
        ctx.explain(r.error.code === 'OTHER_SITE'
          ? `Before committing, the booking service asked StayFinder directly. ${list(r.error.detail.nights)} is taken there, though no webhook or poll had told us yet.`
          : `${r.error.detail ? list(r.error.detail.nights) : 'A night'} is blocked in our calendar by an import from StayFinder, so the booking is refused.`);
      }
    }, { self: 'maya' });
  }

  function omar(sim, kind) {
    const u = sim.ui.omar;
    sim.startAction(kind === 'book' ? 'Omar: book Dec 31 on StayFinder' : 'Omar: cancel Dec 31 on StayFinder', function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call('stayfinder', kind, { who: 'omar', nights: OMAR }, { timeout: 1500 });
      if (r.ok) {
        Object.assign(u, { stage: kind === 'book' ? 'booked' : 'idle', message: kind === 'book' ? '' : 'Cancelled.', tone: '' });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', 'In StayFinder’s calendar.'], async: ['pending', ctx.state.config.push ? 'A webhook is on its way to us.' : `We learn at our next poll, in ${ago(Math.max(0, ctx.state.nextPoll - ctx.now()))}.`] });
      } else {
        Object.assign(u, { stage: 'failed', message: r.error.message, tone: 'fail' });
        Y.failed(ctx, r.error.message);
      }
    }, { self: 'omar' });
  }

  function syncNow(sim) {
    sim.state.nextPoll = sim.now;
    sim.ui.lena.message = 'Syncing with StayFinder…';
  }

  /** Apply a full feed the importer fetched, or keep the last good copy. */
  function importFeed(ctx, r) {
    const st = ctx.state;
    const cfg = st.config;
    const bad = !r.ok ? (r.error.code === 'TIMEOUT' ? 'the feed did not answer in time' : 'the feed URL returned an error')
      : !r.value.complete ? `the feed stopped after ${r.value.events.length} event${r.value.events.length === 1 ? '' : 's'}, without its closing END:VCALENDAR line`
        : !r.value.events.length && st.imported.nights.length ? `the feed is empty, but ${st.imported.nights.length} block${st.imported.nights.length > 1 ? 's were' : ' was'} imported before`
          : null;
    if (bad && cfg.keepLast) {
      st.rejected.push(bad);
      ctx.log({ op: 'feed rejected: kept the last good copy', status: 'err', detail: `${bad[0].toUpperCase()}${bad.slice(1)}. The importer keeps the blocks it had and warns Lena.` });
      ctx.ui.lena.message = `StayFinder sync failed: ${bad}. Your calendar keeps the blocks it had.`;
      return;
    }
    const events = r.ok ? r.value.events : [];
    const before = st.imported.nights.slice();
    st.imported = { nights: events.map((e) => e.d), seq: r.ok ? r.value.seq : st.imported.seq };
    st.lastSync = ctx.now();
    if (!bad) st.lastGood = st.imported.nights.slice();
    const gone = before.filter((d) => !st.imported.nights.includes(d));
    for (const d of gone) if (st.sf.bookings[d]) st.sfChanged[d] = ctx.now(); // out of sync from now
    const clash = st.imported.nights.filter((d) => st.cal.bookings[d]);
    ctx.log({ op: `imported ${st.imported.nights.length} block${st.imported.nights.length === 1 ? '' : 's'}${gone.length ? `, removed ${list(gone)}` : ''}`, status: bad ? 'err' : clash.length ? 'err' : 'ok', detail: bad ? `${bad[0].toUpperCase()}${bad.slice(1)}, and the importer replaced our blocks with it anyway.` : clash.length ? `${list(clash)} is now blocked by StayFinder and booked here: sold twice.` : 'Our calendar matches StayFinder’s feed.' });
    ctx.ui.lena.message = bad ? `Synced: ${gone.length ? `${list(gone)} unblocked` : 'no blocks'}.` : `Synced from StayFinder just now${clash.length ? `: conflict on ${list(clash)}` : ''}.`;
    if (bad && gone.length) st.erased = gone;
    if (r.ok) st.seenSeq = r.value.seq;
  }

  SDL.scenarios['bnb-channels'] = {
    id: 'bnb-channels',
    seed: 4621,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Book Dec 31 on Omar’s phone (StayFinder) and watch the block reach our calendar at the next poll; then book on Maya’s phone inside that window. Switch to webhooks, re-check the other site before confirming, or serve an empty feed.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'This site', kind: 'client', x: 90, y: 90, latency: 1, role: 'Books Dec 30 – Jan 2 here.', owns: ['What Maya sees'] },
        { id: 'omar', label: 'Omar’s phone', sub: 'StayFinder', kind: 'client', x: 1070, y: 90, latency: 1, role: 'Books Dec 31 on StayFinder.', owns: ['What Omar sees'] },
        { id: 'lena', label: 'Lena’s console', sub: 'Both calendars', kind: 'client', x: 90, y: 510, latency: 1, role: 'Sees both calendars and when they last synced.', owns: ['What Lena sees'] },
        { id: 'stayfinder', label: 'StayFinder', sub: 'Another site', kind: 'service', x: 860, y: 230, latency: 20, role: 'Its own bookings, an iCal feed of them, an availability API, and (optionally) webhooks. Polls our export every 2 h.', ops: [{ name: 'book', desc: 'Book on StayFinder.' }, { name: 'feed', desc: 'iCal feed.' }, { name: 'available', desc: 'Are these nights free?' }], owns: ['StayFinder bookings'] },
        { id: 'booking', label: 'Booking service', sub: 'This site', kind: 'service', x: 320, y: 90, latency: 3, role: 'Refuses nights that are booked here or blocked by an import; optionally re-checks StayFinder before committing.', ops: [{ name: 'book', desc: 'Book nights.' }], owns: ['Nothing durable'] },
        { id: 'caldb', label: 'Calendar database', sub: 'Bookings + imported blocks', kind: 'db', x: 320, y: 300, latency: 5, role: 'Our bookings, and blocks imported from StayFinder.', ops: [{ name: 'book', desc: 'Insert a booking.' }, { name: 'read', desc: 'Read the calendar.' }], owns: ['bookings', 'imported blocks'] },
        { id: 'export', label: 'Calendar export', sub: 'iCal feed', kind: 'service', x: 600, y: 420, latency: 3, role: 'Serves our bookings as an iCal feed for other sites.', ops: [{ name: 'feed', desc: 'Our iCal feed.' }], owns: ['Nothing durable'] },
        { id: 'xcache', label: 'Export cache', sub: 'Invalidated on booking', kind: 'cache', x: 860, y: 420, latency: 2, role: 'Caches our feed; a booking invalidates it.', owns: ['cached feed'] },
        { id: 'importer', label: 'Calendar importer', sub: 'Polls StayFinder', kind: 'worker', x: 600, y: 230, latency: 3, role: 'Fetches StayFinder’s feed on a timer and replaces our imported blocks with it; also applies webhooks.', owns: ['Last good copy'] },
        { id: 'hooks', label: 'Webhook queue', sub: 'From StayFinder', kind: 'queue', x: 600, y: 90, latency: 3, queue: 'hooks', role: 'Webhooks StayFinder pushes when a night changes.', owns: ['pending webhooks'] },
      ],
      edges: [
        { from: 'maya', to: 'booking', latency: 40, label: 'mobile network' },
        { from: 'omar', to: 'stayfinder', latency: 40 },
        { from: 'lena', to: 'caldb', latency: 40 },
        { from: 'booking', to: 'caldb', latency: 3 },
        { from: 'booking', to: 'stayfinder', latency: 30, label: 're-check', via: [[460, 160], [860, 160]] },
        { from: 'booking', to: 'xcache', latency: 3, via: [[460, 90], [460, 380], [860, 380]] },
        { from: 'stayfinder', to: 'hooks', latency: 30, label: 'webhooks' },
        { from: 'hooks', to: 'importer', latency: 3 },
        { from: 'importer', to: 'stayfinder', latency: 30, label: 'poll feed' },
        { from: 'importer', to: 'caldb', latency: 3 },
        { from: 'stayfinder', to: 'export', latency: 30, label: 'poll our feed' },
        { from: 'export', to: 'xcache', latency: 2 },
        { from: 'export', to: 'caldb', latency: 3 },
      ],
      queues: [{ id: 'hooks', broker: 'hooks', label: 'webhooks', groups: ['importer'] }],
    },
    modeLabels: { empty: 'Serving an empty feed', truncated: 'Serving a truncated feed', gone: 'Feed URL gone', lose: 'Losing the next webhook', reorder: 'Delivering out of order', stale: 'Ignoring invalidation' },
    failures: [
      { id: 'importer-paused', node: 'importer', mode: 'paused', label: 'Importer paused', desc: 'Nothing from StayFinder reaches our calendar.' },
      { id: 'feed-empty', node: 'stayfinder', mode: 'empty', label: 'StayFinder feed empty', desc: 'A bug on their side: the feed is valid but has no events.' },
      { id: 'feed-truncated', node: 'stayfinder', mode: 'truncated', label: 'StayFinder feed truncated', desc: 'The feed stops halfway, without its closing line.' },
      { id: 'feed-slow', node: 'stayfinder', mode: 'slow', params: { factor: 40 }, label: 'StayFinder slow', desc: 'The feed and the availability API miss their timeouts.' },
      { id: 'feed-gone', node: 'stayfinder', mode: 'gone', label: 'Feed disconnected', desc: 'The feed URL returns “not found”, as when the host disconnects or the link changes.' },
      { id: 'hook-lost', node: 'hooks', mode: 'lose', label: 'Next webhook lost', desc: 'StayFinder sends it; it never arrives.' },
      { id: 'hook-reorder', node: 'hooks', mode: 'reorder', label: 'Webhooks out of order', desc: 'An older webhook arrives after a newer one.' },
      { id: 'xcache-stale', node: 'xcache', mode: 'stale', label: 'Export cache ignores invalidation', desc: 'StayFinder keeps polling an old copy of our feed and never sees new bookings.' },
    ],
    switches: Y.switches([
      ['fastPoll', 'Poll every 15 minutes', 'Fetch StayFinder’s feed every 15 min instead of every 2 h. A smaller window, not a closed one.'],
      ['push', 'Webhooks from StayFinder', 'StayFinder pushes each change within seconds; polling stays as a reconciliation.'],
      ['recheck', 'Re-check the other site', 'Before committing a booking, ask StayFinder’s availability API. Off: trust our calendar.'],
      ['keepLast', 'Keep last-known blocks on a bad feed', 'An empty, truncated, or failed feed is rejected and Lena is warned. Off: whatever the importer gets replaces our blocks.'],
      ['seq', 'Webhook sequence numbers', 'Ignore a webhook older than the newest one applied. Off: apply in arrival order.'],
    ]),
    presets: Y.presets({ fastPoll: false, push: false, recheck: false, keepLast: true, seq: true }, [
      { id: 'omar-poll', label: 'Omar books, then the poll', desc: 'Omar books Dec 31 on StayFinder. The next poll, an hour later, imports the block; when Maya tries to book, Dec 31 is unavailable.', run: (s) => { phase(s, HOUR); omar(s, 'book'); s.schedule(HOUR + 1000, () => mayaBook(s)); } },
      { id: 'both-window', label: 'Both book inside the poll window', desc: 'Omar books Dec 31 on StayFinder; minutes later Maya books it here. Our next poll is an hour away: Dec 31 is sold twice.', run: (s) => { phase(s, HOUR); omar(s, 'book'); s.schedule(200, () => mayaBook(s)); } },
      { id: 'fast-window', label: 'Same race, polling every 15 minutes', desc: 'Polling four times an hour shrinks the window to 15 minutes. Maya books inside it anyway.', sw: { fastPoll: true }, run: (s) => { phase(s, 300); omar(s, 'book'); s.schedule(150, () => mayaBook(s)); } },
      { id: 'push-recheck', label: 'Webhooks plus a re-check', desc: 'Omar and Maya tap at the same moment. Our calendar has not heard yet, but the booking service asks StayFinder directly before committing, and Maya is refused. The webhook lands a moment later.', sw: { push: true, recheck: true }, run: (s) => { phase(s, HOUR); omar(s, 'book'); mayaBook(s); } },
      { id: 'empty-replace', label: 'Empty feed replaces our blocks', desc: 'StayFinder’s feed comes back empty. The importer takes it at face value and erases Omar’s block; Maya books Omar’s night.', sw: { keepLast: false }, run: (s) => { seedOmar(s); s.inject('stayfinder', 'empty'); phase(s, 1000); s.schedule(1600, () => mayaBook(s)); } },
      { id: 'empty-keep', label: 'Empty feed, keep last-known blocks', desc: 'Same empty feed. The importer refuses to drop every block at once, keeps Omar’s, and warns Lena. Out of date, but nothing sold twice.', run: (s) => { seedOmar(s); s.inject('stayfinder', 'empty'); phase(s, 1000); s.schedule(1600, () => mayaBook(s)); } },
      { id: 'truncated', label: 'Truncated feed, sanity check', desc: 'The feed stops halfway, without its closing line. The importer rejects the update and keeps the last good copy.', run: (s) => { seedOmar(s); s.inject('stayfinder', 'truncated'); phase(s, 1000); s.schedule(1600, () => mayaBook(s)); } },
      { id: 'hook-lost', label: 'Lost webhook, then the poll', desc: 'Omar’s webhook never arrives. For an hour our calendar is behind; then the reconciliation poll imports the block.', sw: { push: true }, run: (s) => { s.inject('hooks', 'lose'); phase(s, HOUR); omar(s, 'book'); } },
      { id: 'reorder-noseq', label: 'Webhooks reordered, no sequence', desc: 'Omar cancels Dec 31, then rebooks it. The “cancelled” webhook arrives last and frees the night here; Maya books it.', sw: { push: true, seq: false }, run: (s) => { seedOmar(s); s.inject('hooks', 'reorder'); phase(s, POLL_SLOW); omar(s, 'cancel'); s.schedule(150, () => omar(s, 'book')); s.schedule(1500, () => mayaBook(s)); } },
      { id: 'reorder-seq', label: 'Webhooks reordered, sequence numbers', desc: 'Same reorder. The late “cancelled” webhook carries an older sequence number and is ignored; Dec 31 stays blocked.', sw: { push: true }, run: (s) => { seedOmar(s); s.inject('hooks', 'reorder'); phase(s, POLL_SLOW); omar(s, 'cancel'); s.schedule(150, () => omar(s, 'book')); s.schedule(1500, () => mayaBook(s)); } },
      { id: 'importer-paused', label: 'Importer paused', desc: 'The importer stops. Omar’s booking never arrives, and after six hours Lena’s console shows how far behind the calendar is.', run: (s) => { s.inject('importer', 'paused'); phase(s, POLL_SLOW); s.schedule(500, () => omar(s, 'book')); } },
    ]),
    initialState: () => ({
      config: { fastPoll: false, push: false, recheck: false, keepLast: true, seq: true },
      cal: { bookings: {} },
      imported: { nights: [], seq: 0 },
      lastGood: [],
      sf: { bookings: {}, seq: 0, ours: [] },
      xcache: null,
      nextPoll: POLL_SLOW, lastSync: 0, seenSeq: 0,
      rejected: [], erased: [], holding: false, importMiss: '',
      sfChanged: {},
      stats: { polls: 0, hooks: 0, ignored: 0, lost: 0 },
      seq: { ev: 0 },
    }),
    initialUI: () => ({
      maya: { stage: 'idle', busy: false, message: '', tone: '' },
      omar: { stage: 'idle', message: '', tone: '' },
      lena: { message: '' },
    }),
    actions: {
      book(sim) { mayaBook(sim); },
      omar(sim, a) { omar(sim, a.kind || 'book'); },
      sync(sim) { syncNow(sim); },
      set: Y.setAction,
    },
    handlers: {
      booking: {
        book: function* (ctx, p) {
          const st = ctx.state;
          const cal = ctx.must(yield ctx.call('caldb', 'read', {}, { timeout: 800 }));
          const blocked = p.nights.filter((d) => cal.bookings[d] || cal.imported.includes(d));
          if (blocked.length) ctx.fail('NIGHTS_TAKEN', `${list(blocked)} ${blocked.length > 1 ? 'are' : 'is'} unavailable.`, { nights: blocked });
          if (st.config.recheck) {
            const a = yield ctx.call('stayfinder', 'available', { nights: p.nights }, { timeout: 600 });
            if (!a.ok) ctx.fail('OTHER_SITE_UNKNOWN', 'We couldn’t confirm these nights right now.');
            if (a.value.taken.length) ctx.fail('OTHER_SITE', `${list(a.value.taken)} ${a.value.taken.length > 1 ? 'are' : 'is'} unavailable.`, { nights: a.value.taken });
          }
          ctx.must(yield ctx.call('caldb', 'book', p, { timeout: 800 }));
          yield ctx.call('xcache', 'del', {}, { timeout: 300, quiet: 'all' });
          return { ok: true };
        },
      },
      caldb: {
        read(ctx) { const st = ctx.state; return { bookings: Object.assign({}, st.cal.bookings), imported: st.imported.nights.slice() }; },
        book(ctx, p) {
          const st = ctx.state;
          const missing = p.nights.filter((d) => st.sf.bookings[d]);
          if (missing.length) st.importMiss = st.erased.some((d) => missing.includes(d)) ? 'was erased by the importer when it took an empty feed' : st.sfChanged.reorderFreed ? 'was undone by a late “cancelled” webhook' : `was made ${ago(ctx.now() - (st.sfChanged[missing[0]] || ctx.now()))} ago and had not been imported yet`;
          for (const d of p.nights) st.cal.bookings[d] = p.who;
          return { ok: true };
        },
      },
      xcache: {
        get(ctx) { return { feed: ctx.state.xcache }; },
        put(ctx, p) { ctx.state.xcache = p.feed; return { ok: true }; },
        del(ctx) { if (!ctx.mode('stale')) ctx.state.xcache = null; return { ok: true }; },
      },
      export: {
        feed: function* (ctx) {
          const c = yield ctx.call('xcache', 'get', {}, { timeout: 300, quiet: 'all' });
          if (c.ok && c.value.feed) return c.value.feed;
          const cal = ctx.must(yield ctx.call('caldb', 'read', {}, { timeout: 600, quiet: 'all' }));
          const feed = { nights: Object.keys(cal.bookings).map(Number).filter((d) => cal.bookings[d]) };
          yield ctx.call('xcache', 'put', { feed }, { timeout: 300, quiet: 'all' });
          return feed;
        },
      },
      stayfinder: {
        book(ctx, p) {
          const st = ctx.state;
          const taken = p.nights.filter((d) => st.sf.bookings[d] || st.sf.ours.includes(d));
          if (taken.length) ctx.fail('NIGHTS_TAKEN', `${list(taken)} is unavailable on StayFinder.`);
          for (const d of p.nights) { st.sf.bookings[d] = p.who; st.sfChanged[d] = ctx.now(); }
          st.sf.seq++;
          if (st.config.push) hook(ctx, p.nights, 'booked');
          return { seq: st.sf.seq };
        },
        cancel(ctx, p) {
          const st = ctx.state;
          for (const d of p.nights) st.sf.bookings[d] = null;
          st.sf.seq++;
          if (st.config.push) hook(ctx, p.nights, 'free');
          return { seq: st.sf.seq };
        },
        feed(ctx) {
          const st = ctx.state;
          if (ctx.mode('gone')) ctx.fail('NOT_FOUND', 'Feed not found.');
          const events = sfTaken(st).map((d) => ({ d, uid: `sf-${d}` }));
          if (ctx.mode('empty')) return { events: [], complete: true, seq: st.sf.seq };
          if (ctx.mode('truncated')) return { events: events.slice(0, Math.floor(events.length / 2)), complete: false, seq: st.sf.seq };
          return { events, complete: true, seq: st.sf.seq };
        },
        available(ctx, p) { const st = ctx.state; return { taken: p.nights.filter((d) => st.sf.bookings[d]) }; },
      },
    },
    setup(sim) {
      // Our importer: poll StayFinder's feed when the timer says so.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(10);
          const st = ctx.state;
          if (ctx.mode('paused') || ctx.now() < st.nextPoll) continue;
          st.nextPoll = ctx.now() + (st.config.fastPoll ? POLL_FAST : POLL_SLOW);
          st.stats.polls++;
          const r = yield ctx.call('stayfinder', 'feed', {}, { timeout: 800 });
          importFeed(ctx, r);
        }
      }, { self: 'importer', quiet: 'all' });
      // Webhooks: apply each change as it arrives.
      sim.spawn(function* (ctx) {
        for (;;) {
          if (ctx.mode('paused') || !ctx.sim.queueStats('hooks').depth) { yield ctx.wait(10); continue; }
          const { msg } = yield ctx.take('hooks', 'importer');
          const st = ctx.state;
          const h = msg.payload;
          st.stats.hooks++;
          if (st.config.seq && h.seq <= st.seenSeq) {
            st.stats.ignored++;
            ctx.log({ op: `webhook #${h.seq} ignored (already at #${st.seenSeq})`, status: 'dup', detail: `“${list(h.nights)} ${h.state}” is older than a change already applied.` });
          } else {
            const n = st.imported.nights.filter((d) => !h.nights.includes(d));
            st.imported = { nights: h.state === 'booked' ? n.concat(h.nights) : n, seq: h.seq };
            st.seenSeq = Math.max(st.seenSeq, h.seq);
            st.lastSync = ctx.now();
            if (h.state === 'free' && h.nights.some((d) => st.sf.bookings[d])) st.sfChanged.reorderFreed = true;
            ctx.log({ op: `webhook #${h.seq}: ${list(h.nights)} ${h.state}`, status: 'ok', detail: h.state === 'booked' ? 'Blocked in our calendar.' : 'Unblocked in our calendar.' });
          }
          ctx.ack('hooks', 'importer');
        }
      }, { self: 'importer', quiet: 'all' });
      // StayFinder polls our export every 2 h.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(POLL_SLOW);
          const r = yield ctx.call('export', 'feed', {}, { timeout: 800, quiet: 'all' });
          if (r.ok) ctx.state.sf.ours = r.value.nights.slice();
        }
      }, { self: 'stayfinder', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const both = ourTaken(st).filter((d) => st.sf.bookings[d]);
      if (both.length) {
        const d = both[0];
        return { key: 'wrong', label: `${DAYS[d]} is sold twice: ${NAME[st.cal.bookings[d]]} booked it here and ${NAME[st.sf.bookings[d]]} on StayFinder. ${st.erased.includes(d) ? 'An empty feed erased the block that would have stopped it.' : st.sfChanged.reorderFreed ? 'A late “cancelled” webhook undid the newer “booked” one.' : `Our calendar learns about StayFinder bookings only at the next poll; ${st.config.fastPoll ? 'every 15 minutes still leaves a window' : 'two hours is a wide window'}.`} One guest arrives to a cabin that is taken.` };
      }
      const age = sim.now - st.lastSync;
      if (st.rejected.length) return { key: 'stale', label: `StayFinder’s feed was rejected ${st.rejected.length} time${st.rejected.length > 1 ? 's' : ''} (${st.rejected[st.rejected.length - 1]}). Our calendar keeps the last good copy, now ${ago(age)} old, and Lena is warned. Nothing is sold twice, but a real change on StayFinder would wait too.` };
      if (age > 2 * POLL_SLOW) return { key: 'stale', label: `Our calendar last synced from StayFinder ${ago(age)} ago. ${sfTaken(st).filter((d) => !st.imported.nights.includes(d)).length ? 'Omar’s Dec 31 is not on it, so it could be sold again here. ' : ''}Lena’s console shows the warning.` };
      const missing = sfTaken(st).filter((d) => !st.imported.nights.includes(d));
      if (missing.length) return { key: 'stale', label: `${list(missing)} is booked on StayFinder and not yet blocked here (${ago(sim.now - (st.sfChanged[missing[0]] || sim.now))} so far). Anyone can still book it on this site.` };
      const extra = st.imported.nights.filter((d) => !st.sf.bookings[d]);
      if (extra.length) return { key: 'stale', label: `${list(extra)} is blocked here though StayFinder has it free: nobody can book it on this site until the next sync.` };
      if (!sfTaken(st).length && !ourTaken(st).length) return { key: 'ok', label: 'Book on either phone to start.' };
      return { key: 'ok', label: `Both calendars agree: ${[...ourTaken(st).map((d) => `${DAYS[d]} booked here`), ...sfTaken(st).map((d) => `${DAYS[d]} booked on StayFinder and blocked here`)].join(', ')}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const both = ourTaken(st).filter((d) => st.sf.bookings[d]).length;
      const missing = sfTaken(st).filter((d) => !st.imported.nights.includes(d));
      return [
        { label: 'Last sync', value: `${ago(sim.now - st.lastSync)} ago`, tone: sim.now - st.lastSync > 2 * POLL_SLOW ? 'warn' : '' },
        { label: 'Window open for', value: missing.length ? ago(sim.now - (st.sfChanged[missing[0]] || sim.now)) : '–', tone: missing.length ? 'warn' : '' },
        { label: 'Imported blocks', value: st.imported.nights.length },
        { label: 'Nights sold twice', value: both, tone: both ? 'fail' : 'ok' },
        { label: 'Webhooks applied', value: st.stats.hooks - st.stats.ignored },
        { label: 'Webhooks ignored (old)', value: st.stats.ignored },
        { label: 'Feeds rejected', value: st.rejected.length },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['omar', 'Omar’s phone']], {
          note: 'Maya uses this site, Omar uses StayFinder. Lena’s console below shows both calendars side by side.',
          below: '<div class="ops-console" data-ref="lena"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const um = sim.ui.maya;
        const uo = sim.ui.omar;
        const ours = (d) => (st.cal.bookings[d] ? 'unavailable' : st.imported.nights.includes(d) ? 'unavailable' : 'available');
        const theirs = (d) => (st.sf.bookings[d] || st.sf.ours.includes(d) ? 'unavailable' : 'available');
        const row = (d, v) => `<div class="ops-row" data-tone="${v === 'unavailable' ? 'warn' : ''}"><div class="ops-name">${DAYS[d]}<span>${v}</span></div></div>`;
        let ms = Y.btn('book', 'Reserve Dec 30 – Jan 2', { cls: 'go', disabled: um.busy || um.stage === 'booked' });
        if (um.stage === 'working') ms = '<div class="app-card is-work"><strong><span class="spinner"></span>Reserving…</strong></div>';
        if (um.stage === 'booked') ms = '<div class="app-card is-ok"><strong>✓ Booked Dec 30 – Jan 2</strong><span class="app-sub">Lakeside cabin</span></div>';
        Y.paint(el, sim, 'maya', {
          head: '<div><p class="app-title">Lakeside cabin</p><p class="app-sub">Maya · this site · 3 nights</p></div>',
          nights: `<div class="ops-shards">${MAYA.map((d) => row(d, ours(d))).join('')}</div>`,
          stage: ms, msg: Y.msg(um.message, um.tone),
        }, {});
        const booked = st.sf.bookings[2] === 'omar';
        Y.paint(el, sim, 'omar', {
          head: '<div><p class="app-title">StayFinder</p><p class="app-sub">Lakeside cabin · Omar · New Year’s Eve</p></div>',
          nights: `<div class="ops-shards">${OMAR.map((d) => row(d, theirs(d))).join('')}</div>`,
          stage: booked ? `<div class="app-card is-ok"><strong>✓ Booked Dec 31</strong><span class="app-sub">StayFinder</span></div>${Y.btn('omar', 'Cancel', { arg: { kind: 'cancel' }, cls: 'secondary' })}` : Y.btn('omar', 'Book Dec 31', { arg: { kind: 'book' }, cls: 'go' }),
          msg: Y.msg(uo.message, uo.tone),
        }, {});
        const cell = (d) => {
          const here = st.cal.bookings[d];
          const sf = st.sf.bookings[d];
          const imp = st.imported.nights.includes(d);
          const tone = here && sf ? 'fail' : sf && !imp ? 'warn' : '';
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name">${DAYS[d]}<span>${here ? `${here && sf ? '✕ ' : ''}booked here (${NAME[here]})` : imp ? 'blocked from StayFinder' : 'free'} · StayFinder: ${sf ? `booked (${NAME[sf]})` : st.sf.ours.includes(d) ? 'blocked from here' : 'free'}</span></div></div>`;
        };
        const age = sim.now - st.lastSync;
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="lena"]'), {
          title: `<p class="ops-title">Lena’s calendars · Lakeside cabin · ${st.config.push ? 'webhooks + ' : ''}polling every ${st.config.fastPoll ? '15 min' : '2 h'}</p>`,
          banner: age > 2 * POLL_SLOW ? Y.msg(`StayFinder sync is ${ago(age)} behind. Check the connection.`, 'fail') : '',
          grid: `<div class="ops-shards">${[1, 2, 3].map(cell).join('')}</div>`,
          sync: `<p class="app-sub">Last synced from StayFinder: <span data-live="age"></span> ago · next poll in <span data-live="next"></span></p><div class="app-row">${Y.btn('sync', 'Sync now', { cls: 'secondary' })}</div>${Y.msg(sim.ui.lena.message, '')}`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, { age: ago(age), next: sim.nodes.importer.modes.paused ? 'paused' : ago(Math.max(0, st.nextPoll - sim.now)) });
      },
    },
  };

  /** StayFinder pushes one webhook per change (subject to the webhook queue's faults). */
  function hook(ctx, nights, state) {
    const st = ctx.state;
    const ev = { eventId: `h-${++st.seq.ev}`, type: 'calendar.changed', payload: { seq: st.sf.seq, nights: nights.slice(), state } };
    if (ctx.mode('lose', 'hooks')) {
      ctx.sim.restore('hooks', 'lose');
      st.stats.lost++;
      ctx.log({ op: `webhook #${st.sf.seq} lost`, status: 'lost', detail: 'StayFinder sent it; it never reached our queue. Only the next poll will bring this change.' });
      return;
    }
    if (ctx.mode('reorder', 'hooks') && !st.holding) {
      st.holding = true;
      ctx.log({ op: `webhook #${st.sf.seq} delayed`, status: 'fault', detail: 'It will arrive after the next one.' });
      ctx.spawn(function* (c) { yield c.wait(700); c.sim.enqueue('hooks', ev); c.state.holding = false; }, { self: 'stayfinder', quiet: true });
      return;
    }
    ctx.sim.enqueue('hooks', ev);
  }
})(typeof window !== 'undefined' ? window : globalThis);
