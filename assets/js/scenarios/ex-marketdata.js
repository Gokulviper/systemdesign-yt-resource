/*
 * Market data feed and gap recovery.
 * Every book change gets a sequence number and goes out once, on two multicast
 * feeds, to three very different subscribers: a colocated market maker, a
 * retail broker that conflates for its phones, and a slow retail terminal.
 * Messages are deltas (one price level’s new size), so a missed message leaves
 * a wrong book, not a late one. Subscribers detect gaps by sequence number and
 * recover from the other feed, a retransmit server, or a snapshot.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const CONSUMERS = { quill: 'Quill (colocated)', finch: 'Finch broker', retail: 'Retail terminal' };
  const LEVELS = { bids: [4990, 4980, 4970, 4960, 4950], asks: [5010, 5020, 5030, 5040, 5050] };
  const GRACE_MS = 80; // wait for the other feed before recovering
  const RETRANS_MAX = 50; // bigger gaps go to a snapshot
  const SLOW_MS = 40; // per-message processing cost of the broker when it is slow
  const disp = (c) => (c == null ? '–' : '$' + (c / 100).toFixed(2));
  const clone = (v) => JSON.parse(JSON.stringify(v));

  const freshBook = () => ({ bids: Object.fromEntries(LEVELS.bids.map((p) => [p, 300])), asks: Object.fromEntries(LEVELS.asks.map((p) => [p, 300])) });
  const applyMsg = (book, m) => { if (m.qty === 0) delete book[m.side][m.px]; else book[m.side][m.px] = m.qty; };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const top = (book) => { const bids = Object.keys(book.bids).map(Number), asks = Object.keys(book.asks).map(Number); return { bid: bids.length ? Math.max(...bids) : null, ask: asks.length ? Math.min(...asks) : null }; };

  function setRate(sim, rate) {
    sim.state.rate = rate;
    sim.note(rate ? `The engine produces ${rate} book changes a second.` : 'The book goes quiet.');
  }

  /** A subscriber received one feed message. Never blocks: recovery runs in its own process so the feed keeps flowing. */
  function onMessage(ctx, key, feed, m) {
    const st = ctx.state;
    const c = st.consumers[key];
    c.received++;
    c.lag = ctx.now() - m.t;
    if (m.seq <= c.seq) { c.dupes++; return; } // the other feed got there first: feed arbitrage
    if (!st.config.seqCheck) {
      // No gap detection: apply whatever arrives, in whatever order.
      if (m.seq !== c.seq + 1) { c.gaps++; c.unchecked++; ctx.log({ op: `${CONSUMERS[key]}: applied #${m.seq} after #${c.seq}`, status: 'warn', detail: m.seq < c.seq + 1 ? 'An older message applied over a newer one.' : `${m.seq - c.seq - 1} message${m.seq - c.seq - 1 === 1 ? '' : 's'} missing and nobody noticed. The book is now wrong.` }); }
      applyMsg(c.book, m); c.seq = Math.max(c.seq, m.seq); c.applied++;
      return;
    }
    if (m.seq === c.seq + 1) { applyMsg(c.book, m); c.seq = m.seq; c.applied++; drain(c); return; }
    c.buffer[m.seq] = m;
    if (c.recovering) return;
    c.recovering = true;
    c.gaps++;
    ctx.log({ op: `${CONSUMERS[key]}: gap at #${c.seq + 1}`, status: 'warn', detail: `Expected #${c.seq + 1} on feed ${feed}, received #${m.seq}. Waiting ${GRACE_MS} ms for the other feed before recovering.` });
    ctx.spawn(function* (cx) { yield* recover(cx, key, feed); });
  }
  function* recover(ctx, key, feed) {
    const st = ctx.state;
    const c = st.consumers[key];
    yield ctx.wait(GRACE_MS);
    drain(c);
    if (!Object.keys(c.buffer).length) {
      c.recovering = false; st.stats.arbFilled++;
      ctx.log({ op: `${CONSUMERS[key]}: gap closed without recovery`, status: 'ok', detail: st.config.dualFeed ? `Feed ${feed === 'A' ? 'B' : 'A'} delivered the missing message.` : 'The missing message arrived late: packets were reordered, not lost.' });
      return;
    }
    const first = Math.min(...Object.keys(c.buffer).map(Number));
    const gapSize = first - c.seq - 1;
    let done = false;
    if (st.config.retransmit && gapSize <= RETRANS_MAX) {
      const r = yield ctx.call('retrans', 'get', { from: c.seq + 1, to: first - 1, who: key }, { timeout: 600 });
      if (r.ok) { for (const x of r.value.msgs) if (x.seq === c.seq + 1) { applyMsg(c.book, x); c.seq = x.seq; c.applied++; } st.stats.retransmits++; done = c.seq >= first - 1; ctx.log({ op: `${CONSUMERS[key]}: retransmit of #${first - gapSize}–#${first - 1}`, status: 'ok', detail: `${r.value.msgs.length} message${r.value.msgs.length === 1 ? '' : 's'} replayed from the publisher’s log over unicast.` }); }
      else ctx.log({ op: `${CONSUMERS[key]}: retransmit failed`, status: 'err', detail: `${r.error.message} Falling back to a snapshot.` });
    }
    if (!done) {
      const sn = yield ctx.call('snapshot', 'get', { who: key }, { timeout: 1500 });
      if (sn.ok) { c.book = clone(sn.value.book); c.seq = sn.value.seq; for (const k of Object.keys(c.buffer)) if (Number(k) <= c.seq) delete c.buffer[k]; c.applied++; st.stats.snapshots++; ctx.log({ op: `${CONSUMERS[key]}: snapshot at #${sn.value.seq}`, status: 'ok', detail: `The whole book replaced from the snapshot server${gapSize > RETRANS_MAX ? ` (a gap of ${gapSize} is too big to retransmit)` : ''}.` }); }
      else { ctx.log({ op: `${CONSUMERS[key]}: snapshot failed`, status: 'err', detail: sn.error.message }); c.recovering = false; return; }
    }
    drain(c);
    c.recovered++;
    if (Object.keys(c.buffer).length) { ctx.spawn(function* (cx) { yield* recover(cx, key, feed); }); return; } // another gap behind this one
    c.recovering = false;
  }
  function drain(c) { while (c.buffer[c.seq + 1]) { const m = c.buffer[c.seq + 1]; delete c.buffer[c.seq + 1]; applyMsg(c.book, m); c.seq = m.seq; c.applied++; } }

  const sc = (SDL.scenarios['ex-marketdata'] = {
    id: 'ex-marketdata',
    seed: 77,
    productWidth: 620,
    minHopMs: 5,
    intro: 'Start traffic and watch three subscribers follow the book from two feeds. Drop packets on one feed, then on both; take the retransmit server away; slow the broker down with and without conflation.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'engine', label: 'Matching engine', kind: 'worker', sub: 'Source of book changes', x: 90, y: 300, latency: 1, role: 'Every fill, rest, and cancel changes one price level. Each change gets the next sequence number.', owns: ['The book', 'the change log'] },
        { id: 'mdpub', label: 'Feed publisher', kind: 'service', sub: 'One message, two feeds', x: 300, y: 300, latency: 1, role: 'Encodes each change and sends it once on feed A and once on feed B.', ops: [{ name: 'publish', desc: 'Send a change on both feeds.' }], owns: ['Nothing durable'] },
        { id: 'feedA', label: 'Feed A', kind: 'queue', sub: 'Multicast group A', x: 520, y: 170, latency: 1, queue: 'A', role: 'UDP multicast: one copy of each message reaches every subscriber at once. Packets can be lost or reordered; nothing is retransmitted by the network.', ops: [], owns: ['In-flight packets'] },
        { id: 'feedB', label: 'Feed B', kind: 'queue', sub: 'Multicast group B', x: 520, y: 430, latency: 1, queue: 'B', role: 'The same messages on a second network path. Subscribers take whichever copy arrives first.', ops: [], owns: ['In-flight packets'] },
        { id: 'quill', label: 'Quill (colocated)', kind: 'client', sub: 'Market maker, 5 µs away', x: 780, y: 110, latency: 1, role: 'Fast subscriber in the same data centre.', owns: ['Its copy of the book'] },
        { id: 'finch', label: 'Finch broker', kind: 'service', sub: 'Feed handler, conflation', x: 780, y: 300, latency: 1, role: 'Consumes the feed for thousands of retail customers and pushes a conflated top of book to phones.', owns: ['Its copy of the book'] },
        { id: 'retail', label: 'Retail terminal', kind: 'client', sub: 'Over the internet', x: 780, y: 490, latency: 1, role: 'A slow subscriber far from the exchange.', owns: ['Its copy of the book'] },
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'Finch app', x: 1010, y: 300, latency: 1, role: 'Shows whatever the broker last pushed.', owns: ['What Maya sees'] },
        { id: 'retrans', label: 'Retransmit server', kind: 'service', sub: 'Replays recent messages', x: 1010, y: 110, latency: 3, serviceMs: 2, role: 'Answers “send me #n to #m again” from the publisher’s log. Unicast, so it must not become the normal path.', ops: [{ name: 'get', desc: 'Replay a range.' }], owns: ['Recent messages'] },
        { id: 'snapshot', label: 'Snapshot server', kind: 'cache', sub: 'Whole book on request', x: 1010, y: 490, latency: 8, serviceMs: 8, role: 'Hands out the full book with its sequence number for subscribers that are too far behind to replay.', ops: [{ name: 'get', desc: 'Current book and sequence number.' }], owns: ['Book snapshots'] },
      ],
      edges: [
        { from: 'engine', to: 'mdpub', latency: 1 },
        { from: 'mdpub', to: 'feedA', latency: 1 },
        { from: 'mdpub', to: 'feedB', latency: 1 },
        { from: 'feedA', to: 'quill', latency: 1 },
        { from: 'feedA', to: 'finch', latency: 2 },
        { from: 'feedA', to: 'retail', latency: 30, label: 'internet' },
        { from: 'feedB', to: 'quill', latency: 12 },
        { from: 'feedB', to: 'finch', latency: 12 },
        { from: 'feedB', to: 'retail', latency: 40 },
        { from: 'finch', to: 'maya', latency: 40, label: 'push' },
        { from: 'quill', to: 'retrans', latency: 1 },
        { from: 'finch', to: 'retrans', latency: 2 },
        { from: 'retail', to: 'retrans', latency: 30, via: [[900, 490], [900, 110]] },
        { from: 'quill', to: 'snapshot', latency: 1, via: [[920, 110], [920, 490]] },
        { from: 'finch', to: 'snapshot', latency: 2 },
        { from: 'retail', to: 'snapshot', latency: 30 },
      ],
      queues: [
        { id: 'A', broker: 'feedA', label: 'feed A', groups: ['quill', 'finch', 'retail'] },
        { id: 'B', broker: 'feedB', label: 'feed B', groups: ['quill', 'finch', 'retail'] },
      ],
    },
    modeLabels: { loss: 'Dropping packets', reorder: 'Reordering packets' },
    failures: [
      { id: 'lossA', node: 'feedA', mode: 'loss', params: { every: 5 }, label: 'Feed A drops every 5th packet', desc: 'Subscribers on A alone see gaps.' },
      { id: 'lossB', node: 'feedB', mode: 'loss', params: { every: 5 }, label: 'Feed B drops every 5th packet', desc: 'With A dropping the same ones, nobody gets them.' },
      { id: 'reorderA', node: 'feedA', mode: 'reorder', label: 'Feed A reorders packets', desc: 'Pairs of messages swap places.' },
      { id: 'retrans-down', node: 'retrans', mode: 'down', label: 'Retransmit server down', desc: 'Gaps must be healed from a snapshot.' },
      { id: 'snapshot-slow', node: 'snapshot', mode: 'slow', params: { factor: 20 }, label: 'Snapshot server slow', desc: 'Recovery takes seconds.' },
      { id: 'finch-slow', node: 'finch', mode: 'slow', label: 'Broker feed handler slow', desc: `${SLOW_MS} ms per message: it falls behind unless it conflates.` },
      { id: 'mdpub-down', node: 'mdpub', mode: 'down', label: 'Publisher down', desc: 'The book moves; nobody is told.' },
      { id: 'retail-paused', node: 'retail', mode: 'paused', label: 'Retail terminal stalls', desc: 'Its backlog grows; it catches up later.' },
    ],
    switches: Y.switches([
      ['dualFeed', 'Listen to both feeds', 'A subscriber takes each message from whichever feed delivers it first and ignores the second copy. Off: feed A only.'],
      ['seqCheck', 'Gap detection by sequence number', 'A subscriber applies #n only after #n−1 and recovers anything missing. Off: apply whatever arrives.'],
      ['retransmit', 'Retransmit before snapshot', `Small gaps (up to ${RETRANS_MAX} messages) are replayed from the retransmit server; bigger ones take a snapshot. Off: every gap takes a snapshot.`],
      ['conflate', 'Broker conflates for phones', 'The broker drains its backlog in one batch and pushes only the latest top of book. Off: one push per message.'],
    ]),
    presets: Y.presets({ dualFeed: true, seqCheck: true, retransmit: true, conflate: true }, [
      { id: 'normal', label: 'Three subscribers, one book', desc: 'Twenty changes a second. All three copies match the engine; the colocated subscriber sees each change about 30 ms before the retail terminal.', run: (s) => { setRate(s, 20); s.schedule(6000, () => setRate(s, 0)); } },
      { id: 'loss-a', label: 'Packets lost on one feed', desc: 'Feed A drops every fifth message during a 200-a-second burst. Subscribers notice each gap and feed B fills it within the grace period; nobody asks for a retransmit.', run: (s) => { s.inject('feedA', 'loss', { every: 5 }); setRate(s, 200); s.schedule(4000, () => setRate(s, 0)); } },
      { id: 'loss-both', label: 'Packets lost on both feeds', desc: 'Both feeds drop the same messages. Subscribers detect the gap, wait for the other feed, then ask the retransmit server for the missing range.', run: (s) => { s.inject('feedA', 'loss', { every: 5 }); s.inject('feedB', 'loss', { every: 5 }); setRate(s, 20); s.schedule(6000, () => setRate(s, 0)); } },
      { id: 'loss-snapshot', label: 'Lost on both feeds, retransmit down', desc: 'The retransmit request fails, so each subscriber replaces its whole book from the snapshot server.', run: (s) => { s.inject('feedA', 'loss', { every: 5 }); s.inject('feedB', 'loss', { every: 5 }); s.inject('retrans', 'down'); setRate(s, 20); s.schedule(6000, () => setRate(s, 0)); } },
      { id: 'nocheck', label: 'Lost on both feeds, no gap detection', desc: 'Subscribers apply what arrives. A level that was cancelled is still on their screens; a size that changed never did. Three wrong books and nobody knows.', sw: { seqCheck: false }, run: (s) => { s.inject('feedA', 'loss', { every: 5 }); s.inject('feedB', 'loss', { every: 5 }); setRate(s, 20); s.schedule(6000, () => setRate(s, 0)); } },
      { id: 'reorder', label: 'Reordered packets, one feed', desc: 'Feed A swaps pairs of messages and feed B is off. Gap detection holds the early message until its predecessor arrives, so books stay right.', sw: { dualFeed: false }, run: (s) => { s.inject('feedA', 'reorder'); setRate(s, 20); s.schedule(6000, () => setRate(s, 0)); } },
      { id: 'reorder-bad', label: 'Reordered packets, no gap detection', desc: 'The same swaps applied as they arrive: an older size overwrites a newer one and the books end up wrong.', sw: { dualFeed: false, seqCheck: false }, run: (s) => { s.inject('feedA', 'reorder'); setRate(s, 20); s.schedule(6000, () => setRate(s, 0)); } },
      { id: 'slow-broker', label: 'Slow broker, one push per message', desc: `A burst of 200 changes a second hits a broker that needs ${SLOW_MS} ms per message. Its backlog grows for the whole burst and Maya’s price is seconds old.`, sw: { conflate: false }, run: (s) => { s.inject('finch', 'slow'); setRate(s, 200); s.schedule(4000, () => setRate(s, 0)); } },
      { id: 'slow-broker-conflate', label: 'Slow broker, conflated', desc: 'Same burst, same slow handler. It drains the backlog in batches and pushes only the latest top of book, so Maya stays within a few hundred milliseconds of the engine.', run: (s) => { s.inject('finch', 'slow'); setRate(s, 200); s.schedule(4000, () => setRate(s, 0)); } },
      { id: 'pub-down', label: 'Publisher down', desc: 'The engine keeps changing the book; the publisher sends nothing. Every subscriber is frozen on an old book and knows it only by the silence.', run: (s) => { setRate(s, 20); s.schedule(2500, () => s.inject('mdpub', 'down')); s.schedule(6000, () => setRate(s, 0)); } },
      { id: 'restart', label: 'Retail terminal restarts', desc: 'The terminal comes back with an empty book and a gap from zero. Too big to replay, so it takes a snapshot and then applies the live feed from there.', run: (s) => { setRate(s, 20); s.schedule(3500, () => restartRetail(s)); s.schedule(6000, () => setRate(s, 0)); } },
    ]),
    initialState: () => ({
      config: { dualFeed: true, seqCheck: true, retransmit: true, conflate: true },
      truth: { seq: 0, book: freshBook() }, history: {}, rate: 0, hold: null,
      consumers: Object.fromEntries(Object.keys(CONSUMERS).map((k) => [k, { seq: 0, book: freshBook(), buffer: {}, recovering: false, received: 0, applied: 0, dupes: 0, gaps: 0, recovered: 0, unchecked: 0, lag: 0 }])),
      stats: { published: 0, lost: { A: 0, B: 0 }, arbFilled: 0, retransmits: 0, snapshots: 0, pushes: 0, conflated: 0, unpublished: 0 },
    }),
    initialUI: () => ({ maya: { bid: 4990, ask: 5010, seq: 0, at: 0 } }),
    actions: {
      rate(sim, a) { setRate(sim, a.rate || 0); },
      restart(sim) { restartRetail(sim); },
    },
    handlers: {
      mdpub: {
        publish(ctx, m) {
          const st = ctx.state;
          st.stats.published++;
          for (const feed of ['A', 'B']) {
            const node = 'feed' + feed;
            const loss = ctx.mode('loss', node);
            if (loss && m.seq % (loss.every || 5) === 0) { st.stats.lost[feed]++; continue; }
            if (feed === 'A' && ctx.mode('reorder', node)) {
              if (!st.hold) { st.hold = m; continue; }
              ctx.sim.enqueue(feed, { type: 'md', payload: m }); ctx.sim.enqueue(feed, { type: 'md', payload: st.hold }); st.hold = null; continue;
            }
            ctx.sim.enqueue(feed, { type: 'md', payload: m });
          }
          return { seq: m.seq };
        },
      },
      retrans: {
        get(ctx, p) {
          const st = ctx.state;
          if (p.to - p.from + 1 > RETRANS_MAX) ctx.fail('TOO_BIG', `Range of ${p.to - p.from + 1} exceeds the retransmit window.`);
          const msgs = []; for (let s = p.from; s <= p.to; s++) if (st.history[s]) msgs.push(st.history[s]);
          return { msgs };
        },
      },
      snapshot: { get(ctx) { return { seq: ctx.state.truth.seq, book: clone(ctx.state.truth.book) }; } },
      maya: { push(ctx, p) { Object.assign(ctx.ui.maya, p); return { ok: true }; } },
    },
    setup(sim) {
      // The engine: random level changes at the configured rate; each is logged and handed to the publisher.
      Y.load(sim, 'engine', (s) => s.state.rate, function* (ctx) {
        const st = ctx.state;
        const side = ctx.rand() < 0.5 ? 'bids' : 'asks';
        const px = LEVELS[side][Math.floor(ctx.rand() * LEVELS[side].length)];
        const qty = ctx.rand() < 0.12 ? 0 : 100 * (1 + Math.floor(ctx.rand() * 9));
        const m = { seq: ++st.truth.seq, side, px, qty, t: ctx.now() };
        applyMsg(st.truth.book, m);
        st.history[m.seq] = m;
        const r = yield ctx.call('mdpub', 'publish', m, { timeout: 300, quiet: 'all' });
        if (!r.ok) st.stats.unpublished++;
      });
      // Subscribers: one consumer loop per (subscriber, feed).
      for (const key of Object.keys(CONSUMERS)) for (const feed of ['A', 'B']) sim.spawn(function* (ctx) {
        for (;;) {
          const st = ctx.state;
          const { msgs } = yield ctx.take(feed, key, 50);
          if (feed === 'B' && !st.config.dualFeed) { ctx.ack(feed, key); continue; }
          for (const msg of msgs) onMessage(ctx, key, feed, msg.payload);
          if (key === 'finch') {
            // Processing cost per message; conflation pays it once per batch and pushes once.
            const cost = ctx.mode('slow') ? SLOW_MS : 2;
            yield ctx.wait(st.config.conflate ? cost : cost * msgs.length);
            if (st.config.conflate && msgs.length > 1) st.stats.conflated += msgs.length - 1;
            const c = st.consumers.finch;
            const t = top(c.book);
            st.stats.pushes += st.config.conflate ? 1 : msgs.length;
            const push = { bid: t.bid, ask: t.ask, seq: c.seq, at: ctx.now() };
            ctx.spawn(function* (cx) { yield cx.call('maya', 'push', push, { timeout: 300, quiet: 'all' }); });
          }
          ctx.ack(feed, key);
        }
      }, { self: key, quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      for (const [k, c] of Object.entries(st.consumers)) {
        if (c.unchecked) return { key: 'wrong', label: `${CONSUMERS[k]} applied messages out of order or over a gap without noticing. Its book shows ${Object.keys(c.book.bids).length + Object.keys(c.book.asks).length} levels that may not exist. Nobody will tell it.` };
        if (c.seq === st.truth.seq && !c.recovering && !same(c.book, st.truth.book)) return { key: 'wrong', label: `${CONSUMERS[k]} is at #${c.seq} like the engine but its book differs: a wrong book that believes it is current.` };
      }
      for (const [k, c] of Object.entries(st.consumers)) if (c.recovering) return { key: 'stale', label: `${CONSUMERS[k]} found a gap at #${c.seq + 1} and is recovering.` };
      const behind = Object.entries(st.consumers).filter(([, c]) => st.truth.seq - c.seq > 2);
      if (behind.length) return { key: 'stale', label: `${behind.map(([k, c]) => `${CONSUMERS[k]} is ${st.truth.seq - c.seq} behind`).join('; ')}. ${sim.nodes.mdpub.modes.down ? 'The publisher is down: the book moves and no message says so.' : 'Backlog, not loss: the sequence numbers are contiguous.'}` };
      const u = sim.ui.maya;
      if (st.consumers.finch.seq - u.seq > 2) return { key: 'stale', label: `Maya’s phone shows the book at #${u.seq}; the broker is at #${st.consumers.finch.seq}. Pushes are behind.` };
      return { key: 'ok', label: `All three subscribers hold the engine’s book at #${st.truth.seq}; ${st.stats.lost.A + st.stats.lost.B ? `${st.stats.lost.A + st.stats.lost.B} lost packets were recovered` : 'no packet was lost'}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const c = st.consumers;
      const lagOf = (k) => (c[k].received ? SDL.fmtMs(c[k].lag) : '–');
      return [
        { label: 'Book changes', value: st.truth.seq },
        { label: 'Lag Quill / Finch / Retail', value: `${lagOf('quill')} / ${lagOf('finch')} / ${lagOf('retail')}` },
        { label: 'Behind Quill / Finch / Retail', value: `${st.truth.seq - c.quill.seq} / ${st.truth.seq - c.finch.seq} / ${st.truth.seq - c.retail.seq}`, tone: Math.max(st.truth.seq - c.quill.seq, st.truth.seq - c.finch.seq, st.truth.seq - c.retail.seq) > 5 ? 'warn' : '' },
        { label: 'Packets lost A / B', value: `${st.stats.lost.A} / ${st.stats.lost.B}`, tone: st.stats.lost.A + st.stats.lost.B ? 'warn' : '' },
        { label: 'Gaps filled by the other feed', value: st.stats.arbFilled },
        { label: 'Retransmits / snapshots', value: `${st.stats.retransmits} / ${st.stats.snapshots}` },
        { label: 'Messages conflated', value: Y.num(st.stats.conflated) },
        { label: 'Broker backlog', value: sim.queueStats('A').depth, tone: sim.queueStats('A').depth > 20 ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Maya sees what Finch pushes. The console shows all three subscribers against the engine’s book.',
          side: `<p class="ops-title">Subscribers</p><div class="ops-traffic">${Y.btn('rate', 'Normal traffic (20/s)', { arg: { rate: 20 } })}${Y.btn('rate', 'Burst (200/s)', { arg: { rate: 200 }, cls: 'secondary' })}${Y.btn('rate', 'Quiet', { arg: { rate: 0 }, cls: 'secondary' })}${Y.btn('restart', 'Restart retail terminal', { cls: 'secondary' })}</div><div data-ref="subs"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.maya;
        const age = u.at ? sim.now - u.at : null;
        Y.paint(el, sim, 'maya', {
          head: '<div><p class="app-title">Finch</p><p class="app-sub">Maya · ACME</p></div>',
          price: `<div class="app-card ${age != null && age > 1500 ? 'is-fail' : ''}"><span class="app-kv"><strong>ACME</strong><span>feed #${u.seq}</span></span><strong>bid ${disp(u.bid)} × ask ${disp(u.ask)}</strong><span class="app-sub">${age == null ? 'no update yet' : `updated ${SDL.fmtMs(age)} ago`}${st.consumers.finch.seq - u.seq > 2 ? ` · broker is at #${st.consumers.finch.seq}` : ''}</span></div>`,
          depth: `<p class="app-sub">Levels as the broker has them</p>${['asks', 'bids'].map((side) => { const b = st.consumers.finch.book[side]; const pxs = Object.keys(b).map(Number).sort((x, y) => (side === 'asks' ? y - x : y - x)); return pxs.map((p) => `<div class="app-card" style="padding:4px 8px"><span class="app-kv"><span>${side === 'asks' ? 'Ask' : 'Bid'} ${disp(p)}</span><span>${b[p]} sh${st.truth.book[side][p] === undefined ? ' ✕ gone' : st.truth.book[side][p] !== b[p] ? ` (now ${st.truth.book[side][p]})` : ''}</span></span></div>`).join(''); }).join('<hr>')}`,
        }, {});
        const row = (k) => { const c = st.consumers[k]; const eq = same(c.book, st.truth.book); const tone = c.unchecked || (c.seq === st.truth.seq && !eq) ? 'fail' : c.recovering || st.truth.seq - c.seq > 2 ? 'warn' : 'ok'; return `<div class="ops-row" data-tone="${tone}"><div class="ops-name">${esc(CONSUMERS[k])}<span>#${c.seq} of #${st.truth.seq} · book ${eq ? 'matches' : '✕ differs'} · lag ${c.received ? SDL.fmtMs(c.lag) : '–'} · gaps ${c.gaps}${c.recovering ? ' · recovering…' : ''}${c.dupes ? ` · ${c.dupes} dupes ignored` : ''}</span></div></div>`; };
        const cst = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="subs"]'), {
          rows: `<div class="ops-shards">${Object.keys(CONSUMERS).map(row).join('')}</div>`,
          truth: `<p class="app-sub">Engine book #${st.truth.seq}: ${Object.keys(st.truth.book.bids).length} bid levels, ${Object.keys(st.truth.book.asks).length} ask levels · published ${st.stats.published}, lost A ${st.stats.lost.A}, B ${st.stats.lost.B} · feed A backlog ${sim.queueStats('A').depth}</p>`,
          recon: `<p class="recon" data-tone="${cst.key}">${cst.key === 'ok' ? '✓' : cst.key === 'stale' ? '…' : '✕'} ${esc(cst.label)}</p>`,
        }, {});
      },
    },
  });

  function restartRetail(sim) {
    const st = sim.state;
    st.consumers.retail = { seq: 0, book: { bids: {}, asks: {} }, buffer: {}, recovering: false, received: 0, applied: 0, dupes: 0, gaps: 0, recovered: 0, unchecked: 0, lag: 0 };
    sim.note('The retail terminal restarted with an empty book. The next message will show a gap from #0.');
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
