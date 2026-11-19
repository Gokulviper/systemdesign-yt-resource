/*
 * Dedupe, references, and quota.
 * Bytes are stored once per content hash; library items are references to a
 * blob. A backup first asks whether the blob exists (attach, no bytes) or
 * reserves quota, uploads, and commits. Reservations expire if a device dies.
 * A garbage collector removes blobs with no references, but only after a grace
 * period and with a compare-and-set, because an attach can arrive while it
 * deletes. Dedupe across users saves bytes and tells one user what another has.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const LIMIT = 15000; // MB
  const GRACE = 2000;
  const TTL = 2000;
  const MB_MS = 2; // upload time per MB
  const FILES = {
    video: { name: 'Beach.mp4', hash: 'hv-beach', size: 600, hue: 185, glyph: '🎞' },
    video2: { name: 'Concert.mp4', hash: 'hv-concert', size: 600, hue: 280, glyph: '🎞' },
    sunset: { name: 'Sunset', hash: 'h-sunset', size: 4, hue: 25, glyph: '🌅' },
    ticket: { name: 'Concert ticket', hash: 'h-ticket', size: 2, hue: 50, glyph: '🎫' },
  };
  const OWNER = { phone: 'maya', tablet: 'maya', omar: 'omar' };
  const LABEL = { phone: 'Maya’s phone', tablet: 'Maya’s tablet', omar: 'Omar’s phone' };

  const dead = (sim, d) => !!sim.nodes[d].modes.down;

  function backup(sim, d, key) {
    const f = FILES[key];
    const user = OWNER[d];
    const st = sim.state;
    const job = { id: `j${++st.seq.job}`, dev: d, user, key, state: 'checking', t: sim.now };
    st.jobs.push(job);
    sim.startAction(`${LABEL[d]}: back up “${f.name}”`, function* (ctx) {
      const s = ctx.state;
      const done = (state, note, tone) => { job.state = state; job.note = note; job.at = ctx.now(); if (tone === 'fail') Y.failed(ctx, note); };
      const c = yield ctx.call('gateway', 'check', { user, hash: f.hash }, { timeout: 1500 });
      if (!c.ok) return done('waiting', `Check failed: ${c.error.code}.`, 'fail');
      if (c.value.exists) {
        job.state = 'attaching';
        const a = yield ctx.call('gateway', 'attach', { user, hash: f.hash, size: f.size, name: f.name, dev: d }, { timeout: 1500 });
        if (a.ok) {
          s.stats.attached++;
          if (c.value.others) { s.leaks.push({ user, hash: f.hash }); ctx.log({ op: `${user}: “${f.name}” finished with 0 bytes`, status: 'fault', actionId: ctx.actionId, detail: 'The blob existed and no item of this user points at it. The instant finish tells this user that someone else has exactly this file.' }); }
          Y.L(ctx, { displayed: ['yes', 'Backed up instantly: 0 bytes sent.'], committed: ['yes', `Reference added to ${f.hash}.`] });
          return done('backed', `Backed up · 0 MB sent${c.value.others ? ' (someone else had it)' : ''}`);
        }
        if (a.error.code === 'QUOTA') return done('full', 'Storage full', 'fail');
        ctx.log({ op: `attach refused, uploading ${f.name}`, status: 'retry', actionId: ctx.actionId, detail: `${a.error.message} The device sends the bytes instead.` });
      }
      // Reserve (or just check), upload, commit.
      job.state = 'reserving';
      const q = yield ctx.call('gateway', s.config.reserve ? 'reserve' : 'checkQuota', { user, size: f.size, dev: d }, { timeout: 1500 });
      if (!q.ok) return done(q.error.code === 'QUOTA' ? 'full' : 'waiting', q.error.code === 'QUOTA' ? 'Storage full' : `Refused: ${q.error.code}`, 'fail');
      const res = q.value.res || null;
      job.state = 'uploading';
      ctx.ledger('accepted', 'yes', res ? `Reserved ${f.size} MB (${res}).` : `Checked: ${f.size} MB fits right now.`);
      const u = yield ctx.call('gateway', 'put', { hash: f.hash, size: f.size }, { timeout: 4000 });
      if (dead(ctx.sim, d)) return done('dead', 'The device died mid-upload.');
      if (!u.ok) return done('waiting', `Upload failed: ${u.error.code}.`, 'fail');
      s.stats.sentMB += f.size;
      const m = yield ctx.call('gateway', 'commit', { user, hash: f.hash, size: f.size, name: f.name, dev: d, res }, { timeout: 1500 });
      if (!m.ok) return done(m.error.code === 'QUOTA' ? 'full' : 'waiting', m.error.code === 'QUOTA' ? 'Storage full' : `Commit failed: ${m.error.code}`, 'fail');
      Y.L(ctx, { displayed: ['yes', `Backed up · ${f.size} MB sent.`], committed: ['yes', `Item ${m.value.id}; ${f.size} MB charged.`] });
      done('backed', `Backed up · ${f.size} MB sent`);
    }, { self: d });
  }

  function remove(sim, d, key) {
    const f = FILES[key];
    const user = OWNER[d];
    sim.startAction(`${LABEL[d]}: delete “${f.name}”`, function* (ctx) {
      const r = yield ctx.call('gateway', 'delete', { user, hash: f.hash }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { displayed: ['yes', 'Deleted.'], committed: ['yes', `Reference removed; ${r.value.refs} left on ${f.hash}.`], async: ['pending', r.value.refs ? 'Blob still referenced.' : 'The garbage collector decides when the bytes go.'] });
    }, { self: d });
  }

  /** Delete a blob's bytes, then its index entry. */
  function* collect(ctx, hash, claimed) {
    if (!claimed) ctx.log({ op: `${hash}: no references, deleting now`, status: 'note', detail: 'The count reached zero, so the bytes go at once. Nothing stops an attach that arrives while they are being deleted.' });
    yield ctx.call('blob', 'delete', { hash }, { timeout: 2000 });
    yield ctx.call('blobindex', 'forget', { hash }, { timeout: 800 });
    ctx.state.stats.gcDeleted++;
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'gc', quiet: 'all' });

  const sc = (SDL.scenarios['gp-quota'] = {
    id: 'gp-quota',
    seed: 1811,
    minHopMs: 5,
    productWidth: 760,
    intro: 'Maya has 0.9 GB left of 15 GB. Back up the same photo from two devices, race two 600 MB videos for the last of her space, let a device die after reserving, and delete a photo while another device is attaching to its bytes. Omar uploads a file Maya already has.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'phone', label: 'Maya’s phone', sub: 'Backup', kind: 'client', x: 90, y: 90, latency: 1, role: 'Backs up Maya’s photos and videos.', owns: ['Local originals'] },
        { id: 'tablet', label: 'Maya’s tablet', sub: 'Backup', kind: 'client', x: 90, y: 300, latency: 1, role: 'Backs up too, often the same photos.', owns: ['Local originals'] },
        { id: 'omar', label: 'Omar’s phone', sub: 'Another user', kind: 'client', x: 90, y: 510, latency: 1, role: 'A different account with its own quota.', owns: ['Local originals'] },
        { id: 'gateway', label: 'Edge', sub: 'Auth, routing', kind: 'gateway', x: 300, y: 300, latency: 3, role: 'Routes calls.', owns: ['Nothing durable'] },
        { id: 'library', label: 'Photos API', sub: 'Check, attach, delete', kind: 'service', x: 520, y: 200, latency: 4, role: 'Asks the blob index whether bytes exist for a hash, attaches a new item to existing bytes, and removes references on delete.', ops: [{ name: 'check', desc: 'Do these bytes exist?' }, { name: 'attach', desc: 'New item, existing bytes.' }], owns: ['Nothing durable'] },
        { id: 'upload', label: 'Upload service', sub: 'Bytes', kind: 'service', x: 520, y: 400, latency: 4, role: 'Receives bytes and commits a new blob with its first reference.', ops: [{ name: 'put', desc: 'Receive bytes.' }, { name: 'commit', desc: 'Blob + reference + charge.' }], owns: ['Sessions'] },
        { id: 'quota', label: 'Quota service', sub: 'Reserve, commit, expire', kind: 'service', x: 760, y: 510, latency: 3, role: 'Reserves space before an upload, turns the reservation into a charge on commit, and releases reservations whose device never came back.', ops: [{ name: 'reserve', desc: 'Hold space.' }, { name: 'commit', desc: 'Charge it.' }], owns: ['Reservation expiry'] },
        { id: 'counters', label: 'Quota counters', sub: 'Used + reserved', kind: 'db', x: 980, y: 510, latency: 4, role: 'Per user: bytes charged and bytes reserved. Updated with a conditional write so two devices cannot both take the last gigabyte.', ops: [{ name: 'reserve', desc: 'Conditional add.' }], owns: ['used[user]', 'reserved[user]'] },
        { id: 'blobindex', label: 'Blob index', sub: 'Hash → references', kind: 'db', x: 760, y: 200, latency: 4, role: 'For every content hash: who refers to it, and whether it is live, tombstoned, or being deleted.', ops: [{ name: 'lookup', desc: 'Find a hash.' }, { name: 'addRef', desc: 'Add a reference.' }, { name: 'removeRef', desc: 'Remove a reference.' }], owns: ['refs[hash]', 'state[hash]'] },
        { id: 'blob', label: 'Blob store', sub: 'Bytes by hash', kind: 'store', x: 760, y: 400, latency: 6, role: 'The bytes, stored once per hash.', ops: [{ name: 'put', desc: 'Write bytes.' }, { name: 'delete', desc: 'Delete bytes (slow).' }], owns: ['bytes[hash]'] },
        { id: 'gc', label: 'Garbage collector', sub: 'Unreferenced blobs', kind: 'worker', x: 980, y: 300, latency: 2, role: `Deletes blobs nobody refers to. With a grace period it waits ${GRACE / 1000} s after the last reference goes and claims the blob with a compare-and-set before deleting.`, owns: ['Deletion sweep'] },
      ],
      edges: [
        { from: 'phone', to: 'gateway', latency: 30 },
        { from: 'tablet', to: 'gateway', latency: 30 },
        { from: 'omar', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'library', latency: 3 },
        { from: 'gateway', to: 'upload', latency: 3 },
        { from: 'gateway', to: 'quota', latency: 3, via: [[300, 560], [760, 560]] },
        { from: 'library', to: 'blobindex', latency: 3 },
        { from: 'library', to: 'quota', latency: 3, via: [[640, 300], [640, 470]] },
        { from: 'upload', to: 'blob', latency: 3 },
        { from: 'upload', to: 'blobindex', latency: 3 },
        { from: 'upload', to: 'quota', latency: 3 },
        { from: 'quota', to: 'counters', latency: 3 },
        { from: 'gc', to: 'blobindex', latency: 3 },
        { from: 'gc', to: 'blob', latency: 3 },
      ],
      queues: [],
    },
    modeLabels: {},
    failures: [
      { id: 'phone-dies', node: 'phone', mode: 'down', label: 'Phone dies', desc: 'Anything it was uploading stops; its reservation is left behind.' },
      { id: 'tablet-dies', node: 'tablet', mode: 'down', label: 'Tablet dies', desc: 'Anything it was uploading stops.' },
      { id: 'counters-down', node: 'counters', mode: 'down', label: 'Quota counters down', desc: 'Nothing can be reserved or charged, so new uploads wait. Dedupe attaches wait too.' },
      { id: 'counters-slow', node: 'counters', mode: 'slow', params: { factor: 30 }, label: 'Quota counters slow', desc: 'Every upload takes longer to start.' },
      { id: 'index-slow', node: 'blobindex', mode: 'slow', params: { factor: 20 }, label: 'Blob index slow', desc: 'Checks and attaches take longer.' },
      { id: 'gc-paused', node: 'gc', mode: 'paused', label: 'Garbage collector paused', desc: 'Unreferenced blobs stay on disk: safe, but they cost money.' },
      { id: 'blob-slow', node: 'blob', mode: 'slow', params: { factor: 5 }, label: 'Blob store slow', desc: 'Uploads and deletes take longer, which widens any race.' },
    ],
    switches: Y.switches([
      ['reserve', 'Reserve quota before uploading', 'A conditional write holds the space; commit turns it into a charge. Off: check that it fits, upload, then charge without checking again.'],
      ['expire', 'Reservations expire', `A reservation not committed within ${TTL / 1000} s is released. Off: a device that dies leaves its reservation forever.`],
      ['grace', 'Garbage collection grace and compare-and-set', `Wait ${GRACE / 1000} s after the last reference goes, then claim the blob only if it still has none. An attach in the meantime revives it. Off: delete as soon as the count reaches zero.`],
      ['perUser', 'Dedupe within one user only', 'An upload only skips the bytes if the same user already has them. Off: dedupe across everyone.'],
    ]),
    presets: Y.presets({ reserve: true, expire: true, grace: true, perUser: true }, [
      { id: 'dedupe-hit', label: 'Same photo from the phone and the tablet', desc: 'The phone backed up “Sunset” last week. The tablet’s copy has the same hash: it attaches to the existing bytes and sends nothing.', run: (s) => backup(s, 'tablet', 'sunset') },
      { id: 'reserve-two-devices', label: 'Two 600 MB videos, 900 MB left, reserved', desc: 'Both devices start at once. The phone’s reservation succeeds; the tablet’s would go past 15 GB, so it is refused: “Storage full”. Maya never goes over.', run: (s) => { backup(s, 'phone', 'video'); later(s, 20, (x) => backup(x, 'tablet', 'video2')); } },
      { id: 'check-then-charge', label: 'Two 600 MB videos, 900 MB left, check then charge', desc: 'Both devices check, both see 900 MB free, both upload, both are charged. Maya ends at 15.3 GB of 15.', sw: { reserve: false }, run: (s) => { backup(s, 'phone', 'video'); later(s, 20, (x) => backup(x, 'tablet', 'video2')); } },
      { id: 'aborted-reservation-expires', label: 'Phone dies after reserving, reservations expire', desc: 'The phone reserves 600 MB and dies mid-upload. Two seconds later the reservation is released, and the tablet’s 600 MB video fits.', run: (s) => { backup(s, 'phone', 'video'); later(s, 400, (x) => x.inject('phone', 'down')); later(s, 3000, (x) => backup(x, 'tablet', 'video2')); } },
      { id: 'aborted-reservation-leaks', label: 'Phone dies after reserving, no expiry', desc: 'Same, but the reservation stays. The tablet’s video is refused as “Storage full” although 900 MB are free.', sw: { expire: false }, run: (s) => { backup(s, 'phone', 'video'); later(s, 400, (x) => x.inject('phone', 'down')); later(s, 3000, (x) => backup(x, 'tablet', 'video2')); } },
      { id: 'gc-race', label: 'Delete on the phone while the tablet attaches, no grace', desc: 'The tablet checks “Sunset” and finds the bytes; a moment later the phone deletes its copy, the last reference, and the bytes are deleted at once. The tablet’s attach lands while they are going. The tablet’s new item points at bytes that are gone.', sw: { grace: false }, run: (s) => { backup(s, 'tablet', 'sunset'); later(s, 20, (x) => remove(x, 'phone', 'sunset')); } },
      { id: 'gc-grace', label: 'Delete on the phone while the tablet attaches, with grace', desc: 'Same race. The blob is only tombstoned when the phone’s reference goes; the tablet’s attach revives it, and the collector’s compare-and-set finds a reference and leaves it alone.', run: (s) => { backup(s, 'tablet', 'sunset'); later(s, 20, (x) => remove(x, 'phone', 'sunset')); } },
      { id: 'global-dedupe-leak', label: 'Omar uploads a file Maya has, global dedupe', desc: 'Omar’s copy of the concert ticket matches Maya’s blob. His upload finishes instantly with 0 bytes, which tells him someone already has that exact file.', sw: { perUser: false }, run: (s) => backup(s, 'omar', 'ticket') },
      { id: 'per-user-dedupe', label: 'Omar uploads a file Maya has, per-user dedupe', desc: 'Omar has no item with that hash, so he uploads the bytes like anyone else. Nothing leaks; the ticket is stored twice.', run: (s) => backup(s, 'omar', 'ticket') },
    ]),
    initialState: () => ({
      config: { reserve: true, expire: true, grace: true, perUser: true },
      users: { maya: { used: 14100, reserved: 0 }, omar: { used: 2000, reserved: 0 } },
      res: {},
      index: {
        'h-sunset': { refs: [{ user: 'maya', item: 'i1' }], state: 'live', zeroAt: null, size: 4 },
        'h-ticket': { refs: [{ user: 'maya', item: 'i2' }], state: 'live', zeroAt: null, size: 2 },
      },
      blobs: { 'h-sunset': 4, 'h-ticket': 2 },
      copies: { 'h-sunset': 1, 'h-ticket': 1 },
      items: { i1: { id: 'i1', user: 'maya', hash: 'h-sunset', name: 'Sunset' }, i2: { id: 'i2', user: 'maya', hash: 'h-ticket', name: 'Concert ticket' } },
      jobs: [], leaks: [],
      stats: { attached: 0, sentMB: 0, expired: 0, gcDeleted: 0, revived: 0 },
      seq: { job: 0, item: 2, res: 0 },
    }),
    initialUI: () => ({}),
    actions: {
      backup(sim, a) { backup(sim, a.dev, a.key); },
      remove(sim, a) { remove(sim, a.dev, a.key); },
    },
    handlers: {
      gateway: {
        check: function* (ctx, p) { return ctx.must(yield ctx.call('library', 'check', p, { timeout: 1000 })); },
        attach: function* (ctx, p) { return ctx.must(yield ctx.call('library', 'attach', p, { timeout: 1000 })); },
        delete: function* (ctx, p) { return ctx.must(yield ctx.call('library', 'delete', p, { timeout: 1000 })); },
        reserve: function* (ctx, p) { return ctx.must(yield ctx.call('quota', 'reserve', p, { timeout: 1000 })); },
        checkQuota: function* (ctx, p) { return ctx.must(yield ctx.call('quota', 'check', p, { timeout: 1000 })); },
        put: function* (ctx, p) { return ctx.must(yield ctx.call('upload', 'put', p, { timeout: 3500 })); },
        commit: function* (ctx, p) { return ctx.must(yield ctx.call('upload', 'commit', p, { timeout: 1000 })); },
      },
      library: {
        check: function* (ctx, p) { return ctx.must(yield ctx.call('blobindex', 'lookup', p, { timeout: 800 })); },
        attach: function* (ctx, p) {
          ctx.must(yield ctx.call('quota', 'charge', { user: p.user, size: p.size }, { timeout: 800 }));
          const r = yield ctx.call('blobindex', 'addRef', p, { timeout: 800 });
          if (!r.ok) { yield ctx.call('quota', 'credit', { user: p.user, size: p.size }, { timeout: 800 }); ctx.must(r); }
          return r.value;
        },
        delete: function* (ctx, p) {
          const r = ctx.must(yield ctx.call('blobindex', 'removeRef', p, { timeout: 800 }));
          yield ctx.call('quota', 'credit', { user: p.user, size: r.size }, { timeout: 800 });
          return r;
        },
      },
      upload: {
        put: function* (ctx, p) {
          yield ctx.wait(p.size * MB_MS);
          ctx.must(yield ctx.call('blob', 'put', p, { timeout: 1000 }));
          return { ok: true };
        },
        commit: function* (ctx, p) {
          const st = ctx.state;
          if (p.res) ctx.must(yield ctx.call('quota', 'commit', { res: p.res }, { timeout: 800 }));
          else ctx.must(yield ctx.call('quota', 'chargeBlind', { user: p.user, size: p.size }, { timeout: 800 }));
          const r = ctx.must(yield ctx.call('blobindex', 'create', p, { timeout: 800 }));
          void st;
          return r;
        },
      },
      quota: {
        reserve: function* (ctx, p) {
          const st = ctx.state;
          const id = `r${++st.seq.res}`;
          ctx.must(yield ctx.call('counters', 'reserve', { user: p.user, size: p.size }, { timeout: 800 }));
          st.res[id] = { id, user: p.user, size: p.size, dev: p.dev, t: ctx.now() };
          return { res: id };
        },
        check: function* (ctx, p) { return ctx.must(yield ctx.call('counters', 'check', p, { timeout: 800 })); },
        commit: function* (ctx, p) {
          const st = ctx.state;
          const r = st.res[p.res];
          if (!r) ctx.fail('EXPIRED', 'The reservation expired.');
          delete st.res[p.res];
          return ctx.must(yield ctx.call('counters', 'commit', { user: r.user, size: r.size }, { timeout: 800 }));
        },
        charge: function* (ctx, p) { return ctx.must(yield ctx.call('counters', 'add', Object.assign({ checked: true }, p), { timeout: 800 })); },
        chargeBlind: function* (ctx, p) { return ctx.must(yield ctx.call('counters', 'add', Object.assign({ checked: false }, p), { timeout: 800 })); },
        credit: function* (ctx, p) { return ctx.must(yield ctx.call('counters', 'add', { user: p.user, size: -p.size, checked: false }, { timeout: 800 })); },
      },
      counters: {
        reserve(ctx, p) {
          const u = ctx.state.users[p.user];
          if (u.used + u.reserved + p.size > LIMIT) ctx.fail('QUOTA', `${u.used + u.reserved} of ${LIMIT} MB used or reserved; ${p.size} MB does not fit.`);
          u.reserved += p.size;
          return { ok: true };
        },
        check(ctx, p) {
          const u = ctx.state.users[p.user];
          if (u.used + u.reserved + p.size > LIMIT) ctx.fail('QUOTA', `${p.size} MB does not fit.`);
          return { ok: true };
        },
        commit(ctx, p) { const u = ctx.state.users[p.user]; u.reserved -= p.size; u.used += p.size; return { used: u.used }; },
        release(ctx, p) { const u = ctx.state.users[p.user]; u.reserved = Math.max(0, u.reserved - p.size); return { ok: true }; },
        add(ctx, p) {
          const u = ctx.state.users[p.user];
          if (p.checked && u.used + u.reserved + p.size > LIMIT) ctx.fail('QUOTA', `${p.size} MB does not fit.`);
          u.used += p.size;
          return { used: u.used };
        },
      },
      blobindex: {
        lookup(ctx, p) {
          const st = ctx.state;
          const b = st.index[p.hash];
          if (!b || b.state === 'deleting') return { exists: false };
          if (st.config.perUser) return { exists: b.refs.some((r) => r.user === p.user), others: false };
          return { exists: true, others: !b.refs.some((r) => r.user === p.user) };
        },
        addRef(ctx, p) {
          const st = ctx.state;
          const b = st.index[p.hash];
          if (!b || b.state === 'deleting') ctx.fail('NOT_FOUND', 'The blob is gone or being deleted.');
          const id = `i${++st.seq.item}`;
          st.items[id] = { id, user: p.user, hash: p.hash, name: p.name, dev: p.dev };
          b.refs.push({ user: p.user, item: id });
          if (b.zeroAt != null) { st.stats.revived++; ctx.log({ op: `${p.hash} revived`, status: 'recovered', actionId: ctx.actionId, detail: 'The blob was tombstoned with no references; this attach brings it back before the grace period ends.' }); }
          b.zeroAt = null; b.state = 'live';
          return { id };
        },
        create(ctx, p) {
          const st = ctx.state;
          const id = `i${++st.seq.item}`;
          st.items[id] = { id, user: p.user, hash: p.hash, name: p.name, dev: p.dev };
          const b = st.index[p.hash];
          if (b && b.state !== 'deleting') { b.refs.push({ user: p.user, item: id }); b.zeroAt = null; b.state = 'live'; }
          else st.index[p.hash] = { refs: [{ user: p.user, item: id }], state: 'live', zeroAt: null, size: p.size };
          return { id };
        },
        removeRef(ctx, p) {
          const st = ctx.state;
          const b = st.index[p.hash];
          if (!b) ctx.fail('NOT_FOUND', 'No such blob.');
          const i = b.refs.findIndex((r) => r.user === p.user);
          if (i < 0) ctx.fail('NOT_FOUND', 'No reference for this user.');
          const [r] = b.refs.splice(i, 1);
          delete st.items[r.item];
          if (!b.refs.length) {
            b.zeroAt = ctx.now(); b.state = 'tombstoned';
            // Without a grace period, the count reaching zero deletes the bytes straight away.
            if (!st.config.grace && !ctx.sim.nodes.gc.modes.paused) ctx.spawn((c) => collect(c, p.hash), { self: 'gc' });
          }
          return { refs: b.refs.length, size: b.size };
        },
        claim(ctx, p) {
          const b = ctx.state.index[p.hash];
          if (!b || b.refs.length) ctx.fail('CONFLICT', 'The blob has references again.');
          b.state = 'deleting';
          return { ok: true };
        },
        forget(ctx, p) {
          const st = ctx.state;
          const b = st.index[p.hash];
          if (!b) return { ok: true };
          if (st.config.grace) { if (b.state === 'deleting') delete st.index[p.hash]; }
          else delete st.index[p.hash]; // removed outright, references and all
          return { ok: true };
        },
      },
      blob: {
        put(ctx, p) { const st = ctx.state; if (st.blobs[p.hash]) st.copies[p.hash] = (st.copies[p.hash] || 1) + 1; else { st.blobs[p.hash] = p.size; st.copies[p.hash] = 1; } return { ok: true }; },
        delete: function* (ctx, p) { yield ctx.wait(300); delete ctx.state.blobs[p.hash]; delete ctx.state.copies[p.hash]; return { ok: true }; },
      },
    },
    setup(sim) {
      // Garbage collector.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(100);
          if (ctx.sim.nodes.gc.modes.paused) continue;
          const st = ctx.state;
          if (!st.config.grace) continue;
          for (const [hash, b] of Object.entries(st.index)) {
            if (b.refs.length || b.state === 'deleting') continue;
            if (ctx.now() - b.zeroAt < GRACE) continue;
            const c = yield ctx.call('blobindex', 'claim', { hash }, { timeout: 800 });
            if (!c.ok) continue;
            yield* collect(ctx, hash, true);
          }
        }
      }, { self: 'gc' });
      // Reservation expiry.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(200);
          const st = ctx.state;
          if (!st.config.expire) continue;
          for (const r of Object.values(st.res)) {
            if (ctx.now() - r.t < TTL) continue;
            delete st.res[r.id];
            const x = yield ctx.call('counters', 'release', { user: r.user, size: r.size }, { timeout: 800 });
            if (x.ok) { st.stats.expired++; ctx.log({ op: `reservation ${r.id} expired`, status: 'recovered', detail: `${r.size} MB held for the ${r.dev} for ${TTL / 1000} s and never committed. Released.` }); }
          }
        }
      }, { self: 'quota', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const broken = Object.values(st.items).find((x) => !st.blobs[x.hash]);
      if (broken) return { key: 'wrong', label: `The ${broken.dev || 'new'} item “${broken.name}” points at bytes the garbage collector deleted. It attached while the blob was being removed, so the photo cannot be shown.` };
      const over = Object.entries(st.users).find(([, u]) => u.used > LIMIT);
      if (over) return { key: 'wrong', label: `${over[0] === 'maya' ? 'Maya' : 'Omar'} is at ${(over[1].used / 1000).toFixed(1)} GB of 15 GB. Both devices checked, both fit at the time, both were charged.` };
      if (st.leaks.length) return { key: 'wrong', label: 'Omar’s upload of the concert ticket finished instantly with 0 bytes sent. That tells him another account already has this exact file: dedupe across users is a side channel.' };
      const stuck = Object.values(st.res).find((r) => dead(sim, r.dev) && !st.config.expire);
      if (stuck) return { key: 'stale', label: `${stuck.size} MB is still reserved for a phone that died. Maya’s meter shows ${((LIMIT - st.users.maya.used - st.users.maya.reserved) / 1000).toFixed(1)} GB free; ${((LIMIT - st.users.maya.used) / 1000).toFixed(1)} GB really is.` };
      const moving = st.jobs.filter((j) => ['checking', 'attaching', 'reserving', 'uploading'].includes(j.state) && !dead(sim, j.dev));
      if (moving.length) return { key: 'stale', label: `${moving.length} backup${moving.length > 1 ? 's' : ''} in progress.` };
      if (st.stats.revived) return { key: 'ok', label: 'The tablet’s attach revived the tombstoned blob, and the collector’s compare-and-set found a reference and left the bytes alone.' };
      const full = st.jobs.find((j) => j.state === 'full');
      if (full) return { key: 'ok', label: `The ${full.dev}’s video was refused with “Storage full”. Reservations are conditional, so the two uploads could not both take the last 900 MB.` };
      if (st.stats.expired) return { key: 'ok', label: 'The dead phone’s reservation expired and was released, so the tablet’s video fitted. No one was charged for bytes that never arrived.' };
      const omar = st.jobs.find((j) => j.user === 'omar' && j.state === 'backed');
      if (omar) return { key: 'ok', label: `Omar uploaded his own copy: nothing about other accounts leaked. The ticket is now stored ${st.copies['h-ticket']} times, which is the price.` };
      if (st.stats.attached) return { key: 'ok', label: 'The tablet attached to the bytes the phone uploaded last week: a new item, 0 bytes sent, charged once to the item.' };
      return { key: 'ok', label: 'Every item has its bytes and nobody is over quota.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const m = st.users.maya;
      return [
        { label: 'Maya used', value: `${(m.used / 1000).toFixed(2)} GB`, tone: m.used > LIMIT ? 'fail' : '' },
        { label: 'Maya reserved', value: `${m.reserved} MB`, tone: m.reserved && Object.values(st.res).some((r) => dead(sim, r.dev)) ? 'warn' : '' },
        { label: 'Omar used', value: `${(st.users.omar.used / 1000).toFixed(2)} GB` },
        { label: 'Bytes sent', value: `${st.stats.sentMB} MB` },
        { label: 'Dedupe attaches', value: st.stats.attached },
        { label: 'Blobs on disk', value: Object.keys(st.blobs).length },
        { label: 'Items without bytes', value: Object.values(st.items).filter((x) => !st.blobs[x.hash]).length, tone: Object.values(st.items).some((x) => !st.blobs[x.hash]) ? 'fail' : '' },
        { label: 'Reservations expired', value: st.stats.expired },
        { label: 'Blobs collected', value: st.stats.gcDeleted },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone'], ['tablet', 'Maya’s tablet'], ['omar', 'Omar’s phone']], {
          note: 'Maya’s two devices share one 15 GB quota with 0.9 GB left. The meter shows charged and reserved space separately.',
          below: '<div class="ops-console" data-ref="status"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const meter = (user) => {
          const u = st.users[user];
          const usedPct = Math.min(100, (u.used / LIMIT) * 100);
          const resPct = Math.min(100 - usedPct, (u.reserved / LIMIT) * 100);
          const over = u.used > LIMIT;
          return `<div style="height:10px;border-radius:5px;background:var(--line,#8884);overflow:hidden;display:flex" role="img" aria-label="${(u.used / 1000).toFixed(2)} GB used, ${u.reserved} MB reserved"><i style="width:${usedPct}%;background:${over ? 'var(--fail)' : 'var(--accent,#46c)'}"></i><i style="width:${resPct}%;background:var(--warn)"></i></div><p class="app-sub">${over ? '✕ ' : ''}${(u.used / 1000).toFixed(2)} GB of 15 GB${u.reserved ? ` · ${u.reserved} MB reserved` : ''}</p>`;
        };
        const jobs = (d) => st.jobs.filter((j) => j.dev === d).slice(-3).reverse().map((j) => {
          const f = FILES[j.key];
          const tone = j.state === 'backed' ? 'is-ok' : j.state === 'full' || j.state === 'dead' ? 'is-fail' : 'is-work';
          const label = { checking: 'Checking…', attaching: 'Attaching…', reserving: 'Reserving space…', uploading: 'Uploading…', backed: j.note, full: '✕ Storage full', dead: 'Stopped: device died', waiting: j.note }[j.state];
          return `<div class="app-card ${tone}"><strong>${f.glyph} ${esc(f.name)} · ${f.size} MB</strong><span class="app-sub">${esc(label || '')}</span></div>`;
        }).join('');
        const btns = {
          phone: [Y.btn('backup', 'Back up Beach.mp4 (600 MB)', { arg: { dev: 'phone', key: 'video' }, disabled: dead(sim, 'phone') }), Y.btn('remove', 'Delete “Sunset”', { arg: { dev: 'phone', key: 'sunset' }, cls: 'secondary', disabled: dead(sim, 'phone') || !Object.values(st.items).some((x) => x.user === 'maya' && x.hash === 'h-sunset') })],
          tablet: [Y.btn('backup', 'Back up Concert.mp4 (600 MB)', { arg: { dev: 'tablet', key: 'video2' }, disabled: dead(sim, 'tablet') }), Y.btn('backup', 'Back up its “Sunset”', { arg: { dev: 'tablet', key: 'sunset' }, cls: 'secondary', disabled: dead(sim, 'tablet') })],
          omar: [Y.btn('backup', 'Back up “Concert ticket”', { arg: { dev: 'omar', key: 'ticket' } })],
        };
        for (const d of ['phone', 'tablet', 'omar']) {
          Y.paint(el, sim, d, {
            head: `<div><p class="app-title">Backup</p><p class="app-sub">${OWNER[d] === 'maya' ? 'Maya’s account' : 'Omar’s account'}</p></div>`,
            meter: meter(OWNER[d]),
            ctl: `<div class="app-row" style="flex-wrap:wrap">${btns[d].join('')}</div>`,
            jobs: jobs(d) || '<p class="app-sub">Nothing backing up.</p>',
          }, {});
        }
        const c = sim.scenario.consistency(sim);
        const idx = Object.entries(st.index).map(([h, b]) => `${h}: ${b.refs.length} ref${b.refs.length === 1 ? '' : 's'}${b.state !== 'live' ? ` (${b.state})` : ''}`).join(' · ');
        const rows = `<div class="ops-shards">
          <div class="ops-row"><div class="ops-name">Blob index<span>${esc(idx || 'empty')}</span></div></div>
          <div class="ops-row" data-tone="${Object.keys(st.res).length ? 'warn' : ''}"><div class="ops-name">Reservations<span>${Object.values(st.res).map((r) => `${r.id}: ${r.size} MB for the ${r.dev}`).join(' · ') || 'none'}</span></div></div></div>`;
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
