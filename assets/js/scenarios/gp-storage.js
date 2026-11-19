/*
 * Storage tiers, erasure coding, and repair.
 * New photos keep three full copies. Once a photo is old enough the tier mover
 * encodes it into 4 data + 2 parity chunks (Reed–Solomon 4+2 on screen; real
 * systems use wider codes such as 10+4), verifies them, flips the metadata
 * pointer, and only then deletes the copies. Any 4 of the 6 chunks rebuild the
 * photo. Repair rebuilds lost chunks; a scrubber finds silent corruption with
 * checksums; rack-aware placement keeps a rack failure survivable.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const SERVERS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'];
  const RACK = { s1: 'A', s2: 'A', s3: 'A', s4: 'B', s5: 'B', s6: 'B', s7: 'C', s8: 'C', s9: 'C' };
  const K = 4; const M = 2; const N = K + M;
  const REPAIR_DELAY = 1000; // a server down this long is treated as lost
  const SLOW_OPEN = 600;
  const PHOTOS = {
    lake: { name: 'Lake, 2014', hue: 160, glyph: '🏞' },
    ramen: { name: 'Ramen, March', hue: 45, glyph: '🍜' },
    dog: { name: 'Dog, today', hue: 200, glyph: '🐕' },
  };

  const down = (sim, s) => !!(sim.nodes[s].modes.down || sim.nodes[s].modes.rack);

  /** Choose servers for a stripe. Rack-aware: at most 2 chunks per rack, spread round-robin. Packed: fill in order. */
  function place(sim, avoid) {
    const st = sim.state;
    const ok = SERVERS.filter((s) => !down(sim, s) && !(avoid || []).includes(s));
    if (!st.config.rackAware) return ok.slice(0, N);
    const out = []; const per = {};
    for (let round = 0; out.length < N && round < 3; round++) {
      for (const r of ['A', 'B', 'C']) {
        const s = ok.find((x) => RACK[x] === r && !out.includes(x));
        if (s && (per[r] || 0) < 2 && out.length < N) { out.push(s); per[r] = (per[r] || 0) + 1; }
      }
    }
    return out;
  }
  function stripeFor(sim, avoid) { return place(sim, avoid).map((srv, i) => ({ i, srv, written: true, corrupt: false, gone: false, bad: false })); }

  /** A chunk that can still contribute to a rebuild (temporarily down servers count). */
  const usable = (c) => c.written && !c.gone && !c.bad && !c.corrupt;
  /** What the system believes: unnoticed corruption still looks healthy. */
  const known = (c) => c.written && !c.gone && !c.bad;

  function open(sim, id) {
    const st = sim.state;
    sim.ui.laptop.view = { id, state: 'loading', t: sim.now };
    sim.startAction(`Laptop: open “${PHOTOS[id].name}”`, function* (ctx) {
      const r = yield ctx.call('read', 'open', { id }, { timeout: 8000 });
      const v = ctx.ui.laptop.view;
      if (v.id !== id) return;
      v.ms = ctx.now() - v.t;
      if (!r.ok) {
        v.state = 'unavailable';
        st.opens.push({ id, ok: false, ms: v.ms });
        Y.failed(ctx, `${r.error.code}: ${r.error.message}`);
        ctx.explain(`The photo could not be read: ${r.error.message}`);
        return;
      }
      v.state = r.value.damaged ? 'damaged' : 'ok';
      v.via = r.value.via;
      st.opens.push({ id, ok: !r.value.damaged, damaged: !!r.value.damaged, ms: v.ms, via: r.value.via });
      if (r.value.damaged) st.damaged.push(id);
      Y.L(ctx, { displayed: [r.value.damaged ? 'no' : 'yes', r.value.damaged ? 'Shown with corrupted bytes.' : `Shown after ${SDL.fmtMs(v.ms)}.`], committed: ['n/a', 'Read only.'] });
      ctx.explain({ copy: 'Read one of the three full copies.', chunk: 'Read the data chunk that holds the photo: one server, one read.', rebuilt: 'The data chunk was unavailable, so the read fetched four other chunks and rebuilt the photo (a degraded read).', waited: 'The data chunk was unavailable and degraded reads are off, so the read waited for repair.' }[r.value.via] + (r.value.damaged ? ' Nothing checked the bytes: the photo is shown corrupted.' : ''));
    }, { self: 'laptop' });
  }

  /** Every guided scenario starts from the same three photos (the mover may already have moved Ramen). */
  function fresh(list) {
    return list.map((p) => Object.assign({}, p, {
      run(s) {
        const init = s.scenario.initialState();
        for (const k of ['photos', 'downSince', 'opens', 'damaged', 'stats']) s.state[k] = init[k];
        if (!s.state.config.rackAware) s.state.photos.lake.stripe = stripeFor(s);
        s.ui.laptop.view = null;
        p.run(s);
      },
    }));
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'laptop', quiet: 'all' });

  const serverHandlers = (s) => ({
    get(ctx, p) {
      const ph = ctx.state.photos[p.id];
      if (!ph.hot.includes(s)) ctx.fail('NOT_FOUND', 'No copy here.');
      return { ok: true };
    },
    chunk(ctx, p) {
      const ph = ctx.state.photos[p.id];
      const c = (p.pending ? ph.pending || [] : ph.stripe)[p.i];
      if (!c || c.srv !== s || !c.written || c.gone) ctx.fail('NOT_FOUND', `No chunk ${p.i} of ${p.id} here.`);
      return { corrupt: c.corrupt };
    },
    put(ctx) { return { ok: true }; },
    del(ctx) { return { ok: true }; },
  });

  const handlers = {
    read: {
      open: function* (ctx, p) {
        const st = ctx.state;
        const meta = ctx.must(yield ctx.call('metadb', 'get', p, { timeout: 800 }));
        const ph = st.photos[p.id];
        if (meta.tier === 'hot') {
          for (const s of meta.hot) {
            const r = yield ctx.call(s, 'get', p, { timeout: 600 });
            if (r.ok) return { via: 'copy' };
          }
          ctx.fail('UNAVAILABLE', 'No full copy could be read.');
        }
        const readChunk = function* (c) {
          const r = yield ctx.call(c.srv, 'chunk', { id: p.id, i: c.i }, { timeout: 600 });
          if (!r.ok) return { ok: false };
          if (r.value.corrupt && st.config.checksums) {
            c.bad = true; c.corrupt = false; st.stats.caught++;
            ctx.log({ op: `chunk ${c.i} of ${p.id}: checksum mismatch`, status: 'fault', actionId: ctx.actionId, detail: `The bytes on ${c.srv} do not match their checksum. Treated as missing; repair will rebuild it.` });
            return { ok: false };
          }
          return { ok: true, corrupt: r.value.corrupt };
        };
        const data = ph.stripe[ph.dataIdx];
        const first = yield* readChunk(data);
        if (first.ok) return { via: 'chunk', damaged: first.corrupt };
        if (!st.config.degraded) {
          // Wait for repair to put the data chunk back.
          for (let a = 0; a < 20; a++) {
            yield ctx.wait(300);
            const r = yield* readChunk(ph.stripe[ph.dataIdx]);
            if (r.ok) return { via: 'waited', damaged: r.corrupt };
          }
          ctx.fail('UNAVAILABLE', 'The data chunk never came back.');
        }
        let got = 0; let damaged = false;
        for (const c of ph.stripe.filter((x) => x !== data)) {
          if (got >= K) break;
          const r = yield* readChunk(c);
          if (r.ok) { got++; damaged = damaged || r.corrupt; }
        }
        if (got < K) ctx.fail('UNAVAILABLE', `Only ${got} of the ${K} chunks needed could be read.`);
        yield ctx.wait(30); // decode
        st.stats.degradedReads++;
        return { via: 'rebuilt', damaged };
      },
    },
    metadb: {
      get(ctx, p) { const ph = ctx.state.photos[p.id]; return { tier: ph.tier, hot: ph.hot.slice() }; },
      flip(ctx, p) { const ph = ctx.state.photos[p.id]; ph.tier = 'warm'; return { ok: true }; },
    },
    daemons: {},
  };
  for (const s of SERVERS) handlers[s] = serverHandlers(s);

  /* ---------- background daemons ---------- */
  function* mover(ctx) {
    for (;;) {
      yield ctx.wait(300);
      const st = ctx.state;
      if (ctx.sim.nodes.daemons.modes.down) continue;
      const id = Object.keys(st.photos).find((k) => st.photos[k].tier === 'hot' && st.photos[k].old);
      if (!id) continue;
      const ph = st.photos[id];
      const crash = (step) => {
        if (!ctx.mode('crashMid', 'daemons')) return false;
        ctx.sim.restore('daemons', 'crashMid');
        ctx.sim.inject('daemons', 'down', true, 1000);
        st.stats.moverCrashes++;
        ctx.log({ op: `tier mover crashed ${step}`, status: 'fault', detail: 'The process died mid-migration and restarts in a second.' });
        return true;
      };
      const stripe = stripeFor(ctx.sim).map((c) => Object.assign(c, { written: false }));
      if (stripe.length < N) {
        if (!ph.waitLogged) { ph.waitLogged = true; ctx.log({ op: `${id} stays hot for now`, status: 'warn', detail: `Only ${stripe.length} servers can take a chunk within the placement rules; a stripe needs ${N}. The three copies stay until there is room.` }); }
        continue;
      }
      ctx.log({ op: `move ${id} to the warm tier`, status: 'note', detail: `Encode into ${K} data + ${M} parity chunks on ${stripe.map((c) => c.srv).join(', ')}.` });
      if (st.config.verifyFirst) {
        // Copy, verify, flip, then delete.
        ph.pending = stripe;
        let n = 0;
        for (const c of stripe) {
          const r = yield ctx.call(c.srv, 'put', { id, i: c.i }, { timeout: 600 });
          if (r.ok) c.written = true;
          if (++n === 2 && crash('after writing 2 of 6 chunks')) break;
        }
        if (ctx.sim.nodes.daemons.modes.down) { ph.pending = null; continue; }
        if (stripe.some((c) => !c.written)) { ph.pending = null; continue; }
        let verified = true;
        for (const c of stripe) { const r = yield ctx.call(c.srv, 'chunk', { id, i: c.i, pending: true }, { timeout: 600 }); if (!r.ok) verified = false; }
        if (!verified) { ph.pending = null; continue; }
        if (st.photos[id] !== ph) continue; // a guided scenario reset the library mid-migration
        ph.stripe = stripe; ph.pending = null;
        ctx.must(yield ctx.call('metadb', 'flip', { id }, { timeout: 600 }));
        const old = ph.hot.slice();
        ph.hot = [];
        for (const s of old) yield ctx.call(s, 'del', { id }, { timeout: 600 });
        st.stats.moved++;
        ctx.log({ op: `${id} is warm`, status: 'recovered', detail: 'All six chunks written and read back; the pointer was flipped; then the three copies were deleted.' });
      } else {
        // Flip first, delete copies, then write: a crash in between loses the photo.
        if (st.photos[id] !== ph) continue;
        ph.stripe = stripe;
        ctx.must(yield ctx.call('metadb', 'flip', { id }, { timeout: 600 }));
        const old = ph.hot.slice();
        ph.hot = [];
        for (const s of old) yield ctx.call(s, 'del', { id }, { timeout: 600 });
        let n = 0;
        let died = false;
        for (const c of stripe) {
          const r = yield ctx.call(c.srv, 'put', { id, i: c.i }, { timeout: 600 });
          if (r.ok) c.written = true;
          if (++n === 2 && crash('after flipping the pointer, deleting the copies, and writing 2 of 6 chunks')) { died = true; break; }
        }
        if (!died) st.stats.moved++;
      }
    }
  }

  function pickTarget(sim, stripe) {
    const st = sim.state;
    const used = stripe.filter((c) => usable(c) || !c.written).map((c) => c.srv);
    const free = SERVERS.filter((s) => !down(sim, s) && !used.includes(s));
    if (!free.length) return null;
    if (st.config.rackAware) {
      const per = {};
      for (const s of used) per[RACK[s]] = (per[RACK[s]] || 0) + 1;
      const good = free.find((s) => (per[RACK[s]] || 0) < 2);
      if (good) return { s: good, relaxed: false };
    }
    return { s: free[0], relaxed: st.config.rackAware };
  }

  function* repair(ctx) {
    let lastScrub = 0;
    for (;;) {
      yield ctx.wait(200);
      const st = ctx.state;
      const sim = ctx.sim;
      if (sim.nodes.daemons.modes.down || sim.nodes.daemons.modes.repairPaused) continue;
      // Scrub: read every chunk's checksum once a second.
      if (st.config.checksums && ctx.now() - lastScrub >= 1000) {
        lastScrub = ctx.now();
        for (const [id, ph] of Object.entries(st.photos)) {
          if (ph.tier !== 'warm') continue;
          for (const c of ph.stripe) {
            if (!usable(c) && !c.corrupt) continue;
            if (down(sim, c.srv)) continue;
            if (c.corrupt) {
              const r = yield ctx.call(c.srv, 'chunk', { id, i: c.i }, { timeout: 600 });
              if (r.ok && r.value.corrupt) { c.bad = true; c.corrupt = false; st.stats.caught++; ctx.log({ op: `scrub: chunk ${c.i} of ${id} is corrupt`, status: 'fault', detail: `Checksum mismatch on ${c.srv}. Marked bad; repair rebuilds it from the other chunks.` }); }
            }
          }
        }
      }
      // Re-replicate hot copies.
      for (const [id, ph] of Object.entries(st.photos)) {
        if (ph.tier !== 'hot') continue;
        const alive = ph.hot.filter((s) => !(down(sim, s) && ctx.now() - (st.downSince[s] || 0) >= REPAIR_DELAY));
        if (alive.length >= 3 || !alive.length) continue;
        const target = SERVERS.find((s) => !down(sim, s) && !alive.includes(s));
        if (!target) continue;
        const r = yield ctx.call(target, 'put', { id, copy: true }, { timeout: 600 });
        if (r.ok) { ph.hot = alive.concat(target); st.stats.copies++; ctx.log({ op: `copy of ${id} recreated on ${target}`, status: 'recovered', detail: 'A full copy was lost; a new one was made from a surviving copy.' }); }
      }
      // Rebuild lost chunks.
      for (const [id, ph] of Object.entries(st.photos)) {
        if (ph.tier !== 'warm') continue;
        for (const c of ph.stripe) {
          const lost = c.written && (c.gone || c.bad || (down(sim, c.srv) && ctx.now() - (st.downSince[c.srv] || 0) >= REPAIR_DELAY));
          if (!lost) continue;
          const sources = ph.stripe.filter((x) => x !== c && usable(x) && !down(sim, x.srv)).slice(0, K);
          if (sources.length < K) continue;
          const t = pickTarget(sim, ph.stripe);
          if (!t) continue;
          let okReads = 0;
          for (const x of sources) { const r = yield ctx.call(x.srv, 'chunk', { id, i: x.i }, { timeout: 600, quiet: 'all' }); if (r.ok) okReads++; }
          if (okReads < K) continue;
          const w = yield ctx.call(t.s, 'put', { id, i: c.i }, { timeout: 600 });
          if (!w.ok) continue;
          const from = c.srv;
          Object.assign(c, { srv: t.s, gone: false, bad: false, corrupt: false, written: true });
          st.stats.repaired++; st.stats.repairReadMB += K;
          ctx.log({ op: `rebuilt chunk ${c.i} of ${id} on ${t.s}`, status: 'recovered', detail: `Read ${K} chunks (${K} MB) to rebuild 1 MB that was on ${from}.${t.relaxed ? ' No server in a rack with room was left, so the rack limit is relaxed until rack hardware is replaced.' : ''}` });
        }
      }
    }
  }

  const sc = (SDL.scenarios['gp-storage'] = {
    id: 'gp-storage',
    seed: 1907,
    minHopMs: 5,
    productWidth: 760,
    intro: 'Three photos on nine servers in three racks. “Dog” is new and has three full copies; “Ramen” is old enough to move; “Lake” is already erasure-coded into six chunks, any four of which rebuild it. Open photos while servers, racks, and disks fail.',
    topology: {
      width: 1160, height: 600,
      nodes: [
        { id: 'laptop', label: 'Maya’s laptop', sub: 'Opens photos', kind: 'client', x: 90, y: 300, latency: 1, role: 'Opens a photo from 2014, one from March, and one from today.', owns: ['Nothing'] },
        { id: 'read', label: 'Read service', sub: 'Copy, chunk, or rebuild', kind: 'gateway', x: 280, y: 300, latency: 3, role: 'Looks up where a photo lives, reads a copy or its data chunk, and rebuilds from any four chunks when the data chunk is unavailable.', ops: [{ name: 'open', desc: 'Read a photo.' }], owns: ['Nothing durable'] },
        { id: 'metadb', label: 'Metadata store', sub: 'Tier + pointer', kind: 'db', x: 450, y: 150, latency: 5, role: 'For each photo: hot (three copies) or warm (six chunks), and where they are. The pointer flip is what moves a photo between tiers.', ops: [{ name: 'get', desc: 'Where is this photo?' }, { name: 'flip', desc: 'Point at the chunks.' }], owns: ['tier[photo]'] },
        { id: 'daemons', label: 'Storage daemons', sub: 'Mover, repair, scrub', kind: 'worker', x: 450, y: 450, latency: 2, role: `Tier mover (copy, verify, flip, delete), repair (rebuild a chunk from any ${K} others, after a server has been gone ${REPAIR_DELAY / 1000} s), and a checksum scrubber.`, owns: ['Repair queue', 'Scrub schedule'] },
        ...SERVERS.map((s, i) => ({ id: s, label: `Server ${s.slice(1)}`, sub: `Rack ${RACK[s]}`, kind: 'store', x: 640 + Math.floor(i / 3) * 170, y: 120 + (i % 3) * 180, latency: 6, role: `A storage server in rack ${RACK[s]}. Holds full copies and chunks.`, ops: [{ name: 'chunk', desc: 'Read a chunk.' }, { name: 'put', desc: 'Write a chunk or copy.' }], owns: ['chunks', 'copies'] })),
      ],
      edges: [
        { from: 'laptop', to: 'read', latency: 20 },
        { from: 'read', to: 'metadb', latency: 3 },
        { from: 'daemons', to: 'metadb', latency: 3 },
        ...SERVERS.map((s) => ({ from: 'read', to: s, latency: 3 })),
        ...SERVERS.map((s) => ({ from: 'daemons', to: s, latency: 3 })),
      ],
      queues: [],
    },
    modeLabels: { rack: 'Rack destroyed', rot: 'Bit rot', crashMid: 'Crashes mid-migration', repairPaused: 'Repair paused' },
    failures: [
      { id: 's1-down', node: 's1', mode: 'down', label: 'Server 1 down', desc: 'Holds Lake’s data chunk. Reads must rebuild or wait; after a second repair treats it as lost.' },
      { id: 's4-down', node: 's4', mode: 'down', label: 'Server 4 down', desc: 'A second server in another rack.' },
      { id: 'rack-a', node: 's1', mode: 'rack', label: 'Rack A destroyed (servers 1–3)', desc: 'A rack loses power and its disks: every chunk and copy on servers 1, 2, and 3 is gone.' },
      { id: 'rot', node: 's1', mode: 'rot', label: 'Bit rot on server 1', desc: 'A disk silently flips bits in the chunks it holds. Only a checksum notices.' },
      { id: 'mover-crash', node: 'daemons', mode: 'crashMid', label: 'Tier mover crashes mid-migration', desc: 'The next migration dies part-way through and the process restarts.' },
      { id: 'repair-paused', node: 'daemons', mode: 'repairPaused', label: 'Repair paused', desc: 'Lost chunks are not rebuilt; every further failure eats into the margin.' },
      { id: 's7-slow', node: 's7', mode: 'slow', params: { factor: 30 }, label: 'Server 7 slow', desc: 'A slow disk: every read that touches it waits.' },
      { id: 'meta-slow', node: 'metadb', mode: 'slow', params: { factor: 20 }, label: 'Metadata store slow', desc: 'Every open waits for the pointer lookup.' },
    ],
    onFailureChange(sim, f) {
      const st = sim.state;
      if (f.mode === 'down' || f.mode === 'rack') { if (f.active) st.downSince[f.node] = sim.now; else delete st.downSince[f.node]; }
      if (f.mode === 'rack') {
        const rack = SERVERS.filter((s) => RACK[s] === RACK[f.node] && s !== f.node);
        if (f.active) {
          for (const s of rack) sim.inject(s, 'down');
          for (const s of [f.node, ...rack]) {
            for (const ph of Object.values(st.photos)) {
              for (const c of ph.stripe) if (c.srv === s) c.gone = true;
              ph.hot = ph.hot.filter((x) => x !== s);
            }
          }
        } else for (const s of rack) sim.restore(s, 'down');
      }
      if (f.mode === 'rot' && f.active) {
        for (const ph of Object.values(st.photos)) for (const c of ph.stripe) if (c.srv === f.node && usable(c)) c.corrupt = true;
      }
    },
    switches: Y.switches([
      ['verifyFirst', 'Copy, verify, flip, then delete', 'The mover writes all chunks and reads them back before pointing metadata at them, and deletes the copies last. Off: flip the pointer and delete the copies first, then write the chunks.'],
      ['rackAware', 'Rack-aware placement', 'At most two of the six chunks in any rack, so losing a rack loses at most two. Off: fill servers in order, which can put three in one rack. Re-lays out existing stripes.', (s) => { for (const ph of Object.values(s.state.photos)) if (ph.tier === 'warm') ph.stripe = stripeFor(s); }],
      ['checksums', 'Checksums and scrubbing', 'Every chunk carries a checksum, checked on read and by a scrubber once a second. Off: whatever the disk returns is used.'],
      ['degraded', 'Degraded reads', 'If the data chunk is unavailable, rebuild the photo from any four chunks. Off: wait for repair.'],
    ]),
    presets: Y.presets({ verifyFirst: true, rackAware: true, checksums: true, degraded: true }, fresh([
      { id: 'tier-down', label: 'Move an old photo to the warm tier', desc: '“Ramen” is old enough: the mover writes six chunks, reads them back, flips the pointer, then deletes the three copies. Its overhead drops from 3× to 1.5×, and it still opens.', run: (s) => later(s, 2500, (x) => open(x, 'ramen')) },
      { id: 'one-chunk-lost', label: 'Lose the server with Lake’s data chunk', desc: 'Server 1 dies. Opening “Lake” rebuilds it from four other chunks. After a second, repair writes a new chunk 0 elsewhere.', run: (s) => { s.inject('s1', 'down'); later(s, 300, (x) => open(x, 'lake')); } },
      { id: 'two-lost', label: 'Lose two servers', desc: 'Servers 1 and 4 die. Four chunks remain, exactly enough: “Lake” still opens, and repair rebuilds both.', run: (s) => { s.inject('s1', 'down'); s.inject('s4', 'down'); later(s, 300, (x) => open(x, 'lake')); } },
      { id: 'rack-packed', label: 'Lose rack A, chunks packed', desc: 'Without rack-aware placement, three of Lake’s chunks sit in rack A. When the rack is destroyed, three remain: one short. The photo is gone.', sw: { rackAware: false }, run: (s) => { later(s, 200, (x) => x.inject('s1', 'rack')); later(s, 230, (x) => open(x, 'lake')); } },
      { id: 'rack-aware', label: 'Lose rack A, rack-aware placement', desc: 'At most two chunks per rack: the rack takes two, four remain. “Lake” opens by rebuilding, and repair restores all six on the surviving racks.', run: (s) => { later(s, 200, (x) => x.inject('s1', 'rack')); later(s, 230, (x) => open(x, 'lake')); } },
      { id: 'bit-rot-no-checksum', label: 'Bit rot, no checksums', desc: 'Server 1 silently corrupts Lake’s data chunk. Nothing checks, so the read returns damaged bytes and Maya sees a broken photo.', sw: { checksums: false }, run: (s) => { s.inject('s1', 'rot'); later(s, 500, (x) => open(x, 'lake')); } },
      { id: 'scrub-catches', label: 'Bit rot, checksums and scrubbing', desc: 'The scrubber finds the mismatch within a second, marks the chunk bad, and repair rebuilds it. Maya opens an intact photo.', run: (s) => { s.inject('s1', 'rot'); later(s, 2500, (x) => open(x, 'lake')); } },
      { id: 'mover-flip-first', label: 'Mover crashes, flip first', desc: 'The mover points metadata at the chunks and deletes the copies before writing them, then dies after two chunks. Two are not enough: “Ramen” is lost.', sw: { verifyFirst: false }, run: (s) => { s.inject('daemons', 'crashMid'); later(s, 3500, (x) => open(x, 'ramen')); } },
      { id: 'mover-crash-verified', label: 'Mover crashes, verify first', desc: 'The mover dies after two chunks, but the pointer still says “three copies” and they are untouched. It restarts and does the whole migration again.', run: (s) => { s.inject('daemons', 'crashMid'); later(s, 3500, (x) => open(x, 'ramen')); } },
      { id: 'no-degraded-reads', label: 'Lose the data chunk, no degraded reads', desc: 'Server 1 dies and reads do not rebuild. Opening “Lake” waits until repair has written a new data chunk.', sw: { degraded: false }, run: (s) => { s.inject('s1', 'down'); later(s, 300, (x) => open(x, 'lake')); } },
    ])),
    initialState: () => {
      const lakeStripe = ['s1', 's4', 's7', 's2', 's5', 's8'].map((srv, i) => ({ i, srv, written: true, corrupt: false, gone: false, bad: false }));
      return {
        config: { verifyFirst: true, rackAware: true, checksums: true, degraded: true },
        photos: {
          lake: { tier: 'warm', hot: [], stripe: lakeStripe, old: true, dataIdx: 0 },
          ramen: { tier: 'hot', hot: ['s3', 's6', 's9'], stripe: [], old: true, dataIdx: 2 },
          dog: { tier: 'hot', hot: ['s3', 's6', 's9'], stripe: [], old: false, dataIdx: 0 },
        },
        downSince: {}, opens: [], damaged: [],
        stats: { moved: 0, repaired: 0, repairReadMB: 0, caught: 0, degradedReads: 0, moverCrashes: 0, copies: 0 },
      };
    },
    initialUI: () => ({ laptop: { view: null } }),
    actions: {
      open(sim, a) { open(sim, a.id); },
    },
    handlers,
    setup(sim) {
      sim.spawn((ctx) => mover(ctx), { self: 'daemons', quiet: 'all' });
      sim.spawn((ctx) => repair(ctx), { self: 'daemons', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      for (const [id, ph] of Object.entries(st.photos)) {
        if (ph.tier === 'warm' && ph.stripe.filter(usable).length < K && !ph.hot.length) return { key: 'wrong', label: `“${PHOTOS[id].name}” is lost: only ${ph.stripe.filter(usable).length} of its chunks survive, ${K} are needed, and ${st.config.verifyFirst ? 'no full copy is left' : 'the copies were deleted before the chunks were written'}.` };
        if (ph.tier === 'hot' && !ph.hot.length) return { key: 'wrong', label: `Every copy of “${PHOTOS[id].name}” is gone.` };
      }
      if (st.damaged.length) return { key: 'wrong', label: `Maya opened “${PHOTOS[st.damaged[0]].name}” and saw a corrupted photo. The disk returned flipped bits and nothing checked them.` };
      const failed = st.opens.filter((o) => !o.ok);
      if (failed.length) return { key: 'stale', label: `“${PHOTOS[failed[0].id].name}” could not be opened right now.` };
      const short = Object.entries(st.photos).filter(([, ph]) => ph.tier === 'warm' && ph.stripe.some((c) => !usable(c) || down(sim, c.srv)));
      if (short.length) { const ph = short[0][1]; return { key: 'stale', label: `“${PHOTOS[short[0][0]].name}” has ${ph.stripe.filter((c) => usable(c) && !down(sim, c.srv)).length} of ${N} chunks available. Still readable, but repair has work to do before it can survive another ${M} failures.` }; }
      const slow = st.opens.find((o) => o.ms > SLOW_OPEN);
      if (slow) return { key: 'stale', label: `Opening “${PHOTOS[slow.id].name}” took ${SDL.fmtMs(slow.ms)}: with no degraded reads, it waited for repair.` };
      const hotShort = Object.entries(st.photos).find(([, ph]) => ph.tier === 'hot' && ph.hot.length < 3);
      if (hotShort) return { key: 'stale', label: `“${PHOTOS[hotShort[0]].name}” has ${hotShort[1].hot.length} of 3 copies until repair makes another.` };
      if (st.stats.caught) return { key: 'ok', label: 'A checksum caught the corrupted chunk; repair rebuilt it from four others, and Maya saw an intact photo.' };
      if (st.stats.repaired && sim.nodes.s1.modes.rack) return { key: 'ok', label: `Rack A took only two of Lake’s six chunks. The photo opened by rebuilding from the other four, and repair wrote two new chunks on the surviving racks (${st.stats.repairReadMB} MB read).` };
      if (st.stats.repaired && st.opens.some((o) => o.via === 'rebuilt')) return { key: 'ok', label: `The photo opened by rebuilding from four chunks, and repair restored all ${N} chunks (${st.stats.repairReadMB} MB read to rebuild ${st.stats.repaired} MB).` };
      if (st.stats.moverCrashes) return { key: 'ok', label: 'The mover crashed after two chunks, but the pointer still pointed at three intact copies. It restarted, finished, and only then deleted them.' };
      if (st.stats.moved) return { key: 'ok', label: '“Ramen” moved to the warm tier: six chunks written and read back before the pointer flipped, then the copies deleted. It now takes 1.5 MB of disk per MB of photo instead of 3.' };
      return { key: 'ok', label: 'Every photo has all its copies or chunks.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const lastOpen = st.opens[st.opens.length - 1];
      const missing = Object.values(st.photos).reduce((a, ph) => a + (ph.tier === 'warm' ? ph.stripe.filter((c) => !known(c) || down(sim, c.srv)).length : 0), 0);
      return [
        { label: 'Raw bytes per photo byte', value: `${overhead(st).toFixed(2)}×` },
        { label: 'Chunks missing or down', value: missing, tone: missing ? 'warn' : '' },
        { label: 'Chunks rebuilt', value: st.stats.repaired },
        { label: 'Repair reads', value: `${st.stats.repairReadMB} MB` },
        { label: 'Degraded reads', value: st.stats.degradedReads },
        { label: 'Corruption caught', value: st.stats.caught },
        { label: 'Last open', value: lastOpen ? SDL.fmtMs(lastOpen.ms) : '–', tone: lastOpen && (!lastOpen.ok || lastOpen.ms > SLOW_OPEN) ? 'fail' : '' },
        { label: 'Photos moved to warm', value: st.stats.moved },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['laptop', 'Maya’s laptop (web)']], {
          note: 'Open a photo on the laptop. The racks show where every copy (●) and chunk (0–5) lives; chunks 0–3 are data, 4–5 parity.',
          side: '<p class="ops-title">Racks</p><div data-ref="racks"></div><div data-ref="status"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const v = sim.ui.laptop.view;
        const cards = Object.entries(st.photos).map(([id, ph]) => {
          const tier = ph.tier === 'hot' ? `${ph.hot.length} full cop${ph.hot.length === 1 ? 'y' : 'ies'}` : `${ph.stripe.filter((c) => known(c) && !down(sim, c.srv)).length} of ${N} chunks`;
          return `<div class="app-card"><strong>${PHOTOS[id].glyph} ${esc(PHOTOS[id].name)}</strong><span class="app-sub">${ph.tier === 'hot' ? 'Hot' : 'Warm'} · ${tier}</span>${Y.btn('open', 'Open', { arg: { id }, cls: 'secondary' })}</div>`;
        }).join('');
        let viewer = '';
        if (v) {
          const p = PHOTOS[v.id];
          const style = v.state === 'ok' ? '' : v.state === 'damaged' ? 'filter:hue-rotate(140deg) contrast(2.2) saturate(3);' : 'filter:grayscale(1);opacity:.4';
          const g = v.state === 'loading' ? '…' : v.state === 'unavailable' ? '✕' : p.glyph;
          const cap = v.state === 'loading' ? 'Loading…' : v.state === 'unavailable' ? `✕ Can’t open this photo (${SDL.fmtMs(v.ms)})` : v.state === 'damaged' ? `✕ Corrupted · ${SDL.fmtMs(v.ms)}` : `✓ ${SDL.fmtMs(v.ms)} · ${{ copy: 'from a full copy', chunk: 'from its data chunk', rebuilt: 'rebuilt from 4 chunks', waited: 'after waiting for repair' }[v.via]}`;
          viewer = `<div class="yt-thumb" style="--h:${p.hue};height:120px;font-size:32px;${style}"><span aria-hidden="true">${g}</span></div><p class="app-sub">${esc(p.name)} · ${esc(cap)}</p>`;
        }
        Y.paint(el, sim, 'laptop', { head: '<div><p class="app-title">Photos</p><p class="app-sub">Three photos, three ages</p></div>', viewer, cards }, {});
        // Racks
        const short = { lake: 'L', ramen: 'R', dog: 'D' };
        const racks = ['A', 'B', 'C'].map((r) => `<div class="ops-row" data-tone="${SERVERS.some((s) => RACK[s] === r && down(sim, s)) ? 'fail' : ''}"><div class="ops-name">Rack ${r}<span>${SERVERS.filter((s) => RACK[s] === r).map((s) => {
          const items = [];
          for (const [id, ph] of Object.entries(st.photos)) {
            if (ph.hot.includes(s)) items.push(`${short[id]}●`);
            for (const c of ph.stripe) if (c.srv === s && c.written) items.push(`${short[id]}${c.i}${c.gone ? '✕' : c.bad ? '!' : c.corrupt ? '?' : ''}`);
            if (ph.pending) for (const c of ph.pending) if (c.srv === s && c.written) items.push(`${short[id]}${c.i}*`);
          }
          const state = SERVERS.some((x) => RACK[x] === RACK[s] && sim.nodes[x].modes.rack) ? '✕ destroyed' : down(sim, s) ? '✕ down' : sim.nodes[s].modes.rot ? '⚠ rot' : '';
          return `Server ${s.slice(1)}${state ? ` ${state}` : ''}: ${items.join(' ') || '–'}`;
        }).join('<br>')}</span></div></div>`).join('');
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="racks"]'), { rows: `<div class="ops-shards">${racks}</div><p class="app-sub">L = Lake, R = Ramen, D = Dog. ● full copy; 0–5 chunk; * written, not yet live; ? corrupt, unnoticed; ! corrupt, caught; ✕ lost.</p>` }, {});
        SDL.ui.paintSections(el.querySelector('[data-ref="status"]'), { recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>` }, {});
      },
    },
  });

  function overhead(st) {
    const ph = Object.values(st.photos);
    const raw = ph.reduce((a, p) => a + (p.tier === 'hot' ? Math.max(p.hot.length, 0) : p.stripe.filter((c) => c.written).length / K), 0);
    return raw / ph.length;
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
