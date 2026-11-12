/*
 * Activity and notifications.
 * Every like is a row keyed by (post, user) and an event. An aggregator
 * collects the events for one post into a window and writes one activity
 * entry, “dev and 12 others liked your photo”, with one push, instead of
 * thirteen. A per-user limiter caps pushes when aggregation is off or bursts
 * come from many posts. Events can arrive twice; the dedupe key keeps the
 * count honest. If push is down the activity tab still has everything.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const WINDOW = 2000; // aggregation window
  const LIMIT = 3; // pushes per user per LIMIT_WINDOW
  const LIMIT_WINDOW = 10000;
  const OTHERS = ['ana', 'raj', 'lee', 'mia', 'omar', 'zoe', 'kai', 'ivy', 'noor', 'theo', 'lina', 'ben'];

  function startLike(sim, user, label) {
    sim.startAction(label || `${user}: like Maya’s photo`, function* (ctx) {
      const st = ctx.state;
      Y.L(ctx, { displayed: 'yes', retrySafe: ['yes', 'A like is desired state per (post, user).'] });
      const r = yield ctx.call('posts', 'like', { post: 'P1', user }, { timeout: 1200 });
      ctx.recordOutcome(r.ok, r.latency);
      if (r.ok) {
        Y.L(ctx, { accepted: 'yes', committed: ['yes', r.value.changed ? 'Like row written, event published.' : 'Already liked: nothing changed.'], async: r.value.changed ? ['pending', 'Activity for Maya.'] : 'n/a' });
        if (r.value.changed) st.likeActions[user] = ctx.actionId;
      } else Y.failed(ctx);
    }, { self: 'likers' });
  }

  function startBurst(sim, n) {
    const users = ['dev'].concat(OTHERS).slice(0, n);
    users.forEach((u, i) => sim.schedule(i * 140, () => startLike(sim, u)));
  }

  const sc = (SDL.scenarios['ig-activity'] = {
    id: 'ig-activity',
    seed: 631,
    productWidth: 600,
    intro: 'Dev likes Maya’s photo: one activity, one push. Then send thirteen likes in two seconds with and without aggregation, deliver the events twice, pause the aggregator, or take the push provider down.',
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'likers', label: 'Dev and 12 others', sub: 'Like the photo', kind: 'client', x: 90, y: 90, latency: 1, role: 'People liking Maya’s photo, singly or in a burst.', owns: ['Nothing'] },
        { id: 'maya', label: 'Maya’s phone', sub: 'Activity tab + pushes', kind: 'client', x: 90, y: 400, latency: 1, role: 'Receives pushes and refreshes the activity tab every second.', ops: [{ name: 'push', desc: 'Show a push.' }], owns: ['What Maya sees'] },
        { id: 'posts', label: 'Post service', sub: 'Likes', kind: 'service', x: 320, y: 90, latency: 4, role: 'Stores a like as desired state and publishes one event per real change.', ops: [{ name: 'like', desc: 'Like a post.' }], owns: ['Like rules'] },
        { id: 'likesdb', label: 'Likes', sub: '(post, user) rows', kind: 'db', x: 560, y: 40, latency: 6, role: 'One row per (post, user); the count is the number of rows.', ops: [{ name: 'set', desc: 'Set liked = true.' }], owns: ['likes'] },
        { id: 'events', label: 'Like events', sub: 'Event broker', kind: 'queue', x: 560, y: 180, latency: 4, queue: 'likes', role: 'One event per new like, at least once.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['event log'] },
        { id: 'aggregator', label: 'Activity aggregator', sub: `${WINDOW / 1000} s windows`, kind: 'worker', x: 800, y: 180, latency: 4, role: 'Deduplicates events and groups the likes on one post into a window; writes one entry and sends one push per window.', ops: [{ name: 'consume', desc: 'Handle an event.' }], owns: ['Open windows', 'Dedupe keys'] },
        { id: 'activitydb', label: 'Activity store', sub: 'Per user', kind: 'db', x: 800, y: 330, latency: 6, role: 'The entries in Maya’s activity tab, each with its actor list and count.', ops: [{ name: 'upsert', desc: 'Write or merge an entry.' }, { name: 'list', desc: 'Entries for a user.' }], owns: ['activity[user]'] },
        { id: 'limiter', label: 'Push limiter', sub: `${LIMIT} per ${LIMIT_WINDOW / 1000} s`, kind: 'cache', x: 1020, y: 330, latency: 2, role: 'Counts pushes per user in a sliding window; beyond the limit a notification stays in-app only.', ops: [{ name: 'allow', desc: 'May we push?' }], owns: ['push counts'] },
        { id: 'push', label: 'Push provider', sub: 'APNs and FCM', kind: 'service', x: 560, y: 400, latency: 40, role: 'Delivers pushes to Maya’s phone.', ops: [{ name: 'send', desc: 'Deliver a push.' }], owns: ['Device tokens'] },
      ],
      edges: [
        { from: 'likers', to: 'posts', latency: 40 },
        { from: 'posts', to: 'likesdb', latency: 4 },
        { from: 'posts', to: 'events', latency: 4 },
        { from: 'events', to: 'aggregator', latency: 4 },
        { from: 'aggregator', to: 'activitydb', latency: 4 },
        { from: 'aggregator', to: 'limiter', latency: 3, via: [[1020, 180]] },
        { from: 'aggregator', to: 'push', latency: 5, via: [[800, 460], [560, 460]] },
        { from: 'push', to: 'maya', latency: 40 },
        { from: 'maya', to: 'activitydb', latency: 40, label: 'refresh', via: [[300, 520], [800, 520]] },
      ],
      queues: [{ id: 'likes', broker: 'events', label: 'like events', groups: ['aggregator'] }],
    },
    failures: [
      { id: 'dup', node: 'events', mode: 'duplicate', label: 'Events delivered twice', desc: 'Every like event arrives twice.' },
      { id: 'agg-paused', node: 'aggregator', mode: 'paused', label: 'Aggregator paused', desc: 'Events wait; no activity is written.' },
      { id: 'push-down', node: 'push', mode: 'down', label: 'Push provider down', desc: 'Pushes fail; the activity tab still updates.' },
      { id: 'activity-slow', node: 'activitydb', mode: 'slow', params: { factor: 30 }, label: 'Activity store slow', desc: 'Entries take longer to appear.' },
      { id: 'likes-down', node: 'likesdb', mode: 'down', label: 'Likes store down', desc: 'Likes fail; no events.' },
    ],
    switches: Y.switches([
      ['aggregate', 'Aggregate likes per post', `Collect likes on one post for ${WINDOW / 1000} s and write one entry, “dev and N others”. Off: one entry and one push per like.`],
      ['dedupe', 'Deduplicate events', 'Skip an event id already handled. Off: a redelivered event counts again.'],
      ['limit', 'Per-user push limit', `At most ${LIMIT} pushes per ${LIMIT_WINDOW / 1000} s; the rest stay in the activity tab.`],
    ]),
    presets: Y.presets({ aggregate: true, dedupe: true, limit: true }, [
      { id: 'like', label: 'One like', desc: 'Dev likes the photo. One entry, one push: “dev liked your photo”.', run: (s) => startLike(s, 'dev') },
      { id: 'double', label: 'Dev taps twice', desc: 'The like is desired state: the second tap changes nothing and publishes no event.', run: (s) => { startLike(s, 'dev'); s.schedule(80, () => startLike(s, 'dev', 'dev: like (second tap)')); } },
      { id: 'burst', label: 'Thirteen likes, aggregated', desc: 'Thirteen likes in two seconds become one entry, “dev and 12 others liked your photo”, and one push.', run: (s) => startBurst(s, 13) },
      { id: 'burst-noagg', label: 'Thirteen likes, no aggregation, limited', desc: 'Thirteen entries and thirteen push attempts; the limiter lets three through, the rest are in-app only.', sw: { aggregate: false }, run: (s) => startBurst(s, 13) },
      { id: 'burst-spam', label: 'Thirteen likes, no aggregation, no limit', desc: 'Maya’s phone buzzes thirteen times in two seconds. She turns notifications off.', sw: { aggregate: false, limit: false }, run: (s) => startBurst(s, 13) },
      { id: 'dup', label: 'Events twice, deduplicated', desc: 'Every event arrives twice; the dedupe key drops the copies. Still “dev and 12 others”.', run: (s) => { s.inject('events', 'duplicate'); startBurst(s, 13); } },
      { id: 'dup-bad', label: 'Events twice, no dedupe', desc: 'The copies are counted: “dev and 25 others” for thirteen people.', sw: { dedupe: false }, run: (s) => { s.inject('events', 'duplicate'); startBurst(s, 13); } },
      { id: 'agg-paused', label: 'Aggregator paused', desc: 'Likes are stored, events wait in the broker, Maya hears nothing until it resumes.', run: (s) => { s.inject('aggregator', 'paused'); startBurst(s, 5); } },
      { id: 'push-down', label: 'Push provider down', desc: 'The entry is written and shows in the activity tab; the push fails and is retried.', run: (s) => { s.inject('push', 'down'); startLike(s, 'dev'); } },
    ]),
    initialState: () => ({
      config: { aggregate: true, dedupe: true, limit: true },
      likes: { P1: {} }, windows: {}, activity: [], pushTimes: [], likeActions: {},
      stats: { events: 0, pushes: 0, suppressed: 0, pushFails: 0, dupSkipped: 0 },
      seq: { entry: 0 },
    }),
    initialUI: () => ({ maya: { entries: [], pushes: [], banner: null, spam: false } }),
    actions: {
      like(sim, a) { startLike(sim, a.user || 'dev'); },
      burst(sim, a) { startBurst(sim, (a && a.n) || 13); },
      set: Y.setAction,
    },
    handlers: {
      posts: {
        like: function* (ctx, p) {
          const r = ctx.must(yield ctx.call('likesdb', 'set', p, { timeout: 900 }));
          if (r.changed) yield ctx.call('events', 'publish', { post: p.post, user: p.user }, { timeout: 500 });
          return r;
        },
      },
      likesdb: {
        set(ctx, p) { const rows = ctx.state.likes[p.post]; const had = !!rows[p.user]; rows[p.user] = true; return { changed: !had, count: Object.keys(rows).length }; },
      },
      events: { publish(ctx, p) { ctx.state.stats.events++; ctx.sim.enqueue('likes', { type: 'like', eventId: `${p.post}/${p.user}`, payload: p, actionId: ctx.state.likeActions[p.user] || ctx.actionId }); return { appended: true }; } },
      activitydb: {
        upsert(ctx, p) {
          const st = ctx.state;
          let e = p.merge ? st.activity.find((x) => x.post === p.post && x.type === 'like') : null;
          if (!e) { e = { id: 'A' + ++st.seq.entry, post: p.post, type: 'like', actors: [], count: 0, t: ctx.now() }; st.activity.push(e); }
          for (const a of p.actors) e.actors.push(a);
          e.count += p.count;
          e.text = e.count === 1 ? `${e.actors[0]} liked your photo` : `${e.actors[0]} and ${e.count - 1} other${e.count - 1 === 1 ? '' : 's'} liked your photo`;
          e.t = ctx.now();
          return { id: e.id, text: e.text };
        },
        list(ctx) { return { entries: ctx.state.activity.slice().reverse() }; },
      },
      limiter: {
        allow(ctx) {
          const st = ctx.state;
          if (!st.config.limit) return { allow: true };
          const recent = st.pushTimes.filter((t) => ctx.now() - t < LIMIT_WINDOW).length;
          return { allow: recent < LIMIT, recent };
        },
      },
      push: { send: function* (ctx, p) { return ctx.must(yield ctx.call('maya', 'push', p, { timeout: 500 })); } },
      maya: {
        push(ctx, p) {
          const u = ctx.ui.maya;
          const st = ctx.state;
          u.pushes.unshift({ text: p.text, t: ctx.now() });
          u.banner = { title: 'Instagram', body: p.text, tone: 'ok', t: ctx.now() };
          st.pushTimes.push(ctx.now());
          st.stats.pushes++;
          if (st.pushTimes.filter((t) => ctx.now() - t < LIMIT_WINDOW).length > LIMIT) u.spam = true;
          return { shown: true };
        },
      },
    },
    setup(sim) {
      const notify = function* (ctx, entryText, actionId) {
        const st = ctx.state;
        const ok = yield ctx.call('limiter', 'allow', { user: 'maya' }, { timeout: 300, actionId });
        if (ok.ok && !ok.value.allow) { st.stats.suppressed++; ctx.log({ op: 'push suppressed by the limiter', status: 'note', actionId, detail: `Maya already had ${LIMIT} pushes in ${LIMIT_WINDOW / 1000} s. This one is in the activity tab only.` }); ctx.sim.setLedger(actionId, 'async', 'yes', 'In the activity tab; push suppressed by the limiter.'); return; }
        for (let a = 1; a <= 3; a++) {
          const r = yield ctx.call('push', 'send', { text: entryText }, { timeout: 800, actionId });
          if (r.ok) { ctx.sim.setLedger(actionId, 'async', 'yes', 'Activity written and pushed.'); return; }
          st.stats.pushFails++;
          yield ctx.wait(300 * a);
        }
        ctx.log({ op: 'push failed; activity tab has it', status: 'retry', actionId, detail: 'The provider is down. The entry is already in the activity store, so Maya sees it when she opens the app.' });
      };
      Y.consumer(sim, 'likes', 'aggregator', 'aggregator', function* (ctx, msg) {
        const st = ctx.state;
        const p = msg.payload;
        if (!st.config.aggregate) {
          const w = yield ctx.call('activitydb', 'upsert', { post: p.post, actors: [p.user], count: 1, merge: false }, { timeout: 900, actionId: msg.actionId });
          if (!w.ok) return false;
          yield* notify(ctx, w.value.text, msg.actionId);
          return true;
        }
        const key = p.post;
        let win = st.windows[key];
        if (!win) {
          win = st.windows[key] = { actors: [], count: 0, opened: ctx.now(), actionIds: [] };
          ctx.log({ op: `window opened for ${p.post}`, status: 'note', actionId: msg.actionId, detail: `Likes on this post for the next ${WINDOW / 1000} s will become one activity entry.` });
          ctx.spawn(function* (c) {
            yield c.wait(WINDOW);
            const w = c.state.windows[key];
            delete c.state.windows[key];
            const r = yield c.call('activitydb', 'upsert', { post: key, actors: w.actors, count: w.count, merge: true }, { timeout: 900, actionId: w.actionIds[0] });
            if (!r.ok) return;
            c.log({ op: `window closed: ${w.count} like${w.count === 1 ? '' : 's'} → one entry`, status: 'ok', actionId: w.actionIds[0], detail: `“${r.value.text}”.` });
            for (const id of w.actionIds.slice(1)) c.sim.setLedger(id, 'async', 'yes', 'Merged into the aggregated entry.');
            yield* notify(c, r.value.text, w.actionIds[0]);
          }, { self: 'aggregator' });
        }
        win.actors.push(p.user);
        win.count++;
        win.actionIds.push(msg.actionId);
        return true;
      }, (s) => s.state.config.dedupe);
      // Maya’s phone refreshes the activity tab every second.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(1000);
          const r = yield ctx.call('activitydb', 'list', { user: 'maya' }, { timeout: 1000, quiet: 'all' });
          if (r.ok) ctx.ui.maya.entries = r.value.entries;
        }
      }, { self: 'maya', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.maya;
      const likers = Object.keys(st.likes.P1).length;
      const over = st.activity.find((e) => e.count > likers);
      if (over) return { key: 'wrong', label: `The activity entry says ${over.count} people liked the photo; ${likers} did. Redelivered events were counted again.` };
      if (u.spam) return { key: 'wrong', label: `More than ${LIMIT} pushes in ${LIMIT_WINDOW / 1000} s: notification spam. Maya mutes the app.` };
      const depth = sim.queueStats('likes').depth;
      const openWindows = Object.keys(st.windows).length;
      if (depth && sim.nodes.aggregator.modes.paused) return { key: 'stale', label: `${depth} like event${depth > 1 ? 's are' : ' is'} waiting: the aggregator is paused and Maya has not been told.` };
      if (st.stats.pushFails && sim.nodes.push.modes.down) return { key: 'stale', label: 'The entry is in Maya’s activity tab, but the push could not be delivered: the provider is down.' };
      const total = st.activity.reduce((a, e) => a + e.count, 0);
      if (depth || openWindows || total < likers) return { key: 'stale', label: openWindows ? `A ${WINDOW / 1000} s window is open: likes are being collected into one entry.` : 'Likes are still on their way to the activity store.' };
      if (st.stats.suppressed) return { key: 'stale', label: `${st.stats.suppressed} push${st.stats.suppressed > 1 ? 'es were' : ' was'} suppressed by the limiter; those likes are in the activity tab only.` };
      return { key: 'ok', label: `Every like is counted once (${likers}), Maya was told without being spammed, and the activity tab matches the likes.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const u = sim.ui.maya;
      return [
        { label: 'Likes on the photo', value: Object.keys(st.likes.P1).length },
        { label: 'Activity entries', value: st.activity.length },
        { label: 'Pushes delivered', value: st.stats.pushes, tone: u.spam ? 'fail' : '' },
        { label: 'Pushes suppressed', value: st.stats.suppressed, tone: st.stats.suppressed ? 'warn' : '' },
        { label: 'Events', value: st.stats.events },
        { label: 'Duplicates dropped', value: st.dupSkipped || 0 },
        { label: 'Events waiting', value: sim.queueStats('likes').depth },
        { label: 'Open windows', value: Object.keys(st.windows).length },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Maya’s phone shows pushes as banners and the activity tab underneath. The console sends likes at her photo.',
          side: `<p class="ops-title">Likes on Maya’s photo</p><div class="ops-traffic">${Y.btn('like', 'Dev likes', { arg: { user: 'dev' } })}${Y.btn('burst', '13 people like it in 2 s', { arg: { n: 13 } })}${Y.btn('burst', '5 people like it', { arg: { n: 5 }, cls: 'secondary' })}</div><div data-ref="win"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.maya;
        const body = `<p class="app-sub">Pushes (${u.pushes.length})</p>${u.pushes.slice(0, 3).map((p) => `<div class="app-card is-ok">${esc(p.text)}</div>`).join('') || '<p class="app-sub">None yet.</p>'}
          <p class="app-sub">♥ Activity (${u.entries.length})</p>${u.entries.slice(0, 5).map((e) => `<div class="app-card"><strong>${esc(e.text)}</strong><span class="app-sub">${e.count} like${e.count === 1 ? '' : 's'} on your photo</span></div>`).join('') || '<p class="app-sub">No activity yet.</p>'}`;
        Y.paint(el, sim, 'maya', { head: '<div><p class="app-title">Instagram</p><p class="app-sub">maya.k · activity</p></div>', body }, {}, u.banner);
        const c = sim.scenario.consistency(sim);
        const wins = Object.entries(st.windows);
        SDL.ui.paintSections(el.querySelector('[data-ref="win"]'), {
          rows: `<div class="ops-shards"><div class="ops-row" data-tone="${wins.length ? 'warn' : ''}"><div class="ops-name">Aggregation window<span>${wins.length ? `${wins[0][1].count} like${wins[0][1].count === 1 ? '' : 's'} collected · closes in <span data-live="win"></span>` : st.config.aggregate ? 'none open' : 'aggregation off'}</span></div></div>
            <div class="ops-row"><div class="ops-name">Pushes in the last ${LIMIT_WINDOW / 1000} s<span>${st.pushTimes.filter((t) => sim.now - t < LIMIT_WINDOW).length} of ${LIMIT}${st.config.limit ? '' : ' (limit off)'} · ${st.stats.suppressed} suppressed</span></div></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, { win: wins.length ? `${(Math.max(0, wins[0][1].opened + WINDOW - sim.now) / 1000).toFixed(1)} s` : '' });
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
