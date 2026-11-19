/*
 * The sync engine: phone, tablet, and laptop.
 * Every device runs the same loop: scan its own files against the synced base
 * (the state it last agreed with the server), push local changes, then pull
 * the user's change log from its cursor. The base is what lets a device tell
 * "I deleted this" from "this is new on the server". Tombstones tell devices
 * about deletes; compaction trims old log entries, so a device that has been
 * away too long gets 410 and must reconcile against a full listing. Edits are
 * non-destructive edit lists guarded by a version.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const LIB = [
    ['Lake at dawn', 160, '🏞'], ['Ramen', 45, '🍜'], ['Dog on the beach', 200, '🐕'], ['Sunset', 25, '🌅'],
    ['Birthday cake', 330, '🎂'], ['Street market', 95, '🛍'], ['Mountain trail', 120, '⛰'], ['Night city', 260, '🌃'],
  ];
  const NEW = [['Coffee', 30, '☕'], ['Bike ride', 140, '🚲'], ['Snow day', 210, '❄'], ['Picnic', 80, '🧺']];
  const DEVS = { phone: { label: 'Maya’s phone', files: true }, tablet: { label: 'Maya’s tablet', files: true }, laptop: { label: 'Maya’s laptop', files: false } };
  const POLL = 2000;
  const RETAIN = 4000; // change-log entries older than this are compacted away (twice the poll interval)
  const VIRTUAL = 50000; // the real library behind the eight photos on screen

  const off = (sim, d) => !!(sim.nodes[d].modes.offline || sim.nodes[d].modes.down);

  function baseRows() {
    const items = {}; const base = {}; const files = {};
    LIB.forEach(([name, hue, glyph], i) => {
      const id = `p${i + 1}`;
      items[id] = { id, name, hue, glyph, hash: `h${i + 1}`, version: 1, state: 'active', edits: [] };
      base[id] = { hash: `h${i + 1}`, version: 1, state: 'active', edits: [] };
      files[id] = { hash: `h${i + 1}`, name, hue, glyph, edits: [] };
    });
    return { items, base, files };
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* ---------- user actions ---------- */
  function del(sim, d, id) {
    const st = sim.state;
    const dev = st.dev[d];
    const b = dev.base[id];
    if (!b || b.state !== 'active') return;
    st.intent.deleted.push({ id, hash: b.hash });
    sim.startAction(`${DEVS[d].label}: delete “${st.items[id] ? st.items[id].name : id}”`, function* (ctx) {
      const dv = ctx.state.dev[d];
      if (dv.files && dv.files[id]) { dv.trash.push(id); delete dv.files[id]; }
      dv.localTrash[id] = true;
      dv.outbox.push({ op: 'trash', id, baseVersion: b.version, actionId: ctx.actionId });
      dv.dirty = true;
      Y.L(ctx, { displayed: ['yes', 'Gone from this device at once.'], accepted: ['pending', 'Queued for the next sync.'] });
    }, { self: d });
  }
  function take(sim) {
    const st = sim.state;
    const n = ++st.seq.photo;
    const [name, hue, glyph] = NEW[(n - 1) % NEW.length];
    sim.startAction(`Maya’s phone: take “${name}”`, function* (ctx) {
      const dv = ctx.state.dev.phone;
      dv.files[`n${n}`] = { hash: `hn${n}`, name, hue, glyph, edits: [], actionId: ctx.actionId };
      dv.dirty = true;
      Y.L(ctx, { displayed: ['yes', 'In the camera roll.'], accepted: ['pending', 'The scan will upload it.'] });
    }, { self: 'phone' });
  }
  function free(sim) {
    sim.startAction('Maya’s phone: free up space', function* (ctx) {
      const st = ctx.state;
      const dv = st.dev.phone;
      let n = 0;
      for (const id of Object.keys(dv.files)) {
        if (!dv.base[id] || dv.base[id].state !== 'active') continue;
        delete dv.files[id];
        if (st.config.freeState) dv.cloudOnly[id] = true;
        n++;
      }
      st.stats.freed += n * 4;
      dv.dirty = true;
      Y.L(ctx, { displayed: ['yes', `${n} backed-up photos removed from the phone (${n * 4} MB).`], committed: ['n/a', st.config.freeState ? 'Marked “cloud only” on the device; nothing to tell the server.' : 'No separate state: the next scan will just see files missing.'] });
      ctx.explain(st.config.freeState ? `${n} photos are now “cloud only” on the phone. The scan skips them, so the library is untouched.` : `${n} files are gone and the phone has no way to say why. Its next scan sees photos in the base with no file behind them.`);
    }, { self: 'phone' });
  }
  function edit(sim, d, id, what) {
    const st = sim.state;
    const dev = st.dev[d];
    const b = dev.base[id];
    if (!b) return;
    st.intent.edits.push({ id, edit: what, dev: d });
    sim.startAction(`${DEVS[d].label}: edit “${st.items[id].name}” (${what})`, function* (ctx) {
      const dv = ctx.state.dev[d];
      const edits = [what];
      if (dv.files[id]) dv.files[id].edits = edits;
      dv.localEdit[id] = what;
      dv.outbox.push({ op: 'edit', id, baseVersion: b.version, edits, actionId: ctx.actionId });
      dv.dirty = true;
      Y.L(ctx, { displayed: ['yes', `${what} applied on this device.`], accepted: ['pending', 'Queued for the next sync.'] });
    }, { self: d });
  }
  function reinstall(sim) {
    sim.startAction('Maya’s tablet: reinstall the app', function* (ctx) {
      const dv = ctx.state.dev.tablet;
      dv.base = {}; dv.cursor = 0; dv.outbox = []; dv.cloudOnly = {}; dv.localTrash = {}; dv.localEdit = {};
      dv.dirty = true;
      Y.L(ctx, { displayed: ['yes', 'Local index wiped; the files are still on the tablet.'], committed: ['n/a', 'Nothing changes on the server.'] });
      ctx.explain('The app’s database is gone: no cursor, no base. The eight photos are still in the tablet’s storage. The next sync starts from cursor 0, far behind the compacted log.');
    }, { self: 'tablet' });
  }

  /* ---------- the sync engine ---------- */
  function* engine(ctx, d) {
    let lastPoll = ctx.now();
    for (;;) {
      yield ctx.wait(50);
      const dev = ctx.state.dev[d];
      if (off(ctx.sim, d)) continue;
      const poll = ctx.now() - lastPoll >= POLL;
      if (!(dev.hint || dev.dirty || dev.outbox.length || poll)) continue;
      dev.hint = false; dev.dirty = false; lastPoll = ctx.now();
      dev.syncing = true;
      yield* syncOnce(ctx, d, poll);
      dev.syncing = false;
      dev.lastSync = ctx.now();
    }
  }

  function* syncOnce(ctx, d, poll) {
    const st = ctx.state;
    const dev = st.dev[d];
    // A device with no base (fresh install) must learn the library before it can call any file new.
    const fresh = st.config.threeWay && !Object.keys(dev.base).length;
    if (DEVS[d].files && st.config.threeWay && !fresh) scan(ctx, d);
    // 1. Push local changes in order.
    while (!fresh && dev.outbox.length && !off(ctx.sim, d)) {
      const op = dev.outbox[0];
      const r = yield ctx.call('gateway', 'apply', Object.assign({ dev: d }, op, { file: op.file || null }), { timeout: 1200, actionId: op.actionId });
      if (!r.ok && r.error.code === 'CONFLICT') {
        dev.outbox.shift();
        const f = dev.files[op.id];
        st.stats.conflicts++;
        ctx.log({ op: `${op.id} changed elsewhere: save as a copy`, status: 'warn', actionId: op.actionId, detail: `The server is past version ${op.baseVersion}. Rather than overwrite someone else’s edit, this device keeps its edit as a new item.` });
        const copy = { hash: `${(f || st.items[op.id]).hash}~copy`, name: `${st.items[op.id].name} (copy)`, hue: st.items[op.id].hue, glyph: st.items[op.id].glyph, edits: op.edits };
        dev.files[`c${++st.seq.copy}`] = copy;
        dev.outbox.unshift({ op: 'create', tmp: `c${st.seq.copy}`, file: copy, actionId: op.actionId });
        if (f) f.edits = [];
        delete dev.localEdit[op.id];
        continue;
      }
      if (!r.ok) return; // try again next round
      dev.outbox.shift();
      const v = r.value;
      if (op.op === 'create') {
        const f = dev.files[op.tmp];
        if (f) { delete dev.files[op.tmp]; dev.files[v.id] = f; }
        dev.base[v.id] = { hash: op.file.hash, version: v.version, state: 'active', edits: op.file.edits || [] };
        if (op.actionId) ctx.sim.setLedger(op.actionId, 'accepted', 'yes', `Backed up as ${v.id}.`);
      } else if (op.op === 'trash') {
        if (dev.base[op.id]) dev.base[op.id].state = 'trashed';
        delete dev.localTrash[op.id];
        ctx.sim.setLedger(op.actionId, 'accepted', 'yes', 'The server has the delete.');
      } else if (op.op === 'edit') {
        if (dev.base[op.id]) { dev.base[op.id].version = v.version; dev.base[op.id].edits = op.edits; }
        delete dev.localEdit[op.id];
        ctx.sim.setLedger(op.actionId, 'accepted', 'yes', `Saved as version ${v.version}.`);
      }
    }
    if (off(ctx.sim, d)) return;
    // 2. Pull.
    if (!st.config.threeWay) { yield* twoWay(ctx, d); return; }
    const r = yield ctx.call('gateway', 'pull', { dev: d, cursor: dev.cursor }, { timeout: 1200, quiet: poll ? true : undefined });
    if (!r.ok) return;
    if (r.value.gone) {
      st.stats.gone++;
      if (st.config.resync) {
        ctx.log({ op: `${d}: cursor ${dev.cursor} expired, full reconcile`, status: 'recovered', detail: `The log now starts at ${st.logStart}. The device lists the whole library and compares it with its base and its files.` });
        yield* reconcile(ctx, d);
      } else {
        ctx.log({ op: `${d}: cursor ${dev.cursor} expired, jump to head`, status: 'fault', detail: `The device moves its cursor to ${r.value.head} and carries on. Every change in the compacted range is skipped without a trace.` });
        dev.cursor = r.value.head;
      }
      return;
    }
    for (const e of r.value.entries) { yield* applyEntry(ctx, d, e); dev.cursor = e.seq; }
    if (fresh) dev.dirty = true;
  }

  /** Three-way scan: files on the device against the synced base. */
  function scan(ctx, d) {
    const st = ctx.state;
    const dev = st.dev[d];
    for (const [id, b] of Object.entries(dev.base)) {
      if (b.state !== 'active' || dev.files[id] || dev.cloudOnly[id] || dev.localTrash[id]) continue;
      if (dev.outbox.some((o) => o.id === id)) continue;
      // In the base, no file behind it, and nobody said why: the scan reads that as a delete.
      dev.localTrash[id] = true;
      st.stats.scanDeletes++;
      dev.outbox.push({ op: 'trash', id, baseVersion: b.version, actionId: null });
      ctx.log({ op: `${d} scan: ${id} missing, sending delete`, status: st.config.freeState ? 'note' : 'fault', detail: 'The base says this photo was here and synced. The file is gone. With no “removed from device” state, a missing file can only mean the user deleted it.' });
    }
    for (const [k, f] of Object.entries(dev.files)) {
      if (dev.base[k] || dev.outbox.some((o) => o.tmp === k)) continue;
      dev.outbox.push({ op: 'create', tmp: k, file: { hash: f.hash, name: f.name, hue: f.hue, glyph: f.glyph, edits: f.edits || [] }, actionId: f.actionId || null });
    }
  }

  function* applyEntry(ctx, d, e) {
    const st = ctx.state;
    const dev = st.dev[d];
    if (e.op === 'create') {
      if (!dev.base[e.id]) dev.base[e.id] = { hash: e.hash, version: e.version, state: 'active', edits: e.edits || [] };
      if (DEVS[d].files && !dev.files[e.id]) {
        const r = yield ctx.call('gateway', 'download', { id: e.id }, { timeout: 1200, quiet: true });
        if (r.ok) dev.files[e.id] = { hash: e.hash, name: e.name, hue: e.hue, glyph: e.glyph, edits: e.edits || [] };
      }
    } else if (e.op === 'trash') {
      if (dev.base[e.id]) dev.base[e.id].state = 'trashed';
      if (dev.files[e.id]) { dev.trash.push(e.id); delete dev.files[e.id]; }
      delete dev.cloudOnly[e.id];
    } else if (e.op === 'edit') {
      if (dev.base[e.id]) { dev.base[e.id].version = e.version; dev.base[e.id].edits = e.edits; }
      if (dev.files[e.id]) dev.files[e.id].edits = e.edits;
    }
  }

  /** Full reconcile after 410: list everything, compare with the base and the files. */
  function* reconcile(ctx, d) {
    const st = ctx.state;
    const dev = st.dev[d];
    const r = yield ctx.call('gateway', 'list', { dev: d }, { timeout: 1500 });
    if (!r.ok) return;
    const rows = r.value.items;
    const byId = Object.fromEntries(rows.map((x) => [x.id, x]));
    for (const row of rows) {
      const b = dev.base[row.id];
      if (row.state === 'active') {
        if (DEVS[d].files && !dev.files[row.id] && !dev.cloudOnly[row.id]) {
          const k = Object.keys(dev.files).find((key) => !byId[key] && dev.files[key].hash === row.hash);
          if (k) { dev.files[row.id] = dev.files[k]; delete dev.files[k]; st.stats.matched++; }
          else if (!b || b.state === 'active') { yield ctx.call('gateway', 'download', { id: row.id }, { timeout: 1200, quiet: true }); dev.files[row.id] = { hash: row.hash, name: row.name, hue: row.hue, glyph: row.glyph, edits: row.edits }; }
        } else if (dev.files[row.id] && !b) st.stats.matched++;
        dev.base[row.id] = { hash: row.hash, version: row.version, state: 'active', edits: row.edits };
      } else {
        if (b) b.state = 'trashed';
        if (dev.files[row.id] && b) { dev.trash.push(row.id); delete dev.files[row.id]; }
      }
    }
    for (const id of Object.keys(dev.base)) {
      if (byId[id]) continue;
      delete dev.base[id];
      if (dev.files[id]) { dev.trash.push(id); delete dev.files[id]; }
    }
    dev.cursor = r.value.head;
  }

  /** Two-way compare: local files against the server listing, with no base. */
  function* twoWay(ctx, d) {
    const st = ctx.state;
    const dev = st.dev[d];
    const r = yield ctx.call('gateway', 'list', { dev: d }, { timeout: 1500, quiet: true });
    if (!r.ok) return;
    const rows = r.value.items;
    const active = Object.fromEntries(rows.filter((x) => x.state === 'active').map((x) => [x.id, x]));
    if (DEVS[d].files) {
      for (const [k, f] of Object.entries(dev.files)) {
        if (active[k]) continue;
        if (dev.outbox.some((o) => o.tmp === k)) continue;
        // Here but not live on the server: new, or deleted elsewhere? Without a base it cannot tell, so it uploads.
        if (/^p/.test(k)) { st.stats.resurrected++; ctx.log({ op: `${d}: ${k} not on the server, uploading`, status: 'fault', detail: 'The file is on this device and not live in the library. With no record of the last synced state, “deleted elsewhere” and “new here” look the same.' }); }
        dev.outbox.push({ op: 'create', tmp: k, file: { hash: f.hash, name: f.name, hue: f.hue, glyph: f.glyph, edits: f.edits || [] }, actionId: f.actionId || null });
      }
      for (const row of Object.values(active)) {
        if (dev.files[row.id] || dev.cloudOnly[row.id]) continue;
        yield ctx.call('gateway', 'download', { id: row.id }, { timeout: 1200, quiet: true });
        dev.files[row.id] = { hash: row.hash, name: row.name, hue: row.hue, glyph: row.glyph, edits: row.edits };
      }
    }
    dev.base = {};
    for (const row of Object.values(active)) dev.base[row.id] = { hash: row.hash, version: row.version, state: 'active', edits: row.edits };
    dev.cursor = r.value.head;
    if (dev.outbox.length) dev.dirty = true;
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'compactor', quiet: 'all' });
  const offFor = (sim, d, at, ms) => later(sim, at, (x) => x.inject(d, 'offline', true, ms));

  const sc = (SDL.scenarios['gp-sync'] = {
    id: 'gp-sync',
    seed: 1709,
    minHopMs: 5,
    productWidth: 760,
    intro: 'Three devices, one library. Delete a photo on the laptop and watch the phone and tablet follow; free up space on the phone; take the tablet offline long enough for the log to be compacted; edit one photo on two devices. Each device keeps a cursor and a synced base.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'phone', label: 'Maya’s phone', sub: 'Camera roll + sync', kind: 'client', x: 90, y: 90, latency: 1, role: 'Has the files. Scans them against its synced base, pushes changes, then pulls from its cursor.', ops: [{ name: 'hint', desc: 'Something changed: sync now.' }], owns: ['cursor', 'synced base', 'files'] },
        { id: 'tablet', label: 'Maya’s tablet', sub: 'Full library on device', kind: 'client', x: 90, y: 300, latency: 1, role: 'Same engine as the phone. Often sits on a shelf for weeks.', ops: [{ name: 'hint', desc: 'Something changed: sync now.' }], owns: ['cursor', 'synced base', 'files'] },
        { id: 'laptop', label: 'Maya’s laptop', sub: 'Web library', kind: 'client', x: 90, y: 510, latency: 1, role: 'No files of its own; follows the log to keep its view current.', ops: [{ name: 'hint', desc: 'Something changed: sync now.' }], owns: ['cursor', 'view'] },
        { id: 'gateway', label: 'Edge', sub: 'Auth, routing', kind: 'gateway', x: 300, y: 300, latency: 3, role: 'Routes sync calls.', owns: ['Nothing durable'] },
        { id: 'sync', label: 'Sync service', sub: 'Apply, pull, list', kind: 'service', x: 520, y: 300, latency: 4, role: 'Applies a device’s changes (with a version check on edits), serves the change log from a cursor, answers 410 when the cursor is older than the log, and lists the library for a full reconcile.', ops: [{ name: 'apply', desc: 'Apply one change.' }, { name: 'pull', desc: 'Changes since a cursor.' }, { name: 'list', desc: 'The whole library.' }], owns: ['Nothing durable'] },
        { id: 'metadb', label: 'Metadata store', sub: 'Items + change log', kind: 'db', x: 760, y: 300, latency: 6, role: 'Items with a version and state, and Maya’s change log with a sequence number. Every change writes both in one transaction.', ops: [{ name: 'write', desc: 'Item row + log entry.' }], owns: ['items', 'change log', 'log start'] },
        { id: 'blob', label: 'Blob store', sub: 'Originals', kind: 'store', x: 760, y: 90, latency: 8, role: 'The bytes. Devices download from here.', ops: [{ name: 'get', desc: 'Read bytes.' }, { name: 'put', desc: 'Write bytes.' }], owns: ['blobs'] },
        { id: 'compactor', label: 'Log compactor', sub: `Keeps ${RETAIN / 1000} s`, kind: 'worker', x: 980, y: 300, latency: 2, role: `Drops change-log entries older than the retention window (${RETAIN / 1000} s here, about 30 days in practice). A device whose cursor is older gets 410.`, owns: ['Retention'] },
        { id: 'hints', label: 'Push hints', sub: 'Sync now', kind: 'service', x: 520, y: 510, latency: 20, role: 'After a change, nudges Maya’s other devices to sync. Best effort: devices also poll every few seconds.', ops: [{ name: 'notify', desc: 'Nudge the other devices.' }], owns: ['Nothing'] },
      ],
      edges: [
        { from: 'phone', to: 'gateway', latency: 40 },
        { from: 'tablet', to: 'gateway', latency: 30 },
        { from: 'laptop', to: 'gateway', latency: 20 },
        { from: 'gateway', to: 'sync', latency: 3 },
        { from: 'gateway', to: 'blob', latency: 4, via: [[300, 90]] },
        { from: 'sync', to: 'metadb', latency: 3 },
        { from: 'sync', to: 'blob', latency: 3, via: [[520, 90]] },
        { from: 'sync', to: 'hints', latency: 3 },
        { from: 'compactor', to: 'metadb', latency: 3 },
        { from: 'hints', to: 'phone', latency: 40, via: [[400, 560], [200, 90]] },
        { from: 'hints', to: 'tablet', latency: 40, via: [[200, 400]] },
        { from: 'hints', to: 'laptop', latency: 30 },
      ],
      queues: [],
    },
    modeLabels: { offline: 'Offline', aggressive: 'Compacting aggressively' },
    failures: [
      { id: 'tablet-off', node: 'tablet', mode: 'offline', label: 'Tablet offline', desc: 'The tablet keeps its cursor and base and catches up when it returns, unless the log has moved past it.' },
      { id: 'phone-off', node: 'phone', mode: 'offline', label: 'Phone offline', desc: 'Changes queue on the phone and go out when it reconnects.' },
      { id: 'hints-down', node: 'hints', mode: 'down', label: 'Push hints lost', desc: 'Devices find out at their next poll instead of at once.' },
      { id: 'sync-down', node: 'sync', mode: 'down', label: 'Sync service down', desc: 'Every device keeps its changes and retries.' },
      { id: 'meta-slow', node: 'metadb', mode: 'slow', params: { factor: 20 }, label: 'Metadata store slow', desc: 'Each sync takes longer.' },
      { id: 'compact', node: 'compactor', mode: 'aggressive', label: 'Short log retention', desc: 'Entries are kept for half a second, so even short absences end in 410.' },
    ],
    switches: Y.switches([
      ['threeWay', 'Three-way sync with a synced base', 'Each device remembers the state it last agreed with the server and compares files, base, and server. Off: compare files with the server listing only.'],
      ['tombstones', 'Tombstones in the change log', 'A delete stays as a “trashed” row and a log entry. Off: the row is removed and nothing is logged.'],
      ['freeState', '“Free up space” is its own state', 'Removing device copies marks them “cloud only”, which the scan skips. Off: the files just disappear.'],
      ['resync', 'Full reconcile on 410', 'A device whose cursor has expired lists the library and compares. Off: it jumps to the head of the log.'],
      ['versions', 'Version check on edits', 'An edit carries the version it was made on; a stale one becomes a copy. Off: the last edit to arrive wins.'],
    ]),
    presets: Y.presets({ threeWay: true, tombstones: true, freeState: true, resync: true, versions: true }, [
      { id: 'delta-sync', label: 'Delete on the laptop', desc: 'The laptop deletes “Ramen”. The phone and tablet are nudged, pull one log entry each, and move it to their trash.', run: (s) => del(s, 'laptop', 'p2') },
      { id: 'hint-lost', label: 'Delete with push hints down', desc: 'Same delete, but the nudges never arrive. The phone and tablet find it at their next poll, a few seconds later.', run: (s) => { s.inject('hints', 'down'); del(s, 'laptop', 'p2'); } },
      { id: 'free-up-space', label: 'Free up space on the phone', desc: 'The phone removes its copies of eight backed-up photos and marks them “cloud only”. The library, the laptop, and the tablet are untouched.', run: (s) => free(s) },
      { id: 'free-up-space-as-delete', label: 'Free up space, no separate state', desc: 'The files disappear with nothing to say why. The next scan sees eight photos in the base with no file and sends eight deletes. The laptop and tablet lose them all.', sw: { freeState: false }, run: (s) => free(s) },
      { id: 'two-way-resurrects', label: 'Delete on the laptop, two-way compare', desc: 'With no base, the phone sees a file that is not live on the server and cannot tell “deleted elsewhere” from “new here”. It uploads it: the deleted photo comes back.', sw: { threeWay: false }, run: (s) => del(s, 'laptop', 'p2') },
      { id: 'no-tombstones', label: 'Delete with no tombstones', desc: 'The delete removes the row and writes nothing to the log. The phone and tablet pull and find nothing; they show “Ramen” for good.', sw: { tombstones: false }, run: (s) => del(s, 'laptop', 'p2') },
      { id: 'cursor-expired-resync', label: 'Tablet away past retention, full reconcile', desc: 'The tablet is offline for 6 s while the phone takes three photos and the laptop deletes two. The log is compacted past its cursor; it gets 410, lists the library, and ends exactly in step.', run: (s) => { offFor(s, 'tablet', 0, 6000); later(s, 300, take); later(s, 600, take); later(s, 900, take); later(s, 400, (x) => del(x, 'laptop', 'p2')); later(s, 700, (x) => del(x, 'laptop', 'p3')); } },
      { id: 'cursor-expired-naive', label: 'Tablet away past retention, jump to head', desc: 'Same absence, but on 410 the tablet just moves its cursor to the head. It never learns about three new photos or two deletes.', sw: { resync: false }, run: (s) => { offFor(s, 'tablet', 0, 6000); later(s, 300, take); later(s, 600, take); later(s, 900, take); later(s, 400, (x) => del(x, 'laptop', 'p2')); later(s, 700, (x) => del(x, 'laptop', 'p3')); } },
      { id: 'reinstall', label: 'Reinstall the tablet app', desc: 'The tablet loses its cursor and base but keeps its files. The full reconcile matches all eight files to library items by hash: nothing is uploaded again.', run: (s) => reinstall(s) },
      { id: 'edit-conflict-versioned', label: 'Edit one photo on two offline devices, versioned', desc: 'The phone crops “Lake at dawn” and the tablet adds a warm filter, both offline. The phone syncs first; the tablet’s edit is on an old version, so it is kept as a copy. Nothing is lost.', run: (s) => { s.inject('phone', 'offline', true, 1500); s.inject('tablet', 'offline', true, 2200); later(s, 100, (x) => edit(x, 'phone', 'p1', 'Crop')); later(s, 150, (x) => edit(x, 'tablet', 'p1', 'Warm filter')); } },
      { id: 'edit-conflict-lww', label: 'Edit one photo on two offline devices, last writer wins', desc: 'Same two edits without a version check. The tablet’s arrives last and replaces the phone’s crop everywhere, including on the phone.', sw: { versions: false }, run: (s) => { s.inject('phone', 'offline', true, 1500); s.inject('tablet', 'offline', true, 2200); later(s, 100, (x) => edit(x, 'phone', 'p1', 'Crop')); later(s, 150, (x) => edit(x, 'tablet', 'p1', 'Warm filter')); } },
    ]),
    initialState: () => {
      const r = baseRows();
      const dev = (files) => ({ cursor: 8, base: clone(r.base), files: files ? clone(r.files) : {}, cloudOnly: {}, localTrash: {}, localEdit: {}, outbox: [], trash: [], hint: false, dirty: false, syncing: false, lastSync: 0 });
      return {
        config: { threeWay: true, tombstones: true, freeState: true, resync: true, versions: true },
        items: r.items,
        log: [], logStart: 9, head: 8,
        dev: { phone: dev(true), tablet: dev(true), laptop: dev(false) },
        intent: { deleted: [], edits: [] },
        stats: { listed: 0, pulled: 0, gone: 0, matched: 0, conflicts: 0, scanDeletes: 0, resurrected: 0, freed: 0, uploads: 0 },
        seq: { item: 8, photo: 0, copy: 0 },
      };
    },
    initialUI: () => ({}),
    actions: {
      take(sim) { take(sim); },
      free(sim) { free(sim); },
      del(sim, a) { del(sim, a.dev, a.id); },
      edit(sim, a) { edit(sim, a.dev, a.id, a.what); },
      reinstall(sim) { reinstall(sim); },
      toggle(sim, a) { if (sim.nodes[a.dev].modes.offline) sim.restore(a.dev, 'offline'); else sim.inject(a.dev, 'offline'); },
    },
    handlers: {
      gateway: {
        apply: function* (ctx, p) { return ctx.must(yield ctx.call('sync', 'apply', p, { timeout: 1000 })); },
        pull: function* (ctx, p) { return ctx.must(yield ctx.call('sync', 'pull', p, { timeout: 1000, quiet: true })); },
        list: function* (ctx, p) { return ctx.must(yield ctx.call('sync', 'list', p, { timeout: 1200 })); },
        download: function* (ctx, p) { return ctx.must(yield ctx.call('blob', 'get', p, { timeout: 1000 })); },
      },
      sync: {
        apply: function* (ctx, p) {
          const r = ctx.must(yield ctx.call('metadb', 'write', p, { timeout: 800 }));
          if (p.op === 'create') ctx.must(yield ctx.call('blob', 'put', { hash: p.file.hash }, { timeout: 800, quiet: true }));
          if (r.logged) yield ctx.call('hints', 'notify', { except: p.dev }, { timeout: 800 });
          return r;
        },
        pull: function* (ctx, p) { return ctx.must(yield ctx.call('metadb', 'since', p, { timeout: 800, quiet: true })); },
        list: function* (ctx, p) { return ctx.must(yield ctx.call('metadb', 'list', p, { timeout: 1000 })); },
      },
      metadb: {
        write(ctx, p) {
          const st = ctx.state;
          const log = (e) => { st.head++; st.log.push(Object.assign({ seq: st.head, t: ctx.now() }, e)); };
          if (p.op === 'create') {
            const same = Object.values(st.items).find((x) => x.state === 'active' && x.hash === p.file.hash);
            if (same) return { id: same.id, version: same.version, logged: false };
            const id = `p${++st.seq.item}`;
            st.items[id] = { id, name: p.file.name, hue: p.file.hue, glyph: p.file.glyph, hash: p.file.hash, version: 1, state: 'active', edits: p.file.edits || [], by: p.dev };
            st.stats.uploads++;
            log({ op: 'create', id, hash: p.file.hash, name: p.file.name, hue: p.file.hue, glyph: p.file.glyph, version: 1, edits: p.file.edits || [] });
            return { id, version: 1, logged: true };
          }
          const it = st.items[p.id];
          if (p.op === 'trash') {
            if (!it || it.state !== 'active') return { version: it ? it.version : 0, logged: false };
            if (st.config.tombstones) { it.state = 'trashed'; it.version++; it.trashedBy = p.dev; log({ op: 'trash', id: p.id, version: it.version }); return { version: it.version, logged: true }; }
            delete st.items[p.id];
            return { version: 0, logged: true };
          }
          if (p.op === 'edit') {
            if (!it || it.state !== 'active') ctx.fail('CONFLICT', 'The photo is no longer live.');
            if (st.config.versions && p.baseVersion !== it.version) ctx.fail('CONFLICT', `Edit made on version ${p.baseVersion}; the photo is at version ${it.version}.`);
            if (!st.config.versions && it.edits.length && it.edits.join() !== p.edits.join()) ctx.log({ op: `${p.id}: edit overwritten`, status: 'fault', actionId: ctx.actionId, detail: `The stored edit (${it.edits.join(', ')}) is replaced by ${p.edits.join(', ')} from the ${p.dev}. Nobody is told.` });
            it.edits = p.edits.slice(); it.version++;
            log({ op: 'edit', id: p.id, version: it.version, edits: it.edits });
            return { version: it.version, logged: true };
          }
          ctx.fail('BAD_REQUEST', 'Unknown change.');
        },
        since(ctx, p) {
          const st = ctx.state;
          st.stats.pulled++;
          if (p.cursor + 1 < st.logStart) return { gone: true, head: st.head, logStart: st.logStart };
          return { entries: st.log.filter((e) => e.seq > p.cursor).map((e) => Object.assign({}, e)), head: st.head };
        },
        list(ctx) {
          const st = ctx.state;
          st.stats.listed += VIRTUAL;
          return { items: Object.values(st.items).map((x) => Object.assign({}, x, { edits: x.edits.slice() })), head: st.head };
        },
      },
      blob: { get() { return { ok: true }; }, put() { return { ok: true }; } },
      hints: {
        notify: function* (ctx, p) {
          for (const d of Object.keys(DEVS)) if (d !== p.except) yield ctx.call(d, 'hint', {}, { timeout: 500 });
          return { ok: true };
        },
      },
      phone: { hint(ctx) { if (off(ctx.sim, 'phone')) ctx.fail('OFFLINE', 'No connection.'); ctx.state.dev.phone.hint = true; return { ok: true }; } },
      tablet: { hint(ctx) { if (off(ctx.sim, 'tablet')) ctx.fail('OFFLINE', 'No connection.'); ctx.state.dev.tablet.hint = true; return { ok: true }; } },
      laptop: { hint(ctx) { if (off(ctx.sim, 'laptop')) ctx.fail('OFFLINE', 'No connection.'); ctx.state.dev.laptop.hint = true; return { ok: true }; } },
    },
    setup(sim) {
      for (const d of Object.keys(DEVS)) sim.spawn((ctx) => engine(ctx, d), { self: d });
      // The compactor trims old entries; a device whose cursor is older gets 410.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(250);
          const st = ctx.state;
          const keep = ctx.mode('aggressive') ? 500 : RETAIN;
          const before = st.log.length;
          st.log = st.log.filter((e) => ctx.now() - e.t <= keep);
          st.logStart = st.log.length ? st.log[0].seq : st.head + 1;
          if (st.log.length < before) ctx.log({ op: `compacted ${before - st.log.length} entr${before - st.log.length === 1 ? 'y' : 'ies'}`, status: 'note', detail: `The log now starts at ${st.logStart}. Any cursor before ${st.logStart - 1} will get 410.` });
        }
      }, { self: 'compactor', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const live = Object.values(st.items).filter((x) => x.state === 'active');
      const liveIds = new Set(live.map((x) => x.id));
      const back = st.intent.deleted.find((x) => live.some((y) => y.hash === x.hash));
      if (back) { const y = live.find((z) => z.hash === back.hash); return { key: 'wrong', label: `Maya deleted “${y.name}”, and it is back as ${y.id}: a device with no synced base saw the file and uploaded it as new.` }; }
      const unasked = Object.values(st.items).filter((x) => x.state === 'trashed' && !st.intent.deleted.some((d) => d.id === x.id));
      if (unasked.length) return { key: 'wrong', label: `${unasked.length} photos went to the trash on every device, and Maya never deleted any of them. “Free up space” removed the files and the scan read that as deletes.` };
      const lost = st.intent.edits.find((e) => !Object.values(st.items).some((x) => x.state === 'active' && x.edits.includes(e.edit)));
      if (lost) return { key: 'wrong', label: `The ${lost.dev}’s “${lost.edit}” on “${st.items[lost.id].name}” is gone from every device: a later edit made on the same version replaced it.` };
      for (const d of Object.keys(DEVS)) {
        if (off(sim, d)) continue;
        const dev = st.dev[d];
        if (dev.outbox.length) continue;
        const view = Object.entries(dev.base).filter(([, b]) => b.state === 'active').map(([id]) => id);
        const extra = view.filter((id) => !liveIds.has(id));
        const missing = [...liveIds].filter((id) => !view.includes(id) && !(d !== 'laptop' && false));
        if (extra.length || missing.length) {
          const parts = [];
          if (extra.length) parts.push(`still shows ${extra.length} deleted photo${extra.length > 1 ? 's' : ''}`);
          if (missing.length) parts.push(`is missing ${missing.length} new one${missing.length > 1 ? 's' : ''}`);
          return { key: 'wrong', label: `${DEVS[d].label} ${parts.join(' and ')}, and nothing will ever correct it: ${st.config.tombstones ? 'it skipped the compacted part of the log.' : 'deletes left no trace in the log.'}` };
        }
      }
      const away = Object.keys(DEVS).filter((d) => off(sim, d));
      if (away.length) return { key: 'stale', label: `${away.map((d) => DEVS[d].label).join(' and ')} ${away.length > 1 ? 'are' : 'is'} offline and will catch up when ${away.length > 1 ? 'they return' : 'it returns'}.` };
      const pending = Object.keys(DEVS).filter((d) => st.dev[d].outbox.length);
      if (pending.length) return { key: 'stale', label: `${DEVS[pending[0]].label} still has changes to send.` };
      if (st.stats.conflicts) return { key: 'ok', label: 'Both edits survive: the second was made on an old version, so it was saved as a copy instead of replacing the first.' };
      if (st.stats.gone && st.stats.matched) return { key: 'ok', label: `Every device matches the library. The tablet had no cursor, got 410, and a full listing matched its ${st.stats.matched} files to library items by hash, so nothing was uploaded again.` };
      if (st.stats.gone) return { key: 'ok', label: 'Every device matches the library. The tablet’s cursor had been compacted away; it got 410, listed the library, compared it with its base, and fetched the new photos and dropped the deleted ones.' };
      if (sim.nodes.hints.modes.down && st.intent.deleted.length) return { key: 'ok', label: 'Every device matches the library. With no push hints, the phone and tablet found the delete at their next poll instead of at once.' };
      if (st.intent.deleted.length) return { key: 'ok', label: 'Every device matches the library: the other devices were nudged, pulled one log entry each, and moved the photo to their trash.' };
      if (st.stats.freed && st.config.freeState) return { key: 'ok', label: `The phone freed ${st.stats.freed} MB; those photos are “cloud only” there and untouched everywhere else.` };
      return { key: 'ok', label: 'Every device matches the library.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const live = Object.values(st.items).filter((x) => x.state === 'active').length;
      const behind = Object.keys(DEVS).map((d) => st.head - st.dev[d].cursor);
      return [
        { label: 'Live photos', value: live },
        { label: 'Log head / start', value: `${st.head} / ${st.logStart}` },
        { label: 'Cursor lag (phone, tablet, laptop)', value: behind.join(', ') },
        { label: '410 responses', value: st.stats.gone, tone: st.stats.gone ? 'warn' : '' },
        { label: 'Items listed in full', value: Y.num(st.stats.listed), tone: st.stats.listed ? 'warn' : '' },
        { label: 'Matched by hash', value: st.stats.matched },
        { label: 'Uploads', value: st.stats.uploads },
        { label: 'Scan deletes', value: st.stats.scanDeletes, tone: st.stats.scanDeletes && !st.config.freeState ? 'fail' : '' },
        { label: 'Edit conflicts', value: st.stats.conflicts },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone'], ['tablet', 'Maya’s tablet'], ['laptop', 'Maya’s laptop (web)']], {
          note: 'Each device shows its own view of the library: ✓ the file is on the device, ☁ cloud only. Tap a photo on the laptop to delete it.',
          below: '<div class="ops-console" data-ref="status"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const tile = (meta, badge, act, extra) => `<div style="min-width:0">${act ? `<button class="app-btn secondary" style="padding:0;width:100%;min-height:0" data-act="del" data-arg='${JSON.stringify(act)}' aria-label="Delete ${esc(meta.name)}">` : ''}<div class="yt-thumb" style="--h:${meta.hue};aspect-ratio:1;font-size:15px;${extra || ''}"><span aria-hidden="true">${meta.glyph}</span></div>${act ? '</button>' : ''}<span class="app-sub" style="display:block;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${badge} ${esc(meta.name)}</span></div>`;
        const grid = (inner) => `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px">${inner || '<p class="app-sub">Empty.</p>'}</div>`;
        for (const d of Object.keys(DEVS)) {
          const dev = st.dev[d];
          const ids = Object.entries(dev.base).filter(([id, b]) => b.state === 'active' && !dev.localTrash[id]).map(([id]) => id);
          const pending = DEVS[d].files ? Object.keys(dev.files).filter((k) => !dev.base[k]) : [];
          const cells = [...ids.map((id) => {
            const m = st.items[id] || Object.assign({ name: id, hue: 0, glyph: '?' }, dev.files[id] || {});
            const f = dev.files[id];
            const edits = (dev.localEdit[id] ? [dev.localEdit[id]] : (f ? f.edits : dev.base[id].edits)) || [];
            const badge = DEVS[d].files ? (f ? '✓' : '☁') : '';
            const fx = edits.includes('Warm filter') ? 'filter:sepia(.6) saturate(1.4);' : '';
            const crop = edits.includes('Crop') ? 'outline:3px solid var(--ok);outline-offset:-3px;' : '';
            return tile(Object.assign({}, m, { name: `${edits.length ? `${edits.join(', ')} · ` : ''}${m.name}` }), badge, d === 'laptop' ? { dev: 'laptop', id } : null, fx + crop);
          }), ...pending.map((k) => tile(dev.files[k], '↑', null, 'opacity:.7'))];
          const status = off(sim, d) ? '⚠ Offline' : dev.syncing ? 'Syncing…' : dev.outbox.length ? `${dev.outbox.length} change${dev.outbox.length > 1 ? 's' : ''} to send` : `Synced · cursor ${dev.cursor}`;
          const ctl = d === 'phone'
            ? `<div class="app-row" style="flex-wrap:wrap">${Y.btn('take', '📷 Take photo')}${Y.btn('free', 'Free up space', { cls: 'secondary' })}${Y.btn('edit', 'Crop “Lake”', { cls: 'secondary', arg: { dev: 'phone', id: 'p1', what: 'Crop' } })}</div>`
            : d === 'tablet'
              ? `<div class="app-row" style="flex-wrap:wrap">${Y.btn('toggle', off(sim, 'tablet') ? 'Go online' : 'Go offline', { arg: { dev: 'tablet' } })}${Y.btn('reinstall', 'Reinstall app', { cls: 'secondary' })}${Y.btn('edit', 'Warm filter “Lake”', { cls: 'secondary', arg: { dev: 'tablet', id: 'p1', what: 'Warm filter' } })}</div>`
              : '';
          const trash = dev.trash.length ? `<p class="app-sub">🗑 Device trash: ${dev.trash.length}</p>` : '';
          Y.paint(el, sim, d, { head: `<div><p class="app-title">Photos</p><p class="app-sub">${status}</p></div>`, ctl, grid: grid(cells.join('')), trash }, {});
        }
        const c = sim.scenario.consistency(sim);
        const rows = `<div class="ops-shards">
          <div class="ops-row"><div class="ops-name">Change log<span>entries ${st.logStart}–${st.head} kept (${st.log.length}); older ones compacted</span></div></div>
          <div class="ops-row" data-tone="${st.stats.gone ? 'warn' : ''}"><div class="ops-name">Full listings<span>${st.stats.gone} cursor${st.stats.gone === 1 ? '' : 's'} expired · ${Y.num(st.stats.listed)} items listed</span></div></div>
          <div class="ops-row"><div class="ops-name">Library<span>${Object.values(st.items).filter((x) => x.state === 'active').length} live · ${Object.values(st.items).filter((x) => x.state === 'trashed').length} in trash</span></div></div></div>`;
        SDL.ui.paintSections(el.querySelector('[data-ref="status"]'), {
          title: '<p class="ops-title">Server</p>',
          rows,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
