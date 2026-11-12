/*
 * Media upload and processing.
 * A photo is uploaded in chunks to a resumable session while the caption is
 * typed. Completion hands the original to resize workers that produce the
 * renditions the feed serves through the CDN; until they exist the post shows
 * a tiny blurred placeholder. The upload service deduplicates identical
 * photos by content hash. A viral post makes thousands of phones miss the
 * CDN at once; request coalescing decides whether the rendition store
 * survives.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const CHUNKS = 4;
  const CHUNK_MS = 220; // one 512 KB chunk on a mobile connection
  const CROWD = 500; // image loads per second when a post goes viral
  const CDN_TTL = 2000; // edge caches keep a rendition briefly here, so the miss storm repeats
  const RESIZE_MS = 500; // decoding and resizing one original
  const PHOTOS = { sunset: { label: 'Sunset.jpg', hash: 'h-sunset', hue: 200 }, coffee: { label: 'Coffee.jpg', hash: 'h-coffee', hue: 30 } };

  const online = (sim) => !sim.nodes.maya.modes.down;

  function startPick(sim, photo) {
    const u = sim.ui.maya;
    if (u.busy) return;
    const st = sim.state;
    const key = 'up-' + ++st.seq.key;
    sim.startAction(`Maya: pick ${PHOTOS[photo].label}`, function* (ctx) {
      const v = ctx.ui.maya;
      Object.assign(v, { busy: true, photo, parts: new Array(CHUNKS).fill('empty'), status: 'Checking…', mediaId: null, wasted: 0 });
      Y.L(ctx, { displayed: ['yes', 'The picker closes at once; upload runs behind the caption box.'], retrySafe: ['yes', 'Chunks and completion are idempotent per upload session.'] });
      const t0 = ctx.now();
      // Content hash first: an identical photo may already be stored.
      const h = yield ctx.call('upload', 'lookup', { hash: PHOTOS[photo].hash }, { timeout: 800 });
      if (h.ok && h.value.mediaId) {
        Object.assign(v, { mediaId: h.value.mediaId, parts: new Array(CHUNKS).fill('skipped'), status: 'Already uploaded: identical photo found', busy: false, uploadMs: ctx.now() - t0 });
        st.stats.dedupeHits++;
        Y.L(ctx, { accepted: 'yes', committed: ['yes', `Reusing ${h.value.mediaId}.`], async: 'n/a' });
        ctx.explain('The phone sent the photo’s content hash before any bytes. The upload service already had a media record with that hash, so nothing was transferred: the share will reuse the existing renditions.');
        return;
      }
      let s = yield ctx.call('upload', 'create', { key, hash: PHOTOS[photo].hash }, { timeout: 1000 });
      if (!s.ok) { Object.assign(v, { busy: false, status: `Couldn’t start the upload: ${s.error.message}` }); Y.failed(ctx); return; }
      let uploadId = s.value.uploadId;
      let n = 0;
      while (n < CHUNKS) {
        if (!online(ctx.sim)) {
          v.parts[n] = 'failed';
          v.status = 'Offline: waiting for the network…';
          while (!online(ctx.sim)) yield ctx.wait(150);
          if (st.config.resumable) {
            const r = yield ctx.call('upload', 'status', { uploadId }, { timeout: 800 });
            if (r.ok) { n = r.value.received; ctx.log({ op: `resume at chunk ${n + 1}`, status: 'recovered', detail: `The session already holds ${n} of ${CHUNKS} chunks; only the rest are sent.` }); }
          } else {
            st.stats.wasted += n;
            v.wasted += n;
            ctx.log({ op: 'restart from scratch', status: 'retry', detail: `No resumable session: the ${n} chunk${n === 1 ? '' : 's'} already sent are thrown away.` });
            v.parts = new Array(CHUNKS).fill('empty');
            s = yield ctx.call('upload', 'create', { key: `${key}-r${st.stats.wasted}`, hash: PHOTOS[photo].hash }, { timeout: 1000 });
            if (!s.ok) { Object.assign(v, { busy: false, status: 'Upload failed.' }); Y.failed(ctx); return; }
            uploadId = s.value.uploadId;
            n = 0;
          }
          continue;
        }
        v.parts[n] = 'sending';
        v.status = `Uploading chunk ${n + 1} of ${CHUNKS}…`;
        yield ctx.wait(CHUNK_MS);
        if (!online(ctx.sim)) continue;
        const r = yield ctx.call('upload', 'chunk', { uploadId, n }, { timeout: 1200 });
        st.stats.chunks++;
        if (r.ok) { v.parts[n] = 'done'; n++; } else { v.parts[n] = 'failed'; yield ctx.wait(300); }
      }
      v.status = 'Finishing…';
      let c = yield ctx.call('upload', 'complete', { uploadId }, { timeout: 1500 });
      if (!c.ok && c.error.code === 'TIMEOUT') {
        ctx.log({ op: 'completion reply lost: retrying', status: 'retry', detail: 'The app does not know whether the session was completed, so it asks again.' });
        c = yield ctx.call('upload', 'complete', { uploadId }, { timeout: 1500 });
      }
      if (!c.ok) { Object.assign(v, { busy: false, status: `Couldn’t finish the upload: ${c.error.message}` }); Y.failed(ctx); return; }
      Object.assign(v, { mediaId: c.value.mediaId, status: 'Uploaded, ready to share', busy: false, uploadMs: ctx.now() - t0 });
      Y.L(ctx, { accepted: 'yes', committed: ['yes', `${c.value.mediaId} in the object store.`], async: 'n/a' });
      ctx.explain(`${CHUNKS} chunks went up in ${((ctx.now() - t0) / 1000).toFixed(1)} s while Maya typed. Completion returned media id ${c.value.mediaId}${c.value.replayed ? ' again: the retry was recognised as the same session' : ''}. Share will only have to reference it.`);
    }, { self: 'maya' });
  }

  function startShare(sim) {
    const u = sim.ui.maya;
    if (!u.photo || u.sharing) return;
    sim.startAction('Maya: share', function* (ctx) {
      const st = ctx.state;
      const v = ctx.ui.maya;
      const t0 = ctx.now();
      v.sharing = true;
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      while (v.busy) { v.status = 'Waiting for the upload to finish…'; yield ctx.wait(50); }
      if (!v.mediaId) { v.sharing = false; Y.failed(ctx, 'Nothing to share.'); return; }
      const r = yield ctx.call('posts', 'create', { mediaId: v.mediaId, photo: v.photo }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, ctx.now() - t0);
      v.sharing = false;
      if (r.ok) {
        Object.assign(v, { shareMs: ctx.now() - t0, posted: r.value.postId, photo: null, mediaId: null, parts: [], status: '' });
        st.posts[r.value.postId].actionId = ctx.actionId;
        Y.L(ctx, { displayed: ['yes', `Shared in ${Math.round(ctx.now() - t0)} ms.`], accepted: 'yes', committed: ['yes', `Post ${r.value.postId}.`], async: r.value.ready ? ['yes', 'Renditions already existed.'] : ['pending', 'Resize workers are producing the renditions.'] });
        ctx.explain(r.value.ready
          ? 'The media already had renditions (an identical photo was processed before), so the post is complete at once.'
          : `The post exists now, pointing at the original. Resize workers will produce the feed renditions in a moment; ${st.config.placeholder ? 'until then followers see a tiny blurred placeholder encoded in the post itself' : 'until then the post is hidden from feeds'}.`);
      } else { v.status = `Couldn’t share: ${r.error.message}`; Y.failed(ctx); }
    }, { self: 'maya' });
  }

  function setViral(sim, on) {
    sim.state.viral = on;
    sim.note(on ? `The post goes viral: ${CROWD} phones a second load its image.` : 'The rush is over.');
  }

  const sc = (SDL.scenarios['ig-media'] = {
    id: 'ig-media',
    seed: 629,
    productWidth: 620,
    intro: 'Pick a photo on Maya’s phone and watch the chunks go up while she types, then share. Dev sees a blurred placeholder until the resize workers finish. Then interrupt the upload, take the workers down, pick the same photo twice, or make the post go viral.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'Uploads', kind: 'client', x: 90, y: 90, latency: 1, role: 'Hashes, uploads in chunks, shares. Can lose the network.', owns: ['Draft'] },
        { id: 'dev', label: 'Dev’s phone', sub: 'Views the post', kind: 'client', x: 90, y: 330, latency: 1, role: 'Refreshes the feed every second and loads images through the CDN.', owns: ['What Dev sees'] },
        { id: 'crowd', label: 'Everyone else', sub: 'Viral traffic', kind: 'client', x: 90, y: 540, latency: 1, role: 'Hundreds of phones a second loading the same image.', owns: ['Nothing'] },
        { id: 'upload', label: 'Upload service', sub: 'Resumable sessions', kind: 'service', x: 320, y: 90, latency: 4, role: 'Hash lookup, sessions, chunks, idempotent completion.', ops: [{ name: 'lookup', desc: 'Find media by content hash.' }, { name: 'create', desc: 'Start a session.' }, { name: 'chunk', desc: 'Store a chunk.' }, { name: 'status', desc: 'Chunks received.' }, { name: 'complete', desc: 'Finish a session.' }], owns: ['sessions', 'hash → media'] },
        { id: 'blobs', label: 'Object store', sub: 'Originals', kind: 'store', x: 560, y: 90, latency: 10, role: 'Durable storage for chunks and originals.', ops: [{ name: 'put', desc: 'Store bytes.' }], owns: ['originals'] },
        { id: 'procq', label: 'Processing jobs', sub: 'Queue', kind: 'queue', x: 560, y: 220, latency: 4, queue: 'proc', role: 'One job per new original.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['job log'] },
        { id: 'workers', label: 'Resize workers', sub: 'About 0.5 s per photo', kind: 'worker', x: 800, y: 220, latency: 5, role: 'Decode the original and write thumbnail, feed, and full-size renditions.', ops: [{ name: 'consume', desc: 'Process one original.' }], owns: ['Nothing durable'] },
        { id: 'renditions', label: 'Rendition store', sub: 'Resized images', kind: 'store', x: 800, y: 380, latency: 6, serviceMs: 30, role: 'The images feeds actually show. About 30 reads a second; the CDN is meant to absorb the rest.', ops: [{ name: 'put', desc: 'Store renditions.' }, { name: 'get', desc: 'Read a rendition.' }], owns: ['renditions'] },
        { id: 'cdn', label: 'CDN', sub: 'Edge cache', kind: 'cdn', x: 560, y: 380, latency: 8, role: `Serves renditions, caching each for ${CDN_TTL / 1000} s here; concurrent misses for one image can share a single fetch.`, ops: [{ name: 'get', desc: 'Fetch an image.' }], owns: ['Cached images', 'In-flight misses'] },
        { id: 'posts', label: 'Post service', sub: 'Create, mark ready', kind: 'service', x: 320, y: 330, latency: 4, role: 'Creates the post pointing at the media and flips it to ready when renditions exist.', ops: [{ name: 'create', desc: 'Create a post.' }, { name: 'ready', desc: 'Mark renditions ready.' }, { name: 'feed', desc: 'Dev’s feed.' }], owns: ['posts'] },
      ],
      edges: [
        { from: 'maya', to: 'upload', latency: 40 },
        { from: 'maya', to: 'posts', latency: 40 },
        { from: 'upload', to: 'blobs', latency: 5 },
        { from: 'upload', to: 'procq', latency: 5 },
        { from: 'procq', to: 'workers', latency: 4 },
        { from: 'workers', to: 'renditions', latency: 5 },
        { from: 'workers', to: 'posts', latency: 5, label: 'ready', via: [[800, 500], [320, 500]] },
        { from: 'dev', to: 'posts', latency: 40 },
        { from: 'dev', to: 'cdn', latency: 25, via: [[200, 420], [560, 420]] },
        { from: 'crowd', to: 'cdn', latency: 25 },
        { from: 'cdn', to: 'renditions', latency: 20, label: 'miss' },
      ],
      queues: [{ id: 'proc', broker: 'procq', label: 'processing', groups: ['workers'] }],
    },
    failures: [
      { id: 'offline', node: 'maya', mode: 'down', label: 'Maya loses the network', desc: 'Chunks in flight fail; the upload waits.' },
      { id: 'workers-down', node: 'workers', mode: 'down', label: 'Resize workers down', desc: 'Posts stay unprocessed.' },
      { id: 'upload-drop', node: 'upload', mode: 'dropResponse', label: 'Upload service replies lost', desc: 'Completion is retried.' },
      { id: 'blobs-slow', node: 'blobs', mode: 'slow', params: { factor: 20 }, label: 'Object store slow', desc: 'Each chunk takes much longer.' },
      { id: 'renditions-slow', node: 'renditions', mode: 'slow', params: { factor: 4 }, label: 'Rendition store slow', desc: 'Misses take longer; stampedes hurt more.' },
      { id: 'cdn-down', node: 'cdn', mode: 'down', label: 'CDN down', desc: 'No images load.' },
    ],
    switches: Y.switches([
      ['resumable', 'Resumable sessions', 'After a network drop, ask which chunks arrived and send only the rest. Off: start the upload again.'],
      ['placeholder', 'Blurred placeholder', 'Show the post at once with a tiny blurred preview until renditions are ready. Off: hide it until then.'],
      ['dedupe', 'Deduplicate by content hash', 'Send the hash first; reuse existing media for an identical photo. Off: upload every time.'],
      ['coalesce', 'Coalesce CDN misses', 'Concurrent misses for one image share one fetch from the rendition store. Off: every miss fetches.'],
      ['idemComplete', 'Idempotent completion', 'Completing a session twice returns the same media. Off: a retried completion creates a second media and a second job.'],
    ]),
    presets: Y.presets({ resumable: true, placeholder: true, dedupe: true, coalesce: true, idemComplete: true }, [
      { id: 'share', label: 'Pick, upload, share, process', desc: 'Four chunks go up while Maya types; Share is instant; Dev sees a blurred placeholder for about a second, then the real image.', run: (s) => { startPick(s, 'sunset'); s.schedule(1800, () => startShare(s)); } },
      { id: 'no-placeholder', label: 'Same, no placeholder', desc: 'The post is hidden from Dev until the renditions exist.', sw: { placeholder: false }, run: (s) => { startPick(s, 'sunset'); s.schedule(1800, () => startShare(s)); } },
      { id: 'resume', label: 'Network drops mid-upload, resumable', desc: 'Maya is offline for a second after two chunks. The session remembers them; only the rest are sent.', run: (s) => { startPick(s, 'sunset'); s.schedule(500, () => s.inject('maya', 'down', true, 1000)); s.schedule(3500, () => startShare(s)); } },
      { id: 'restart', label: 'Network drops, no resumable session', desc: 'The two chunks already sent are thrown away and the upload starts again.', sw: { resumable: false }, run: (s) => { startPick(s, 'sunset'); s.schedule(500, () => s.inject('maya', 'down', true, 1000)); s.schedule(3500, () => startShare(s)); } },
      { id: 'workers-down', label: 'Resize workers down', desc: 'The post exists but its renditions never arrive: Dev’s placeholder stays blurred.', run: (s) => { s.inject('workers', 'down'); startPick(s, 'sunset'); s.schedule(1800, () => startShare(s)); } },
      { id: 'dedupe', label: 'Same photo twice, deduplicated', desc: 'The second pick sends only a hash; the media and its renditions are reused and the share is complete at once.', run: (s) => { startPick(s, 'sunset'); s.schedule(1800, () => startShare(s)); s.schedule(3500, () => startPick(s, 'sunset')); s.schedule(4200, () => startShare(s)); } },
      { id: 'dedupe-off', label: 'Same photo twice, uploaded twice', desc: 'Four more chunks, another original, another processing job for bytes the store already had.', sw: { dedupe: false }, run: (s) => { startPick(s, 'sunset'); s.schedule(1800, () => startShare(s)); s.schedule(3500, () => startPick(s, 'sunset')); s.schedule(5000, () => startShare(s)); } },
      { id: 'complete-twice', label: 'Completion reply lost, idempotent', desc: 'The session completes but the reply is lost; the retry returns the same media id. One original, one job.', run: (s) => { s.schedule(1650, () => s.inject('upload', 'dropResponse', true, 500)); startPick(s, 'sunset'); s.schedule(2800, () => startShare(s)); } },
      { id: 'complete-twice-bad', label: 'Completion reply lost, not idempotent', desc: 'The retried completion creates a second media and a second processing job for the same bytes.', sw: { idemComplete: false }, run: (s) => { s.schedule(1650, () => s.inject('upload', 'dropResponse', true, 500)); startPick(s, 'sunset'); s.schedule(2800, () => startShare(s)); } },
      { id: 'viral', label: 'Post goes viral, misses coalesced', desc: 'Five hundred phones a second want the image. Each time the edge cache expires, the CDN fetches it once and everyone else shares that fetch.', run: (s) => { startPick(s, 'sunset'); s.schedule(1800, () => startShare(s)); s.schedule(2100, () => setViral(s, true)); s.schedule(7000, () => setViral(s, false)); } },
      { id: 'viral-stampede', label: 'Post goes viral, no coalescing', desc: 'Every concurrent miss hits the rendition store: a stampede each time the edge cache expires. Loads time out, Dev’s among them.', sw: { coalesce: false }, run: (s) => { startPick(s, 'sunset'); s.schedule(1800, () => startShare(s)); s.schedule(2100, () => setViral(s, true)); s.schedule(7000, () => setViral(s, false)); } },
    ]),
    initialState: () => ({
      config: { resumable: true, placeholder: true, dedupe: true, coalesce: true, idemComplete: true },
      sessions: {}, media: {}, byHash: {}, posts: {}, cdnCache: {}, inflight: {}, viral: false,
      stats: { chunks: 0, wasted: 0, dedupeHits: 0, jobs: 0, originReads: 0, coalesced: 0, crowdLoads: 0, crowdTimeouts: 0 },
      seq: { key: 0, session: 0, media: 0, post: 0 },
    }),
    initialUI: () => ({
      maya: { photo: null, parts: [], status: '', busy: false, mediaId: null, sharing: false, shareMs: null, uploadMs: null, posted: null, wasted: 0 },
      dev: { feed: [], loaded: {}, loadedAt: {}, imageMs: null },
    }),
    actions: {
      pick(sim, a) { startPick(sim, a.photo || 'sunset'); },
      share(sim) { startShare(sim); },
      viral(sim, a) { setViral(sim, !!a.on); },
      set: Y.setAction,
    },
    handlers: {
      upload: {
        lookup(ctx, p) { const st = ctx.state; return { mediaId: st.config.dedupe ? st.byHash[p.hash] || null : null }; },
        create(ctx, p) { const st = ctx.state; const id = 'u' + ++st.seq.session; st.sessions[id] = { id, key: p.key, hash: p.hash, received: 0, mediaId: null }; return { uploadId: id }; },
        chunk: function* (ctx, p) {
          const s = ctx.state.sessions[p.uploadId];
          ctx.must(yield ctx.call('blobs', 'put', { id: `${p.uploadId}/${p.n}` }, { timeout: 1000 }));
          if (p.n === s.received) s.received++;
          return { received: s.received };
        },
        status(ctx, p) { return { received: ctx.state.sessions[p.uploadId].received }; },
        complete: function* (ctx, p) {
          const st = ctx.state;
          const s = st.sessions[p.uploadId];
          if (s.received < CHUNKS) ctx.fail('INCOMPLETE', `Only ${s.received} of ${CHUNKS} chunks received.`);
          if (st.config.idemComplete && s.mediaId) return { mediaId: s.mediaId, replayed: true };
          const id = 'm' + ++st.seq.media;
          st.media[id] = { id, hash: s.hash, ready: false, t: ctx.now() };
          s.mediaId = id;
          st.byHash[s.hash] = id;
          yield ctx.call('procq', 'publish', { mediaId: id }, { timeout: 600 });
          return { mediaId: id };
        },
      },
      blobs: { put() { return { stored: true }; } },
      procq: { publish(ctx, p) { ctx.state.stats.jobs++; ctx.sim.enqueue('proc', { type: 'media.uploaded', eventId: 'job-' + p.mediaId, payload: p }); return { appended: true }; } },
      renditions: {
        put(ctx, p) { ctx.state.media[p.mediaId].ready = true; return { stored: true }; },
        get(ctx, p) { ctx.state.stats.originReads++; if (!ctx.state.media[p.mediaId] || !ctx.state.media[p.mediaId].ready) ctx.fail('NOT_FOUND', 'No rendition yet.'); return { bytes: 2e5 }; },
      },
      cdn: {
        get: function* (ctx, p) {
          const st = ctx.state;
          const cached = st.cdnCache[p.mediaId];
          if (cached && cached > ctx.now()) return { hit: true };
          if (st.config.coalesce && st.inflight[p.mediaId]) {
            const t0 = ctx.now();
            while (st.inflight[p.mediaId] && ctx.now() - t0 < 1300) yield ctx.wait(10);
            if (st.cdnCache[p.mediaId] > ctx.now()) { st.stats.coalesced++; return { hit: 'coalesced' }; }
          }
          st.inflight[p.mediaId] = true;
          const r = yield ctx.call('renditions', 'get', p, { timeout: 1300 });
          delete st.inflight[p.mediaId];
          ctx.must(r);
          st.cdnCache[p.mediaId] = ctx.now() + CDN_TTL;
          return { hit: false };
        },
      },
      posts: {
        create(ctx, p) {
          const st = ctx.state;
          const id = 'P' + ++st.seq.post;
          const ready = !!(st.media[p.mediaId] && st.media[p.mediaId].ready);
          st.posts[id] = { id, mediaId: p.mediaId, photo: p.photo, t: ctx.now(), ready, readyAt: ready ? ctx.now() : null };
          return { postId: id, ready };
        },
        ready(ctx, p) { const st = ctx.state; for (const post of Object.values(st.posts)) if (post.mediaId === p.mediaId && !post.ready) { post.ready = true; post.readyAt = ctx.now(); if (post.actionId) ctx.sim.setLedger(post.actionId, 'async', 'yes', `Renditions ready ${((ctx.now() - post.t) / 1000).toFixed(1)} s after sharing.`); } return { ok: true }; },
        feed(ctx) { const st = ctx.state; return { posts: Object.values(st.posts).filter((p) => p.ready || st.config.placeholder) }; },
      },
    },
    setup(sim) {
      Y.consumer(sim, 'proc', 'workers', 'workers', function* (ctx, msg) {
        const p = msg.payload;
        yield ctx.wait(RESIZE_MS); // decode and resize
        const r = yield ctx.call('renditions', 'put', { mediaId: p.mediaId }, { timeout: 2000 });
        if (!r.ok) return false;
        yield ctx.call('posts', 'ready', { mediaId: p.mediaId }, { timeout: 600 });
        ctx.log({ op: `renditions for ${p.mediaId} ready`, status: 'ok', detail: 'Thumbnail, feed, and full-size renditions written; the post is complete.' });
        return true;
      }, () => true);
      // Dev’s phone: refresh the feed every second; load each post’s image once it is ready.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(1000);
          const u = ctx.ui.dev;
          const r = yield ctx.call('posts', 'feed', {}, { timeout: 1000, quiet: 'all' });
          if (!r.ok) continue;
          u.feed = r.value.posts;
          for (const post of r.value.posts) {
            const due = post.ready && (!u.loaded[post.id] || (ctx.state.viral && u.loaded[post.id] !== 'loading' && ctx.now() - (u.loadedAt[post.id] || 0) > 2500));
            if (due) {
              u.loaded[post.id] = 'loading';
              u.loadedAt[post.id] = ctx.now();
              ctx.spawn(function* (c) {
                const t0 = c.now();
                const img = yield c.call('cdn', 'get', { mediaId: post.mediaId }, { timeout: 1200, quiet: 'all' });
                c.ui.dev.imageMs = c.now() - t0;
                c.ui.dev.loaded[post.id] = img.ok ? 'ok' : 'failed';
                c.log({ op: `Dev ${img.ok ? 'loaded' : 'failed to load'} ${post.id}’s image`, status: img.ok ? 'ok' : 'err', detail: img.ok ? `${img.value.hit === true ? 'CDN hit' : img.value.hit === 'coalesced' ? 'waited for a fetch already in flight' : 'CDN miss, fetched from the rendition store'} in ${Math.round(c.now() - t0)} ms.` : `${img.error.message}` });
              }, { self: 'dev', quiet: 'all' });
            }
          }
        }
      }, { self: 'dev', quiet: 'all' });
      Y.load(sim, 'crowd', (s) => (s.state.viral ? CROWD : 0), function* (ctx) {
        const st = ctx.state;
        const post = Object.values(st.posts).find((p) => p.ready);
        if (!post) return;
        st.stats.crowdLoads++;
        const r = yield ctx.call('cdn', 'get', { mediaId: post.mediaId }, { timeout: 1500, quiet: 'all' });
        if (!r.ok) st.stats.crowdTimeouts++;
      });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.dev;
      const m = sim.ui.maya;
      const byHash = {};
      for (const med of Object.values(st.media)) byHash[med.hash] = (byHash[med.hash] || 0) + 1;
      const dupMedia = Object.entries(byHash).find(([, n]) => n > 1);
      if (dupMedia && !st.config.dedupe) { /* deliberate re-upload: wasteful, not wrong */ }
      else if (dupMedia) return { key: 'wrong', label: `One upload produced ${dupMedia[1]} media records and ${dupMedia[1]} processing jobs: completion was retried and not recognised as the same session.` };
      if (Object.values(u.loaded).includes('failed')) return { key: 'stale', label: 'Dev’s image request failed: the rendition store could not keep up with CDN misses.' };
      if (st.stats.crowdTimeouts) return { key: 'stale', label: `${Y.num(st.stats.crowdTimeouts)} image loads timed out during the rush: every concurrent miss went to the rendition store (${Y.num(st.stats.originReads)} reads for one image).` };
      const stuck = Object.values(st.posts).filter((p) => !p.ready && sim.now - p.t > 2500);
      if (stuck.length) return { key: 'stale', label: `${stuck.map((p) => p.id).join(', ')} shared ${((sim.now - stuck[0].t) / 1000).toFixed(1)} s ago and still has no renditions${st.config.placeholder ? ': Dev sees a blurred placeholder' : ': hidden from Dev’s feed'}.` };
      if (m.busy && !online(sim)) return { key: 'stale', label: 'Maya is offline; the upload is waiting for the network.' };
      if (m.sharing) return { key: 'stale', label: 'Share is waiting for the upload to finish.' };
      if (!st.config.dedupe && dupMedia) return { key: 'ok', label: `The same photo was uploaded and processed twice (${st.stats.chunks} chunks): correct, just wasteful.` };
      return { key: 'ok', label: 'Every shared post has its renditions, every image loaded, and no bytes were stored twice.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const m = sim.ui.maya;
      const d = sim.ui.dev;
      const ready = Object.values(st.posts).filter((p) => p.readyAt).map((p) => p.readyAt - p.t);
      const w = sim.queueWait('renditions');
      return [
        { label: 'Upload time', value: m.uploadMs == null ? 'n/a' : SDL.fmtMs(m.uploadMs) },
        { label: 'Share time', value: m.shareMs == null ? 'n/a' : SDL.fmtMs(m.shareMs), tone: m.shareMs > 500 ? 'warn' : m.shareMs ? 'ok' : '' },
        { label: 'Share to renditions', value: ready.length ? SDL.fmtMs(Math.max(...ready)) : 'n/a' },
        { label: 'Chunks sent / wasted', value: `${st.stats.chunks} / ${st.stats.wasted}`, tone: st.stats.wasted ? 'warn' : '' },
        { label: 'Processing jobs', value: st.stats.jobs },
        { label: 'Image load (Dev)', value: d.imageMs == null ? 'n/a' : SDL.fmtMs(d.imageMs) },
        { label: 'Rendition store reads', value: Y.num(st.stats.originReads) },
        { label: 'Rendition store queue', value: SDL.fmtMs(w), tone: w > 500 ? 'fail' : w > 100 ? 'warn' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['dev', 'Dev’s phone']], {
          note: 'Maya picks a photo; the chunks go up while she types; Share only references the uploaded media. Dev sees a placeholder until the renditions exist. The console makes the post go viral.',
          below: `<div class="ops-console"><p class="ops-title">Traffic</p><div class="ops-traffic">${Y.btn('viral', 'Post goes viral: 500 loads/s', { arg: { on: true } })}${Y.btn('viral', 'End the rush', { arg: { on: false }, cls: 'secondary' })}</div><div data-ref="status"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const m = sim.ui.maya;
        const d = sim.ui.dev;
        const parts = m.parts.length ? `<div class="app-steps" aria-hidden="true">${m.parts.map((p) => `<span class="${p === 'done' || p === 'skipped' ? 'done' : ''}" style="${p === 'failed' ? 'background:var(--fail)' : p === 'sending' ? 'opacity:.6' : ''}"></span>`).join('')}</div>` : '';
        const compose = m.photo
          ? `<div class="yt-thumb" style="--h:${PHOTOS[m.photo].hue};height:110px"><span aria-hidden="true">◉</span></div>${parts}<p class="app-sub">${m.busy ? '<span class="spinner"></span>' : m.mediaId ? '✓ ' : ''}${esc(m.status)}</p><div class="app-card"><span class="app-sub">Caption</span><strong>Golden hour</strong></div>${Y.btn('share', m.sharing ? 'Sharing…' : 'Share', { cls: 'go', disabled: m.sharing })}`
          : `${Y.btn('pick', 'Pick Sunset.jpg', { arg: { photo: 'sunset' } })}${Y.btn('pick', 'Pick Coffee.jpg', { arg: { photo: 'coffee' }, cls: 'secondary' })}`;
        const mine = Object.values(st.posts).slice(-2).reverse().map((p) => `<div class="app-card ${p.ready ? 'is-ok' : 'is-work'}"><strong>${p.ready ? '✓' : '<span class="spinner"></span>'} ${esc(p.id)} · ${esc(PHOTOS[p.photo].label)}</strong><span class="app-sub">${p.ready ? 'Renditions ready' : 'Processing…'}</span></div>`).join('');
        Y.paint(el, sim, 'maya', { head: '<div><p class="app-title">Instagram</p><p class="app-sub">New post</p></div>', compose, mine }, {});
        const feed = d.feed.slice(-2).reverse().map((p) => {
          const state = !p.ready ? 'placeholder' : d.loaded[p.id] || 'loading';
          return `<div class="app-card"><strong>maya.k</strong><div class="yt-thumb" style="--h:${PHOTOS[p.photo].hue};height:110px;${state === 'ok' ? '' : state === 'failed' ? 'filter:grayscale(1);opacity:.4' : 'filter:blur(8px);opacity:.7'}"><span aria-hidden="true">${state === 'failed' ? '✕' : state === 'ok' ? '◉' : '…'}</span></div><span class="app-sub">${state === 'placeholder' ? 'Processing: blurred preview' : state === 'loading' ? 'Loading image…' : state === 'failed' ? 'Image failed to load' : 'Golden hour'}</span></div>`;
        }).join('');
        Y.paint(el, sim, 'dev', { head: '<div><p class="app-title">Instagram</p><p class="app-sub">Home</p></div>', feed: feed || '<p class="app-sub">Nothing new yet.</p>' }, {});
        const c = sim.scenario.consistency(sim);
        const w = sim.queueWait('renditions');
        SDL.ui.paintSections(el.querySelector('[data-ref="status"]'), {
          rows: `<div class="ops-shards">
            <div class="ops-row"><div class="ops-name">Object store<span>${Object.keys(st.media).length} original${Object.keys(st.media).length === 1 ? '' : 's'} · ${st.stats.chunks} chunks received · ${st.stats.dedupeHits} deduplicated</span></div></div>
            <div class="ops-row" data-tone="${sim.queueStats('proc').depth ? 'warn' : ''}"><div class="ops-name">Processing queue<span>${sim.queueStats('proc').depth} job${sim.queueStats('proc').depth === 1 ? '' : 's'} waiting</span></div></div>
            <div class="ops-row" data-tone="${w > 500 ? 'fail' : w > 100 ? 'warn' : ''}"><div class="ops-name">Rendition store<span>${Y.num(st.stats.originReads)} reads · queue ${Math.round(w)} ms · ${Y.num(st.stats.coalesced)} misses coalesced${st.stats.crowdTimeouts ? ` · ${Y.num(st.stats.crowdTimeouts)} loads timed out` : ''}</span></div></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
