/*
 * Likes and reactions: the reference lab.
 * The client sends a desired state (liked: true/false) with a sequence number,
 * so retries are idempotent and late requests cannot undo newer ones. The
 * reaction row and an outbox event commit together; a consumer updates the
 * count read model. Celebrity videos turn the count row into a hot key.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const BASE = 12480;

  function startSet(sim, liked, label) {
    const st = sim.state;
    const ui = sim.ui.viewer;
    const seq = ++st.seq.client;
    const before = ui.liked;
    st.intent = liked;
    sim.startAction(label || (liked ? 'Viewer: like' : 'Viewer: unlike'), function* (ctx) {
      const u = ctx.ui.viewer;
      u.inflight++;
      if (st.config.optimistic) { u.liked = liked; u.shownCount += liked === before ? 0 : liked ? 1 : -1; }
      Y.L(ctx, {
        displayed: st.config.optimistic ? ['pending', 'Optimistic: the button flips immediately, before the server answers.'] : ['pending', 'Pessimistic: the button waits for the server.'],
        retrySafe: st.config.desired ? ['yes', `The request says “liked = ${liked}” with sequence ${seq}; repeating it changes nothing.`] : ['no', 'Toggle API: a retry flips the like again.'],
      });
      const r = yield* ctx.retry({ attempts: 3, baseMs: 150 }, function* () {
        return yield ctx.call('gateway', 'react', { user: 'you', liked, seq }, { timeout: 1000 });
      });
      u.inflight--;
      if (r.ok) {
        if (seq >= u.ackSeq) { u.ackSeq = seq; u.liked = r.value.liked; }
        u.message = r.value.liked ? 'Liked.' : 'Like removed.';
        u.tone = 'ok';
        Y.L(ctx, { displayed: ['yes', `Shows ${r.value.liked ? 'liked' : 'not liked'}, confirmed by the server.`], accepted: 'yes' });
        ctx.ledger('committed', 'yes', null, { ifPending: true });
        ctx.explain(r.value.changed
          ? `The reaction and its event committed together. The count updates when the counter consumer processes the event${st.config.optimistic ? '; the button already showed the change' : ''}.`
          : 'The server already had this state, so nothing changed and no event was emitted. That is what makes retries safe.');
      } else {
        if (st.config.optimistic && seq >= u.ackSeq) { u.liked = before; u.shownCount += liked === before ? 0 : liked ? -1 : 1; }
        u.message = r.error.code === 'TIMEOUT' ? 'We couldn’t confirm your like. Try again.' : `Couldn’t save: ${r.error.message}`;
        u.tone = 'fail';
        Y.failed(ctx, st.config.optimistic ? 'The optimistic change was rolled back.' : 'The button never changed.');
        ctx.explain(`The request failed with ${r.error.code} after ${r.attempts} attempt${r.attempts > 1 ? 's' : ''}.${st.config.optimistic ? ' The button had flipped optimistically, so it flips back: the app must not claim a like it could not save.' : ''}`);
      }
      setTimeout0(ctx.sim);
    }, { self: 'viewer' });
  }
  // Refresh the displayed count shortly after each action.
  function setTimeout0(sim) { sim.schedule(500, () => startRefresh(sim)); }
  function startRefresh(sim) {
    sim.spawn(function* (ctx) {
      const r = yield ctx.call('gateway', 'count', {}, { timeout: 800, quiet: true });
      if (r.ok && ctx.ui.viewer.inflight === 0) ctx.ui.viewer.shownCount = r.value.count;
    }, { self: 'viewer' });
  }

  const sc = (SDL.scenarios.likes = {
    id: 'likes',
    seed: 101,
    productWidth: 440,
    intro: 'Tap Like on the phone. The reaction commits with an outbox event, the counter consumer updates the count, and the phone refreshes it. Then try the eight failure scenarios.',
    topology: {
      width: 1100, height: 520,
      nodes: [
        { id: 'viewer', label: 'YouTube app', sub: 'Your phone', kind: 'client', x: 100, y: 90, latency: 1, role: 'Sends the desired like state with a sequence number; optimistic or pessimistic UI.', owns: ['What you see'] },
        { id: 'crowd', label: 'Other viewers', sub: 'Background likes', kind: 'client', x: 100, y: 330, latency: 1, role: 'Everyone else liking the same video.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Auth, rate limits', kind: 'gateway', x: 320, y: 90, latency: 2, role: 'Authenticates and forwards reaction calls; serves count reads.', ops: [{ name: 'react', desc: 'Set a reaction.' }, { name: 'count', desc: 'Read the like count.' }], owns: ['Nothing durable'] },
        { id: 'likesvc', label: 'Like service', sub: 'Reaction rules', kind: 'service', x: 540, y: 90, latency: 4, role: 'Applies the desired state, ignoring requests older than the latest sequence.', ops: [{ name: 'react', desc: 'Upsert one reaction.' }], owns: ['Reaction rules'] },
        { id: 'likedb', label: 'Reactions DB', sub: 'One row per user', kind: 'db', x: 760, y: 90, latency: 10, role: 'One row per (user, video), unique. Writes the reaction and its outbox event in one transaction.', ops: [{ name: 'upsert', desc: 'Set state if newer.' }], owns: ['reactions', 'outbox'] },
        { id: 'events', label: 'Reaction events', sub: 'Event broker', kind: 'queue', x: 980, y: 90, latency: 4, queue: 'reactions', role: 'Carries +1 / −1 events to the counter.', ops: [{ name: 'publish', desc: 'Append.' }], owns: ['reaction log'] },
        { id: 'counter', label: 'Counter consumer', sub: 'Applies deltas', kind: 'worker', x: 980, y: 330, latency: 3, role: 'Applies each event’s delta to the count, skipping events it has already applied.', ops: [{ name: 'consume', desc: 'Apply a delta.' }], owns: ['Processed event IDs'] },
        { id: 'counts', label: 'Like counts', sub: 'Read model', kind: 'cache', x: 760, y: 330, latency: 2, serviceMs: 25, servers: 1, role: 'The displayed count. One counter row per video is serialised: about 40 updates per second.', ops: [{ name: 'apply', desc: 'Add a delta.' }, { name: 'get', desc: 'Read the count.' }], owns: ['count[video]'] },
      ],
      edges: [
        { from: 'viewer', to: 'gateway', latency: 30 },
        { from: 'crowd', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'likesvc', latency: 3 },
        { from: 'likesvc', to: 'likedb', latency: 4 },
        { from: 'likedb', to: 'events', latency: 6, label: 'outbox' },
        { from: 'events', to: 'counter', latency: 4 },
        { from: 'counter', to: 'counts', latency: 3 },
        { from: 'gateway', to: 'counts', latency: 4, label: 'read' },
      ],
      queues: [{ id: 'outbox', broker: 'likedb', label: 'outbox', groups: ['relay'] }, { id: 'reactions', broker: 'events', label: 'reactions', groups: ['counter'] }],
    },
    modeLabels: { reorder: 'Reordering requests' },
    failures: [
      { id: 'svc-down', node: 'likesvc', mode: 'down', label: 'A. Like service unavailable', desc: 'Requests fail after bounded retries.' },
      { id: 'db-down', node: 'likedb', mode: 'down', label: 'B. Reactions DB unavailable', desc: 'Nothing can be saved; optimistic UI must roll back.' },
      { id: 'db-drop', node: 'likedb', mode: 'dropResponse', label: 'C. Timeout after commit', desc: 'The like is saved but the reply is lost.' },
      { id: 'broker-down', node: 'events', mode: 'down', label: 'D. Event broker down', desc: 'Reactions save; the count waits in the outbox.' },
      { id: 'dup', node: 'events', mode: 'duplicate', label: 'E. Duplicate events', desc: 'Every event is delivered twice.' },
      { id: 'lag', node: 'counter', mode: 'paused', label: 'F. Counter consumer paused', desc: 'Events pile up; the count goes stale.' },
      { id: 'reorder', node: 'gateway', mode: 'reorder', label: 'G. Requests arrive out of order', desc: 'The first of two quick requests is delayed 600 ms.' },
    ],
    switches: Y.switches([
      ['optimistic', 'Optimistic UI', 'Flip the button immediately and roll back on failure. Off: wait for the server.'],
      ['desired', 'Idempotent desired state', 'Send “liked = true/false”. Off: a toggle API, where a retry flips the like back.'],
      ['versioned', 'Ignore out-of-date requests', 'Apply a request only if its sequence number is newer than the last applied.'],
      ['dedupe', 'Counter skips duplicate events', 'Off: a redelivered event is counted twice.'],
      ['aggregate', 'Aggregate deltas before writing', 'The consumer reads events in batches and writes one summed update. Off: one counter-row update per like.'],
    ]),
    presets: Y.presets({ optimistic: true, desired: true, versioned: true, dedupe: true, aggregate: false }, [
      { id: 'like', label: 'Like a video', desc: 'Optimistic UI, commit, outbox, counter, refreshed count.', run: (s) => startSet(s, true) },
      { id: 'A', label: 'A. Like service unavailable', desc: 'Three bounded attempts fail; the optimistic like rolls back.', run: (s) => { s.inject('likesvc', 'down'); startSet(s, true); } },
      { id: 'B', label: 'B. Database unavailable', desc: 'Nothing is durable, so the button must not stay liked.', run: (s) => { s.inject('likedb', 'down'); startSet(s, true); } },
      { id: 'C', label: 'C. Timeout after commit', desc: 'The like saves but the reply is lost; the retry repeats the desired state and changes nothing.', run: (s) => { s.inject('likedb', 'dropResponse', true, 900); startSet(s, true); } },
      { id: 'C-bad', label: 'C. Same, with a toggle API', desc: 'The retry toggles again: the user tapped Like once and ends up not liking.', sw: { desired: false }, run: (s) => { s.inject('likedb', 'dropResponse', true, 900); startSet(s, true); } },
      { id: 'D', label: 'D. Broker down', desc: 'The like is saved; the count stays stale until the broker returns.', run: (s) => { s.inject('events', 'down', true, 3000); startSet(s, true); } },
      { id: 'E', label: 'E. Duplicate event, deduplicated', desc: 'Delivered twice, counted once.', run: (s) => { s.inject('events', 'duplicate'); startSet(s, true); } },
      { id: 'E-bad', label: 'E. Duplicate event, no dedupe', desc: 'One like, counted twice.', sw: { dedupe: false }, run: (s) => { s.inject('events', 'duplicate'); startSet(s, true); } },
      { id: 'F', label: 'F. Consumer lag', desc: 'The consumer pauses for 3 s while likes keep saving.', run: (s) => { s.inject('counter', 'paused', true, 3000); s.do('crowd', { rate: 6, ms: 2500 }); startSet(s, true); } },
      { id: 'G', label: 'G. Like then unlike, reordered', desc: 'The unlike arrives first; the late like is recognised as older and ignored.', run: (s) => { s.inject('gateway', 'reorder', true, 2000); startSet(s, true, 'Viewer: like (sent first)'); s.schedule(60, () => startSet(s, false, 'Viewer: unlike (sent second)')); } },
      { id: 'G-bad', label: 'G. Same, no versioning', desc: 'Last arrival wins: the user unliked but the video stays liked.', sw: { versioned: false }, run: (s) => { s.inject('gateway', 'reorder', true, 2000); startSet(s, true, 'Viewer: like (sent first)'); s.schedule(60, () => startSet(s, false, 'Viewer: unlike (sent second)')); } },
      { id: 'H', label: 'H. Celebrity hot key', desc: '120 likes per second on one video. Every like is one update to the same counter row; updates queue and the count falls further behind.', run: (s) => { s.do('crowd', { rate: 120, ms: 4000 }); s.schedule(800, () => startSet(s, true)); } },
      { id: 'H-fix', label: 'H. Hot key, aggregated deltas', desc: 'The consumer sums each batch of likes into one write. The hot row sees a handful of updates per second and the count keeps up.', sw: { aggregate: true }, run: (s) => { s.do('crowd', { rate: 120, ms: 4000 }); s.schedule(800, () => startSet(s, true)); } },
    ]),
    initialState: () => ({
      config: { optimistic: true, desired: true, versioned: true, dedupe: true, aggregate: false },
      rows: {}, count: BASE, seq: { client: 0, event: 0, crowd: 0 }, crowdUntil: 0, crowdRate: 0,
    }),
    initialUI: () => ({ viewer: { liked: false, shownCount: BASE, inflight: 0, ackSeq: 0, message: 'Tap Like.', tone: '' } }),
    actions: {
      like(sim) { startSet(sim, !sim.ui.viewer.liked); },
      crowd(sim, a) { sim.state.crowdRate = a.rate; sim.state.crowdUntil = sim.now + a.ms; sim.note(`${a.rate} other viewers per second start liking this video.`); },
      set: Y.setAction,
    },
    handlers: {
      gateway: {
        react: function* (ctx, p) {
          if (ctx.mode('reorder') && p.seq % 2 === 1 && p.user === 'you') yield ctx.wait(600);
          return ctx.must(yield ctx.call('likesvc', 'react', p, { timeout: 900 }));
        },
        count: function* (ctx) { return ctx.must(yield ctx.call('counts', 'get', {}, { timeout: 600 })); },
      },
      likesvc: { react: function* (ctx, p) { return ctx.must(yield ctx.call('likedb', 'upsert', p, { timeout: 600 })); } },
      likedb: {
        upsert(ctx, p) {
          const st = ctx.state;
          const row = st.rows[p.user] || { liked: false, seq: 0 };
          if (st.config.versioned && p.seq < row.seq) return { liked: row.liked, changed: false, stale: true };
          const next = st.config.desired ? p.liked : !row.liked;
          const changed = next !== row.liked;
          st.rows[p.user] = { liked: next, seq: Math.max(row.seq, p.seq) };
          if (changed) {
            const eventId = 'e' + ++st.seq.event;
            ctx.sim.enqueue('outbox', { type: 'reaction', eventId, payload: { delta: next ? 1 : -1 }, actionId: ctx.actionId });
          }
          ctx.ledger('committed', 'yes', changed ? `Row is now liked = ${next}, with its event in the outbox.` : 'Row already in that state.');
          return { liked: next, changed };
        },
      },
      counts: {
        apply(ctx, p) { ctx.state.count += p.delta; return { count: ctx.state.count }; },
        get(ctx) { return { count: ctx.state.count }; },
      },
    },
    setup(sim) {
      Y.relay(sim, 'outbox', 'relay', 'events', 'reactions');
      sim.spawn(function* (ctx) {
        for (;;) {
          const st = ctx.state;
          const { msgs } = yield ctx.take('reactions', 'counter', st.config.aggregate ? 200 : 1);
          st.applied = st.applied || {};
          let delta = 0;
          const fresh = [];
          for (const m of msgs) {
            if (st.config.dedupe && st.applied[m.eventId]) { st.dupSkipped = (st.dupSkipped || 0) + 1; ctx.log({ op: `duplicate ${m.eventId} skipped`, status: 'dup', actionId: m.actionId, detail: 'Already applied; the count is unchanged.' }); continue; }
            delta += m.payload.delta;
            fresh.push(m);
          }
          if (fresh.length) {
            const r = yield ctx.call('counts', 'apply', { delta }, { timeout: 3000, quiet: true });
            if (!r.ok) { ctx.nack('reactions', 'counter'); yield ctx.wait(300); continue; }
            for (const m of fresh) { st.applied[m.eventId] = true; ctx.sim.setLedger(m.actionId, 'async', 'yes', 'The count read model includes this reaction.'); }
            if (msgs.length > 1) ctx.log({ op: `applied ${fresh.length} events as one update`, status: 'ok', detail: `Summed delta ${delta >= 0 ? '+' : ''}${delta} written to the counter row in a single update.` });
          }
          ctx.ack('reactions', 'counter');
        }
      }, { self: 'counter' });
      Y.load(sim, 'crowd', (s) => (s.now < s.state.crowdUntil ? s.state.crowdRate : 0), function* (ctx, n) {
        const st = ctx.state;
        yield ctx.call('gateway', 'react', { user: 'c' + ++st.seq.crowd, liked: true, seq: 1 }, { timeout: 1500, quiet: 'all' });
      });
    },
    consistency(sim) {
      const st = sim.state;
      const truth = BASE + Object.values(st.rows).filter((r) => r.liked).length;
      const u = sim.ui.viewer;
      const mine = st.rows.you ? st.rows.you.liked : false;
      if (st.count > truth) return { key: 'wrong', label: `The count shows ${st.count.toLocaleString('en-US')} but only ${truth.toLocaleString('en-US')} users like the video: an event was counted twice.` };
      const settled = u.inflight === 0 && sim.queueStats('outbox').depth + sim.queueStats('reactions').depth === 0;
      const last = sim.ledger.filter((e) => e.label.startsWith('Viewer')).slice(-1)[0];
      if (settled && last && last.layers.displayed === 'yes' && st.intent !== undefined && mine !== st.intent) {
        return { key: 'wrong', label: `Your last tap asked for “${st.intent ? 'liked' : 'not liked'}”, but the database says ${mine ? 'liked' : 'not liked'}.` };
      }
      if (u.inflight === 0 && u.liked !== mine) return { key: 'wrong', label: `The button shows ${u.liked ? 'liked' : 'not liked'}, but the database says ${mine ? 'liked' : 'not liked'}.` };
      if (st.count < truth) return { key: 'stale', label: `The count is ${Y.num(truth - st.count)} behind the reactions table.` };
      return { key: 'ok', label: 'Button, reactions table, and count agree.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const truth = BASE + Object.values(st.rows).filter((r) => r.liked).length;
      const w = sim.queueWait('counts');
      return [
        { label: 'Likes in the table', value: Y.num(truth) },
        { label: 'Displayed count', value: Y.num(st.count), tone: st.count > truth ? 'fail' : st.count < truth ? 'warn' : 'ok' },
        { label: 'Counter row queue', value: SDL.fmtMs(w), tone: w > 500 ? 'fail' : w > 100 ? 'warn' : 'ok' },
        { label: 'Events waiting for the counter', value: sim.queueStats('reactions').depth, tone: sim.queueStats('reactions').depth > 20 ? 'fail' : '' },
        { label: 'Duplicates skipped', value: st.dupSkipped || 0 },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['viewer', 'Your phone']], { note: 'The like button follows the switches you choose: optimistic or pessimistic, desired state or toggle.' }); },
      render(el, sim) {
        const u = sim.ui.viewer;
        const body = `${Y.video('Building a Raft cluster in 10 minutes', 'Distributed Daily', '1.2M views', 210)}
          <div class="yt-actions"><button class="yt-like${u.liked ? ' is-on' : ''}" data-act="like" aria-pressed="${u.liked}">${u.inflight ? '<span class="spinner"></span>' : '👍'} <span data-live="count"></span></button><span class="app-sub">${u.liked ? 'You liked this' : 'Tap to like'}</span></div>
          ${Y.msg(u.message, u.tone)}`;
        Y.paint(el, sim, 'viewer', { head: '<div><p class="app-title">YouTube</p></div>', body }, { count: u.shownCount.toLocaleString('en-US') });
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
