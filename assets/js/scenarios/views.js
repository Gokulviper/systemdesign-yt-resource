/*
 * Views and view counting. A playback that passes the watch threshold emits a
 * view event with a unique view ID. Ingest validates it (bots, duplicates),
 * a stream partitioned by video feeds an aggregator that writes summed counts.
 * Viral videos make one partition hot; splitting the key spreads the work.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const BASE = 48210;
  const PER_EVENT_MS = 8;

  function* sendView(ctx, ev, mine) {
    const st = ctx.state;
    const r = yield* ctx.retry({ attempts: 3, baseMs: 150 }, function* () {
      return yield ctx.call('ingest', 'view', ev, { timeout: 800, quiet: mine ? false : 'all' });
    });
    if (r.ok) return true;
    if (st.config.buffer) { st.buffered.push(ev); if (mine) ctx.log({ op: 'view buffered on the phone', status: 'retry', detail: `Ingest is unreachable. View ${ev.viewId} is kept on the device and resent later.` }); return false; }
    st.lost++;
    if (mine) ctx.log({ op: `view ${ev.viewId} lost`, status: 'err', detail: 'Three attempts failed and the app does not buffer events. This view will never be counted.' });
    return false;
  }

  function startWatch(sim) {
    const st = sim.state;
    const viewId = 'v-you-' + ++st.seq.view;
    sim.startAction('Viewer: watch a video', function* (ctx) {
      const u = ctx.ui.viewer;
      u.playing = true;
      u.progress = 0;
      Y.L(ctx, { displayed: ['pending', 'Playing; a view counts after the watch threshold.'], retrySafe: ['yes', `The event carries view ID ${viewId}; duplicates can be dropped.`] });
      for (let i = 1; i <= 6; i++) { yield ctx.wait(200); u.progress = i / 6; }
      u.playing = false;
      st.trueViews.add(viewId);
      const ok = yield* sendView(ctx, { viewId, ip: '203.0.113.7', device: 'phone', human: true }, true);
      Y.L(ctx, { displayed: ['yes', 'Playback finished; the app does not show a count change immediately.'] });
      if (ok) { Y.L(ctx, { accepted: 'yes', committed: ['yes', 'The view event is durable in the stream.'], async: ['pending', 'The aggregator adds it to the count.'] }); ctx.explain('The view qualified after the watch threshold, so the app sent one event with a unique view ID. Ingest checked it and appended it to the stream; the aggregator will add it to the count in its next batch.'); }
      else Y.L(ctx, { accepted: 'no', committed: st.config.buffer ? ['pending', 'Waiting on the phone.'] : ['no', 'Lost.'], async: 'n/a' });
    }, { self: 'viewer' });
  }

  const sc = (SDL.scenarios.views = {
    id: 'views',
    seed: 127,
    productWidth: 600,
    intro: 'Watch the video on the phone: once playback passes the threshold, one view event travels to ingest, the stream, and the aggregator. Then turn on the bot farm or go viral from the console.',
    topology: {
      width: 1100, height: 560,
      nodes: [
        { id: 'viewer', label: 'YouTube app', sub: 'Your playback', kind: 'client', x: 100, y: 90, latency: 1, role: 'Sends one view event per qualifying playback, with a unique view ID; can buffer events offline.', owns: ['Event buffer'] },
        { id: 'crowd', label: 'Other viewers', sub: 'Real playback', kind: 'client', x: 100, y: 300, latency: 1, role: 'Genuine viewers. Their rate jumps when the video goes viral.', owns: ['Nothing'] },
        { id: 'bots', label: 'Bot farm', sub: 'Fake views', kind: 'client', x: 100, y: 490, latency: 1, role: 'A handful of IPs and emulators generating fake views.', owns: ['Nothing'] },
        { id: 'ingest', label: 'Event ingest', sub: 'Collects events', kind: 'gateway', x: 320, y: 300, latency: 2, role: 'Receives playback events from every app.', ops: [{ name: 'view', desc: 'One view event.' }], owns: ['Nothing durable'] },
        { id: 'validator', label: 'Validator', sub: 'Bots, duplicates', kind: 'service', x: 540, y: 300, latency: 3, role: 'Drops repeated view IDs and traffic that looks automated (too many views per IP).', ops: [{ name: 'check', desc: 'Accept or reject.' }], owns: ['Seen view IDs', 'Per-IP rates'] },
        { id: 'events', label: 'View events', sub: 'By video', kind: 'queue', x: 760, y: 300, latency: 3, queue: 'views', role: 'Accepted views, partitioned by video ID: one video, one partition.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['view log'] },
        { id: 'aggregator', label: 'Aggregator', sub: 'Batches counts', kind: 'worker', x: 980, y: 300, latency: 3, role: 'Reads batches, does about 8 ms of work per event, and writes one summed update.', ops: [{ name: 'consume', desc: 'Sum a batch.' }], owns: ['Its partition offsets'] },
        { id: 'counts', label: 'View counts', sub: 'Per video', kind: 'db', x: 980, y: 90, latency: 4, role: 'The count shown under the video.', ops: [{ name: 'add', desc: 'Add a batch total.' }, { name: 'get', desc: 'Read.' }], owns: ['views[video]'] },
        { id: 'countapi', label: 'Count API', sub: 'Serves counts', kind: 'service', x: 540, y: 90, latency: 2, role: 'Returns the count for the watch page.', ops: [{ name: 'get', desc: 'Read the count.' }], owns: ['Nothing'] },
      ],
      edges: [
        { from: 'viewer', to: 'ingest', latency: 30, label: 'events' },
        { from: 'crowd', to: 'ingest', latency: 30 },
        { from: 'bots', to: 'ingest', latency: 30 },
        { from: 'ingest', to: 'validator', latency: 3 },
        { from: 'validator', to: 'events', latency: 3 },
        { from: 'events', to: 'aggregator', latency: 3 },
        { from: 'aggregator', to: 'counts', latency: 4 },
        { from: 'viewer', to: 'countapi', latency: 30, label: 'read' },
        { from: 'countapi', to: 'counts', latency: 3 },
      ],
      queues: [{ id: 'views', broker: 'events', label: 'view events', groups: ['agg'] }],
    },
    failures: [
      { id: 'ingest-drop', node: 'ingest', mode: 'dropResponse', label: 'Ingest replies lost', desc: 'Events arrive but the app times out and resends them.' },
      { id: 'broker-down', node: 'events', mode: 'down', label: 'Stream unavailable', desc: 'Ingest cannot append; apps buffer or lose events.' },
      { id: 'agg-paused', node: 'aggregator', mode: 'paused', label: 'Aggregator stalled', desc: 'Views pile up; the count freezes.' },
      { id: 'validator-slow', node: 'validator', mode: 'slow', params: { factor: 30 }, label: 'Validator slow', desc: 'Ingest calls time out; apps retry.' },
    ],
    switches: Y.switches([
      ['dedupe', 'Drop repeated view IDs', 'Off: a resent event is counted again.'],
      ['botFilter', 'Filter automated traffic', 'Reject emulators and IPs sending more than 3 views per second. Off: bot views count.'],
      ['buffer', 'Buffer events on the device', 'Keep events the app could not send and retry later. Off: they are lost.'],
      ['split', 'Split hot videos across partitions', 'Salt the key so a viral video uses 4 partitions and 4 aggregators. Off: one partition does all the work.'],
    ]),
    presets: Y.presets({ dedupe: true, botFilter: true, buffer: true, split: false }, [
      { id: 'watch', label: 'Watch a video', desc: 'One qualifying playback, one event, one more view.', run: (s) => startWatch(s) },
      { id: 'resend', label: 'Resent events, deduplicated', desc: 'Ingest replies are lost so the app resends. The repeats share a view ID and are dropped.', run: (s) => { s.schedule(1100, () => s.inject('ingest', 'dropResponse', true, 700)); startWatch(s); } },
      { id: 'resend-bad', label: 'Resent events, no dedupe', desc: 'One playback counted three times.', sw: { dedupe: false }, run: (s) => { s.schedule(1100, () => s.inject('ingest', 'dropResponse', true, 700)); startWatch(s); } },
      { id: 'bots', label: 'Bot farm, filtered', desc: '25 fake views per second from three IPs. The validator rejects them.', run: (s) => { s.do('traffic', { bots: true }); s.schedule(3000, () => s.do('traffic', { bots: false })); } },
      { id: 'bots-bad', label: 'Bot farm, unfiltered', desc: 'The count inflates with views no human made.', sw: { botFilter: false }, run: (s) => { s.do('traffic', { bots: true }); s.schedule(3000, () => s.do('traffic', { bots: false })); } },
      { id: 'outage', label: 'Stream outage, buffered', desc: 'The stream is down for 2.5 s. The phone keeps its view and resends it later.', run: (s) => { s.schedule(1100, () => s.inject('events', 'down', true, 2500)); startWatch(s); } },
      { id: 'outage-bad', label: 'Stream outage, no buffering', desc: 'The view is lost for good: the count is permanently one short.', sw: { buffer: false }, run: (s) => { s.schedule(1100, () => s.inject('events', 'down', true, 2500)); startWatch(s); } },
      { id: 'viral', label: 'Viral video, one partition', desc: '150 views per second land on one partition. The aggregator falls behind and the count lags further every second.', run: (s) => { s.do('traffic', { viral: true }); s.schedule(4000, () => s.do('traffic', { viral: false })); } },
      { id: 'viral-split', label: 'Viral video, split key', desc: 'Four partitions and four aggregators share the load; the count keeps up.', sw: { split: true }, run: (s) => { s.do('traffic', { viral: true }); s.schedule(4000, () => s.do('traffic', { viral: false })); } },
      { id: 'stall', label: 'Aggregator stalls', desc: 'Views keep arriving; the count freezes for 3 s, then catches up with nothing lost.', run: (s) => { s.inject('aggregator', 'paused', true, 3000); s.do('traffic', { viral: false }); startWatch(s); } },
    ]),
    initialState: () => ({
      config: { dedupe: true, botFilter: true, buffer: true, split: false },
      count: BASE, trueViews: new Set(), seen: {}, ipHits: {}, buffered: [], lost: 0,
      traffic: { viral: false, bots: false }, seq: { view: 0, crowd: 0, bot: 0 },
      stats: { bots: 0, dups: 0, accepted: 0 },
    }),
    initialUI: () => ({ viewer: { playing: false, progress: 0, shown: BASE } }),
    actions: {
      watch(sim) { startWatch(sim); },
      traffic(sim, a) { Object.assign(sim.state.traffic, a); sim.note(a.viral ? 'The video goes viral: about 150 genuine views per second.' : a.bots ? 'A bot farm starts generating fake views.' : 'Traffic back to normal.'); },
      set: Y.setAction,
    },
    handlers: {
      ingest: {
        view: function* (ctx, ev) {
          const v = ctx.must(yield ctx.call('validator', 'check', ev, { timeout: 500 }));
          if (!v.accept) return { accepted: false, reason: v.reason };
          ctx.must(yield ctx.call('events', 'publish', ev, { timeout: 400 }));
          // Remember the view ID only once it is safely in the stream, so a retry
          // after a failed publish is not mistaken for a duplicate.
          ctx.state.seen[ev.viewId] = true;
          return { accepted: true };
        },
      },
      validator: {
        check(ctx, ev) {
          const st = ctx.state;
          if (st.config.dedupe && st.seen[ev.viewId]) { st.stats.dups++; return { accept: false, reason: 'duplicate' }; }
          if (st.config.botFilter) {
            if (ev.device === 'emulator') { st.stats.bots++; return { accept: false, reason: 'automated' }; }
            const hits = (st.ipHits[ev.ip] = (st.ipHits[ev.ip] || []).filter((t) => ctx.now() - t < 1000));
            hits.push(ctx.now());
            if (hits.length > 3) { st.stats.bots++; return { accept: false, reason: 'automated' }; }
          }
          return { accept: true };
        },
      },
      events: { publish(ctx, ev) { ctx.sim.enqueue('views', { type: 'view', payload: ev, actionId: ctx.actionId }); return { appended: true }; } },
      counts: { add(ctx, p) { ctx.state.count += p.n; return { count: ctx.state.count }; }, get(ctx) { return { count: ctx.state.count }; } },
      countapi: { get: function* (ctx) { return ctx.must(yield ctx.call('counts', 'get', {}, { timeout: 400 })); } },
    },
    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          const st = ctx.state;
          const { msgs } = yield ctx.take('views', 'agg', 400);
          const work = (msgs.length * PER_EVENT_MS) / (st.config.split ? 4 : 1);
          if (work > 1) yield ctx.wait(work);
          const r = yield ctx.call('counts', 'add', { n: msgs.length }, { timeout: 800, quiet: true });
          if (!r.ok) { ctx.nack('views', 'agg'); yield ctx.wait(300); continue; }
          for (const m of msgs) if (m.actionId) ctx.sim.setLedger(m.actionId, 'async', 'yes', 'The aggregator added this view to the count.');
          st.stats.accepted += msgs.length;
          ctx.ack('views', 'agg');
        }
      }, { self: 'aggregator' });
      Y.load(sim, 'crowd', (s) => (s.state.traffic.viral ? 150 : 4), function* (ctx) {
        const st = ctx.state;
        const id = 'v-c-' + ++st.seq.crowd;
        st.trueViews.add(id);
        yield* sendView(ctx, { viewId: id, ip: '198.51.' + (st.seq.crowd % 250) + '.' + (st.seq.crowd % 7), device: 'phone', human: true }, false);
      });
      Y.load(sim, 'bots', (s) => (s.state.traffic.bots ? 25 : 0), function* (ctx) {
        const st = ctx.state;
        yield ctx.call('ingest', 'view', { viewId: 'v-b-' + ++st.seq.bot, ip: 'bot-' + (st.seq.bot % 3), device: 'emulator', human: false }, { timeout: 800, quiet: 'all' });
      });
      // Buffered events are resent once a second; the watch page refreshes its count.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(1000);
          const st = ctx.state;
          if (st.buffered.length) {
            const batch = st.buffered.splice(0, 20);
            let sent = 0;
            for (const ev of batch) {
              const r = yield ctx.call('ingest', 'view', ev, { timeout: 800, quiet: ev.viewId.startsWith('v-you') ? false : 'all' });
              if (!r.ok) { st.buffered.unshift(...batch.slice(batch.indexOf(ev))); break; }
              sent++;
            }
            if (sent) ctx.log({ op: `${sent} buffered view${sent > 1 ? 's' : ''} delivered`, status: 'recovered', detail: 'Phones resent the views they kept while the stream was down.' });
          }
          const c = yield ctx.call('countapi', 'get', {}, { timeout: 600, quiet: 'all' });
          if (c.ok) ctx.ui.viewer.shown = c.value.count;
        }
      }, { self: 'viewer' });
    },
    consistency(sim) {
      const st = sim.state;
      const truth = BASE + st.trueViews.size - st.buffered.length - st.lost;
      if (st.count > BASE + st.trueViews.size + 0) return { key: 'wrong', label: `Counted ${Y.num(st.count - BASE)} new views but only ${Y.num(st.trueViews.size)} real playbacks happened: duplicates or bots got through.` };
      if (st.lost) return { key: 'wrong', label: `${st.lost} real view${st.lost > 1 ? 's were' : ' was'} lost and will never be counted.` };
      const lag = sim.queueStats('views').lag;
      if (lag > 800 || st.buffered.length) return { key: 'stale', label: `The count is behind real playbacks: ${st.buffered.length ? `${st.buffered.length} views buffered on phones` : `aggregator ${SDL.fmtMs(lag)} behind`}.` };
      void truth;
      return { key: 'ok', label: 'The count equals real, unique playbacks.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const lag = sim.queueStats('views');
      return [
        { label: 'Displayed views', value: Y.num(st.count) },
        { label: 'Real playbacks', value: Y.num(BASE + st.trueViews.size) },
        { label: 'Bot views rejected', value: st.stats.bots },
        { label: 'Duplicates dropped', value: st.stats.dups },
        { label: 'Aggregator backlog', value: `${lag.depth} events, ${SDL.fmtMs(lag.lag)}`, tone: lag.lag > 1500 ? 'fail' : lag.lag > 500 ? 'warn' : 'ok' },
        { label: 'Views lost', value: st.lost, tone: st.lost ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['viewer', 'Your phone']], {
          note: 'The phone shows the public count. The console controls traffic and shows the pipeline.',
          side: `<p class="ops-title">Traffic</p><div class="ops-traffic"><button class="btn ops-tbtn" data-act="traffic" data-arg='{"viral":true}' data-k="viral">Go viral</button><button class="btn ops-tbtn" data-act="traffic" data-arg='{"viral":false,"bots":false}' data-k="normal">Normal</button><button class="btn ops-tbtn" data-act="traffic" data-arg='{"bots":true}' data-k="bots">Start bot farm</button></div><div data-ref="pipe"></div>`,
        });
      },
      render(el, sim) {
        const st = sim.state;
        const u = sim.ui.viewer;
        el.querySelectorAll('[data-k]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === 'viral' ? st.traffic.viral : b.dataset.k === 'bots' ? st.traffic.bots : !st.traffic.viral && !st.traffic.bots)));
        const body = `${Y.video('Consistent hashing, visually explained', 'Distributed Daily', '', 30)}
          <p class="yt-count"><span data-live="views"></span> views</p>
          <div class="app-countdown"><i data-live-width="prog"></i></div>
          ${Y.btn('watch', u.playing ? '<span class="spinner"></span>Watching…' : 'Watch the video', { disabled: u.playing })}
          <p class="app-sub">A view counts after the watch threshold. Events waiting on this phone: <span data-live="buf"></span></p>`;
        Y.paint(el, sim, 'viewer', { head: '<div><p class="app-title">YouTube</p></div>', body }, { views: st.count === u.shown ? u.shown.toLocaleString('en-US') : u.shown.toLocaleString('en-US'), prog: `${u.progress * 100}%`, buf: String(st.buffered.length) });
        const lag = sim.queueStats('views');
        SDL.ui.paintSections(el.querySelector('[data-ref="pipe"]'), { p: `<div class="ops-row" data-tone="${lag.lag > 1500 ? 'fail' : lag.lag > 500 ? 'warn' : 'ok'}"><div class="ops-name"><strong>Aggregator backlog</strong><span>${lag.depth} events</span></div><div class="ops-bar"><i style="width:${Math.min(100, lag.lag / 30)}%"></i></div><span class="ops-val">${Math.round(lag.lag)} ms behind</span></div>
          <p class="recon">Real playbacks ${Y.num(BASE + st.trueViews.size)}, counted ${Y.num(st.count)}. Rejected: ${st.stats.bots} bot, ${st.stats.dups} duplicate.</p>` }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
