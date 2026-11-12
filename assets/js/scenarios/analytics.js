/*
 * Creator analytics. Playback events (stamped with event time) flow through a
 * collector into a stream. A real-time aggregator counts them in 2 s windows
 * by event time and closes a window once the watermark passes it; a batch job
 * recomputes exact numbers from the data lake. Playback itself never waits on
 * any of this.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const WIN = 2000;

  const sc = (SDL.scenarios.analytics = {
    id: 'analytics',
    seed: 191,
    productWidth: 560,
    intro: 'Viewers are watching constantly. The creator dashboard shows real-time counts per 2 s window next to exact batch numbers. Make phones send late events, or take the pipeline down, and compare.',
    topology: {
      width: 1100, height: 540,
      nodes: [
        { id: 'viewers', label: 'Viewers', sub: 'Playback + events', kind: 'client', x: 100, y: 120, latency: 1, role: 'Watch videos and send playback events stamped with when they happened.', owns: ['Event buffer'] },
        { id: 'cdn', label: 'Playback CDN', sub: 'Video delivery', kind: 'cdn', x: 320, y: 40, latency: 3, role: 'Serves the video. Completely independent of analytics.', ops: [{ name: 'segment', desc: 'Serve video.' }], owns: ['Cached video'] },
        { id: 'collector', label: 'Event collector', sub: 'Ingest', kind: 'gateway', x: 320, y: 220, latency: 2, role: 'Accepts events; can spool them to disk while the stream is down.', ops: [{ name: 'events', desc: 'Accept a batch.' }], owns: ['Disk spool'] },
        { id: 'stream', label: 'Event stream', sub: 'Durable log', kind: 'queue', x: 560, y: 220, latency: 3, queue: 'evts', role: 'All playback events.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['event log'] },
        { id: 'rt', label: 'Real-time aggregator', sub: 'Event-time windows', kind: 'worker', x: 800, y: 120, latency: 3, role: 'Counts events per 2 s window of event time; finalises a window when the watermark passes it.', ops: [{ name: 'consume', desc: 'Count events.' }], owns: ['Open windows'] },
        { id: 'lake', label: 'Data lake', sub: 'Raw events', kind: 'store', x: 800, y: 330, latency: 10, role: 'Every raw event, for exact recomputation.', ops: [{ name: 'append', desc: 'Store events.' }], owns: ['raw events'] },
        { id: 'batch', label: 'Batch job', sub: 'Every 6 s', kind: 'worker', x: 1000, y: 330, latency: 5, role: 'Recomputes exact counts from the lake, deduplicating by event ID.', ops: [{ name: 'run', desc: 'Recompute.' }], owns: ['Exact counts'] },
        { id: 'dashdb', label: 'Analytics store', sub: 'Dashboard data', kind: 'db', x: 1000, y: 120, latency: 4, role: 'Real-time and batch numbers for the dashboard.', ops: [{ name: 'get', desc: 'Read numbers.' }], owns: ['window counts'] },
        { id: 'creator', label: 'Creator dashboard', sub: 'YouTube Studio', kind: 'client', x: 800, y: 470, latency: 1, role: 'Shows views per window, real-time and corrected.', owns: ['Nothing'] },
      ],
      edges: [
        { from: 'viewers', to: 'cdn', latency: 20, label: 'video' },
        { from: 'viewers', to: 'collector', latency: 30, label: 'events' },
        { from: 'collector', to: 'stream', latency: 3 },
        { from: 'stream', to: 'rt', latency: 3 },
        { from: 'stream', to: 'lake', latency: 4 },
        { from: 'rt', to: 'dashdb', latency: 4 },
        { from: 'lake', to: 'batch', latency: 4 },
        { from: 'batch', to: 'dashdb', latency: 4 },
        { from: 'creator', to: 'dashdb', latency: 30, via: [[1080, 470], [1080, 160]] },
      ],
      queues: [{ id: 'evts', broker: 'stream', label: 'events', groups: ['rt', 'lake'] }],
    },
    modeLabels: { late: 'Sending events late' },
    failures: [
      { id: 'late', node: 'viewers', mode: 'late', label: 'Phones send events late', desc: 'Some viewers watch offline; their events arrive 3 s after they happened.' },
      { id: 'stream-down', node: 'stream', mode: 'down', label: 'Event stream outage', desc: 'The pipeline stops accepting events. Playback is unaffected.' },
      { id: 'rt-paused', node: 'rt', mode: 'paused', label: 'Real-time aggregator stalled', desc: 'The dashboard freezes; batch numbers still arrive.' },
      { id: 'dup', node: 'stream', mode: 'duplicate', label: 'Duplicate events', desc: 'Collector retries create duplicates.' },
    ],
    switches: Y.switches([
      ['watermark', 'Allow late events (watermark 4 s)', 'Keep each window open 4 s after it ends. Off: close it immediately and drop late events.'],
      ['spool', 'Collector spools to disk', 'During a stream outage, keep events and replay them. Off: they are lost.'],
      ['dedupe', 'Real-time dedupe by event ID', 'Off: duplicates inflate real-time numbers until batch corrects them.'],
    ]),
    presets: Y.presets({ watermark: true, spool: true, dedupe: true }, [
      { id: 'normal', label: 'Normal evening', desc: 'Real-time and batch numbers agree.', run: () => {} },
      { id: 'late', label: 'Late events, with a watermark', desc: 'Late events still land in the right window before it closes.', run: (s) => s.inject('viewers', 'late') },
      { id: 'late-bad', label: 'Late events, no watermark', desc: 'Windows close before late events arrive: real-time undercounts, and batch corrects it later.', sw: { watermark: false }, run: (s) => s.inject('viewers', 'late') },
      { id: 'outage', label: 'Pipeline outage, spooled', desc: 'Analytics freezes for 3 s, playback never notices, and the spool replays everything.', run: (s) => s.inject('stream', 'down', true, 3000) },
      { id: 'outage-bad', label: 'Pipeline outage, no spool', desc: 'Three seconds of events are gone from both real-time and batch numbers for good.', sw: { spool: false }, run: (s) => s.inject('stream', 'down', true, 3000) },
      { id: 'dup', label: 'Duplicate events', desc: 'Real-time drops the copies; batch would have caught them anyway.', run: (s) => s.inject('stream', 'duplicate', true, 3000) },
      { id: 'dup-bad', label: 'Duplicates, no real-time dedupe', desc: 'Real-time numbers jump above the truth until the batch job corrects them.', sw: { dedupe: false }, run: (s) => s.inject('stream', 'duplicate', true, 3000) },
    ]),
    initialState: () => ({ config: { watermark: true, spool: true, dedupe: true }, truth: {}, rt: {}, rtFinal: {}, exact: {}, seen: {}, spool: [], lostEvents: 0, plays: 0, playFails: 0, dropsLate: 0, maxEventT: 0, seq: { ev: 0 }, lake: [] }),
    initialUI: () => ({}),
    actions: {
      refresh(sim) {
        sim.startAction('Creator: refresh dashboard', function* (ctx) {
          Y.L(ctx, { committed: ['n/a', 'Reading only.'], async: 'n/a', retrySafe: 'yes', displayed: 'pending' });
          const r = yield ctx.call('dashdb', 'get', {}, { timeout: 800 });
          const st = ctx.state;
          if (!r.ok) { Y.failed(ctx); return; }
          const closed = Object.keys(st.rtFinal).map(Number).sort((a, b) => b - a)[0];
          const shown = closed == null ? 0 : st.rt[closed] || 0;
          const truth = closed == null ? 0 : st.truth[closed] || 0;
          Y.L(ctx, { displayed: ['yes', `Last closed window: ${shown} views (truth ${truth}${st.exact[closed] != null ? `, batch ${st.exact[closed]}` : ''}).`], accepted: 'yes' });
          ctx.explain(shown === truth ? 'The real-time number for the latest closed window matches what viewers actually did.' : `Real-time shows ${shown} for the latest closed window, against ${truth} real views. ${shown < truth ? 'Late or lost events are missing' : 'Duplicates slipped in'}; the batch job is the source of truth.`);
        }, { self: 'creator' });
      },
      set: Y.setAction,
    },
    handlers: {
      cdn: { segment() { return { ok: true }; } },
      collector: {
        events: function* (ctx, p) {
          const st = ctx.state;
          const r = yield ctx.call('stream', 'publish', p, { timeout: 400 });
          if (r.ok) {
            if (st.spool.length) { const s = st.spool.splice(0); yield ctx.call('stream', 'publish', { events: s }, { timeout: 400 }); ctx.log({ op: `replayed ${s.length} spooled events`, status: 'recovered', detail: 'The collector kept them on disk during the outage.' }); }
            return { ok: true };
          }
          if (st.config.spool) { st.spool.push(...p.events); return { spooled: true }; }
          st.lostEvents += p.events.length;
          return { lost: true };
        },
      },
      stream: { publish(ctx, p) { for (const e of p.events) ctx.sim.enqueue('evts', { type: 'ev', eventId: e.id, payload: e, quiet: true }); return { ok: true }; } },
      lake: { append(ctx, p) { ctx.state.lake.push(...p.events); return { ok: true }; } },
      dashdb: { put() { return { ok: true }; }, get() { return { ok: true }; } },
    },
    setup(sim) {
      // Viewers: watch (CDN) and send events every 250 ms; late mode delays some.
      sim.spawn(function* (ctx) {
        let pendingLate = [];
        for (;;) {
          yield ctx.wait(250);
          const st = ctx.state;
          const now = ctx.now();
          ctx.spawn(function* (c) { const r = yield c.call('cdn', 'segment', {}, { timeout: 600, quiet: 'all' }); st.plays++; if (!r.ok) st.playFails++; }, { quiet: 'all' });
          const evs = [];
          for (let i = 0; i < 5; i++) {
            const e = { id: 'e' + ++st.seq.ev, t: now - 50 * i };
            const w = Math.floor(e.t / WIN);
            st.truth[w] = (st.truth[w] || 0) + 1;
            if (ctx.sim.nodes.viewers.modes.late && i === 0) pendingLate.push({ e, sendAt: now + 3000 }); else evs.push(e);
          }
          const due = pendingLate.filter((x) => x.sendAt <= now);
          pendingLate = pendingLate.filter((x) => x.sendAt > now);
          evs.push(...due.map((x) => x.e));
          ctx.spawn(function* (c) { yield c.call('collector', 'events', { events: evs }, { timeout: 800, quiet: 'all' }); }, { quiet: 'all' });
        }
      }, { self: 'viewers', quiet: 'all' });
      // Real-time aggregator with an event-time watermark.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msgs } = yield ctx.take('evts', 'rt', 200);
          const st = ctx.state;
          for (const m of msgs) {
            const e = m.payload;
            if (st.config.dedupe && st.seen[e.id]) continue;
            st.seen[e.id] = true;
            st.maxEventT = Math.max(st.maxEventT, e.t);
            const w = Math.floor(e.t / WIN);
            if (st.rtFinal[w]) { st.dropsLate++; continue; }
            st.rt[w] = (st.rt[w] || 0) + 1;
          }
          const lateness = st.config.watermark ? 4000 : 0;
          const watermark = st.maxEventT - lateness;
          for (const w of Object.keys(st.rt)) if ((+w + 1) * WIN <= watermark) st.rtFinal[w] = true;
          yield ctx.call('dashdb', 'put', {}, { timeout: 400, quiet: 'all' });
          ctx.ack('evts', 'rt');
        }
      }, { self: 'rt' });
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msgs } = yield ctx.take('evts', 'lake', 500);
          ctx.state.lake.push(...msgs.map((m) => m.payload)); // the delivery from the stream is the write into the lake
          ctx.ack('evts', 'lake');
        }
      }, { self: 'lake' });
      // Batch job: exact, deduplicated counts from the lake.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(6000);
          const st = ctx.state;
          const seen = new Set();
          const exact = {};
          for (const e of st.lake) { if (seen.has(e.id)) continue; seen.add(e.id); const w = Math.floor(e.t / WIN); exact[w] = (exact[w] || 0) + 1; }
          st.exact = exact;
          st.batchAt = ctx.now();
          yield ctx.call('dashdb', 'put', {}, { timeout: 400, quiet: 'all' });
          ctx.log({ op: 'batch recompute finished', status: 'ok', detail: 'Exact, deduplicated counts for every closed window.' });
        }
      }, { self: 'batch', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      if (st.playFails) return { key: 'wrong', label: 'Playback failed: analytics problems leaked into the viewing path.' };
      if (st.lostEvents) return { key: 'wrong', label: `${st.lostEvents} events were lost during the outage: both real-time and batch numbers will undercount forever.` };
      const closed = Object.keys(st.rtFinal).map(Number);
      const over = closed.find((w) => (st.rt[w] || 0) > (st.truth[w] || 0));
      if (over != null) return { key: 'stale', label: `Real-time shows ${st.rt[over]} views for a window that had ${st.truth[over]}: duplicates, until batch corrects it.` };
      const under = closed.filter((w) => (st.rt[w] || 0) < (st.truth[w] || 0) && !(st.exact[w] >= st.truth[w]));
      if (under.length) return { key: 'stale', label: `Real-time undercounts ${under.length} closed window${under.length > 1 ? 's' : ''} (late events dropped); the next batch run corrects ${under.length > 1 ? 'them' : 'it'}.` };
      if (sim.queueStats('evts').lag > 1500 || st.spool.length) return { key: 'stale', label: 'The dashboard is behind; events are spooled or queued.' };
      return { key: 'ok', label: 'Real-time and batch numbers match what viewers actually did, and playback never noticed.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      return [
        { label: 'Playback success', value: st.plays ? `${Math.round(((st.plays - st.playFails) / st.plays) * 100)}%` : 'n/a', tone: st.playFails ? 'fail' : 'ok' },
        { label: 'Late events dropped (real-time)', value: st.dropsLate, tone: st.dropsLate ? 'warn' : '' },
        { label: 'Events spooled', value: st.spool.length },
        { label: 'Events lost', value: st.lostEvents, tone: st.lostEvents ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['creator', 'Creator dashboard']], { note: 'Each bar is a 2 s window: dark is real-time, the tick is the exact batch number, the outline is the truth.' }); },
      render(el, sim) {
        const st = sim.state;
        const ws = Object.keys(st.truth).map(Number).sort((a, b) => a - b).slice(-8, -1);
        const max = Math.max(1, ...ws.map((w) => Math.max(st.truth[w] || 0, st.rt[w] || 0)));
        const bars = ws.map((w) => `<div class="an-col" title="window ${w}"><div class="an-truth" style="height:${((st.truth[w] || 0) / max) * 100}%"></div><div class="an-rt${(st.rt[w] || 0) > (st.truth[w] || 0) ? ' is-over' : ''}" style="height:${((st.rt[w] || 0) / max) * 100}%"></div>${st.exact[w] != null ? `<div class="an-exact" style="bottom:${(st.exact[w] / max) * 100}%"></div>` : ''}<span>${st.rt[w] || 0}</span></div>`).join('');
        const body = `${Y.btn('refresh', 'Refresh dashboard')}<p class="app-sub">Views per 2 s window, newest on the right</p><div class="an-chart">${bars}</div><p class="app-sub">Batch last ran ${st.batchAt ? `${((sim.now - st.batchAt) / 1000).toFixed(0)} s ago` : 'not yet'}.</p>`;
        Y.paint(el, sim, 'creator', { head: '<div><p class="app-title">YouTube Studio</p><p class="app-sub">Real-time analytics</p></div>', body }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
