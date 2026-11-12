/*
 * Watch history and playlists. The player saves resume positions: throttled to
 * keep write volume sane, and flushed on pause so another device resumes at the
 * right spot. Playlist edits from two devices are sent as operations against a
 * version, so concurrent edits merge instead of overwriting each other.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const THROTTLE_MS = 5000;
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function* savePos(ctx, pos, why) {
    const st = ctx.state;
    st.writes++;
    const r = yield ctx.call('gateway', 'position', { pos, t: ctx.now() }, { timeout: 1500, quiet: why === 'tick' });
    if (!r.ok && why !== 'tick') ctx.log({ op: 'position not saved', status: 'err', error: r.error, detail: `Resume point ${fmt(pos)} was not saved; another device will resume earlier.` });
    return r.ok;
  }

  function startWatch(sim) {
    const st = sim.state;
    if (st.playing) { st.playing = false; sim.startAction('Phone: pause', function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: ['yes', 'Saving a position is a last-write-wins upsert by timestamp.'] });
      if (st.config.flush) { const ok = yield* savePos(ctx, st.pos, 'pause'); Y.L(ctx, { accepted: ok ? 'yes' : 'no', committed: ok ? ['yes', `Resume point ${fmt(st.pos)} saved on pause.`] : 'no', async: 'n/a' }); }
      else Y.L(ctx, { accepted: 'n/a', committed: ['no', 'No flush on pause: the last periodic save stands.'], async: 'n/a' });
    }, { self: 'phone' }); return; }
    st.playing = true;
    sim.startAction('Phone: play', function* (ctx) {
      Y.L(ctx, { displayed: 'yes', committed: ['pending', 'Positions are saved periodically while playing.'], async: 'n/a', retrySafe: 'yes' });
      let last = ctx.now();
      while (st.playing) {
        yield ctx.wait(100);
        st.pos += 0.1;
        const every = st.config.throttle ? THROTTLE_MS : 1000;
        // Saves are fire-and-forget: playback never waits for the database.
        if (ctx.now() - last >= every) { last = ctx.now(); const pos = st.pos; ctx.spawn((c) => savePos(c, pos, 'tick')); }
      }
      Y.L(ctx, { accepted: 'yes' });
    }, { self: 'phone' });
  }
  function startContinue(sim) {
    sim.startAction('TV: continue watching', function* (ctx) {
      Y.L(ctx, { committed: ['n/a', 'Reading only.'], async: 'n/a', retrySafe: 'yes' });
      const r = yield ctx.call('gateway', 'resume', {}, { timeout: 1500 });
      const st = ctx.state;
      if (r.ok) {
        st.tvPos = r.value.pos;
        const behind = st.pos - r.value.pos;
        Y.L(ctx, { displayed: ['yes', `TV offers “Resume from ${fmt(r.value.pos)}”.`], accepted: 'yes' });
        ctx.explain(behind > 2 ? `The TV resumes at ${fmt(r.value.pos)}, ${behind.toFixed(0)} s before where the phone stopped. ${st.config.flush ? 'The latest save has not landed yet.' : 'Without a save on pause, the last periodic save is all the server has.'}` : `The TV resumes at ${fmt(r.value.pos)}, exactly where the phone stopped.`);
      } else Y.failed(ctx);
    }, { self: 'tv' });
  }
  function startEdits(sim) {
    const st = sim.state;
    const base = st.playlist.items.slice();
    const v = st.playlist.version;
    const send = (device, op, desc) => sim.startAction(`${device === 'phone' ? 'Phone' : 'TV'}: ${desc}`, function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: ['yes', 'Operations carry an ID.'] });
      const local = op.kind === 'move' ? [op.item].concat(base.filter((x) => x !== op.item)) : base.filter((x) => x !== op.item);
      const r = yield ctx.call('gateway', 'playlist', st.config.ops ? { op, baseVersion: v } : { list: local }, { timeout: 1500 });
      if (r.ok) Y.L(ctx, { accepted: 'yes', committed: ['yes', st.config.ops ? 'Operation applied to the current list.' : 'The whole list was replaced with this device’s copy.'], async: 'n/a' });
      else Y.failed(ctx);
    }, { self: device });
    send('phone', { kind: 'move', item: 'D' }, 'move “Kafka internals” to the top');
    sim.schedule(10, () => send('tv', { kind: 'remove', item: 'B' }, 'remove “Paxos made simple”'));
  }

  const TITLES = { A: 'Raft, part 1', B: 'Paxos made simple', C: 'Consistent hashing', D: 'Kafka internals' };
  const sc = (SDL.scenarios.history = {
    id: 'history',
    seed: 179,
    productWidth: 560,
    intro: 'Press Play on the phone, pause a few seconds later, then tap “Continue on TV”. Then edit the playlist from both devices at once.',
    topology: {
      width: 1100, height: 520,
      nodes: [
        { id: 'phone', label: 'Phone app', sub: 'Watching', kind: 'client', x: 100, y: 90, latency: 1, role: 'Plays video and saves resume points.', owns: ['Local position'] },
        { id: 'tv', label: 'TV app', sub: 'Continue watching', kind: 'client', x: 100, y: 400, latency: 1, role: 'Resumes from the saved position and edits the shared playlist.', owns: ['Nothing'] },
        { id: 'crowd', label: 'Other viewers', sub: 'Background writes', kind: 'client', x: 330, y: 470, latency: 1, role: 'Everyone else saving positions.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Device traffic', kind: 'gateway', x: 330, y: 250, latency: 2, role: 'Routes history and playlist calls.', ops: [{ name: 'position', desc: 'Save a resume point.' }, { name: 'resume', desc: 'Read it.' }, { name: 'playlist', desc: 'Edit a playlist.' }], owns: ['Nothing durable'] },
        { id: 'historydb', label: 'Watch history', sub: 'Resume points', kind: 'db', x: 600, y: 120, latency: 4, serviceMs: 12, servers: 1, role: 'Latest position per (user, video), newest timestamp wins. About 80 writes per second here.', ops: [{ name: 'save', desc: 'Upsert a position.' }, { name: 'get', desc: 'Read a position.' }], owns: ['positions'] },
        { id: 'playlistdb', label: 'Playlists', sub: 'Ordered items', kind: 'db', x: 600, y: 380, latency: 8, role: 'Playlist items with a version number.', ops: [{ name: 'edit', desc: 'Apply an operation or replace the list.' }], owns: ['playlists'] },
      ],
      edges: [
        { from: 'phone', to: 'gateway', latency: 30 },
        { from: 'tv', to: 'gateway', latency: 30 },
        { from: 'crowd', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'historydb', latency: 4 },
        { from: 'gateway', to: 'playlistdb', latency: 4 },
      ],
    },
    failures: [
      { id: 'history-down', node: 'historydb', mode: 'down', label: 'Watch history unavailable', desc: 'Positions cannot be saved or read.' },
      { id: 'history-slow', node: 'historydb', mode: 'slow', params: { factor: 6 }, label: 'Watch history slow', desc: 'Writes queue up.' },
      { id: 'playlist-down', node: 'playlistdb', mode: 'down', label: 'Playlists unavailable', desc: 'Edits fail cleanly.' },
    ],
    switches: Y.switches([
      ['throttle', 'Throttle position saves', `Save every ${THROTTLE_MS / 1000} s instead of every second: a fifth of the writes.`],
      ['flush', 'Save on pause', 'Always save the exact position when playback stops.'],
      ['ops', 'Playlist edits as operations', 'Send “move D to top” against a version, merged on the server. Off: send the whole list, last write wins.'],
    ]),
    presets: Y.presets({ throttle: true, flush: true, ops: true }, [
      { id: 'continue', label: 'Pause on phone, continue on TV', desc: 'Throttled saves while playing, an exact save on pause, the TV resumes at the right second.', run: (s) => { startWatch(s); s.schedule(7300, () => startWatch(s)); s.schedule(8200, () => startContinue(s)); } },
      { id: 'no-flush', label: 'No save on pause', desc: 'The TV resumes at the last periodic save, seconds earlier.', sw: { flush: false }, run: (s) => { startWatch(s); s.schedule(7300, () => startWatch(s)); s.schedule(8200, () => startContinue(s)); } },
      { id: 'load', label: 'Busy evening, throttled', desc: 'Many viewers save positions; throttled writes stay well within capacity.', run: (s) => { s.do('crowd', { on: true }); startWatch(s); s.schedule(4300, () => startWatch(s)); s.schedule(5200, () => startContinue(s)); } },
      { id: 'load-bad', label: 'Busy evening, unthrottled', desc: 'Five times the writes overflow the database: saves queue for seconds and the TV resumes from an old point.', sw: { throttle: false }, run: (s) => { s.do('crowd', { on: true }); startWatch(s); s.schedule(4300, () => startWatch(s)); s.schedule(5200, () => startContinue(s)); } },
      { id: 'edits', label: 'Two devices edit the playlist', desc: 'Phone moves an item, TV removes one, at the same moment. Both edits survive.', run: (s) => startEdits(s) },
      { id: 'edits-bad', label: 'Same, whole-list writes', desc: 'Each device sends its own full copy; the later one silently undoes the other’s edit.', sw: { ops: false }, run: (s) => startEdits(s) },
      { id: 'down', label: 'History down during the pause', desc: 'The save on pause fails; the TV resumes from the last successful save.', run: (s) => { startWatch(s); s.schedule(7000, () => s.inject('historydb', 'down', true, 1200)); s.schedule(7300, () => startWatch(s)); s.schedule(8400, () => startContinue(s)); } },
    ]),
    initialState: () => ({ config: { throttle: true, flush: true, ops: true }, playing: false, pos: 0, saved: { pos: 0, t: 0 }, tvPos: null, writes: 0, crowd: false, playlist: { items: ['A', 'B', 'C', 'D'], version: 1 }, intended: null }),
    initialUI: () => ({}),
    actions: {
      play(sim) { startWatch(sim); },
      cont(sim) { startContinue(sim); },
      edits(sim) { startEdits(sim); },
      crowd(sim, a) { sim.state.crowd = a.on; sim.note('Evening peak: many other viewers are saving positions.'); },
      set: Y.setAction,
    },
    handlers: {
      gateway: {
        position: function* (ctx, p) { return ctx.must(yield ctx.call('historydb', 'save', p, { timeout: 1400 })); },
        resume: function* (ctx) { return ctx.must(yield ctx.call('historydb', 'get', {}, { timeout: 1400 })); },
        playlist: function* (ctx, p) { return ctx.must(yield ctx.call('playlistdb', 'edit', p, { timeout: 1400 })); },
      },
      historydb: {
        save(ctx, p) { const st = ctx.state; if (!p.crowd && p.t >= st.saved.t) st.saved = { pos: p.pos, t: p.t }; return { ok: true }; },
        get(ctx) { return { pos: ctx.state.saved.pos }; },
      },
      playlistdb: {
        edit(ctx, p) {
          const pl = ctx.state.playlist;
          if (p.op) {
            if (p.op.kind === 'move') pl.items = [p.op.item].concat(pl.items.filter((x) => x !== p.op.item));
            else pl.items = pl.items.filter((x) => x !== p.op.item);
          } else pl.items = p.list.slice();
          pl.version++;
          return { items: pl.items.slice(), version: pl.version };
        },
      },
    },
    setup(sim) {
      Y.load(sim, 'crowd', (s) => (s.state.crowd ? (s.state.config.throttle ? 25 : 125) : 0), function* (ctx) {
        yield ctx.call('gateway', 'position', { pos: 1, t: 0, crowd: true }, { timeout: 1500, quiet: 'all' });
      });
    },
    consistency(sim) {
      const st = sim.state;
      const items = st.playlist.items;
      if (st.playlist.version > 1 && (items.includes('B') || items[0] !== 'D')) return { key: 'wrong', label: `The playlist is ${items.map((i) => TITLES[i]).join(', ')}: one device’s edit was silently lost.` };
      if (st.tvPos != null && !st.playing && st.pos - st.tvPos > 2) return { key: 'stale', label: `The TV resumed at ${fmt(st.tvPos)}, ${(st.pos - st.tvPos).toFixed(0)} s before the phone stopped at ${fmt(st.pos)}.` };
      const w = sim.queueWait('historydb');
      if (w > 500) return { key: 'stale', label: `Position saves are queuing for ${SDL.fmtMs(w)}.` };
      return { key: 'ok', label: 'Resume points and the playlist match what the user did.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const w = sim.queueWait('historydb');
      return [
        { label: 'Phone position', value: fmt(st.pos) },
        { label: 'Saved resume point', value: fmt(st.saved.pos) },
        { label: 'History write queue', value: SDL.fmtMs(w), tone: w > 500 ? 'fail' : w > 100 ? 'warn' : 'ok' },
        { label: 'Your position writes', value: st.writes },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['phone', 'Phone'], ['tv', 'TV']], { note: 'Both devices share one account: one resume point and one playlist.' }); },
      render(el, sim) {
        const st = sim.state;
        const list = `<div class="yt-feed">${st.playlist.items.map((i, n) => `<div class="yt-card"><div class="yt-thumb" style="--h:${n * 70}">${n + 1}</div><div><strong>${TITLES[i]}</strong></div></div>`).join('')}</div>`;
        Y.paint(el, sim, 'phone', { head: '<div><p class="app-title">YouTube</p></div>', body: `${Y.video('Raft, part 1', 'Distributed Daily', '', 200)}<p class="app-sub">Position <span data-live="pos"></span></p>${Y.btn('play', st.playing ? 'Pause' : 'Play')}${Y.btn('edits', 'Edit playlist from both devices', { cls: 'secondary' })}` }, { pos: fmt(st.pos) });
        Y.paint(el, sim, 'tv', { head: '<div><p class="app-title">YouTube on TV</p></div>', body: `${Y.btn('cont', 'Continue watching')}${st.tvPos != null ? `<div class="app-card is-ok"><strong>Resume from ${fmt(st.tvPos)}</strong></div>` : ''}<p class="app-sub">Shared playlist (version ${st.playlist.version})</p>${list}` }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
