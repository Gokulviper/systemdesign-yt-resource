/*
 * Subscriptions. Subscribing is an idempotent edge in the subscription graph
 * with a counter updated in the same transaction. New uploads reach
 * subscribers' feeds by fan-out on write (copy into every inbox) or, for huge
 * channels, fan-out on read (pull at request time): the hybrid model.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const CHANNELS = { ana: { name: 'Ana’s Garden', subs: 2100 }, mega: { name: 'MegaStar', subs: 48000000 } };
  const MS_PER_MILLION = 400;

  function startSub(sim, ch) {
    const st = sim.state;
    const on = !st.edges.you[ch];
    const key = `sub-${ch}-${++st.seq.key}`;
    sim.startAction(`Viewer: ${on ? 'subscribe to' : 'unsubscribe from'} ${CHANNELS[ch].name}`, function* (ctx) {
      Y.L(ctx, { displayed: ['pending', 'Pessimistic: the button changes after the server confirms.'], retrySafe: st.config.idem ? ['yes', 'Desired state per (user, channel): repeating it changes nothing.'] : ['no', 'Each call inserts another row.'] });
      const r = yield* ctx.retry({ attempts: 3, baseMs: 150 }, function* () { return yield ctx.call('gateway', 'subscribe', { ch, on, key }, { timeout: 900 }); });
      if (r.ok) { Y.L(ctx, { displayed: 'yes', accepted: 'yes', async: 'n/a' }); ctx.explain(`The subscription edge and ${CHANNELS[ch].name}’s counter changed in one transaction${r.value.changed ? '' : ' (nothing changed: it was already in that state)'}.`); }
      else Y.failed(ctx, 'The button stays as it was.');
    }, { self: 'viewer' });
  }
  function startUpload(sim, ch) {
    const st = sim.state;
    const vid = `${ch}-${++st.seq.video}`;
    sim.startAction(`${CHANNELS[ch].name} uploads a video`, function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const r = yield ctx.call('uploads', 'add', { ch, vid }, { timeout: 800 });
      if (r.ok) { Y.L(ctx, { accepted: 'yes', committed: ['yes', 'The upload is recorded.'], async: ['pending', 'Reaching subscribers’ feeds.'] }); st.published[vid] = { ch, t: ctx.now(), actionId: ctx.actionId }; }
      else Y.failed(ctx);
    }, { self: 'creator' });
  }

  const sc = (SDL.scenarios.subscriptions = {
    id: 'subscriptions',
    seed: 157,
    productWidth: 600,
    intro: 'Subscribe to both channels, then make each one upload. A small channel’s video is copied into every subscriber’s inbox quickly. A 48-million-subscriber channel cannot be copied quickly: that is where hybrid fan-out matters.',
    topology: {
      width: 1100, height: 540,
      nodes: [
        { id: 'viewer', label: 'Viewer app', sub: 'Subscribes, reads feed', kind: 'client', x: 100, y: 90, latency: 1, role: 'Subscribes and reads the subscriptions feed.', owns: ['Nothing'] },
        { id: 'creator', label: 'Creators', sub: 'Upload videos', kind: 'client', x: 100, y: 300, latency: 1, role: 'A small channel and a celebrity channel.', owns: ['Their channels'] },
        { id: 'gateway', label: 'API gateway', sub: 'Viewer traffic', kind: 'gateway', x: 320, y: 90, latency: 2, role: 'Routes subscribe calls and feed reads.', ops: [{ name: 'subscribe', desc: 'Set a subscription.' }, { name: 'feed', desc: 'Read the subscriptions feed.' }], owns: ['Nothing durable'] },
        { id: 'graph', label: 'Subscription graph', sub: 'Edges + counts', kind: 'db', x: 540, y: 90, latency: 8, role: 'One row per (user, channel), unique, with each channel’s count updated in the same transaction.', ops: [{ name: 'set', desc: 'Upsert an edge.' }], owns: ['subscriptions', 'subscriber_count'] },
        { id: 'uploads', label: 'Recent uploads', sub: 'Per channel', kind: 'db', x: 320, y: 300, latency: 6, role: 'Each channel’s latest uploads; emits an event per upload.', ops: [{ name: 'add', desc: 'Record an upload.' }, { name: 'recent', desc: 'Pull recent uploads.' }], owns: ['uploads'] },
        { id: 'events', label: 'Upload events', sub: 'Event broker', kind: 'queue', x: 540, y: 300, latency: 4, queue: 'ups', role: 'One event per upload.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['upload log'] },
        { id: 'fanout', label: 'Feed fan-out', sub: 'Writes inboxes', kind: 'worker', x: 760, y: 300, latency: 4, role: 'Copies each upload into every subscriber’s inbox: work proportional to the subscriber count.', ops: [{ name: 'consume', desc: 'Fan one upload out.' }], owns: ['Its offset'] },
        { id: 'inbox', label: 'Feed inboxes', sub: 'Precomputed feeds', kind: 'cache', x: 760, y: 90, latency: 3, role: 'A ready-made list of new uploads per subscriber.', ops: [{ name: 'write', desc: 'Add to inboxes.' }, { name: 'read', desc: 'Read one inbox.' }], owns: ['inbox[user]'] },
        { id: 'feedsvc', label: 'Feed reader', sub: 'Merges sources', kind: 'service', x: 980, y: 190, latency: 4, role: 'Reads the user’s inbox and, under hybrid fan-out, pulls recent uploads from huge channels at read time.', ops: [{ name: 'read', desc: 'Build the subscriptions feed.' }], owns: ['Nothing'] },
      ],
      edges: [
        { from: 'viewer', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'graph', latency: 4 },
        { from: 'creator', to: 'uploads', latency: 30 },
        { from: 'uploads', to: 'events', latency: 4 },
        { from: 'events', to: 'fanout', latency: 4 },
        { from: 'fanout', to: 'inbox', latency: 4 },
        { from: 'gateway', to: 'feedsvc', latency: 4, via: [[320, 22], [980, 22]] },
        { from: 'feedsvc', to: 'inbox', latency: 3 },
        { from: 'feedsvc', to: 'uploads', latency: 5, via: [[980, 420], [320, 420]], label: 'pull' },
      ],
      queues: [{ id: 'ups', broker: 'events', label: 'uploads', groups: ['fanout'] }],
    },
    failures: [
      { id: 'graph-down', node: 'graph', mode: 'down', label: 'Subscription graph down', desc: 'Subscribing fails cleanly.' },
      { id: 'fanout-paused', node: 'fanout', mode: 'paused', label: 'Fan-out paused', desc: 'New uploads stop reaching inboxes.' },
      { id: 'graph-drop', node: 'graph', mode: 'dropResponse', label: 'Subscribe reply lost', desc: 'The edge is saved but the app retries.' },
    ],
    switches: Y.switches([
      ['idem', 'Idempotent subscribe', 'Unique (user, channel) with desired state. Off: each call inserts a row and bumps the count.'],
      ['hybrid', 'Hybrid fan-out', 'Do not fan out channels over 1 million subscribers; pull their uploads at read time.'],
    ]),
    presets: Y.presets({ idem: true, hybrid: true }, [
      { id: 'subscribe', label: 'Subscribe', desc: 'One edge, one count increment.', run: (s) => startSub(s, 'ana') },
      { id: 'retry', label: 'Lost reply, idempotent', desc: 'The subscription saves, the reply is lost, the retry changes nothing.', run: (s) => { s.inject('graph', 'dropResponse', true, 700); startSub(s, 'ana'); } },
      { id: 'retry-bad', label: 'Lost reply, not idempotent', desc: 'Every retry inserts another row: the count drifts upward.', sw: { idem: false }, run: (s) => { s.inject('graph', 'dropResponse', true, 700); startSub(s, 'ana'); } },
      { id: 'small', label: 'Small channel uploads', desc: '2,100 inbox writes take about a millisecond; the video is in the feed almost at once.', run: (s) => { s.do('subAll', {}); s.schedule(400, () => startUpload(s, 'ana')); } },
      { id: 'celebrity', label: 'Celebrity uploads, hybrid', desc: 'MegaStar’s video is not fanned out; the feed reader pulls it, so it shows up immediately.', run: (s) => { s.do('subAll', {}); s.schedule(400, () => startUpload(s, 'mega')); s.schedule(600, () => startUpload(s, 'ana')); } },
      { id: 'celebrity-bad', label: 'Celebrity uploads, fan-out on write', desc: '48 million inbox writes take about 19 s, and Ana’s upload waits behind them.', sw: { hybrid: false }, run: (s) => { s.do('subAll', {}); s.schedule(400, () => startUpload(s, 'mega')); s.schedule(600, () => startUpload(s, 'ana')); } },
      { id: 'paused', label: 'Fan-out paused', desc: 'Uploads wait for 3 s; under hybrid, the celebrity video still appears because it is pulled.', run: (s) => { s.do('subAll', {}); s.inject('fanout', 'paused', true, 3000); s.schedule(400, () => startUpload(s, 'ana')); s.schedule(500, () => startUpload(s, 'mega')); } },
      { id: 'graph-down', label: 'Graph down', desc: 'Subscribing fails after bounded retries; nothing changes.', run: (s) => { s.inject('graph', 'down'); startSub(s, 'ana'); } },
    ]),
    initialState: () => ({ config: { idem: true, hybrid: true }, edges: { you: {} }, rows: [], counts: { ana: CHANNELS.ana.subs, mega: CHANNELS.mega.subs }, inbox: [], uploads: [], published: {}, delivered: {}, seq: { key: 0, video: 0, event: 0 } }),
    initialUI: () => ({ viewer: { feed: [] } }),
    actions: {
      sub(sim, a) { startSub(sim, a.ch); },
      upload(sim, a) { startUpload(sim, a.ch); },
      subAll(sim) { const st = sim.state; for (const ch of Object.keys(CHANNELS)) if (!st.edges.you[ch]) { st.edges.you[ch] = true; st.rows.push(ch); st.counts[ch]++; } },
      set: Y.setAction,
    },
    handlers: {
      gateway: {
        subscribe: function* (ctx, p) { return ctx.must(yield ctx.call('graph', 'set', p, { timeout: 700 })); },
        feed: function* (ctx) { return ctx.must(yield ctx.call('feedsvc', 'read', {}, { timeout: 900 })); },
      },
      graph: {
        set(ctx, p) {
          const st = ctx.state;
          if (st.config.idem) {
            const was = !!st.edges.you[p.ch];
            if (was === p.on) return { changed: false };
            st.edges.you[p.ch] = p.on;
            st.counts[p.ch] += p.on ? 1 : -1;
            if (p.on) st.rows.push(p.ch); else st.rows = st.rows.filter((r) => r !== p.ch);
          } else {
            st.edges.you[p.ch] = p.on;
            if (p.on) { st.rows.push(p.ch); st.counts[p.ch]++; }
          }
          ctx.ledger('committed', 'yes', 'Edge and count written together.');
          return { changed: true };
        },
      },
      uploads: {
        add(ctx, p) { ctx.state.uploads.push({ ch: p.ch, vid: p.vid, t: ctx.now() }); ctx.sim.enqueue('ups', { type: 'upload', eventId: 'ev' + ++ctx.state.seq.event, payload: p, actionId: ctx.actionId }); return { ok: true }; },
        recent(ctx, p) { return { items: ctx.state.uploads.filter((u) => p.channels.includes(u.ch)) }; },
      },
      inbox: {
        write(ctx, p) { ctx.state.inbox.push({ ch: p.ch, vid: p.vid, t: ctx.now() }); return { ok: true }; },
        read(ctx) { return { items: ctx.state.inbox.slice() }; },
      },
      feedsvc: {
        read: function* (ctx) {
          const st = ctx.state;
          const inbox = ctx.must(yield ctx.call('inbox', 'read', {}, { timeout: 400 }));
          let items = inbox.items;
          const big = Object.keys(CHANNELS).filter((c) => CHANNELS[c].subs > 1e6 && st.edges.you[c]);
          if (st.config.hybrid && big.length) {
            const pulled = yield ctx.call('uploads', 'recent', { channels: big }, { timeout: 400 });
            if (pulled.ok) items = items.concat(pulled.value.items);
          }
          return { items: items.filter((it) => st.edges.you[it.ch]) };
        },
      },
    },
    setup(sim) {
      Y.consumer(sim, 'ups', 'fanout', 'fanout', function* (ctx, msg) {
        const st = ctx.state;
        const ch = CHANNELS[msg.payload.ch];
        if (st.config.hybrid && ch.subs > 1e6) { ctx.log({ op: `skip fan-out for ${ch.name}`, status: 'note', actionId: msg.actionId, detail: `${Y.num(ch.subs)} subscribers: too many inboxes to write. Readers pull this channel at request time instead.` }); return true; }
        const work = (ch.subs / 1e6) * MS_PER_MILLION;
        if (work > 50) ctx.log({ op: `fanning out to ${Y.num(ch.subs)} inboxes`, status: 'note', actionId: msg.actionId, detail: `About ${(work / 1000).toFixed(1)} s of inbox writes. Every upload behind it waits.` });
        yield ctx.wait(Math.max(1, work));
        const r = yield ctx.call('inbox', 'write', msg.payload, { timeout: 600, quiet: true });
        return r.ok;
      }, () => true);
      // The viewer app refreshes its subscriptions feed every second.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(1000);
          const r = yield ctx.call('gateway', 'feed', {}, { timeout: 1000, quiet: 'all' });
          if (!r.ok) continue;
          const st = ctx.state;
          ctx.ui.viewer.feed = r.value.items.slice().sort((a, b) => b.t - a.t);
          for (const it of r.value.items) if (!st.delivered[it.vid] && st.published[it.vid]) {
            st.delivered[it.vid] = ctx.now();
            const lag = ctx.now() - st.published[it.vid].t;
            ctx.sim.setLedger(st.published[it.vid].actionId, 'async', 'yes', `In the viewer’s feed ${(lag / 1000).toFixed(1)} s after upload.`);
            ctx.log({ op: `${it.vid} in viewer feed`, status: 'ok', detail: `${(lag / 1000).toFixed(1)} s after upload.` });
          }
        }
      }, { self: 'viewer', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      for (const ch of Object.keys(CHANNELS)) {
        const expected = CHANNELS[ch].subs + (st.edges.you[ch] ? 1 : 0);
        if (st.counts[ch] !== expected) return { key: 'wrong', label: `${CHANNELS[ch].name} shows ${st.counts[ch].toLocaleString('en-US')} subscribers but has ${expected.toLocaleString('en-US')}: duplicate rows.` };
      }
      const late = Object.entries(st.published).filter(([vid, p]) => st.edges.you[p.ch] && !st.delivered[vid] && sim.now - p.t > 2000);
      if (late.length) return { key: 'stale', label: `${late.map(([v]) => v).join(', ')} uploaded over 2 s ago and still not in the viewer’s feed.` };
      return { key: 'ok', label: 'Counts match the graph, and every upload reached the feed promptly.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const lags = Object.entries(st.delivered).map(([v, t]) => t - st.published[v].t);
      return [
        { label: 'Fan-out backlog', value: sim.queueStats('ups').depth, tone: sim.queueStats('ups').depth ? 'warn' : '' },
        { label: 'Upload to feed (worst)', value: lags.length ? `${(Math.max(...lags) / 1000).toFixed(1)} s` : 'n/a', tone: lags.some((l) => l > 3000) ? 'fail' : '' },
        { label: 'Ana’s subscribers', value: st.counts.ana.toLocaleString('en-US') },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['viewer', 'Viewer phone']], {
          note: 'Subscribe on the phone; make the channels upload from the console. The feed refreshes every second.',
          side: `<p class="ops-title">Creators</p><div class="ops-traffic"><button class="btn" data-act="upload" data-arg='{"ch":"ana"}'>Ana’s Garden uploads</button><button class="btn" data-act="upload" data-arg='{"ch":"mega"}'>MegaStar uploads</button></div><div data-ref="fan"></div>`,
        });
      },
      render(el, sim) {
        const st = sim.state;
        const esc = SDL.ui.esc;
        const chans = Object.entries(CHANNELS).map(([k, c]) => `<div class="app-card"><span class="app-kv"><strong>${esc(c.name)}</strong><span>${Y.num(st.counts[k])} subscribers</span></span>${Y.btn('sub', st.edges.you[k] ? 'Subscribed ✓' : 'Subscribe', { cls: st.edges.you[k] ? 'secondary' : '', arg: { ch: k } })}</div>`).join('');
        const feed = sim.ui.viewer.feed.slice(0, 5).map((it) => `<div class="yt-card"><div class="yt-thumb" style="--h:${it.ch === 'mega' ? 10 : 130}">▶</div><div><strong>${esc(CHANNELS[it.ch].name)}: new video</strong><span class="app-sub">${it.vid}</span></div></div>`).join('') || '<p class="app-sub">No new videos from your subscriptions.</p>';
        Y.paint(el, sim, 'viewer', { head: '<div><p class="app-title">Subscriptions</p></div>', body: `${chans}<p class="app-sub">Latest from your subscriptions</p><div class="yt-feed">${feed}</div>` }, {});
        const q = sim.queueStats('ups');
        SDL.ui.paintSections(el.querySelector('[data-ref="fan"]'), { f: `<div class="ops-row" data-tone="${q.lag > 2000 ? 'fail' : q.depth ? 'warn' : 'ok'}"><div class="ops-name"><strong>Fan-out queue</strong><span>${q.depth} upload${q.depth === 1 ? '' : 's'} waiting</span></div><div class="ops-bar"><i style="width:${Math.min(100, q.lag / 200)}%"></i></div><span class="ops-val">${Math.round(q.lag)} ms behind</span></div><p class="recon">Hybrid fan-out is ${st.config.hybrid ? 'on: MegaStar’s uploads are pulled at read time' : 'off: every upload is copied into every inbox'}.</p>` }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
