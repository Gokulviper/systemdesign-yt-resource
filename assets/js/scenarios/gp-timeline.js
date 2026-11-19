/*
 * A large timeline.
 * The library is shown newest first by capture time, a page at a time. The
 * page boundary must be a cursor (the last item's sort key), not an offset,
 * or a delete on another device shifts everything and photos are skipped; the
 * cursor needs a tie-breaker (the item id), or a burst of shots taken in the
 * same second is cut in half at a page boundary. The month scrubber reads
 * precomputed counts that a summary job keeps up to date. Thumbnails come
 * from a shared cache; when it is flushed, concurrent misses for the same tile
 * must be coalesced or the whole region stampedes the thumbnail service.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const p99of = (a) => SDL.percentile(a.slice().sort((x, y) => x - y), 99);

  const PAGE = 12;
  const HOT = 100;            // popular tiles other viewers in the region keep asking for
  const REGION_PER_TICK = 4;  // requests per 10 ms (400/s)
  const SUM_MS = 300;         // summary job interval
  const TODAY = '2026-11-13';
  const BURST_T = '2026-11-12 18:04:31';
  const pad = (n) => String(n).padStart(2, '0');

  function library() {
    const items = {};
    const add = (id, name, taken, glyph, hue, uploaded) => { items[id] = { id, name, taken, uploaded: uploaded || taken, glyph, hue, state: 'active' }; };
    for (let i = 1; i <= 6; i++) add(`n${i}`, `Screenshot ${i}`, `${TODAY} 08:${pad(i)}:00`, '📱', 220);
    for (let i = 1; i <= 10; i++) add(`k${pad(i)}`, `Burst ${i}`, BURST_T, '🏃', 15);
    add('m1', 'Birthday cake', '2026-11-10 19:30:00', '🎂', 330);
    add('m2', 'Birthday candles', '2026-11-10 19:28:00', '🕯', 40);
    for (let i = 1; i <= 12; i++) add(`o${pad(i)}`, `Autumn walk ${i}`, `2026-10-${pad(30 - i)} 15:00:00`, '🍂', 30);
    for (let i = 1; i <= 10; i++) add(`s${pad(i)}`, `Beach ${i}`, `2026-09-${pad(28 - i)} 11:00:00`, '🏖', 200);
    for (let i = 1; i <= 40; i++) add(`r${pad(i)}`, `Lisbon ${i}`, `2026-03-${pad(1 + Math.floor((i - 1) / 2))} ${pad(10 + (i % 8))}:00:00`, '🏞', 160);
    add('g1', 'Grandma’s garden (scan)', '2009-07-04 12:00:00', '🌻', 60, `${TODAY} 09:00:00`);
    return items;
  }
  const IMPORT = Array.from({ length: 12 }, (_, i) => ({ id: `x${pad(i + 1)}`, name: `Old phone ${i + 1}`, taken: `2026-03-${pad(20 + Math.floor(i / 2))} 09:${pad(i)}:00`, glyph: '📷', hue: 100 }));

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthName = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  const keyOf = (st, it) => (st.config.sortByTaken ? it.taken || it.uploaded : it.uploaded);
  const cmpDesc = (a, b) => (a.k < b.k ? 1 : a.k > b.k ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  function sorted(st) {
    return Object.values(st.items).filter((it) => it.state === 'active').map((it) => ({ id: it.id, k: keyOf(st, it) })).sort(cmpDesc);
  }
  function counts(st) {
    const c = {};
    for (const it of Object.values(st.items)) if (it.state === 'active') { const m = (it.taken || it.uploaded).slice(0, 7); c[m] = (c[m] || 0) + 1; }
    return c;
  }

  function open(sim) {
    sim.startAction('Laptop: open the timeline', function* (ctx) {
      const ui = ctx.ui.laptop;
      Object.assign(ui, { shown: [], keys: {}, cursor: null, offset: 0, done: false, tiles: {}, scrub: null, pages: 0 });
      const s = yield ctx.call('gateway', 'summary', {}, { timeout: 1500 });
      if (s.ok) ui.scrub = s.value;
      const ok = yield* page(ctx);
      if (!ok) return;
      Y.L(ctx, { displayed: ['yes', `First ${ui.shown.length} photos and the month scrubber.`], committed: ['n/a', 'Read only.'] });
    }, { self: 'laptop' });
  }
  function scroll(sim, all) {
    sim.startAction(all ? 'Laptop: scroll to the end' : 'Laptop: scroll down', function* (ctx) {
      const ui = ctx.ui.laptop;
      if (!ui.pages) { Y.failed(ctx, 'NOT_OPEN'); return; }
      let n = 0;
      do {
        if (ui.done) break;
        const ok = yield* page(ctx);
        if (!ok) return;
        n++;
        if (all) yield ctx.wait(120);
      } while (all);
      const s = yield ctx.call('gateway', 'summary', {}, { timeout: 1500 });
      if (s.ok) ui.scrub = s.value;
      Y.L(ctx, { displayed: ['yes', `${n} more page${n === 1 ? '' : 's'}; ${ui.shown.length} photos shown${ui.done ? ', end of library' : ''}.`], committed: ['n/a', 'Read only.'] });
    }, { self: 'laptop' });
  }
  function* page(ctx) {
    const ui = ctx.ui.laptop;
    const st = ctx.state;
    const req = st.config.cursor ? { cursor: ui.cursor, limit: PAGE } : { offset: ui.offset, limit: PAGE };
    const r = yield ctx.call('gateway', 'page', req, { timeout: 1500 });
    if (!r.ok) { Y.failed(ctx, r.error.code); return false; }
    ui.pages++;
    for (const x of r.value.items) {
      if (ui.shown.includes(x.id)) st.stats.repeats++;
      ui.shown.push(x.id);
      ui.keys[x.id] = x.k;
    }
    ui.cursor = r.value.cursor;
    ui.offset += r.value.items.length;
    ui.done = r.value.items.length < PAGE;
    // Tiles for this page, fetched in parallel.
    const t0 = ctx.now();
    const procs = r.value.items.map((x) => ctx.spawn(function* (c) {
      ui.tiles[x.id] = 'wait';
      const g = yield c.call('thumbcache', 'get', { key: x.id, who: 'maya' }, { timeout: 5000, quiet: 'all' });
      ui.tiles[x.id] = g.ok ? 'ok' : 'fail';
      st.stats.tileMs.push(c.now() - t0);
    }, { quiet: 'all' }));
    yield ctx.join(procs);
    const slow = Math.max(0, ...r.value.items.map(() => ctx.now() - t0));
    if (slow > 1000) ctx.log({ op: `page ${ui.pages}: tiles took ${SDL.fmtMs(slow)}`, status: 'warn', detail: `The thumbnail service has ${ctx.sim.queueWait('thumbs') ? `${SDL.fmtMs(ctx.sim.queueWait('thumbs'))} of queue` : 'a backlog'}.` });
    return true;
  }
  function removeScreens(sim) {
    sim.startAction('Phone: delete 6 screenshots', function* (ctx) {
      const r = yield ctx.call('gateway', 'delete', { ids: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'] }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { displayed: ['yes', 'Gone from the phone.'], committed: ['yes', '6 items deleted.'], async: ['n/a', 'Other devices pick it up on their next request.'] });
      ctx.explain(ctx.state.config.cursor ? 'The laptop’s next page starts after the last photo it showed, so the deletes cannot move it.' : 'Every photo after the screenshots has moved up six places. The laptop asks for “the next 12 starting at 12”, which now starts six photos later than it should.');
    }, { self: 'phone' });
  }
  function importOld(sim) {
    sim.startAction('Phone: back up 12 photos from March', function* (ctx) {
      const noExif = !!ctx.mode('noExif', 'phone');
      const items = IMPORT.map((x) => Object.assign({}, x, noExif ? { taken: null } : {}));
      const r = yield ctx.call('gateway', 'insert', { items }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { displayed: ['yes', 'Backed up.'], committed: ['yes', `${r.value.n} items in the index.`], async: [ctx.sim.nodes.sumjob.modes.paused ? 'pending' : 'pending', 'Month counts updated by the summary job.'] });
      if (noExif) ctx.explain('These files carry no capture time, so the library files them under the upload time and marks the date as estimated.');
    }, { self: 'phone' });
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'laptop', quiet: 'all' });

  const sc = (SDL.scenarios['gp-timeline'] = {
    id: 'gp-timeline',
    seed: 2309,
    minHopMs: 5,
    productWidth: 760,
    intro: `Maya’s timeline, newest first, ${PAGE} photos a page (a real library has tens of thousands; this one has 81 so you can see every one). Scroll it on the laptop while the phone deletes and backs up, page through a burst of ten shots taken in the same second, and flush the thumbnail cache while the region is busy.`,
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'laptop', label: 'Maya’s laptop', sub: 'Timeline + scrubber', kind: 'client', x: 90, y: 160, latency: 1, role: 'Scrolls the timeline a page at a time and fetches each page’s thumbnails.', owns: ['The cursor or offset of the last page'] },
        { id: 'phone', label: 'Maya’s phone', sub: 'Deletes, backs up', kind: 'client', x: 90, y: 440, latency: 1, role: 'Changes the library while the laptop scrolls.', owns: ['Nothing durable'] },
        { id: 'gateway', label: 'Edge', sub: 'Auth, routing', kind: 'gateway', x: 260, y: 300, latency: 3, role: 'Routes requests.', owns: ['Nothing durable'] },
        { id: 'library', label: 'Library service', sub: 'Pages, summaries', kind: 'service', x: 440, y: 300, latency: 3, role: 'Answers “the next page after this cursor” and the month counts for the scrubber.', ops: [{ name: 'page', desc: 'One page.' }, { name: 'summary', desc: 'Month counts.' }], owns: ['Nothing durable'] },
        { id: 'metaidx', label: 'Metadata index', sub: '(user, taken, id)', kind: 'db', x: 640, y: 300, latency: 4, role: 'Items sorted by (user, capture time, id), newest first. A page is a range scan from the cursor.', ops: [{ name: 'page', desc: 'Range scan.' }, { name: 'write', desc: 'Insert or delete.' }], owns: ['items'] },
        { id: 'sumjob', label: 'Summary job', sub: `every ${SUM_MS} ms`, kind: 'worker', x: 640, y: 500, latency: 2, role: 'Recounts photos per month for libraries that changed, and writes the counts the scrubber reads.', owns: ['Nothing durable'] },
        { id: 'summaries', label: 'Month summaries', sub: 'Counts per month', kind: 'cache', x: 440, y: 500, latency: 2, role: 'Precomputed photos per month. Counting tens of thousands of rows on every open would be far too slow.', ops: [{ name: 'get', desc: 'Read counts.' }, { name: 'put', desc: 'Write counts.' }], owns: ['count[user][month]'] },
        { id: 'thumbcache', label: 'Thumbnail cache', sub: 'Shared by the region', kind: 'cache', x: 440, y: 110, latency: 2, role: 'Rendered thumbnails. On a miss it asks the thumbnail service; with coalescing, concurrent misses for the same tile wait for one render.', ops: [{ name: 'get', desc: 'A thumbnail.' }], owns: ['tiles'] },
        { id: 'thumbs', label: 'Thumbnail service', sub: '4 × 40 ms', kind: 'worker', x: 840, y: 110, latency: 3, serviceMs: 40, servers: 4, role: 'Renders a thumbnail from the original. About 100 a second here.', ops: [{ name: 'render', desc: 'Render one tile.' }], owns: ['Nothing durable'] },
        { id: 'region', label: 'Other viewers', sub: '400 tiles/s', kind: 'client', x: 260, y: 40, latency: 1, role: 'Everyone else nearby, mostly viewing a popular shared album: about 400 tile requests a second over 100 tiles.', owns: ['Nothing durable'] },
      ],
      edges: [
        { from: 'laptop', to: 'gateway', latency: 20 },
        { from: 'phone', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'library', latency: 3 },
        { from: 'library', to: 'metaidx', latency: 3 },
        { from: 'library', to: 'summaries', latency: 2 },
        { from: 'sumjob', to: 'metaidx', latency: 2 },
        { from: 'sumjob', to: 'summaries', latency: 2 },
        { from: 'laptop', to: 'thumbcache', latency: 15 },
        { from: 'region', to: 'thumbcache', latency: 10 },
        { from: 'thumbcache', to: 'thumbs', latency: 3 },
      ],
    },
    modeLabels: { flushed: 'Flushed', noExif: 'No capture time' },
    failures: [
      { id: 'thumbs-slow', node: 'thumbs', mode: 'slow', params: { factor: 5 }, label: 'Thumbnail service slow', desc: 'Each render takes five times as long; only misses feel it.' },
      { id: 'cache-flush', node: 'thumbcache', mode: 'flushed', label: 'Thumbnail cache flushed', desc: 'Every cached tile is gone at once, as after a bad deploy or a restart.', duration: 200 },
      { id: 'cache-down', node: 'thumbcache', mode: 'down', label: 'Thumbnail cache down', desc: 'Tiles fail and show placeholders; the timeline itself still pages.' },
      { id: 'summary-lag', node: 'sumjob', mode: 'paused', label: 'Month summaries lag', desc: 'The summary job stops; the scrubber keeps showing old counts.' },
      { id: 'no-exif', node: 'phone', mode: 'noExif', label: 'Missing capture time', desc: 'Photos backed up from the phone carry no capture time while this is on.' },
      { id: 'index-slow', node: 'metaidx', mode: 'slow', params: { factor: 20 }, label: 'Metadata index slow', desc: 'Every page waits.' },
    ],
    switches: Y.switches([
      ['sortByTaken', 'Sort by capture time', 'The timeline is ordered by when a photo was taken. Off: by when it was uploaded.'],
      ['cursor', 'Page with a cursor', 'The next page starts after the last item shown. Off: “skip the first N”.'],
      ['tiebreak', 'Cursor includes the item id', 'Items with the same time are ordered by id, and the cursor remembers both. Off: the cursor is the time alone.'],
      ['coalesce', 'Coalesce concurrent misses', 'While one render of a tile is in flight, other requests for it wait for that render. Off: every miss renders.'],
    ]),
    presets: Y.presets({ sortByTaken: true, cursor: true, tiebreak: true, coalesce: true }, [
      { id: 'scroll-by-taken', label: 'Scroll the whole timeline', desc: `Open the timeline and scroll to the end: ${81} photos in capture order, each exactly once. The 2009 scan sits at the bottom.`, run: (s) => { open(s); later(s, 800, (x) => scroll(x, true)); } },
      { id: 'sort-by-upload', label: 'Sorted by upload time', desc: 'The scan of Grandma’s garden was uploaded this morning, so it tops the timeline under November 2026, though it was taken in 2009.', sw: { sortByTaken: false }, run: (s) => { open(s); later(s, 800, (x) => scroll(x, true)); } },
      { id: 'offset-with-deletes', label: 'Offset paging while the phone deletes', desc: 'The laptop shows page 1. The phone deletes the six screenshots on it. The laptop asks for “12 starting at 12”, and six photos that moved up are never shown.', sw: { cursor: false }, run: (s) => { open(s); later(s, 700, removeScreens); later(s, 1300, (x) => scroll(x, true)); } },
      { id: 'cursor', label: 'Cursor paging while the phone deletes', desc: 'Same deletes. The next page starts after the last photo shown, so nothing is skipped.', run: (s) => { open(s); later(s, 700, removeScreens); later(s, 1300, (x) => scroll(x, true)); } },
      { id: 'burst-no-tiebreak', label: 'Burst across a page, cursor on time only', desc: 'Ten burst shots share one second; page 1 ends after six of them. “Older than 18:04:31” skips the other four.', sw: { tiebreak: false }, run: (s) => { open(s); later(s, 800, (x) => scroll(x, true)); } },
      { id: 'burst-tiebreak', label: 'Burst across a page, cursor with id', desc: 'The cursor is (time, id), so page 2 starts with the seventh burst shot.', run: (s) => { open(s); later(s, 800, (x) => scroll(x, true)); } },
      { id: 'summary-lag', label: 'Back up 12 photos, summaries lag', desc: 'The phone backs up 12 March photos while the summary job is stopped. The timeline shows 52 March photos; the scrubber still says 40.', run: (s) => { s.inject('sumjob', 'paused'); importOld(s); later(s, 1000, open); later(s, 1600, (x) => scroll(x, true)); } },
      { id: 'cold-cache-stampede', label: 'Cache flushed, no coalescing', desc: 'The cache is flushed while the region asks for 400 tiles a second. Every request for a missing tile renders it again, the thumbnail service queues, and Maya’s tiles take seconds.', sw: { coalesce: false }, run: (s) => { later(s, 500, (x) => x.inject('thumbcache', 'flushed', {}, 200)); later(s, 1200, open); later(s, 2000, (x) => scroll(x, true)); } },
      { id: 'coalesced', label: 'Cache flushed, misses coalesced', desc: 'Same flush. Each missing tile is rendered once and everyone asking for it waits for that render; the service clears the 100 popular tiles in about a second.', run: (s) => { later(s, 500, (x) => x.inject('thumbcache', 'flushed', {}, 200)); later(s, 1200, open); later(s, 2000, (x) => scroll(x, true)); } },
    ]),
    initialState: () => {
      const items = library();
      const tc = {};
      for (let i = 0; i < HOT; i++) tc[`c${i}`] = true;
      const st = {
        config: { sortByTaken: true, cursor: true, tiebreak: true, coalesce: true },
        items, sums: null, tc, inflight: {},
        stats: { repeats: 0, renders: 0, hits: 0, misses: 0, tileMs: [], coalesced: 0, flushes: 0 },
      };
      st.sums = counts(st);
      return st;
    },
    initialUI: () => ({ laptop: { shown: [], keys: {}, cursor: null, offset: 0, done: false, tiles: {}, scrub: null, pages: 0 }, phone: {} }),
    actions: {
      open(sim) { open(sim); },
      scroll(sim) { scroll(sim, false); },
      scrollAll(sim) { scroll(sim, true); },
      remove(sim) { removeScreens(sim); },
      import(sim) { importOld(sim); },
    },
    handlers: {
      gateway: {
        page: function* (ctx, p) { return ctx.must(yield ctx.call('library', 'page', p, { timeout: 1000 })); },
        summary: function* (ctx) { return ctx.must(yield ctx.call('library', 'summary', {}, { timeout: 1000 })); },
        delete: function* (ctx, p) { return ctx.must(yield ctx.call('library', 'write', { del: p.ids }, { timeout: 1000 })); },
        insert: function* (ctx, p) { return ctx.must(yield ctx.call('library', 'write', { add: p.items }, { timeout: 1000 })); },
      },
      library: {
        page: function* (ctx, p) { return ctx.must(yield ctx.call('metaidx', 'page', p, { timeout: 800 })); },
        summary: function* (ctx) { return ctx.must(yield ctx.call('summaries', 'get', {}, { timeout: 500 })); },
        write: function* (ctx, p) { return ctx.must(yield ctx.call('metaidx', 'write', p, { timeout: 800 })); },
      },
      metaidx: {
        page(ctx, p) {
          const st = ctx.state;
          const all = sorted(st);
          let rest;
          if (p.offset != null) rest = all.slice(p.offset);
          else if (!p.cursor) rest = all;
          else if (st.config.tiebreak) rest = all.filter((x) => cmpDesc(x, p.cursor) > 0);
          else rest = all.filter((x) => x.k < p.cursor.k);
          const items = rest.slice(0, p.limit);
          const last = items[items.length - 1];
          return { items, cursor: last ? (st.config.tiebreak ? { k: last.k, id: last.id } : { k: last.k }) : p.cursor };
        },
        write(ctx, p) {
          const st = ctx.state;
          let n = 0;
          for (const id of p.del || []) if (st.items[id] && st.items[id].state === 'active') { st.items[id].state = 'deleted'; n++; }
          for (const it of p.add || []) if (!st.items[it.id]) { st.items[it.id] = Object.assign({}, it, { uploaded: `${TODAY} 10:${pad(n)}:00`, state: 'active', estimated: !it.taken }); n++; }
          st.dirty = true;
          return { n };
        },
        counts(ctx) { return counts(ctx.state); },
      },
      summaries: {
        get(ctx) { return Object.assign({}, ctx.state.sums); },
        put(ctx, p) { ctx.state.sums = p.counts; return { ok: true }; },
      },
      thumbcache: {
        get: function* (ctx, p) {
          const st = ctx.state;
          if (st.tc[p.key]) { st.stats.hits++; return { key: p.key }; }
          st.stats.misses++;
          if (st.config.coalesce && st.inflight[p.key]) {
            st.stats.coalesced++;
            while (st.inflight[p.key] && !st.tc[p.key]) yield ctx.wait(5);
            if (st.tc[p.key]) return { key: p.key };
          }
          st.inflight[p.key] = (st.inflight[p.key] || 0) + 1;
          const r = yield ctx.call('thumbs', 'render', { key: p.key }, { timeout: 8000, quiet: 'all' });
          st.inflight[p.key]--;
          if (!st.inflight[p.key]) delete st.inflight[p.key];
          ctx.must(r);
          st.tc[p.key] = true;
          return { key: p.key };
        },
      },
      thumbs: {
        render(ctx) { ctx.state.stats.renders++; return { ok: true }; },
      },
    },
    onFailureChange(sim, f) {
      if (f.node === 'thumbcache' && f.mode === 'flushed' && f.active) {
        sim.state.tc = {};
        sim.state.stats.flushes++;
      }
    },
    setup(sim) {
      // The summary job recounts libraries that changed.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(SUM_MS);
          const st = ctx.state;
          if (!ctx.alive() || !st.dirty) continue;
          st.dirty = false;
          const c = yield ctx.call('metaidx', 'counts', {}, { timeout: 800, quiet: 'all' });
          if (!c.ok) { st.dirty = true; continue; }
          const w = yield ctx.call('summaries', 'put', { counts: c.value }, { timeout: 800, quiet: 'all' });
          if (!w.ok) { st.dirty = true; continue; }
          ctx.log({ op: 'month counts updated', status: 'recovered', detail: Object.entries(c.value).sort().reverse().map(([m, n]) => `${monthName(m)} ${n}`).join(', ') });
        }
      }, { self: 'sumjob', quiet: 'all' });
      // Everyone else in the region, asking for popular tiles.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(10);
          for (let k = 0; k < REGION_PER_TICK; k++) {
            const key = `c${Math.floor(ctx.rand() * HOT)}`;
            ctx.spawn(function* (c) { yield c.call('thumbcache', 'get', { key }, { timeout: 8000, quiet: 'all' }); }, { self: 'region', quiet: 'all' });
          }
        }
      }, { self: 'region', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const ui = sim.ui.laptop;
      const live = Object.values(st.items).filter((it) => it.state === 'active');
      if (ui.pages && !st.config.sortByTaken) {
        const g = st.items.g1;
        if (ui.shown.includes('g1') && ui.keys.g1.slice(0, 7) !== g.taken.slice(0, 7)) return { key: 'wrong', label: `“${g.name}” was taken in July 2009, but the timeline files it under ${monthName(ui.keys.g1.slice(0, 7))}, at the very top, because it is sorted by upload time.` };
      }
      if (st.stats.repeats) return { key: 'wrong', label: `${st.stats.repeats} photos were shown twice.` };
      if (ui.done) {
        const missed = live.filter((it) => !ui.shown.includes(it.id));
        if (missed.length) {
          const burst = missed.every((it) => it.taken === BURST_T);
          return { key: 'wrong', label: `Scrolled to the end, but ${missed.length} photos were never shown (${missed.slice(0, 4).map((it) => it.name).join(', ')}${missed.length > 4 ? ', …' : ''}). ${burst ? 'They share a capture second with the last photo on the page, and “older than that second” skips them.' : 'Six photos before them were deleted, so they moved up into rows the laptop had already paged past.'}` };
        }
      }
      const tiles = st.stats.tileMs;
      const p99 = tiles.length ? p99of(tiles) : 0;
      if (p99 > 1000) return { key: 'stale', label: `Thumbnails were slow: p99 ${SDL.fmtMs(p99)}. After the flush every request for a missing tile rendered it again, ${st.stats.renders} renders for ${HOT} popular tiles, and Maya’s tiles queued behind them.` };
      if (ui.scrub) {
        const truth = counts(st);
        const off = Object.keys(truth).find((m) => ui.scrub[m] !== truth[m] && ui.shown.some((id) => st.items[id] && (st.items[id].taken || st.items[id].uploaded).slice(0, 7) === m));
        if (off) return { key: 'stale', label: `The scrubber says ${monthName(off)}: ${ui.scrub[off] || 0}, but the timeline has ${truth[off]}. The month summaries are behind the index ${sim.nodes.sumjob.modes.paused ? 'because the summary job is stopped' : 'until the summary job next runs'}.` };
      }
      const est = live.filter((it) => it.estimated);
      if (est.length) return { key: 'stale', label: `${est.length} photos have no capture time, so they are filed under the day they were uploaded and marked “date estimated” until Maya sets the date.` };
      if (ui.done) return { key: 'ok', label: `All ${ui.shown.filter((id) => st.items[id].state === 'active').length} photos shown once each, in capture order${st.stats.flushes ? `; after the flush ${st.stats.renders} renders refilled the cache` : ''}.` };
      if (ui.pages) return { key: 'ok', label: `${ui.shown.length} photos shown so far, in capture order.` };
      return { key: 'ok', label: 'The timeline is ready.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const ui = sim.ui.laptop;
      const live = Object.values(st.items).filter((it) => it.state === 'active');
      const skips = ui.done ? live.filter((it) => !ui.shown.includes(it.id)).length : 0;
      const total = st.stats.hits + st.stats.misses;
      const tiles = st.stats.tileMs;
      return [
        { label: 'Photos shown / in library', value: `${ui.shown.filter((id) => st.items[id].state === 'active').length} / ${live.length}` },
        { label: 'Skipped', value: skips, tone: skips ? 'fail' : '' },
        { label: 'Repeats', value: st.stats.repeats, tone: st.stats.repeats ? 'fail' : '' },
        { label: 'Thumbnail hit ratio', value: total ? `${Math.round((st.stats.hits / total) * 100)}%` : '–' },
        { label: 'Renders', value: st.stats.renders },
        { label: 'Coalesced misses', value: st.stats.coalesced },
        { label: 'Tile p99', value: tiles.length ? SDL.fmtMs(p99of(tiles)) : '–', tone: tiles.length && p99of(tiles) > 1000 ? 'warn' : '' },
        { label: 'Thumbnail queue', value: SDL.fmtMs(sim.queueWait('thumbs')) },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['laptop', 'Maya’s laptop (web)'], ['phone', 'Maya’s phone']], {
          note: 'Open the timeline on the laptop and scroll. The phone deletes and backs up photos while you do.',
          below: '<div class="ops-console" data-ref="status"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const ui = sim.ui.laptop;
        const groups = [];
        for (const id of ui.shown) {
          const m = ui.keys[id].slice(0, 7);
          if (!groups.length || groups[groups.length - 1].m !== m) groups.push({ m, ids: [] });
          groups[groups.length - 1].ids.push(id);
        }
        const tile = (id) => { const it = st.items[id]; const t = ui.tiles[id]; return `<div class="yt-thumb" title="${esc(it.name)}" style="--h:${it.hue};aspect-ratio:1;font-size:12px;${t === 'ok' ? '' : 'opacity:.35'}${it.state === 'deleted' ? ';outline:1px dashed var(--fail)' : ''}"><span aria-hidden="true">${t === 'fail' ? '✕' : t === 'ok' ? it.glyph : '…'}</span></div>`; };
        const tl = groups.map((g) => `<p class="app-sub" style="margin:6px 0 3px"><strong>${esc(monthName(g.m))}</strong> · ${g.ids.length}${g.ids.some((id) => st.items[id].estimated) ? ' · some dates estimated' : ''}</p><div style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:3px">${g.ids.map(tile).join('')}</div>`).join('');
        const scrub = ui.scrub ? Object.entries(ui.scrub).sort().reverse().map(([m, n]) => `<span class="app-sub" style="display:inline-block;margin-right:8px">${esc(monthName(m).replace(/ 20/, ' ’'))}: ${n}</span>`).join('') : '';
        Y.paint(el, sim, 'laptop', {
          head: `<div><p class="app-title">Photos</p><p class="app-sub">${ui.pages ? `${ui.shown.length} shown · page ${ui.pages}${ui.done ? ' · end' : ''}` : 'Timeline'}</p></div>`,
          ctl: `<div class="app-row" style="flex-wrap:wrap">${Y.btn('open', ui.pages ? 'Reopen' : 'Open timeline')}${Y.btn('scroll', 'Scroll', { cls: 'secondary', disabled: !ui.pages || ui.done })}${Y.btn('scrollAll', 'Scroll to the end', { cls: 'secondary', disabled: !ui.pages || ui.done })}</div>`,
          missed: (() => { if (!ui.done) return ''; const m = Object.values(st.items).filter((it) => it.state === 'active' && !ui.shown.includes(it.id)); return m.length ? `<div class="app-card is-fail"><strong>✕ ${m.length} photos never shown</strong><span class="app-sub">${esc(m.map((it) => it.name).join(', '))}</span></div>` : ''; })(),
          scrub: scrub ? `<div class="app-card"><span class="app-sub">Scrubber</span><div>${scrub}</div></div>` : '',
          tl: `<div style="max-height:300px;overflow-y:auto">${tl}</div>`,
        }, {});
        const del = st.items.n1.state === 'deleted';
        const imp = !!st.items.x01;
        Y.paint(el, sim, 'phone', {
          head: `<div><p class="app-title">Photos</p><p class="app-sub">${Object.values(st.items).filter((it) => it.state === 'active').length} in the library</p></div>`,
          ctl: `<div class="app-row" style="flex-wrap:wrap">${Y.btn('remove', 'Delete 6 screenshots', { cls: 'secondary', disabled: del })}${Y.btn('import', 'Back up 12 March photos', { cls: 'secondary', disabled: imp })}</div>`,
          body: `${del ? '<div class="app-card is-ok"><strong>✓ 6 screenshots deleted</strong></div>' : ''}${imp ? `<div class="app-card is-ok"><strong>✓ 12 photos backed up</strong><span class="app-sub">${st.items.x01.estimated ? 'No capture time: filed by upload date' : 'March 2026'}</span></div>` : ''}`,
        }, {});
        const c = sim.scenario.consistency(sim);
        const truth = counts(st);
        const lag = Object.keys(truth).some((m) => (st.sums[m] || 0) !== truth[m]);
        const rows = `<div class="ops-shards">
          <div class="ops-row"><div class="ops-name">Paging<span>${st.config.cursor ? `cursor ${ui.cursor ? `${esc(ui.cursor.k)}${ui.cursor.id ? ` · ${esc(ui.cursor.id)}` : ''}` : '(start)'}` : `offset ${ui.offset}`}</span></div></div>
          <div class="ops-row" data-tone="${lag ? 'warn' : ''}"><div class="ops-name">Month summaries<span>${lag ? 'behind the index' : 'up to date'}</span></div></div>
          <div class="ops-row" data-tone="${sim.queueWait('thumbs') > 500 ? 'warn' : ''}"><div class="ops-name">Thumbnails<span>${Object.keys(st.tc).length} cached · ${st.stats.renders} renders · queue ${SDL.fmtMs(sim.queueWait('thumbs'))}</span></div></div></div>`;
        SDL.ui.paintSections(el.querySelector('[data-ref="status"]'), { rows, recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>` }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
