/*
 * The storage engine: write-ahead log, memtable, SSTables, compaction.
 * Inside one storage node. A write is appended to the log and put in the
 * memtable; when the memtable is full it is flushed to a sorted file in
 * level 0; the compactor merges level 0 into level 1 and level 1 into level
 * 2, dropping tombstones and expired rows at the bottom. A read checks the
 * memtable, then every level-0 file newest first, then one file per lower
 * level, skipping files whose bloom filter says the key is absent. The log
 * is the only thing that makes an acknowledged write survive a crash, and
 * only the part of it that reached the disk.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const KEY = 'cart:maya';
  const MEM_LIMIT = 40;
  const MEM_HARD = 120;
  const L0_TRIGGER = 4;
  const L1_LIMIT = 240;
  const CHUNK = { 1: 60, 2: 200 };
  const FSYNC_MS = 6;
  const GROUP_MS = 100;
  const PROBE_MS = 6;
  const READ_SLO = 100;
  const WRITE_SLO = 100;
  const LEVELS = [0, 1, 2];
  const SST = { 0: 'sst0', 1: 'sst1', 2: 'sst2' };
  const NAME = { wal: 'the log', mem: 'the memtable', sst0: 'level 0', sst1: 'level 1', sst2: 'level 2' };

  const crashed = (sim) => !!sim.nodes.mem.modes.crashed;
  const factor = (sim, node) => { const m = sim.nodes[node].modes.slow; return m ? (m.factor || 10) : 1; };
  const live = (row, now) => !row.tomb && !(row.exp && row.exp <= now);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sortRows = (rows) => rows.sort((a, b) => cmp(a.key, b.key) || b.seq - a.seq);
  function makeTable(st, level, rows) {
    rows = sortRows(rows.slice());
    const bloom = {}; for (const r of rows) bloom[r.key] = 1;
    return { id: `t${++st.tableSeq}`, level, rows, min: rows[0].key, max: rows[rows.length - 1].key, bloom };
  }
  /** Merge rows from several tables keeping the newest version of each key; drop tombstones and expired rows at the bottom level. */
  function mergeRows(st, tables, toLevel, now) {
    const newest = {};
    for (const t of tables) for (const r of t.rows) if (!newest[r.key] || r.seq > newest[r.key].seq) newest[r.key] = r;
    let rows = Object.values(newest);
    if (toLevel === 2) {
      const before = rows.length;
      rows = rows.filter((r) => !r.tomb); st.stats.tombsDropped += before - rows.length;
      const b2 = rows.length;
      rows = rows.filter((r) => !(r.exp && r.exp <= now)); st.stats.expiredDropped += b2 - rows.length;
    }
    return sortRows(rows);
  }
  const chunk = (rows, n) => { const out = []; for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n)); return out; };
  const rowsIn = (tables) => tables.reduce((s, t) => s + t.rows.length, 0);
  /** What the engine would return for a key right now, without any I/O: memtable, then levels. */
  function lookup(st, key, now) {
    const m = st.mem.rows[key] || (st.immutable && st.immutable.rows[key]);
    if (m) return live(m, now) ? m.value : null;
    for (const t of st.levels[0].slice().reverse()) { const r = t.rows.find((x) => x.key === key); if (r) return live(r, now) ? r.value : null; }
    for (const lv of [1, 2]) { const t = st.levels[lv].find((x) => x.min <= key && key <= x.max); if (t) { const r = t.rows.find((x) => x.key === key); if (r) return live(r, now) ? r.value : null; } }
    return null;
  }
  const truthCart = (sim) => lookup(sim.state, KEY, sim.now) || [];
  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

  /* ---------- Maya ---------- */
  function startWrite(sim, op, item) {
    const u = sim.ui.maya;
    const label = op === 'clear' ? 'clear cart' : `${op} ${item}`;
    sim.startAction(`Maya: ${label}`, function* (ctx) {
      const st = ctx.state;
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'The write carries the whole cart.'] });
      const items = op === 'add' ? Y.kv.union([u.cart, [item]]) : op === 'remove' ? u.cart.filter((x) => x !== item) : [];
      const r = op === 'clear' ? yield ctx.call('api', 'delete', { key: KEY }, { timeout: 2500 }) : yield ctx.call('api', 'put', { key: KEY, value: items }, { timeout: 2500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency; u.lastOp = 'write';
      if (!r.ok) {
        u.error = r.error.message;
        Y.failed(ctx, 'The cart shows an error and is unchanged.');
        ctx.explain({ OVERLOADED: `The memtable holds ${st.mem.count} entries and cannot be flushed, so the node refuses new writes rather than grow without bound. This is a write stall: the disk, not the network, is the bottleneck.`, UNAVAILABLE: 'The node is restarting. Until it has replayed its log it accepts nothing.' }[r.error.code] || r.error.message);
        return;
      }
      u.cart = items; st.acked = items.slice(); st.ackedAt = ctx.now();
      const v = r.value;
      Y.L(ctx, { displayed: ['yes', `${items.length} item${items.length === 1 ? '' : 's'}.`], accepted: 'yes', committed: v.durable ? ['yes', 'Log entry fsynced before the acknowledgement.'] : ['pending', `In the log buffer; fsync within ${GROUP_MS} ms.`], async: 'n/a' });
      if (!v.durable) { const actionId = ctx.actionId; ctx.spawn(function* (c) { yield c.wait(GROUP_MS + 5); const e = st.wal.find((x) => x.seq === v.seq); ctx.sim.setLedger(actionId, 'committed', e && e.durable ? 'yes' : e ? 'pending' : st.walLostSeqs.includes(v.seq) ? 'no' : 'yes', e && e.durable ? 'Group commit fsynced it.' : st.walLostSeqs.includes(v.seq) ? 'Lost: the node crashed before the group commit.' : 'Flushed to level 0.'); }, { actionId }); }
      ctx.explain(`${op === 'clear' ? 'Wrote a tombstone for the cart' : `Saved ${items.join(', ') || 'an empty cart'}`}: appended to the log (sequence ${v.seq}) and put in the memtable, ${SDL.fmtMs(r.latency)}. ${v.durable ? `The log entry was fsynced before the acknowledgement${factor(ctx.sim, 'wal') > 1 ? ', and the slow disk made that fsync take most of the time' : ''}.` : `The log entry is in the buffer; the next group commit, within ${GROUP_MS} ms, will fsync it. Until then a crash loses it even though Maya saw “saved”.`}${op === 'clear' ? ' Older versions in the sorted files still hold the items; the tombstone shadows them until a compaction into the bottom level drops both.' : ''}`);
    }, { self: 'maya' });
  }
  function startRefresh(sim) {
    const u = sim.ui.maya;
    sim.startAction('Maya: refresh cart', function* (ctx) {
      const st = ctx.state;
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const r = yield ctx.call('api', 'get', { key: KEY }, { timeout: 2500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency; u.lastOp = 'read';
      if (!r.ok) { u.error = r.error.message; Y.failed(ctx, 'Not refreshed.'); ctx.explain(r.error.code === 'UNAVAILABLE' ? 'The node is restarting and replaying its log.' : r.error.message); return; }
      const v = r.value;
      u.cart = v.value || []; u.lastRead = v;
      Y.L(ctx, { displayed: ['yes', `${u.cart.length} item${u.cart.length === 1 ? '' : 's'}.`], accepted: 'yes', committed: 'n/a', async: 'n/a' });
      const where = v.found === 'memtable' ? 'in the memtable' : v.found ? `in ${v.found}` : 'nowhere';
      ctx.explain(`Read path: memtable ${v.found === 'memtable' ? 'hit' : 'miss'}${v.found !== 'memtable' ? `, level 0: ${v.probes0} file${v.probes0 === 1 ? '' : 's'} read from disk${v.skips ? `, ${v.skips} skipped by bloom filters` : ''}${v.falsePositives ? ` (${v.falsePositives} false positive${v.falsePositives === 1 ? '' : 's'})` : ''}${v.probesLower ? `, then ${v.probesLower} file${v.probesLower === 1 ? '' : 's'} in the lower levels` : ''}` : ''}. Found ${where}${v.tomb ? ' as a tombstone, so the cart is empty' : v.expired ? ', expired' : ''}, ${SDL.fmtMs(r.latency)}. ${v.probes > 3 ? `${v.probes} disk reads for one key is read amplification: level 0 files overlap, so each must be checked until the key turns up. ${st.config.bloom ? 'Bloom filters keep most of those checks in memory.' : 'Bloom filters would have skipped nearly all of them.'}` : `${v.probes} disk read${v.probes === 1 ? '' : 's'}.`}`);
    }, { self: 'maya' });
  }

  /* ---------- background writes ---------- */
  function startBurst(sim, n, opts) {
    opts = opts || {};
    const st = sim.state;
    const base = st.burstSeq++ * 1000;
    sim.spawn(function* (ctx) {
      for (let i = 0; i < n; i++) {
        const k = opts.ttl ? `session:${base + i}` : `cart:u${(base / 1000) * 37 + i * 7 % 300}`;
        ctx.spawn(function* (c) { yield c.call('api', 'put', { key: k, value: [`item${i % 5}`], ttl: opts.ttl }, { timeout: 2500, quiet: 'all' }); }, { quiet: 'all' });
        yield ctx.wait(4);
      }
      ctx.log({ op: `${n} ${opts.ttl ? 'session rows with a TTL' : 'cart writes'} done`, status: 'ok', detail: `${n} keys written through the normal write path.` });
    }, { self: 'api', quiet: 'all' });
  }

  /* ---------- flush and compaction ---------- */
  function* flushOnce(ctx) {
    const st = ctx.state; const sim = ctx.sim;
    if (st.immutable || st.mem.count === 0) return;
    st.immutable = st.mem; st.mem = { rows: {}, count: 0 };
    const rows = Object.values(st.immutable.rows);
    const maxSeq = Math.max(...rows.map((r) => r.seq));
    for (;;) {
      const r = yield ctx.call('sst0', 'write', { rows: rows.length }, { timeout: 4000 });
      if (r.ok) break;
      st.stats.flushFailures++;
      ctx.log({ op: 'flush failed', status: 'fail', detail: `Level 0 refused the file: ${r.error.message} The memtable keeps growing; at ${MEM_HARD} entries writes stall.` });
      yield ctx.wait(400);
      if (!ctx.alive()) { yield ctx.wait(200); }
    }
    const t = makeTable(st, 0, rows);
    st.levels[0].push(t);
    st.stats.flushes++; st.stats.bytesWritten += rows.length;
    const before = st.wal.length;
    st.wal = st.wal.filter((e) => e.seq > maxSeq);
    st.immutable = null;
    ctx.log({ op: `flushed ${rows.length} rows to level 0`, status: 'ok', detail: `File ${t.id} (${t.min} … ${t.max}) written and fsynced; ${before - st.wal.length} log entries up to sequence ${maxSeq} truncated. Level 0 now has ${st.levels[0].length} file${st.levels[0].length === 1 ? '' : 's'}.` });
    void sim;
  }
  function* compactOnce(ctx, force) {
    const st = ctx.state;
    if (st.compacting) return;
    const now = ctx.now();
    if (st.levels[0].length >= L0_TRIGGER || (force && st.levels[0].length)) {
      st.compacting = true;
      const src = st.levels[0].slice();
      const lo = src.reduce((m, t) => (t.min < m ? t.min : m), src[0].min);
      const hi = src.reduce((m, t) => (t.max > m ? t.max : m), src[0].max);
      const overlap = st.levels[1].filter((t) => !(t.max < lo || t.min > hi));
      const input = rowsIn(src) + rowsIn(overlap);
      yield ctx.call('sst0', 'read', { rows: rowsIn(src) }, { timeout: 6000 });
      if (overlap.length) yield ctx.call('sst1', 'read', { rows: rowsIn(overlap) }, { timeout: 6000 });
      const merged = mergeRows(st, src.concat(overlap), 1, now);
      yield ctx.call('sst1', 'write', { rows: merged.length }, { timeout: 8000 });
      st.levels[0] = st.levels[0].filter((t) => !src.includes(t));
      st.levels[1] = st.levels[1].filter((t) => !overlap.includes(t)).concat(chunk(merged, CHUNK[1]).map((rs) => makeTable(st, 1, rs))).sort((a, b) => cmp(a.min, b.min));
      st.stats.compactions++; st.stats.bytesWritten += merged.length;
      ctx.log({ op: `compacted level 0 → level 1`, status: 'ok', detail: `${src.length} level-0 file${src.length === 1 ? '' : 's'} and ${overlap.length} overlapping level-1 file${overlap.length === 1 ? '' : 's'} (${input} rows) merged into ${merged.length} rows across ${Math.ceil(merged.length / CHUNK[1])} level-1 files. Each row was rewritten once more: write amplification.` });
      st.compacting = false;
    }
    if (rowsIn(st.levels[1]) > L1_LIMIT || (force && st.levels[1].length)) {
      st.compacting = true;
      const src = st.levels[1].slice(); const dst = st.levels[2].slice();
      yield ctx.call('sst1', 'read', { rows: rowsIn(src) }, { timeout: 6000 });
      if (dst.length) yield ctx.call('sst2', 'read', { rows: rowsIn(dst) }, { timeout: 6000 });
      const t0 = st.stats.tombsDropped, e0 = st.stats.expiredDropped;
      const merged = mergeRows(st, src.concat(dst), 2, now);
      yield ctx.call('sst2', 'write', { rows: merged.length }, { timeout: 8000 });
      st.levels[1] = []; st.levels[2] = chunk(merged, CHUNK[2]).map((rs) => makeTable(st, 2, rs));
      st.stats.compactions++; st.stats.bytesWritten += merged.length;
      const td = st.stats.tombsDropped - t0, ed = st.stats.expiredDropped - e0;
      ctx.log({ op: `compacted level 1 → level 2`, status: 'ok', detail: `${rowsIn(src) + rowsIn(dst)} rows merged into ${merged.length}${td || ed ? `; dropped ${td ? `${td} tombstone${td === 1 ? '' : 's'}` : ''}${td && ed ? ' and ' : ''}${ed ? `${ed} expired row${ed === 1 ? '' : 's'}` : ''}, which is safe only here, at the bottom, where no older version can hide below` : ''}.` });
      st.compacting = false;
    }
  }

  const sc = (SDL.scenarios['kv-storage'] = {
    id: 'kv-storage',
    seed: 41,
    minHopMs: 5,
    productWidth: 700,
    intro: 'Save the cart and refresh: the write goes to the log and the memtable. Write a few hundred keys to force flushes and a compaction, then crash the node right after a save with fsync on and off, and compare reads with the compactor paused and bloom filters on and off.',
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'One key', x: 90, y: 280, latency: 1, role: 'Writes and reads one key, the cart. The console writes hundreds of other keys to fill the memtable.', owns: ['What the phone shows'] },
        { id: 'api', label: 'Storage node', kind: 'gateway', sub: 'Request handler', x: 320, y: 280, latency: 1, role: 'put: append to the log, then the memtable. get: memtable, level 0 newest first, then one file per lower level. delete: write a tombstone.', ops: [{ name: 'put', desc: 'Log, then memtable.' }, { name: 'get', desc: 'Memtable, then the levels.' }, { name: 'delete', desc: 'Write a tombstone.' }], owns: ['Nothing durable'] },
        { id: 'wal', label: 'Write-ahead log', kind: 'store', sub: 'Append only', x: 560, y: 90, latency: 1, role: `Sequential appends. With fsync on, every append waits for the disk (${FSYNC_MS} ms); off, entries sit in a buffer and a group commit fsyncs them every ${GROUP_MS} ms. Truncated after a flush.`, ops: [{ name: 'append', desc: 'Append an entry.' }, { name: 'replay', desc: 'Replay durable entries after a crash.' }], owns: ['Entries since the last flush'] },
        { id: 'mem', label: 'Memtable', kind: 'cache', sub: 'In memory', x: 560, y: 280, latency: 0.5, role: `A sorted in-memory map of recent writes. Flushed at ${MEM_LIMIT} entries. Lost in a crash; rebuilt from the log.`, ops: [{ name: 'put', desc: 'Insert or overwrite.' }, { name: 'get', desc: 'Point lookup.' }], owns: ['Recent writes'] },
        { id: 'flush', label: 'Flusher', kind: 'worker', sub: 'Memtable → level 0', x: 800, y: 90, latency: 2, role: 'Freezes the full memtable, writes it as one sorted file into level 0, then truncates the log up to that point.', owns: ['Nothing'] },
        { id: 'compact', label: 'Compactor', kind: 'worker', sub: 'Leveled', x: 800, y: 470, latency: 2, role: `Merges level 0 into level 1 when level 0 has ${L0_TRIGGER} files, and level 1 into level 2 when level 1 exceeds ${L1_LIMIT} rows. Keeps the newest version of each key; drops tombstones and expired rows only in the bottom level.`, owns: ['Nothing'] },
        { id: 'sst0', label: 'Level 0', kind: 'store', sub: 'Overlapping files', x: 1040, y: 90, latency: PROBE_MS, role: 'Files written straight from the memtable. Their key ranges overlap, so a read may have to check every one of them. Each has a bloom filter.', ops: [{ name: 'write', desc: 'Write a file.' }, { name: 'probe', desc: 'Look a key up in one file.' }, { name: 'read', desc: 'Read files for compaction.' }], owns: ['Sorted files'] },
        { id: 'sst1', label: 'Level 1', kind: 'store', sub: 'Non-overlapping', x: 1040, y: 280, latency: PROBE_MS, role: `Files with disjoint key ranges, at most ${CHUNK[1]} rows each. One file can hold a given key, so a read probes at most one.`, ops: [{ name: 'write', desc: 'Write files.' }, { name: 'probe', desc: 'Look a key up.' }, { name: 'read', desc: 'Read for compaction.' }], owns: ['Sorted files'] },
        { id: 'sst2', label: 'Level 2', kind: 'store', sub: 'Bottom level', x: 1040, y: 470, latency: PROBE_MS, role: 'The largest level. Tombstones and expired rows are dropped when data is rewritten here, because nothing older can exist below.', ops: [{ name: 'write', desc: 'Write files.' }, { name: 'probe', desc: 'Look a key up.' }, { name: 'read', desc: 'Read for compaction.' }], owns: ['Sorted files'] },
      ],
      edges: [
        { from: 'maya', to: 'api', latency: 15 },
        { from: 'api', to: 'wal', latency: 1 },
        { from: 'api', to: 'mem', latency: 1 },
        { from: 'api', to: 'sst0', latency: 1, via: [[320, 40], [1040, 40]] },
        { from: 'api', to: 'sst1', latency: 1, via: [[700, 330]] },
        { from: 'api', to: 'sst2', latency: 1, via: [[320, 520], [1040, 520]] },
        { from: 'mem', to: 'flush', latency: 1 },
        { from: 'flush', to: 'sst0', latency: 1 },
        { from: 'flush', to: 'wal', latency: 1 },
        { from: 'compact', to: 'sst0', latency: 1, via: [[920, 470], [920, 90]] },
        { from: 'compact', to: 'sst1', latency: 1 },
        { from: 'compact', to: 'sst2', latency: 1 },
        { from: 'wal', to: 'mem', latency: 1 },
      ],
      queues: [],
    },
    modeLabels: { crashed: 'Crashed: memory lost, restarting', full: 'Disk full' },
    failures: [
      { id: 'crash', node: 'mem', mode: 'crashed', label: 'Node crashes', desc: 'The memtable and the unsynced part of the log buffer vanish. On restart the node replays the durable log into a fresh memtable.' },
      { id: 'disk-slow', node: 'wal', mode: 'slow', params: { factor: 20 }, label: 'Log disk slow', desc: 'Each fsync takes twenty times longer. With fsync per write, every save waits for it; with group commit, writes stay fast and the durability window stays the same.' },
      { id: 'compact-paused', node: 'compact', mode: 'paused', label: 'Compaction paused', desc: 'Level 0 files pile up. Reads must check each of them; without bloom filters that is one disk read per file.' },
      { id: 'flush-paused', node: 'flush', mode: 'paused', label: 'Flush paused', desc: `The memtable and the log keep growing. At ${MEM_HARD} entries the node stalls writes.` },
      { id: 'disk-full', node: 'sst0', mode: 'full', label: 'Data disk full', desc: 'Flushes fail. The memtable cannot drain and writes stall shortly after.' },
      { id: 'sst1-slow', node: 'sst1', mode: 'slow', params: { factor: 10 }, label: 'Level 1 disk slow', desc: 'Reads that reach level 1 take longer; reads served from the memtable or level 0 do not notice.' },
    ],
    switches: Y.switches([
      ['fsync', 'Fsync every write (off: group commit)', `On: the log append waits for the disk before the write is acknowledged. Off: entries are buffered and fsynced together every ${GROUP_MS} ms; faster, but a crash loses up to ${GROUP_MS} ms of acknowledged writes.`],
      ['bloom', 'Bloom filters', 'Each file carries a filter that says “definitely not here” or “maybe”. Reads skip files that say no without touching the disk. Off: every candidate file is read.'],
      ['autoCompact', 'Automatic compaction', `The compactor runs when level 0 reaches ${L0_TRIGGER} files or level 1 exceeds ${L1_LIMIT} rows. Off: only the “Compact now” button compacts.`],
    ]),
    presets: Y.presets({ fsync: true, bloom: true, autoCompact: true }, [
      { id: 'write-read', label: 'Write, then read from the memtable', desc: 'Maya saves socks: one log append with fsync, one memtable insert. Her refresh is served from the memtable without touching a file.', run: (s) => { s.schedule(300, () => startWrite(s, 'add', 'Socks')); s.schedule(900, () => startRefresh(s)); } },
      { id: 'flush-read', label: 'Flush to level 0, then read', desc: `Maya saves socks, then a hundred other carts are written. At ${MEM_LIMIT} entries the memtable is flushed to a level-0 file and the log is truncated. Her refresh misses the memtable and finds the cart in that file.`, run: (s) => { s.schedule(300, () => startWrite(s, 'add', 'Socks')); s.schedule(500, () => startBurst(s, 100)); s.schedule(2200, () => startRefresh(s)); } },
      { id: 'levels-read', label: 'Compaction, then a read from level 1', desc: `A hundred and sixty writes produce ${L0_TRIGGER} level-0 files, which the compactor merges into non-overlapping level-1 files. Maya's refresh skips level 0 and reads exactly one level-1 file.`, run: (s) => { s.schedule(300, () => startWrite(s, 'add', 'Socks')); for (let i = 0; i < 4; i++) s.schedule(500 + i * 500, () => startBurst(s, 40)); s.schedule(4200, () => startRefresh(s)); } },
      { id: 'crash-fsync', label: 'Crash after an fsynced write', desc: 'Maya saves socks and the node crashes 30 ms later. The memtable is gone, but the log entry reached the disk before the acknowledgement. On restart the log is replayed and the refresh finds the socks.', run: (s) => { s.schedule(300, () => startWrite(s, 'add', 'Socks')); s.schedule(380, () => s.inject('mem', 'crashed')); s.schedule(1400, () => s.restore('mem')); s.schedule(2600, () => startRefresh(s)); } },
      { id: 'crash-nofsync', label: 'Crash inside the group-commit window', desc: `Group commit: the acknowledgement comes back before the fsync. The node crashes 30 ms later, inside the ${GROUP_MS} ms window. The entry was only in the buffer. After the restart the cart is empty, although Maya saw “saved”.`, sw: { fsync: false }, run: (s) => { s.schedule(300, () => startWrite(s, 'add', 'Socks')); s.schedule(370, () => s.inject('mem', 'crashed')); s.schedule(1400, () => s.restore('mem')); s.schedule(2600, () => startRefresh(s)); } },
      { id: 'read-amplification', label: 'Compaction paused, no bloom filters', desc: 'Ten bursts pile up ten overlapping level-0 files with the compactor paused. The cart is in the oldest one. Without bloom filters the refresh reads every newer file from disk first.', sw: { bloom: false }, run: (s) => { s.inject('compact', 'paused'); s.schedule(300, () => startWrite(s, 'add', 'Socks')); for (let i = 0; i < 10; i++) s.schedule(400 + i * 350, () => startBurst(s, 40)); s.schedule(5000, () => startRefresh(s)); } },
      { id: 'bloom-filters', label: 'The same ten files with bloom filters', desc: 'Same pile of level-0 files. Each file’s filter answers from memory, so the refresh reads only the file that holds the cart, plus the occasional false positive.', run: (s) => { s.inject('compact', 'paused'); s.schedule(300, () => startWrite(s, 'add', 'Socks')); for (let i = 0; i < 10; i++) s.schedule(400 + i * 350, () => startBurst(s, 40)); s.schedule(5000, () => startRefresh(s)); } },
      { id: 'tombstone', label: 'Delete: a tombstone shadows the old rows', desc: 'The socks are compacted down to level 1. Maya clears the cart: a tombstone goes into the memtable and her refresh reads “empty” from it, while level 1 still holds the socks. More writes push the tombstone down; only the compaction into level 2 drops both.', run: (s) => { s.schedule(300, () => startWrite(s, 'add', 'Socks')); for (let i = 0; i < 4; i++) s.schedule(500 + i * 400, () => startBurst(s, 100)); s.schedule(2800, () => startWrite(s, 'clear')); s.schedule(3200, () => startRefresh(s)); for (let i = 0; i < 4; i++) s.schedule(3500 + i * 400, () => startBurst(s, 100)); s.schedule(6500, () => startRefresh(s)); } },
      { id: 'disk-full', label: 'Data disk full: write stall', desc: `Flushes fail, so the memtable cannot drain. Writes keep coming until it reaches ${MEM_HARD} entries; then the node refuses Maya's save. Durability is intact, availability is not.`, run: (s) => { s.inject('sst0', 'full'); s.schedule(300, () => startWrite(s, 'add', 'Socks')); s.schedule(500, () => startBurst(s, 200)); s.schedule(2400, () => startWrite(s, 'add', 'Hat')); } },
      { id: 'slow-fsync', label: 'Slow disk with fsync per write', desc: 'The log disk is twenty times slower. Every save waits for its own fsync, so Maya’s write takes well over a hundred milliseconds.', run: (s) => { s.inject('wal', 'slow', { factor: 20 }); s.schedule(300, () => startWrite(s, 'add', 'Socks')); } },
      { id: 'slow-group-commit', label: 'Slow disk with group commit', desc: 'Same slow disk, fsync off. The save is acknowledged from the buffer and stays fast; the fsync happens once per group. The trade is the crash window from the earlier scenario.', sw: { fsync: false }, run: (s) => { s.inject('wal', 'slow', { factor: 20 }); s.schedule(300, () => startWrite(s, 'add', 'Socks')); } },
      { id: 'ttl', label: 'TTL: expired rows stay on disk until compaction', desc: 'A hundred session rows are written with a 1.5 s TTL and flushed. Reads treat them as gone once they expire, but they still take space in level 0 and level 1 until a compaction into the bottom level drops them.', run: (s) => { s.schedule(300, () => startBurst(s, 100, { ttl: 1500 })); s.schedule(400, () => startWrite(s, 'add', 'Socks')); for (let i = 0; i < 3; i++) s.schedule(900 + i * 400, () => startBurst(s, 100)); s.schedule(3200, () => startRefresh(s)); s.schedule(3600, () => s.dispatch('compact', {})); } },
    ]),
    initialState: () => ({ config: { fsync: true, bloom: true, autoCompact: true }, seq: 0, tableSeq: 0, burstSeq: 0, mem: { rows: {}, count: 0 }, immutable: null, wal: [], walLostSeqs: [], groupDue: 0, levels: { 0: [], 1: [], 2: [] }, compacting: false, recovering: false, acked: null, ackedAt: 0, stats: { writes: 0, reads: 0, flushes: 0, flushFailures: 0, compactions: 0, bytesWritten: 0, probes: 0, bloomSkips: 0, falsePositives: 0, tombsDropped: 0, expiredDropped: 0, walLost: 0, replayed: 0, stalls: 0 } }),
    initialUI: () => ({ maya: { cart: [], pending: false, error: '', lastMs: null, lastOp: null, lastRead: null } }),
    actions: {
      add(sim, a) { startWrite(sim, 'add', a.item); },
      remove(sim, a) { startWrite(sim, 'remove', a.item); },
      clear(sim) { startWrite(sim, 'clear'); },
      refresh(sim) { startRefresh(sim); },
      burst(sim, a) { startBurst(sim, a.n || 100, { ttl: a.ttl }); },
      flush(sim) { sim.spawn(function* (ctx) { yield* flushOnce(ctx); }, { self: 'flush' }); },
      compact(sim) { sim.spawn(function* (ctx) { yield* compactOnce(ctx, true); }, { self: 'compact' }); },
    },
    handlers: {
      api: {
        put: function* (ctx, p) {
          const st = ctx.state;
          if (crashed(ctx.sim) || st.recovering) ctx.fail('UNAVAILABLE', 'The node is restarting.');
          if (st.mem.count >= MEM_HARD) { st.stats.stalls++; ctx.fail('OVERLOADED', `Write stall: the memtable is full (${st.mem.count} entries) and cannot be flushed.`); }
          const seq = ++st.seq;
          const row = { key: p.key, value: p.value, seq, tomb: !!p.tomb, exp: p.ttl ? ctx.now() + p.ttl : 0 };
          const w = ctx.must(yield ctx.call('wal', 'append', { row, sync: st.config.fsync }, { timeout: 4000, quiet: ctx.quiet }));
          ctx.must(yield ctx.call('mem', 'put', { row }, { timeout: 500, quiet: ctx.quiet }));
          st.stats.writes++;
          return { seq, durable: w.durable };
        },
        delete: function* (ctx, p) { return yield* sc.handlers.api.put(ctx, { key: p.key, value: null, tomb: true }); },
        get: function* (ctx, p) {
          const st = ctx.state;
          if (crashed(ctx.sim) || st.recovering) ctx.fail('UNAVAILABLE', 'The node is restarting.');
          st.stats.reads++;
          const now = ctx.now();
          const out = { probes: 0, probes0: 0, probesLower: 0, skips: 0, falsePositives: 0, found: null, value: null, tomb: false, expired: false };
          const finish = (row, where) => { out.found = where; if (row.tomb) out.tomb = true; else if (row.exp && row.exp <= now) out.expired = true; else out.value = row.value; return out; };
          const m = ctx.must(yield ctx.call('mem', 'get', { key: p.key }, { timeout: 500, quiet: ctx.quiet }));
          if (m.row) return finish(m.row, 'memtable');
          const candidates = st.levels[0].slice().reverse().map((t) => [0, t]);
          for (const lv of [1, 2]) { const t = st.levels[lv].find((x) => x.min <= p.key && p.key <= x.max); if (t) candidates.push([lv, t]); }
          for (const [lv, t] of candidates) {
            if (st.config.bloom) {
              if (!t.bloom[p.key]) { if (ctx.rand() < 0.02) out.falsePositives++; else { out.skips++; st.stats.bloomSkips++; continue; } }
            }
            out.probes++; if (lv === 0) out.probes0++; else out.probesLower++; st.stats.probes++;
            const r = ctx.must(yield ctx.call(SST[lv], 'probe', { table: t.id, key: p.key }, { timeout: 2000, quiet: ctx.quiet }));
            if (r.row) return finish(r.row, `level ${lv} (${t.id})`);
          }
          return out;
        },
      },
      wal: {
        append: function* (ctx, p) {
          const st = ctx.state;
          const e = Object.assign({ durable: false }, p.row);
          st.wal.push(e);
          if (p.sync) { yield ctx.wait(FSYNC_MS * factor(ctx.sim, 'wal')); e.durable = true; for (const x of st.wal) if (x.seq < e.seq) x.durable = true; }
          else if (!st.groupDue) st.groupDue = ctx.now() + GROUP_MS; // the group-commit timer starts with the first buffered entry
          return { durable: e.durable };
        },
        replay(ctx) { const st = ctx.state; const rows = st.wal.filter((e) => e.durable); return { rows }; },
      },
      mem: {
        put(ctx, p) { const st = ctx.state; if (!st.mem.rows[p.row.key]) st.mem.count++; st.mem.rows[p.row.key] = p.row; return { count: st.mem.count }; },
        get(ctx, p) { const st = ctx.state; return { row: st.mem.rows[p.key] || (st.immutable && st.immutable.rows[p.key]) || null }; },
      },
      sst0: { write: function* (ctx, p) { if (ctx.mode('full')) ctx.fail('DISK_FULL', 'The data disk is full.'); yield ctx.wait(Math.min(400, p.rows * 0.6)); return { ok: true }; }, probe(ctx, p) { const t = ctx.state.levels[0].find((x) => x.id === p.table); return { row: t ? t.rows.find((r) => r.key === p.key) || null : null }; }, read: function* (ctx, p) { yield ctx.wait(Math.min(400, p.rows * 0.3)); return {}; } },
      sst1: { write: function* (ctx, p) { yield ctx.wait(Math.min(500, p.rows * 0.4)); return { ok: true }; }, probe(ctx, p) { const t = ctx.state.levels[1].find((x) => x.id === p.table); return { row: t ? t.rows.find((r) => r.key === p.key) || null : null }; }, read: function* (ctx, p) { yield ctx.wait(Math.min(400, p.rows * 0.2)); return {}; } },
      sst2: { write: function* (ctx, p) { yield ctx.wait(Math.min(600, p.rows * 0.3)); return { ok: true }; }, probe(ctx, p) { const t = ctx.state.levels[2].find((x) => x.id === p.table); return { row: t ? t.rows.find((r) => r.key === p.key) || null : null }; }, read: function* (ctx, p) { yield ctx.wait(Math.min(400, p.rows * 0.15)); return {}; } },
    },
    setup(sim) {
      // Group commit: fsync the buffered log entries together.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(10);
          const st = ctx.state;
          if (crashed(ctx.sim) || !st.groupDue || ctx.now() < st.groupDue) continue;
          st.groupDue = 0;
          const pending = st.wal.filter((e) => !e.durable);
          if (!pending.length) continue;
          yield ctx.wait(FSYNC_MS * factor(ctx.sim, 'wal'));
          if (crashed(ctx.sim)) continue;
          for (const e of pending) e.durable = true;
          ctx.log({ op: `group commit: ${pending.length} entr${pending.length === 1 ? 'y' : 'ies'} fsynced`, status: 'ok', detail: `One fsync made ${pending.length} buffered log entr${pending.length === 1 ? 'y' : 'ies'} durable.` });
        }
      }, { self: 'wal', quiet: 'all' });
      // Flusher.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(50);
          if (!ctx.alive() || crashed(ctx.sim) || ctx.state.recovering) continue;
          if (ctx.state.mem.count >= MEM_LIMIT && !ctx.state.immutable) yield* flushOnce(ctx);
        }
      }, { self: 'flush', quiet: 'all' });
      // Compactor.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(80);
          if (!ctx.alive() || crashed(ctx.sim) || !ctx.state.config.autoCompact) continue;
          yield* compactOnce(ctx, false);
        }
      }, { self: 'compact', quiet: 'all' });
    },
    onFailureChange(sim, ch) {
      const st = sim.state;
      if (ch.node !== 'mem' || ch.mode !== 'crashed') return;
      if (ch.active) {
        const lost = st.wal.filter((e) => !e.durable);
        st.stats.walLost += lost.length; st.walLostSeqs.push(...lost.map((e) => e.seq));
        st.wal = st.wal.filter((e) => e.durable); st.groupDue = 0;
        const memCount = st.mem.count + (st.immutable ? st.immutable.count : 0);
        st.mem = { rows: {}, count: 0 }; st.immutable = null; st.compacting = false;
        sim.note(`Crash: ${memCount} memtable entr${memCount === 1 ? 'y' : 'ies'} gone from memory${lost.length ? `, and ${lost.length} log entr${lost.length === 1 ? 'y' : 'ies'} that had not been fsynced ${lost.length === 1 ? 'is' : 'are'} lost for good` : ''}. ${st.wal.length} durable log entr${st.wal.length === 1 ? 'y' : 'ies'} on disk.`);
      } else {
        st.recovering = true;
        sim.spawn(function* (ctx) {
          const r = yield ctx.call('wal', 'replay', {}, { timeout: 3000 });
          const rows = r.ok ? r.value.rows : [];
          for (const row of rows) { yield ctx.call('mem', 'put', { row }, { timeout: 500 }); }
          st.stats.replayed += rows.length;
          st.recovering = false;
          ctx.log({ op: `recovery: ${rows.length} log entr${rows.length === 1 ? 'y' : 'ies'} replayed`, status: 'ok', detail: `The memtable was rebuilt from the durable part of the log. ${rows.some((x) => x.key === KEY) ? 'Maya’s cart was among them.' : st.walLostSeqs.length ? 'Maya’s last save was not in it.' : ''}` });
        }, { self: 'wal' });
      }
    },
    consistency(sim) {
      const st = sim.state; const u = sim.ui.maya;
      if (crashed(sim)) return { key: 'stale', label: 'The node is down. Nothing is served until it restarts and replays its log.' };
      if (st.recovering) return { key: 'stale', label: 'Restarting: replaying the log into a new memtable.' };
      if (u.pending) return { key: 'stale', label: 'Maya is waiting.' };
      const t = truthCart(sim);
      if (st.acked && !same(st.acked, t)) return { key: 'wrong', label: `Maya was told her cart (${st.acked.join(', ') || 'empty'}) was saved; the node now has ${t.join(', ') || 'nothing'}. The log entry had not been fsynced when the node crashed.` };
      if (u.error) return { key: 'stale', label: `Maya’s last request failed: ${u.error}` };
      if (!same(u.cart, t)) return { key: 'stale', label: `The phone shows ${u.cart.join(', ') || 'an empty cart'}; the node has ${t.join(', ') || 'nothing'}.` };
      if (st.mem.count >= MEM_HARD) return { key: 'stale', label: `Write stall: the memtable has ${st.mem.count} entries and flushes are failing. New writes are refused.` };
      if (u.lastMs != null && u.lastMs > (u.lastOp === 'read' ? READ_SLO : WRITE_SLO)) return { key: 'stale', label: `Correct but slow: Maya’s last ${u.lastOp} took ${SDL.fmtMs(u.lastMs)}${u.lastOp === 'read' && u.lastRead ? ` (${u.lastRead.probes} disk reads for one key)` : ' (waiting for the slow disk to fsync)'}.` };
      const l0 = st.levels[0].length;
      return { key: 'ok', label: `The phone and the node agree on ${t.length} item${t.length === 1 ? '' : 's'}. Memtable ${st.mem.count}, log ${st.wal.length} entries, files: ${l0} / ${st.levels[1].length} / ${st.levels[2].length}${l0 >= L0_TRIGGER ? ' (level 0 waiting for compaction)' : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state; const u = sim.ui.maya;
      const onDisk = LEVELS.reduce((s, lv) => s + rowsIn(st.levels[lv]), 0);
      const expired = LEVELS.reduce((s, lv) => s + st.levels[lv].reduce((a, t) => a + t.rows.filter((r) => r.tomb || (r.exp && r.exp <= sim.now)).length, 0), 0);
      const amp = st.stats.writes ? (st.stats.bytesWritten / st.stats.writes) : 0;
      return [
        { label: 'Memtable entries', value: `${st.mem.count} / ${MEM_LIMIT}${st.immutable ? ' (+1 flushing)' : ''}`, tone: st.mem.count >= MEM_HARD ? 'fail' : st.mem.count >= MEM_LIMIT ? 'warn' : '' },
        { label: 'Log entries (durable / buffered)', value: `${st.wal.filter((e) => e.durable).length} / ${st.wal.filter((e) => !e.durable).length}`, tone: st.wal.some((e) => !e.durable) ? 'warn' : '' },
        { label: 'Files L0 / L1 / L2', value: `${st.levels[0].length} / ${st.levels[1].length} / ${st.levels[2].length}`, tone: st.levels[0].length >= L0_TRIGGER * 2 ? 'warn' : '' },
        { label: 'Last read: disk reads / bloom skips', value: u.lastRead ? `${u.lastRead.probes} / ${u.lastRead.skips}` : '–', tone: u.lastRead && u.lastRead.probes > 3 ? 'warn' : '' },
        { label: 'Maya’s last request', value: u.lastMs == null ? '–' : SDL.fmtMs(u.lastMs), tone: u.lastMs > READ_SLO ? 'warn' : '' },
        { label: 'Write amplification', value: amp ? `${amp.toFixed(1)}×` : '–' },
        { label: 'Rows on disk / dead (tombstone or expired)', value: `${onDisk} / ${expired}`, tone: expired ? 'warn' : '' },
        { label: 'Flushes / compactions', value: `${st.stats.flushes} / ${st.stats.compactions}` },
        { label: 'Acknowledged writes lost', value: st.stats.walLost, tone: st.stats.walLost ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: 'Maya’s cart is one key among many. The console writes other keys in bursts and shows the memtable, the log, and every file in each level.',
          side: `<p class="ops-title">Inside the storage node</p><div class="ops-traffic">${Y.btn('burst', 'Write 100 keys', { arg: { n: 100 } })}${Y.btn('burst', 'Write 100 keys with a 1.5 s TTL', { arg: { n: 100, ttl: 1500 }, cls: 'secondary' })}${Y.btn('flush', 'Flush now', { cls: 'secondary' })}${Y.btn('compact', 'Compact now', { cls: 'secondary' })}</div><div data-ref="engine"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state; const u = sim.ui.maya;
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Cart</p><p class="app-sub">Maya · one storage node · fsync ${st.config.fsync ? 'per write' : 'by group commit'}</p></div>`,
          cart: u.cart.length ? u.cart.map((it) => `<div class="app-card"><span class="app-kv"><strong>${esc(it)}</strong>${Y.btn('remove', 'Remove', { arg: { item: it }, cls: 'secondary', disabled: u.pending })}</span></div>`).join('') : '<p class="app-sub">Your cart is empty.</p>',
          msg: Y.msg(u.error, 'fail') || (u.pending ? '<p class="app-msg"><span class="spinner"></span>Working…</p>' : u.lastRead && u.lastOp === 'read' ? `<p class="app-msg">Read: ${u.lastRead.found ? `found in ${u.lastRead.found}` : 'not found'}, ${u.lastRead.probes} disk read${u.lastRead.probes === 1 ? '' : 's'}, ${SDL.fmtMs(u.lastMs)}.</p>` : ''),
          actions: `<div class="app-row">${['Socks', 'Hat', 'Mug'].map((it) => Y.btn('add', `Add ${it.toLowerCase()}`, { arg: { item: it }, cls: u.cart.includes(it) ? 'secondary' : '', disabled: u.pending })).join('')}</div><div class="app-row">${Y.btn('refresh', 'Refresh', { cls: 'secondary', disabled: u.pending })}${Y.btn('clear', 'Clear cart', { cls: 'secondary', disabled: u.pending || !u.cart.length })}</div>`,
        }, {});
        const bar = (n, max, tone) => `<div class="ops-bar" data-tone="${tone || ''}"><i style="width:${Math.min(100, Math.round((n / max) * 100))}%"></i></div>`;
        const durable = st.wal.filter((e) => e.durable).length, buffered = st.wal.length - durable;
        const memTone = st.mem.count >= MEM_HARD ? 'fail' : st.mem.count >= MEM_LIMIT ? 'warn' : 'ok';
        const hasKey = (t) => !!t.bloom[KEY];
        const chips = (lv) => st.levels[lv].length ? `<div class="kv-files">${st.levels[lv].map((t) => `<span class="kv-file ${hasKey(t) ? 'has-key' : ''}" title="${esc(`${t.id}: ${t.min} … ${t.max}`)}">${t.rows.length}${hasKey(t) ? ' ★' : ''}</span>`).join('')}</div>` : '<span class="ops-val">empty</span>';
        const rows = `
          <div class="ops-row" data-tone="${crashed(sim) ? 'fail' : memTone}"><div class="ops-name"><strong>Memtable</strong><span>${crashed(sim) ? 'lost (crashed)' : `${st.mem.count} / ${MEM_LIMIT} entries${st.immutable ? ` · flushing ${st.immutable.count}` : ''}${st.mem.rows[KEY] ? ' · has the cart ★' : ''}`}</span></div>${bar(st.mem.count, MEM_HARD, memTone)}</div>
          <div class="ops-row" data-tone="${buffered ? 'warn' : 'ok'}"><div class="ops-name"><strong>Write-ahead log</strong><span>${durable} durable${buffered ? ` · ${buffered} buffered, not yet fsynced` : ''}</span></div>${bar(st.wal.length, MEM_HARD * 2, buffered ? 'warn' : 'ok')}</div>
          ${LEVELS.map((lv) => `<div class="ops-row" data-tone="${lv === 0 && st.levels[0].length >= L0_TRIGGER ? 'warn' : 'ok'}"><div class="ops-name"><strong>Level ${lv}</strong><span>${st.levels[lv].length} file${st.levels[lv].length === 1 ? '' : 's'} · ${rowsIn(st.levels[lv])} rows${lv === 0 ? ' · ranges overlap' : ` · ≤ ${CHUNK[lv]} rows per file`}</span></div>${chips(lv)}</div>`).join('')}`;
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="engine"]'), {
          rows: `<div class="ops-shards">${rows}</div>`,
          cfg: `<p class="app-sub">★ marks where the cart currently lives (a file may hold an older version). Compaction ${st.config.autoCompact ? `automatic at ${L0_TRIGGER} level-0 files` : 'manual'} · bloom filters ${st.config.bloom ? 'on' : 'off'} · ${st.stats.bloomSkips} files skipped so far.</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
