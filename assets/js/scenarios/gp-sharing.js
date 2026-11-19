/*
 * Albums, links, and revocation.
 * Maya shares an album with Omar (a member, checked against the ACL on every
 * open) and a link with Lena (anyone holding the token). Photos are served by
 * a CDN from signed URLs that the CDN checks on its own, with no ACL lookup,
 * which is what lets a viral link scale and also why revocation needs short
 * URL lifetimes. The ACL cache must be invalidated on a change, or a removed
 * member keeps seeing the album until the entry expires. A link share should
 * strip location from the copies it serves.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const p99of = (a) => SDL.percentile(a.slice().sort((x, y) => x - y), 99);

  const URL_TTL = 1500;          // short-lived signed URL (minutes in production)
  const LONG_TTL = 30 * 86400000; // "permanent" URL: 30 days
  const CACHE_TTL = 5000;        // ACL cache entry lifetime
  const SWIPE_MS = 400;          // Lena's tab fetches the next full-size photo
  const REFRESH_MS = 700;        // Omar's album view refreshes
  const VIRAL_PER_TICK = 2;      // viewers per 10 ms while the link is viral (200/s)

  const ALBUM = [
    { id: 'a1', name: 'Tram 28', hue: 40, glyph: '🚋', gps: '38.711, −9.130', owner: 'maya' },
    { id: 'a2', name: 'Pastéis', hue: 30, glyph: '🥮', gps: null, owner: 'maya' },
    { id: 'a3', name: 'Our hotel balcony', hue: 200, glyph: '🏨', gps: '38.716, −9.141', owner: 'maya' },
    { id: 'a4', name: 'Sunset at Belém', hue: 15, glyph: '🌅', gps: null, owner: 'maya' },
  ];
  const NEW_PHOTO = { id: 'a5', name: 'Fado night', hue: 280, glyph: '🎶', gps: '38.712, −9.127', owner: 'maya' };
  const OMAR_PHOTO = { id: 'o1', name: 'Omar’s castle view', hue: 120, glyph: '🏰', gps: null, owner: 'omar' };

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'maya', quiet: 'all' });

  function share(sim) {
    sim.startAction('Maya: share “Lisbon trip” with Omar', function* (ctx) {
      const r = yield ctx.call('gateway', 'addMember', { user: 'omar' }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { displayed: ['yes', 'Omar is listed as a member.'], committed: ['yes', 'ACL row written.'], async: ['n/a', 'Omar sees it on his next open.'] });
    }, { self: 'maya' });
  }
  function removeMember(sim) {
    sim.startAction('Maya: remove Omar from the album', function* (ctx) {
      const r = yield ctx.call('gateway', 'removeMember', { user: 'omar' }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { displayed: ['yes', 'Omar is gone from the member list.'], committed: ['yes', 'ACL row deleted.'], async: [r.value.invalidated ? 'yes' : 'pending', r.value.invalidated ? 'ACL cache entry invalidated.' : `ACL cache keeps “member” until it expires (${CACHE_TTL / 1000} s).`] });
      ctx.explain(r.value.invalidated ? 'The ACL row is deleted and the cache entry dropped, so the very next check goes to the ACL store and says no.' : `The ACL row is deleted, but nothing told the cache. Checks for Omar keep hitting the cached “member” answer for up to ${CACHE_TTL / 1000} s.`);
    }, { self: 'maya' });
  }
  function createLink(sim) {
    sim.startAction('Maya: create a link to “Lisbon trip”', function* (ctx) {
      const r = yield ctx.call('gateway', 'createLink', {}, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { displayed: ['yes', 'Link copied.'], committed: ['yes', `Link token ${r.value.token} stored.`], async: ['n/a', ''] });
      ctx.explain(`Anyone with the link can open the album. ${ctx.state.config.stripLocation ? 'Copies served through the link have their location removed.' : 'Copies served through the link are the originals, location included.'}`);
    }, { self: 'maya' });
  }
  function revokeLink(sim) {
    sim.startAction('Maya: turn the link off', function* (ctx) {
      const r = yield ctx.call('gateway', 'revokeLink', {}, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      const s = ctx.state;
      Y.L(ctx, { displayed: ['yes', 'Link off.'], committed: ['yes', 'Token deleted.'], async: [s.config.shortUrls ? 'pending' : 'no', s.config.shortUrls ? `URLs already handed out work for up to ${URL_TTL / 1000} s more.` : 'URLs already handed out keep working for 30 days.'] });
      ctx.explain(s.config.shortUrls ? `The token is gone, so nobody can get new URLs. The CDN checks signed URLs on its own, so the ones Lena already has keep working until they expire, at most ${URL_TTL / 1000} s from now.` : 'The token is gone, but the CDN never asks the ACL: it only checks the signature and the expiry, and Lena’s URLs expire in 30 days.');
    }, { self: 'maya' });
  }
  function addPhoto(sim) {
    sim.startAction('Maya: add “Fado night” to the album', function* (ctx) {
      const r = yield ctx.call('gateway', 'addPhoto', { photo: NEW_PHOTO, user: 'maya' }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { displayed: ['yes', 'In the album.'], committed: ['yes', 'Album entry written.'], async: ['n/a', 'Members see it on their next open.'] });
    }, { self: 'maya' });
  }
  function mayaOpen(sim) {
    sim.startAction('Maya: open “Lisbon trip”', function* (ctx) {
      const r = yield ctx.call('gateway', 'open', { user: 'maya' }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      ctx.ui.maya.album = r.value.photos.map((p) => p.id);
      Y.L(ctx, { displayed: ['yes', `${r.value.photos.length} photos.`], committed: ['n/a', 'Read only.'] });
    }, { self: 'maya' });
  }
  function omarOpen(sim) {
    sim.ui.omar.open = true;
    sim.startAction('Omar: open “Lisbon trip”', function* (ctx) {
      const r = yield ctx.call('gateway', 'open', { user: 'omar' }, { timeout: 1500 });
      if (!r.ok) { ctx.ui.omar.denied = r.error.code; ctx.ui.omar.open = false; Y.failed(ctx, r.error.code); return; }
      yield* omarShow(ctx, r.value, false);
      Y.L(ctx, { displayed: ['yes', `${r.value.photos.length} photos.`], committed: ['n/a', 'Read only.'], async: ['n/a', `Refreshes every ${REFRESH_MS / 1000} s.`] });
    }, { self: 'omar' });
  }
  function* omarShow(ctx, v, quiet) {
    const ui = ctx.ui.omar;
    ui.album = v.photos.map((p) => p.id);
    for (const p of v.photos) {
      if (ui.loaded[p.id] === 'ok') continue;
      const r = yield ctx.call('cdn', 'get', { url: v.urls[p.id], who: 'omar' }, { timeout: 1500, quiet: quiet ? 'all' : undefined });
      ui.loaded[p.id] = r.ok ? 'ok' : 'fail';
    }
  }
  function omarContribute(sim) {
    sim.startAction('Omar: add his photo to the album', function* (ctx) {
      const r = yield ctx.call('gateway', 'addPhoto', { photo: OMAR_PHOTO, user: 'omar' }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { displayed: ['yes', 'In the album.'], committed: ['yes', 'Album entry → Omar’s item. Omar owns it; it counts against his storage.'] });
      ctx.explain('The album holds a reference to Omar’s photo; the photo itself stays in Omar’s library and counts against his storage, not Maya’s. If Omar leaves, his photos leave with him.');
    }, { self: 'omar' });
  }
  function lenaOpen(sim) {
    sim.ui.lena.open = true;
    sim.startAction('Lena: open the link', function* (ctx) {
      const r = yield ctx.call('gateway', 'openLink', { token: ctx.state.link ? ctx.state.link.token : 'none' }, { timeout: 1500 });
      if (!r.ok) { ctx.ui.lena.denied = r.error.code; ctx.ui.lena.open = false; Y.failed(ctx, r.error.code); return; }
      ctx.ui.lena.urls = r.value.urls;
      ctx.ui.lena.album = r.value.photos.map((p) => p.id);
      for (const p of r.value.photos) {
        const t0 = ctx.now();
        const g = yield ctx.call('cdn', 'get', { url: r.value.urls[p.id], who: 'lena' }, { timeout: 3000 });
        ctx.ui.lena.loaded[p.id] = g.ok ? 'ok' : 'fail';
        if (g.ok) ctx.ui.lena.gps[p.id] = g.value.gps;
        ctx.state.stats.tiles.push(ctx.now() - t0);
      }
      Y.L(ctx, { displayed: ['yes', `${r.value.photos.length} photos.`], committed: ['n/a', 'Read only.'], async: ['n/a', `URLs expire ${ctx.state.config.shortUrls ? `in ${URL_TTL / 1000} s` : 'in 30 days'}.`] });
    }, { self: 'lena' });
  }

  // One viewer of a viral link: open the link, then fetch every photo from the CDN.
  function* viewer(ctx) {
    const st = ctx.state;
    const t0 = ctx.now();
    const r = yield ctx.call('gateway', 'openLink', { token: st.link ? st.link.token : 'none', crowd: true }, { timeout: 3000, quiet: 'all' });
    if (!r.ok) { st.stats.crowdFailed++; return; }
    for (const p of r.value.photos) {
      const g = yield ctx.call('cdn', 'get', { url: r.value.urls[p.id], who: 'crowd' }, { timeout: 10000, quiet: 'all' });
      if (!g.ok) { st.stats.crowdFailed++; return; }
    }
    st.stats.crowdViews++;
    st.stats.crowdMs.push(ctx.now() - t0);
  }

  function* aclCheck(ctx, key, who) {
    const st = ctx.state;
    const c = yield ctx.call('aclcache', 'get', { key }, { timeout: 500, quiet: ctx.quiet });
    if (c.ok && c.value) return c.value.allow;
    const r = yield ctx.call('acldb', 'check', { key, who }, { timeout: 800, quiet: ctx.quiet });
    if (!r.ok) ctx.fail('UNAVAILABLE', 'Cannot check access: the ACL store is unavailable. Refusing rather than guessing.');
    yield ctx.call('aclcache', 'set', { key, allow: r.value.allow }, { timeout: 500, quiet: ctx.quiet });
    void st;
    return r.value.allow;
  }

  const sc = (SDL.scenarios['gp-sharing'] = {
    id: 'gp-sharing',
    seed: 2203,
    minHopMs: 5,
    productWidth: 840,
    intro: 'Maya’s “Lisbon trip” album has four photos, two of them with a location. Share it with Omar, then a link with Lena; take both back and watch how long access really lasts. Then send the link viral.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'Owner', kind: 'client', x: 90, y: 100, latency: 1, role: 'Owns the album: shares, removes members, creates and turns off the link.', owns: ['Nothing durable'] },
        { id: 'omar', label: 'Omar’s phone', sub: 'Album member', kind: 'client', x: 90, y: 300, latency: 1, role: 'Views the album and adds his own photos to it.', owns: ['Nothing durable'] },
        { id: 'lena', label: 'Lena’s browser', sub: 'Has the link', kind: 'client', x: 90, y: 500, latency: 1, role: 'Opens the link and swipes through the full-size photos. When the link goes viral, stands in for the crowd too.', owns: ['Signed URLs she was given'] },
        { id: 'gateway', label: 'Edge', sub: 'Auth, routing', kind: 'gateway', x: 260, y: 300, latency: 3, role: 'Authenticates signed-in users; link opens carry only the token.', owns: ['Nothing durable'] },
        { id: 'sharing', label: 'Sharing service', sub: 'Check, list, sign', kind: 'service', x: 440, y: 300, latency: 3, role: 'Checks access, lists the album, and asks the signer for one URL per photo.', ops: [{ name: 'open', desc: 'Member open.' }, { name: 'openLink', desc: 'Link open.' }], owns: ['Nothing durable'] },
        { id: 'aclcache', label: 'ACL cache', sub: `TTL ${CACHE_TTL / 1000} s`, kind: 'cache', x: 620, y: 110, latency: 1, role: 'Caches “may this user (or token) see this album?” Every open asks it first.', ops: [{ name: 'get', desc: 'Cached answer.' }, { name: 'set', desc: 'Cache an answer.' }, { name: 'invalidate', desc: 'Drop an entry.' }], owns: ['allow[album][user]'] },
        { id: 'acldb', label: 'ACL store', sub: 'Members + link tokens', kind: 'db', x: 820, y: 110, latency: 5, serviceMs: 10, servers: 2, role: 'The truth about who may see the album. About 200 checks a second here.', ops: [{ name: 'check', desc: 'Is this user or token allowed?' }, { name: 'put', desc: 'Change a member or token.' }], owns: ['members', 'link token'] },
        { id: 'metadb', label: 'Album metadata', sub: 'Entries', kind: 'db', x: 620, y: 300, latency: 4, role: 'Album entries: each points at a photo in its owner’s library.', ops: [{ name: 'list', desc: 'Album entries.' }, { name: 'insert', desc: 'Add an entry.' }], owns: ['album → items'] },
        { id: 'signer', label: 'URL signer', sub: 'HMAC + expiry', kind: 'service', x: 620, y: 470, latency: 2, role: 'Signs a URL for one photo and variant with an expiry. The CDN checks the signature with a shared key; it never calls the ACL.', ops: [{ name: 'sign', desc: 'Sign URLs.' }], owns: ['signing key'] },
        { id: 'cdn', label: 'Photo CDN', sub: 'Checks signatures', kind: 'cdn', x: 440, y: 540, latency: 2, role: 'Serves photos from edge caches. Rejects a URL whose signature is bad or whose expiry has passed; otherwise serves it.', ops: [{ name: 'get', desc: 'Serve a signed URL.' }], owns: ['cached photos'] },
        { id: 'blob', label: 'Blob store', sub: 'Originals + variants', kind: 'store', x: 820, y: 540, latency: 6, serviceMs: 20, servers: 2, role: 'Originals and the location-stripped variants. About 100 reads a second here; the CDN is what keeps it calm.', ops: [{ name: 'get', desc: 'Read a photo.' }], owns: ['bytes'] },
      ],
      edges: [
        { from: 'maya', to: 'gateway', latency: 25 },
        { from: 'omar', to: 'gateway', latency: 25 },
        { from: 'lena', to: 'gateway', latency: 25 },
        { from: 'gateway', to: 'sharing', latency: 3 },
        { from: 'sharing', to: 'aclcache', latency: 2 },
        { from: 'sharing', to: 'acldb', latency: 3, via: [[540, 40], [820, 40]] },
        { from: 'sharing', to: 'metadb', latency: 3 },
        { from: 'sharing', to: 'signer', latency: 2 },
        { from: 'omar', to: 'cdn', latency: 15, via: [[180, 420]] },
        { from: 'lena', to: 'cdn', latency: 15 },
        { from: 'cdn', to: 'blob', latency: 5 },
      ],
    },
    modeLabels: { lostInvalidation: 'Drops invalidations', viral: 'Viral' },
    failures: [
      { id: 'cache-lost', node: 'aclcache', mode: 'lostInvalidation', label: 'ACL cache drops invalidations', desc: 'Changes are written, but the cache keeps the old answer until its TTL.' },
      { id: 'acl-down', node: 'acldb', mode: 'down', label: 'ACL store down', desc: 'Cached answers keep working; anything not cached is refused (fail closed). Shares and revokes cannot be written.' },
      { id: 'signer-down', node: 'signer', mode: 'down', label: 'URL signer down', desc: 'Albums cannot be opened: no URLs. URLs already handed out keep working until they expire.' },
      { id: 'cdn-slow', node: 'cdn', mode: 'slow', params: { factor: 10 }, label: 'CDN slow', desc: 'Every photo takes ten times as long.' },
      { id: 'blob-down', node: 'blob', mode: 'down', label: 'Blob store down', desc: 'Photos already cached at the CDN still load; anything else fails.' },
      { id: 'meta-slow', node: 'metadb', mode: 'slow', params: { factor: 20 }, label: 'Album metadata slow', desc: 'Opens and additions wait.' },
      { id: 'viral', node: 'lena', mode: 'viral', label: 'Viral link surge', desc: `About ${VIRAL_PER_TICK * 100} new viewers a second open the link while this is on.` },
    ],
    switches: Y.switches([
      ['shortUrls', 'Short-lived signed URLs', `Photo URLs expire ${URL_TTL / 1000} s after they are signed (minutes in production); the page asks for fresh ones. Off: URLs last 30 days.`],
      ['invalidate', 'Invalidate the ACL cache on a change', `Removing a member or turning a link off drops the cached answer. Off: the cache keeps it for up to ${CACHE_TTL / 1000} s.`],
      ['stripLocation', 'Strip location from link shares', 'Link viewers get a copy with the location removed. Off: they get the original.'],
      ['keyNoSig', 'CDN cache key ignores the signature', 'The CDN caches by photo and variant, so every viewer’s different URL hits the same entry. Off: the whole URL is the key.'],
    ]),
    presets: Y.presets({ shortUrls: true, invalidate: true, stripLocation: true, keyNoSig: true }, [
      { id: 'album-share', label: 'Share the album with Omar', desc: 'Maya adds Omar. His phone opens the album, gets one signed URL per photo, and loads them from the CDN.', run: (s) => { share(s); later(s, 500, omarOpen); } },
      { id: 'omar-contributes', label: 'Omar adds a photo', desc: 'Omar adds his castle photo. The album points at Omar’s item: it shows in Maya’s album, but Omar owns it and it counts against his storage.', run: (s) => { share(s); later(s, 500, omarOpen); later(s, 1200, omarContribute); later(s, 2000, mayaOpen); } },
      { id: 'link-view', label: 'Share a link with Lena', desc: 'Lena opens the link, gets short-lived URLs for the location-stripped copies, and swipes through them. Her tab asks for fresh URLs each time they expire.', run: (s) => { createLink(s); later(s, 400, lenaOpen); } },
      { id: 'revoke-long-urls', label: 'Turn the link off, 30-day URLs', desc: 'Maya turns the link off at 2.6 s. The CDN never asks the ACL, and Lena’s URLs are good for 30 days: she keeps loading the full photos until the end of the run, and would for weeks.', sw: { shortUrls: false }, run: (s) => { createLink(s); later(s, 400, lenaOpen); later(s, 2600, revokeLink); } },
      { id: 'revoke-short-ttl', label: 'Turn the link off, short-lived URLs', desc: `Same revoke. Lena’s URLs expire within ${URL_TTL / 1000} s; her tab asks for fresh ones and the sharing service refuses. Access ends within one URL lifetime.`, run: (s) => { createLink(s); later(s, 400, lenaOpen); later(s, 2600, revokeLink); } },
      { id: 'remove-member-stale-acl', label: 'Remove Omar, cache not invalidated', desc: `Maya removes Omar, then adds “Fado night”. Omar’s check still hits the cached “member” answer, so his next refresh shows the new photo, added after he was removed. He is cut off only when the entry expires.`, sw: { invalidate: false }, run: (s) => { share(s); later(s, 300, omarOpen); later(s, 1500, removeMember); later(s, 1900, addPhoto); } },
      { id: 'remove-member-invalidate', label: 'Remove Omar, cache invalidated', desc: 'Same removal. The cache entry is dropped, so Omar’s next refresh goes to the ACL store and is refused. He never sees “Fado night”.', run: (s) => { share(s); later(s, 300, omarOpen); later(s, 1500, removeMember); later(s, 1900, addPhoto); } },
      { id: 'location-leak', label: 'Link share with location kept', desc: 'Lena gets the originals. Two of them carry the GPS position of the hotel and the tram stop, now readable by anyone the link reaches.', sw: { stripLocation: false }, run: (s) => { createLink(s); later(s, 400, lenaOpen); } },
      { id: 'viral-link', label: 'The link goes viral', desc: 'About 600 viewers in three seconds. The ACL cache answers for the token, so the ACL store sees one check; the CDN caches each photo once, so the blob store sees a handful of reads.', run: (s) => { createLink(s); later(s, 400, lenaOpen); later(s, 1500, (x) => x.inject('lena', 'viral', {}, 3000)); later(s, 3000, lenaOpen); } },
      { id: 'viral-sig-in-key', label: 'Viral link, signature in the cache key', desc: 'Same crowd, but every viewer gets differently signed URLs and the CDN caches by the whole URL. Every view misses, the blob store queues, and the page takes seconds to load.', sw: { keyNoSig: false }, run: (s) => { createLink(s); later(s, 400, lenaOpen); later(s, 1500, (x) => x.inject('lena', 'viral', {}, 3000)); later(s, 3000, lenaOpen); } },
    ]),
    initialState: () => ({
      config: { shortUrls: true, invalidate: true, stripLocation: true, keyNoSig: true },
      album: ALBUM.map((p) => Object.assign({ addedAt: 0 }, p)),
      members: [], removedAt: {}, link: null, linkSeq: 0, sigSeq: 0,
      acl: {}, cache: {}, cdn: {}, revokedAt: null,
      usage: { maya: 4, omar: 0 },
      leaks: [], reads: [], exposed: {},
      stats: { aclReads: 0, blobReads: 0, cdnHits: 0, cdnMisses: 0, signed: 0, tiles: [], crowdViews: 0, crowdFailed: 0, crowdMs: [], expired: 0, refused: 0 },
    }),
    initialUI: () => ({
      maya: { album: null },
      omar: { open: false, album: null, loaded: {}, denied: null },
      lena: { open: false, album: null, loaded: {}, gps: {}, urls: null, denied: null, at: 0 },
    }),
    actions: {
      share(sim) { share(sim); },
      remove(sim) { removeMember(sim); },
      link(sim) { createLink(sim); },
      revoke(sim) { revokeLink(sim); },
      add(sim) { addPhoto(sim); },
      mayaOpen(sim) { mayaOpen(sim); },
      omarOpen(sim) { omarOpen(sim); },
      contribute(sim) { omarContribute(sim); },
      lenaOpen(sim) { lenaOpen(sim); },
      viral(sim) { if (!sim.nodes.lena.modes.viral) sim.inject('lena', 'viral', {}, 3000); },
    },
    handlers: {
      gateway: {
        addMember: function* (ctx, p) { return ctx.must(yield ctx.call('sharing', 'addMember', p, { timeout: 1000 })); },
        removeMember: function* (ctx, p) { return ctx.must(yield ctx.call('sharing', 'removeMember', p, { timeout: 1000 })); },
        createLink: function* (ctx, p) { return ctx.must(yield ctx.call('sharing', 'createLink', p, { timeout: 1000 })); },
        revokeLink: function* (ctx, p) { return ctx.must(yield ctx.call('sharing', 'revokeLink', p, { timeout: 1000 })); },
        addPhoto: function* (ctx, p) { return ctx.must(yield ctx.call('sharing', 'addPhoto', p, { timeout: 1000 })); },
        open: function* (ctx, p) { return ctx.must(yield ctx.call('sharing', 'open', p, { timeout: 1000, quiet: ctx.quiet })); },
        openLink: function* (ctx, p) { return ctx.must(yield ctx.call('sharing', 'openLink', p, { timeout: 2500, quiet: ctx.quiet })); },
      },
      sharing: {
        addMember: function* (ctx, p) {
          ctx.must(yield ctx.call('acldb', 'put', { key: `album:${p.user}`, allow: true }, { timeout: 800 }));
          const st = ctx.state;
          if (!st.members.includes(p.user)) st.members.push(p.user);
          delete st.removedAt[p.user];
          yield ctx.call('aclcache', 'invalidate', { key: `album:${p.user}` }, { timeout: 500 });
          return { ok: true };
        },
        removeMember: function* (ctx, p) {
          ctx.must(yield ctx.call('acldb', 'put', { key: `album:${p.user}`, allow: false }, { timeout: 800 }));
          const st = ctx.state;
          st.members = st.members.filter((m) => m !== p.user);
          st.removedAt[p.user] = ctx.now();
          let invalidated = false;
          if (st.config.invalidate) { const r = yield ctx.call('aclcache', 'invalidate', { key: `album:${p.user}` }, { timeout: 500 }); invalidated = r.ok && r.value.dropped; }
          return { invalidated };
        },
        createLink: function* (ctx) {
          const st = ctx.state;
          const token = `L${++st.linkSeq}`;
          ctx.must(yield ctx.call('acldb', 'put', { key: `link:${token}`, allow: true }, { timeout: 800 }));
          st.link = { token, active: true };
          st.revokedAt = null;
          return { token };
        },
        revokeLink: function* (ctx) {
          const st = ctx.state;
          if (!st.link) ctx.fail('NOT_FOUND', 'No link to turn off.');
          const key = `link:${st.link.token}`;
          ctx.must(yield ctx.call('acldb', 'put', { key, allow: false }, { timeout: 800 }));
          st.link.active = false;
          st.revokedAt = ctx.now();
          let invalidated = false;
          if (st.config.invalidate) { const r = yield ctx.call('aclcache', 'invalidate', { key }, { timeout: 500 }); invalidated = r.ok && r.value.dropped; }
          return { invalidated };
        },
        addPhoto: function* (ctx, p) {
          if (p.user !== 'maya' && !(yield* aclCheck(ctx, `album:${p.user}`, p.user))) ctx.fail('FORBIDDEN', 'Not a member of this album.');
          const r = ctx.must(yield ctx.call('metadb', 'insert', { photo: p.photo }, { timeout: 800 }));
          if (r.added && p.photo.owner === 'omar') ctx.state.usage.omar++;
          return r;
        },
        open: function* (ctx, p) {
          const st = ctx.state;
          if (p.user !== 'maya' && !(yield* aclCheck(ctx, `album:${p.user}`, p.user))) { st.stats.refused++; ctx.fail('FORBIDDEN', 'You no longer have access to this album.'); }
          const checkedAt = ctx.now();
          const list = ctx.must(yield ctx.call('metadb', 'list', {}, { timeout: 800, quiet: ctx.quiet }));
          const signed = ctx.must(yield ctx.call('signer', 'sign', { ids: list.map((x) => x.id), variant: 'orig' }, { timeout: 800, quiet: ctx.quiet }));
          if (p.user !== 'maya' && st.removedAt[p.user] != null && st.removedAt[p.user] < checkedAt) {
            const after = list.filter((x) => x.addedAt > (st.removedAt[p.user] || Infinity));
            st.reads.push({ who: p.user, t: ctx.now(), via: 'acl cache' });
            if (after.length && !st.leaks.some((l) => l.who === p.user && l.photo === after[0].id)) {
              st.leaks.push({ who: p.user, photo: after[0].id, t: ctx.now() });
              ctx.log({ op: `Omar shown “${after[0].name}”`, status: 'fault', detail: `Added ${SDL.fmtMs(after[0].addedAt - st.removedAt[p.user])} after Omar was removed. The ACL cache still said “member”.` });
            }
          }
          return { photos: list, urls: signed };
        },
        openLink: function* (ctx, p) {
          const st = ctx.state;
          if (!(yield* aclCheck(ctx, `link:${p.token}`, 'link'))) { st.stats.refused++; ctx.fail('NOT_FOUND', 'This link no longer works.'); }
          const list = ctx.must(yield ctx.call('metadb', 'list', {}, { timeout: 800, quiet: ctx.quiet }));
          const signed = ctx.must(yield ctx.call('signer', 'sign', { ids: list.map((x) => x.id), variant: st.config.stripLocation ? 'shared' : 'orig' }, { timeout: 800, quiet: ctx.quiet }));
          return { photos: list, urls: signed };
        },
      },
      aclcache: {
        get(ctx, p) { const c = ctx.state.cache[p.key]; return c && c.until > ctx.now() ? { allow: c.allow } : null; },
        set(ctx, p) { ctx.state.cache[p.key] = { allow: p.allow, until: ctx.now() + CACHE_TTL }; return { ok: true }; },
        invalidate(ctx, p) {
          if (ctx.mode('lostInvalidation')) return { dropped: false };
          const had = !!ctx.state.cache[p.key];
          delete ctx.state.cache[p.key];
          return { dropped: had };
        },
      },
      acldb: {
        check(ctx, p) { ctx.state.stats.aclReads++; return { allow: !!ctx.state.acl[p.key] }; },
        put(ctx, p) { ctx.state.acl[p.key] = p.allow; return { ok: true }; },
      },
      metadb: {
        list(ctx) { return ctx.state.album.map((x) => Object.assign({}, x)); },
        insert(ctx, p) {
          const st = ctx.state;
          if (st.album.some((x) => x.id === p.photo.id)) return { added: false };
          st.album.push(Object.assign({}, p.photo, { addedAt: ctx.now() }));
          return { added: true };
        },
      },
      signer: {
        sign(ctx, p) {
          const st = ctx.state;
          const urls = {};
          for (const id of p.ids) urls[id] = { id, variant: p.variant, sig: `s${++st.sigSeq}`, exp: ctx.now() + (st.config.shortUrls ? URL_TTL : LONG_TTL) };
          st.stats.signed += p.ids.length;
          return urls;
        },
      },
      cdn: {
        get: function* (ctx, p) {
          const st = ctx.state;
          const u = p.url;
          if (!u) ctx.fail('BAD_URL', 'No URL.');
          if (ctx.now() > u.exp) { if (p.who === 'lena') st.stats.expired++; ctx.fail('EXPIRED', 'This signed URL has expired.'); }
          const key = st.config.keyNoSig ? `${u.id}:${u.variant}` : `${u.id}:${u.variant}:${u.sig}`;
          let obj = st.cdn[key];
          if (obj) st.stats.cdnHits++;
          else {
            st.stats.cdnMisses++;
            obj = ctx.must(yield ctx.call('blob', 'get', { id: u.id, variant: u.variant }, { timeout: 8000, quiet: ctx.quiet }));
            st.cdn[key] = obj;
          }
          if (p.who === 'lena' || p.who === 'crowd') {
            if (obj.gps) st.exposed[u.id] = obj.gps;
            if (p.who === 'lena' && st.revokedAt != null && !(st.link && st.link.active)) st.reads.push({ who: 'lena', t: ctx.now(), id: u.id, since: ctx.now() - st.revokedAt });
          }
          return obj;
        },
      },
      blob: {
        get(ctx, p) {
          ctx.state.stats.blobReads++;
          const ph = ctx.state.album.find((x) => x.id === p.id) || {};
          return { id: p.id, gps: p.variant === 'shared' ? null : ph.gps || null };
        },
      },
    },
    setup(sim) {
      // Lena's tab: swipe to the next full-size photo; ask for fresh URLs when they expire.
      sim.spawn(function* (ctx) {
        let i = 0;
        for (;;) {
          yield ctx.wait(SWIPE_MS);
          const ui = ctx.ui.lena;
          if (!ui.open || !ui.urls || !ui.album) continue;
          const id = ui.album[i++ % ui.album.length];
          const r = yield ctx.call('cdn', 'get', { url: ui.urls[id], who: 'lena' }, { timeout: 3000, quiet: 'all' });
          if (r.ok) { ui.loaded[id] = 'ok'; ui.gps[id] = r.value.gps; ui.at = ctx.now(); continue; }
          if (r.error.code !== 'EXPIRED') { ui.loaded[id] = 'fail'; continue; }
          const st = ctx.state;
          const o = yield ctx.call('gateway', 'openLink', { token: st.link ? st.link.token : 'none' }, { timeout: 2500 });
          if (o.ok) { ui.urls = o.value.urls; ui.album = o.value.photos.map((p) => p.id); continue; }
          ui.open = false; ui.denied = o.error.code; ui.loaded = {};
          ctx.log({ op: 'Lena’s tab: link no longer works', status: 'recovered', detail: st.revokedAt != null ? `Her URLs expired ${SDL.fmtMs(ctx.now() - st.revokedAt)} after the link was turned off, and fresh ones were refused.` : 'Fresh URLs were refused.' });
        }
      }, { self: 'lena', quiet: 'all' });
      // Omar's album view refreshes; a refusal closes it.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(REFRESH_MS);
          const ui = ctx.ui.omar;
          if (!ui.open || !ui.album) continue;
          const r = yield ctx.call('gateway', 'open', { user: 'omar' }, { timeout: 1500 });
          if (r.ok) { yield* omarShow(ctx, r.value, true); continue; }
          if (r.error.code === 'FORBIDDEN') {
            ui.open = false; ui.denied = r.error.code; ui.album = null; ui.loaded = {};
            const st = ctx.state;
            ctx.log({ op: 'Omar’s album closed: no access', status: 'recovered', detail: st.removedAt.omar != null ? `${SDL.fmtMs(ctx.now() - st.removedAt.omar)} after he was removed.` : '' });
          }
        }
      }, { self: 'omar', quiet: 'all' });
      // The viral crowd: about 200 new viewers a second while the mode is on.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(10);
          if (!ctx.mode('viral', 'lena')) continue;
          for (let k = 0; k < VIRAL_PER_TICK; k++) ctx.spawn(viewer, { self: 'lena', quiet: 'all' });
        }
      }, { self: 'lena', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const leak = st.leaks[0];
      if (leak) { const ph = st.album.find((x) => x.id === leak.photo); return { key: 'wrong', label: `Omar saw “${ph.name}”, added after Maya removed him. The ACL cache still answered “member”, because nothing invalidated it; removal took effect only when the entry expired.` }; }
      const exposed = Object.keys(st.exposed);
      if (exposed.length) return { key: 'wrong', label: `The link served ${exposed.length} photo${exposed.length > 1 ? 's' : ''} with a GPS location (${exposed.map((id) => `“${st.album.find((x) => x.id === id).name}” ${st.exposed[id]}`).join(', ')}). Anyone the link reaches can see where Maya stayed.` };
      const lenaReads = st.reads.filter((r) => r.who === 'lena');
      const last = lenaReads[lenaReads.length - 1];
      if (last && last.since > URL_TTL + SWIPE_MS) return { key: 'wrong', label: `Lena loaded full photos ${lenaReads.length} times after the link was turned off, the latest ${SDL.fmtMs(last.since)} after. The CDN only checks signatures and expiry, and her URLs are good for 30 days.` };
      if (sim.ui.lena.open && st.revokedAt != null) return { key: 'stale', label: `The link is off, but Lena’s URLs are still valid for up to ${SDL.fmtMs(URL_TTL)}.` };
      if (sim.ui.omar.open && st.removedAt.omar != null) return { key: 'stale', label: 'Omar was removed; his view closes at the next check.' };
      const crowd = st.stats.crowdMs;
      const p99 = crowd.length ? p99of(crowd) : 0;
      if (crowd.length && p99 > 1000) return { key: 'stale', label: `The viral link loaded slowly: p99 ${SDL.fmtMs(p99)} per viewer. Every viewer’s URLs were signed differently and the CDN cached by the whole URL, so ${st.stats.cdnMisses} of ${st.stats.cdnHits + st.stats.cdnMisses} photo requests went to the blob store.` };
      if (st.stats.crowdViews) return { key: 'ok', label: `${st.stats.crowdViews} viewers opened the link. The ACL store answered ${st.stats.aclReads} checks and the blob store ${st.stats.blobReads} reads; the ACL cache and the CDN absorbed the rest.` };
      if (st.revokedAt != null) return { key: 'ok', label: lenaReads.length ? `Lena’s access ended ${SDL.fmtMs(last.since)} after the link was turned off: her URLs expired and fresh ones were refused. That is the price of short-lived URLs: access can outlive a revoke by at most one URL lifetime (${SDL.fmtMs(URL_TTL)}).` : 'The link is off and nobody can get fresh URLs.' };
      if (st.removedAt.omar != null) return { key: 'ok', label: 'Omar’s access ended at his next check after removal: the cache entry was invalidated, so the ACL store answered.' };
      const omars = st.album.find((x) => x.owner === 'omar');
      if (omars) return { key: 'ok', label: `“${omars.name}” is in Maya’s album but owned by Omar: it counts against his storage (${st.usage.omar} photo).` };
      if (sim.ui.lena.album) return { key: 'ok', label: 'Lena sees the album through the link, without any location data.' };
      if (sim.ui.omar.album) return { key: 'ok', label: 'Omar is a member and sees all four photos.' };
      return { key: 'ok', label: 'Only Maya can see the album.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const lenaAfter = st.reads.filter((r) => r.who === 'lena').length;
      const total = st.stats.cdnHits + st.stats.cdnMisses;
      const crowd = st.stats.crowdMs;
      return [
        { label: 'Reads after revoke', value: lenaAfter + st.reads.filter((r) => r.who === 'omar').length, tone: st.leaks.length || st.reads.some((r) => r.since > URL_TTL + SWIPE_MS) ? 'fail' : '' },
        { label: 'CDN hit ratio', value: total ? `${Math.round((st.stats.cdnHits / total) * 100)}%` : '–' },
        { label: 'ACL store checks', value: st.stats.aclReads },
        { label: 'Blob store reads', value: st.stats.blobReads },
        { label: 'Location fields exposed', value: Object.keys(st.exposed).length, tone: Object.keys(st.exposed).length ? 'fail' : '' },
        { label: 'URLs signed', value: st.stats.signed },
        { label: 'Viral viewers', value: st.stats.crowdViews },
        { label: 'Viewer p99', value: crowd.length ? SDL.fmtMs(p99of(crowd)) : '–', tone: crowd.length && p99of(crowd) > 1000 ? 'warn' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['omar', 'Omar’s phone'], ['lena', 'Lena’s browser']], {
          note: 'Maya shares “Lisbon trip” with Omar and a link with Lena. Take access back and watch how long it really lasts.',
          below: `<div class="ops-console"><p class="ops-title">Link traffic</p><div class="ops-traffic">${Y.btn('viral', 'Send the link viral (3 s)', { cls: 'secondary' })}</div><div data-ref="status"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const byId = (id) => st.album.find((x) => x.id === id);
        const tile = (ph, state, extra) => `<div style="min-width:0"><div class="yt-thumb" style="--h:${ph.hue};aspect-ratio:1;font-size:14px;${state === 'ok' ? '' : 'opacity:.35'}"><span aria-hidden="true">${state === 'fail' ? '✕' : ph.glyph}</span></div><span class="app-sub" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ph.name)}</span>${extra || ''}</div>`;
        const grid = (inner) => `<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px">${inner}</div>`;
        const member = st.members.includes('omar');
        const linkOn = !!(st.link && st.link.active);
        const mayaList = sim.ui.maya.album ? sim.ui.maya.album.map(byId) : st.album.filter((x) => x.owner === 'maya');
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Lisbon trip</p><p class="app-sub">${member ? 'Shared with Omar' : 'Not shared'}${linkOn ? ' · link on' : ''}</p></div>`,
          ctl: `<div class="app-row" style="flex-wrap:wrap">${Y.btn('share', 'Share with Omar', { disabled: member })}${Y.btn('remove', 'Remove Omar', { cls: 'secondary', disabled: !member })}</div>
            <div class="app-row" style="flex-wrap:wrap">${Y.btn('link', 'Create link', { cls: 'secondary', disabled: linkOn })}${Y.btn('revoke', 'Turn link off', { cls: 'secondary', disabled: !linkOn })}</div>
            <div class="app-row" style="flex-wrap:wrap">${Y.btn('add', 'Add “Fado night”', { cls: 'secondary', disabled: st.album.some((x) => x.id === 'a5') })}${Y.btn('mayaOpen', 'Refresh', { cls: 'secondary' })}</div>`,
          grid: grid(mayaList.map((ph) => tile(ph, 'ok', ph.owner === 'omar' ? '<span class="app-sub">by Omar</span>' : '')).join('')),
          own: mayaList.some((ph) => ph.owner === 'omar') ? `<p class="app-sub">“${esc(OMAR_PHOTO.name)}” belongs to Omar; it counts against his storage.</p>` : '',
        }, {});
        const ou = sim.ui.omar;
        Y.paint(el, sim, 'omar', {
          head: `<div><p class="app-title">Shared with me</p><p class="app-sub">${ou.album ? 'Lisbon trip' : member ? 'Lisbon trip is shared with you' : 'Nothing shared'}</p></div>`,
          ctl: `<div class="app-row" style="flex-wrap:wrap">${Y.btn('omarOpen', 'Open “Lisbon trip”', { disabled: !!ou.open })}${Y.btn('contribute', 'Add my castle photo', { cls: 'secondary', disabled: !ou.album || st.album.some((x) => x.id === 'o1') })}</div>`,
          body: ou.denied ? '<div class="app-card is-fail"><strong>✕ No access</strong><span class="app-sub">You no longer have access to this album.</span></div>' : ou.album ? grid(ou.album.map((id) => tile(byId(id), ou.loaded[id])).join('')) : '',
          leak: st.leaks.length ? `<div class="app-card is-fail"><strong>⚠ Omar can see “${esc(byId(st.leaks[0].photo).name)}”</strong><span class="app-sub">Added after he was removed.</span></div>` : '',
        }, {});
        const lu = sim.ui.lena;
        Y.paint(el, sim, 'lena', {
          head: `<div><p class="app-title">photos.example/share/${esc(st.link ? st.link.token : '…')}</p><p class="app-sub">${lu.album ? 'Lisbon trip, shared by Maya' : 'A link from Maya'}</p></div>`,
          ctl: `<div class="app-row">${Y.btn('lenaOpen', 'Open the link', { disabled: !!lu.open || !st.link })}</div>`,
          body: lu.denied ? `<div class="app-card is-fail"><strong>✕ ${lu.denied === 'NOT_FOUND' ? 'This link no longer works' : 'Could not open'}</strong></div>` : lu.album ? grid(lu.album.map((id) => tile(byId(id), lu.loaded[id])).join('')) : '',
          gps: lu.album && !lu.denied ? (() => { const g = lu.album.filter((id) => lu.gps[id]); return g.length ? `<div class="app-card is-fail"><strong>📍 Location visible in ${g.length} photo${g.length > 1 ? 's' : ''}</strong>${g.map((id) => `<span class="app-sub">${esc(byId(id).name)}: ${esc(lu.gps[id])}</span>`).join('')}</div>` : Object.keys(lu.gps).length ? '<div class="app-card is-ok"><strong>✓ No location in these copies</strong></div>' : ''; })() : '',
          exp: lu.album && !lu.denied && lu.urls ? `<p class="app-sub">Photo URLs expire ${st.config.shortUrls ? (Object.values(lu.urls)[0].exp > sim.now ? `in ${SDL.fmtMs(Object.values(lu.urls)[0].exp - sim.now)}` : 'now: asking for fresh ones') : 'in 30 days'}</p>` : '',
        }, {});
        const c = sim.scenario.consistency(sim);
        const total = st.stats.cdnHits + st.stats.cdnMisses;
        const cached = (k) => { const e = st.cache[k]; return e && e.until > sim.now ? (e.allow ? 'allow' : 'deny') : 'not cached'; };
        const rows = `<div class="ops-shards">
          <div class="ops-row" data-tone="${!member && cached('album:omar') === 'allow' ? 'fail' : ''}"><div class="ops-name">Omar<span>ACL: ${member ? 'member' : st.removedAt.omar != null ? 'removed' : 'not a member'} · cache: ${cached('album:omar')}</span></div></div>
          <div class="ops-row" data-tone="${st.link && !st.link.active && lu.open ? 'warn' : ''}"><div class="ops-name">Link<span>${st.link ? `${st.link.active ? 'on' : 'off'} · URLs last ${st.config.shortUrls ? `${URL_TTL / 1000} s` : '30 days'}` : 'none'}</span></div></div>
          <div class="ops-row" data-tone="${sim.nodes.lena.modes.viral ? 'warn' : ''}"><div class="ops-name">Crowd<span>${st.stats.crowdViews} viewers · CDN hits ${total ? Math.round((st.stats.cdnHits / total) * 100) : 0}% · blob reads ${st.stats.blobReads}</span></div></div></div>`;
        SDL.ui.paintSections(el.querySelector('[data-ref="status"]'), { rows, recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>` }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
