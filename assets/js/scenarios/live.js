/*
 * Live streaming. The streamer's phone sends a chunk every 500 ms to ingest;
 * a live transcoder encodes renditions (real capacity); the packager groups
 * chunks into segments; viewers fetch segments from the CDN edge. Latency is
 * capture-to-screen. Chat is a separate path whose fan-out has capacity too.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const CHUNK_MS = 500;
  const RENDITION_MS = 50;

  function startLive(sim) {
    const st = sim.state;
    if (st.live) { st.live = false; sim.note('The streamer ended the broadcast.'); return; }
    st.live = true;
    sim.startAction('Streamer: go live', function* (ctx) {
      Y.L(ctx, { displayed: 'yes', committed: ['n/a', 'Live video is streamed, not stored, in this lab.'], async: 'n/a', retrySafe: 'yes' });
      st.ingest = 'ingest';
      while (st.live) {
        yield ctx.wait(CHUNK_MS);
        if (st.ingest === 'backup' && !ctx.sim.nodes.ingest.modes.down) st.ingest = 'ingest';
        const chunk = { n: ++st.seq.chunk, t: ctx.now() };
        // Chunks are pushed continuously; the encoder does not wait for one to finish before sending the next.
        ctx.spawn(function* (c) {
          let r = yield c.call(st.ingest, 'chunk', chunk, { timeout: 15000, quiet: true });
          if (!r.ok && st.config.backup && r.error.code === 'UNAVAILABLE') {
            if (st.ingest === 'ingest') { st.ingest = 'backup'; c.log({ op: 'switched to backup ingest', status: 'retry', detail: 'The primary ingest stopped answering. The encoder reconnects to the backup ingest point and resends.' }); }
            r = yield c.call('backup', 'chunk', chunk, { timeout: 15000, quiet: true });
          }
          if (!r.ok) { st.lostChunks++; if (st.lostChunks === 1 || st.lostChunks % 4 === 0) c.log({ op: 'chunks lost', status: 'err', detail: `${st.lostChunks} chunks of live video never reached the platform.` }); }
        });
      }
      Y.L(ctx, { accepted: 'yes' });
    }, { self: 'streamer' });
  }
  function startChat(sim) {
    sim.startAction('Viewer: send a chat message', function* (ctx) {
      Y.L(ctx, { displayed: 'pending', committed: 'n/a', retrySafe: ['yes', 'Messages carry an ID.'] });
      const t0 = ctx.now();
      const r = yield ctx.call('chat', 'post', { text: 'This explanation is so clear!', mine: true, t: t0 }, { timeout: 4000 });
      if (r.ok) { Y.L(ctx, { displayed: ['yes', 'Shown in chat.'], accepted: 'yes', async: ['pending', 'Fanned out to everyone watching.'] }); }
      else Y.failed(ctx);
    }, { self: 'viewer' });
  }

  const sc = (SDL.scenarios.live = {
    id: 'live',
    seed: 181,
    productWidth: 560,
    intro: 'Tap “Go live” on the streamer phone. Chunks flow through ingest, the transcoder, and the packager to the CDN; the viewer phone shows how far behind live it is. Then try a hype moment in chat.',
    topology: {
      width: 1100, height: 560,
      nodes: [
        { id: 'streamer', label: 'Streamer phone', sub: 'Camera + encoder', kind: 'client', x: 100, y: 90, latency: 1, role: 'Captures and sends a chunk every 500 ms.', owns: ['Camera feed'] },
        { id: 'ingest', label: 'Ingest', sub: 'Primary', kind: 'gateway', x: 320, y: 90, latency: 3, role: 'Receives the live feed.', ops: [{ name: 'chunk', desc: 'Accept a chunk.' }], owns: ['Nothing durable'] },
        { id: 'backup', label: 'Backup ingest', sub: 'Another site', kind: 'gateway', x: 320, y: 270, latency: 6, role: 'A second ingest point the encoder can switch to.', ops: [{ name: 'chunk', desc: 'Accept a chunk.' }], owns: ['Nothing durable'] },
        { id: 'transcoder', label: 'Live transcoder', sub: 'Renditions in real time', kind: 'worker', x: 560, y: 180, latency: 2, role: 'Encodes every chunk into each rendition. Must keep up with real time or latency grows.', ops: [{ name: 'encode', desc: 'Encode one chunk.' }], owns: ['Encoder state'] },
        { id: 'packager', label: 'Packager', sub: 'Chunks → segments', kind: 'service', x: 800, y: 180, latency: 3, role: 'Groups chunks into playable segments and publishes them.', ops: [{ name: 'add', desc: 'Add a chunk.' }], owns: ['Open segment'] },
        { id: 'edge', label: 'CDN edge', sub: 'Live segments', kind: 'cdn', x: 1000, y: 360, latency: 3, role: 'Serves the newest segments to viewers.', ops: [{ name: 'latest', desc: 'Newest segments.' }], owns: ['Recent segments'] },
        { id: 'viewer', label: 'Viewer phone', sub: 'Watching', kind: 'client', x: 760, y: 470, latency: 1, role: 'Fetches new segments and plays them a little behind live.', owns: ['Buffer'] },
        { id: 'chat', label: 'Chat service', sub: 'Fan-out', kind: 'service', x: 320, y: 470, latency: 2, serviceMs: 5, servers: 1, role: 'Fans each message out to every viewer: about 200 messages per second of capacity.', ops: [{ name: 'post', desc: 'Accept and fan out a message.' }], owns: ['Chat history'] },
        { id: 'crowd', label: 'Other viewers', sub: 'Chatting', kind: 'client', x: 100, y: 470, latency: 1, role: 'Everyone else in chat.', owns: ['Nothing'] },
      ],
      edges: [
        { from: 'streamer', to: 'ingest', latency: 30 },
        { from: 'streamer', to: 'backup', latency: 45, label: 'failover' },
        { from: 'ingest', to: 'transcoder', latency: 4 },
        { from: 'backup', to: 'transcoder', latency: 6 },
        { from: 'transcoder', to: 'packager', latency: 3 },
        { from: 'packager', to: 'edge', latency: 6 },
        { from: 'viewer', to: 'edge', latency: 25 },
        { from: 'viewer', to: 'chat', latency: 30 },
        { from: 'crowd', to: 'chat', latency: 30 },
      ],
    },
    failures: [
      { id: 'ingest-down', node: 'ingest', mode: 'down', label: 'Ingest disconnects', desc: 'The primary ingest point stops accepting the feed.' },
      { id: 'tc-slow', node: 'transcoder', mode: 'slow', params: { factor: 4 }, label: 'Transcoder overloaded', desc: 'Encoding takes four times longer, more than real time allows.' },
      { id: 'edge-down', node: 'edge', mode: 'down', label: 'CDN edge down', desc: 'Viewers cannot fetch new segments.' },
    ],
    switches: Y.switches([
      ['lowLatency', 'Low-latency segments', '1 s segments and a one-segment buffer. Off: 4 s segments and a two-segment buffer.'],
      ['backup', 'Backup ingest', 'The encoder fails over to a second ingest point. Off: the stream drops.'],
      ['shed', 'Shed renditions under load', 'If the transcoder falls behind, drop 1080p to keep up. Off: latency grows without bound.'],
      ['sample', 'Chat sampling', 'During floods, show viewers a sample (your own messages always appear). Off: every message, however late.'],
    ]),
    presets: Y.presets({ lowLatency: true, backup: true, shed: true, sample: true }, [
      { id: 'live', label: 'Go live', desc: 'About 2 s behind live with low-latency segments.', run: (s) => startLive(s) },
      { id: 'standard', label: 'Standard latency', desc: '4 s segments: smoother, but viewers are about 9 s behind.', sw: { lowLatency: false }, run: (s) => startLive(s) },
      { id: 'ingest', label: 'Ingest drops, backup', desc: 'The encoder switches ingest points; viewers see no gap.', run: (s) => { startLive(s); s.schedule(3000, () => s.inject('ingest', 'down', true, 3000)); } },
      { id: 'ingest-bad', label: 'Ingest drops, no backup', desc: 'Three seconds of live video are gone; viewers see the stream stall.', sw: { backup: false }, run: (s) => { startLive(s); s.schedule(3000, () => s.inject('ingest', 'down', true, 3000)); } },
      { id: 'overload', label: 'Transcoder overload, shedding', desc: 'Dropping 1080p brings encoding back under real time.', run: (s) => { startLive(s); s.schedule(2000, () => s.inject('transcoder', 'slow', { factor: 4 })); } },
      { id: 'overload-bad', label: 'Transcoder overload, no shedding', desc: 'Every chunk takes longer than 500 ms to encode, so viewers fall further behind every second.', sw: { shed: false }, run: (s) => { startLive(s); s.schedule(2000, () => s.inject('transcoder', 'slow', { factor: 4 })); } },
      { id: 'hype', label: 'Chat hype, sampled', desc: '400 messages per second. Viewers see a readable sample; your message appears immediately.', run: (s) => { startLive(s); s.do('hype', { on: true }); s.schedule(1500, () => startChat(s)); s.schedule(5000, () => s.do('hype', { on: false })); } },
      { id: 'hype-bad', label: 'Chat hype, unsampled', desc: 'Every message is fanned out; the chat runs seconds behind, including your message.', sw: { sample: false }, run: (s) => { startLive(s); s.do('hype', { on: true }); s.schedule(1500, () => startChat(s)); s.schedule(5000, () => s.do('hype', { on: false })); } },
    ]),
    initialState: () => ({ config: { lowLatency: true, backup: true, shed: true, sample: true }, live: false, open: [], segments: [], played: null, latency: null, lastSeg: 0, stalls: 0, lostChunks: 0, renditions: 4, hype: false, chat: [], myChatDelay: null, chatDropped: 0, sampleN: 0, seq: { chunk: 0, seg: 0, msg: 0 } }),
    initialUI: () => ({}),
    actions: {
      live(sim) { startLive(sim); },
      chat(sim) { startChat(sim); },
      hype(sim, a) { sim.state.hype = a.on; sim.note(a.on ? 'A big moment on stream: about 400 chat messages per second.' : 'Chat calms down.'); },
      set: Y.setAction,
    },
    handlers: {
      ingest: { chunk: function* (ctx, c) { return ctx.must(yield ctx.call('transcoder', 'encode', c, { timeout: 14000 })); } },
      backup: { chunk: function* (ctx, c) { return ctx.must(yield ctx.call('transcoder', 'encode', c, { timeout: 14000 })); } },
      transcoder: {
        encode: function* (ctx, c) {
          const st = ctx.state;
          const slow = ctx.mode('slow') ? (ctx.mode('slow').factor || 4) : 1;
          st.tcBacklog = (st.tcBacklog || 0) + 1;
          if (st.config.shed && slow > 1 && st.renditions === 4) { st.renditions = 2; ctx.log({ op: 'dropped 1080p and 720p', status: 'note', detail: 'Encoding was falling behind real time; fewer renditions bring it back.' }); }
          if (!(slow > 1) && st.renditions < 4) st.renditions = 4;
          // Encoding is serial for a live stream: the next chunk waits for this one.
          const start = Math.max(ctx.now(), st.tcFree || 0);
          const work = st.renditions * RENDITION_MS * slow;
          st.tcFree = start + work;
          yield ctx.wait(start - ctx.now() + work);
          st.tcBacklog--;
          return ctx.must(yield ctx.call('packager', 'add', c, { timeout: 1000 }));
        },
      },
      packager: {
        add(ctx, c) {
          const st = ctx.state;
          st.open.push(c);
          const per = st.config.lowLatency ? 2 : 8;
          if (st.open.length >= per) { st.segments.push({ n: ++st.seq.seg, from: st.open[0].t, to: c.t, ready: ctx.now() }); st.open = []; }
          return { ok: true };
        },
      },
      edge: { latest(ctx, p) { return { segs: ctx.state.segments.filter((s) => s.n > p.after) }; } },
      chat: {
        post(ctx, m) {
          const st = ctx.state;
          const delay = ctx.now() - m.t;
          if (m.mine) { st.myChatDelay = delay; st.chat.push({ who: 'You', text: m.text }); return { ok: true }; }
          st.seq.msg++;
          st.chat.push({ who: 'viewer' + (st.seq.msg % 97), text: m.text });
          if (st.chat.length > 30) st.chat.shift();
          st.lastCrowdDelay = delay;
          return { ok: true };
        },
      },
    },
    setup(sim) {
      // Viewer: poll the edge, keep a small buffer, measure capture-to-screen latency.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(500);
          const st = ctx.state;
          if (!st.live && !st.segments.length) continue;
          const r = yield ctx.call('edge', 'latest', { after: st.lastSeg }, { timeout: 800, quiet: 'all' });
          const segDur = (st.config.lowLatency ? 2 : 8) * CHUNK_MS;
          const bufferSegs = st.config.lowLatency ? 1 : 2;
          if (r.ok && r.value.segs.length) {
            st.lastSeg = r.value.segs[r.value.segs.length - 1].n;
            st.lastNew = ctx.now();
            st.latency = ctx.now() - r.value.segs[r.value.segs.length - 1].to + segDur * bufferSegs;
            if (st.stalled) { st.stalled = false; ctx.log({ op: 'stream resumed for viewers', status: 'recovered' }); }
          } else if (st.live && st.lastNew && ctx.now() - st.lastNew > segDur * (bufferSegs + 1) && !st.stalled) {
            st.stalled = true;
            st.stalls++;
            ctx.log({ op: 'viewers stalled', status: 'err', detail: 'No new segments: the stream looks frozen to viewers.' });
          }
        }
      }, { self: 'viewer', quiet: 'all' });
      Y.load(sim, 'crowd', (s) => (s.state.hype ? 400 : 3), function* (ctx) {
        const st = ctx.state;
        // Sampling happens at the chat edge, before any fan-out work is spent.
        if (st.config.sample && st.hype && ++st.sampleN % 20 !== 0) { st.chatDropped++; return; }
        yield ctx.call('chat', 'post', { text: ['W', 'LETS GO', 'clutch', 'gg', 'no way'][ctx.state.seq.msg % 5], t: ctx.now() }, { timeout: 8000, quiet: 'all' });
      });
    },
    consistency(sim) {
      const st = sim.state;
      if (st.lostChunks) return { key: 'wrong', label: `${(st.lostChunks * CHUNK_MS / 1000).toFixed(1)} s of the broadcast never reached the platform and can never be shown.` };
      if (st.stalled) return { key: 'stale', label: 'Viewers are stalled: no new segments are arriving.' };
      if (st.latency > 4500 && st.config.lowLatency) return { key: 'stale', label: `Viewers are ${(st.latency / 1000).toFixed(1)} s behind live and falling further behind.` };
      const w = sim.queueWait('chat');
      if (w > 1000) return { key: 'stale', label: `Chat is running ${(w / 1000).toFixed(1)} s behind.` };
      return { key: 'ok', label: st.live ? `Live, about ${((st.latency || 0) / 1000).toFixed(1)} s behind real time.` : 'Not live.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const w = sim.queueWait('chat');
      return [
        { label: 'Behind live', value: st.latency == null ? 'n/a' : `${(st.latency / 1000).toFixed(1)} s`, tone: st.latency > 6000 ? 'fail' : st.latency > 3500 ? 'warn' : 'ok' },
        { label: 'Renditions', value: st.renditions },
        { label: 'Lost video', value: `${(st.lostChunks * CHUNK_MS / 1000).toFixed(1)} s`, tone: st.lostChunks ? 'fail' : '' },
        { label: 'Chat delay', value: SDL.fmtMs(w), tone: w > 1000 ? 'fail' : w > 300 ? 'warn' : 'ok' },
        { label: 'Your message delay', value: st.myChatDelay == null ? 'n/a' : SDL.fmtMs(st.myChatDelay) },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['streamer', 'Streamer'], ['viewer', 'Viewer']], { note: 'Latency is measured from the camera to the viewer’s screen.' }); },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        Y.paint(el, sim, 'streamer', { head: '<div><p class="app-title">YouTube Live</p></div>', body: `<div class="player"><div class="player-screen">${st.live ? '● LIVE' : 'Camera ready'}</div></div>${Y.btn('live', st.live ? 'End stream' : 'Go live', { cls: st.live ? 'danger' : 'go' })}<p class="app-sub">Chunks sent: <span data-live="chunks"></span></p>` }, { chunks: String(st.seq.chunk) });
        const chat = st.chat.slice(-6).map((m) => `<span><b>${esc(m.who)}</b>${esc(m.text)}</span>`).join('');
        Y.paint(el, sim, 'viewer', { head: '<div><p class="app-title">YouTube</p></div>', body: `<div class="player"><div class="player-screen${st.stalled ? ' is-stalled' : ''}">${st.segments.length ? `● LIVE <span class="quality" data-live="lat"></span>` : 'Waiting for stream'}</div></div><div class="chat">${chat}</div>${Y.btn('chat', 'Send a chat message', { cls: 'secondary' })}` }, { lat: st.latency == null ? '' : `${(st.latency / 1000).toFixed(1)} s behind` });
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
