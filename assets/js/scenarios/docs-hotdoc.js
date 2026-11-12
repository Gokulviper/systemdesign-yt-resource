/*
 * A viral document.
 * One editor, thousands of viewers. Every operation must reach every viewer,
 * and the single sequencer must not be the one doing it: fan-out moves to
 * broadcast workers so the editor’s acknowledgement stays fast. Late joiners
 * read a cached snapshot instead of replaying the log. Slow viewers get a
 * bounded buffer and a resync, not unbounded memory. A scripted typist is
 * rate limited before it can saturate the sequencer.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const OT = Y.ot;

  const DOC0 = 'Q3 plan: ship the editor.';
  const WORDS = [' Hire two.', ' Launch in May.', ' Budget: flat.', ' Review Friday.'];
  const PUSH_US = 40; // microseconds of gateway work per viewer push
  const BUFFER_LIMIT = 6; // operations a slow viewer may fall behind before being resynced

  function startType(sim, who) {
    const st = sim.state;
    const u = sim.ui.ana;
    const word = who === 'bot' ? ' x' : WORDS[u.typed++ % WORDS.length];
    const op = { pos: who === 'bot' ? 0 : u.text.length, ins: word };
    const run = function* (ctx) {
      if (who === 'ana') { u.text = OT.apply(u.text, op); u.pending = (u.pending || 0) + 1; }
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      const t0 = ctx.now();
      const r = yield ctx.call('gw', 'submit', { clientId: `${who}-${++st.seq.client}`, baseRev: who === 'ana' ? u.rev : st.doc.rev, op, who }, { timeout: 6000, quiet: who === 'bot' ? 'all' : false });
      if (who === 'ana') { ctx.recordOutcome(r.ok, r.latency); u.pending--; st.ackMs.push(ctx.now() - t0); if (st.ackMs.length > 50) st.ackMs.shift(); }
      if (r.ok) { if (who === 'ana') { u.rev = Math.max(u.rev, r.value.rev); u.lastAck = ctx.now() - t0; Y.L(ctx, { accepted: ['yes', `Revision ${r.value.rev} in ${SDL.fmtMs(u.lastAck)}.`], committed: 'yes', async: ['pending', `Fan-out to ${st.viewers} viewers.`] }); ctx.explain(`Acknowledged in ${SDL.fmtMs(u.lastAck)}. ${st.config.fanWorkers ? 'The sequencer handed the operation to the broadcast workers and answered at once.' : `The sequencer pushed it to all ${st.viewers} viewers itself before answering: ${SDL.fmtMs(st.viewers * PUSH_US / 1000)} of pushing inside the critical section.`}`); } }
      else if (who === 'ana') { u.text = OT.apply(u.text, { pos: op.pos, del: op.ins.length }); Y.L(ctx, { accepted: ['no', r.error.message], committed: 'no', async: 'n/a' }); ctx.explain(`Not saved: ${r.error.message}`); }
      else if (r.error.code === 'RATE_LIMITED') st.stats.limited++;
    };
    if (who === 'ana') sim.startAction(`Ana: type “${word.trim()}”`, run, { self: 'ana' });
    else sim.spawn(run, { self: 'bot', quiet: 'all' });
  }

  function* fanOut(ctx, row) {
    const st = ctx.state;
    // Pushing to N sockets costs the gateway N × PUSH_US; slow viewers queue instead.
    const fast = Math.round(st.viewers * (1 - st.slowShare));
    const slow = st.viewers - fast;
    yield ctx.call('gw', 'pushAll', { rev: row.rev, n: fast }, { timeout: 8000, quiet: true });
    st.stats.pushes += fast;
    if (slow) {
      st.slowBacklog += 1; // every slow viewer falls one more operation behind
      if (st.config.backpressure && st.slowBacklog > BUFFER_LIMIT) {
        st.stats.resyncs += slow; st.slowBacklog = 0; st.stats.bufferedOps = 0;
        ctx.log({ op: `${slow} slow viewers resynced`, status: 'note', detail: `Their per-connection buffers passed ${BUFFER_LIMIT} operations, so the gateway dropped the backlog and sent them a fresh snapshot instead of holding memory for them.` });
      } else {
        st.stats.bufferedOps = st.slowBacklog * slow;
        if (!st.config.backpressure && st.stats.bufferedOps > 20000) { ctx.log({ op: 'gateway memory exhausted by slow-viewer buffers', status: 'err', detail: `${st.stats.bufferedOps.toLocaleString('en-US')} buffered operations. The gateway stalls for everyone, fast viewers and the editor included.` }); st.stalled = true; }
      }
    }
    st.stats.delivered = Math.max(st.stats.delivered, row.rev);
  }

  function* joinFlow(ctx) {
    const st = ctx.state;
    const t0 = ctx.now();
    const r = yield ctx.call('gw', 'open', {}, { timeout: 3000, quiet: 'all' });
    st.stats.joins++;
    if (r.ok) { st.viewers++; st.joinMs.push(ctx.now() - t0); if (st.joinMs.length > 200) st.joinMs.shift(); }
    else st.stats.joinFails++;
  }

  SDL.scenarios['docs-hotdoc'] = {
    id: 'docs-hotdoc',
    seed: 808,
    productWidth: 640,
    intro: 'Set the viewer count to 10,000, type, and watch Ana’s acknowledgement time. Move fan-out to the workers. Then send a late-joiner spike, make a share of the viewers slow, and unleash the bot.',
    modeLabels: {},
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'ana', label: 'Ana’s phone', sub: 'The editor', kind: 'client', x: 90, y: 100, latency: 1, role: 'The only human typing. Her acknowledgement time is the number to watch.', owns: ['Local copy'] },
        { id: 'viewers', label: 'Viewers', sub: 'Thousands of sockets', kind: 'client', x: 90, y: 300, latency: 1, role: 'Read-only sockets on the same document. Some may be on slow connections.', owns: ['Their copies'] },
        { id: 'bot', label: 'Scripted typist', sub: 'Abuse', kind: 'client', x: 90, y: 480, latency: 1, role: 'A script submitting operations as fast as it can.', owns: ['Nothing'] },
        { id: 'gw', label: 'Gateway', sub: 'Pushes to sockets', kind: 'gateway', x: 330, y: 300, latency: 2, serviceMs: 0.5, servers: 8, role: `Writes to sockets. Each push costs about ${PUSH_US} µs; ten thousand viewers are a quarter of a second of work per operation. Buffers for slow sockets live here.`, ops: [{ name: 'submit', desc: 'An operation.' }, { name: 'open', desc: 'A viewer joins.' }, { name: 'pushAll', desc: 'Push one operation to many sockets.' }], owns: ['Sockets', 'Per-socket buffers'] },
        { id: 'limiter', label: 'Rate limiter', sub: 'Per editor', kind: 'service', x: 560, y: 120, latency: 1, role: 'Allows at most 5 operations a second per editor; beyond that, refuses cheaply before the sequencer is touched.', ops: [{ name: 'allow', desc: 'Token bucket check.' }], owns: ['Buckets'] },
        { id: 'session', label: 'Document session', sub: 'The one sequencer', kind: 'service', x: 560, y: 300, latency: 3, serviceMs: 4, role: 'Orders every operation on this document. Whatever it does per operation, it does alone: it cannot be scaled out.', ops: [{ name: 'submit', desc: 'Commit.' }, { name: 'open', desc: 'Snapshot for a joiner.' }], owns: ['Head revision'] },
        { id: 'fanout', label: 'Broadcast workers', sub: '4 workers', kind: 'worker', x: 800, y: 460, latency: 2, role: 'Take committed operations from the channel and do the pushing, so the sequencer does not.', owns: ['Nothing durable'] },
        { id: 'snapcache', label: 'Snapshot cache', sub: 'Current text', kind: 'cache', x: 800, y: 120, latency: 2, role: 'The current text, refreshed on every commit. Late joiners read it instead of the log.', ops: [{ name: 'get', desc: 'Current text.' }, { name: 'set', desc: 'Refresh.' }], owns: ['text, rev'] },
        { id: 'oplog', label: 'Operation log', sub: 'Revisions', kind: 'db', x: 800, y: 300, latency: 6, serviceMs: 6, servers: 2, role: 'Appends every revision; replays the log for joiners when there is no snapshot cache. Replays are expensive.', ops: [{ name: 'append', desc: 'Write.' }, { name: 'replay', desc: 'Rebuild the text.' }], owns: ['log[rev]'] },
        { id: 'pubsub', label: 'Pub/sub', sub: 'Document channel', kind: 'queue', x: 560, y: 470, latency: 3, role: 'Carries committed operations to the broadcast workers.', owns: ['Channel'] },
      ],
      edges: [
        { from: 'ana', to: 'gw', latency: 30 }, { from: 'viewers', to: 'gw', latency: 30 }, { from: 'bot', to: 'gw', latency: 10 },
        { from: 'gw', to: 'limiter', latency: 2 }, { from: 'gw', to: 'session', latency: 3 },
        { from: 'session', to: 'oplog', latency: 4 }, { from: 'session', to: 'snapcache', latency: 3 }, { from: 'session', to: 'pubsub', latency: 3 },
        { from: 'session', to: 'gw', latency: 3, via: [[450, 220]] },
        { from: 'pubsub', to: 'fanout', latency: 3 }, { from: 'fanout', to: 'gw', latency: 3, via: [[800, 540], [330, 540]] },
        { from: 'gw', to: 'snapcache', latency: 3, via: [[450, 60], [800, 60]] }, { from: 'gw', to: 'oplog', latency: 4, via: [[450, 380], [700, 380]] },
      ],
      queues: [{ id: 'bcast', broker: 'pubsub', label: 'Document channel', groups: ['fanout'] }],
    },
    failures: [
      { id: 'session-slow', node: 'session', mode: 'slow', params: { factor: 20 }, label: 'Sequencer slow', desc: 'Every commit takes 20× longer. There is only one of it.' },
      { id: 'cache-down', node: 'snapcache', mode: 'down', label: 'Snapshot cache down', desc: 'Every joiner replays the log.' },
      { id: 'fanout-down', node: 'fanout', mode: 'down', label: 'Broadcast workers down', desc: 'Operations commit but nobody receives them until the workers return.' },
      { id: 'gw-slow', node: 'gw', mode: 'slow', params: { factor: 10 }, label: 'Gateway slow', desc: 'Every push costs ten times more.' },
    ],
    switches: Y.switches([
      ['fanWorkers', 'Fan out through broadcast workers', 'The sequencer publishes once and answers; workers push to every socket. Off: the sequencer pushes to every viewer before acknowledging.'],
      ['snapCache', 'Snapshot cache for late joiners', 'A joiner reads the current text from the cache. Off: the log is replayed for each joiner.'],
      ['backpressure', 'Bounded buffers and resync for slow viewers', `A viewer more than ${BUFFER_LIMIT} operations behind is resynced from a snapshot. Off: buffer without limit.`],
      ['rateLimit', 'Rate limit editors', 'At most 5 operations a second per editor. Off: anything goes.'],
    ]),
    presets: Y.presets({ fanWorkers: true, snapCache: true, backpressure: true, rateLimit: true }, [
      { id: 'small', label: '10 viewers', desc: 'A normal document. Fan-out is trivial; Ana’s acknowledgement is a round trip plus a log write.', run: (s) => { setViewers(s, 10); for (let i = 0; i < 3; i++) s.schedule(i * 700, () => startType(s, 'ana')); } },
      { id: 'big-loop', label: '10,000 viewers, sequencer fans out', desc: 'The sequencer pushes to every socket before it answers. Ana waits a quarter of a second per keystroke, and her next operation queues behind the previous fan-out.', sw: { fanWorkers: false }, run: (s) => { setViewers(s, 10000); for (let i = 0; i < 4; i++) s.schedule(i * 300, () => startType(s, 'ana')); } },
      { id: 'big-workers', label: '10,000 viewers, workers fan out', desc: 'The sequencer publishes once and answers. Workers do the pushing in parallel. Ana’s acknowledgement is back to a round trip.', run: (s) => { setViewers(s, 10000); for (let i = 0; i < 4; i++) s.schedule(i * 300, () => startType(s, 'ana')); } },
      { id: 'joiners-nocache', label: 'Late-joiner spike, no snapshot cache', desc: 'Two thousand people open the document in two seconds. Each open replays the log; the log saturates, opens time out, and Ana’s commits wait behind the replays.', sw: { snapCache: false }, run: (s) => { setViewers(s, 500); for (let i = 0; i < 8; i++) s.schedule(i * 200, () => startType(s, 'ana')); s.schedule(500, () => { s.state.joinRate = 1000; }); s.schedule(2500, () => { s.state.joinRate = 0; }); s.schedule(3500, () => startType(s, 'ana')); } },
      { id: 'joiners-cache', label: 'Late-joiner spike, snapshot cache', desc: 'Same spike. Each open is one cache read; the log is untouched and Ana never notices.', run: (s) => { setViewers(s, 500); for (let i = 0; i < 8; i++) s.schedule(i * 200, () => startType(s, 'ana')); s.schedule(500, () => { s.state.joinRate = 1000; }); s.schedule(2500, () => { s.state.joinRate = 0; }); s.schedule(3500, () => startType(s, 'ana')); } },
      { id: 'slow-nobp', label: 'Slow viewers, unbounded buffers', desc: 'A fifth of 10,000 viewers cannot keep up. The gateway buffers everything for them; memory grows with every operation until it stalls for everyone.', sw: { backpressure: false }, run: (s) => { setViewers(s, 10000); s.state.slowShare = 0.2; for (let i = 0; i < 12; i++) s.schedule(i * 350, () => startType(s, 'ana')); } },
      { id: 'slow-bp', label: 'Slow viewers, bounded buffers', desc: `A slow viewer more than ${BUFFER_LIMIT} operations behind is dropped and resynced from a snapshot. Memory stays flat; fast viewers and Ana never feel it.`, run: (s) => { setViewers(s, 10000); s.state.slowShare = 0.2; for (let i = 0; i < 12; i++) s.schedule(i * 350, () => startType(s, 'ana')); } },
      { id: 'bot-nolimit', label: 'Scripted typist, no rate limit', desc: 'A script submits 60 operations a second. The single sequencer saturates and Ana’s keystrokes queue behind the script.', sw: { rateLimit: false }, run: (s) => { setViewers(s, 100); s.state.botRate = 60; for (let i = 0; i < 5; i++) s.schedule(800 + i * 500, () => startType(s, 'ana')); } },
      { id: 'bot-limit', label: 'Scripted typist, rate limited', desc: 'The limiter refuses the script beyond 5 operations a second before the sequencer is touched. Ana is unaffected.', run: (s) => { setViewers(s, 100); s.state.botRate = 60; for (let i = 0; i < 5; i++) s.schedule(800 + i * 500, () => startType(s, 'ana')); } },
    ]),
    initialState: () => ({
      config: { fanWorkers: true, snapCache: true, backpressure: true, rateLimit: true },
      doc: { text: DOC0, rev: 0 }, log: [], busy: false, ticket: 0, serving: 1, viewers: 10, slowShare: 0, slowBacklog: 0, joinRate: 0, botRate: 0, stalled: false,
      cache: { text: DOC0, rev: 0 }, bucket: {}, ackMs: [], joinMs: [], seq: { client: 0 },
      stats: { pushes: 0, delivered: 0, joins: 0, joinFails: 0, resyncs: 0, bufferedOps: 0, limited: 0, botOps: 0, replays: 0 },
    }),
    initialUI: () => ({ ana: { text: DOC0, rev: 0, pending: 0, typed: 0, lastAck: null } }),
    actions: {
      type(sim) { startType(sim, 'ana'); },
      viewers(sim, a) { setViewers(sim, a.n); },
      slow(sim, a) { sim.state.slowShare = a.share; sim.state.slowBacklog = 0; },
      spike(sim) { sim.state.joinRate = 1000; sim.schedule(2000, () => { sim.state.joinRate = 0; }); },
      bot(sim) { sim.state.botRate = sim.state.botRate ? 0 : 60; },
    },
    setup(sim) {
      Y.consumer(sim, 'bcast', 'fanout', 'fanout', function* (ctx, msg) { yield* fanOut(ctx, msg.payload); return true; }, () => false);
      Y.load(sim, 'viewers', (s) => s.state.joinRate, function* (ctx) { yield* joinFlow(ctx); });
      Y.load(sim, 'bot', (s) => s.state.botRate, function* () { startType(sim, 'bot'); });
    },
    handlers: {
      gw: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          if (st.config.rateLimit) { const a = ctx.must(yield ctx.call('limiter', 'allow', { who: p.who }, { timeout: 300, quiet: p.who === 'bot' ? 'all' : true })); if (!a.allowed) ctx.fail('RATE_LIMITED', `${p.who} exceeded 5 operations a second.`); }
          if (p.who === 'bot') st.stats.botOps++;
          return ctx.must(yield ctx.call('session', 'submit', p, { timeout: 5500, quiet: p.who === 'bot' ? 'all' : false }));
        },
        open: function* (ctx) {
          const st = ctx.state;
          if (st.config.snapCache) { const c = yield ctx.call('snapcache', 'get', {}, { timeout: 500, quiet: 'all' }); if (c.ok) return c.value; }
          st.stats.replays++;
          return ctx.must(yield ctx.call('oplog', 'replay', {}, { timeout: 2500, quiet: 'all' }));
        },
        pushAll: function* (ctx, p) {
          const st = ctx.state;
          if (st.stalled) yield ctx.wait(2000);
          yield ctx.wait(Math.round((p.n * PUSH_US) / 1000));
          return { pushed: p.n };
        },
      },
      limiter: {
        allow(ctx, p) {
          const st = ctx.state;
          const b = st.bucket[p.who] || (st.bucket[p.who] = { tokens: 5, t: ctx.now() });
          b.tokens = Math.min(5, b.tokens + ((ctx.now() - b.t) / 1000) * 5); b.t = ctx.now();
          if (b.tokens < 1) return { allowed: false };
          b.tokens -= 1; return { allowed: true };
        },
      },
      session: {
        submit: function* (ctx, p) {
          const st = ctx.state;
          // A fair queue in front of the sequencer: first come, first served, so a flood cannot starve a human.
          const ticket = ++st.ticket;
          while (st.serving !== ticket) yield ctx.wait(2);
          st.busy = true;
          try {
            let op = p.op;
            for (const r of st.log.filter((x) => x.rev > p.baseRev)) op = OT.transform(op, r.op, false);
            const rev = st.doc.rev + 1;
            const row = { rev, op, who: p.who };
            ctx.must(yield ctx.call('oplog', 'append', row, { timeout: 2000, quiet: p.who === 'bot' ? 'all' : true }));
            st.doc.rev = rev; st.doc.text = OT.apply(st.doc.text, op); st.log.push(row);
            if (st.log.length > 400) st.log.shift();
            ctx.spawn(function* (c) { yield c.call('snapcache', 'set', { text: st.doc.text, rev }, { timeout: 300, quiet: 'all' }); }); // outside the critical section
            if (st.config.fanWorkers) ctx.sim.enqueue('bcast', { type: `rev ${rev}`, eventId: `r${rev}`, payload: row, quiet: p.who === 'bot' });
            else yield* fanOut(ctx, row);
            return { rev };
          } finally { st.busy = false; st.serving++; }
        },
      },
      snapcache: { get(ctx) { return ctx.state.cache; }, set(ctx, p) { ctx.state.cache = { text: p.text, rev: p.rev }; return { ok: true }; } },
      oplog: {
        append(ctx, row) { return { rev: row.rev }; },
        replay: function* (ctx) { const st = ctx.state; yield ctx.wait(Math.min(400, st.log.length * 3)); return { text: st.doc.text, rev: st.doc.rev }; },
      },
      fanout: {},
    },
    consistency(sim) {
      const st = sim.state;
      const ack = st.ackMs.length ? st.ackMs.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, st.ackMs.length) : 0;
      if (st.stalled) return { key: 'stale', label: `The gateway holds ${st.stats.bufferedOps.toLocaleString('en-US')} buffered operations for slow viewers and has stalled: fast viewers and Ana are waiting behind memory spent on people who cannot keep up.` };
      const why = st.botRate && !st.config.rateLimit ? 'the sequencer is busy with the script’s operations' : !st.config.fanWorkers ? 'the sequencer pushes to every viewer before it answers' : !st.config.snapCache && st.stats.replays ? 'her log writes wait behind replays for joiners' : 'the editor is paying for the viewers';
      if (ack > 500) return { key: 'stale', label: `Ana’s last acknowledgements averaged ${SDL.fmtMs(ack)}: ${why}.` };
      if (st.stats.joinFails) return { key: 'stale', label: `${st.stats.joinFails} viewers could not open the document: the log is saturated with replays${st.config.snapCache ? '' : ' because there is no snapshot cache'}.` };
      if (sim.ui.ana.pending > 0) return { key: 'stale', label: 'An operation is in flight.' };
      if (st.stats.delivered < st.doc.rev && sim.nodes.fanout.modes.down) return { key: 'stale', label: `Revisions ${st.stats.delivered + 1} to ${st.doc.rev} are committed but no viewer has them: the broadcast workers are down.` };
      return { key: 'ok', label: `${st.viewers.toLocaleString('en-US')} viewers, revision ${st.doc.rev}, Ana’s acknowledgement ${ack ? SDL.fmtMs(ack) : 'n/a'}${st.stats.resyncs ? `, ${st.stats.resyncs.toLocaleString('en-US')} slow viewers resynced instead of buffered` : ''}${st.stats.limited ? `, ${st.stats.limited} scripted operations refused` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const ack = st.ackMs.length ? SDL.percentile(st.ackMs, 50) : null;
      const join = st.joinMs.length ? SDL.percentile(st.joinMs, 50) : null;
      return [
        { label: 'Viewers', value: st.viewers.toLocaleString('en-US') },
        { label: 'Ana’s acknowledgement (p50)', value: ack == null ? 'n/a' : SDL.fmtMs(ack), tone: ack > 500 ? 'fail' : ack > 300 ? 'warn' : 'ok' },
        { label: 'Pushes', value: st.stats.pushes.toLocaleString('en-US') },
        { label: 'Sequencer queue', value: SDL.fmtMs(sim.queueWait('session')), tone: sim.queueWait('session') > 500 ? 'fail' : sim.queueWait('session') > 100 ? 'warn' : '' },
        { label: 'Joins (failed), open p50', value: `${st.stats.joins} (${st.stats.joinFails}), ${join == null ? 'n/a' : SDL.fmtMs(join)}`, tone: st.stats.joinFails ? 'fail' : '' },
        { label: 'Buffered for slow viewers', value: st.stats.bufferedOps.toLocaleString('en-US'), tone: st.stats.bufferedOps > 20000 ? 'fail' : st.stats.bufferedOps > 5000 ? 'warn' : '' },
        { label: 'Slow viewers resynced', value: st.stats.resyncs.toLocaleString('en-US') },
        { label: 'Script ops committed (refused)', value: `${st.stats.botOps} (${st.stats.limited})` },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['ana', 'Ana']], {
          note: 'Ana is the only human typing. The console sets how many viewers hold a socket, how many of them are slow, sends a late-joiner spike, and starts the script.',
          side: `<p class="ops-title">Viewers and load</p>
            <div class="ops-traffic" role="group" aria-label="Viewers">${[10, 1000, 10000].map((n) => `<button class="btn ops-tbtn" data-act="viewers" data-arg='{"n":${n}}' data-n="${n}">${n.toLocaleString('en-US')} viewers</button>`).join('')}</div>
            <div class="ops-traffic" role="group" aria-label="Load">${Y.btn('slow', 'A fifth of viewers slow', { arg: { share: 0.2 }, cls: 'secondary' })}${Y.btn('slow', 'All viewers fast', { arg: { share: 0 }, cls: 'secondary' })}${Y.btn('spike', 'Late-joiner spike', { cls: 'secondary' })}${Y.btn('bot', 'Start or stop the script', { cls: 'secondary' })}</div>
            <div class="ops-shards" data-ref="rows"></div><p class="recon" data-ref="recon"></p>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.ana;
        Y.paint(el, sim, 'ana', {
          head: `<div><p class="app-title">Q3 plan</p><p class="app-sub">${st.viewers.toLocaleString('en-US')} viewing</p></div>`,
          doc: `<div class="app-card doc-page"><p class="doc-text">${esc(u.text.length > 160 ? '…' + u.text.slice(-160) : u.text)}<span class="doc-caret"></span></p><span class="app-sub doc-chip" data-tone="${u.pending ? 'work' : 'ok'}">${u.pending ? 'Saving…' : `Saved · rev ${u.rev}${u.lastAck != null ? ` · ${SDL.fmtMs(u.lastAck)}` : ''}`}</span></div>`,
          keys: `<div class="app-row">${Y.btn('type', `Type “${esc(WORDS[u.typed % WORDS.length].trim())}”`, { cls: 'go' })}</div>`,
        }, {}, null);
        el.querySelectorAll('[data-n]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.n) === st.viewers)));
        const c = sim.scenario.consistency(sim);
        const q = sim.queueWait('session');
        const rows = [
          ['Sequencer queue', `${Math.round(q)} ms`, q > 500 ? 'fail' : q > 100 ? 'warn' : 'ok'],
          ['Slow viewers', `${Math.round(st.slowShare * 100)}% · ${st.stats.bufferedOps.toLocaleString('en-US')} buffered ops`, st.stats.bufferedOps > 20000 ? 'fail' : st.stats.bufferedOps > 5000 ? 'warn' : 'ok'],
          ['Joiners', `${st.joinRate ? `${st.joinRate}/s arriving · ` : ''}${st.stats.joins} joined, ${st.stats.joinFails} failed`, st.stats.joinFails ? 'fail' : 'ok'],
          ['Script', st.botRate ? `${st.botRate} ops/s · ${st.stats.botOps} committed, ${st.stats.limited} refused` : 'off', st.botRate && !st.config.rateLimit ? 'fail' : 'ok'],
        ];
        SDL.ui.paintSections(el.querySelector('[data-ref="rows"]'), { rows: rows.map(([k, v, t]) => `<div class="ops-row" data-tone="${t}"><div class="ops-name"><strong>${k}</strong><span>${esc(v)}</span></div></div>`).join('') }, {});
        const rc = el.querySelector('[data-ref="recon"]');
        const txt = `${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${c.label}`;
        if (rc.textContent !== txt) { rc.textContent = txt; rc.dataset.tone = c.key; }
      },
    },
  };
  function setViewers(sim, n) { sim.state.viewers = n; sim.state.slowBacklog = 0; sim.state.stats.bufferedOps = 0; sim.state.stalled = false; }
})(typeof window !== 'undefined' ? window : globalThis);
