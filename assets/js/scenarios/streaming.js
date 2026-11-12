/*
 * Video streaming and playback. The player fetches a manifest, then 2-second
 * segments, keeping a buffer ahead of the playhead. Adaptive bitrate picks the
 * highest rendition the measured throughput can sustain. Segments come from a
 * CDN edge (cached) or the origin (on a miss). Playback consumes the buffer in
 * simulated real time; an empty buffer is a stall.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const Q = [['240p', 0.4], ['480p', 1.2], ['720p', 3], ['1080p', 6]];
  const NETS = { fast: ['Fast Wi-Fi', 20], lte: ['4G', 6], weak: ['Weak signal', 1.5] };
  const SEG = 2;
  const SEGMENTS = 30;
  const rate = (q) => Q.find((x) => x[0] === q)[1];

  function* fetchVia(ctx, op, payload) {
    const st = ctx.state;
    const edges = st.config.failover ? ['edgeA', 'edgeB'] : ['edgeA'];
    let last;
    for (const e of edges) {
      last = yield ctx.call(e, op, payload, { timeout: 2500 });
      if (last.ok) return Object.assign({ edge: e }, last);
      if (e === 'edgeA' && edges.length > 1) ctx.log({ op: `CDN A failed, trying CDN B`, status: 'retry', error: last.error, detail: 'Multi-CDN failover: the player switches to the backup CDN for this request.' });
    }
    return last;
  }

  function startPlay(sim) {
    if (sim.state.playing) { sim.state.playing = false; sim.note('Viewer paused playback.'); return; }
    const st = sim.state;
    st.playing = true;
    st.session++;
    const session = st.session;
    sim.startAction('Viewer: play video', function* (ctx) {
      const u = ctx.ui.player;
      Object.assign(u, { error: null });
      Y.L(ctx, { displayed: ['pending', 'Spinner until the first segment arrives.'], committed: ['n/a', 'Playback reads only.'], retrySafe: 'yes' });
      const t0 = ctx.now();
      let m;
      for (let a = 1; a <= 3; a++) {
        m = yield* fetchVia(ctx, 'manifest', {});
        if (m.ok) break;
        ctx.log({ op: `manifest attempt ${a} failed`, status: 'retry', error: m.error, detail: 'No manifest, no playback: the player retries with backoff.' });
        yield ctx.wait(300 * a);
      }
      if (!m.ok) { u.error = 'This video can’t be played right now.'; st.playing = false; st.fatal = true; Y.failed(ctx, 'Shows a playback error.'); return; }
      Y.L(ctx, { accepted: 'yes' });
      while (st.playing && st.session === session && st.next < SEGMENTS) {
        const target = st.config.prefetch ? 10 : 4;
        if (st.buffer >= target) { yield ctx.wait(100); continue; }
        let q = u.quality === 'auto' && st.config.abr ? Q.filter(([, r]) => r <= st.throughput * 0.7).slice(-1)[0] || Q[0] : Q.find(([n]) => n === (u.quality === 'auto' ? '1080p' : u.quality));
        q = q[0];
        const n = st.next;
        let r = yield* fetchVia(ctx, 'segment', { n, q });
        if (!r.ok && r.error.code === 'NOT_FOUND' && st.config.fallback) {
          const lower = Q[Math.max(0, Q.findIndex(([x]) => x === q) - 2)][0];
          ctx.log({ op: `segment ${n} missing at ${q}`, status: 'retry', detail: `Falling back to ${lower} for this one segment.` });
          q = lower;
          r = yield* fetchVia(ctx, 'segment', { n, q });
        }
        if (!r.ok) {
          st.segErrors++;
          if (st.segErrors > 6) { u.error = 'Playback error: a segment could not be loaded.'; st.playing = false; st.fatal = true; ctx.explain('The same segment failed repeatedly and there was no lower-quality fallback, so playback gave up with an error.'); break; }
          yield ctx.wait(400);
          continue;
        }
        st.segErrors = 0;
        const bw = NETS[u.net][1];
        const mbits = rate(q) * SEG;
        const transfer = (mbits / bw) * 1000;
        yield ctx.wait(transfer);
        const took = transfer + r.latency;
        // Fast down, slow up: a slow sample is believed at once; a fast one only gradually.
        const sample = mbits / (took / 1000);
        st.throughput = !st.throughput ? sample : sample < st.throughput ? sample : 0.7 * st.throughput + 0.3 * sample;
        if (st.lastQ && st.lastQ !== q) { st.switches++; ctx.log({ op: `quality ${st.lastQ} → ${q}`, status: 'note', detail: `Measured throughput about ${st.throughput.toFixed(1)} Mbps.` }); }
        st.lastQ = q;
        st.bits.push(rate(q));
        st.buffer += SEG;
        st.next++;
        if (st.startup == null) {
          st.startup = ctx.now() - t0;
          Y.L(ctx, { displayed: ['yes', `First frame after ${Math.round(st.startup)} ms.`], async: 'n/a' });
          ctx.explain(`Playback started after ${Math.round(st.startup)} ms: manifest, then the first segment from ${r.edge === 'edgeA' ? 'CDN A' : 'CDN B'}${r.value.hit ? ' (a cache hit)' : ' (a miss fetched from the origin)'}. From here the player keeps ${st.config.prefetch ? 10 : 4} s of video buffered and adapts quality to measured throughput.`);
        }
      }
    }, { self: 'player' });
  }

  const sc = (SDL.scenarios.streaming = {
    id: 'streaming',
    seed: 149,
    productWidth: 440,
    intro: 'Press Play. Watch the buffer fill, the quality settle, and segments flow from the CDN. Then switch the network to a weak signal, or take a CDN down.',
    topology: {
      width: 1100, height: 470,
      nodes: [
        { id: 'player', label: 'Video player', sub: 'Buffer and ABR', kind: 'client', x: 100, y: 90, latency: 1, role: 'Fetches the manifest and segments, keeps a buffer ahead of the playhead, and picks quality from measured throughput.', owns: ['Buffer', 'Throughput estimate'] },
        { id: 'edgeA', label: 'CDN A', sub: 'Primary edge', kind: 'cdn', x: 330, y: 90, latency: 3, role: 'Nearby edge cache; hits are fast, misses go to the origin.', ops: [{ name: 'manifest', desc: 'Playback manifest.' }, { name: 'segment', desc: 'One 2 s segment.' }], owns: ['Cached segments'] },
        { id: 'edgeB', label: 'CDN B', sub: 'Backup provider', kind: 'cdn', x: 330, y: 360, latency: 6, role: 'A second CDN provider for failover. Slightly farther away.', ops: [{ name: 'segment', desc: 'One 2 s segment.' }], owns: ['Cached segments'] },
        { id: 'origin', label: 'Origin and packager', sub: 'Source of segments', kind: 'service', x: 580, y: 225, latency: 15, role: 'Serves manifests and segments to CDNs on a cache miss.', ops: [{ name: 'manifest', desc: 'Build the manifest.' }, { name: 'segment', desc: 'Read a segment.' }], owns: ['Manifests'] },
        { id: 'store', label: 'Segment storage', sub: 'All renditions', kind: 'store', x: 830, y: 225, latency: 10, role: 'Every rendition’s segments.', ops: [{ name: 'get', desc: 'Read a segment.' }], owns: ['segments'] },
      ],
      edges: [
        { from: 'player', to: 'edgeA', latency: 20 },
        { from: 'player', to: 'edgeB', latency: 35 },
        { from: 'edgeA', to: 'origin', latency: 25 },
        { from: 'edgeB', to: 'origin', latency: 30 },
        { from: 'origin', to: 'store', latency: 5 },
      ],
    },
    modeLabels: { missing: 'Missing a segment', manifestError: 'Failing manifests' },
    failures: [
      { id: 'edgeA-down', node: 'edgeA', mode: 'down', label: 'CDN A outage', desc: 'The primary CDN stops answering.' },
      { id: 'origin-slow', node: 'origin', mode: 'slow', params: { factor: 25 }, label: 'Origin slow', desc: 'Cache misses take 25 times longer.' },
      { id: 'missing', node: 'store', mode: 'missing', label: 'Missing segment', desc: 'Segment 5 is missing in 720p and 1080p.' },
      { id: 'manifest', node: 'origin', mode: 'manifestError', label: 'Manifest errors', desc: 'The origin fails manifest requests.' },
    ],
    switches: Y.switches([
      ['abr', 'Adaptive bitrate', 'Pick quality from measured throughput. Off: Auto means 1080p.'],
      ['failover', 'Multi-CDN failover', 'Retry a failed request on CDN B. Off: the player only knows CDN A.'],
      ['fallback', 'Lower quality on a missing segment', 'Fetch that segment in a lower rendition. Off: retry the same one.'],
      ['prefetch', 'Larger buffer (10 s)', 'Off: keep only 4 s ahead, which leaves little room for hiccups.'],
    ]),
    presets: Y.presets({ abr: true, failover: true, fallback: true, prefetch: true }, [
      { id: 'play', label: 'Smooth playback', desc: 'Fast Wi-Fi: quality climbs to 1080p and stays there.', run: (s) => startPlay(s) },
      { id: 'weak', label: 'Signal drops, adaptive bitrate', desc: 'The network falls to 1.5 Mbps after 4 s. Quality steps down; playback continues.', run: (s) => { startPlay(s); s.schedule(4000, () => s.do('set', { field: 'player.net', value: 'weak' })); } },
      { id: 'weak-fixed', label: 'Signal drops, locked to 1080p', desc: 'The same drop with quality forced to 1080p: each 2 s segment takes 8 s to download, so it stalls.', run: (s) => { s.do('set', { field: 'player.quality', value: '1080p' }); startPlay(s); s.schedule(4000, () => s.do('set', { field: 'player.net', value: 'weak' })); } },
      { id: 'cdn', label: 'CDN A outage, failover', desc: 'CDN A dies mid-playback; requests move to CDN B without a stall.', run: (s) => { startPlay(s); s.schedule(3000, () => s.inject('edgeA', 'down')); } },
      { id: 'cdn-bad', label: 'CDN A outage, no failover', desc: 'The buffer drains, then playback stalls with nowhere to go.', sw: { failover: false }, run: (s) => { startPlay(s); s.schedule(3000, () => s.inject('edgeA', 'down')); } },
      { id: 'missing', label: 'Missing segment, fallback', desc: 'Segment 5 is missing in high quality; one segment plays in 240p and nobody notices.', run: (s) => { s.inject('store', 'missing'); startPlay(s); } },
      { id: 'missing-bad', label: 'Missing segment, no fallback', desc: 'The player keeps asking for a segment that does not exist, then gives up.', sw: { fallback: false }, run: (s) => { s.inject('store', 'missing'); startPlay(s); } },
      { id: 'cold', label: 'Slow origin on a cold cache', desc: 'Nothing is cached yet and the origin is slow: a long wait for the first frame.', run: (s) => { s.inject('origin', 'slow', { factor: 25 }); startPlay(s); } },
      { id: 'manifest', label: 'Manifest errors, retried', desc: 'The first manifest requests fail; a retry with backoff gets through and playback starts.', run: (s) => { s.inject('origin', 'manifestError', true, 700); startPlay(s); } },
    ]),
    initialState: () => ({ config: { abr: true, failover: true, fallback: true, prefetch: true }, playing: false, session: 0, buffer: 0, pos: 0, next: 0, throughput: 0, bits: [], switches: 0, stalls: 0, stallMs: 0, stalled: false, startup: null, segErrors: 0, fatal: false, lastQ: null, cache: { edgeA: {}, edgeB: {} } }),
    initialUI: () => ({ player: { quality: 'auto', net: 'fast', error: null } }),
    actions: { play(sim) { startPlay(sim); }, set: Y.setAction },
    handlers: {
      edgeA: edgeHandlers('edgeA'),
      edgeB: edgeHandlers('edgeB'),
      origin: {
        manifest(ctx) { if (ctx.mode('manifestError')) ctx.fail('SERVER_ERROR', 'Manifest generation failed.'); return { renditions: Q.map(([q]) => q), segments: SEGMENTS }; },
        segment: function* (ctx, p) { return ctx.must(yield ctx.call('store', 'get', p, { timeout: 2000 })); },
      },
      store: { get(ctx, p) { if (ctx.mode('missing') && p.n === 5 && (p.q === '720p' || p.q === '1080p')) ctx.fail('NOT_FOUND', `Segment ${p.n} at ${p.q} is missing.`); return { bytes: rate(p.q) * SEG }; } },
    },
    setup(sim) {
      // The playhead: consumes the buffer in simulated real time.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          const st = ctx.state;
          if (!st.playing || st.startup == null) continue;
          if (st.buffer > 0.05) {
            if (st.stalled) { st.stalled = false; ctx.log({ op: 'playback resumed', status: 'recovered', detail: `Stalled for ${Math.round(ctx.now() - st.stallStart)} ms.` }); }
            const d = Math.min(0.1, st.buffer);
            st.buffer -= d;
            st.pos += d;
            if (st.next >= SEGMENTS && st.buffer <= 0.05) { st.playing = false; ctx.log({ op: 'video finished', status: 'ok' }); }
          } else if (st.next < SEGMENTS && !st.stalled) {
            st.stalled = true;
            st.stalls++;
            st.stallStart = ctx.now();
            ctx.log({ op: 'stalled: buffer empty', status: 'err', detail: 'The playhead caught up with the downloaded video.' });
            ctx.explain('The buffer ran dry: segments are arriving more slowly than the video plays. Adaptive bitrate, a bigger buffer, or a working CDN path would have prevented this.');
          }
          if (st.stalled) st.stallMs += 100;
        }
      }, { self: 'player', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      if (st.fatal) return { key: 'wrong', label: 'Playback failed with an error the viewer cannot fix.' };
      if (st.stalled) return { key: 'stale', label: `Stalled: the buffer is empty (stall ${st.stalls}).` };
      if (st.stalls) return { key: 'stale', label: `Playback recovered, but stalled ${st.stalls} time${st.stalls > 1 ? 's' : ''} for ${(st.stallMs / 1000).toFixed(1)} s in total.` };
      return { key: 'ok', label: 'Smooth playback: no stalls.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const avg = st.bits.length ? st.bits.reduce((a, b) => a + b, 0) / st.bits.length : null;
      return [
        { label: 'Startup time', value: st.startup == null ? 'n/a' : SDL.fmtMs(st.startup), tone: st.startup > 1500 ? 'warn' : '' },
        { label: 'Buffer ahead', value: `${st.buffer.toFixed(1)} s`, tone: st.buffer < 1 && st.playing ? 'fail' : '' },
        { label: 'Stalls', value: `${st.stalls} (${(st.stallMs / 1000).toFixed(1)} s)`, tone: st.stalls ? 'fail' : 'ok' },
        { label: 'Average bitrate', value: avg == null ? 'n/a' : `${avg.toFixed(1)} Mbps` },
        { label: 'Quality switches', value: st.switches },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['player', 'Your phone']], { note: 'The grey bar is buffered video, the red bar is the playhead. Change quality or network at any time.' }); },
      render(el, sim) {
        const st = sim.state;
        const u = sim.ui.player;
        const opt = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${v}</option>`).join('');
        const body = `<div class="player"><div class="player-screen${st.stalled ? ' is-stalled' : ''}">${st.playing || st.pos ? `▶ <span class="quality" data-live="q"></span>` : '▶ Press play'}</div>
          <div class="player-bar"><i class="buf" data-live-width="buf"></i><i class="pos" data-live-width="pos"></i></div>
          <span class="app-sub" data-live="time"></span></div>
          ${Y.btn('play', st.playing ? 'Pause' : st.pos ? 'Resume' : 'Play')}
          <div class="app-row"><label for="sq">Quality</label><select id="sq" data-field="player.quality">${opt({ auto: 'Auto', '1080p': '1080p', '720p': '720p', '480p': '480p', '240p': '240p' }, u.quality)}</select></div>
          <div class="app-row"><label for="sn">Network</label><select id="sn" data-field="player.net">${opt(Object.fromEntries(Object.entries(NETS).map(([k, [l, m]]) => [k, `${l}, ${m} Mbps`])), u.net)}</select></div>
          ${u.error ? Y.msg(u.error, 'fail') : ''}`;
        const total = SEGMENTS * SEG;
        Y.paint(el, sim, 'player', { head: '<div><p class="app-title">YouTube</p><p class="app-sub">Leader election, explained</p></div>', body }, {
          q: st.lastQ || '…', buf: `${((st.pos + st.buffer) / total) * 100}%`, pos: `${(st.pos / total) * 100}%`,
          time: `${st.pos.toFixed(1)} s of ${total} s, ${st.buffer.toFixed(1)} s buffered`,
        });
      },
    },
  });

  function edgeHandlers(id) {
    return {
      manifest: function* (ctx) { return ctx.must(yield ctx.call('origin', 'manifest', {}, { timeout: 1500 })); },
      segment: function* (ctx, p) {
        const cache = ctx.state.cache[id];
        const key = `${p.n}/${p.q}`;
        if (cache[key]) { ctx.count('cacheHit'); return { hit: true }; }
        ctx.count('cacheMiss');
        ctx.must(yield ctx.call('origin', 'segment', p, { timeout: 2300 }));
        cache[key] = true;
        return { hit: false };
      },
    };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
