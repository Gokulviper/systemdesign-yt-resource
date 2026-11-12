/*
 * Stories and expiry.
 * A story lives 24 hours (scaled to 6 seconds here). Each row carries an
 * expiry time; a sweeper deletes expired rows and fixes the tray; and the
 * read path checks the expiry too, because the sweeper can fall behind and
 * an expired story must never be shown. Viewing a story writes a “seen”
 * row; a celebrity's story turns that one key into millions of writes.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const TTL = 6000; // 24 hours, scaled
  const VIEWERS = 3000; // views per second of the celebrity's story
  const ACCOUNTS = { maya: { name: 'maya.k', hue: 330 }, celeb: { name: 'priya.rao', hue: 40 } };

  function startPost(sim, author) {
    const st = sim.state;
    sim.startAction(`${ACCOUNTS[author].name}: post a story`, function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('gateway', 'post', { author }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) {
        st.stories[r.value.id].actionId = ctx.actionId;
        Y.L(ctx, { accepted: 'yes', committed: ['yes', `Story ${r.value.id}, expires in ${TTL / 1000} s (24 h scaled).`], async: ['pending', 'Updating followers’ trays.'] });
        ctx.explain(`The story row was written with an expiry time ${TTL / 1000} s from now (24 hours, scaled). Followers’ trays were updated so the ring appears on Dev’s phone. Two things will make it disappear: the sweeper deleting the row, and the read path refusing to show anything past its expiry.`);
      } else Y.failed(ctx);
    }, { self: author === 'maya' ? 'maya' : 'crowd' });
  }

  function startView(sim, storyId) {
    const st = sim.state;
    const s = st.stories[storyId];
    if (!s) return;
    sim.startAction(`Dev: view ${ACCOUNTS[s.author].name}’s story`, function* (ctx) {
      const u = ctx.ui.dev;
      Object.assign(u, { viewing: storyId, viewError: '', media: 'loading' });
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'Seen is a set: viewing twice records one view.'] });
      const t0 = ctx.now();
      const r = yield ctx.call('gateway', 'view', { id: storyId, viewer: 'dev' }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.viewMs = ctx.now() - t0;
      if (r.ok) {
        u.media = r.value.media ? 'ok' : 'failed';
        Y.L(ctx, { displayed: ['yes', r.value.media ? 'Story shown.' : 'Story opened but the media failed to load.'], accepted: 'yes', committed: ['yes', 'Seen row written.'], async: 'n/a' });
        ctx.explain(`${r.value.media ? 'The media came through the CDN' : 'The CDN request failed, so the frame stayed grey'}; the seen row for (story, dev) was written in ${Math.round(r.value.seenMs)} ms${r.value.sharded ? ' to the shard for Dev’s viewer id' : ''}. ${ACCOUNTS[s.author].name} sees “Seen by dev”.`);
      } else {
        Object.assign(u, { viewError: r.error.code === 'TIMEOUT' ? 'Couldn’t open the story. Try again.' : `Couldn’t open: ${r.error.message}`, media: 'failed' });
        Y.failed(ctx, 'Shows an error instead of the story.');
        const w = ctx.sim.queueWait('seen');
        ctx.explain(w > 300
          ? `Recording the view timed out: the seen store is ${Math.round(w)} ms behind because ${Y.num(VIEWERS)} people a second are viewing ${ACCOUNTS.celeb.name}’s story and every view writes to the same store. Dev’s view of a 1,200-follower account waits in the same queue.`
          : `Viewing failed: ${r.error.message}`);
      }
    }, { self: 'dev' });
  }

  function setCelebStory(sim, on) {
    const st = sim.state;
    if (on && !st.celebLive) { st.celebLive = true; startPost(sim, 'celeb'); }
    st.flood = on;
    sim.note(on ? `${Y.num(VIEWERS)} people a second start viewing ${ACCOUNTS.celeb.name}’s story.` : 'The viewing rush is over.');
  }

  const sc = (SDL.scenarios['ig-stories'] = {
    id: 'ig-stories',
    seed: 623,
    productWidth: 620,
    intro: 'Maya posts a story; the ring appears in Dev’s tray and he views it. Wait six seconds and it expires. Pause the sweeper to see what the read-time check is for, or make the celebrity’s story a hot key.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', sub: 'Posts stories', kind: 'client', x: 90, y: 90, latency: 1, role: 'Posts and sees who viewed.', owns: ['Her stories'] },
        { id: 'dev', label: 'Dev’s phone', sub: 'Views stories', kind: 'client', x: 90, y: 330, latency: 1, role: 'Refreshes the tray every second and views stories.', owns: ['What Dev sees'] },
        { id: 'crowd', label: 'Everyone else', sub: 'Celebrity viewers', kind: 'client', x: 90, y: 540, latency: 1, role: 'Thousands of people a second viewing the celebrity’s story.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Mobile API', kind: 'gateway', x: 300, y: 300, latency: 2, role: 'Routes story posts, tray reads, and views.', ops: [{ name: 'post', desc: 'Post a story.' }, { name: 'tray', desc: 'Read the tray.' }, { name: 'view', desc: 'View a story.' }, { name: 'viewers', desc: 'Who viewed.' }], owns: ['Nothing durable'] },
        { id: 'stories', label: 'Story service', sub: 'Post, tray, view', kind: 'service', x: 520, y: 300, latency: 4, role: 'Writes stories with an expiry, maintains trays, applies the read-time expiry check, records views.', ops: [{ name: 'post', desc: 'Create a story.' }, { name: 'tray', desc: 'Active stories for a viewer.' }, { name: 'view', desc: 'Record a view and fetch media.' }], owns: ['Expiry rule'] },
        { id: 'storiesdb', label: 'Stories DB', sub: 'Rows with expiresAt', kind: 'db', x: 760, y: 150, latency: 6, role: 'One row per story with its expiry time.', ops: [{ name: 'insert', desc: 'Create a row.' }, { name: 'list', desc: 'Stories by authors.' }, { name: 'expire', desc: 'Delete expired rows.' }], owns: ['stories'] },
        { id: 'tray', label: 'Tray cache', sub: 'Per viewer', kind: 'cache', x: 760, y: 300, latency: 3, role: 'Which accounts a viewer follows have active stories, precomputed.', ops: [{ name: 'get', desc: 'Read a tray.' }, { name: 'add', desc: 'Add a story.' }, { name: 'remove', desc: 'Remove a story.' }], owns: ['tray[viewer]'] },
        { id: 'seen', label: 'Seen store', sub: 'One key per story', kind: 'db', x: 760, y: 450, latency: 4, serviceMs: 1, role: '(story, viewer) rows, all views of one story on one key: about 1,000 writes a second.', ops: [{ name: 'record', desc: 'Record a view.' }, { name: 'list', desc: 'Viewers of a story.' }], owns: ['seen[story]'] },
        { id: 'seenShards', label: 'Seen store, sharded', sub: 'By viewer id, 8 shards', kind: 'db', x: 980, y: 450, latency: 4, serviceMs: 1, servers: 8, role: 'The same rows split by viewer id across eight shards; the viewer list is gathered from all of them.', ops: [{ name: 'record', desc: 'Record a view.' }, { name: 'list', desc: 'Gather viewers.' }], owns: ['seen[story][shard]'] },
        { id: 'sweeper', label: 'Expiry sweeper', sub: 'Every 0.5 s', kind: 'worker', x: 980, y: 150, latency: 3, role: 'Deletes expired story rows and removes them from trays.', ops: [{ name: 'run', desc: 'Sweep.' }], owns: ['Nothing durable'] },
        { id: 'cdn', label: 'CDN', sub: 'Story media', kind: 'cdn', x: 520, y: 90, latency: 25, role: 'Serves story media near the viewer.', ops: [{ name: 'get', desc: 'Fetch media.' }], owns: ['Cached media'] },
      ],
      edges: [
        { from: 'maya', to: 'gateway', latency: 40 },
        { from: 'dev', to: 'gateway', latency: 40 },
        { from: 'crowd', to: 'gateway', latency: 40 },
        { from: 'gateway', to: 'stories', latency: 4 },
        { from: 'stories', to: 'storiesdb', latency: 4 },
        { from: 'stories', to: 'tray', latency: 3 },
        { from: 'stories', to: 'seen', latency: 4 },
        { from: 'stories', to: 'seenShards', latency: 4, via: [[640, 520], [980, 520]] },
        { from: 'stories', to: 'cdn', latency: 5 },
        { from: 'sweeper', to: 'storiesdb', latency: 4 },
        { from: 'sweeper', to: 'tray', latency: 4, via: [[980, 300]] },
      ],
      queues: [],
    },
    modeLabels: { stale: 'Serving stale entries' },
    failures: [
      { id: 'sweeper-paused', node: 'sweeper', mode: 'paused', label: 'Sweeper paused', desc: 'Expired rows are not deleted and trays are not fixed.' },
      { id: 'tray-stale', node: 'tray', mode: 'stale', label: 'Tray cache stale', desc: 'The tray stops taking updates.' },
      { id: 'seen-slow', node: 'seen', mode: 'slow', params: { factor: 20 }, label: 'Seen store slow', desc: 'Recording a view takes 20× longer.' },
      { id: 'cdn-down', node: 'cdn', mode: 'down', label: 'CDN down', desc: 'Stories open but media fails.' },
      { id: 'db-down', node: 'storiesdb', mode: 'down', label: 'Stories DB down', desc: 'Nothing can be posted.' },
    ],
    switches: Y.switches([
      ['readCheck', 'Check expiry at read time', 'Never return a story whose expiry has passed, whatever the tray says. Off: trust the tray.'],
      ['shardSeen', 'Shard seen rows by viewer', 'Spread each story’s views over eight shards. Off: all views of a story hit one key.'],
      ['trayCache', 'Precomputed tray', 'Read the tray from a per-viewer cache. Off: compute it from the stories database on every read.'],
    ]),
    presets: Y.presets({ readCheck: true, shardSeen: true, trayCache: true }, [
      { id: 'post-view', label: 'Post, view, seen by', desc: 'Maya’s ring appears in Dev’s tray; he views it; her phone shows “Seen by dev”.', run: (s) => { startPost(s, 'maya'); s.schedule(1500, () => startView(s, 'S1')); } },
      { id: 'expire', label: 'Story expires', desc: 'Six seconds after posting, the sweeper deletes the row and the ring leaves Dev’s tray.', run: (s) => startPost(s, 'maya') },
      { id: 'sweeper-paused', label: 'Sweeper paused, read-time check', desc: 'The expired row and tray entry stay, but the read path refuses to return it. Dev never sees an expired story.', run: (s) => { s.inject('sweeper', 'paused'); startPost(s, 'maya'); } },
      { id: 'sweeper-paused-bad', label: 'Sweeper paused, trust the tray', desc: 'Nobody deletes the row and nobody checks the time: a story posted “24 hours” ago is still in Dev’s tray.', sw: { readCheck: false }, run: (s) => { s.inject('sweeper', 'paused'); startPost(s, 'maya'); } },
      { id: 'view-twice', label: 'View twice', desc: 'Dev opens the story twice. Seen is a set of viewers: one row, one entry in Maya’s list.', run: (s) => { startPost(s, 'maya'); s.schedule(1500, () => startView(s, 'S1')); s.schedule(2500, () => startView(s, 'S1')); } },
      { id: 'hot', label: 'Celebrity story, one seen key', desc: `${Y.num(VIEWERS)} views a second write to one key. Dev’s view of Maya’s story waits in the same queue and times out.`, sw: { shardSeen: false }, run: (s) => { startPost(s, 'maya'); s.schedule(400, () => setCelebStory(s, true)); s.schedule(2500, () => startView(s, 'S1')); s.schedule(6000, () => setCelebStory(s, false)); } },
      { id: 'hot-sharded', label: 'Celebrity story, seen rows sharded', desc: 'The same views spread over eight shards by viewer id. Dev’s view is recorded in a few milliseconds.', run: (s) => { startPost(s, 'maya'); s.schedule(400, () => setCelebStory(s, true)); s.schedule(2500, () => startView(s, 'S1')); s.schedule(6000, () => setCelebStory(s, false)); } },
      { id: 'tray-stale', label: 'Tray cache stale', desc: 'Maya posts twice, but the tray cache stops taking updates: Dev never sees a ring.', run: (s) => { s.inject('tray', 'stale'); startPost(s, 'maya'); s.schedule(4000, () => startPost(s, 'maya')); } },
      { id: 'tray-nocache', label: 'Tray cache stale, tray computed per read', desc: 'With no precomputed tray, each read lists active stories from the database: slower, but the rings appear.', sw: { trayCache: false }, run: (s) => { s.inject('tray', 'stale'); startPost(s, 'maya'); s.schedule(4000, () => startPost(s, 'maya')); } },
      { id: 'cdn-down', label: 'CDN down', desc: 'The view is recorded, but the media never arrives: a grey frame.', run: (s) => { s.inject('cdn', 'down'); startPost(s, 'maya'); s.schedule(1500, () => startView(s, 'S1')); } },
    ]),
    initialState: () => ({
      config: { readCheck: true, shardSeen: true, trayCache: true },
      stories: {}, trays: { dev: [] }, seen: {}, follows: { dev: ['maya', 'celeb'] },
      flood: false, celebLive: false,
      stats: { expired: 0, hiddenAtRead: 0, crowdViews: 0, crowdTimeouts: 0, trayFromDb: 0 },
      seq: { story: 0 },
    }),
    initialUI: () => ({ maya: { viewers: {} }, dev: { tray: [], viewing: null, viewError: '', media: '', viewMs: null, trayMs: null } }),
    actions: {
      post(sim, a) { startPost(sim, (a && a.author) || 'maya'); },
      view(sim, a) { startView(sim, a.id); },
      celeb(sim, a) { setCelebStory(sim, !!a.on); },
      set: Y.setAction,
    },
    handlers: {
      gateway: {
        post: function* (ctx, p) { return ctx.must(yield ctx.call('stories', 'post', p, { timeout: 1300 })); },
        tray: function* (ctx, p) { return ctx.must(yield ctx.call('stories', 'tray', p, { timeout: 1300 })); },
        view: function* (ctx, p) { return ctx.must(yield ctx.call('stories', 'view', p, { timeout: 1300 })); },
        viewers: function* (ctx, p) { return ctx.must(yield ctx.call(ctx.state.config.shardSeen ? 'seenShards' : 'seen', 'list', p, { timeout: 800 })); },
      },
      stories: {
        post: function* (ctx, p) {
          const r = ctx.must(yield ctx.call('storiesdb', 'insert', { author: p.author, expiresAt: ctx.now() + TTL }, { timeout: 900 }));
          yield ctx.call('tray', 'add', { viewer: 'dev', id: r.id }, { timeout: 400 });
          return { id: r.id };
        },
        tray: function* (ctx, p) {
          const st = ctx.state;
          let ids;
          if (st.config.trayCache) ids = ctx.must(yield ctx.call('tray', 'get', { viewer: p.viewer }, { timeout: 500 })).ids;
          else { st.stats.trayFromDb++; ids = ctx.must(yield ctx.call('storiesdb', 'list', { authors: st.follows[p.viewer] }, { timeout: 900 })).ids; }
          const now = ctx.now();
          const out = [];
          for (const id of ids) {
            const s = st.stories[id];
            if (!s) continue;
            if (st.config.readCheck && s.expiresAt <= now) { st.stats.hiddenAtRead++; continue; }
            out.push({ id, author: s.author, expiresAt: s.expiresAt });
          }
          return { stories: out };
        },
        view: function* (ctx, p) {
          const st = ctx.state;
          const s = st.stories[p.id];
          if (!s) ctx.fail('GONE', 'This story is no longer available.');
          if (st.config.readCheck && s.expiresAt <= ctx.now()) ctx.fail('EXPIRED', 'This story has expired.');
          const t0 = ctx.now();
          ctx.must(yield ctx.call(st.config.shardSeen ? 'seenShards' : 'seen', 'record', { id: p.id, viewer: p.viewer }, { timeout: 1200 }));
          const seenMs = ctx.now() - t0;
          const m = yield ctx.call('cdn', 'get', { id: p.id }, { timeout: 800 });
          return { media: m.ok, seenMs, sharded: st.config.shardSeen };
        },
      },
      storiesdb: {
        insert(ctx, p) { const st = ctx.state; const id = 'S' + ++st.seq.story; st.stories[id] = { id, author: p.author, t: ctx.now(), expiresAt: p.expiresAt }; return { id }; },
        list(ctx, p) { return { ids: Object.values(ctx.state.stories).filter((s) => p.authors.includes(s.author)).map((s) => s.id) }; },
        expire(ctx) {
          const st = ctx.state;
          const due = Object.values(st.stories).filter((s) => s.expiresAt <= ctx.now()).map((s) => s.id);
          for (const id of due) { delete st.stories[id]; st.stats.expired++; }
          return { ids: due };
        },
      },
      tray: {
        get(ctx, p) { return { ids: ctx.state.trays[p.viewer].slice() }; },
        add(ctx, p) { if (ctx.mode('stale')) return { ignored: true }; const t = ctx.state.trays[p.viewer]; if (!t.includes(p.id)) t.push(p.id); return { ok: true }; },
        remove(ctx, p) { if (ctx.mode('stale')) return { ignored: true }; ctx.state.trays[p.viewer] = ctx.state.trays[p.viewer].filter((x) => x !== p.id); return { ok: true }; },
      },
      seen: seenHandlers(), seenShards: seenHandlers(),
    },
    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(500);
          if (ctx.mode('paused')) continue;
          const r = yield ctx.call('storiesdb', 'expire', {}, { timeout: 900, quiet: 'all' });
          if (!r.ok || !r.value.ids.length) continue;
          for (const id of r.value.ids) yield ctx.call('tray', 'remove', { viewer: 'dev', id }, { timeout: 400, quiet: 'all' });
          ctx.log({ op: `expired ${r.value.ids.join(', ')}`, status: 'ok', detail: `${TTL / 1000} s (24 h scaled) after posting: row deleted and removed from trays.` });
        }
      }, { self: 'sweeper', quiet: 'all' });
      // Dev’s tray refreshes every second; Maya’s viewer list too.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(1000);
          const t0 = ctx.now();
          const r = yield ctx.call('gateway', 'tray', { viewer: 'dev' }, { timeout: 1500, quiet: 'all' });
          ctx.ui.dev.trayMs = ctx.now() - t0;
          if (r.ok) ctx.ui.dev.tray = r.value.stories;
          const mine = Object.values(ctx.state.stories).filter((s) => s.author === 'maya');
          for (const s of mine) { const v = yield ctx.call('gateway', 'viewers', { id: s.id }, { timeout: 1500, quiet: 'all' }); if (v.ok) ctx.ui.maya.viewers[s.id] = v.value.viewers; }
        }
      }, { self: 'dev', quiet: 'all' });
      Y.load(sim, 'crowd', (s) => (s.state.flood ? VIEWERS : 0), function* (ctx) {
        const st = ctx.state;
        const celeb = Object.values(st.stories).find((s) => s.author === 'celeb');
        if (!celeb) return;
        st.stats.crowdViews++;
        const r = yield ctx.call(st.config.shardSeen ? 'seenShards' : 'seen', 'record', { id: celeb.id, viewer: 'v' + st.stats.crowdViews, bulk: true }, { timeout: 1200, quiet: 'all' });
        if (!r.ok) st.stats.crowdTimeouts++;
      });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.dev;
      const shownExpired = u.tray.find((s) => s.expiresAt <= sim.now - 300);
      if (shownExpired) return { key: 'wrong', label: `Dev’s tray shows ${ACCOUNTS[shownExpired.author].name}’s story ${((sim.now - shownExpired.expiresAt) / 1000).toFixed(1)} s after it expired. An expired story must never be shown.` };
      for (const [id, viewers] of Object.entries(st.seen)) if (viewers.filter((v) => v === 'dev').length > 1) return { key: 'wrong', label: `Story ${id} counts dev as two viewers.` };
      if (u.viewError) return { key: 'stale', label: `Dev could not open a story: the seen store is overloaded by ${ACCOUNTS.celeb.name}’s viewers.` };
      if (u.viewing && u.media === 'failed') return { key: 'stale', label: 'Dev opened a story but its media failed to load.' };
      const missing = Object.values(st.stories).filter((s) => s.author === 'maya' && s.expiresAt > sim.now && sim.now - s.t > 2000 && !u.tray.some((x) => x.id === s.id));
      if (missing.length) return { key: 'stale', label: `Maya posted ${missing[0].id} ${((sim.now - missing[0].t) / 1000).toFixed(1)} s ago and it is not in Dev’s tray.` };
      const zombie = Object.values(st.stories).filter((s) => s.expiresAt <= sim.now - 300);
      if (zombie.length) return { key: 'stale', label: `${zombie.length} expired stor${zombie.length > 1 ? 'ies are' : 'y is'} still stored and in the tray cache; the read-time check hides ${zombie.length > 1 ? 'them' : 'it'}, so nobody sees ${zombie.length > 1 ? 'them' : 'it'}.` };
      return { key: 'ok', label: 'Every active story is in the tray, no expired story is visible, and every view is counted once.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const u = sim.ui.dev;
      const w = sim.queueWait(st.config.shardSeen ? 'seenShards' : 'seen');
      return [
        { label: 'Active stories', value: Object.values(st.stories).filter((s) => s.expiresAt > sim.now).length },
        { label: 'Expired by the sweeper', value: st.stats.expired },
        { label: 'Hidden at read time', value: st.stats.hiddenAtRead, tone: st.stats.hiddenAtRead ? 'warn' : '' },
        { label: 'View time', value: u.viewMs == null ? 'n/a' : SDL.fmtMs(u.viewMs), tone: u.viewError ? 'fail' : u.viewMs > 500 ? 'warn' : '' },
        { label: 'Seen store queue', value: SDL.fmtMs(w), tone: w > 500 ? 'fail' : w > 100 ? 'warn' : '' },
        { label: 'Celebrity views recorded', value: Y.num(st.stats.crowdViews - st.stats.crowdTimeouts) },
        { label: 'Views timed out', value: Y.num(st.stats.crowdTimeouts), tone: st.stats.crowdTimeouts ? 'fail' : '' },
        { label: 'Tray read', value: u.trayMs == null ? 'n/a' : SDL.fmtMs(u.trayMs) },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone'], ['dev', 'Dev’s phone']], {
          note: `Stories last ${TTL / 1000} s here (24 hours, scaled). The console below posts the celebrity’s story and sends thousands of viewers a second at it.`,
          below: `<div class="ops-console"><p class="ops-title">Celebrity story</p><div class="ops-traffic">${Y.btn('celeb', 'priya.rao posts; 3,000 views/s', { arg: { on: true } })}${Y.btn('celeb', 'Stop the viewers', { arg: { on: false }, cls: 'secondary' })}</div><div data-ref="status"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const d = sim.ui.dev;
        const m = sim.ui.maya;
        const mine = Object.values(st.stories).filter((s) => s.author === 'maya');
        const ring = (s) => `<div class="app-card" style="display:flex;gap:8px;align-items:center"><span class="yt-thumb" style="--h:${ACCOUNTS[s.author].hue};width:44px;height:44px;border-radius:50%;flex:none;border:3px solid var(--event, #8b5cf6)"></span><span><strong>${esc(ACCOUNTS[s.author].name)}</strong><br><span class="app-sub">expires in <span data-live="exp-${s.id}"></span></span></span></div>`;
        Y.paint(el, sim, 'maya', {
          head: '<div><p class="app-title">Instagram</p><p class="app-sub">maya.k · your story</p></div>',
          post: Y.btn('post', mine.length ? 'Add to your story' : 'Post a story', { arg: { author: 'maya' }, cls: 'go' }),
          mine: mine.length ? mine.map((s) => `<div class="app-card"><strong>${esc(s.id)}</strong><span class="app-sub">expires in <span data-live="exp-${s.id}"></span> · ${(m.viewers[s.id] || []).length ? `Seen by ${(m.viewers[s.id] || []).map(esc).join(', ')}` : 'No views yet'}</span></div>`).join('') : '<p class="app-sub">No active story.</p>',
        }, Object.fromEntries(mine.map((s) => [`exp-${s.id}`, `${(Math.max(0, s.expiresAt - sim.now) / 1000).toFixed(1)} s`])));
        const trayLive = Object.fromEntries(d.tray.map((s) => [`exp-${s.id}`, s.expiresAt > sim.now ? `${((s.expiresAt - sim.now) / 1000).toFixed(1)} s` : `expired ${((sim.now - s.expiresAt) / 1000).toFixed(1)} s ago ✕`]));
        const viewer = d.viewing && st.stories[d.viewing] ? `<div class="app-card ${d.media === 'failed' ? 'is-fail' : ''}"><strong>${esc(ACCOUNTS[st.stories[d.viewing].author].name)}</strong><div class="yt-thumb" style="--h:${ACCOUNTS[st.stories[d.viewing].author].hue};height:90px;${d.media === 'ok' ? '' : 'filter:grayscale(1);opacity:.5'}"><span aria-hidden="true">${d.media === 'failed' ? '✕' : d.media === 'loading' ? '…' : '◉'}</span></div><span class="app-sub">${d.media === 'ok' ? 'Viewed' : d.media === 'failed' ? 'Media failed to load' : 'Loading…'}</span></div>` : '';
        Y.paint(el, sim, 'dev', {
          head: '<div><p class="app-title">Instagram</p><p class="app-sub">Stories tray</p></div>',
          tray: d.tray.length ? d.tray.map((s) => ring(s) + Y.btn('view', 'View', { arg: { id: s.id }, cls: 'secondary' })).join('') : '<p class="app-sub">No stories right now.</p>',
          msg: Y.msg(d.viewError, 'fail'), viewer,
        }, trayLive);
        const c = sim.scenario.consistency(sim);
        const w = sim.queueWait(st.config.shardSeen ? 'seenShards' : 'seen');
        SDL.ui.paintSections(el.querySelector('[data-ref="status"]'), {
          rows: `<div class="ops-shards"><div class="ops-row" data-tone="${w > 500 ? 'fail' : w > 100 ? 'warn' : ''}"><div class="ops-name">${st.config.shardSeen ? 'Seen store, 8 shards' : 'Seen store, one key per story'}<span>queue ${Math.round(w)} ms · ${Y.num(st.stats.crowdViews - st.stats.crowdTimeouts)} celebrity views recorded${st.stats.crowdTimeouts ? ` · ${Y.num(st.stats.crowdTimeouts)} timed out` : ''}</span></div></div>
            <div class="ops-row"><div class="ops-name">Stories DB<span>${Object.keys(st.stories).length} row${Object.keys(st.stories).length === 1 ? '' : 's'} · ${st.stats.expired} deleted by the sweeper · ${st.stats.hiddenAtRead} hidden at read time</span></div></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  function seenHandlers() {
    return {
      record(ctx, p) {
        const st = ctx.state;
        if (p.bulk) return { recorded: true };
        st.seen[p.id] = st.seen[p.id] || [];
        if (!st.seen[p.id].includes(p.viewer)) st.seen[p.id].push(p.viewer);
        return { recorded: true };
      },
      list(ctx, p) { return { viewers: (ctx.state.seen[p.id] || []).slice() }; },
    };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
