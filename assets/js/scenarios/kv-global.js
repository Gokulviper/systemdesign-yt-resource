/*
 * Global tables, region failover, and cross-region conflicts.
 * The same cart in two regions. Maya's phone is routed to the US, her
 * tablet to the EU. Each region acknowledges writes locally and ships them
 * to the other through a replication stream, so the other region is a few
 * hundred milliseconds behind on a good day and much more behind when the
 * link is slow or a region is down. Concurrent writes meet under a conflict
 * rule: last writer wins, or a merge. When a region fails, the global router
 * sends its users to the other region, and the writes that had not yet left
 * the failed region come back later to meet whatever was written meanwhile.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const KEY = 'cart:maya';
  const REGIONS = ['us', 'eu'];
  const DB = { us: 'usDb', eu: 'euDb' };
  const API = { us: 'usApi', eu: 'euApi' };
  const REPL = { us: 'usRepl', eu: 'euRepl' };
  const STREAM = { us: 'us-out', eu: 'eu-out' };
  const OTHER = { us: 'eu', eu: 'us' };
  const HOME = { maya: 'us', tablet: 'eu' };
  const DEVICE = { maya: 'phone', tablet: 'tablet' };
  const RNAME = { us: 'US', eu: 'EU' };
  const LINK_MS = 120;
  const POLL_MS = 100;
  const BATCH = 25;
  const HEALTH_MS = 400;
  const STICKY_MS = 3000;
  const SKEW_MS = 2000;
  const LOAD_RATE = 3;

  const dead = (sim, n) => !!(sim.nodes[n].modes.down || sim.nodes[n].modes.crashed);
  const skewOf = (sim, r) => (sim.nodes[DB[r]].modes.ahead ? SKEW_MS : 0);
  const linkFactor = (sim, r) => { const m = sim.nodes[REPL[r]].modes.slow; return m ? (m.factor || 10) : 1; };
  const regionOf = (sim, dev, forRead) => {
    const st = sim.state;
    const sticky = st.lastWrite[dev];
    if (forRead && st.config.sticky && sticky && sim.now - sticky.t < STICKY_MS && st.healthy[sticky.region]) return { region: sticky.region, why: 'sticky' };
    const r = st.routed[dev];
    return { region: r, why: r === HOME[dev] ? 'home' : 'failover' };
  };
  const later = (a, b) => a.ts > b.ts || (a.ts === b.ts && a.region > b.region);
  function applyVersion(st, region, v, source) {
    const cur = st.data[region][v.key];
    if (st.config.merge) {
      const items = cur ? Y.kv.union([cur.items, v.items]) : v.items.slice();
      const ts = cur ? Math.max(cur.ts, v.ts) : v.ts;
      st.data[region][v.key] = { key: v.key, items, ts, region: !cur || later(v, cur) ? v.region : cur.region };
      return { applied: true, lost: [] };
    }
    if (cur && !later(v, cur)) { const lost = v.items.filter((it) => !cur.items.includes(it)); if (v.key === KEY) for (const it of lost) if (!st.lost.includes(it)) st.lost.push(it); return { applied: false, lost }; }
    const lost = cur ? cur.items.filter((it) => !v.items.includes(it)) : [];
    if (v.key === KEY) for (const it of lost) if (!st.lost.includes(it)) st.lost.push(it);
    st.data[region][v.key] = Object.assign({}, v);
    void source;
    return { applied: true, lost };
  }
  function truth(sim) {
    const st = sim.state;
    const vs = REGIONS.map((r) => st.data[r][KEY]).filter(Boolean);
    const inflight = REGIONS.flatMap((r) => { const q = sim.queues[STREAM[r]]; const g = q.groups[REPL[r]]; const from = g ? g.offset : 0; return q.msgs.slice(from).map((m) => m.payload).filter((v) => v.key === KEY); });
    const all = vs.concat(inflight);
    if (!all.length) return { items: [], ts: 0 };
    if (st.config.merge) return { items: Y.kv.union(all.map((v) => v.items)), ts: Math.max(...all.map((v) => v.ts)) };
    return all.reduce((b, v) => (later(v, b) ? v : b));
  }

  function flipDevice(sim, dev) { const st = sim.state; st.routed[dev] = OTHER[st.routed[dev]]; st.stats.flips++; sim.note(`Routing flipped: the ${DEVICE[dev]} now goes to ${RNAME[st.routed[dev]]}.`); }

  /* ---------- Maya ---------- */
  function startAdd(sim, dev, item) {
    const u = sim.ui[dev];
    sim.startAction(`Maya (${DEVICE[dev]}): add ${item}`, function* (ctx) {
      const st = ctx.state;
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'The write carries the whole cart.'] });
      const route = ctx.must(yield ctx.call('dns', 'route', { device: dev, op: 'write' }, { timeout: 300 }));
      const items = Y.kv.union([u.cart, [item]]);
      const r = yield ctx.call(API[route.region], 'put', { key: KEY, items, device: dev }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency; u.lastRegion = route.region; u.touched = true;
      if (!r.ok) {
        u.error = `${RNAME[route.region]}: ${r.error.message}`;
        Y.failed(ctx, 'The cart shows an error.');
        ctx.explain(`The ${DEVICE[dev]} was routed to ${RNAME[route.region]} and the write failed there: ${r.error.message} ${st.config.autoFailover ? `The health check will move this user to ${RNAME[OTHER[route.region]]} within a second.` : 'Automatic failover is off; someone has to flip the routing by hand.'}`);
        return;
      }
      u.cart = items; st.acked[dev] = Y.kv.union([st.acked[dev], [item]]); st.lastWrite[dev] = { region: route.region, t: ctx.now() };
      Y.L(ctx, { displayed: 'yes', accepted: ['yes', `${RNAME[route.region]} region.`], committed: ['yes', `Durable in ${RNAME[route.region]}; stamped t=${r.value.ts}.`], async: ['pending', `Replicating to ${RNAME[OTHER[route.region]]}.`] });
      const skew = skewOf(ctx.sim, route.region);
      ctx.explain(`Saved in ${RNAME[route.region]} (${route.why === 'failover' ? 'failed over from ' + RNAME[HOME[dev]] : 'home region'}) in ${SDL.fmtMs(r.latency)}, stamped t=${r.value.ts}${skew ? ` by a clock ${skew / 1000} s ahead` : ''}. The version is on the ${RNAME[route.region]}→${RNAME[OTHER[route.region]]} stream; ${RNAME[OTHER[route.region]]} will apply it under the ${st.config.merge ? 'merge' : 'last-writer-wins'} rule when it arrives.`);
    }, { self: dev });
  }
  function startRefresh(sim, dev) {
    const u = sim.ui[dev];
    sim.startAction(`Maya (${DEVICE[dev]}): refresh cart`, function* (ctx) {
      const st = ctx.state;
      u.pending = true; u.error = '';
      Y.L(ctx, { displayed: 'pending', retrySafe: 'yes' });
      const route = ctx.must(yield ctx.call('dns', 'route', { device: dev, op: 'read' }, { timeout: 300 }));
      const r = yield ctx.call(API[route.region], 'get', { key: KEY }, { timeout: 1500 });
      ctx.recordOutcome(r.ok, r.latency);
      u.pending = false; u.lastMs = r.latency; u.lastRegion = route.region; u.touched = true;
      if (!r.ok) { u.error = `${RNAME[route.region]}: ${r.error.message}`; Y.failed(ctx, 'Not refreshed.'); ctx.explain(r.error.message); return; }
      u.cart = r.value.items;
      const t = truth(ctx.sim);
      const missing = t.items.filter((it) => !r.value.items.includes(it));
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'n/a', async: 'n/a' });
      ctx.explain(`Read from ${RNAME[route.region]} (${route.why === 'sticky' ? 'the region this device last wrote to' : route.why === 'failover' ? 'failed over' : 'home region'}): ${r.value.items.join(', ') || 'an empty cart'}.${missing.length ? ` “${missing.join('”, “')}” ${missing.length === 1 ? 'is' : 'are'} in the other region or on the stream and ${missing.length === 1 ? 'has' : 'have'} not arrived here yet: replication lag made visible.` : ''}`);
    }, { self: dev });
  }

  /* ---------- regions ---------- */
  function regionApi(r) {
    return {
      put: function* (ctx, p) { return ctx.must(yield ctx.call(DB[r], 'put', p, { timeout: 1200, quiet: ctx.quiet })); },
      get: function* (ctx, p) { return ctx.must(yield ctx.call(DB[r], 'get', p, { timeout: 1200, quiet: ctx.quiet })); },
    };
  }
  function regionDb(r) {
    return {
      put(ctx, p) {
        const st = ctx.state;
        const v = { key: p.key, items: p.items, ts: ctx.now() + skewOf(ctx.sim, r), region: r };
        applyVersion(st, r, v, 'local');
        st.stats.writes[r]++;
        ctx.sim.enqueue(STREAM[r], { type: 'replicate', eventId: `${r}-${st.stats.writes[r]}`, payload: v, actionId: ctx.actionId, quiet: p.key !== KEY });
        return { ts: v.ts };
      },
      get(ctx, p) { const v = ctx.state.data[r][p.key]; return { items: v ? v.items : [], ts: v ? v.ts : 0 }; },
      applyBatch(ctx, p) {
        let out = { applied: 0 };
        for (const v of p.versions) { const res = sc.handlers[DB[r]].apply(ctx, { version: v }); if (res.applied) out.applied++; }
        return out;
      },
      apply(ctx, p) {
        const st = ctx.state;
        const res = applyVersion(st, r, p.version, 'stream');
        st.stats.applied[r]++;
        if (p.version.key === KEY) ctx.log({ op: `${RNAME[r]} applied ${RNAME[OTHER[r]]}’s version`, status: res.applied ? 'ok' : 'warn', detail: res.applied ? `${RNAME[r]} now has ${st.data[r][KEY].items.join(', ') || 'an empty cart'}${res.lost.length ? `. Last writer wins discarded “${res.lost.join('”, “')}”` : ''}.` : `${RNAME[r]} kept its own version (t=${st.data[r][KEY].ts}), which is newer than the incoming t=${p.version.ts}${res.lost.length ? `; “${res.lost.join('”, “')}” from ${RNAME[OTHER[r]]} is discarded` : ''}.` });
        return res;
      },
    };
  }

  const sc = (SDL.scenarios['kv-global'] = {
    id: 'kv-global',
    seed: 59,
    minHopMs: 5,
    productWidth: 640,
    intro: 'Add an item on the phone (US) and refresh the tablet (EU) a moment later to see the lag. Then write on both at once under each conflict rule, slow the link, take the US down right after a write, and flip the phone’s routing between regions.',
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'maya', label: 'Maya’s phone', kind: 'client', sub: 'In the US', x: 90, y: 120, latency: 1, role: 'Routed to the US region by the global router, unless the US is unhealthy or someone flips it.', owns: ['What the phone shows'] },
        { id: 'tablet', label: 'Maya’s tablet', kind: 'client', sub: 'In the EU', x: 90, y: 470, latency: 1, role: 'Routed to the EU region.', owns: ['What the tablet shows'] },
        { id: 'dns', label: 'Global router', kind: 'gateway', sub: 'Health checks', x: 330, y: 295, latency: 1, role: `Sends each user to a home region. Probes each region every ${HEALTH_MS} ms; with automatic failover on, two failed probes move that region's users to the other one. With sticky reads on, a device reads from the region it last wrote to for ${STICKY_MS / 1000} s.`, ops: [{ name: 'route', desc: 'Pick a region.' }], owns: ['Routing table', 'Health state'] },
        { id: 'usApi', label: 'US API', kind: 'service', sub: 'us-east', x: 560, y: 120, latency: 2, role: 'Reads and writes the US copy.', owns: ['Nothing durable'] },
        { id: 'euApi', label: 'EU API', kind: 'service', sub: 'eu-west', x: 560, y: 470, latency: 2, role: 'Reads and writes the EU copy.', owns: ['Nothing durable'] },
        { id: 'usDb', label: 'US table', kind: 'db', sub: 'Full copy', x: 800, y: 120, latency: 3, role: 'Acknowledges writes locally, stamps them with its clock, and appends them to the US→EU stream. Applies EU versions under the conflict rule.', ops: [{ name: 'put', desc: 'Write locally, enqueue.' }, { name: 'get', desc: 'Local read.' }, { name: 'apply', desc: 'Apply a remote version.' }], owns: ['US copy', 'US→EU stream'] },
        { id: 'euDb', label: 'EU table', kind: 'db', sub: 'Full copy', x: 800, y: 470, latency: 3, role: 'Same for the EU. Its clock can be skewed, which matters under last writer wins.', ops: [{ name: 'put', desc: 'Write locally, enqueue.' }, { name: 'get', desc: 'Local read.' }, { name: 'apply', desc: 'Apply a remote version.' }], owns: ['EU copy', 'EU→US stream'] },
        { id: 'usRepl', label: 'Replicator US→EU', kind: 'worker', sub: `Link ${LINK_MS} ms`, x: 1040, y: 200, latency: 2, role: 'Reads the US stream in order and applies each version in the EU. Slow or down, the stream backs up; nothing is lost while the US table itself survives.', owns: ['Stream position'] },
        { id: 'euRepl', label: 'Replicator EU→US', kind: 'worker', sub: `Link ${LINK_MS} ms`, x: 1040, y: 390, latency: 2, role: 'Same for the EU stream.', owns: ['Stream position'] },
      ],
      edges: [
        { from: 'maya', to: 'dns', latency: 10 }, { from: 'tablet', to: 'dns', latency: 10 },
        { from: 'maya', to: 'usApi', latency: 20, via: [[330, 60]] }, { from: 'maya', to: 'euApi', latency: 90, via: [[220, 295]] },
        { from: 'tablet', to: 'euApi', latency: 20, via: [[330, 540]] }, { from: 'tablet', to: 'usApi', latency: 90, via: [[440, 295]] },
        { from: 'usApi', to: 'usDb', latency: 2 }, { from: 'euApi', to: 'euDb', latency: 2 },
        { from: 'usDb', to: 'usRepl', latency: 2 }, { from: 'usRepl', to: 'euDb', latency: LINK_MS },
        { from: 'euDb', to: 'euRepl', latency: 2 }, { from: 'euRepl', to: 'usDb', latency: LINK_MS },
        { from: 'dns', to: 'usDb', latency: 2, via: [[330, 30], [800, 30]] }, { from: 'dns', to: 'euDb', latency: 2, via: [[330, 560], [800, 560]] },
      ],
      queues: [
        { id: 'us-out', broker: 'usDb', label: 'US→EU stream', groups: ['usRepl'] },
        { id: 'eu-out', broker: 'euDb', label: 'EU→US stream', groups: ['euRepl'] },
      ],
    },
    modeLabels: { ahead: `Clock ${SKEW_MS / 1000} s ahead` },
    failures: [
      { id: 'us-down', node: 'usDb', mode: 'down', label: 'US region down', desc: 'Writes and reads in the US fail. Anything on the US→EU stream that had not been shipped waits until the region is back.' },
      { id: 'eu-down', node: 'euDb', mode: 'down', label: 'EU region down', desc: 'Same for the EU.' },
      { id: 'link-slow', node: 'usRepl', mode: 'slow', params: { factor: 20 }, label: 'US→EU link slow', desc: 'Each version takes seconds to cross. The EU falls further behind with every write.' },
      { id: 'link-down', node: 'usRepl', mode: 'down', label: 'US→EU replication down', desc: 'The stream backs up. When the replicator returns it drains in order.' },
      { id: 'eu-ahead', node: 'euDb', mode: 'ahead', label: `EU clock ${SKEW_MS / 1000} s ahead`, desc: 'EU versions look newer than they are. Under last writer wins, US writes made in the next two seconds lose to older EU writes.' },
    ],
    switches: Y.switches([
      ['merge', 'Merge concurrent versions (off: last writer wins)', 'When a version arrives from the other region the carts are merged by union. Off: the version with the later timestamp replaces the other, whole.'],
      ['autoFailover', 'Automatic failover', `Two failed health probes (${HEALTH_MS} ms apart) move a region's users to the other region; two good probes move them back.`],
      ['sticky', 'Read from the region you last wrote to', `For ${STICKY_MS / 1000} s after a write, a device's reads go to the region that took the write, so it sees its own writes even if routing changes.`],
    ]),
    presets: Y.presets({ merge: false, autoFailover: true, sticky: false }, [
      { id: 'lag', label: 'Write in the US, read in the EU', desc: 'The phone adds socks in the US. The tablet refreshes 300 ms later from the EU: the version is still on the stream, so the tablet shows an empty cart. A second refresh a little later has it. Cross-region reads are eventually consistent.', run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(600, () => startRefresh(s, 'tablet')); s.schedule(1600, () => startRefresh(s, 'tablet')); } },
      { id: 'concurrent-lww', label: 'Both regions write at once, last writer wins', desc: 'Socks in the US and a hat in the EU at the same moment. Each region acknowledges its own write, then receives the other’s. The later timestamp wins in both places: the regions agree, and one acknowledged item is gone.', run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(300, () => startAdd(s, 'tablet', 'Hat')); s.schedule(2000, () => startRefresh(s, 'maya')); s.schedule(2200, () => startRefresh(s, 'tablet')); } },
      { id: 'concurrent-merge', label: 'Both regions write at once, merge', desc: 'The same writes with a merge rule. Each region unions the incoming cart with its own. Both regions end with socks and a hat.', sw: { merge: true }, run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(300, () => startAdd(s, 'tablet', 'Hat')); s.schedule(2000, () => startRefresh(s, 'maya')); s.schedule(2200, () => startRefresh(s, 'tablet')); } },
      { id: 'skew-lww', label: 'Clock skew: the EU’s older write wins', desc: `The EU clock is ${SKEW_MS / 1000} s ahead. The tablet adds a hat; the phone refreshes, sees it, and adds socks a second later. The US version is newer but its timestamp is smaller, so both regions keep the hat-only cart. Last writer wins trusts clocks.`, run: (s) => { s.inject('euDb', 'ahead'); s.schedule(300, () => startAdd(s, 'tablet', 'Hat')); s.schedule(1200, () => startRefresh(s, 'maya')); s.schedule(1600, () => startAdd(s, 'maya', 'Socks')); s.schedule(3200, () => startRefresh(s, 'maya')); s.schedule(3400, () => startRefresh(s, 'tablet')); } },
      { id: 'link-slow', label: 'Slow link: lag you can see', desc: 'The US→EU link is twenty times slower. The phone adds socks; the tablet refreshes after a second and still sees the old cart. Nothing is wrong, only late; the lag metric shows how late.', run: (s) => { s.inject('usRepl', 'slow', { factor: 20 }); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(1500, () => startRefresh(s, 'tablet')); } },
      { id: 'link-recovers', label: 'Replication down, then draining', desc: 'The US→EU replicator is down while the phone adds two items. The stream backs up to two versions (plus background writes). When the replicator returns it drains in order and the tablet catches up.', run: (s) => { s.inject('usRepl', 'down'); s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(900, () => startAdd(s, 'maya', 'Hat')); s.schedule(1500, () => startRefresh(s, 'tablet')); s.schedule(4000, () => s.restore('usRepl')); s.schedule(6000, () => startRefresh(s, 'tablet')); } },
      { id: 'failover', label: 'US down: the phone fails over to the EU', desc: 'The phone’s socks reach the EU; then the US goes down. Two failed probes later the router sends the phone to the EU, where its next write and read work. When the US returns, the EU→US stream catches it up.', run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(1500, () => s.inject('usDb', 'down')); s.schedule(3000, () => startAdd(s, 'maya', 'Hat')); s.schedule(3800, () => startRefresh(s, 'maya')); s.schedule(5500, () => s.restore('usDb')); s.schedule(7500, () => startRefresh(s, 'tablet')); } },
      { id: 'no-failover', label: 'US down, no automatic failover', desc: 'Same outage with automatic failover off. The phone keeps going to the US and every request fails until someone flips the routing by hand.', sw: { autoFailover: false }, run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(1500, () => s.inject('usDb', 'down')); s.schedule(3000, () => startAdd(s, 'maya', 'Hat')); } },
      { id: 'failover-unreplicated-lww', label: 'Failover with an unreplicated write, last writer wins', desc: 'The phone adds socks and the US goes down before the version leaves. The phone fails over to the EU, sees an empty cart, and adds a hat. When the US comes back the socks finally cross: older timestamp, discarded. The acknowledged socks are lost in both regions.', run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(420, () => s.inject('usDb', 'down')); s.schedule(2500, () => startRefresh(s, 'maya')); s.schedule(3000, () => startAdd(s, 'maya', 'Hat')); s.schedule(5000, () => s.restore('usDb')); s.schedule(7000, () => startRefresh(s, 'maya')); s.schedule(7200, () => startRefresh(s, 'tablet')); } },
      { id: 'failover-unreplicated-merge', label: 'Failover with an unreplicated write, merge', desc: 'The same sequence with the merge rule. When the socks finally cross they are unioned with the hat. Both regions end with both items.', sw: { merge: true }, run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(420, () => s.inject('usDb', 'down')); s.schedule(2500, () => startRefresh(s, 'maya')); s.schedule(3000, () => startAdd(s, 'maya', 'Hat')); s.schedule(5000, () => s.restore('usDb')); s.schedule(7000, () => startRefresh(s, 'maya')); s.schedule(7200, () => startRefresh(s, 'tablet')); } },
      { id: 'flip-stale', label: 'Routing flips between a write and a read', desc: 'The phone writes in the US; routing flips it to the EU; its very next read comes from the EU before the version has crossed. Maya cannot see what she just saved. Read-your-writes does not survive a region change.', run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(380, () => flipDevice(s, 'maya')); s.schedule(390, () => startRefresh(s, 'maya')); } },
      { id: 'flip-sticky', label: 'The same flip with sticky reads', desc: `For ${STICKY_MS / 1000} s after a write the device reads from the region that took it, so the read goes back to the US and shows the socks. After that the EU has caught up anyway.`, sw: { sticky: true }, run: (s) => { s.schedule(300, () => startAdd(s, 'maya', 'Socks')); s.schedule(380, () => flipDevice(s, 'maya')); s.schedule(390, () => startRefresh(s, 'maya')); } },
    ]),
    initialState: () => ({
      config: { merge: false, autoFailover: true, sticky: false },
      data: { us: {}, eu: {} }, routed: { maya: 'us', tablet: 'eu' }, healthy: { us: true, eu: true }, probeFails: { us: 0, eu: 0 }, probeOks: { us: 0, eu: 0 },
      lastWrite: {}, acked: { maya: [], tablet: [] }, lost: [], maxBacklog: 0,
      stats: { writes: { us: 0, eu: 0 }, applied: { us: 0, eu: 0 }, flips: 0 },
    }),
    initialUI: () => ({
      maya: { cart: [], pending: false, error: '', lastMs: null, lastRegion: 'us', touched: false },
      tablet: { cart: [], pending: false, error: '', lastMs: null, lastRegion: 'eu', touched: false },
    }),
    actions: {
      add(sim, a) { startAdd(sim, a.device, a.item); },
      refresh(sim, a) { startRefresh(sim, a.device); },
      flip(sim, a) { flipDevice(sim, a.device || 'maya'); },
    },
    handlers: {
      dns: {
        route(ctx, p) { const r = regionOf(ctx.sim, p.device, p.op === 'read'); return r; },
      },
      usApi: regionApi('us'), euApi: regionApi('eu'),
      usDb: regionDb('us'), euDb: regionDb('eu'),
    },
    setup(sim) {
      for (const r of REGIONS) {
        // Replicator: reads the stream in order and applies each version in the other region.
        sim.spawn(function* (ctx) {
          for (;;) {
            const { msgs } = yield ctx.take(STREAM[r], REPL[r], BATCH);
            yield ctx.wait(POLL_MS + LINK_MS * (linkFactor(ctx.sim, r) - 1));
            // The records live in the source region's stream until shipped: a dead region takes them down with it.
            while (dead(ctx.sim, DB[r])) yield ctx.wait(200);
            const quiet = msgs.every((m) => m.quiet) ? 'all' : false;
            for (;;) {
              const res = yield ctx.call(DB[OTHER[r]], 'applyBatch', { versions: msgs.map((m) => m.payload) }, { timeout: 2000, quiet });
              if (res.ok) break;
              yield ctx.wait(500);
            }
            ctx.ack(STREAM[r], REPL[r]);
          }
        }, { self: REPL[r], quiet: 'all' });
        // Light background traffic in each region keeps the streams visible.
        Y.load(sim, API[r], () => LOAD_RATE, function* (c, i) { yield c.call(DB[r], 'put', { key: `cart:${r}${i % 40}`, items: [`item${i % 5}`] }, { timeout: 1200, quiet: 'all' }); });
      }
      // Health probes and failover.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(HEALTH_MS);
          const st = ctx.state;
          for (const r of REGIONS) {
            const ok = !dead(ctx.sim, DB[r]);
            if (ok) { st.probeOks[r]++; st.probeFails[r] = 0; } else { st.probeFails[r]++; st.probeOks[r] = 0; }
            if (st.healthy[r] && st.probeFails[r] >= 2) { st.healthy[r] = false; ctx.sim._log({ node: 'dns', op: `${RNAME[r]} marked unhealthy`, status: 'fault', detail: `Two probes failed. ${st.config.autoFailover ? `Users of ${RNAME[r]} are sent to ${RNAME[OTHER[r]]}.` : 'Automatic failover is off: routing is unchanged.'}` }); if (st.config.autoFailover) for (const d of Object.keys(st.routed)) if (st.routed[d] === r) { st.routed[d] = OTHER[r]; st.stats.flips++; } }
            if (!st.healthy[r] && st.probeOks[r] >= 2) { st.healthy[r] = true; ctx.sim._log({ node: 'dns', op: `${RNAME[r]} healthy again`, status: 'recovered', detail: `Two probes succeeded. ${st.config.autoFailover ? `${RNAME[r]}'s users go home.` : ''}` }); if (st.config.autoFailover) for (const d of Object.keys(st.routed)) if (HOME[d] === r) st.routed[d] = r; }
          }
          const backlog = Math.max(...REGIONS.map((x) => ctx.sim.queueStats(STREAM[x]).depth));
          st.maxBacklog = Math.max(st.maxBacklog, backlog);
        }
      }, { self: 'dns', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state; const ui = sim.ui;
      const t = truth(sim);
      const lagged = REGIONS.filter((r) => { const q = sim.queueStats(STREAM[r]); return q.depth > 4 || q.lag > 1000; });
      if (st.lost.length) return { key: 'wrong', label: `“${st.lost.join('”, “')}” ${st.lost.length === 1 ? 'was' : 'were'} acknowledged in one region and discarded when the versions met: last writer wins kept the version with the later timestamp${REGIONS.some((r) => skewOf(sim, r)) ? ', and the EU clock is ahead' : ''}.` };
      for (const dev of ['maya', 'tablet']) {
        if (ui[dev].pending) return { key: 'stale', label: `The ${DEVICE[dev]} is waiting.` };
        if (ui[dev].error) return { key: 'stale', label: `The ${DEVICE[dev]}’s last request failed in ${ui[dev].error}` };
      }
      const downR = REGIONS.filter((r) => dead(sim, DB[r]));
      if (downR.length) return { key: 'stale', label: `${downR.map((r) => RNAME[r]).join(', ')} is down. ${sim.queueStats(STREAM[downR[0]]).total - (sim.queues[STREAM[downR[0]]].groups[REPL[downR[0]]] || { offset: 0 }).offset} version${sim.queueStats(STREAM[downR[0]]).depth === 1 ? '' : 's'} on its outbound stream cannot leave until it returns.` };
      if (lagged.length) { const q = sim.queueStats(STREAM[lagged[0]]); return { key: 'stale', label: `${RNAME[lagged[0]]}→${RNAME[OTHER[lagged[0]]]} stream: ${q.depth} version${q.depth === 1 ? '' : 's'} behind, ${SDL.fmtMs(q.lag)} of lag. The other region is serving older data.` }; }
      const vs = REGIONS.map((r) => st.data[r][KEY]).filter(Boolean);
      if (vs.length === 2 && (vs[0].items.length !== vs[1].items.length || vs[0].items.some((it) => !vs[1].items.includes(it)))) return { key: 'stale', label: `The regions disagree: US has ${vs[0].items.join(', ') || 'nothing'}, EU has ${vs[1].items.join(', ') || 'nothing'}.` };
      for (const dev of ['maya', 'tablet'].filter((d) => ui[d].touched)) {
        const missing = t.items.filter((it) => !ui[dev].cart.includes(it)).concat(ui[dev].cart.filter((it) => !t.items.includes(it)));
        if (missing.length) return { key: 'stale', label: `The ${DEVICE[dev]} shows ${ui[dev].cart.join(', ') || 'an empty cart'}; both regions have ${t.items.join(', ') || 'nothing'}. Its last read came from ${RNAME[ui[dev].lastRegion]} before that region had caught up.` };
      }
      return { key: 'ok', label: `Both regions and both devices agree on ${t.items.length} item${t.items.length === 1 ? '' : 's'}${st.stats.flips ? `; routing flipped ${st.stats.flips} time${st.stats.flips === 1 ? '' : 's'}` : ''}${st.maxBacklog > 2 ? `; the stream backed up to ${st.maxBacklog} versions at its worst` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const q = (r) => sim.queueStats(STREAM[r]);
      return [
        { label: 'Phone / tablet routed to', value: `${RNAME[st.routed.maya]} / ${RNAME[st.routed.tablet]}`, tone: st.routed.maya !== 'us' || st.routed.tablet !== 'eu' ? 'warn' : '' },
        { label: 'Regions healthy', value: REGIONS.map((r) => `${RNAME[r]} ${st.healthy[r] ? '✓' : '✕'}`).join(' · '), tone: REGIONS.every((r) => st.healthy[r]) ? '' : 'fail' },
        { label: 'US→EU stream: behind / lag', value: `${q('us').depth} / ${SDL.fmtMs(q('us').lag)}`, tone: q('us').depth > 3 ? 'warn' : '' },
        { label: 'EU→US stream: behind / lag', value: `${q('eu').depth} / ${SDL.fmtMs(q('eu').lag)}`, tone: q('eu').depth > 3 ? 'warn' : '' },
        { label: 'Conflict rule', value: st.config.merge ? 'merge (union)' : 'last writer wins' },
        { label: 'Cart in US / EU', value: REGIONS.map((r) => (st.data[r][KEY] ? st.data[r][KEY].items.join(', ') || 'empty' : '–')).join(' / ') },
        { label: 'Phone / tablet last request', value: `${sim.ui.maya.lastMs == null ? '–' : SDL.fmtMs(sim.ui.maya.lastMs)} / ${sim.ui.tablet.lastMs == null ? '–' : SDL.fmtMs(sim.ui.tablet.lastMs)}` },
        { label: 'Items lost to conflicts', value: st.lost.length, tone: st.lost.length ? 'fail' : '' },
        { label: 'Routing flips', value: st.stats.flips },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['maya', 'Maya’s phone (US)'], ['tablet', 'Maya’s tablet (EU)']], {
          note: 'Each device is routed to its home region. The console shows each region’s copy of the cart, the replication streams, and where each device is routed right now.',
          below: `<div class="ops-console"><p class="ops-title">Regions and streams</p><div class="ops-traffic">${Y.btn('flip', 'Flip the phone’s region', { arg: { device: 'maya' }, cls: 'secondary' })}${Y.btn('flip', 'Flip the tablet’s region', { arg: { device: 'tablet' }, cls: 'secondary' })}</div><div data-ref="regions"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const dev of ['maya', 'tablet']) {
          const u = sim.ui[dev];
          const r = regionOf(sim, dev, false).region;
          Y.paint(el, sim, dev, {
            head: `<div><p class="app-title">Cart</p><p class="app-sub">Maya · ${DEVICE[dev]} · routed to ${RNAME[r]}${r !== HOME[dev] ? ' (failed over)' : ''}</p></div>`,
            cart: u.cart.length ? u.cart.map((it) => `<div class="app-card ${st.lost.includes(it) ? 'is-fail' : ''}"><span class="app-kv"><strong>${esc(it)}</strong><span>1</span></span></div>`).join('') : '<p class="app-sub">Your cart is empty.</p>',
            msg: Y.msg(u.error, 'fail') || (u.pending ? '<p class="app-msg"><span class="spinner"></span>Working…</p>' : ''),
            actions: `<div class="app-row">${['Socks', 'Hat', 'Mug'].map((it) => Y.btn('add', `Add ${it.toLowerCase()}`, { arg: { device: dev, item: it }, cls: u.cart.includes(it) ? 'secondary' : '', disabled: u.pending })).join('')}</div><div class="app-row">${Y.btn('refresh', 'Refresh', { arg: { device: dev }, cls: 'secondary', disabled: u.pending })}</div>`,
          }, {});
        }
        const rows = REGIONS.map((r) => {
          const v = st.data[r][KEY];
          const q = sim.queueStats(STREAM[r]);
          const down = dead(sim, DB[r]);
          const tone = down ? 'fail' : q.depth > 0 || !st.healthy[r] ? 'warn' : 'ok';
          return `<div class="ops-row" data-tone="${tone}"><div class="ops-name"><strong>${RNAME[r]} region${skewOf(sim, r) ? ` · clock +${skewOf(sim, r) / 1000} s` : ''}</strong><span>${down ? 'down' : st.healthy[r] ? 'healthy' : 'marked unhealthy'} · ${Object.keys(st.routed).filter((d) => st.routed[d] === r).map((d) => DEVICE[d]).join(', ') || 'no devices'} routed here</span></div><span class="ops-val">cart: ${v ? `[${v.items.join(', ') || 'empty'}] t=${v.ts} from ${RNAME[v.region]}` : 'nothing yet'} · outbound stream: ${q.depth} behind${q.depth ? `, ${SDL.fmtMs(q.lag)} lag` : ''}</span></div>`;
        }).join('');
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="regions"]'), {
          rows: `<div class="ops-shards">${rows}</div>`,
          cfg: `<p class="app-sub">Conflict rule: ${st.config.merge ? 'merge by union' : 'last writer wins'} · failover ${st.config.autoFailover ? 'automatic' : 'manual'} · sticky reads ${st.config.sticky ? 'on' : 'off'} · link ${LINK_MS} ms each way.</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
