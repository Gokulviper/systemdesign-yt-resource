/*
 * Labels, faces, and reindexing.
 * Search runs over labels a model produces asynchronously after upload. A new
 * model means relabelling the whole library into a new index and switching an
 * alias to it. Fresh uploads need their own lane or they wait behind the
 * backfill; photos uploaded during the backfill must be written to both
 * indexes or the swap loses them; deletes during the backfill must reach both
 * indexes too. Turning face grouping off must delete the embeddings, not just
 * hide them.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const LIB = 60;
  const LABEL_MS = 60;
  const POOL = [['beach', 200, '🏖'], ['food', 45, '🍜'], ['lake', 160, '🏞'], ['city', 260, '🌃'], ['party', 330, '🎂'], ['market', 95, '🛍']];
  const NEW = { id: 'n1', name: 'Dog on the beach', labels: ['dog', 'beach'], hue: 30, glyph: '🐕', face: false };

  function libItems() {
    const items = {};
    for (let i = 1; i <= LIB; i++) {
      const [label, hue, glyph] = POOL[(i - 1) % POOL.length];
      items[`b${i}`] = { id: `b${i}`, name: i === 1 ? 'Old beach photo' : `${label[0].toUpperCase()}${label.slice(1)} #${Math.ceil(i / POOL.length)}`, labels: [label], hue, glyph, face: i % 3 === 0, state: 'active' };
    }
    return items;
  }

  function take(sim) {
    sim.startAction('Phone: take “Dog on the beach”', function* (ctx) {
      const r = yield ctx.call('gateway', 'upload', { item: NEW }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { displayed: ['yes', 'In the library at once.'], committed: ['yes', 'Item written; labelling task queued.'], async: ['pending', 'Searchable once labelled.'] });
      ctx.explain(`The photo is in the library. Search will find it once the labeller has run, ${ctx.state.config.freshLane ? 'from the fresh lane, which goes ahead of any backfill' : 'from the one shared queue, behind whatever is already in it'}.`);
    }, { self: 'phone' });
  }
  function remove(sim, id) {
    sim.startAction(`Phone: delete “${sim.state.items[id].name}”`, function* (ctx) {
      const r = yield ctx.call('gateway', 'delete', { id }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { displayed: ['yes', 'Gone from the library.'], committed: ['yes', `Removed from ${r.value.from.join(' and ')}.`] });
    }, { self: 'phone' });
  }
  function search(sim, q) {
    sim.ui.laptop.query = q;
    sim.startAction(`Laptop: search “${q}”`, function* (ctx) {
      const r = yield ctx.call('gateway', 'search', { q }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); ctx.ui.laptop.results = null; return; }
      ctx.ui.laptop.results = r.value.ids;
      ctx.ui.laptop.index = r.value.index;
      Y.L(ctx, { displayed: ['yes', `${r.value.ids.length} results from index ${r.value.index}.`], committed: ['n/a', 'Read only.'] });
    }, { self: 'laptop' });
  }
  function backfill(sim) {
    const st = sim.state;
    if (st.bf) return;
    sim.startAction('Ops: relabel the library with model v2', function* (ctx) {
      const s = ctx.state;
      const ids = Object.keys(s.items).filter((id) => s.items[id].state === 'active');
      s.bf = { total: ids.length, done: 0, started: ctx.now(), swappedAt: null };
      for (const id of ids) ctx.sim.enqueue('backfill', { type: 'relabel', eventId: `bf-${id}`, payload: { id, backfill: true }, actionId: ctx.actionId });
      Y.L(ctx, { displayed: ['n/a', 'Background job.'], committed: ['yes', `${ids.length} relabel tasks queued (a snapshot of the library).`], async: ['pending', 'Swap the alias to v2 when every task is done.'] });
      ctx.explain(`${ids.length} relabel tasks, one per photo in the library right now. Photos added after this moment are not in the list${s.config.dualWrite ? '; dual writes put them in v2 as they arrive' : ', and nothing else will put them in v2'}.`);
    }, { self: 'backfill' });
  }
  function faces(sim, on) {
    sim.startAction(`Phone: turn face grouping ${on ? 'on' : 'off'}`, function* (ctx) {
      const r = yield ctx.call('gateway', 'faces', { on }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { displayed: ['yes', `People ${on ? 'shown' : 'hidden'}.`], committed: ['yes', on ? 'Setting on.' : r.value.purged ? `Setting off; ${r.value.purged} embeddings deleted.` : 'Setting off; embeddings kept.'] });
    }, { self: 'phone' });
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'phone', quiet: 'all' });
  const live = (st) => (st.alias === 'v1' ? 'idx1' : 'idx2');

  const sc = (SDL.scenarios['gp-search'] = {
    id: 'gp-search',
    seed: 2111,
    minHopMs: 5,
    productWidth: 760,
    intro: `Maya’s library has ${LIB} photos indexed by model v1. Take a new photo and search for it; start relabelling everything with model v2 and see what happens to fresh uploads, to photos added during the backfill, and to a photo deleted while it runs. Then turn face grouping off.`,
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'phone', label: 'Maya’s phone', sub: 'Camera + People', kind: 'client', x: 90, y: 150, latency: 1, role: 'Uploads, deletes, and controls face grouping.', owns: ['Nothing durable'] },
        { id: 'laptop', label: 'Maya’s laptop', sub: 'Search', kind: 'client', x: 90, y: 450, latency: 1, role: 'Searches her own library.', owns: ['Nothing durable'] },
        { id: 'gateway', label: 'Edge', sub: 'Auth, routing', kind: 'gateway', x: 270, y: 300, latency: 3, role: 'Routes requests.', owns: ['Nothing durable'] },
        { id: 'search', label: 'Search service', sub: 'Alias → index', kind: 'service', x: 430, y: 450, latency: 3, role: 'Queries the index the alias points at, only within the owner’s library. Swapping the alias is how a new index goes live.', ops: [{ name: 'query', desc: 'Search.' }, { name: 'swap', desc: 'Point the alias at v2.' }], owns: ['alias'] },
        { id: 'metadb', label: 'Metadata store', sub: 'Items + settings', kind: 'db', x: 430, y: 150, latency: 5, role: 'Library items and settings. A new item enqueues a labelling task in the same transaction.', ops: [{ name: 'insert', desc: 'New item + task.' }, { name: 'delete', desc: 'Remove an item.' }], owns: ['items', 'face setting'] },
        { id: 'freshq', label: 'Fresh lane', sub: 'New uploads', kind: 'queue', x: 620, y: 90, latency: 2, queue: 'fresh', role: 'Labelling tasks for new uploads. The labeller always takes from here first.', owns: ['tasks'] },
        { id: 'bfq', label: 'Backfill queue', sub: 'Relabel tasks', kind: 'queue', x: 620, y: 250, latency: 2, queue: 'backfill', role: 'Relabel tasks for the whole library. Without a fresh lane, new uploads join the back of this queue.', owns: ['tasks'] },
        { id: 'labeler', label: 'Labeller', sub: `${Math.round(1000 / LABEL_MS)} images/s`, kind: 'worker', x: 800, y: 170, latency: 2, role: 'Runs the image model and writes labels (and face embeddings, if grouping is on) to the index. One image at a time here.', owns: ['Model weights'] },
        { id: 'backfill', label: 'Backfill job', sub: 'Snapshot, enqueue, swap', kind: 'worker', x: 620, y: 410, latency: 2, role: 'Lists the library once, queues one relabel task per photo, and swaps the alias when every task is done.', owns: ['Progress'] },
        { id: 'idx1', label: 'Index v1', sub: 'Live today', kind: 'db', x: 800, y: 360, latency: 4, role: 'Labels from model v1.', ops: [{ name: 'put', desc: 'Write labels.' }, { name: 'del', desc: 'Remove a doc.' }], owns: ['docs'] },
        { id: 'idx2', label: 'Index v2', sub: 'Being built', kind: 'db', x: 980, y: 360, latency: 4, role: 'Labels from model v2, filled by the backfill (and dual writes).', ops: [{ name: 'put', desc: 'Write labels.' }, { name: 'del', desc: 'Remove a doc.' }], owns: ['docs'] },
        { id: 'facestore', label: 'Face store', sub: 'Embeddings', kind: 'db', x: 980, y: 120, latency: 4, role: 'Face embeddings and the groups built from them. Biometric data: it must go when Maya turns grouping off.', ops: [{ name: 'put', desc: 'Store an embedding.' }, { name: 'purge', desc: 'Delete all of a user’s.' }], owns: ['embeddings[user]'] },
      ],
      edges: [
        { from: 'phone', to: 'gateway', latency: 30 },
        { from: 'laptop', to: 'gateway', latency: 20 },
        { from: 'gateway', to: 'metadb', latency: 3 },
        { from: 'gateway', to: 'search', latency: 3 },
        { from: 'metadb', to: 'freshq', latency: 3 },
        { from: 'metadb', to: 'bfq', latency: 3 },
        { from: 'metadb', to: 'idx1', latency: 3, via: [[520, 330], [720, 330]] },
        { from: 'metadb', to: 'facestore', latency: 3, via: [[430, 40], [980, 40]] },
        { from: 'freshq', to: 'labeler', latency: 2 },
        { from: 'bfq', to: 'labeler', latency: 2 },
        { from: 'backfill', to: 'bfq', latency: 2 },
        { from: 'backfill', to: 'search', latency: 2 },
        { from: 'labeler', to: 'idx1', latency: 3 },
        { from: 'labeler', to: 'idx2', latency: 3 },
        { from: 'labeler', to: 'facestore', latency: 3 },
        { from: 'search', to: 'idx1', latency: 3, via: [[800, 500]] },
        { from: 'search', to: 'idx2', latency: 3, via: [[980, 520]] },
      ],
      queues: [
        { id: 'fresh', broker: 'freshq', label: 'fresh tasks', groups: ['labeler'] },
        { id: 'backfill', broker: 'bfq', label: 'relabel tasks', groups: ['labeler'] },
      ],
    },
    modeLabels: {},
    failures: [
      { id: 'labeler-down', node: 'labeler', mode: 'down', label: 'Labeller down', desc: 'New photos are in the library but not searchable until it returns.' },
      { id: 'labeler-slow', node: 'labeler', mode: 'slow', params: { factor: 5 }, label: 'Labeller slow', desc: 'Each image takes five times as long; queues grow.' },
      { id: 'idx2-down', node: 'idx2', mode: 'down', label: 'Index v2 down', desc: 'Backfill and dual writes fail and retry.' },
      { id: 'idx1-slow', node: 'idx1', mode: 'slow', params: { factor: 20 }, label: 'Index v1 slow', desc: 'Searches and label writes wait.' },
      { id: 'fresh-dup', node: 'freshq', mode: 'duplicate', label: 'Fresh lane delivers twice', desc: 'Labelling is idempotent: writing the same labels twice changes nothing.' },
      { id: 'faces-slow', node: 'facestore', mode: 'slow', params: { factor: 20 }, label: 'Face store slow', desc: 'Labelling waits on embedding writes.' },
      { id: 'meta-slow', node: 'metadb', mode: 'slow', params: { factor: 20 }, label: 'Metadata store slow', desc: 'Uploads and deletes wait.' },
    ],
    switches: Y.switches([
      ['freshLane', 'Fresh lane for new uploads', 'New uploads get their own queue, taken before any backfill. Off: one queue for everything.'],
      ['dualWrite', 'Dual write during a backfill', 'While v2 is being built, new labels go to v1 and v2. Off: only to the live index.'],
      ['deleteBoth', 'Deletes reach both indexes', 'A delete removes the doc from v1 and v2, and a relabel task for a deleted photo is skipped. Off: only the live index.'],
      ['purgeFaces', 'Turning grouping off deletes embeddings', 'The face store deletes every embedding for Maya. Off: the People view is hidden; the embeddings stay.'],
    ]),
    presets: Y.presets({ freshLane: true, dualWrite: true, deleteBoth: true, purgeFaces: true }, [
      { id: 'searchable', label: 'New photo, then search', desc: 'The dog photo is labelled about a tenth of a second after upload; a search for “dog” finds it.', run: (s) => { take(s); later(s, 1500, (x) => search(x, 'dog')); } },
      { id: 'workers-down', label: 'Labeller down', desc: 'The photo is in the library, but “dog” finds nothing: its labels do not exist yet.', run: (s) => { s.inject('labeler', 'down'); take(s); later(s, 1500, (x) => search(x, 'dog')); } },
      { id: 'backfill-starves-fresh', label: 'Backfill running, one shared queue', desc: `The v2 backfill queues ${LIB} relabel tasks. The new photo goes to the back of the same queue and waits about six seconds; a search in the meantime finds nothing.`, sw: { freshLane: false }, run: (s) => { backfill(s); later(s, 300, take); later(s, 2500, (x) => search(x, 'dog')); } },
      { id: 'fresh-lane', label: 'Backfill running, fresh lane', desc: 'Same backfill, but the new photo’s task is in the fresh lane and the labeller takes it next. “dog” finds it at once.', run: (s) => { backfill(s); later(s, 300, take); later(s, 2500, (x) => search(x, 'dog')); } },
      { id: 'swap-without-dual-write', label: 'Upload during the backfill, no dual write', desc: 'The dog photo is labelled into v1 only. The backfill’s list was taken before it existed. When the alias swaps to v2, “dog” finds nothing, and nothing will ever add it.', sw: { dualWrite: false }, run: (s) => { backfill(s); later(s, 300, take); later(s, 8200, (x) => search(x, 'dog')); } },
      { id: 'dual-write-swap', label: 'Upload during the backfill, dual write', desc: 'The labeller writes the new photo to v1 and v2. After the swap, “dog” still finds it, now from v2.', run: (s) => { backfill(s); later(s, 300, take); later(s, 8200, (x) => search(x, 'dog')); } },
      { id: 'delete-during-backfill', label: 'Delete during the backfill, live index only', desc: 'Maya deletes “Old beach photo”. It leaves v1, but its relabel task is still queued and writes it into v2. After the swap, “beach” finds a photo she deleted.', sw: { deleteBoth: false }, run: (s) => { backfill(s); later(s, 300, (x) => remove(x, 'b1')); later(s, 8200, (x) => search(x, 'beach')); } },
      { id: 'face-optout-no-purge', label: 'Turn face grouping off, embeddings kept', desc: 'The People view disappears, but every face embedding is still in the face store.', sw: { purgeFaces: false }, run: (s) => faces(s, false) },
      { id: 'face-optout-purge', label: 'Turn face grouping off, embeddings deleted', desc: 'The setting is saved and the face store deletes all of Maya’s embeddings. New photos are not scanned for faces.', run: (s) => faces(s, false) },
    ]),
    initialState: () => {
      const items = libItems();
      const idx1 = {}; const emb = {};
      for (const it of Object.values(items)) { idx1[it.id] = it.labels.slice(); if (it.face) emb[it.id] = true; }
      return {
        config: { freshLane: true, dualWrite: true, deleteBoth: true, purgeFaces: true },
        items, idx1, idx2: {}, emb, alias: 'v1', faceOn: true, bf: null, deleted: [],
        stats: { labelled: 0, relabelled: 0, skipped: 0, freshWait: null, retries: 0 },
      };
    },
    initialUI: () => ({ phone: {}, laptop: { query: '', results: null, index: null } }),
    actions: {
      take(sim) { take(sim); },
      remove(sim) { remove(sim, 'b1'); },
      search(sim, a) { search(sim, a.q); },
      backfill(sim) { backfill(sim); },
      faces(sim, a) { faces(sim, !!a.on); },
    },
    handlers: {
      gateway: {
        upload: function* (ctx, p) { return ctx.must(yield ctx.call('metadb', 'insert', p, { timeout: 1000 })); },
        delete: function* (ctx, p) { return ctx.must(yield ctx.call('metadb', 'delete', p, { timeout: 1000 })); },
        search: function* (ctx, p) { return ctx.must(yield ctx.call('search', 'query', p, { timeout: 1000 })); },
        faces: function* (ctx, p) { return ctx.must(yield ctx.call('metadb', 'faces', p, { timeout: 1000 })); },
      },
      metadb: {
        insert(ctx, p) {
          const st = ctx.state;
          if (st.items[p.item.id]) return { id: p.item.id };
          st.items[p.item.id] = Object.assign({}, p.item, { state: 'active', t: ctx.now() });
          ctx.sim.enqueue(st.config.freshLane ? 'fresh' : 'backfill', { type: 'label', eventId: `l-${p.item.id}`, payload: { id: p.item.id }, actionId: ctx.actionId });
          return { id: p.item.id };
        },
        delete: function* (ctx, p) {
          const st = ctx.state;
          const it = st.items[p.id];
          if (!it || it.state !== 'active') ctx.fail('NOT_FOUND', 'Not in the library.');
          it.state = 'deleted';
          st.deleted.push(p.id);
          delete st.emb[p.id];
          const from = [];
          const targets = st.config.deleteBoth ? ['idx1', 'idx2'] : [live(st)];
          for (const t of targets) { const r = yield ctx.call(t, 'del', p, { timeout: 800 }); if (r.ok) from.push(t === 'idx1' ? 'v1' : 'v2'); }
          return { from };
        },
        faces: function* (ctx, p) {
          const st = ctx.state;
          st.faceOn = p.on;
          if (p.on || !st.config.purgeFaces) return { purged: 0 };
          const r = ctx.must(yield ctx.call('facestore', 'purge', { user: 'maya' }, { timeout: 800 }));
          return { purged: r.n };
        },
        get(ctx, p) { const it = ctx.state.items[p.id]; return { state: it ? it.state : 'missing', labels: it ? it.labels : [], face: it ? it.face : false }; },
      },
      search: {
        query(ctx, p) {
          const st = ctx.state;
          const idx = st[live(st)];
          const q = String(p.q).toLowerCase();
          return { ids: Object.keys(idx).filter((id) => idx[id].includes(q)), index: st.alias };
        },
        swap(ctx) { ctx.state.alias = 'v2'; ctx.state.bf.swappedAt = ctx.now(); return { alias: 'v2' }; },
      },
      idx1: { put(ctx, p) { ctx.state.idx1[p.id] = p.labels.slice(); return { ok: true }; }, del(ctx, p) { delete ctx.state.idx1[p.id]; return { ok: true }; } },
      idx2: { put(ctx, p) { ctx.state.idx2[p.id] = p.labels.slice(); return { ok: true }; }, del(ctx, p) { delete ctx.state.idx2[p.id]; return { ok: true }; } },
      facestore: {
        put(ctx, p) { ctx.state.emb[p.id] = true; return { ok: true }; },
        purge(ctx) { const n = Object.keys(ctx.state.emb).length; ctx.state.emb = {}; return { n }; },
      },
    },
    setup(sim) {
      // The labeller: fresh lane first (if there is one), then the backfill queue.
      sim.spawn(function* (ctx) {
        for (;;) {
          const st = ctx.state;
          const n = ctx.sim.nodes.labeler;
          if (n.modes.down || n.modes.paused) { yield ctx.wait(100); continue; }
          const q = sim.queueStats('fresh').depth ? 'fresh' : sim.queueStats('backfill').depth ? 'backfill' : null;
          if (!q) { yield ctx.wait(50); continue; }
          const { msg } = yield ctx.take(q, 'labeler');
          const id = msg.payload.id;
          const m = yield ctx.call('metadb', 'get', { id }, { timeout: 800, actionId: msg.actionId, quiet: msg.payload.backfill ? 'all' : undefined });
          if (!m.ok) { ctx.nack(q, 'labeler'); yield ctx.wait(200); continue; }
          if (m.value.state !== 'active' && st.config.deleteBoth) {
            st.stats.skipped++;
            ctx.log({ op: `relabel ${id} skipped: deleted`, status: 'note', actionId: msg.actionId, detail: 'The photo was deleted after the backfill listed it. Its task is dropped instead of writing it into v2.' });
            ctx.ack(q, 'labeler');
            if (msg.payload.backfill) st.bf.done++;
            continue;
          }
          yield ctx.wait(Math.round(LABEL_MS * (n.modes.slow ? 5 : 1)));
          const targets = msg.payload.backfill ? ['idx2'] : st.bf && !st.bf.swappedAt && st.config.dualWrite ? ['idx1', 'idx2'] : [live(st)];
          let ok = true;
          for (const t of targets) {
            const r = yield ctx.call(t, 'put', { id, labels: m.value.labels }, { timeout: 800, actionId: msg.actionId, quiet: msg.payload.backfill ? 'all' : undefined });
            if (!r.ok) ok = false;
          }
          if (ok && !msg.payload.backfill && m.value.face && st.faceOn) {
            const r = yield ctx.call('facestore', 'put', { id }, { timeout: 800, actionId: msg.actionId });
            if (!r.ok) ok = false;
          }
          if (!ok) { st.stats.retries++; ctx.nack(q, 'labeler'); yield ctx.wait(200); continue; }
          ctx.ack(q, 'labeler');
          if (msg.payload.backfill) { st.stats.relabelled++; st.bf.done++; }
          else {
            st.stats.labelled++;
            const it = st.items[id];
            it.labelledAt = ctx.now();
            st.stats.freshWait = ctx.now() - it.t;
            ctx.log({ op: `${id} labelled`, status: 'ok', actionId: msg.actionId, detail: `Written to ${targets.map((t) => (t === 'idx1' ? 'v1' : 'v2')).join(' and ')} ${SDL.fmtMs(ctx.now() - it.t)} after upload.` });
            ctx.sim.setLedger(msg.actionId, 'async', 'yes', `Searchable (${targets.map((t) => (t === 'idx1' ? 'v1' : 'v2')).join(' + ')}).`);
          }
        }
      }, { self: 'labeler' });
      // The backfill job swaps the alias once every task is done.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const st = ctx.state;
          if (!st.bf || st.bf.swappedAt || st.bf.done < st.bf.total) continue;
          const r = yield ctx.call('search', 'swap', {}, { timeout: 800 });
          if (r.ok) ctx.log({ op: 'alias → index v2', status: 'recovered', detail: `All ${st.bf.total} relabel tasks are done. Searches now read v2.` });
        }
      }, { self: 'backfill', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const idx = st[live(st)];
      const ghost = st.deleted.find((id) => idx[id]);
      if (ghost) return { key: 'wrong', label: `Maya deleted “${st.items[ghost].name}”, and a search on index ${st.alias} still finds it. The delete only reached ${st.config.deleteBoth ? 'one index' : 'the index that was live at the time'}, and the backfill wrote it back into v2.` };
      if (!st.faceOn && Object.keys(st.emb).length) return { key: 'wrong', label: `Face grouping is off, but ${Object.keys(st.emb).length} face embeddings of Maya’s photos are still stored. Hiding the People view is not deleting biometric data.` };
      const fresh = Object.values(st.items).filter((it) => it.t != null && it.state === 'active');
      const lost = fresh.find((it) => it.labelledAt != null && !idx[it.id]);
      if (lost) return { key: 'wrong', label: `“${lost.name}” was labelled into v1 only. The backfill’s list was made before it existed, so v2 never got it, and the swap made it unsearchable for good.` };
      const waiting = fresh.find((it) => it.labelledAt == null);
      if (waiting) return { key: 'stale', label: `“${waiting.name}” is in the library but not searchable yet: ${sim.nodes.labeler.modes.down ? 'the labeller is down' : !st.config.freshLane && st.bf ? `its task is behind ${sim.queueStats('backfill').depth} relabel tasks in the one shared queue` : 'its labels are on the way'}.` };
      if (st.stats.freshWait > 2000) return { key: 'stale', label: `“${fresh[0] ? fresh[0].name : 'The new photo'}” took ${SDL.fmtMs(st.stats.freshWait)} to become searchable: its task waited behind the backfill in the one shared queue. Maya searched in the meantime and found nothing.` };
      if (st.bf && !st.bf.swappedAt) return { key: 'stale', label: `Backfill ${st.bf.done} of ${st.bf.total}: searches still read v1 until v2 is complete.` };
      if (st.bf && st.bf.swappedAt) return { key: 'ok', label: `The alias moved to v2 after all ${st.bf.total} relabel tasks${st.stats.skipped ? ` (${st.stats.skipped} skipped because the photo was deleted)` : ''}. ${fresh.length ? `“${fresh[0].name}” was written to both indexes as it arrived, so it survived the swap.` : ''}` };
      if (!st.faceOn) return { key: 'ok', label: 'Face grouping is off and every embedding was deleted. New photos are not scanned for faces.' };
      if (fresh.length) return { key: 'ok', label: `“${fresh[0].name}” became searchable ${SDL.fmtMs(st.stats.freshWait)} after upload.` };
      return { key: 'ok', label: 'Every photo in the library is searchable.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      return [
        { label: 'Live index', value: st.alias },
        { label: 'Docs in v1 / v2', value: `${Object.keys(st.idx1).length} / ${Object.keys(st.idx2).length}` },
        { label: 'Backfill', value: st.bf ? `${st.bf.done} of ${st.bf.total}` : '–' },
        { label: 'Fresh upload to searchable', value: st.stats.freshWait != null ? SDL.fmtMs(st.stats.freshWait) : '–', tone: st.stats.freshWait > 2000 ? 'warn' : '' },
        { label: 'Fresh lane depth', value: sim.queueStats('fresh').depth },
        { label: 'Backfill queue depth', value: sim.queueStats('backfill').depth },
        { label: 'Face embeddings', value: Object.keys(st.emb).length, tone: !st.faceOn && Object.keys(st.emb).length ? 'fail' : '' },
        { label: 'Write retries', value: st.stats.retries },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone'], ['laptop', 'Maya’s laptop (web)']], {
          note: 'Take a photo on the phone, then search for it on the laptop. The ops console starts the model v2 backfill.',
          below: `<div class="ops-console"><p class="ops-title">Search ops</p><div class="ops-traffic">${Y.btn('backfill', 'Relabel everything with model v2', { cls: 'secondary' })}</div><div data-ref="status"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const tile = (it) => `<div style="min-width:0"><div class="yt-thumb" style="--h:${it.hue};aspect-ratio:1;font-size:16px"><span aria-hidden="true">${it.glyph}</span></div><span class="app-sub" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.state === 'deleted' ? '✕ ' : ''}${esc(it.name)}</span></div>`;
        const grid = (inner) => `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px">${inner}</div>`;
        const mine = st.items.n1;
        const faceCount = Object.keys(st.emb).length;
        Y.paint(el, sim, 'phone', {
          head: `<div><p class="app-title">Photos</p><p class="app-sub">${Object.values(st.items).filter((i) => i.state === 'active').length} photos</p></div>`,
          ctl: `<div class="app-row" style="flex-wrap:wrap">${Y.btn('take', '📷 Photo of the dog', { disabled: !!mine })}${Y.btn('remove', 'Delete “Old beach photo”', { cls: 'secondary', disabled: st.items.b1.state !== 'active' })}</div>`,
          mine: mine ? `<div class="app-card ${mine.labelledAt != null ? 'is-ok' : 'is-work'}"><strong>${mine.glyph} ${esc(mine.name)}</strong><span class="app-sub">${mine.labelledAt != null ? '✓ Labelled: dog, beach' : '… Waiting for labels'}</span></div>` : '',
          people: `<p class="app-sub">People</p>${st.faceOn ? `<div class="app-card"><strong>🙂 Omar</strong><span class="app-sub">${faceCount} photos with this face</span></div>` : '<p class="app-sub">Face grouping is off.</p>'}${Y.btn('faces', st.faceOn ? 'Turn face grouping off' : 'Turn face grouping on', { arg: { on: !st.faceOn }, cls: 'secondary' })}`,
        }, {});
        const lp = sim.ui.laptop;
        const res = lp.results == null ? '' : `<p class="app-sub">“${esc(lp.query)}” on index ${esc(lp.index)}: ${lp.results.length} result${lp.results.length === 1 ? '' : 's'}</p>${grid(lp.results.slice().sort((a, b) => (a === 'n1' ? -1 : b === 'n1' ? 1 : a === 'b1' ? -1 : 0)).slice(0, 6).map((id) => tile(st.items[id])).join(''))}`;
        Y.paint(el, sim, 'laptop', {
          head: '<div><p class="app-title">Search</p><p class="app-sub">Only Maya’s photos</p></div>',
          q: `<div class="app-row" style="flex-wrap:wrap">${Y.btn('search', 'Search “dog”', { arg: { q: 'dog' }, cls: 'secondary' })}${Y.btn('search', 'Search “beach”', { arg: { q: 'beach' }, cls: 'secondary' })}</div>`,
          res,
        }, {});
        const c = sim.scenario.consistency(sim);
        const rows = `<div class="ops-shards">
          <div class="ops-row"><div class="ops-name">Alias<span>searches read index ${st.alias}</span></div></div>
          <div class="ops-row" data-tone="${st.bf && !st.bf.swappedAt ? 'warn' : ''}"><div class="ops-name">Backfill<span>${st.bf ? `${st.bf.done} of ${st.bf.total} relabelled${st.bf.swappedAt ? ' · swapped' : ''}` : 'not started'}</span></div></div>
          <div class="ops-row"><div class="ops-name">Queues<span>fresh ${sim.queueStats('fresh').depth} · backfill ${sim.queueStats('backfill').depth}</span></div></div>
          <div class="ops-row" data-tone="${!st.faceOn && faceCount ? 'fail' : ''}"><div class="ops-name">Face store<span>${faceCount} embeddings</span></div></div></div>`;
        SDL.ui.paintSections(el.querySelector('[data-ref="status"]'), { rows, recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>` }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
