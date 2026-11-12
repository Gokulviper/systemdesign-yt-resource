/*
 * Consistent hashing and rebalancing.
 * Six hundred carts live on six storage nodes placed on a hash ring. Shoppers
 * read and write them all day. The operator adds a seventh node, decommissions
 * one, or splits a range that got hot, and every key whose owner changed has to
 * move while traffic keeps coming. This lab keeps one copy per key so that the
 * placement is what you see; replication is the next lab.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const R = Y.ring;

  const BASE = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
  const SPARE = 'n7';
  const KEYS = 600;
  const VNODES = 64;
  const MAYA = 'cart:maya';
  const ALL_KEYS = [...Array(KEYS)].map((_, i) => `cart:u${i}`).concat([MAYA]);
  const SERVICE_MS = 1.5; // about 600 requests a second per node
  const READ_RATE = 150;
  const WRITE_RATE = 30;
  const FLOOD = 900; // extra reads a second on the hot keys
  const HOT_KEYS = 40;
  const BATCH = 20; // keys copied per migration call
  const COPY_MS = 150; // time to copy one batch
  const SLOW_MS = 300; // a node this far behind is "overloaded" here
  const NAME = {}; BASE.concat([SPARE]).forEach((n, i) => { NAME[n] = `Node ${i + 1}`; });

  const initRing = R.create(BASE, VNODES);
  const HOME = R.owners(initRing, MAYA, 1)[0]; // the node that owns Maya's cart at the start
  const HOT = ALL_KEYS.filter((k) => k !== MAYA && R.owners(initRing, k, 1)[0] === HOME).slice(0, HOT_KEYS);

  /** Placement is a pure function of membership, extra tokens, and the rule; cache it by that key. */
  const PL_CACHE = new Map();
  function placementFor(members, extraTokens, config) {
    const key = `${members.join(',')}|${extraTokens.map((t) => t.pos.toFixed(7) + t.node).join(',')}|${config.vnodes ? 1 : 0}|${config.modulo ? 1 : 0}`;
    if (PL_CACHE.has(key)) return PL_CACHE.get(key);
    let pl;
    if (config.modulo) pl = { kind: 'modulo', owner: (k) => R.modulo(members, k, 1)[0] };
    else {
      const ring = R.create(members, config.vnodes ? VNODES : 1);
      for (const t of extraTokens) ring.tokens.push(t);
      ring.tokens.sort((a, b) => a.pos - b.pos);
      pl = { kind: 'ring', ring, owner: (k) => R.owners(ring, k, 1)[0] };
    }
    if (PL_CACHE.size > 200) PL_CACHE.clear();
    PL_CACHE.set(key, pl);
    return pl;
  }
  const placement = (st) => placementFor(st.members.slice(), st.extraTokens, st.config);
  const ownerOf = (st, k) => placement(st).owner(k);
  /** The router works from its own snapshot of the ring, refreshed only when a node says “not owner”. */
  const routerOwner = (st, k) => placementFor(st.router.members, st.router.extraTokens, st.router.config).owner(k);
  const refreshRouter = (st) => { st.router = { members: st.members.slice(), extraTokens: st.extraTokens.slice(), config: { vnodes: st.config.vnodes, modulo: st.config.modulo } }; };
  const dead = (sim, n) => !!sim.nodes[n].modes.down;
  const keysOn = (st, n) => Object.keys(st.data[n] || {});

  /** Re-place every key according to the current placement rule (used when a switch changes the rule). */
  function replaceAll(sim) {
    const st = sim.state;
    const old = {};
    for (const n of Object.keys(st.data)) for (const k of Object.keys(st.data[n])) old[k] = st.data[n][k];
    for (const n of Object.keys(st.data)) st.data[n] = {};
    for (const k of Object.keys(old)) { const o = ownerOf(st, k); st.data[o][k] = old[k]; }
    st.moving = []; st.prev = {}; refreshRouter(st);
  }
  /** Flip ownership at the metadata service and queue every key whose owner changed. */
  function flipAndQueue(sim, why) {
    const st = sim.state;
    const moves = [];
    for (const k of ALL_KEYS) {
      const cur = Object.keys(st.data).find((n) => st.data[n][k] !== undefined);
      const o = ownerOf(st, k);
      if (cur && cur !== o) { moves.push({ key: k, from: cur, to: o }); st.prev[k] = cur; }
    }
    // Maya's key goes last so the guided scenarios can act while it is still in flight.
    moves.sort((a, b) => (a.key === MAYA) - (b.key === MAYA));
    st.moving.push(...moves);
    st.stats.moved += moves.length;
    st.stats.lastMove = moves.length;
    sim.note(`${why}: ${moves.length} of ${ALL_KEYS.length} keys change owner${moves.length ? ` and must move (${summ(moves)})` : ''}.`);
    return moves;
  }
  function summ(moves) {
    const by = {};
    for (const m of moves) { const k = `${NAME[m.from]} → ${NAME[m.to]}`; by[k] = (by[k] || 0) + 1; }
    return Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${n} ${k}`).join(', ') + (Object.keys(by).length > 4 ? ', …' : '');
  }

  /* ---------- operator actions ---------- */
  function startJoin(sim) {
    const st = sim.state;
    if (st.members.includes(SPARE)) return;
    sim.startAction(`Operator: add ${NAME[SPARE]} to the ring`, function* (ctx) {
      Y.L(ctx, { displayed: 'n/a', retrySafe: ['yes', 'Membership changes are idempotent.'] });
      const r = yield ctx.call('meta', 'join', { node: SPARE }, { timeout: 600 });
      if (!r.ok) { Y.failed(ctx, 'The ring is unchanged.'); ctx.explain(`The metadata service is unavailable, so ${NAME[SPARE]} cannot join: nobody can agree on the new ring.`); return; }
      Y.L(ctx, { accepted: 'yes', committed: ['yes', `${NAME[SPARE]} owns ${r.value.moves} keys on the new ring.`], async: ['pending', 'The migration worker copies them.'] });
      ctx.explain(st.config.modulo
        ? `With modulo hashing, every key is placed at hash mod 7 instead of hash mod 6: ${r.value.moves} of ${ALL_KEYS.length} keys change owner. Almost the whole store moves for one new node, and until each key arrives a read for it misses.`
        : st.config.vnodes
          ? `${NAME[SPARE]} took ${VNODES} tokens spread around the ring, so it takes a slice from every node: ${r.value.moves} keys, about one seventh of the store, and nothing else moves.`
          : `${NAME[SPARE]} took one token, so it takes one contiguous range from one neighbour: ${r.value.moves} keys, all from ${NAME[r.value.from]}. The rest of the ring stays as uneven as it was.`);
    }, { self: 'meta' });
  }
  function startLeave(sim, node) {
    const st = sim.state;
    if (!st.members.includes(node)) return;
    sim.startAction(`Operator: decommission ${NAME[node]}`, function* (ctx) {
      Y.L(ctx, { displayed: 'n/a', retrySafe: 'yes' });
      const r = yield ctx.call('meta', 'leave', { node }, { timeout: 600 });
      if (!r.ok) { Y.failed(ctx, 'The ring is unchanged.'); ctx.explain('The metadata service is unavailable: the node stays in the ring.'); return; }
      Y.L(ctx, { accepted: 'yes', committed: ['yes', `${NAME[node]}’s ${r.value.moves} keys are assigned to its successors.`], async: ['pending', 'The migration worker copies them off before the node is switched off.'] });
      ctx.explain(`${NAME[node]}’s tokens are removed; each of its ranges now belongs to the next token clockwise, so its ${r.value.moves} keys spread over ${r.value.targets} neighbours. The node keeps answering “fetch” for keys it still holds until the copy is done${st.config.forward ? ', and new owners forward to it meanwhile' : ', but with forwarding off, new owners answer from what they have: nothing'}.`);
    }, { self: 'meta' });
  }
  function startSplit(sim) {
    const st = sim.state;
    sim.startAction(`Operator: split ${NAME[HOME]}’s hot range`, function* (ctx) {
      Y.L(ctx, { displayed: 'n/a', retrySafe: 'yes' });
      const r = yield ctx.call('meta', 'split', { node: HOME }, { timeout: 600 });
      if (!r.ok) { Y.failed(ctx, 'No split.'); ctx.explain(r.error.message); return; }
      Y.L(ctx, { accepted: 'yes', committed: ['yes', `${r.value.moves} hot keys now belong to ${NAME[SPARE]}.`], async: ['pending', 'Migration.'] });
      ctx.explain(`The metadata service placed new tokens for ${NAME[SPARE]} just past half of the hot keys, so ${r.value.moves} of them change owner. The flood splits roughly in half: about ${Math.round(FLOOD / 2)} reads a second each against a capacity of about ${Math.round(1000 / SERVICE_MS)}. Splitting a hot range works because the heat is spread over many keys; one hot key cannot be split.`);
    }, { self: 'meta' });
  }
  function setFlood(sim, on) { sim.state.flood = on; sim.note(on ? `Flash sale: ${FLOOD} extra reads a second on ${HOT_KEYS} carts that all hash to ${NAME[HOME]}.` : 'The flash sale is over.'); }

  /* ---------- Maya ---------- */
  function startAdd(sim, item) {
    const st = sim.state;
    const u = sim.ui.maya;
    sim.startAction(`Maya: add ${item}`, function* (ctx) {
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'The write carries the version it is based on.'] });
      const items = u.cart.includes(item) ? u.cart.slice() : u.cart.concat([item]);
      const r = yield ctx.call('router', 'put', { key: MAYA, items, base: u.version }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency;
      if (r.ok) {
        u.cart = r.value.items; u.version = r.value.version; u.node = r.value.node;
        st.mayaWrites.push({ item, version: r.value.version, node: r.value.node });
        Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', `Version ${r.value.version} on ${NAME[r.value.node]}.`], async: 'n/a' });
        ctx.explain(`${NAME[r.value.node]} owns ${MAYA} now and stored version ${r.value.version}${r.value.fetched ? ` after fetching version ${r.value.version - 1} from ${NAME[r.value.fetched]}, which still held the key mid-migration` : ''}${r.value.fresh ? `. The key had not arrived from ${NAME[st.prev[MAYA] || '?']} yet and forwarding is off, so the node started from an empty cart at version 1. When the migration copies the old version over, this write will be overwritten` : ''}.`);
      } else {
        u.error = r.error.message;
        Y.failed(ctx, 'The cart shows an error.');
        ctx.explain(r.error.message);
      }
    }, { self: 'maya' });
  }
  function startRefresh(sim) {
    const st = sim.state;
    const u = sim.ui.maya;
    sim.startAction('Maya: refresh cart', function* (ctx) {
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const t0 = ctx.now();
      const r = yield ctx.call('router', 'get', { key: MAYA }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = ctx.now() - t0;
      if (r.ok) {
        const v = r.value;
        u.cart = v.items; u.version = v.version; u.node = v.node;
        const truthV = truthOf(st, MAYA);
        Y.L(ctx, { displayed: ['yes', `${v.items.length} item${v.items.length === 1 ? '' : 's'}.`], accepted: 'yes', committed: 'n/a', async: 'n/a' });
        if (v.miss) ctx.explain(`${NAME[v.node]} owns the key on the new ring but has not received it yet, and forwarding is off, so it answered with an empty cart. The ${truthV.items.length} item${truthV.items.length === 1 ? '' : 's'} still sit on ${NAME[st.prev[MAYA]]}. The phone shows an empty cart that is not empty.`);
        else ctx.explain(`${NAME[v.node]} answered in ${SDL.fmtMs(u.lastMs)}${v.forwarded ? `, forwarding to ${NAME[v.forwarded]}, which still holds the key while the migration runs` : ''}${v.redirects ? `, after ${v.redirects} “not owner” redirect${v.redirects === 1 ? '' : 's'} refreshed the router’s map` : ''}${v.waited > SLOW_MS ? `. It waited ${SDL.fmtMs(v.waited)} in the node’s queue behind the flood` : ''}.`);
      } else {
        u.error = r.error.message;
        Y.failed(ctx, 'The cart could not be refreshed.');
        const why = {
          TIMEOUT: `${NAME[routerOwner(st, MAYA)]} is ${SDL.fmtMs(ctx.sim.queueWait(routerOwner(st, MAYA)))} behind: ${HOT_KEYS} hot carts share its ranges and every request waits in the same queue. Adding nodes elsewhere does not help this node.`,
          UNAVAILABLE: dead(ctx.sim, ownerOf(st, MAYA)) || dead(ctx.sim, st.prev[MAYA] || ownerOf(st, MAYA)) ? `${NAME[dead(ctx.sim, ownerOf(st, MAYA)) ? ownerOf(st, MAYA) : st.prev[MAYA]]} is down and this lab keeps one copy per key, so Maya’s cart is unreachable until it returns. Replicas on the next nodes of the ring are how the real system covers this.` : r.error.message,
          WRONG_OWNER: 'The router keeps sending to a node that says it is not the owner, and cannot refresh its map.',
        }[r.error.code];
        ctx.explain(why || r.error.message);
      }
    }, { self: 'maya' });
  }
  function truthOf(st, k) {
    for (const n of Object.keys(st.data)) if (st.data[n][k] !== undefined) return st.data[n][k];
    return { items: [], version: 0 };
  }

  /* ---------- storage node handlers ---------- */
  function node(id) {
    return {
      get: function* (ctx, p) {
        const st = ctx.state;
        if (ownerOf(st, p.key) !== id) ctx.fail('NOT_OWNER', `${NAME[id]} does not own ${p.key} on the current ring.`);
        const v = st.data[id][p.key];
        if (v) return { items: v.items, version: v.version, node: id };
        const prev = st.prev[p.key];
        if (prev && st.config.forward) {
          const f = dead(ctx.sim, prev) ? { ok: false, error: { code: 'UNAVAILABLE' } } : yield ctx.call(prev, 'fetch', { key: p.key }, { timeout: 500, quiet: p.quiet });
          st.stats.forwarded++;
          if (f.ok && f.value) return { items: f.value.items, version: f.value.version, node: id, forwarded: prev };
          st.stats.unavailable++;
          ctx.fail('UNAVAILABLE', `${NAME[id]} owns ${p.key} but has not received it yet, and ${NAME[prev]} did not answer the forwarded read.`);
        }
        st.stats.misses++;
        return { items: [], version: 0, node: id, miss: true };
      },
      put: function* (ctx, p) {
        const st = ctx.state;
        if (ownerOf(st, p.key) !== id) ctx.fail('NOT_OWNER', `${NAME[id]} does not own ${p.key} on the current ring.`);
        let cur = st.data[id][p.key];
        let fetched = null;
        let fresh = false;
        if (!cur) {
          const prev = st.prev[p.key];
          if (prev && st.config.forward) {
            const f = dead(ctx.sim, prev) ? { ok: false, error: { code: 'UNAVAILABLE' } } : yield ctx.call(prev, 'fetch', { key: p.key }, { timeout: 500, quiet: p.quiet });
            if (f.ok && f.value) { cur = f.value; fetched = prev; }
            else if (!f.ok) ctx.fail('UNAVAILABLE', `${NAME[id]} owns ${p.key} but has not received it yet, and ${NAME[prev]} did not answer. Refusing to write from scratch.`);
          }
          if (!cur) fresh = !!prev;
        }
        const version = (cur ? cur.version : 0) + 1;
        st.data[id][p.key] = { items: p.items, version, by: p.by || 'maya' };
        if (fresh) st.freshWrites[p.key] = { version, items: p.items };
        return { items: p.items, version, node: id, fetched, fresh };
      },
      fetch(ctx, p) { const v = ctx.state.data[id][p.key]; return v ? { items: v.items, version: v.version } : null; },
      export(ctx, p) {
        const st = ctx.state;
        const out = [];
        for (const k of p.keys) if (st.data[id][k]) out.push({ key: k, items: st.data[id][k].items, version: st.data[id][k].version });
        return { records: out };
      },
      import(ctx, p) {
        const st = ctx.state;
        let over = 0;
        for (const r of p.records) {
          const cur = st.data[id][r.key];
          if (cur && cur.version >= r.version) continue; // a newer write already arrived here: keep it
          if (cur && st.freshWrites[r.key] && cur.version === st.freshWrites[r.key].version) {
            // The copy from the old owner has a higher version than a write made here from scratch. The write is lost.
            over++;
            st.lost.push({ key: r.key, items: cur.items, by: cur.by });
            delete st.freshWrites[r.key];
          }
          st.data[id][r.key] = { items: r.items, version: r.version };
        }
        if (over) ctx.log({ op: `import overwrote ${over} newer write${over === 1 ? '' : 's'}`, status: 'warn', detail: `Keys written here from scratch had version 1; the copies arriving from the old owner carry higher versions and replaced them.` });
        return { imported: p.records.length, overwrote: over };
      },
    };
  }

  const sc = (SDL.scenarios['kv-ring'] = {
    id: 'kv-ring',
    seed: 23,
    productWidth: 760,
    minHopMs: 5,
    intro: `Add ${NAME[SPARE]} and watch how many keys move with virtual nodes, with one token, and with modulo hashing. Decommission ${NAME[HOME]} (Maya’s node) with and without forwarding. Start the flash sale and split the hot range.`,
    topology: {
      width: 1160, height: 620,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'Cart app', x: 90, y: 110, latency: 1, role: `Her cart is ${MAYA}, which hashes to ${NAME[HOME]} on the starting ring.`, owns: ['What the phone shows'] },
        { id: 'shoppers', label: 'Shoppers', kind: 'client', sub: `${READ_RATE} reads, ${WRITE_RATE} writes a second`, x: 90, y: 300, latency: 1, role: `Background traffic over all ${ALL_KEYS.length} carts. During a flash sale, ${FLOOD} extra reads a second hit ${HOT_KEYS} carts that all live on ${NAME[HOME]}.`, owns: ['Nothing'] },
        { id: 'router', label: 'Request router', kind: 'gateway', sub: 'Caches the ring', x: 330, y: 300, latency: 1, role: 'Hashes each key and sends the request to the owner in its cached copy of the ring. When a node answers “not owner”, it refreshes the ring from the metadata service and retries.', ops: [{ name: 'get', desc: 'Route a read.' }, { name: 'put', desc: 'Route a write.' }], owns: ['Cached ring'] },
        { id: 'meta', label: 'Metadata service', kind: 'service', sub: 'Owns the ring', x: 330, y: 90, latency: 2, role: 'The authority on membership and tokens. A join, a leave, or a split changes the ring here first; the migration worker then moves the keys whose owner changed.', ops: [{ name: 'join', desc: 'Add a node.' }, { name: 'leave', desc: 'Remove a node.' }, { name: 'split', desc: 'Give a hot range new tokens.' }, { name: 'ring', desc: 'Current ring.' }], owns: ['Membership', 'Tokens'] },
        { id: 'mover', label: 'Migration worker', kind: 'worker', sub: `${BATCH} keys per ${COPY_MS} ms`, x: 330, y: 520, latency: 1, role: 'Copies keys from old owner to new owner in batches. The new owner keeps any version newer than the one arriving.', ops: [{ name: 'copy', desc: 'Export from the old owner, import at the new.' }], owns: ['The move queue'] },
        { id: 'n1', label: 'Node 1', kind: 'db', sub: 'storage', x: 800, y: 70, latency: 1, serviceMs: SERVICE_MS, role: `One copy of every key it owns. ${SERVICE_MS} ms per request: about ${Math.round(1000 / SERVICE_MS)} a second, whatever the keys.`, ops: [{ name: 'get', desc: 'Read a key it owns.' }, { name: 'put', desc: 'Write a key it owns.' }, { name: 'fetch', desc: 'Return a key it still holds mid-migration.' }], owns: ['Keys in its ranges'] },
        { id: 'n2', label: 'Node 2', kind: 'db', sub: 'storage', x: 990, y: 180, latency: 1, serviceMs: SERVICE_MS, role: 'Storage node.', owns: ['Keys in its ranges'] },
        { id: 'n3', label: 'Node 3', kind: 'db', sub: 'storage', x: 990, y: 400, latency: 1, serviceMs: SERVICE_MS, role: 'Storage node.', owns: ['Keys in its ranges'] },
        { id: 'n4', label: 'Node 4', kind: 'db', sub: 'storage', x: 800, y: 510, latency: 1, serviceMs: SERVICE_MS, role: 'Storage node.', owns: ['Keys in its ranges'] },
        { id: 'n5', label: 'Node 5', kind: 'db', sub: 'storage', x: 610, y: 400, latency: 1, serviceMs: SERVICE_MS, role: 'Storage node.', owns: ['Keys in its ranges'] },
        { id: 'n6', label: 'Node 6', kind: 'db', sub: 'storage', x: 610, y: 180, latency: 1, serviceMs: SERVICE_MS, role: 'Storage node.', owns: ['Keys in its ranges'] },
        { id: 'n7', label: 'Node 7', kind: 'db', sub: 'not in the ring yet', x: 1100, y: 560, latency: 1, serviceMs: SERVICE_MS, role: 'A spare. Joins when the operator adds it, or takes a hot range in a split.', owns: ['Nothing yet'] },
      ],
      edges: [
        { from: 'maya', to: 'router', latency: 40 },
        { from: 'shoppers', to: 'router', latency: 2 },
        { from: 'router', to: 'meta', latency: 2 },
        { from: 'meta', to: 'mover', latency: 2, via: [[200, 90], [200, 520]] },
        ...BASE.concat([SPARE]).map((n) => ({ from: 'router', to: n, latency: 2 })),
        ...BASE.map((n, i) => ({ from: n, to: BASE[(i + 1) % BASE.length], latency: 1 })),
      ],
      queues: [],
    },
    modeLabels: { staleMap: 'Ignoring ring updates' },
    failures: [
      { id: 'home-down', node: HOME, mode: 'down', label: `${NAME[HOME]} leaves abruptly`, desc: `Maya’s node is gone. With one copy per key, its ${keysOnInit(HOME)} keys are unreachable; the ring does not reassign what nobody else holds.` },
      { id: 'mover-paused', node: 'mover', mode: 'paused', label: 'Migration worker paused', desc: 'Ownership has flipped but keys stop moving. New owners forward (or miss) for as long as it lasts.' },
      { id: 'meta-down', node: 'meta', mode: 'down', label: 'Metadata service down', desc: 'No joins, leaves, or splits, and routers cannot refresh their ring.' },
      { id: 'router-stale', node: 'router', mode: 'staleMap', label: 'Router ignores ring updates', desc: 'After a change the router keeps sending to the old owners, which answer “not owner”.' },
      { id: 'home-slow', node: HOME, mode: 'slow', params: { factor: 6 }, label: `${NAME[HOME]} slow`, desc: 'A slow disk. Every key on it waits; a migration off it crawls.' },
      { id: 'spare-down', node: SPARE, mode: 'down', label: `${NAME[SPARE]} down during a join`, desc: 'The new node owns keys it cannot receive. Reads for them fail until it is back.' },
    ],
    switches: Y.switches([
      ['vnodes', `Virtual nodes (${VNODES} tokens per node)`, 'Each node owns many small ranges spread around the ring, so load is even and a new node takes a slice from everyone. Off: one token per node, uneven ranges, and a join only relieves one neighbour.', (s) => { replaceAll(s); s.note('Placement rule changed: keys re-placed.'); }],
      ['modulo', 'Modulo hashing instead of the ring', 'Owner = hash mod number of nodes. Simple, and almost every key changes owner when a node is added or removed.', (s) => { replaceAll(s); s.note('Placement rule changed: keys re-placed.'); }],
      ['forward', 'Serve from the old owner during migration', 'A new owner that does not have the key yet fetches it from the previous owner, for reads and before writes. Off: it answers with nothing and writes from scratch.'],
      ['autoSplit', 'Split a hot range automatically', `When a node’s queue stays over ${SLOW_MS} ms, the metadata service gives half of its hottest range to the spare node.`],
    ]),
    presets: Y.presets({ vnodes: true, modulo: false, forward: true, autoSplit: false }, [
      { id: 'steady', label: 'Steady state', desc: `${ALL_KEYS.length} keys over six nodes with ${VNODES} tokens each: within about 20% of even. Maya’s refresh goes straight to ${NAME[HOME]}.`, run: (s) => { s.schedule(500, () => startRefresh(s)); } },
      { id: 'join-vnodes', label: `Add ${NAME[SPARE]} with virtual nodes`, desc: 'About a seventh of the keys move, a few from every node. Reads for keys in flight are forwarded to the old owner, so nobody notices.', run: (s) => { s.schedule(300, () => startJoin(s)); s.schedule(1200, () => startRefresh(s)); } },
      { id: 'join-modulo', label: `Add ${NAME[SPARE]} with modulo hashing`, desc: 'Owner = hash mod 7 instead of mod 6: most keys change owner. The migration takes seconds and every read for a key not yet copied has to be forwarded.', sw: { modulo: true }, run: (s) => { s.schedule(300, () => startJoin(s)); s.schedule(1200, () => startRefresh(s)); } },
      { id: 'join-onetoken', label: `Add ${NAME[SPARE]} with one token per node`, desc: 'With one token each, ranges are wildly uneven from the start, and the new node relieves exactly one neighbour. The imbalance stays.', sw: { vnodes: false }, run: (s) => { s.schedule(300, () => startJoin(s)); s.schedule(1500, () => startRefresh(s)); } },
      { id: 'leave-forward', label: `Decommission ${NAME[HOME]}, forwarding on`, desc: 'Maya’s node leaves the ring on purpose. Her key’s new owner forwards to it until the copy lands; her refresh and her add both work mid-migration.', run: (s) => { s.schedule(300, () => startLeave(s, HOME)); s.schedule(500, () => startRefresh(s)); s.schedule(700, () => startAdd(s, 'Mug')); s.schedule(5000, () => startRefresh(s)); } },
      { id: 'leave-noforward', label: `Decommission ${NAME[HOME]}, forwarding off`, desc: 'The new owner does not have Maya’s key yet. Her refresh returns an empty cart that is not empty, and her add is stored from scratch as version 1. Then the copy of her old cart arrives with a higher version and replaces it: the mug is gone, and so are the shoppers’ writes to every other key in flight.', sw: { forward: false }, run: (s) => { s.schedule(300, () => startLeave(s, HOME)); s.schedule(500, () => startRefresh(s)); s.schedule(800, () => startAdd(s, 'Mug')); s.schedule(5000, () => startRefresh(s)); } },
      { id: 'mover-paused', label: 'Migration stalls', desc: `${NAME[SPARE]} joins, the worker pauses after the first batches. Ownership has flipped; the keys have not moved. Forwarding carries every read for them, and will until the worker resumes.`, run: (s) => { s.schedule(300, () => startJoin(s)); s.schedule(600, () => s.inject('mover', 'paused')); s.schedule(1500, () => startRefresh(s)); } },
      { id: 'stale-router', label: 'Router ignores the new ring', desc: `${NAME[HOME]} is decommissioned but the router keeps its old map. It answers “not owner”; the router cannot refresh and Maya’s request fails until the map is fixed.`, run: (s) => { s.inject('router', 'staleMap', true, 4000); s.schedule(300, () => startLeave(s, HOME)); s.schedule(1500, () => startRefresh(s)); } },
      { id: 'hot-range', label: 'Flash sale on one range', desc: `${HOT_KEYS} carts that hash to ${NAME[HOME]} get ${FLOOD} extra reads a second against a capacity of about ${Math.round(1000 / SERVICE_MS)}. Maya’s cart shares the node and her refresh times out behind the flood.`, run: (s) => { s.schedule(200, () => setFlood(s, true)); s.schedule(4200, () => startRefresh(s)); s.schedule(6500, () => setFlood(s, false)); } },
      { id: 'hot-split', label: 'Split the hot range', desc: `The operator gives ${NAME[SPARE]} tokens through the middle of the hot range. Half the hot keys move, each node sees about ${FLOOD / 2} a second, and Maya’s refresh is fast again.`, run: (s) => { s.schedule(200, () => setFlood(s, true)); s.schedule(400, () => startSplit(s)); s.schedule(4500, () => startRefresh(s)); s.schedule(6500, () => setFlood(s, false)); } },
      { id: 'home-down', label: `${NAME[HOME]} leaves abruptly`, desc: 'No decommission, no copy. With one copy per key, every cart on it is unreachable. The ring alone does not give you availability: replicas do.', run: (s) => { s.schedule(200, () => s.inject(HOME, 'down')); s.schedule(600, () => startRefresh(s)); } },
    ]),
    initialState: () => {
      const rng = SDL.createRng(23);
      const data = {}; for (const n of BASE.concat([SPARE])) data[n] = {};
      const st = { config: { vnodes: true, modulo: false, forward: true, autoSplit: false }, members: BASE.slice(), extraTokens: [], data, moving: [], prev: {}, router: null, freshWrites: {}, lost: [], mayaWrites: [], flood: false, hotSince: 0, stats: { moved: 0, lastMove: 0, copied: 0, misses: 0, forwarded: 0, redirects: 0, timeouts: 0, splits: 0, autoSplits: 0, reads: 0, unavailable: 0 } };
      for (const k of ALL_KEYS) { const o = ownerOf(st, k); data[o][k] = { items: k === MAYA ? ['Socks'] : [`item-${Math.floor(rng() * 90) + 10}`], version: 2 + Math.floor(rng() * 8) }; }
      refreshRouter(st);
      return st;
    },
    initialUI: () => ({ maya: { cart: ['Socks'], version: 0, node: HOME, pending: false, error: '', lastMs: null } }),
    actions: {
      add(sim, a) { startAdd(sim, a.item || 'Mug'); },
      refresh(sim) { startRefresh(sim); },
      join(sim) { startJoin(sim); },
      leave(sim, a) { startLeave(sim, a.node || HOME); },
      split(sim) { startSplit(sim); },
      flood(sim, a) { setFlood(sim, !!a.on); },
    },
    handlers: Object.assign({
      router: {
        get: function* (ctx, p) { return yield* route(ctx, 'get', p); },
        put: function* (ctx, p) { return yield* route(ctx, 'put', p); },
      },
      meta: {
        ring(ctx) { return { members: ctx.state.members.slice(), extra: ctx.state.extraTokens.length, gen: ctx.state.gen || 0 }; },
        join(ctx, p) {
          const st = ctx.state;
          st.members.push(p.node);
          st.gen = (st.gen || 0) + 1;
          const moves = flipAndQueue(ctx.sim, `${NAME[p.node]} joined`);
          return { moves: moves.length, from: moves.length ? moves[0].from : null };
        },
        leave(ctx, p) {
          const st = ctx.state;
          st.members = st.members.filter((n) => n !== p.node);
          st.extraTokens = st.extraTokens.filter((t) => t.node !== p.node);
          st.gen = (st.gen || 0) + 1;
          const moves = flipAndQueue(ctx.sim, `${NAME[p.node]} left`);
          return { moves: moves.length, targets: new Set(moves.map((m) => m.to)).size };
        },
        split(ctx, p) {
          const st = ctx.state;
          if (st.config.modulo) ctx.fail('UNSUPPORTED', 'Modulo hashing has no ranges to split.');
          // The spare gets tokens only where the heat is; it does not take a regular share of the ring.
          // Put a token for the spare just past every other hot key, so about half of them change owner.
          const hot = HOT.filter((k) => ownerOf(st, k) === p.node).map((k) => R.hash(k)).sort((a, b) => a - b);
          for (let i = 0; i < hot.length; i += 2) st.extraTokens.push({ pos: Math.min(0.999999, hot[i] + 1e-7), node: SPARE });
          st.gen = (st.gen || 0) + 1;
          st.stats.splits++;
          const moves = flipAndQueue(ctx.sim, `${NAME[p.node]}’s hot range split`);
          return { moves: moves.length };
        },
      },
    }, Object.fromEntries(BASE.concat([SPARE]).map((n) => [n, node(n)]))),
    setup(sim) {
      let i = 0;
      Y.load(sim, 'shoppers', () => READ_RATE + WRITE_RATE, function* (ctx) {
        const n = ++i;
        const key = ALL_KEYS[Math.floor(ctx.rand() * KEYS)];
        const write = n % Math.round((READ_RATE + WRITE_RATE) / WRITE_RATE) === 0;
        ctx.state.stats.reads++;
        const r = yield ctx.call('router', write ? 'put' : 'get', write ? { key, items: [`item-${n % 90}`], by: 'shopper', quiet: 'all' } : { key, quiet: 'all' }, { timeout: 1500, quiet: 'all' });
        if (!r.ok && r.error.code === 'TIMEOUT') ctx.state.stats.timeouts++;
      });
      Y.load(sim, 'shoppers', (s) => (s.state.flood ? FLOOD : 0), function* (ctx, n) {
        const key = HOT[n % HOT.length];
        const r = yield ctx.call('router', 'get', { key, quiet: 'all' }, { timeout: 1500, quiet: 'all' });
        if (!r.ok && r.error.code === 'TIMEOUT') ctx.state.stats.timeouts++;
      });
      // Migration worker: one batch at a time.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(20);
          const st = ctx.state;
          if (!st.moving.length || !ctx.alive()) continue;
          const first = st.moving[0];
          const batch = st.moving.filter((m) => m.from === first.from && m.to === first.to).slice(0, BATCH);
          yield ctx.wait(COPY_MS);
          if (!ctx.alive()) continue;
          const ex = yield ctx.call(first.from, 'export', { keys: batch.map((m) => m.key) }, { timeout: 800, quiet: true });
          if (!ex.ok) { yield ctx.wait(300); continue; }
          const im = yield ctx.call(first.to, 'import', { records: ex.value.records }, { timeout: 800, quiet: true });
          if (!im.ok) { yield ctx.wait(300); continue; }
          for (const m of batch) { delete st.data[m.from][m.key]; delete st.prev[m.key]; st.moving.splice(st.moving.indexOf(m), 1); }
          st.stats.copied += batch.length;
          ctx.log({ op: `copied ${batch.length} keys ${NAME[first.from]} → ${NAME[first.to]}`, status: 'ok', detail: `${st.moving.length} keys still to move.` });
          if (!st.moving.length) ctx.log({ op: 'migration complete', status: 'ok', detail: `${st.stats.copied} keys copied in total.` });
        }
      }, { self: 'mover', quiet: 'all' });
      // Auto split: watch the hottest node's queue.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(250);
          const st = ctx.state;
          if (!st.config.autoSplit || st.stats.autoSplits || !ctx.alive()) continue;
          if (ctx.sim.queueWait(HOME) > SLOW_MS) { st.hotSince = st.hotSince || ctx.now(); if (ctx.now() - st.hotSince > 1000) { st.stats.autoSplits++; startSplit(ctx.sim); } } else st.hotSince = 0;
        }
      }, { self: 'meta', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const u = sim.ui.maya;
      if (st.lost.length) { const m = st.lost.find((l) => l.key === MAYA) || st.lost[0]; return { key: 'wrong', label: `${st.lost.length} write${st.lost.length === 1 ? '' : 's'} lost: ${m.key === MAYA ? `Maya’s “${m.items[m.items.length - 1]}”` : m.key} was stored by the new owner from scratch and then replaced by the migrated copy, which carried a higher version.` }; }
      if (u.pending) return { key: 'stale', label: 'Maya’s phone is waiting.' };
      if (u.error) return { key: 'stale', label: `Maya’s last request failed: ${u.error}` };
      const t = truthOf(st, MAYA);
      if (t.items.some((it) => !u.cart.includes(it)) || u.cart.some((it) => !t.items.includes(it))) return { key: 'stale', label: `Maya’s phone shows ${u.cart.length ? u.cart.join(', ') : 'an empty cart'}; the store has ${t.items.join(', ') || 'nothing'}${st.moving.some((m) => m.key === MAYA) ? ` on ${NAME[Object.keys(st.data).find((n) => st.data[n][MAYA])]}, waiting to be migrated` : ''}.` };
      const down = BASE.concat([SPARE]).filter((n) => dead(sim, n) && keysOn(st, n).length);
      if (down.length) return { key: 'stale', label: `${down.map((n) => `${NAME[n]} (${keysOn(st, n).length} keys)`).join(', ')} down: those carts are unreachable. One copy per key means the ring alone cannot cover a failure.` };
      if (st.moving.length) return { key: 'stale', label: `${st.moving.length} keys still on their old owner (${st.stats.copied} copied so far). ${st.config.forward ? 'Reads for them are forwarded.' : 'Reads for them come back empty.'}` };
      const slow = BASE.concat([SPARE]).filter((n) => sim.queueWait(n) > SLOW_MS);
      if (slow.length) return { key: 'stale', label: `${slow.map((n) => NAME[n]).join(', ')} ${slow.length === 1 ? 'is' : 'are'} ${SDL.fmtMs(Math.max(...slow.map((n) => sim.queueWait(n))))} behind: every key on ${slow.length === 1 ? 'it' : 'them'} waits, hot or not.` };
      const counts = BASE.concat([SPARE]).map((n) => keysOn(st, n).length).filter((c) => c > 0);
      const max = Math.max(...counts), min = Math.min(...counts);
      if (max > 3 * min) return { key: 'stale', label: `Uneven ring: the busiest node holds ${max} keys, the quietest ${min}. With one token per node, ranges are whatever the hash gave them.` };
      return { key: 'ok', label: `Every key is on its owner; ${counts.length} nodes hold between ${min} and ${max} keys each${st.stats.moved ? `; ${st.stats.copied} keys moved in total with ${st.stats.misses} misses` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const counts = BASE.concat([SPARE]).map((n) => keysOn(st, n).length).filter((c) => c > 0);
      const w = sim.queueWait(HOME);
      return [
        { label: 'Keys per node (min–max)', value: `${Math.min(...counts)}–${Math.max(...counts)}`, tone: Math.max(...counts) > 3 * Math.min(...counts) ? 'warn' : '' },
        { label: 'Keys moved / to move', value: `${st.stats.copied} / ${st.moving.length}`, tone: st.moving.length ? 'warn' : '' },
        { label: 'Misses during moves', value: st.stats.misses, tone: st.stats.misses ? 'warn' : '' },
        { label: 'Forwarded reads', value: st.stats.forwarded },
        { label: '“Not owner” redirects', value: st.stats.redirects },
        { label: `${NAME[HOME]} queue`, value: SDL.fmtMs(w), tone: w > SLOW_MS ? 'fail' : w > 100 ? 'warn' : '' },
        { label: 'Timed out', value: st.stats.timeouts, tone: st.stats.timeouts ? 'fail' : '' },
        { label: 'Writes lost', value: st.lost.length, tone: st.lost.length ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone']], {
          note: `${ALL_KEYS.length} carts on the ring. Maya’s is ${MAYA}, on ${NAME[HOME]} at the start. The console shows the ring, each node’s share, and how long a request waits there.`,
          side: `<p class="ops-title">The ring</p><div class="ops-traffic">${Y.btn('join', `Add ${NAME[SPARE]}`)}${Y.btn('leave', `Decommission ${NAME[HOME]}`, { arg: { node: HOME }, cls: 'secondary' })}${Y.btn('flood', 'Flash sale on', { arg: { on: true }, cls: 'secondary' })}${Y.btn('flood', 'Flash sale off', { arg: { on: false }, cls: 'secondary' })}${Y.btn('split', 'Split the hot range', { cls: 'go' })}</div><div data-ref="ring"></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.maya;
        Y.paint(el, sim, 'maya', {
          head: `<div><p class="app-title">Cart</p><p class="app-sub">Maya · ${MAYA} · ${u.node ? NAME[u.node] : ''}${u.lastMs != null ? ` · ${SDL.fmtMs(u.lastMs)}` : ''}</p></div>`,
          cart: u.cart.length ? u.cart.map((it) => `<div class="app-card"><span class="app-kv"><strong>${esc(it)}</strong><span>1</span></span></div>`).join('') : '<p class="app-sub">Your cart is empty.</p>',
          msg: Y.msg(u.error, 'fail') || (u.pending ? '<p class="app-msg"><span class="spinner"></span>Loading…</p>' : ''),
          actions: `<div class="app-row">${Y.btn('add', 'Add mug', { arg: { item: 'Mug' }, disabled: u.pending })}${Y.btn('refresh', 'Refresh', { cls: 'secondary', disabled: u.pending })}</div>`,
        }, {});
        // Ring as a 360° band: each token owns the arc up to itself.
        const pl = placement(st);
        const cx = 160, cy = 120, rad = 96;
        const ang = (p) => p * Math.PI * 2 - Math.PI / 2;
        const pt = (p, r) => [cx + r * Math.cos(ang(p)), cy + r * Math.sin(ang(p))];
        const hue = { n1: 0, n2: 1, n3: 2, n4: 3, n5: 4, n6: 5, n7: 6 };
        let arcs = '';
        if (pl.kind === 'ring' && pl.ring.tokens.length) {
          const toks = pl.ring.tokens;
          for (let i = 0; i < toks.length; i++) {
            const start = i === 0 ? toks[toks.length - 1].pos - 1 : toks[i - 1].pos;
            const end = toks[i].pos;
            const [x1, y1] = pt(start, rad), [x2, y2] = pt(end, rad);
            const large = end - start > 0.5 ? 1 : 0;
            arcs += `<path class="kv-arc kv-c${hue[toks[i].node]} ${dead(sim, toks[i].node) ? 'is-down' : ''}" d="M ${x1} ${y1} A ${rad} ${rad} 0 ${large} 1 ${x2} ${y2}"></path>`;
          }
        } else {
          arcs = `<circle cx="${cx}" cy="${cy}" r="${rad}" class="kv-ring-track"></circle><text x="${cx}" y="${cy + 40}" text-anchor="middle" class="kv-sub">modulo hashing: no ring positions</text>`;
        }
        const [mx, my] = pt(R.hash(MAYA), rad);
        const hot = st.flood ? HOT.map((k) => { const [x, y] = pt(R.hash(k), rad + 8); return `<circle cx="${x}" cy="${y}" r="1.6" class="kv-hot"></circle>`; }).join('') : '';
        const ring = `<svg class="kv-ring kv-ring-wide" viewBox="0 0 320 240" role="img" aria-label="Hash ring"><g>${arcs}</g>${hot}<g class="kv-key"><circle cx="${mx}" cy="${my}" r="5"></circle></g><text x="${cx}" y="${cy - 4}" text-anchor="middle" class="kv-key-label">${esc(MAYA)}</text><text x="${cx}" y="${cy + 12}" text-anchor="middle" class="kv-sub">→ ${NAME[ownerOf(st, MAYA)]}${st.moving.some((m) => m.key === MAYA) ? ' (moving)' : ''}</text></svg>`;
        const rows = BASE.concat([SPARE]).map((n) => {
          const k = keysOn(st, n).length;
          const w = sim.queueWait(n);
          const member = st.members.includes(n) || st.extraTokens.some((t) => t.node === n);
          const tone = dead(sim, n) ? 'fail' : w > SLOW_MS ? 'fail' : w > 100 ? 'warn' : 'ok';
          const incoming = st.moving.filter((m) => m.to === n).length, outgoing = st.moving.filter((m) => m.from === n).length;
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name"><strong><i class="kv-swatch kv-c${hue[n]}"></i>${NAME[n]}${member ? '' : ' · not in the ring'}</strong><span>${dead(sim, n) ? 'down' : `${k} keys${incoming ? ` · ${incoming} arriving` : ''}${outgoing ? ` · ${outgoing} leaving` : ''}`}</span></div><div class="ops-bar"><i style="width:${Math.min(100, (k / 300) * 100)}%"></i></div><span class="ops-val">${dead(sim, n) ? '–' : `${SDL.fmtMs(w)} wait`}</span></div>`;
        }).join('');
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="ring"]'), {
          ring,
          rows: `<div class="ops-shards">${rows}</div>`,
          stats: `<p class="app-sub">${st.config.modulo ? 'modulo hashing' : st.config.vnodes ? `${VNODES} tokens per node` : 'one token per node'} · forwarding ${st.config.forward ? 'on' : 'off'} · ${st.stats.copied} keys moved · ${st.stats.misses} misses · ${st.stats.redirects} redirects${st.flood ? ` · flash sale: ${FLOOD}/s on ${HOT_KEYS} keys` : ''}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });

  function keysOnInit(n) { let c = 0; for (const k of ALL_KEYS) if (R.owners(initRing, k, 1)[0] === n) c++; return c; }

  /** Router: send to the cached owner; on “not owner” refresh from the metadata service and retry. */
  function* route(ctx, op, p) {
    const st = ctx.state;
    const sim = ctx.sim;
    let redirects = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = routerOwner(st, p.key);
      const r = yield ctx.call(target, op, p, { timeout: 1200, quiet: p.quiet });
      if (r.ok) { if (!p.quiet && redirects) r.value.redirects = redirects; return r.value; }
      if (r.error.code !== 'NOT_OWNER') ctx.fail(r.error.code, r.error.message);
      st.stats.redirects++; redirects++;
      if (ctx.mode('staleMap')) { if (!p.quiet) ctx.log({ op: 'ring update ignored', status: 'warn', detail: 'The router kept its stale map.' }); ctx.fail('WRONG_OWNER', `${NAME[target]} says it does not own ${p.key}, and the router will not refresh its ring.`); }
      const m = yield ctx.call('meta', 'ring', {}, { timeout: 300, quiet: p.quiet });
      if (!m.ok) ctx.fail('WRONG_OWNER', `${NAME[target]} does not own ${p.key} and the metadata service is unavailable, so the router cannot refresh its ring.`);
      refreshRouter(st);
      if (!p.quiet) ctx.log({ op: `ring refreshed: ${p.key} → ${NAME[routerOwner(st, p.key)]}`, status: 'retry', detail: 'Retrying at the owner the metadata service names.' });
    }
    ctx.fail('WRONG_OWNER', 'No node would take the request.');
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
