/*
 * Sequencing, determinism, and failover.
 * Two matching cores. The primary stamps each message with the next sequence
 * number, writes it to the journal, applies it to its in-memory book, and
 * acknowledges. The journal feeds the same entries to the standby, which
 * applies them in the same order and so holds the same book. An elector
 * watches heartbeats; when the primary dies it fences the journal at a new
 * epoch and promotes the standby at the next sequence number. Every switch here
 * removes one of those guarantees and shows what it protected.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const B = Y.book;

  const CORES = { primary: 'Core A', standby: 'Core B' };
  const REPLAY_MS = 40; // simulated cost of replaying one journal entry into a cold core (scaled up so it is visible)
  const SNAP_EVERY = 20;
  const BATCH_MS = 400; // ack-first mode: delay before the batched journal write
  const disp = (c) => '$' + (c / 100).toFixed(2);
  const clone = (v) => JSON.parse(JSON.stringify(v));

  function hash(book) {
    let h = 0;
    const s = book.bids.concat(book.asks).map((o) => `${o.id}:${o.px}:${o.remaining}`).join(',');
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /** Apply one sequenced entry to a core's book. Idempotent by sequence number when the switch is on. */
  function applyEntry(st, core, e) {
    if (core.applied[e.seq]) {
      if (st.config.idemSeq) return { dup: true };
      st.stats.dupApplied++;
    }
    core.applied[e.seq] = true;
    const m = e.msg;
    const res = B.match(core.book, { id: m.id, owner: m.owner, side: m.side, px: m.px, qty: m.qty, tif: 'gtc', seq: e.seq }, {});
    core.orders[m.id] = { status: res.status, filled: m.qty - res.remaining };
    for (const f of res.fills) { const mk = core.orders[f.makerId]; if (mk) { mk.filled += f.qty; mk.status = core.book.byId[f.makerId] ? 'partial' : 'filled'; } core.fills++; }
    core.seq = Math.max(core.seq, e.seq);
    return res;
  }

  /** Drain contiguous buffered entries into the book, skipping holes left by failed writes. */
  function drain(st, core) {
    for (;;) {
      const n = core.seq + 1;
      if (core.holes[n]) { core.seq = n; continue; }
      const x = core.pending[n];
      if (!x) return;
      delete core.pending[n];
      core.results[n] = applyEntry(st, core, x);
    }
  }
  /** Buffer an entry and apply everything that is now contiguous: the single thread applies strictly in sequence order. */
  function applyInOrder(st, core, e) { core.pending[e.seq] = e; drain(st, core); }
  const freshCore = (role, epoch) => ({ role, epoch, seq: 0, nextSeq: 0, book: B.create(), orders: {}, applied: {}, pending: {}, holes: {}, results: {}, fills: 0, rebuilding: false });

  function startOrder(sim, o) {
    const st = sim.state;
    sim.startAction(`You: ${o.side} ${o.qty} limit ${disp(o.px)}`, function* (ctx) {
      const u = ctx.ui.me;
      const id = 'me-' + ++st.mySeq;
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'Client order id: a resubmission after a failover is recognised.'] });
      const r = yield* ctx.retry({ attempts: 2, baseMs: 600 }, function* () { return yield ctx.call('gwA', 'newOrder', { id, owner: 'me', side: o.side, px: o.px, qty: o.qty }, { timeout: 2500 }); });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false;
      if (r.ok) {
        const v = r.value;
        u.orders.push({ id, side: o.side, px: o.px, qty: o.qty, seq: v.seq, epoch: v.epoch, core: v.core, status: v.status, filled: v.filled });
        Y.L(ctx, { displayed: 'yes', accepted: ['yes', `Sequence #${v.seq}, epoch ${v.epoch}, acknowledged by ${CORES[v.core]}.`], committed: st.config.journalFirst ? ['yes', 'Journaled before the ack.'] : ['pending', `Journal write batched ${BATCH_MS} ms after the ack.`], async: ['pending', 'Replication to the other core.'] });
        ctx.explain(`${CORES[v.core]} (epoch ${v.epoch}) sequenced the order as #${v.seq}${v.resubmitted ? ` after the gateway was told its first choice was no longer primary` : ''}. ${st.config.journalFirst ? 'The journal entry existed before the ack, and the other core applies the same entry from the journal.' : 'The ack went out first; the journal write follows in a batch.'}`);
      } else {
        u.error = r.error.code === 'UNAVAILABLE' ? 'Exchange unavailable: failover in progress.' : `Failed: ${r.error.message}`;
        Y.failed(ctx, 'The terminal shows an error.');
        ctx.explain(r.error.code === 'UNAVAILABLE' ? 'No core is accepting orders: the primary is gone and the standby is still rebuilding. While a cold core replays the journal, the market is closed.' : `Failed: ${r.error.message}`);
      }
    }, { self: 'me' });
  }

  function startBurst(sim, n) {
    const st = sim.state;
    sim.startAction(`Members: ${n} orders through gateway B`, function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      let ok = 0, failed = 0;
      const procs = [];
      for (let i = 0; i < n; i++) {
        const side = ctx.rand() < 0.5 ? 'buy' : 'sell';
        const px = side === 'buy' ? 4950 + Math.floor(ctx.rand() * 5) * 10 : 5020 + Math.floor(ctx.rand() * 5) * 10;
        const qty = 100 * (1 + Math.floor(ctx.rand() * 5));
        const msg = { id: `m-${++st.memberSeq}`, owner: 'member' + (i % 7), side, px, qty };
        procs.push(ctx.spawn(function* (c) {
          yield c.wait(i * 25);
          const r = yield c.call('gwB', 'newOrder', msg, { timeout: 2500, quiet: true });
          if (r.ok) ok++; else failed++;
        }));
      }
      yield ctx.join(procs);
      Y.L(ctx, { accepted: failed ? ['no', `${failed} rejected`] : 'yes', committed: 'yes', async: 'pending' });
      ctx.log({ op: `${ok} member orders sequenced${failed ? `, ${failed} rejected` : ''}`, status: failed ? 'warn' : 'ok' });
    }, { self: 'members' });
  }

  function setPartition(sim, on) {
    const st = sim.state;
    st.partition = on;
    if (!on && st.leader && st.cores[st.leader].role === 'primary') {
      // The partition heals: the old primary learns it was replaced, gateway A can reach the elector again.
      for (const [k, c] of Object.entries(st.cores)) if (k !== st.leader && c.role !== 'standby') {
        c.role = 'standby'; c.epoch = st.epoch;
        sim.note(`${CORES[k]} reconnects and learns that epoch ${st.epoch} belongs to ${CORES[st.leader]}. It stops acting as primary and rebuilds from the journal as the standby.`);
        sim.spawn(function* (ctx) { yield* rebuildCore(ctx, k, false); }, { self: k, quiet: 'all' });
      }
    }
  }

  /** Rebuild a core's memory from snapshot and journal: used for a cold promotion and for a crashed core rejoining. */
  function* rebuildCore(ctx, key, slow) {
    const st = ctx.state;
    const core = st.cores[key];
    core.rebuilding = true;
    Object.assign(core, { book: B.create(), orders: {}, applied: {}, pending: {}, holes: {}, results: {}, seq: 0, fills: 0 });
    let fromSnapshot = 0;
    if (st.config.snapshots) {
      const s = yield ctx.call('snapshots', 'load', {}, { timeout: 600 });
      if (s.ok && s.value.snap) { const snap = s.value.snap; core.book = clone(snap.book); core.orders = clone(snap.orders); core.seq = snap.seq; for (let i = 1; i <= snap.seq; i++) core.applied[i] = true; fromSnapshot = snap.seq; }
    }
    const r = yield ctx.call('journal', 'read', { from: core.seq }, { timeout: 800 });
    let n = 0;
    if (r.ok) for (const e of r.value.entries) { applyEntry(st, core, e); n++; if (slow) yield ctx.wait(REPLAY_MS); }
    core.nextSeq = core.seq;
    core.rebuilding = false;
    return { n, fromSnapshot };
  }

  const sc = (SDL.scenarios['ex-sequencer'] = {
    id: 'ex-sequencer',
    seed: 4242,
    productWidth: 600,
    intro: 'Send a burst of member orders and your own, then crash Core A. Watch Core B take over at the next sequence number with the same book. Then turn off journal-first, the hot standby, or fencing and crash it again.',
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'me', label: 'Your terminal', kind: 'client', sub: 'Via gateway A', x: 90, y: 110, latency: 1, role: 'Sends your orders through gateway A and shows what was acknowledged.', owns: ['What you see'] },
        { id: 'members', label: 'Other members', kind: 'client', sub: 'Via gateway B', x: 90, y: 400, latency: 1, role: 'Bursts of orders that fill the book.', owns: ['Their orders'] },
        { id: 'gwA', label: 'Gateway A', kind: 'gateway', sub: 'Caches who is primary', x: 310, y: 110, latency: 1, role: 'Routes to the core it believes is primary; asks the elector again when a core refuses.', ops: [{ name: 'newOrder', desc: 'Route to the primary.' }], owns: ['Cached leader'] },
        { id: 'gwB', label: 'Gateway B', kind: 'gateway', sub: 'Caches who is primary', x: 310, y: 400, latency: 1, role: 'Same as gateway A, on the other side of the partition.', ops: [{ name: 'newOrder', desc: 'Route to the primary.' }], owns: ['Cached leader'] },
        { id: 'primary', label: 'Core A', kind: 'worker', sub: 'Matching core, starts as primary', x: 560, y: 110, latency: 1, role: 'Sequences, journals, applies, acknowledges. Its book lives in memory.', ops: [{ name: 'process', desc: 'Sequence and apply one message.' }], owns: ['Book A (memory)'] },
        { id: 'standby', label: 'Core B', kind: 'worker', sub: 'Matching core, starts as standby', x: 560, y: 400, latency: 1, role: 'Applies the same entries from the journal, in the same order, so its book equals the primary’s.', ops: [{ name: 'process', desc: 'Sequence and apply one message.' }], owns: ['Book B (memory)'] },
        { id: 'journal', label: 'Journal', kind: 'store', sub: 'Sequenced log, fenced by epoch', x: 830, y: 255, latency: 4, queue: 'repl', role: 'The durable, ordered truth. Accepts writes only from the current epoch when fencing is on, and streams every entry to both cores.', ops: [{ name: 'append', desc: 'Durable write (fenced).' }, { name: 'read', desc: 'Entries after a sequence number.' }, { name: 'fence', desc: 'Advance the epoch.' }], owns: ['Entries', 'current epoch'] },
        { id: 'snapshots', label: 'Snapshot store', kind: 'store', sub: 'Book every 20 entries', x: 830, y: 450, latency: 6, role: 'Periodic copies of the book so a cold core replays only the tail.', ops: [{ name: 'save', desc: 'Store a snapshot.' }, { name: 'load', desc: 'Latest snapshot.' }], owns: ['Snapshots'] },
        { id: 'elector', label: 'Elector', kind: 'service', sub: 'Heartbeats and epochs', x: 830, y: 60, latency: 1, role: 'Watches heartbeats. On loss it fences the journal at a new epoch and promotes the other core.', ops: [{ name: 'leader', desc: 'Who is primary now.' }], owns: ['Leader, epoch'] },
      ],
      edges: [
        { from: 'me', to: 'gwA', latency: 1 },
        { from: 'members', to: 'gwB', latency: 1 },
        { from: 'gwA', to: 'primary', latency: 1 },
        { from: 'gwA', to: 'standby', latency: 1, via: [[430, 110], [430, 400]] },
        { from: 'gwB', to: 'standby', latency: 1 },
        { from: 'gwB', to: 'primary', latency: 1, via: [[460, 400], [460, 110]] },
        { from: 'gwA', to: 'elector', latency: 1, via: [[310, 30], [830, 30]] },
        { from: 'gwB', to: 'elector', latency: 1, via: [[310, 500], [1000, 500], [1000, 60]] },
        { from: 'primary', to: 'journal', latency: 1, label: 'append' },
        { from: 'standby', to: 'journal', latency: 1, label: 'read' },
        { from: 'journal', to: 'primary', latency: 1 },
        { from: 'journal', to: 'standby', latency: 1 },
        { from: 'primary', to: 'snapshots', latency: 2, via: [[700, 110], [700, 450]] },
        { from: 'standby', to: 'snapshots', latency: 2 },
        { from: 'elector', to: 'journal', latency: 1, label: 'fence' },
        { from: 'elector', to: 'primary', latency: 1, label: 'heartbeat' },
        { from: 'elector', to: 'standby', latency: 1, via: [[1000, 60], [1000, 400]] },
      ],
      queues: [{ id: 'repl', broker: 'journal', label: 'journal stream', groups: ['primary', 'standby'] }],
    },
    modeLabels: { partition: 'Partitioned from core A and gateway A' },
    failures: [
      { id: 'primary-crash', node: 'primary', mode: 'crashed', label: 'Core A crashes', desc: 'Its memory is gone. The elector promotes Core B; Core A rejoins later as a standby rebuilt from the journal.' },
      { id: 'standby-paused', node: 'standby', mode: 'paused', label: 'Core B stops applying', desc: 'The standby falls behind the journal.' },
      { id: 'journal-dup', node: 'journal', mode: 'duplicate', label: 'Journal stream duplicates entries', desc: 'The standby receives some entries twice.' },
      { id: 'journal-slow', node: 'journal', mode: 'slow', params: { factor: 25 }, label: 'Journal slow', desc: 'Every ack waits for the journal.' },
      { id: 'partition', node: 'elector', mode: 'partition', label: 'Partition: elector cannot see Core A or gateway A', desc: 'The elector believes Core A is dead and promotes Core B; Core A keeps running.' },
      { id: 'snapshots-down', node: 'snapshots', mode: 'down', label: 'Snapshot store down', desc: 'A cold rebuild must replay the whole journal.' },
      { id: 'gwA-down', node: 'gwA', mode: 'down', label: 'Gateway A down', desc: 'Your orders cannot enter; members are unaffected.' },
    ],
    switches: Y.switches([
      ['journalFirst', 'Journal before acknowledging', `The primary writes the entry to the journal (which streams it to the standby) before applying and acknowledging. Off: acknowledge first, write ${BATCH_MS} ms later in a batch.`],
      ['hotStandby', 'Hot standby', 'The standby applies every journal entry as it arrives and can take over at once. Off: a cold standby that must replay the journal when promoted.'],
      ['fencing', 'Fence the journal by epoch', 'On failover the journal stops accepting writes from the old epoch, so a primary that is alive but cut off cannot keep acknowledging. Off: trust heartbeats alone.'],
      ['snapshots', 'Snapshots every 20 entries', 'A cold rebuild starts from the last snapshot and replays only the tail. Off: replay from the first entry.'],
      ['idemSeq', 'Apply each sequence number once', 'A core ignores an entry it has already applied. Off: a duplicated entry is applied twice.'],
    ]),
    presets: Y.presets({ journalFirst: true, hotStandby: true, fencing: true, snapshots: true, idemSeq: true }, [
      { id: 'steady', label: 'Two cores, one stream', desc: 'Twenty member orders and yours. Both cores end at the same sequence number with the same book hash.', run: (s) => { startBurst(s, 20); s.schedule(1200, () => startOrder(s, { side: 'buy', px: 5010, qty: 100 })); } },
      { id: 'crash-hot', label: 'Primary crash, hot standby', desc: 'Core A dies after your first order. The elector fences epoch 2 and promotes Core B, which already has every entry. Your second order is sequenced by Core B at the next number.', run: (s) => { startBurst(s, 20); s.schedule(1200, () => startOrder(s, { side: 'buy', px: 5010, qty: 100 })); s.schedule(2000, () => s.inject('primary', 'crashed', true, 2500)); s.schedule(3000, () => startOrder(s, { side: 'sell', px: 5010, qty: 50 })); } },
      { id: 'crash-cold', label: 'Primary crash, cold standby', desc: 'Core B has applied nothing. Promotion means replaying 60 entries first, and while it does the market is closed: your order is rejected.', sw: { hotStandby: false, snapshots: false }, run: (s) => { startBurst(s, 60); s.schedule(2600, () => s.inject('primary', 'crashed', true, 2500)); s.schedule(3200, () => startOrder(s, { side: 'buy', px: 5010, qty: 100 })); } },
      { id: 'crash-snapshot', label: 'Cold standby with snapshots', desc: 'Same crash, but Core B loads the snapshot at entry 60 and replays only the tail. Promotion takes a fraction of the time and your order gets through.', sw: { hotStandby: false }, run: (s) => { startBurst(s, 60); s.schedule(2600, () => s.inject('primary', 'crashed', true, 2500)); s.schedule(3200, () => startOrder(s, { side: 'buy', px: 5010, qty: 100 })); } },
      { id: 'ack-first-crash', label: 'Ack before journal, then crash', desc: 'Your order is acknowledged by Core A, which crashes before the batched journal write. Core B never saw it. After failover the book has no such order: an acknowledged order is lost.', sw: { journalFirst: false }, run: (s) => { startBurst(s, 20); s.schedule(1200, () => startOrder(s, { side: 'buy', px: 5010, qty: 100 })); s.schedule(1500, () => s.inject('primary', 'crashed', true, 2500)); } },
      { id: 'journal-first-crash', label: 'Journal first, then crash', desc: 'Same timing with journal-first on. The entry reached the journal and Core B before the ack, so after failover your order is still in the book.', run: (s) => { startBurst(s, 20); s.schedule(1200, () => startOrder(s, { side: 'buy', px: 5010, qty: 100 })); s.schedule(1500, () => s.inject('primary', 'crashed', true, 2500)); } },
      { id: 'dup', label: 'Duplicated stream, applied once', desc: 'The journal stream delivers entries twice. Core B recognises sequence numbers it has applied and skips them; the hashes still match.', run: (s) => { s.inject('journal', 'duplicate'); startBurst(s, 20); s.schedule(1200, () => startOrder(s, { side: 'buy', px: 5010, qty: 100 })); } },
      { id: 'dup-bad', label: 'Duplicated stream, applied twice', desc: 'Same duplicates with idempotency off: Core B’s book has orders twice and its hash differs from Core A’s. A failover now would change who gets filled.', sw: { idemSeq: false }, run: (s) => { s.inject('journal', 'duplicate'); startBurst(s, 20); s.schedule(1200, () => startOrder(s, { side: 'buy', px: 5010, qty: 100 })); } },
      { id: 'partition', label: 'Partition with fencing', desc: 'The elector loses sight of Core A and promotes Core B at epoch 2. Core A is alive and gateway A still sends your order to it, but the journal refuses epoch 1: your order is resubmitted to Core B.', run: (s) => { startBurst(s, 20); s.schedule(2000, () => s.inject('elector', 'partition', true, 1200)); s.schedule(2600, () => startBurst(s, 10)); s.schedule(3000, () => startOrder(s, { side: 'buy', px: 5010, qty: 100 })); } },
      { id: 'partition-bad', label: 'Partition without fencing', desc: 'Two primaries. Core A acknowledges your order as #21 of epoch 1 while Core B sequences members’ orders as #21 of epoch 2. The journal holds both: split brain.', sw: { fencing: false }, run: (s) => { startBurst(s, 20); s.schedule(2000, () => s.inject('elector', 'partition', true, 1200)); s.schedule(2600, () => startBurst(s, 10)); s.schedule(3000, () => startOrder(s, { side: 'buy', px: 5010, qty: 100 })); } },
      { id: 'lag', label: 'Standby stops applying', desc: 'Core B is paused during a burst. It falls behind the journal; a failover now would need a catch-up first.', run: (s) => { s.inject('standby', 'paused'); startBurst(s, 20); s.schedule(1200, () => startOrder(s, { side: 'buy', px: 5010, qty: 100 })); } },
    ]),
    initialState: () => ({
      config: { journalFirst: true, hotStandby: true, fencing: true, snapshots: true, idemSeq: true },
      cores: { primary: freshCore('primary', 1), standby: freshCore('standby', 1) },
      leader: 'primary', epoch: 1, journalEpoch: 1, failover: false, partition: false,
      gw: { gwA: 'primary', gwB: 'primary' },
      journal: [], snap: null, acked: {}, mySeq: 0, memberSeq: 0,
      stats: { acks: 0, failovers: 0, promotionMs: null, replayed: 0, fromSnapshot: 0, dupSkipped: 0, dupApplied: 0, conflicts: 0, fenced: 0, journalLost: 0, resubmits: 0 },
    }),
    initialUI: () => ({ me: { pending: false, error: '', orders: [] } }),
    actions: {
      order(sim, a) { startOrder(sim, { side: a.side || 'buy', px: a.px || 5010, qty: a.qty || 100 }); },
      burst(sim, a) { startBurst(sim, a.n || 20); },
      crash(sim) { sim.inject(sim.state.leader || 'primary', 'crashed', true, 2500); },
      partition(sim) { sim.inject('elector', 'partition', true, 1200); },
    },
    handlers: {
      gwA: gatewayHandlers('gwA'),
      gwB: gatewayHandlers('gwB'),
      primary: coreHandlers('primary'),
      standby: coreHandlers('standby'),
      journal: {
        append(ctx, p) {
          const st = ctx.state;
          const e = p.entry;
          if (st.config.fencing && e.epoch < st.journalEpoch) { st.stats.fenced++; ctx.fail('FENCED', `Epoch ${e.epoch} is fenced; the journal is at epoch ${st.journalEpoch}.`); }
          const clash = st.journal.find((x) => x.seq === e.seq);
          if (clash) { st.stats.conflicts++; ctx.log({ op: `two entries for #${e.seq}`, status: 'warn', detail: `Epoch ${clash.epoch} and epoch ${e.epoch} both wrote sequence number ${e.seq}. Two cores believe they are primary.` }); }
          st.journal.push(e);
          ctx.sim.enqueue('repl', { type: 'entry', eventId: `e${e.epoch}-${e.seq}`, payload: e });
          return { seq: e.seq };
        },
        read(ctx, p) {
          const seen = {};
          const entries = ctx.state.journal.filter((e) => e.seq > p.from).sort((a, b) => a.seq - b.seq || a.epoch - b.epoch).filter((e) => (seen[e.seq] ? false : (seen[e.seq] = true)));
          return { entries };
        },
        fence(ctx, p) { ctx.state.journalEpoch = p.epoch; return { epoch: p.epoch }; },
      },
      snapshots: {
        save(ctx, p) { ctx.state.snap = { seq: p.seq, book: p.book, orders: p.orders }; return { seq: p.seq }; },
        load(ctx) { return { snap: ctx.state.snap }; },
      },
      elector: { leader(ctx) { return { leader: ctx.state.leader, epoch: ctx.state.epoch }; } },
    },
    setup(sim) {
      for (const key of ['primary', 'standby']) Y.consumer(sim, 'repl', key, key, function* (ctx, msg) {
        const st = ctx.state;
        const core = st.cores[key];
        const e = msg.payload;
        if (core.role !== 'standby' || core.rebuilding || !st.config.hotStandby) return true; // the primary wrote it; a cold standby ignores the stream
        if (core.applied[e.seq] || core.pending[e.seq]) {
          if (st.config.idemSeq) { st.stats.dupSkipped++; ctx.log({ op: `#${e.seq} already applied`, status: 'dup', detail: `${CORES[key]} has applied sequence number ${e.seq}; the duplicate is ignored.` }); return true; }
          applyEntry(st, core, e);
          ctx.log({ op: `#${e.seq} applied again`, status: 'warn', detail: `${CORES[key]} applied sequence number ${e.seq} a second time. Its book now differs from the primary’s.` });
          return true;
        }
        applyInOrder(st, core, e); // entries can arrive out of order; the core applies them strictly by sequence number
        return true;
      }, () => false);
      // The elector: heartbeats every 200 ms; failover on loss.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(200);
          const st = ctx.state;
          if (!st.leader || st.failover) continue;
          const dead = !!ctx.sim.nodes[st.leader].modes.crashed || (st.partition && st.leader === 'primary');
          if (!dead) continue;
          const old = st.leader;
          const next = old === 'primary' ? 'standby' : 'primary';
          st.failover = true; st.leader = null; st.epoch++;
          ctx.log({ op: `${CORES[old]} presumed dead`, status: 'warn', detail: st.partition ? `No heartbeat from ${CORES[old]}. It may still be running on the other side of the partition. Starting epoch ${st.epoch}.` : `No heartbeat from ${CORES[old]}: it crashed. Starting epoch ${st.epoch}.` });
          if (st.config.fencing) yield ctx.call('journal', 'fence', { epoch: st.epoch }, { timeout: 400 });
          const t0 = ctx.now();
          const core = st.cores[next];
          let n = 0, fromSnapshot = 0;
          if (st.config.hotStandby) {
            const r = yield ctx.call('journal', 'read', { from: core.seq }, { timeout: 800 });
            if (r.ok) for (const e of r.value.entries) if (!core.applied[e.seq]) { applyEntry(st, core, e); n++; }
            core.pending = {}; core.nextSeq = core.seq;
          } else {
            const res = yield* rebuildCore(ctx, next, true);
            n = res.n; fromSnapshot = res.fromSnapshot;
          }
          core.role = 'primary'; core.epoch = st.epoch;
          if (!st.partition && st.cores[old].role === 'primary') st.cores[old].role = 'retired';
          st.leader = next; st.gw.gwB = next; if (!st.partition) st.gw.gwA = next;
          st.failover = false; st.stats.failovers++; st.stats.promotionMs = ctx.now() - t0; st.stats.replayed = n; st.stats.fromSnapshot = fromSnapshot;
          ctx.sim.note(`${CORES[next]} promoted at epoch ${st.epoch} after ${ctx.now() - t0} ms${st.config.hotStandby ? ` (hot: ${n} entr${n === 1 ? 'y' : 'ies'} to catch up)` : ` (cold: ${fromSnapshot ? `snapshot at #${fromSnapshot}, ` : ''}${n} entries replayed at ${REPLAY_MS} ms each)`}. Next sequence number: #${core.seq + 1}.`);
        }
      }, { self: 'elector', quiet: 'all' });
    },
    onFailureChange(sim, ch) {
      const st = sim.state;
      if (ch.node === 'elector' && ch.mode === 'partition') setPartition(sim, ch.active);
      if (ch.node === 'primary' && ch.mode === 'crashed' && !ch.active) {
        // Core A restarts with empty memory and rejoins as a standby rebuilt from the journal.
        const core = st.cores.primary;
        if (core.role === 'primary' && st.leader === 'primary') return; // promoted nobody yet; keep going
        core.role = 'standby'; core.epoch = st.epoch;
        sim.spawn(function* (ctx) {
          const r = yield* rebuildCore(ctx, 'primary', false);
          ctx.sim.note(`${CORES.primary} restarted with empty memory and rebuilt its book from the journal (${r.n} entries${r.fromSnapshot ? ` after a snapshot at #${r.fromSnapshot}` : ''}). It is now the standby.`);
        }, { self: 'primary', quiet: 'all' });
      }
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.me;
      const A = st.cores.primary, Bc = st.cores.standby;
      if (st.stats.conflicts) return { key: 'wrong', label: `Split brain: ${st.stats.conflicts} sequence number${st.stats.conflicts === 1 ? '' : 's'} written by two epochs. Two cores acknowledged different orders as the same event.` };
      if (st.leader && !st.failover) {
        const L = st.cores[st.leader];
        for (const [id, a] of Object.entries(st.acked).sort((x, y) => (y[1].owner === 'me') - (x[1].owner === 'me'))) if (!L.orders[id] && !L.rebuilding) return { key: 'wrong', label: `Order ${id} was acknowledged as #${a.seq} by ${CORES[a.core]} but ${CORES[st.leader]}, now primary, has never seen it. An acknowledged order is gone.` };
      }
      const alive = (k) => !sim.nodes[k].modes.crashed && !st.cores[k].rebuilding;
      if (alive('primary') && alive('standby') && A.seq === Bc.seq && A.seq > 0 && hash(A.book) !== hash(Bc.book)) return { key: 'wrong', label: `Both cores are at #${A.seq} but their books differ (${hash(A.book)} vs ${hash(Bc.book)}). The standby applied something the primary did not; a failover would change fills.` };
      if (st.failover || !st.leader) return { key: 'stale', label: `Failover in progress: ${st.config.hotStandby ? 'catching up' : 'replaying the journal into a cold core'}. No orders are accepted.` };
      if (u.pending) return { key: 'stale', label: 'Your order is in flight.' };
      if (u.error) return { key: 'stale', label: `Your order failed: ${u.error}` };
      const L = st.cores[st.leader];
      const S = st.cores[st.leader === 'primary' ? 'standby' : 'primary'];
      const sKey = st.leader === 'primary' ? 'standby' : 'primary';
      if (st.config.hotStandby && alive(sKey) && S.role === 'standby' && S.seq < L.seq) return { key: 'stale', label: `${CORES[sKey]} is ${L.seq - S.seq} entr${L.seq - S.seq === 1 ? 'y' : 'ies'} behind the primary. A failover now would have to catch up first.` };
      if (!alive(sKey)) return { key: 'stale', label: `${CORES[sKey]} is ${sim.nodes[sKey].modes.crashed ? 'down' : 'rebuilding'}: trading continues on ${CORES[st.leader]} with no standby.` };
      return { key: 'ok', label: `${CORES[st.leader]} is primary at epoch ${st.epoch}, both cores are at #${L.seq} with the same book, and every acknowledged order is in it.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const A = st.cores.primary, Bc = st.cores.standby;
      return [
        { label: 'Primary', value: st.leader ? `${CORES[st.leader]}, epoch ${st.epoch}` : 'none', tone: st.leader ? '' : 'fail' },
        { label: 'Core A / Core B sequence', value: `#${A.seq} / #${Bc.seq}`, tone: A.seq !== Bc.seq ? 'warn' : '' },
        { label: 'Books equal', value: hash(A.book) === hash(Bc.book) ? 'yes' : 'no', tone: hash(A.book) === hash(Bc.book) ? 'ok' : 'fail' },
        { label: 'Failovers', value: st.stats.failovers },
        { label: 'Last promotion', value: st.stats.promotionMs == null ? '–' : SDL.fmtMs(st.stats.promotionMs), tone: st.stats.promotionMs > 1000 ? 'fail' : st.stats.promotionMs > 300 ? 'warn' : '' },
        { label: 'Entries replayed', value: st.stats.replayed },
        { label: 'Fenced writes', value: st.stats.fenced },
        { label: 'Duplicates skipped', value: st.stats.dupSkipped, tone: st.stats.dupApplied ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [], {
          note: 'Two matching cores side by side. Send orders, crash the primary, or cut the elector off from Core A, and compare sequence numbers and book hashes.',
          below: `<div class="ops-console"><p class="ops-title">Matching cores</p><div data-ref="cores"></div></div>
            <div class="ops-console"><p class="ops-title">Your terminal (gateway A)</p><div class="ops-traffic">${Y.btn('order', 'Buy 100 @ $50.10', { arg: { side: 'buy', px: 5010, qty: 100 }, cls: 'go' })}${Y.btn('order', 'Sell 50 @ $50.10', { arg: { side: 'sell', px: 5010, qty: 50 }, cls: 'secondary' })}${Y.btn('burst', 'Members: 20 orders', { arg: { n: 20 }, cls: 'secondary' })}${Y.btn('crash', 'Crash the primary')}${Y.btn('partition', 'Partition the elector')}</div><div data-ref="mine"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.me;
        const pane = (k) => {
          const c = st.cores[k];
          const n = sim.nodes[k];
          const state = n.modes.crashed ? 'crashed' : c.rebuilding ? 'rebuilding' : c.role;
          const best = B.best(c.book);
          return `<div class="ops-row" data-tone="${n.modes.crashed ? 'fail' : c.role === 'primary' ? 'ok' : c.role === 'retired' ? 'warn' : ''}"><div class="ops-name">${esc(CORES[k])} · ${esc(state)}${c.role === 'primary' ? ` · epoch ${c.epoch}` : ''}<span>seq #${c.seq} · book ${hash(c.book)} · ${c.book.bids.length + c.book.asks.length} resting · ${best.bid == null ? '–' : disp(best.bid)} × ${best.ask == null ? '–' : disp(best.ask)}${k === 'standby' && !st.config.hotStandby && c.role === 'standby' ? ' · cold' : ''}</span></div></div>`;
        };
        const cst = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="cores"]'), {
          cores: `<div class="ops-shards">${pane('primary')}${pane('standby')}</div>`,
          elector: `<p class="app-sub">Elector: ${st.failover ? 'failover in progress' : st.leader ? `${esc(CORES[st.leader])} is primary` : 'no primary'} · epoch ${st.epoch} · journal ${st.journal.length} entries, fenced at epoch ${st.journalEpoch}${st.partition ? ' · ✕ partitioned from Core A and gateway A' : ''} · gateway A → ${esc(CORES[st.gw.gwA])}, gateway B → ${esc(CORES[st.gw.gwB])}</p>`,
          recon: `<p class="recon" data-tone="${cst.key}">${cst.key === 'ok' ? '✓' : cst.key === 'stale' ? '…' : '✕'} ${esc(cst.label)}</p>`,
        }, {});
        const mine = u.orders.slice(-3).reverse().map((o) => { const L = st.leader && st.cores[st.leader]; const now = L && L.orders[o.id]; return `<div class="app-card ${now ? '' : 'is-fail'}"><span class="app-kv"><strong>${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.qty} @ ${disp(o.px)}</strong><span>#${o.seq} · epoch ${o.epoch}</span></span><span class="app-sub">acked by ${esc(CORES[o.core])} as ${esc(o.status)}${now ? ` · now ${esc(now.status)} on ${esc(CORES[st.leader])}` : L ? ` · ✕ not in ${esc(CORES[st.leader])}’s book` : ''}</span></div>`; }).join('');
        SDL.ui.paintSections(el.querySelector('[data-ref="mine"]'), {
          msg: u.pending ? '<p class="app-sub"><span class="spinner"></span>Sending…</p>' : Y.msg(u.error, 'fail'),
          mine: mine ? `<p class="app-sub">Your orders</p>${mine}` : '<p class="app-sub">No orders yet.</p>',
        }, {});
      },
    },
  });

  function gatewayHandlers(self) {
    return {
      newOrder: function* (ctx, p) {
        const st = ctx.state;
        const refresh = function* () {
          if (self === 'gwA' && st.partition) { ctx.log({ op: 'elector unreachable', status: 'warn', detail: 'Gateway A is on Core A’s side of the partition and cannot ask who is primary.' }); return null; }
          const e = yield ctx.call('elector', 'leader', {}, { timeout: 300 });
          if (!e.ok) return null;
          st.gw[self] = e.value.leader;
          return e.value.leader;
        };
        let leader = st.gw[self];
        if (!leader) leader = yield* refresh();
        if (!leader) ctx.fail('UNAVAILABLE', 'No primary is accepting orders: failover in progress.');
        let r = yield ctx.call(leader, 'process', { msg: p }, { timeout: 900 });
        if (!r.ok && ['UNAVAILABLE', 'NOT_LEADER', 'FENCED'].includes(r.error.code)) {
          ctx.log({ op: `${CORES[leader]} refused: ${r.error.code}`, status: 'warn', detail: `${r.error.message} Asking the elector who is primary now.` });
          const l = yield* refresh();
          if (!l) ctx.fail('UNAVAILABLE', 'No primary is accepting orders: failover in progress.');
          if (l === leader) ctx.must(r);
          st.stats.resubmits++;
          r = yield ctx.call(l, 'process', { msg: p }, { timeout: 900 });
          if (r.ok) r.value.resubmitted = true;
        }
        return ctx.must(r);
      },
    };
  }

  function coreHandlers(key) {
    return {
      process: function* (ctx, p) {
        const st = ctx.state;
        const core = st.cores[key];
        if (core.role !== 'primary' || core.rebuilding) ctx.fail('NOT_LEADER', `${CORES[key]} is not the primary.`);
        const seq = ++core.nextSeq; // assigned synchronously: this is the single-threaded sequencer
        const entry = { seq, epoch: core.epoch, msg: p.msg, t: ctx.now() };
        if (st.config.journalFirst) {
          const w = yield ctx.call('journal', 'append', { entry }, { timeout: 700 });
          if (!w.ok) {
            core.holes[seq] = true; drain(st, core);
            if (w.error.code === 'FENCED') { core.role = 'retired'; ctx.log({ op: 'fenced: stepping down', status: 'warn', detail: `The journal refused epoch ${core.epoch}. ${CORES[key]} learns it is no longer primary and stops acknowledging.` }); }
            ctx.must(w);
          }
        }
        applyInOrder(st, core, entry);
        while (!core.applied[seq]) yield ctx.wait(1); // an earlier sequence number's journal write is still landing
        const res = core.results[seq];
        st.acked[p.msg.id] = { seq, epoch: core.epoch, core: key, owner: p.msg.owner };
        st.stats.acks++;
        if (!st.config.journalFirst) {
          const actionId = ctx.actionId;
          ctx.spawn(function* (c) {
            yield c.wait(BATCH_MS);
            if (c.mode('crashed')) { st.stats.journalLost++; c.log({ op: `journal write #${seq} lost`, status: 'lost', detail: `${CORES[key]} crashed before the batched journal write. The order was acknowledged and never made durable; the other core never sees it.` }); return; }
            const w = yield c.call('journal', 'append', { entry }, { timeout: 700 });
            if (w.ok) c.sim.setLedger(actionId, 'committed', 'yes', `Journal entry #${seq} written ${BATCH_MS} ms after the ack.`);
          }, { actionId });
        }
        if (st.config.snapshots && seq % SNAP_EVERY === 0) { const snap = { seq, book: clone(core.book), orders: clone(core.orders) }; ctx.spawn(function* (c) { yield c.call('snapshots', 'save', snap, { timeout: 800, quiet: true }); }); }
        if (p.msg.owner === 'me') ctx.log({ op: `#${seq} (epoch ${core.epoch}) ${p.msg.side} ${p.msg.qty} @ ${disp(p.msg.px)} → ${res.status}`, status: 'ok', detail: `${CORES[key]} applied it to book ${hash(core.book)}.` });
        return { seq, epoch: core.epoch, core: key, status: res.status, filled: p.msg.qty - res.remaining };
      },
    };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
