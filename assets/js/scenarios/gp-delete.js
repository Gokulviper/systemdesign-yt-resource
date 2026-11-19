/*
 * Trash, permanent delete, and every copy.
 * Trash hides a photo for 30 days (3 s here) and keeps it restorable. A
 * permanent delete must reach every copy: the original, the thumbnails, the
 * CDN cache, the search index, face data, shared albums, and backups. With a
 * deletion ledger, one task per copy is written with the tombstone and retried
 * until done; idempotent purges make redelivery harmless. The purge claims the
 * item first, so a restore at the last moment cannot bring back metadata whose
 * bytes are already gone. Backups are made unreadable by destroying the user's
 * key (crypto-shredding) instead of waiting for snapshots to expire.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const TRASH_MS = 3000; // 30 days
  const DAY = TRASH_MS / 30;
  const TARGETS = [
    ['blob', 'Original'], ['thumbs', 'Thumbnails'], ['cdn', 'CDN cache'], ['index', 'Search index'],
    ['faces', 'Face data'], ['albums', 'Shared albums'], ['backups', 'Backups'],
  ];
  const NODE = { blob: 'blob', thumbs: 'blob', cdn: 'cdn', index: 'index', faces: 'faces', albums: 'metadb', backups: 'backups' };
  const PHOTOS = {
    beach: { name: 'Beach day', labels: ['beach', 'sea'], hue: 200, glyph: '🏖', album: true, face: true },
    lake: { name: 'Lake at dawn', labels: ['lake'], hue: 160, glyph: '🏞', album: true, face: false },
    ramen: { name: 'Ramen', labels: ['food'], hue: 45, glyph: '🍜', album: false, face: false },
    dog: { name: 'Dog on the beach', labels: ['dog', 'beach'], hue: 30, glyph: '🐕', album: false, face: false },
  };

  function act(sim, label, self, op, p, after) {
    sim.startAction(label, function* (ctx) {
      const r = yield ctx.call('gateway', op, p, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, `${r.error.code}: ${r.error.message}`); if (after) after(ctx, r); return; }
      if (after) after(ctx, r);
    }, { self });
  }
  const trash = (sim, id) => act(sim, `Phone: delete “${PHOTOS[id].name}”`, 'phone', 'trash', { id }, (ctx, r) => {
    if (r.ok) { Y.L(ctx, { displayed: ['yes', 'Moved to trash: hidden, restorable for 30 days.'], committed: ['yes', 'Item state = trashed.'] }); ctx.explain('The photo is in the trash. Nothing is deleted yet; it still counts against storage until the trash is emptied or 30 days pass.'); }
  });
  const restore = (sim, id) => act(sim, `Phone: restore “${PHOTOS[id].name}”`, 'phone', 'restore', { id }, (ctx, r) => {
    ctx.ui.phone.msg = r.ok ? `Restored “${PHOTOS[id].name}”.` : `Couldn’t restore: ${r.error.message}`;
    if (r.ok) { ctx.state.restoredAt = ctx.now(); Y.L(ctx, { displayed: ['yes', 'Back in the library.'], committed: ['yes', 'Item state = active.'] }); }
  });
  const empty = (sim) => act(sim, 'Phone: empty trash', 'phone', 'empty', {}, (ctx, r) => {
    if (r.ok) Y.L(ctx, { displayed: ['yes', 'Trash emptied.'], committed: ['yes', `${r.value.n} item${r.value.n === 1 ? '' : 's'} due for permanent delete.`], async: ['pending', 'Every copy is removed in the background.'] });
  });
  const search = (sim, q) => {
    sim.ui.laptop.query = q;
    sim.startAction(`Laptop: search “${q}”`, function* (ctx) {
      const r = yield ctx.call('gateway', 'search', { q }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); ctx.ui.laptop.results = null; return; }
      ctx.ui.laptop.results = r.value.hits.map((h) => ({ id: h.id, thumb: 'loading' }));
      for (const h of ctx.ui.laptop.results) {
        const t = yield ctx.call('cdn', 'get', { id: h.id }, { timeout: 800 });
        h.thumb = t.ok ? 'ok' : 'broken';
      }
      const st = ctx.state;
      const ghosts = r.value.hits.filter((h) => !st.items[h.id] || st.items[h.id].state !== 'active');
      if (ghosts.length) st.ghostHits = ghosts.map((h) => h.id);
      Y.L(ctx, { displayed: ['yes', `${r.value.hits.length} result${r.value.hits.length === 1 ? '' : 's'}.`], committed: ['n/a', 'Read only.'] });
    }, { self: 'laptop' });
  };
  const deleteAccount = (sim) => act(sim, 'Maya: delete my account', 'laptop', 'deleteAccount', {}, (ctx, r) => {
    if (r.ok) { ctx.ui.laptop.account = 'deleted'; Y.L(ctx, { displayed: ['yes', 'Account deletion started.'], committed: ['yes', 'Every item marked for permanent delete.'], async: ['pending', 'Copies are removed in the background.'] }); }
  });

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'phone', quiet: 'all' });

  /** Purge one target. Idempotent: purging something already gone is a success. */
  const purgeOp = (target) => function (ctx, p) {
    const st = ctx.state;
    st.stats.purgeCalls++;
    if (target === 'backups') {
      if (st.keyDestroyed) { delete st.copies.backups[p.id]; return { done: true, how: 'key destroyed' }; }
      return { scheduled: true, how: 'leaves when the snapshot expires (90 days)' };
    }
    delete st.copies[target][p.id];
    return { done: true };
  };

  const sc = (SDL.scenarios['gp-delete'] = {
    id: 'gp-delete',
    seed: 2003,
    minHopMs: 5,
    productWidth: 760,
    intro: 'Delete “Beach day” on Maya’s phone: it goes to the trash. Empty the trash (or wait 30 days, 3 s here) and watch the ledger chase every copy. Then break the search index, restore at the last moment, or delete the whole account.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'phone', label: 'Maya’s phone', sub: 'Library + trash', kind: 'client', x: 90, y: 150, latency: 1, role: 'Deletes, restores, and empties the trash.', owns: ['Nothing durable'] },
        { id: 'laptop', label: 'Maya’s laptop', sub: 'Search + account', kind: 'client', x: 90, y: 450, latency: 1, role: 'Searches the library and can delete the account.', owns: ['Nothing durable'] },
        { id: 'gateway', label: 'Edge', sub: 'Auth, routing', kind: 'gateway', x: 260, y: 300, latency: 3, role: 'Routes requests.', owns: ['Nothing durable'] },
        { id: 'library', label: 'Photos API', sub: 'Trash, restore, search', kind: 'service', x: 430, y: 300, latency: 4, role: 'Moves items in and out of the trash, empties it, searches, and starts account deletion.', ops: [{ name: 'trash', desc: 'Move to trash.' }, { name: 'restore', desc: 'Restore from trash.' }], owns: ['Nothing durable'] },
        { id: 'metadb', label: 'Metadata store', sub: 'Items, albums, ledger', kind: 'db', x: 610, y: 150, latency: 5, role: 'Item state (active, trashed, purging, deleted), shared-album rows, and the deletion ledger: one row per copy that must go. Writes the tombstone, the ledger, and the tasks in one transaction.', ops: [{ name: 'claim', desc: 'trashed → purging, if still trashed.' }, { name: 'plan', desc: 'Tombstone + ledger + tasks.' }], owns: ['items', 'albums', 'ledger'] },
        { id: 'delq', label: 'Deletion queue', sub: 'One task per copy', kind: 'queue', x: 610, y: 450, latency: 3, queue: 'deletions', role: 'Deletion tasks, at least once. A failed task comes back.', owns: ['tasks'] },
        { id: 'workers', label: 'Deletion workers', sub: 'Sweep + purge', kind: 'worker', x: 430, y: 520, latency: 3, role: 'Sweep the trash for items past 30 days, then work through deletion tasks: purge one copy, mark the ledger row, acknowledge.', owns: ['Trash sweep'] },
        { id: 'blob', label: 'Blob store', sub: 'Originals + thumbnails', kind: 'store', x: 795, y: 90, latency: 6, role: 'Original bytes and every rendition.', ops: [{ name: 'purge', desc: 'Delete bytes.' }], owns: ['originals', 'thumbnails'] },
        { id: 'cdn', label: 'CDN', sub: 'Cached thumbnails', kind: 'cdn', x: 980, y: 90, latency: 3, role: 'Edge caches of thumbnails. Must be purged, or they serve until they expire.', ops: [{ name: 'get', desc: 'Fetch a thumbnail.' }, { name: 'purge', desc: 'Invalidate.' }], owns: ['cached thumbnails'] },
        { id: 'index', label: 'Search index', sub: 'Denormalised docs', kind: 'db', x: 795, y: 300, latency: 5, role: 'Holds its own copy of each photo’s labels and thumbnail address, so it answers searches without the metadata store.', ops: [{ name: 'query', desc: 'Search.' }, { name: 'purge', desc: 'Remove a doc.' }], owns: ['docs'] },
        { id: 'faces', label: 'Face store', sub: 'Embeddings', kind: 'db', x: 980, y: 300, latency: 5, role: 'Face embeddings and groups derived from photos.', ops: [{ name: 'purge', desc: 'Remove embeddings.' }], owns: ['embeddings'] },
        { id: 'backups', label: 'Backup snapshots', sub: '90-day retention', kind: 'store', x: 795, y: 510, latency: 8, role: 'Daily snapshots, encrypted with a per-user key. Snapshots cannot be edited; they expire after 90 days.', ops: [{ name: 'purge', desc: 'Handle a deleted item.' }], owns: ['snapshots'] },
        { id: 'keys', label: 'Key service', sub: 'Per-user keys', kind: 'service', x: 980, y: 510, latency: 4, role: 'Holds each user’s data key. Destroying it makes every backup of their data unreadable.', ops: [{ name: 'destroy', desc: 'Destroy a user key.' }], owns: ['keys[user]'] },
      ],
      edges: [
        { from: 'phone', to: 'gateway', latency: 30 },
        { from: 'laptop', to: 'gateway', latency: 20 },
        { from: 'gateway', to: 'library', latency: 3 },
        { from: 'library', to: 'metadb', latency: 3 },
        { from: 'library', to: 'index', latency: 3 },
        { from: 'library', to: 'keys', latency: 3, via: [[430, 590], [980, 590]] },
        { from: 'metadb', to: 'delq', latency: 3 },
        { from: 'delq', to: 'workers', latency: 3 },
        { from: 'workers', to: 'metadb', latency: 3, via: [[520, 220]] },
        { from: 'workers', to: 'blob', latency: 3, via: [[520, 60], [795, 60]] },
        { from: 'workers', to: 'cdn', latency: 3 },
        { from: 'workers', to: 'index', latency: 3 },
        { from: 'workers', to: 'faces', latency: 3 },
        { from: 'workers', to: 'backups', latency: 3 },
        { from: 'laptop', to: 'cdn', latency: 10, via: [[90, 40], [980, 40]] },
        { from: 'cdn', to: 'blob', latency: 5 },
        { from: 'keys', to: 'backups', latency: 3 },
      ],
      queues: [{ id: 'deletions', broker: 'delq', label: 'deletion tasks', groups: ['workers'] }],
    },
    modeLabels: { crashMid: 'Crashes after the next purge', rejectPurge: 'Purge requests fail' },
    failures: [
      { id: 'worker-crash', node: 'workers', mode: 'crashMid', label: 'Deletion worker crash', desc: 'The next task is purged, then the worker dies before acknowledging. The task comes back.' },
      { id: 'index-down', node: 'index', mode: 'down', label: 'Search index down', desc: 'Purges of search docs fail; searches fail too.' },
      { id: 'cdn-purge', node: 'cdn', mode: 'rejectPurge', label: 'CDN purge fails', desc: 'The CDN refuses invalidations; cached thumbnails keep serving.' },
      { id: 'faces-down', node: 'faces', mode: 'down', label: 'Face store down', desc: 'Embeddings cannot be removed until it returns.' },
      { id: 'dup', node: 'delq', mode: 'duplicate', label: 'Queue delivers tasks twice', desc: 'Every task is appended twice. Purges must be idempotent.' },
      { id: 'workers-paused', node: 'workers', mode: 'paused', label: 'Deletion workers paused', desc: 'Nothing is swept or purged; tasks wait.' },
      { id: 'meta-slow', node: 'metadb', mode: 'slow', params: { factor: 20 }, label: 'Metadata store slow', desc: 'Every trash, restore, and claim waits.' },
    ],
    switches: Y.switches([
      ['ledger', 'Deletion ledger with retries', 'The tombstone, one ledger row per copy, and one task per copy are written together; tasks retry until done. Off: the purge calls each store once and moves on.'],
      ['guard', 'Claim before purging', 'The purge first moves the item from “trashed” to “purging”; a restore only works on “trashed”. Off: the purge deletes bytes first and checks the state at the end.'],
      ['shred', 'Crypto-shredding for backups', 'Account deletion destroys the user’s key, so every snapshot of their data becomes unreadable at once. Off: backups keep the data until they expire.'],
    ]),
    presets: Y.presets({ ledger: true, guard: true, shred: true }, [
      { id: 'trash-restore', label: 'Delete, then restore', desc: '“Beach day” goes to the trash: hidden, nothing deleted. Maya restores it a second later and it is back exactly as it was.', run: (s) => { trash(s, 'beach'); later(s, 1000, (x) => restore(x, 'beach')); } },
      { id: 'permanent-delete', label: 'Delete and empty the trash', desc: 'The tombstone, seven ledger rows, and seven tasks are written together. Workers purge the original, thumbnails, CDN, search doc, face data, and album row; backups are scheduled to drop the photo when the snapshot expires. A search for “beach” finds only the dog.', run: (s) => { trash(s, 'beach'); later(s, 400, empty); later(s, 2500, (x) => search(x, 'beach')); } },
      { id: 'fire-and-forget-index-down', label: 'Empty the trash with the index down, no ledger', desc: 'The purge calls each store once. The search index is down, its call fails, and nobody tries again. A week later “beach” still finds the deleted photo.', sw: { ledger: false }, run: (s) => { s.inject('index', 'down', true, 2000); trash(s, 'beach'); later(s, 400, empty); later(s, 3000, (x) => search(x, 'beach')); } },
      { id: 'ledger-retries', label: 'Empty the trash with the index down, ledger', desc: 'The index task fails and comes back every few hundred milliseconds until the index returns. The ledger row turns green last; “beach” finds only the dog.', run: (s) => { s.inject('index', 'down', true, 2000); trash(s, 'beach'); later(s, 400, empty); later(s, 3000, (x) => search(x, 'beach')); } },
      { id: 'restore-purge-race', label: 'Restore on day 30, no claim', desc: 'The 30-day sweep starts purging “Beach day” and deletes its bytes; Maya taps Restore in that moment and it works. The purge then sees “active” and leaves the metadata: a photo in the library with no bytes.', sw: { guard: false }, run: (s) => { trash(s, 'beach'); later(s, TRASH_MS + 200, (x) => restore(x, 'beach')); } },
      { id: 'restore-guarded', label: 'Restore on day 30, purge claims first', desc: 'The purge moves the item to “purging” before touching any bytes. Maya’s restore is refused with “already being deleted”. The photo is gone everywhere, consistently.', run: (s) => { trash(s, 'beach'); later(s, TRASH_MS + 200, (x) => restore(x, 'beach')); } },
      { id: 'duplicate-task', label: 'Tasks delivered twice', desc: 'The queue appends every task twice. Purging something already gone is a success, so the second copy of each task changes nothing.', run: (s) => { s.inject('delq', 'duplicate'); trash(s, 'beach'); later(s, 400, empty); } },
      { id: 'account-delete-backup-wait', label: 'Delete the account, backups expire on their own', desc: 'Every photo is purged from every live store, but the 90-day snapshots still hold them, readable by anyone who restores one.', sw: { shred: false }, run: (s) => deleteAccount(s) },
      { id: 'account-delete-shred', label: 'Delete the account, destroy the key', desc: 'Same deletion, plus Maya’s data key is destroyed. The snapshots still exist, but nothing in them can be read.', run: (s) => deleteAccount(s) },
    ]),
    initialState: () => {
      const items = {}; const copies = { blob: {}, thumbs: {}, cdn: {}, index: {}, faces: {}, albums: {}, backups: {} };
      for (const [id, p] of Object.entries(PHOTOS)) {
        items[id] = { id, state: 'active', trashedAt: null };
        for (const t of ['blob', 'thumbs', 'cdn', 'index', 'backups']) copies[t][id] = true;
        if (p.face) copies.faces[id] = true;
        if (p.album) copies.albums[id] = true;
      }
      return {
        config: { ledger: true, guard: true, shred: true },
        items, copies, ledger: {}, fails: {}, abandoned: [], keyDestroyed: false, account: 'active', restoredAt: null, ghostHits: [],
        stats: { purgeCalls: 0, tasks: 0, retries: 0, refused: 0 },
      };
    },
    initialUI: () => ({ phone: { tab: 'library', msg: '' }, laptop: { query: '', results: null, account: 'active' } }),
    actions: {
      trash(sim, a) { trash(sim, a.id); },
      restore(sim, a) { restore(sim, a.id); },
      empty(sim) { empty(sim); },
      search(sim, a) { search(sim, a.q || 'beach'); },
      account(sim) { deleteAccount(sim); },
      set: Y.setAction,
    },
    handlers: {
      gateway: Object.fromEntries(['trash', 'restore', 'empty', 'search', 'deleteAccount'].map((op) => [op, function* (ctx, p) { return ctx.must(yield ctx.call('library', op, p, { timeout: 1200 })); }])),
      library: {
        trash: function* (ctx, p) { return ctx.must(yield ctx.call('metadb', 'trash', p, { timeout: 800 })); },
        restore: function* (ctx, p) { return ctx.must(yield ctx.call('metadb', 'restore', p, { timeout: 800 })); },
        empty: function* (ctx) { return ctx.must(yield ctx.call('metadb', 'empty', {}, { timeout: 800 })); },
        search: function* (ctx, p) { return ctx.must(yield ctx.call('index', 'query', p, { timeout: 800 })); },
        deleteAccount: function* (ctx) {
          const st = ctx.state;
          if (st.config.shred) {
            ctx.must(yield ctx.call('keys', 'destroy', { user: 'maya' }, { timeout: 800 }));
          }
          return ctx.must(yield ctx.call('metadb', 'deleteAll', {}, { timeout: 800 }));
        },
      },
      metadb: {
        trash(ctx, p) { const it = ctx.state.items[p.id]; if (!it || it.state !== 'active') ctx.fail('CONFLICT', 'Not in the library.'); it.state = 'trashed'; it.trashedAt = ctx.now(); return { ok: true }; },
        restore(ctx, p) {
          const st = ctx.state;
          const it = st.items[p.id];
          if (st.config.guard) {
            if (!it || it.state !== 'trashed') { st.stats.refused++; ctx.fail('CONFLICT', it && it.state === 'purging' ? 'This photo is already being permanently deleted.' : 'It is no longer in the trash.'); }
          } else if (!it || it.state === 'deleted') ctx.fail('NOT_FOUND', 'It is gone.');
          it.state = 'active'; it.trashedAt = null;
          return { ok: true };
        },
        empty(ctx) {
          let n = 0;
          for (const it of Object.values(ctx.state.items)) if (it.state === 'trashed') { it.due = true; n++; }
          return { n };
        },
        deleteAll(ctx) {
          const st = ctx.state;
          st.account = 'deleted';
          for (const it of Object.values(st.items)) if (it.state === 'active' || it.state === 'trashed') { it.state = 'trashed'; it.trashedAt = ctx.now(); it.due = true; }
          return { ok: true };
        },
        claim(ctx, p) { const it = ctx.state.items[p.id]; if (it.state !== 'trashed') ctx.fail('CONFLICT', `Item is ${it.state}.`); it.state = 'purging'; return { ok: true }; },
        plan(ctx, p) {
          const st = ctx.state;
          st.ledger[p.id] = Object.fromEntries(TARGETS.map(([t]) => [t, 'pending']));
          for (const [t] of TARGETS) { st.stats.tasks++; ctx.sim.enqueue('deletions', { type: 'purge', eventId: `${p.id}/${t}`, payload: { id: p.id, target: t }, actionId: ctx.actionId }); }
          return { ok: true };
        },
        finish(ctx, p) {
          const st = ctx.state;
          const it = st.items[p.id];
          if (it.state === 'purging' || it.state === 'trashed') { it.state = 'deleted'; delete st.copies.albums[p.id]; return { deleted: true }; }
          ctx.log({ op: `${p.id} is ${it.state}: metadata kept`, status: 'fault', actionId: ctx.actionId, detail: 'The purge checked the state only at the end. A restore made the item active while its bytes were being deleted.' });
          return { deleted: false };
        },
        purge: purgeOp('albums'),
      },
      blob: {
        purge: function* (ctx, p) { yield ctx.wait(150); return (p.target === 'thumbs' ? purgeOp('thumbs') : purgeOp('blob'))(ctx, p); },
        thumb(ctx, p) { if (!ctx.state.copies.thumbs[p.id]) ctx.fail('NOT_FOUND', 'No thumbnail.'); return { ok: true }; },
      },
      cdn: {
        get: function* (ctx, p) { if (ctx.state.copies.cdn[p.id]) return { hit: true }; ctx.must(yield ctx.call('blob', 'thumb', p, { timeout: 600 })); return { hit: false }; },
        purge(ctx, p) { if (ctx.mode('rejectPurge')) ctx.fail('REJECTED', 'Invalidation refused.'); return purgeOp('cdn')(ctx, p); },
      },
      index: {
        query(ctx, p) { const q = String(p.q).toLowerCase(); return { hits: Object.keys(ctx.state.copies.index).filter((id) => PHOTOS[id].labels.includes(q)).map((id) => ({ id })) }; },
        purge: purgeOp('index'),
      },
      faces: { purge: purgeOp('faces') },
      backups: { purge: purgeOp('backups') },
      keys: { destroy(ctx) { ctx.state.keyDestroyed = true; for (const id of Object.keys(ctx.state.copies.backups)) delete ctx.state.copies.backups[id]; return { ok: true }; } },
    },
    setup(sim) {
      // Trash sweep: anything due (emptied, or 30 days old) is purged.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const st = ctx.state;
          if (ctx.sim.nodes.workers.modes.paused || ctx.sim.nodes.workers.modes.down) continue;
          for (const it of Object.values(st.items)) {
            if (it.state !== 'trashed' || (!it.due && ctx.now() - it.trashedAt < TRASH_MS)) continue;
            if (st.config.guard) {
              const c = yield ctx.call('metadb', 'claim', { id: it.id }, { timeout: 800 });
              if (!c.ok) continue;
            } else it.purgeStarted = true;
            ctx.log({ op: `purge ${it.id}`, status: 'note', detail: st.config.guard ? 'Claimed: trashed → purging. A restore can no longer succeed.' : 'Purging without a claim: the item still says “trashed”.' });
            if (st.config.ledger) {
              const r = yield ctx.call('metadb', 'plan', { id: it.id }, { timeout: 800 });
              if (!r.ok) continue;
              it.planned = true;
            } else {
              st.ledger[it.id] = {};
              for (const [t] of TARGETS) {
                const r = yield ctx.call(NODE[t], 'purge', { id: it.id, target: t }, { timeout: 800 });
                st.ledger[it.id][t] = r.ok ? (r.value.scheduled ? 'scheduled' : 'done') : 'abandoned';
                if (!r.ok) { st.abandoned.push({ id: it.id, target: t }); ctx.log({ op: `${it.id}/${t} failed, not retried`, status: 'fault', detail: `${r.error.message} Without a ledger, nothing remembers that this copy still exists.` }); }
              }
              yield ctx.call('metadb', 'finish', { id: it.id }, { timeout: 800 });
            }
          }
        }
      }, { self: 'workers', quiet: 'all' });
      // Ledger tasks.
      Y.consumer(sim, 'deletions', 'workers', 'workers', function* (ctx, msg) {
        const st = ctx.state;
        const { id, target } = msg.payload;
        const r = yield ctx.call(NODE[target], 'purge', { id, target }, { timeout: 800, actionId: msg.actionId });
        if (!r.ok) { st.stats.retries++; st.fails[`${id}/${target}`] = (st.fails[`${id}/${target}`] || 0) + 1; ctx.log({ op: `${id}/${target} failed, will retry`, status: 'retry', actionId: msg.actionId, detail: `${r.error.message} The task goes back on the queue; the ledger row stays pending.` }); return false; }
        if (ctx.mode('crashMid')) { ctx.sim.restore('workers', 'crashMid'); ctx.log({ op: `worker crashed after purging ${id}/${target}`, status: 'fault', actionId: msg.actionId, detail: 'The copy is gone but the task was not acknowledged. It will come back; purging again is harmless.' }); return false; }
        const row = st.ledger[id];
        if (row) row[target] = r.value.scheduled ? 'scheduled' : 'done';
        if (row && Object.values(row).every((v) => v === 'done' || v === 'scheduled')) {
          yield ctx.call('metadb', 'finish', { id }, { timeout: 800, actionId: msg.actionId });
        }
        return true;
      });
    },
    consistency(sim) {
      const st = sim.state;
      const broken = Object.values(st.items).find((it) => it.state === 'active' && !st.copies.blob[it.id]);
      if (broken) return { key: 'wrong', label: `“${PHOTOS[broken.id].name}” is back in Maya’s library, but its bytes were deleted while she restored it. The purge only checked the state at the end.` };
      const ab = st.abandoned.find((a) => a.target !== 'backups' && st.copies[a.target][a.id]);
      if (ab) return { key: 'wrong', label: `“${PHOTOS[ab.id].name}” was permanently deleted, but its ${TARGETS.find((t) => t[0] === ab.target)[1].toLowerCase()} copy is still there${st.ghostHits.includes(ab.id) ? ' and a search still finds it' : ''}. The purge tried once, failed, and nothing remembers.` };
      const pending = Object.entries(st.ledger).filter(([, row]) => Object.values(row).some((v) => v === 'pending'));
      if (pending.length) { const n = pending.reduce((a, [, row]) => a + Object.values(row).filter((v) => v === 'pending').length, 0); return { key: 'stale', label: `${n} cop${n === 1 ? 'y is' : 'ies are'} still being removed; the ledger retries until each is gone.` }; }
      if (st.account === 'deleted') {
        if (!st.keyDestroyed && Object.keys(st.copies.backups).length) return { key: 'stale', label: `Every live copy is gone, but ${Object.keys(st.copies.backups).length} photos remain readable in backup snapshots for up to 90 days.` };
        const live = Object.keys(st.items).filter((id) => st.items[id].state !== 'deleted');
        if (live.length) return { key: 'stale', label: 'The account deletion is still working through the library.' };
        return { key: 'ok', label: 'Every live copy is gone, and the snapshots that still hold Maya’s photos are unreadable: her key was destroyed.' };
      }
      if (st.stats.refused) return { key: 'ok', label: 'The restore was refused: the purge had already claimed the photo. It is gone from every store, and Maya was told so.' };
      const deleted = Object.values(st.items).filter((it) => it.state === 'deleted');
      if (deleted.length) {
        const dupes = st.stats.purgeCalls - st.stats.tasks;
        return { key: 'ok', label: `“${PHOTOS[deleted[0].id].name}” is gone from the original, thumbnails, CDN, search, face data, and albums${st.stats.retries ? ` (after ${st.stats.retries} retries)` : ''}${dupes > 0 && st.config.ledger ? `; ${dupes} repeated purges changed nothing` : ''}. Backups drop it when their snapshot expires.` };
      }
      const trashed = Object.values(st.items).filter((it) => it.state === 'trashed' || it.state === 'purging');
      if (trashed.length) return { key: 'ok', label: `“${PHOTOS[trashed[0].id].name}” is in the trash: hidden, restorable, nothing deleted yet.` };
      if (st.restoredAt) return { key: 'ok', label: 'Restored: the photo never left any store, so it is back exactly as it was.' };
      return { key: 'ok', label: 'Nothing deleted yet.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const left = (id) => TARGETS.filter(([t]) => st.copies[t][id]).length;
      return [
        { label: 'Copies of “Beach day”', value: `${left('beach')} of ${TARGETS.length}`, tone: st.items.beach.state === 'deleted' && TARGETS.some(([t]) => t !== 'backups' && st.copies[t].beach) ? 'fail' : '' },
        { label: 'Deletion tasks', value: st.stats.tasks },
        { label: 'Purge calls', value: st.stats.purgeCalls },
        { label: 'Retries', value: st.stats.retries, tone: st.stats.retries ? 'warn' : '' },
        { label: 'Abandoned copies', value: st.abandoned.length, tone: st.abandoned.length ? 'fail' : '' },
        { label: 'Task queue', value: sim.queueStats('deletions').depth },
        { label: 'Backups readable', value: st.keyDestroyed ? 'no (key destroyed)' : 'yes' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone'], ['laptop', 'Maya’s laptop (web)']], {
          note: 'Delete a photo on the phone, then empty the trash. The ledger shows every copy the delete has to reach.',
          below: '<div class="ops-console"><p class="ops-title">Deletion ledger</p><div data-ref="ledger"></div></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const ui = sim.ui.phone;
        const tile = (id, extra, cap) => `<div style="min-width:0"><div class="yt-thumb" style="--h:${PHOTOS[id].hue};aspect-ratio:1;font-size:18px;${extra || ''}"><span aria-hidden="true">${PHOTOS[id].glyph}</span></div><span class="app-sub" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cap || PHOTOS[id].name)}</span></div>`;
        const grid = (inner) => `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">${inner}</div>`;
        const tabs = `<div class="app-row">${Y.btn('set', 'Library', { arg: { field: 'phone.tab', value: 'library' }, cls: ui.tab === 'library' ? '' : 'secondary' })}${Y.btn('set', `Trash (${Object.values(st.items).filter((i) => i.state === 'trashed').length})`, { arg: { field: 'phone.tab', value: 'trash' }, cls: ui.tab === 'trash' ? '' : 'secondary' })}</div>`;
        let body;
        if (st.account === 'deleted') body = '<p class="app-sub">This account has been deleted.</p>';
        else if (ui.tab === 'library') {
          const live = Object.values(st.items).filter((i) => i.state === 'active');
          body = `${Y.btn('trash', 'Delete “Beach day”', { arg: { id: 'beach' }, disabled: st.items.beach.state !== 'active' })}${grid(live.map((i) => tile(i.id, st.copies.blob[i.id] ? '' : 'filter:grayscale(1);opacity:.35', st.copies.blob[i.id] ? null : `✕ ${PHOTOS[i.id].name}: no bytes`)).join(''))}`;
        } else {
          const tr = Object.values(st.items).filter((i) => i.state === 'trashed' || i.state === 'purging');
          body = tr.length ? `${grid(tr.map((i) => tile(i.id, 'opacity:.6', i.state === 'purging' ? 'Deleting…' : `${Math.max(0, Math.ceil((TRASH_MS - (sim.now - i.trashedAt)) / DAY))} days left`)).join(''))}<div class="app-row">${Y.btn('restore', 'Restore', { arg: { id: tr[0].id }, cls: 'secondary' })}${Y.btn('empty', 'Empty trash')}</div>` : `<p class="app-sub">Trash is empty.</p>${st.items.beach.state === 'trashed' || st.items.beach.state === 'active' ? '' : ''}`;
        }
        Y.paint(el, sim, 'phone', { head: '<div><p class="app-title">Photos</p><p class="app-sub">Trash keeps items 30 days</p></div>', body, tabs, msg: Y.msg(ui.msg, /Couldn/.test(ui.msg) ? 'fail' : 'ok') }, {});
        const lp = sim.ui.laptop;
        const res = lp.results == null ? '' : lp.results.length ? grid(lp.results.map((r) => tile(r.id, r.thumb === 'ok' ? '' : r.thumb === 'broken' ? 'filter:grayscale(1);opacity:.35' : 'opacity:.6', `${st.items[r.id].state === 'deleted' ? '✕ deleted · ' : ''}${PHOTOS[r.id].name}`)).join('')) : '<p class="app-sub">No results.</p>';
        Y.paint(el, sim, 'laptop', {
          head: `<div><p class="app-title">Library</p><p class="app-sub">${st.account === 'deleted' ? 'Account deleted' : 'Maya’s account'}</p></div>`,
          q: `<div class="app-row" style="flex-wrap:wrap">${Y.btn('search', 'Search “beach”', { arg: { q: 'beach' }, cls: 'secondary' })}${Y.btn('account', 'Delete account', { cls: 'secondary', disabled: st.account === 'deleted' })}</div>`,
          res: lp.query ? `<p class="app-sub">“${esc(lp.query)}”</p>${res}` : '',
          album: `<p class="app-sub">Shared album “Goa trip”: ${Object.keys(st.copies.albums).length} photos</p>`,
        }, {});
        const c = sim.scenario.consistency(sim);
        const id = Object.keys(st.ledger).includes('beach') || st.account !== 'deleted' ? 'beach' : Object.keys(st.ledger)[0];
        const row = st.ledger[id] || {};
        const icon = { done: '✓', pending: '…', scheduled: '◷', abandoned: '✕' };
        const tone = { done: 'ok', pending: 'warn', scheduled: '', abandoned: 'fail' };
        const rows = TARGETS.map(([t, label]) => {
          const v = row[t];
          const present = !!st.copies[t][id];
          const note = v === 'scheduled' ? (st.keyDestroyed ? 'key destroyed' : 'leaves when its snapshot expires') : v === 'abandoned' ? 'failed once, never retried' : v === 'done' ? 'removed' : v === 'pending' ? (st.fails[`${id}/${t}`] ? `failed ${st.fails[`${id}/${t}`]}×, retrying until removed` : 'queued') : present ? 'present' : 'not held';
          return `<div class="ops-row" data-tone="${v ? tone[v] : ''}"><div class="ops-name">${v ? icon[v] : present ? '●' : '–'} ${esc(label)}<span>${esc(note)}</span></div></div>`;
        }).join('');
        SDL.ui.paintSections(el.querySelector('[data-ref="ledger"]'), {
          title: `<p class="app-sub">${esc(PHOTOS[id].name)} · item ${esc(st.items[id].state)}</p>`,
          rows: `<div class="ops-shards">${rows}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
