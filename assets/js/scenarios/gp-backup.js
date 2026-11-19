/*
 * End-to-end: from the shutter to the cloud.
 * Maya takes a photo. The phone hashes it, asks whether the library already
 * has it, opens a resumable upload session, sends the bytes in chunks, and
 * only then creates the library item (with a client id so a retry cannot make
 * a second one). The item and a change-log entry commit together; the change
 * log drives the thumbnailer, the labeller (search), and Maya's laptop. An
 * album add reaches Omar. "Backed up" on the phone means the create committed.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const SUBJECTS = [
    { name: 'Dog on the beach', labels: ['dog', 'beach'], hue: 200, glyph: '🐕' },
    { name: 'Sunset over the sea', labels: ['sunset', 'sea'], hue: 25, glyph: '🌅' },
    { name: 'Birthday cake', labels: ['cake', 'party'], hue: 330, glyph: '🎂' },
    { name: 'Street market', labels: ['market', 'people'], hue: 95, glyph: '🛍' },
  ];
  const VIDEO = { name: 'Waves.mp4', labels: ['sea', 'video'], hue: 185, glyph: '🎞' };
  const CHUNK = 4; // MB per chunk
  const MS_PER_MB = 30; // radio time to push one MB
  const SHED_MS = 250; // the edge refuses uploads when the upload service queue is longer than this
  const RETRY_AFTER = 1000;
  const SURGE = 800;

  const phoneDead = (sim) => !!sim.nodes.phone.modes.down;
  const offline = (sim) => !!sim.nodes.phone.modes.offline;

  function takePhoto(sim, opts) {
    opts = opts || {};
    const st = sim.state;
    const n = ++st.seq.photo;
    const subj = opts.video ? VIDEO : SUBJECTS[(n - 1) % SUBJECTS.length];
    const id = `p${n}`;
    st.local[id] = { id, name: subj.name, labels: subj.labels, hue: subj.hue, glyph: subj.glyph, size: opts.video ? 40 : 4, hash: `h${n}${opts.video ? 'v' : ''}`, clientId: `maya-phone-${n}`, state: 'waiting', sent: 0, offset: 0, t: sim.now };
    sim.ui.phone.banner = null;
    startBackup(sim, id);
    return id;
  }

  /** Call the edge with the client's retry policy (backoff, Retry-After, jitter). */
  function* send(ctx, op, p, tries) {
    const st = ctx.state;
    for (let a = 1; ; a++) {
      if (phoneDead(ctx.sim)) return null;
      const r = yield ctx.call('gateway', op, p, { timeout: 1500, quiet: p.bg ? 'all' : undefined });
      if (r.ok || r.error.code === 'OFFLINE' || a >= (tries || 8)) return r;
      let wait;
      if (r.error.code === 'OVERLOADED') {
        wait = RETRY_AFTER + (st.config.jitter ? Math.round(ctx.rand() * 1000 * Math.min(4, a + 1)) : 0);
        if (p.bg) st.surge.retries++;
      } else wait = Math.min(2000, 200 * 2 ** (a - 1)) + (st.config.jitter ? Math.round(ctx.rand() * 100) : 0);
      if (!p.bg) ctx.log({ op: `${op} retry in ${wait} ms`, status: 'retry', actionId: ctx.actionId, detail: `${r.error.message} ${r.error.code === 'OVERLOADED' ? (st.config.jitter ? 'Retry-After plus a random spread, so returning phones do not arrive together.' : 'Exactly Retry-After: every phone that was refused comes back at the same moment.') : 'Exponential backoff.'}` });
      yield ctx.wait(wait);
    }
  }

  function startBackup(sim, id) {
    sim.startAction(`Phone: back up “${sim.state.local[id].name}”`, function* (ctx) {
      const st = ctx.state;
      const it = st.local[id];
      Y.L(ctx, { displayed: ['pending', 'The phone says “Backing up” until the library item is committed.'], retrySafe: [st.config.idem ? 'yes' : 'no', st.config.idem ? `Client id ${it.clientId}: a retried create returns the same item.` : 'No client id: a retried create makes a new item.'] });
      it.state = 'uploading';
      const fail = (why) => { it.state = 'waiting'; it.why = why; Y.failed(ctx, why); ctx.explain(`${why} The photo stays on the phone, marked “waiting”, and the app tries again later. Nothing in the cloud claims it exists.`); };
      const create = function* (pending) {
        const r = yield* send(ctx, 'create', { clientId: it.clientId, hash: it.hash, name: it.name, size: it.size, labels: it.labels, hue: it.hue, glyph: it.glyph, token: it.token || null, pending });
        if (!r || !r.ok) return null;
        it.itemId = r.value.id;
        return r.value;
      };
      // 0. Metadata first (the unsafe order): the item exists before any bytes do.
      if (!st.config.bytesFirst) {
        const c = yield* create(true);
        if (!c) return fail(phoneDead(ctx.sim) ? 'The phone died.' : 'Create failed.');
        ctx.ledger('committed', 'yes', `Item ${c.id} created before its bytes: every device can see it now.`);
      }
      // 1. Ask whether the library already has these bytes.
      const chk = yield* send(ctx, 'check', { hash: it.hash });
      if (!chk) return fail('The phone died.');
      if (chk.ok && chk.value.exists && st.config.bytesFirst) {
        it.state = 'backed'; it.itemId = chk.value.id; st.stats.dedupe++;
        Y.L(ctx, { displayed: ['yes', 'Already in the library: nothing uploaded.'], committed: ['yes', 'Existing item.'] });
        return;
      }
      // 2. Open a session and send the bytes.
      let s = yield* send(ctx, 'start', { hash: it.hash, size: it.size });
      if (!s || !s.ok) return fail(s ? `Upload refused: ${s.error.code}.` : 'The phone died.');
      let session = s.value.session;
      let offset = 0;
      while (offset < it.size) {
        if (phoneDead(ctx.sim)) return fail('The phone died mid-upload.');
        if (offline(ctx.sim)) {
          it.state = 'paused';
          while (offline(ctx.sim) && !phoneDead(ctx.sim)) yield ctx.wait(100);
          if (phoneDead(ctx.sim)) return fail('The phone died mid-upload.');
          it.state = 'uploading';
          if (st.config.resumable) {
            const q = yield* send(ctx, 'status', { session });
            if (q && q.ok) { offset = q.value.offset; it.offset = offset; ctx.log({ op: `resume ${session} at ${offset} MB`, status: 'recovered', actionId: ctx.actionId, detail: `The server has ${offset} of ${it.size} MB. Only the rest is sent.` }); continue; }
          }
          s = yield* send(ctx, 'start', { hash: it.hash, size: it.size });
          if (!s || !s.ok) return fail('Could not restart the upload.');
          session = s.value.session;
          offset = 0; it.offset = 0; st.stats.restarts++;
          ctx.log({ op: `restart ${it.name} from 0 MB`, status: 'retry', actionId: ctx.actionId, detail: 'No resumable session: the bytes already sent are thrown away and the whole file goes again.' });
          continue;
        }
        const len = Math.min(CHUNK, it.size - offset);
        it.sent += len; st.stats.sentMB += len;
        const r = yield* send(ctx, 'chunk', { session, offset, len, quietLog: true });
        if (!r) return fail('The phone died mid-upload.');
        if (r.ok) { offset += len; it.offset = offset; continue; }
        if (r.error.code !== 'OFFLINE') return fail(`Upload failed: ${r.error.code}.`);
      }
      const f = yield* send(ctx, 'finish', { session });
      if (!f || !f.ok) return fail(f ? `Finish failed: ${f.error.code}.` : 'The phone died.');
      it.token = f.value.token;
      ctx.ledger('accepted', 'yes', `${it.size} MB durable in the blob store (token ${it.token}).`);
      // 3. Create (bytes first) or attach (metadata first).
      if (st.config.bytesFirst) {
        const c = yield* create(false);
        if (!c) return fail(phoneDead(ctx.sim) ? 'The phone died.' : 'Create failed.');
      } else {
        const a = yield* send(ctx, 'attach', { id: it.itemId, token: it.token, hash: it.hash });
        if (!a || !a.ok) return fail('Attach failed.');
      }
      it.state = 'backed'; it.at = ctx.now();
      Y.L(ctx, { displayed: ['yes', '“Backed up”: the item is committed.'], committed: ['yes', `Item ${it.itemId}, change-log entry in the same transaction.`], async: ['pending', 'Thumbnail and labels follow from the change log.'] });
      ctx.explain(`${it.name} is backed up as ${it.itemId} after ${SDL.fmtMs(ctx.now() - it.t)}. ${it.sent > it.size ? `${it.sent} MB went over the radio for a ${it.size} MB file.` : 'Every byte was sent once.'}`);
    }, { self: 'phone' });
  }

  function search(sim, q) {
    sim.ui.laptop.query = q;
    sim.startAction(`Laptop: search “${q}”`, function* (ctx) {
      const r = yield ctx.call('gateway', 'search', { q }, { timeout: 1500 });
      if (!r.ok) { ctx.ui.laptop.results = null; Y.failed(ctx, `Search failed: ${r.error.code}.`); return; }
      ctx.ui.laptop.results = r.value.ids;
      ctx.ui.laptop.searchedAt = ctx.now();
      Y.L(ctx, { displayed: ['yes', `${r.value.ids.length} result${r.value.ids.length === 1 ? '' : 's'}.`], committed: ['n/a', 'Read only.'] });
      ctx.explain(`“${q}” found ${r.value.ids.length} photo${r.value.ids.length === 1 ? '' : 's'}. Labels arrive asynchronously, so a photo backed up a moment ago may not be searchable yet.`);
    }, { self: 'laptop' });
  }

  function share(sim) {
    const st = sim.state;
    const it = Object.values(st.local).filter((x) => x.state === 'backed').pop();
    if (!it) return;
    sim.startAction(`Phone: add “${it.name}” to Goa trip`, function* (ctx) {
      const r = yield ctx.call('gateway', 'albumAdd', { id: it.itemId }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, `Album add failed: ${r.error.code}.`); return; }
      Y.L(ctx, { displayed: ['yes', 'Added to Goa trip.'], committed: ['yes', 'Album row written.'], async: ['pending', 'Omar’s phone is told.'] });
    }, { self: 'phone' });
  }

  function surge(sim) {
    const st = sim.state;
    st.surge = { n: SURGE, done: 0, retries: 0, t: sim.now, doneAt: null };
    for (let i = 0; i < SURGE; i++) {
      sim.spawn(function* (ctx) {
        yield ctx.wait(Math.round(ctx.rand() * 150));
        const r = yield* send(ctx, 'burst', { bg: true }, 30);
        if (r && r.ok) { const s = ctx.state.surge; s.done++; if (s.done === s.n) s.doneAt = ctx.now(); }
      }, { self: 'phone', quiet: 'all' });
    }
    sim.ui.phone.banner = { title: 'New Year’s Day', body: `${SURGE} other phones start backing up at the same moment.`, tone: 'warn', t: sim.now };
  }

  // Wait in a preset without dispatching: a spawned flow that acts later.
  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'phone', quiet: 'all' });

  const sc = (SDL.scenarios['gp-backup'] = {
    id: 'gp-backup',
    seed: 1601,
    minHopMs: 5,
    productWidth: 760,
    intro: 'Take a photo on Maya’s phone and watch it back up: hash check, resumable chunks, then the create. The laptop sees it through the change log, the labeller makes it searchable, and the album add reaches Omar. Then drop the network, lose a reply, or let the battery die.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'phone', label: 'Maya’s phone', sub: 'Camera roll + backup', kind: 'client', x: 90, y: 90, latency: 1, role: 'Hashes each photo, uploads it in a resumable session, and creates the item with a client id. Shows “Backed up” only after the create commits.', ops: [], owns: ['The originals until backed up', 'Client ids'] },
        { id: 'laptop', label: 'Maya’s laptop', sub: 'Web library', kind: 'client', x: 90, y: 310, latency: 1, role: 'Follows the change log, loads thumbnails from the CDN, and searches.', owns: ['Its change-log cursor'] },
        { id: 'omar', label: 'Omar’s phone', sub: 'Shared album', kind: 'client', x: 90, y: 510, latency: 1, role: 'Member of Maya’s “Goa trip” album.', ops: [{ name: 'albumUpdate', desc: 'A photo was added to an album.' }], owns: ['Nothing'] },
        { id: 'gateway', label: 'Edge', sub: 'Auth, routing, shedding', kind: 'gateway', x: 300, y: 200, latency: 3, role: `Routes requests and refuses uploads with 503 and Retry-After when the upload service has more than ${SHED_MS} ms of queue.`, ops: [{ name: 'chunk', desc: 'Forward a chunk.' }, { name: 'create', desc: 'Forward a create.' }], owns: ['Nothing durable'] },
        { id: 'upload', label: 'Upload service', sub: 'Resumable sessions', kind: 'service', x: 520, y: 90, latency: 4, serviceMs: 20, servers: 4, role: 'Opens upload sessions, appends chunks at the committed offset, and returns an upload token once every byte is durable. 4 workers, about 200 requests a second.', ops: [{ name: 'start', desc: 'Open a session.' }, { name: 'chunk', desc: 'Append bytes at an offset.' }, { name: 'status', desc: 'Committed offset.' }, { name: 'finish', desc: 'Seal and return a token.' }], owns: ['sessions'] },
        { id: 'blob', label: 'Blob store', sub: 'Originals + thumbnails', kind: 'store', x: 760, y: 90, latency: 8, role: 'Content-addressed bytes. Written before any item points at them.', ops: [{ name: 'put', desc: 'Write bytes.' }, { name: 'get', desc: 'Read an original.' }, { name: 'thumb', desc: 'Read a thumbnail.' }], owns: ['blobs[hash]'] },
        { id: 'library', label: 'Photos API', sub: 'Create, attach, search', kind: 'service', x: 520, y: 290, latency: 4, role: 'Creates library items from upload tokens. With a client id, a retried create returns the item it already made.', ops: [{ name: 'create', desc: 'Create an item.' }, { name: 'search', desc: 'Search my photos.' }], owns: ['Client-id map'] },
        { id: 'metadb', label: 'Metadata store', sub: 'Items + change log', kind: 'db', x: 760, y: 290, latency: 8, queue: 'changes', role: 'Library items, albums, and quota for each user. Every write appends to the user’s change log in the same transaction.', ops: [{ name: 'insert', desc: 'Insert an item.' }, { name: 'attach', desc: 'Attach bytes to an item.' }], owns: ['items', 'albums', 'change log', 'quota'] },
        { id: 'thumbs', label: 'Thumbnailer', sub: 'Renditions', kind: 'worker', x: 980, y: 190, latency: 4, role: 'Reads the original and writes thumbnails, then records “thumbnail ready” in the change log.', owns: ['Rendition jobs'] },
        { id: 'ml', label: 'Labeller', sub: 'Image labels', kind: 'worker', x: 980, y: 380, latency: 4, role: 'Runs an image model on each new photo and writes labels to the search index. Asynchronous: minutes are acceptable.', owns: ['Label jobs'] },
        { id: 'index', label: 'Search index', sub: 'Per user', kind: 'db', x: 760, y: 510, latency: 6, role: 'Labels per user, queried only within the owner’s library.', ops: [{ name: 'put', desc: 'Index labels.' }, { name: 'query', desc: 'Search.' }], owns: ['labels[user]'] },
        { id: 'share', label: 'Sharing service', sub: 'Albums', kind: 'service', x: 520, y: 510, latency: 4, role: 'Adds items to albums and tells members.', ops: [{ name: 'add', desc: 'Add to an album.' }], owns: ['album members'] },
        { id: 'cdn', label: 'CDN', sub: 'Thumbnails', kind: 'cdn', x: 300, y: 420, latency: 3, role: 'Serves thumbnails close to viewers; fetches from the blob store on a miss.', ops: [{ name: 'get', desc: 'Fetch a thumbnail.' }], owns: ['Cached thumbnails'] },
      ],
      edges: [
        { from: 'phone', to: 'gateway', latency: 50, label: 'mobile network' },
        { from: 'laptop', to: 'gateway', latency: 20 },
        { from: 'gateway', to: 'upload', latency: 3 },
        { from: 'gateway', to: 'library', latency: 3 },
        { from: 'gateway', to: 'share', latency: 3, via: [[400, 510]] },
        { from: 'upload', to: 'blob', latency: 4 },
        { from: 'library', to: 'metadb', latency: 3 },
        { from: 'library', to: 'index', latency: 3, via: [[640, 420], [760, 420]] },
        { from: 'metadb', to: 'thumbs', latency: 3 },
        { from: 'metadb', to: 'ml', latency: 3 },
        { from: 'metadb', to: 'laptop', latency: 20, via: [[760, 360], [200, 360]], label: 'change feed' },
        { from: 'thumbs', to: 'blob', latency: 3 },
        { from: 'thumbs', to: 'metadb', latency: 3 },
        { from: 'ml', to: 'index', latency: 3 },
        { from: 'share', to: 'metadb', latency: 3 },
        { from: 'share', to: 'omar', latency: 40 },
        { from: 'laptop', to: 'cdn', latency: 10 },
        { from: 'omar', to: 'cdn', latency: 10 },
        { from: 'cdn', to: 'blob', latency: 10, via: [[300, 30], [760, 30]] },
      ],
      queues: [
        { id: 'changes', broker: 'metadb', label: 'change log', groups: ['thumbs', 'ml', 'laptop'] },
      ],
    },
    modeLabels: { offline: 'No signal', loseNextReply: 'Loses the next create reply' },
    failures: [
      { id: 'net-drop', node: 'phone', mode: 'offline', duration: 1200, label: 'Network drop (1.2 s)', desc: 'The phone loses signal mid-upload. The chunk in flight is lost.' },
      { id: 'upload-down', node: 'upload', mode: 'down', label: 'Upload service down', desc: 'Sessions cannot open; the phone backs off and keeps the photo.' },
      { id: 'blob-slow', node: 'blob', mode: 'slow', params: { factor: 15 }, label: 'Blob store slow', desc: 'Each chunk takes much longer to land.' },
      { id: 'metadb-down', node: 'metadb', mode: 'down', label: 'Metadata store down', desc: 'Bytes upload, but the create fails and is retried. No “Backed up” until it commits.' },
      { id: 'lose-reply', node: 'library', mode: 'loseNextReply', label: 'Photos API loses a create reply', desc: 'The item is committed but the reply never reaches the phone, which retries.' },
      { id: 'thumbs-down', node: 'thumbs', mode: 'down', label: 'Thumbnailer down', desc: 'New photos appear as grey tiles until it returns.' },
      { id: 'ml-backlog', node: 'ml', mode: 'paused', label: 'Labelling backlog', desc: 'The labeller is busy elsewhere: new photos are listed but not searchable.' },
      { id: 'cdn-down', node: 'cdn', mode: 'down', label: 'CDN down', desc: 'Thumbnails fail to load on the laptop and on Omar’s phone.' },
      { id: 'battery', node: 'phone', mode: 'down', label: 'Phone battery dies', desc: 'The phone stops mid-upload and stays off.' },
    ],
    switches: Y.switches([
      ['resumable', 'Resumable upload sessions', 'After a drop, ask the server for the committed offset and send only the rest. Off: start the whole file again.'],
      ['bytesFirst', 'Create the item only after the bytes are durable', 'Upload, get a token, then create. Off: create the item first and attach bytes later, so every device lists a photo that may never have bytes.'],
      ['idem', 'Client id on create', 'The phone sends a client id; a retried create returns the existing item. Off: each retry makes a new item.'],
      ['jitter', 'Jitter on retries', 'Refused phones wait Retry-After plus a random spread. Off: they all return after exactly Retry-After.'],
    ]),
    presets: Y.presets({ resumable: true, bytesFirst: true, idem: true, jitter: true }, [
      { id: 'happy-path', label: 'Take a photo, search it, share it', desc: 'The dog photo backs up in about half a second, appears on the laptop with its thumbnail, becomes searchable for “dog”, and reaches Omar through the album.', run: (s) => { takePhoto(s); later(s, 1500, share); later(s, 2500, (x) => search(x, 'dog')); } },
      { id: 'drop-and-resume', label: 'Network drop during a video, resumable', desc: 'A 40 MB video loses signal for 1.2 s. The phone asks for the committed offset and sends only the rest: about 44 MB over the radio.', run: (s) => { takePhoto(s, { video: true }); later(s, 1500, (x) => x.inject('phone', 'offline', true, 1200)); } },
      { id: 'no-resume', label: 'Network drop during a video, no resume', desc: 'Same drop without resumable sessions. The phone starts the 40 MB again from zero: it finishes, late, after sending half as much again.', sw: { resumable: false }, run: (s) => { takePhoto(s, { video: true }); later(s, 1500, (x) => x.inject('phone', 'offline', true, 1200)); } },
      { id: 'lost-ack-idempotent', label: 'Create reply lost, with a client id', desc: 'The item commits but the reply is lost. The phone retries with the same client id and gets the same item back. One photo, charged once.', run: (s) => { s.inject('library', 'loseNextReply'); takePhoto(s); } },
      { id: 'lost-ack-duplicate', label: 'Create reply lost, no client id', desc: 'Same lost reply. The retry has nothing to match on, so the API makes a second item: the photo appears twice and Maya’s quota is charged twice.', sw: { idem: false }, run: (s) => { s.inject('library', 'loseNextReply'); takePhoto(s); } },
      { id: 'battery-bytes-first', label: 'Battery dies mid-upload, bytes first', desc: 'The phone dies during the video. Nothing was created, so no device lists a photo that is not there. It is still on the phone, marked “waiting”.', run: (s) => { takePhoto(s, { video: true }); later(s, 900, (x) => x.inject('phone', 'down')); } },
      { id: 'metadata-first', label: 'Battery dies mid-upload, metadata first', desc: 'The item was created before any bytes. The phone dies; the laptop lists a video that has no bytes and never will.', sw: { bytesFirst: false }, run: (s) => { takePhoto(s, { video: true }); later(s, 900, (x) => x.inject('phone', 'down')); } },
      { id: 'thumbs-down', label: 'Thumbnailer down', desc: 'The photo backs up and the laptop lists it, but as a grey tile: no thumbnail until the thumbnailer is restored.', run: (s) => { s.inject('thumbs', 'down'); takePhoto(s); later(s, 2500, (x) => search(x, 'dog')); } },
      { id: 'ml-backlog', label: 'Labelling backlog', desc: 'The photo is backed up and visible on the laptop, but a search for “dog” finds nothing: labels are asynchronous and the labeller is behind.', run: (s) => { s.inject('ml', 'paused'); takePhoto(s); later(s, 2500, (x) => search(x, 'dog')); } },
      { id: 'holiday-surge-jitter', label: 'New Year’s surge, retries with jitter', desc: `${SURGE} phones start at once against about 200 uploads a second. The edge refuses the overflow with Retry-After; refused phones spread their return over a window that widens with each refusal
 and the backlog drains in a few seconds.`, run: (s) => { surge(s); takePhoto(s); } },
      { id: 'holiday-surge-sync-retry', label: 'New Year’s surge, retries in lockstep', desc: 'Same surge, but every refused phone returns after exactly Retry-After. Each wave arrives together, a few dozen get in, the rest are refused again.', sw: { jitter: false }, run: (s) => { surge(s); takePhoto(s); } },
    ]),
    initialState: () => ({
      config: { resumable: true, bytesFirst: true, idem: true, jitter: true },
      local: {},
      items: {
        o1: { id: 'o1', name: 'Lake at dawn', hash: 'ho1', size: 4, labels: ['lake'], hue: 160, glyph: '🏞', blob: true, thumb: true, clientId: 'old-1', old: true },
        o2: { id: 'o2', name: 'Ramen', hash: 'ho2', size: 4, labels: ['food'], hue: 45, glyph: '🍜', blob: true, thumb: true, clientId: 'old-2', old: true },
      },
      blobs: { ho1: 4, ho2: 4 },
      sessions: {}, byClient: {}, clientItems: {}, index: { o1: ['lake'], o2: ['food'] }, cdn: {}, album: [],
      usedMB: 8,
      surge: null,
      stats: { sentMB: 0, restarts: 0, dedupe: 0, shed: 0, creates: 0 },
      seq: { photo: 0, item: 0, session: 0 },
    }),
    initialUI: () => ({
      phone: { banner: null },
      laptop: { items: ['o1', 'o2'], loaded: { o1: 'ok', o2: 'ok' }, query: '', results: null },
      omar: { album: [], loaded: {}, banner: null },
    }),
    actions: {
      take(sim) { takePhoto(sim); },
      video(sim) { takePhoto(sim, { video: true }); },
      share(sim) { share(sim); },
      search(sim, a) { search(sim, a.q || 'dog'); },
      set: Y.setAction,
    },
    handlers: {
      gateway: (() => {
        const toUpload = (op) => function* (ctx, p) {
          const st = ctx.state;
          if (op === 'chunk') yield ctx.wait(p.len * MS_PER_MB); // radio time for the chunk's bytes
          if (offline(ctx.sim) && !p.bg) ctx.fail('OFFLINE', 'The phone lost signal; the bytes in flight never arrived.');
          if (ctx.sim.queueWait('upload') > SHED_MS) { st.stats.shed++; ctx.fail('OVERLOADED', `503: the upload service has ${SDL.fmtMs(ctx.sim.queueWait('upload'))} of queue. Retry-After: ${RETRY_AFTER / 1000} s.`); }
          return ctx.must(yield ctx.call('upload', op, p, { timeout: 1200, quiet: p.bg ? 'all' : p.quietLog ? true : undefined }));
        };
        const toLibrary = (op) => function* (ctx, p) { return ctx.must(yield ctx.call('library', op, p, { timeout: 800 })); };
        return {
          start: toUpload('start'), chunk: toUpload('chunk'), status: toUpload('status'), finish: toUpload('finish'), burst: toUpload('burst'),
          check: toLibrary('check'), create: toLibrary('create'), attach: toLibrary('attach'), search: toLibrary('search'),
          albumAdd: function* (ctx, p) { return ctx.must(yield ctx.call('share', 'add', p, { timeout: 800 })); },
        };
      })(),
      upload: {
        start(ctx, p) {
          const id = `u${++ctx.state.seq.session}`;
          ctx.state.sessions[id] = { id, hash: p.hash, size: p.size, offset: 0 };
          return { session: id };
        },
        chunk: function* (ctx, p) {
          const s = ctx.state.sessions[p.session];
          if (!s) ctx.fail('NOT_FOUND', 'Unknown session.');
          if (p.offset !== s.offset) ctx.fail('OFFSET_MISMATCH', `The session is at ${s.offset} MB, not ${p.offset} MB.`);
          ctx.must(yield ctx.call('blob', 'put', { hash: s.hash, part: p.offset, len: p.len }, { timeout: 1000, quiet: true }));
          s.offset += p.len;
          return { offset: s.offset };
        },
        status(ctx, p) { const s = ctx.state.sessions[p.session]; if (!s) ctx.fail('NOT_FOUND', 'Unknown session.'); return { offset: s.offset }; },
        finish(ctx, p) {
          const st = ctx.state;
          const s = st.sessions[p.session];
          if (!s || s.offset !== s.size) ctx.fail('INCOMPLETE', 'Not every byte has arrived.');
          st.blobs[s.hash] = s.size;
          return { token: `tok-${s.id}` };
        },
        burst() { return { ok: true }; },
      },
      blob: {
        put() { return { stored: true }; },
        get(ctx, p) { if (!ctx.state.blobs[p.hash]) ctx.fail('NOT_FOUND', 'No bytes for this hash.'); return { size: ctx.state.blobs[p.hash] }; },
        thumb(ctx, p) { const it = ctx.state.items[p.id]; if (!it || !it.thumb) ctx.fail('NOT_FOUND', 'No thumbnail yet.'); return { ok: true }; },
      },
      library: {
        check(ctx, p) {
          const found = Object.values(ctx.state.items).find((x) => x.hash === p.hash && x.blob);
          return { exists: !!found, id: found ? found.id : null };
        },
        create: function* (ctx, p) {
          const st = ctx.state;
          if (st.config.idem && st.byClient[p.clientId]) {
            ctx.log({ op: `create ${p.clientId} again: same item`, status: 'dup', actionId: ctx.actionId, detail: `Client id ${p.clientId} already made ${st.byClient[p.clientId]}. The retry gets that item back; nothing new is written.` });
            return { id: st.byClient[p.clientId], existing: true };
          }
          if (!p.pending && !st.blobs[p.hash]) ctx.fail('BAD_TOKEN', 'The upload token does not point at durable bytes.');
          const r = ctx.must(yield ctx.call('metadb', 'insert', p, { timeout: 600 }));
          if (ctx.mode('loseNextReply')) {
            ctx.sim.restore('library', 'loseNextReply');
            ctx.sim.inject('library', 'dropResponse', true, 40);
          }
          return r;
        },
        attach: function* (ctx, p) { return ctx.must(yield ctx.call('metadb', 'attach', p, { timeout: 600 })); },
        search: function* (ctx, p) { return ctx.must(yield ctx.call('index', 'query', p, { timeout: 600 })); },
      },
      metadb: {
        insert(ctx, p) {
          const st = ctx.state;
          const id = `m${++st.seq.item}`;
          st.items[id] = { id, name: p.name, hash: p.hash, size: p.size, labels: p.labels, hue: p.hue, glyph: p.glyph, blob: !p.pending, thumb: false, clientId: p.clientId, t: ctx.now() };
          if (st.config.idem) st.byClient[p.clientId] = id;
          (st.clientItems[p.clientId] = st.clientItems[p.clientId] || []).push(id);
          st.usedMB += p.size;
          st.stats.creates++;
          ctx.sim.enqueue('changes', { type: 'created', eventId: `c-${id}`, payload: { id }, actionId: ctx.actionId });
          return { id };
        },
        attach(ctx, p) {
          const st = ctx.state;
          const it = st.items[p.id];
          if (!it) ctx.fail('NOT_FOUND', 'No such item.');
          if (!st.blobs[p.hash]) ctx.fail('BAD_TOKEN', 'No bytes yet.');
          it.blob = true;
          ctx.sim.enqueue('changes', { type: 'attached', eventId: `a-${p.id}`, payload: { id: p.id }, actionId: ctx.actionId });
          return { id: p.id };
        },
        thumbReady(ctx, p) {
          ctx.state.items[p.id].thumb = true;
          ctx.sim.enqueue('changes', { type: 'thumb', eventId: `t-${p.id}`, payload: { id: p.id }, actionId: ctx.actionId });
          return { ok: true };
        },
        albumAdd(ctx, p) {
          const st = ctx.state;
          if (!st.items[p.id]) ctx.fail('NOT_FOUND', 'No such item.');
          if (!st.album.includes(p.id)) st.album.push(p.id);
          return { album: 'Goa trip' };
        },
      },
      index: {
        put(ctx, p) { ctx.state.index[p.id] = p.labels.slice(); return { ok: true }; },
        query(ctx, p) { const q = String(p.q).toLowerCase(); return { ids: Object.keys(ctx.state.index).filter((id) => ctx.state.index[id].includes(q) && ctx.state.items[id]) }; },
      },
      share: {
        add: function* (ctx, p) {
          ctx.must(yield ctx.call('metadb', 'albumAdd', p, { timeout: 600 }));
          ctx.must(yield ctx.call('omar', 'albumUpdate', p, { timeout: 800 }));
          return { ok: true };
        },
      },
      cdn: {
        get: function* (ctx, p) {
          const st = ctx.state;
          if (st.cdn[p.id]) return { hit: true };
          ctx.must(yield ctx.call('blob', 'thumb', p, { timeout: 600 }));
          st.cdn[p.id] = true;
          return { hit: false };
        },
      },
      omar: {
        albumUpdate(ctx, p) {
          const ui = ctx.ui.omar;
          if (!ui.album.includes(p.id)) ui.album.push(p.id);
          ui.banner = { title: 'Goa trip', body: 'Maya added a photo.', tone: 'ok', t: ctx.now() };
          ctx.spawn((c) => loadThumb(c, 'omar', p.id), { self: 'omar' });
          return { shown: true };
        },
      },
    },
    setup(sim) {
      // Thumbnailer: read the original, write renditions, record "thumbnail ready".
      Y.consumer(sim, 'changes', 'thumbs', 'thumbs', function* (ctx, msg) {
        const st = ctx.state;
        if (msg.type !== 'created' && msg.type !== 'attached') return true;
        const it = st.items[msg.payload.id];
        if (!it.blob) {
          ctx.log({ op: `${it.id}: no bytes to render`, status: 'warn', actionId: msg.actionId, detail: 'The item exists but its bytes have not arrived. Nothing to make a thumbnail from.' });
          return true;
        }
        const r = yield ctx.call('blob', 'get', { hash: it.hash }, { timeout: 800, actionId: msg.actionId });
        if (!r.ok) return false;
        yield ctx.wait(80);
        const w = yield ctx.call('metadb', 'thumbReady', { id: it.id }, { timeout: 600, actionId: msg.actionId });
        return w.ok;
      });
      // Labeller: image model, then the search index.
      Y.consumer(sim, 'changes', 'ml', 'ml', function* (ctx, msg) {
        const st = ctx.state;
        if (msg.type !== 'created' && msg.type !== 'attached') return true;
        const it = st.items[msg.payload.id];
        if (!it.blob) return true;
        yield ctx.wait(250);
        const r = yield ctx.call('index', 'put', { id: it.id, labels: it.labels }, { timeout: 600, actionId: msg.actionId });
        if (r.ok) { it.labelled = ctx.now(); ctx.sim.setLedger(msg.actionId, 'async', 'yes', 'Thumbnail and labels done.'); }
        return r.ok;
      });
      // The laptop follows the change log.
      Y.consumer(sim, 'changes', 'laptop', 'laptop', function* (ctx, msg) {
        const ui = ctx.ui.laptop;
        const id = msg.payload.id;
        if (!ui.items.includes(id)) ui.items.push(id);
        if (msg.type === 'thumb') ctx.spawn((c) => loadThumb(c, 'laptop', id), { self: 'laptop' });
        return true;
      });
    },
    consistency(sim) {
      const st = sim.state;
      const dupe = Object.entries(st.clientItems).find(([, ids]) => ids.length > 1);
      if (dupe) return { key: 'wrong', label: `One photo became ${dupe[1].length} library items (${dupe[1].join(', ')}): the create was retried with nothing to match on. Maya sees it twice and is charged ${dupe[1].length * st.items[dupe[1][0]].size} MB for ${st.items[dupe[1][0]].size} MB.` };
      const ghosts = Object.values(st.items).filter((x) => !x.blob);
      if (ghosts.length && phoneDead(sim)) return { key: 'wrong', label: `The laptop lists “${ghosts[0].name}”, but the blob store has no bytes for it and the only copy was on a phone that is now off. The library claims a photo it cannot show.` };
      if (st.surge && st.surge.done < st.surge.n) return { key: 'stale', label: `${st.surge.n - st.surge.done} of ${st.surge.n} phones are still waiting after ${st.surge.retries} refused retries. ${st.config.jitter ? 'The backlog is draining.' : 'Retries arrive in waves at exactly Retry-After; each wave overloads the service again.'}` };
      const local = Object.values(st.local);
      if (phoneDead(sim) && local.some((x) => x.state !== 'backed')) return { key: 'ok', label: 'The phone died mid-upload. Nothing was created, so no device lists a photo without bytes. The original is still on the phone, marked “waiting”, and backs up when it turns on.' };
      if (ghosts.length) return { key: 'stale', label: `“${ghosts[0].name}” is listed before its bytes arrived (metadata first). It looks backed up on the laptop but is not yet.` };
      const pending = local.filter((x) => x.state !== 'backed');
      if (pending.length) return { key: 'stale', label: `${pending.length} item${pending.length > 1 ? 's are' : ' is'} still backing up.` };
      const fresh = Object.values(st.items).filter((x) => !x.old);
      const noThumb = fresh.filter((x) => !x.thumb);
      if (noThumb.length) return { key: 'stale', label: `${noThumb.length} backed-up photo${noThumb.length > 1 ? 's show' : ' shows'} as a grey tile: the thumbnailer has not made a rendition.` };
      const noLabels = fresh.filter((x) => !x.labelled);
      if (noLabels.length) return { key: 'stale', label: `“${noLabels[0].name}” is backed up and visible, but not searchable yet: labels come later from the labeller.` };
      const waste = local.find((x) => x.sent > x.size * 1.3);
      if (waste) return { key: 'stale', label: `${waste.name} is backed up, but ${waste.sent} MB went over the radio for ${waste.size} MB: the upload restarted from zero after the drop.` };
      const badTile = sim.ui.laptop.items.find((id) => sim.ui.laptop.loaded[id] === 'failed');
      if (badTile) return { key: 'stale', label: 'Thumbnails fail to load: the CDN is down.' };
      if (st.surge) return { key: 'ok', label: `All ${st.surge.n} phones finished in ${SDL.fmtMs(st.surge.doneAt - st.surge.t)}, with ${st.surge.retries} refused retries spread out by jitter.` };
      if (!local.length) return { key: 'ok', label: 'Take a photo to start.' };
      return { key: 'ok', label: 'Every photo was created once, after its bytes were durable, and is visible, searchable, and shareable.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const local = Object.values(st.local);
      const backed = local.filter((x) => x.state === 'backed');
      const size = local.reduce((a, x) => a + x.size, 0);
      const dupes = Object.values(st.clientItems).reduce((a, ids) => a + ids.length - 1, 0);
      const vis = backed.map((x) => x.at - x.t);
      return [
        { label: 'Backed up', value: `${backed.length} of ${local.length}` },
        { label: 'Radio MB per file MB', value: size ? (st.stats.sentMB / size).toFixed(2) : '–', tone: size && st.stats.sentMB / size > 1.3 ? 'warn' : '' },
        { label: 'Time to backed up', value: vis.length ? SDL.fmtMs(Math.max(...vis)) : '–' },
        { label: 'Library items', value: Object.keys(st.items).length },
        { label: 'Duplicates', value: dupes, tone: dupes ? 'fail' : '' },
        { label: 'Quota used', value: `${st.usedMB} MB` },
        { label: 'Refused (503)', value: st.stats.shed, tone: st.stats.shed ? 'warn' : '' },
        { label: 'Upload queue', value: SDL.fmtMs(sim.queueWait('upload')), tone: sim.queueWait('upload') > SHED_MS ? 'fail' : '' },
        { label: 'Change log depth', value: sim.queueStats('changes').depth },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone'], ['laptop', 'Maya’s laptop (web)'], ['omar', 'Omar’s phone']], {
          note: 'Take a photo on the phone. The badge says “Backed up” only once the library item is committed. The laptop follows Maya’s change log; Omar sees the “Goa trip” album.',
          below: '<div class="ops-console" data-ref="status"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const tile = (it, state, label) => {
          const style = state === 'ok' ? '' : state === 'ghost' ? 'filter:grayscale(1);opacity:.35' : state === 'failed' ? 'filter:grayscale(1);opacity:.45' : 'background:var(--surface-2,#8884);filter:grayscale(1)';
          const g = state === 'ok' ? it.glyph : state === 'ghost' ? '?' : state === 'failed' ? '✕' : '…';
          return `<div style="min-width:0"><div class="yt-thumb" style="--h:${it.hue};aspect-ratio:1;font-size:18px;${style}"><span aria-hidden="true">${g}</span></div><span class="app-sub" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span></div>`;
        };
        const grid = (inner) => `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px">${inner}</div>`;
        // Phone
        const badge = { waiting: '⏳ Waiting', uploading: '↑ Backing up', paused: '⚠ No signal', backed: '☁ Backed up' };
        const local = Object.values(st.local).slice(-6).reverse();
        const grid2 = (inner) => `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">${inner}</div>`;
        const roll = local.length ? grid2(local.map((x) => tile(x, 'ok', `${badge[x.state]}${x.state === 'uploading' ? ` ${Math.round((x.offset / x.size) * 100)}%` : ''}`)).join('')) : '<p class="app-sub">No new photos.</p>';
        const camera = `<div class="app-row">${Y.btn('take', '📷 Take photo', { disabled: phoneDead(sim) })}${Y.btn('video', '🎞 Record video', { cls: 'secondary', disabled: phoneDead(sim) })}</div>`;
        const shareBtn = `<div class="app-row">${Y.btn('share', 'Add newest to “Goa trip”', { cls: 'secondary', disabled: !Object.values(st.local).some((x) => x.state === 'backed') })}</div>`;
        const pend = Object.values(st.local).filter((x) => x.state !== 'backed').length;
        Y.paint(el, sim, 'phone', { head: `<div><p class="app-title">Photos</p><p class="app-sub">${pend ? `Backing up ${pend} item${pend > 1 ? 's' : ''}` : 'Backup complete'} · ${st.usedMB} MB of 15 GB</p></div>`, camera, roll, shareBtn }, {}, sim.ui.phone.banner);
        // Laptop
        const lp = sim.ui.laptop;
        const lt = lp.items.slice(-6).reverse().map((id) => {
          const it = st.items[id];
          const state = !it.blob ? 'ghost' : lp.loaded[id] === 'ok' ? 'ok' : lp.loaded[id] === 'failed' ? 'failed' : 'grey';
          return tile(it, state, !it.blob ? 'No bytes' : it.name);
        }).join('');
        const qs = `<div class="app-row">${Y.btn('search', 'Search “dog”', { arg: { q: 'dog' }, cls: 'secondary' })}</div>`;
        const res = lp.results == null ? '' : `<p class="app-sub">“${esc(lp.query)}”: ${lp.results.length ? lp.results.map((id) => esc(st.items[id].name)).join(', ') : 'no results'}</p>`;
        Y.paint(el, sim, 'laptop', { head: `<div><p class="app-title">Library</p><p class="app-sub">${lp.items.length} items</p></div>`, qs, res, grid: grid(lt) }, {});
        // Omar
        const om = sim.ui.omar;
        const at = om.album.map((id) => tile(st.items[id], om.loaded[id] === 'ok' ? 'ok' : om.loaded[id] === 'failed' ? 'failed' : 'grey', st.items[id].name)).join('');
        Y.paint(el, sim, 'omar', { head: '<div><p class="app-title">Goa trip</p><p class="app-sub">Shared by Maya</p></div>', grid: at ? grid(at) : '<p class="app-sub">No photos yet.</p>' }, {}, om.banner);
        // Status
        const c = sim.scenario.consistency(sim);
        const qd = sim.queueStats('changes').depth;
        const rows = `<div class="ops-shards">
          <div class="ops-row" data-tone="${sim.queueWait('upload') > SHED_MS ? 'fail' : ''}"><div class="ops-name">Upload service<span>${SDL.fmtMs(sim.queueWait('upload'))} queue · ${st.stats.shed} refused with 503${st.surge ? ` · surge ${st.surge.done} of ${st.surge.n} done` : ''}</span></div></div>
          <div class="ops-row"><div class="ops-name">Blob store and library<span>${Object.keys(st.blobs).length} blobs · ${Object.keys(st.items).length} items · ${st.usedMB} MB charged</span></div></div>
          <div class="ops-row" data-tone="${qd ? 'warn' : ''}"><div class="ops-name">Change log<span>${qd} entr${qd === 1 ? 'y' : 'ies'} waiting for the thumbnailer, labeller, or laptop</span></div></div></div>`;
        SDL.ui.paintSections(el.querySelector('[data-ref="status"]'), {
          title: '<p class="ops-title">Backend</p>',
          rows,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });

  /** A viewer loads a thumbnail through the CDN, retrying while it fails. */
  function* loadThumb(ctx, who, id) {
    for (let a = 0; a < 12; a++) {
      const r = yield ctx.call('cdn', 'get', { id }, { timeout: 800, quiet: a > 0 ? 'all' : undefined });
      ctx.ui[who].loaded[id] = r.ok ? 'ok' : 'failed';
      if (r.ok) return;
      yield ctx.wait(600);
    }
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
