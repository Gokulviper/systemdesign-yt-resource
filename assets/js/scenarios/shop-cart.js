/*
 * Cart across devices.
 * One shopper, a phone and a tablet, one cart. The cart service writes the
 * cart document to a primary database, which replicates to a read replica
 * (for cart pages) and to a standby (for failover). Guest carts live in a
 * separate store keyed by cookie and are merged at sign-in.
 *
 * Each correctness rule is a design switch:
 *  ryw        read-your-writes: a device that just wrote reads at least that version
 *  versioned  compare-and-set on the cart version, retried on conflict
 *  merge      sign-in merges the guest cart instead of discarding it
 *  idem       an idempotency key per edit, so a retried edit applies once
 *  sync       the primary waits for the standby before confirming a write
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const ITEMS = {
    echo: { name: 'Echo Dot smart speaker', price: 49.99, hue: 200 },
    kindle: { name: 'Kindle Paperwhite', price: 99.99, hue: 30 },
    cable: { name: 'USB-C cable, 2 m', price: 9.99, hue: 140 },
  };
  const DEV = { phone: 'Phone', tablet: 'Tablet' };
  const USER = 'Priya';
  const COOKIE = 'guest-7f3a';
  const name = (sku) => ITEMS[sku].name;
  const list = (items) => Object.keys(items).filter((k) => items[k] > 0).map((k) => `${name(k)}${items[k] > 1 ? ` ×${items[k]}` : ''}`).join(', ') || 'empty';
  const leaderDown = (sim) => { const m = sim.nodes[sim.state.leader].modes; return !!(m.down || m.crashed); };

  /** Copy a database's cart to the replica (and to the standby, unless it was copied synchronously). */
  function replicate(ctx, from) {
    const st = ctx.state;
    const snap = () => ({ from, ver: st.db[from].ver, items: Object.assign({}, st.db[from].items), keys: Object.assign({}, st.db[from].keys) });
    ctx.spawn(function* (c) {
      yield c.wait(80);
      while (c.mode('lag', 'replica')) yield c.wait(200);
      yield c.call('replica', 'apply', snap(), { timeout: 1000, quiet: true });
    }, { self: from, quiet: true });
    if (from === 'primary' && !st.config.sync) {
      ctx.spawn(function* (c) {
        yield c.wait(400); // asynchronous shipping to the standby
        if (c.mode('down', 'primary') || c.mode('crashed', 'primary')) return;
        yield c.call('standby', 'apply', snap(), { timeout: 1000, quiet: true });
      }, { self: from, quiet: true });
    }
  }

  /** Read-modify-write against the current primary, with compare-and-set when versioned. */
  function* modify(ctx, p, change) {
    const st = ctx.state;
    for (let a = 1; a <= 4; a++) {
      const cur = ctx.must(yield ctx.call(st.leader, 'get', {}, { timeout: 600 }));
      const items = change(Object.assign({}, cur.items));
      const w = yield ctx.call(st.leader, 'put', { items, expect: st.config.versioned ? cur.ver : null, key: st.config.idem ? p.key : null }, { timeout: 900 });
      if (w.ok) return Object.assign(w.value, { conflicts: a - 1 });
      if (w.error.code !== 'CONFLICT') ctx.must(w);
      ctx.log({ op: 'version conflict, re-reading', status: 'retry', detail: `The cart changed since version ${cur.ver} was read. The edit is applied again on top of the newer cart.` });
    }
    ctx.fail('CONFLICT', 'The cart kept changing.');
  }

  function* readCart(ctx, dev) {
    const v = ctx.ui[dev];
    const r = yield ctx.call('gateway', 'get', { user: v.user, cookie: COOKIE, minVer: v.lastVer }, { timeout: 900 });
    if (r.ok) Object.assign(v, { shown: r.value.items, source: r.value.source, shownVer: r.value.ver });
    return r;
  }

  function startEdit(sim, dev, sku, remove) {
    const u = sim.ui[dev];
    if (u.busy) return;
    const label = `${DEV[dev]}: ${remove ? 'remove' : 'add'} ${name(sku)}`;
    sim.startAction(label, function* (ctx) {
      const st = ctx.state;
      const v = ctx.ui[dev];
      const key = `${dev}-${++st.seq.key}`;
      Object.assign(v, { busy: true, message: '', tone: '', missing: null });
      Y.L(ctx, { displayed: ['pending', 'Shows a spinner on the button.'], retrySafe: [st.config.idem ? 'yes' : 'no', st.config.idem ? `Edit key ${key}: a retry is recognised.` : 'No key: a retried “add” adds again.'] });
      let r;
      for (let a = 1; a <= 2; a++) {
        r = yield ctx.call('gateway', remove ? 'remove' : 'add', { user: v.user, cookie: COOKIE, sku, key }, { timeout: 1000 });
        if (r.ok || r.error.code !== 'TIMEOUT' || a === 2) break;
        ctx.sim.retries++;
        ctx.log({ op: `retry ${key}`, status: 'retry', detail: `No reply, so the ${DEV[dev].toLowerCase()} sends the same edit again${st.config.idem ? ' with the same key' : ''}.` });
        yield ctx.wait(200);
      }
      ctx.recordOutcome(r.ok, r.latency || 0);
      v.busy = false;
      if (!r.ok) {
        Object.assign(v, { message: `Couldn’t update your cart (${r.error.code}).`, tone: 'fail' });
        Y.failed(ctx, 'Shows an error.');
        ctx.explain(r.error.code === 'UNAVAILABLE' ? 'The cart database is unavailable. The failover manager promotes the standby within about a second; until then edits fail.' : `The edit failed with ${r.error.code}.`);
        return;
      }
      const intent = v.user ? st.intent : st.guestIntent;
      intent[sku] = remove ? 0 : (intent[sku] || 0) + 1;
      v.lastVer = v.user ? r.value.ver : 0;
      Y.L(ctx, { accepted: 'yes', committed: ['yes', v.user ? `Cart version ${r.value.ver} on the ${st.leader === 'primary' ? 'primary' : 'promoted standby'}.` : 'Saved in the guest-cart store under the cookie.'] });
      const seen = yield* readCart(ctx, dev);
      const missing = seen.ok && !remove && !(v.shown[sku] > 0);
      const lostInFailover = missing && st.leader !== 'primary' && !st.db[st.leader].items[sku];
      v.missing = missing && !lostInFailover ? sku : null;
      Object.assign(v, lostInFailover ? { message: `Added, but ${name(sku)} is gone from your cart.`, tone: 'fail' } : missing ? { message: `Added, but your cart doesn’t show ${name(sku)}.`, tone: 'warn' } : { message: remove ? 'Removed.' : 'Added to cart.', tone: 'ok' });
      Y.L(ctx, { displayed: missing ? ['no', 'The cart page read a replica that has not caught up.'] : 'yes', async: v.user ? 'pending' : 'n/a' });
      const dup = r.value.dup;
      ctx.explain(lostInFailover
        ? `The primary confirmed version ${r.value.ver}, then crashed before shipping it to the standby (asynchronous replication sends it about 0.4 s later). The standby was promoted without it, so a write the shopper was told succeeded no longer exists.`
        : missing
        ? `The write went to the primary (version ${r.value.ver}), but the cart page then read the replica, which is behind. Your own change vanished from your screen. With read-your-writes, the ${DEV[dev].toLowerCase()} sends “at least version ${r.value.ver}” and the cart service reads the primary when the replica is older.`
        : dup ? 'The first attempt was applied, but its reply was lost. The retry carried the same edit key, so the database recognised it and returned the earlier result instead of adding again.'
          : r.value.conflicts ? `Another device changed the cart between this edit’s read and its write. The write was conditional on the version it had read, so it was refused, re-read, and applied on top: both edits survive.`
            : v.user ? `Saved as cart version ${r.value.ver}${st.config.sync ? ' on the primary and the standby before confirming' : ' on the primary; the standby receives it about 0.4 s later'}. The cart page read ${v.source}.`
              : 'You are not signed in, so the item went into a guest cart keyed by your browser cookie.');
    }, { self: dev });
  }

  function startRefresh(sim, dev) {
    sim.startAction(`${DEV[dev]}: open cart`, function* (ctx) {
      ctx.ledger('committed', 'n/a', 'A read.');
      ctx.ledger('retrySafe', 'yes');
      const r = yield* readCart(ctx, dev);
      ctx.recordOutcome(r.ok, r.latency || 0);
      ctx.ledger('displayed', r.ok ? 'yes' : 'no');
      if (r.ok) {
        const v = ctx.ui[dev];
        v.missing = null;
        Object.assign(v, { message: '', tone: '' });
        ctx.explain(`The ${DEV[dev].toLowerCase()} read the cart from ${r.value.source}: ${list(r.value.items)}.`);
      }
    }, { self: dev });
  }

  function startSignIn(sim, dev) {
    const u = sim.ui[dev];
    if (u.user || u.busy) return;
    sim.startAction(`${DEV[dev]}: sign in`, function* (ctx) {
      const st = ctx.state;
      const v = ctx.ui[dev];
      v.busy = true;
      Y.L(ctx, { displayed: ['pending', 'Shows “Signing in…”.'], retrySafe: ['yes', 'Merging is keyed by the guest cookie; the guest cart is cleared after.'] });
      const r = yield ctx.call('gateway', 'signin', { cookie: COOKIE }, { timeout: 2000 });
      v.busy = false;
      if (!r.ok) { Y.failed(ctx, 'Still signed out.'); Object.assign(v, { message: `Couldn’t sign in (${r.error.code}).`, tone: 'fail' }); return; }
      v.user = USER;
      v.lastVer = r.value.ver;
      for (const [k, n] of Object.entries(st.guestIntent)) if (n > 0) st.intent[k] = Math.max(st.intent[k] || 0, n);
      st.guestIntent = {};
      Y.L(ctx, { accepted: 'yes', committed: ['yes', r.value.merged ? 'Guest items merged into the account cart.' : 'The account cart was loaded; the guest cart was discarded.'], async: 'n/a' });
      yield* readCart(ctx, dev);
      ctx.ledger('displayed', 'yes');
      Object.assign(v, { message: `Signed in as ${USER}.`, tone: 'ok' });
      ctx.explain(r.value.merged
        ? `Signing in merged the guest cart (${list(r.value.guest)}) into ${USER}’s account cart (${list(r.value.before)}). Nothing the shopper added while signed out is lost.`
        : `Signing in loaded ${USER}’s account cart (${list(r.value.before)}) and threw the guest cart away. ${list(r.value.guest)} was added a minute ago and has silently disappeared.`);
    }, { self: dev });
  }

  const sc = (SDL.scenarios['shop-cart'] = {
    id: 'shop-cart',
    seed: 412,
    productWidth: 580,
    intro: 'Add an item on the phone and open the cart on the tablet: one cart, two devices. Then edit from both at once, sign in with a guest cart, or crash the primary database.',
    topology: {
      width: 1120, height: 600,
      nodes: [
        { id: 'phone', label: 'Phone', sub: `${USER}’s phone`, kind: 'client', x: 90, y: 120, latency: 1, role: 'Edits and shows the cart. Starts signed out in the guest-cart scenarios.', owns: ['Cookie', 'Last version written'] },
        { id: 'tablet', label: 'Tablet', sub: `${USER}’s tablet`, kind: 'client', x: 90, y: 400, latency: 1, role: 'The same account on a second device.', owns: ['Last version written'] },
        { id: 'gateway', label: 'API gateway', sub: 'Cart API', kind: 'gateway', x: 290, y: 260, latency: 2, role: 'Routes cart reads, edits, and sign-in.', ops: [{ name: 'get', desc: 'Read the cart.' }, { name: 'add', desc: 'Add one.' }, { name: 'remove', desc: 'Remove a line.' }, { name: 'signin', desc: 'Sign in and merge.' }], owns: ['Nothing durable'] },
        { id: 'auth', label: 'Sign-in service', sub: 'Sessions', kind: 'service', x: 290, y: 500, latency: 6, role: 'Signs the shopper in, then asks the cart service to merge the guest cart.', ops: [{ name: 'signin', desc: 'Create a session.' }], owns: ['Sessions'] },
        { id: 'cart', label: 'Cart service', sub: 'Read-modify-write', kind: 'service', x: 520, y: 260, latency: 3, role: 'Reads the cart, applies the edit, writes it back. Chooses replica or primary for reads.', ops: [{ name: 'get', desc: 'Read a cart.' }, { name: 'add', desc: 'Add one of an item.' }, { name: 'remove', desc: 'Remove an item.' }, { name: 'merge', desc: 'Merge a guest cart.' }], owns: ['Nothing durable'] },
        { id: 'guest', label: 'Guest carts', sub: 'Key: cookie', kind: 'cache', x: 520, y: 500, latency: 3, role: 'Carts for shoppers who are not signed in, keyed by browser cookie, kept for 30 days.', ops: [{ name: 'get', desc: 'Read a guest cart.' }, { name: 'put', desc: 'Write a guest cart.' }, { name: 'clear', desc: 'Delete after merging.' }], owns: ['guestCart[cookie]'] },
        { id: 'primary', label: 'Cart DB primary', sub: 'Key: account', kind: 'db', x: 770, y: 260, latency: 6, role: 'Holds one cart document per account with a version number. Takes every write.', ops: [{ name: 'get', desc: 'Read the cart and its version.' }, { name: 'put', desc: 'Write, optionally only if the version matches.' }], owns: ['cart[account]', 'Edit keys seen'] },
        { id: 'replica', label: 'Read replica', sub: 'Cart pages', kind: 'db', x: 770, y: 80, latency: 4, role: 'An asynchronous copy that serves cart pages, about 80 ms behind.', ops: [{ name: 'get', desc: 'Read the copy.' }, { name: 'apply', desc: 'Apply a newer version.' }], owns: ['cart (copy)'] },
        { id: 'standby', label: 'Standby', sub: 'Promoted on failure', kind: 'db', x: 770, y: 460, latency: 6, role: 'A copy kept for failover. Receives writes synchronously (before confirming) or about 0.4 s later.', ops: [{ name: 'apply', desc: 'Apply a newer version.' }, { name: 'get', desc: 'Serve reads once promoted.' }, { name: 'put', desc: 'Take writes once promoted.' }], owns: ['cart (copy)'] },
        { id: 'ha', label: 'Failover manager', sub: 'Checks every 0.3 s', kind: 'worker', x: 1010, y: 360, latency: 2, role: 'Promotes the standby when the primary stops answering, and re-points the replica at it.', ops: [{ name: 'check', desc: 'Health check.' }], owns: ['Which database is primary'] },
      ],
      edges: [
        { from: 'phone', to: 'gateway', latency: 30 },
        { from: 'tablet', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'cart', latency: 3 },
        { from: 'gateway', to: 'auth', latency: 3 },
        { from: 'auth', to: 'cart', latency: 3 },
        { from: 'cart', to: 'guest', latency: 3 },
        { from: 'cart', to: 'primary', latency: 3 },
        { from: 'cart', to: 'replica', latency: 3 },
        { from: 'cart', to: 'standby', latency: 3 },
        { from: 'primary', to: 'replica', latency: 20, label: 'replication', via: [[880, 260], [880, 80]] },
        { from: 'primary', to: 'standby', latency: 20, label: 'replication', via: [[880, 260], [880, 460]] },
        { from: 'standby', to: 'replica', latency: 20, via: [[660, 460], [660, 80]] },
        { from: 'ha', to: 'primary', latency: 3 },
        { from: 'ha', to: 'standby', latency: 3 },
      ],
    },
    modeLabels: { lag: 'Replication lagging' },
    failures: [
      { id: 'lag', node: 'replica', mode: 'lag', label: 'Replica lagging', desc: 'Cart pages read an old version.' },
      { id: 'drop', node: 'cart', mode: 'dropResponse', label: 'Cart replies lost', desc: 'Edits are applied but the device never hears back, so it retries.' },
      { id: 'crash', node: 'primary', mode: 'crashed', label: 'Primary crashes', desc: 'The failover manager promotes the standby.' },
      { id: 'guest-down', node: 'guest', mode: 'down', label: 'Guest-cart store down', desc: 'Signed-out shoppers cannot add items; sign-in cannot merge.' },
      { id: 'slow', node: 'primary', mode: 'slow', params: { factor: 30 }, label: 'Primary slow', desc: 'Every edit waits on the database.' },
    ],
    switches: Y.switches([
      ['ryw', 'Read your own writes', 'A device sends the version it last wrote; if the replica is older, the cart is read from the primary. Off: cart pages always read the replica.'],
      ['versioned', 'Versioned writes (compare-and-set)', 'Write only if the cart is still at the version that was read; re-read and retry on conflict. Off: the last write overwrites the whole cart.'],
      ['merge', 'Merge the guest cart at sign-in', 'Combine guest items with the account cart. Off: the account cart replaces the guest cart.'],
      ['idem', 'Idempotency key per edit', 'The database records each edit key, so a retried edit applies once. Off: a retried “add” adds again.'],
      ['sync', 'Confirm only after the standby has the write', 'Synchronous replication to the standby: slower writes, nothing lost on failover. Off: the standby gets each write about 0.4 s later.'],
    ]),
    presets: Y.presets({ ryw: true, versioned: true, merge: true, idem: true, sync: true }, [
      { id: 'add', label: 'Add on the phone, see it on the tablet', desc: 'One cart for the account: the tablet shows what the phone added.', run: (s) => { startEdit(s, 'phone', 'echo'); s.schedule(1200, () => startRefresh(s, 'tablet')); } },
      { id: 'ryw-bad', label: 'Lagging replica, no read-your-writes', desc: 'The phone adds an item, then its own cart page reads the lagging replica and the item is not there.', sw: { ryw: false }, run: (s) => { s.inject('replica', 'lag'); startEdit(s, 'phone', 'echo'); } },
      { id: 'ryw', label: 'Lagging replica, read-your-writes', desc: 'The phone asks for at least the version it wrote, so the cart service reads the primary and the item appears.', run: (s) => { s.inject('replica', 'lag'); startEdit(s, 'phone', 'echo'); } },
      { id: 'concurrent', label: 'Both devices add at once', desc: 'Phone and tablet both read version 0. The second write is refused, re-read, and applied on top: both items survive.', run: (s) => { startEdit(s, 'phone', 'echo'); s.schedule(4, () => startEdit(s, 'tablet', 'kindle')); s.schedule(1500, () => startRefresh(s, 'phone')); } },
      { id: 'concurrent-bad', label: 'Both add at once, last write wins', desc: 'Both read the empty cart and write back their own version. Both were told “added”; one item is gone.', sw: { versioned: false }, run: (s) => { startEdit(s, 'phone', 'echo'); s.schedule(4, () => startEdit(s, 'tablet', 'kindle')); s.schedule(1500, () => startRefresh(s, 'phone')); } },
      { id: 'merge', label: 'Guest cart merged at sign-in', desc: 'The tablet already has a Kindle in the account cart. Signed out, the phone adds an Echo Dot, then signs in: the cart has both.', run: (s) => { s.ui.phone.user = null; startEdit(s, 'tablet', 'kindle'); s.schedule(500, () => startEdit(s, 'phone', 'echo')); s.schedule(1500, () => startSignIn(s, 'phone')); } },
      { id: 'merge-bad', label: 'Guest cart discarded at sign-in', desc: 'Same steps, but sign-in loads the account cart and drops the guest cart. The Echo Dot vanishes.', sw: { merge: false }, run: (s) => { s.ui.phone.user = null; startEdit(s, 'tablet', 'kindle'); s.schedule(500, () => startEdit(s, 'phone', 'echo')); s.schedule(1500, () => startSignIn(s, 'phone')); } },
      { id: 'retry', label: 'Reply lost, retried with a key', desc: 'The add is applied but its reply is lost. The phone retries with the same key; the cart still has one.', run: (s) => { s.inject('cart', 'dropResponse', null, 500); startEdit(s, 'phone', 'echo'); } },
      { id: 'retry-bad', label: 'Reply lost, retried without a key', desc: 'The retry adds the item again: the shopper asked for one and the cart has two.', sw: { idem: false }, run: (s) => { s.inject('cart', 'dropResponse', null, 500); startEdit(s, 'phone', 'echo'); } },
      { id: 'failover', label: 'Primary crashes, synchronous standby', desc: 'The phone adds a Kindle; the primary crashes 0.2 s after confirming. The standby already had it, so nothing is lost.', run: (s) => { startEdit(s, 'phone', 'echo'); s.schedule(1500, () => startEdit(s, 'phone', 'kindle')); s.schedule(1780, () => s.inject('primary', 'crashed')); s.schedule(3200, () => startRefresh(s, 'tablet')); } },
      { id: 'failover-bad', label: 'Primary crashes, asynchronous standby', desc: 'The Kindle was confirmed but not yet shipped to the standby. After failover it is gone from the cart.', sw: { sync: false }, run: (s) => { startEdit(s, 'phone', 'echo'); s.schedule(1500, () => startEdit(s, 'phone', 'kindle')); s.schedule(1700, () => s.inject('primary', 'crashed')); s.schedule(3200, () => startRefresh(s, 'tablet')); } },
    ]),
    initialState: () => {
      const doc = () => ({ ver: 0, items: {}, keys: {} });
      return {
        config: { ryw: true, versioned: true, merge: true, idem: true, sync: true },
        db: { primary: doc(), replica: doc(), standby: doc() },
        leader: 'primary',
        guest: {},
        intent: {}, guestIntent: {},
        seq: { key: 0 },
        stats: { conflicts: 0, dups: 0, failovers: 0, primaryReads: 0 },
      };
    },
    initialUI: () => {
      const dev = () => ({ user: USER, busy: false, shown: {}, source: '', shownVer: 0, lastVer: 0, missing: null, message: '', tone: '' });
      return { phone: dev(), tablet: dev() };
    },
    actions: {
      add(sim, a) { startEdit(sim, a.dev, a.sku); },
      remove(sim, a) { startEdit(sim, a.dev, a.sku, true); },
      refresh(sim, a) { startRefresh(sim, a.dev); },
      signin(sim, a) { startSignIn(sim, a.dev); },
      signout(sim, a) { Object.assign(sim.ui[a.dev], { user: null, shown: {}, lastVer: 0, message: 'Signed out. New items go into a guest cart.', tone: '' }); },
    },
    handlers: {
      gateway: {
        get: function* (ctx, p) { return ctx.must(yield ctx.call('cart', 'get', p, { timeout: 800 })); },
        add: function* (ctx, p) { return ctx.must(yield ctx.call('cart', 'add', p, { timeout: 800 })); },
        remove: function* (ctx, p) { return ctx.must(yield ctx.call('cart', 'remove', p, { timeout: 800 })); },
        signin: function* (ctx, p) { return ctx.must(yield ctx.call('auth', 'signin', p, { timeout: 1800 })); },
      },
      auth: {
        signin: function* (ctx, p) { return ctx.must(yield ctx.call('cart', 'merge', { user: USER, cookie: p.cookie }, { timeout: 1600 })); },
      },
      cart: {
        get: function* (ctx, p) {
          const st = ctx.state;
          if (!p.user) {
            const g = ctx.must(yield ctx.call('guest', 'get', { cookie: p.cookie }, { timeout: 600 }));
            return { items: g.items, ver: 0, source: 'the guest-cart store' };
          }
          const rep = ctx.must(yield ctx.call('replica', 'get', {}, { timeout: 600 }));
          if (st.config.ryw && rep.ver < p.minVer) {
            st.stats.primaryReads++;
            const prim = ctx.must(yield ctx.call(st.leader, 'get', {}, { timeout: 600 }));
            return { items: prim.items, ver: prim.ver, source: `the ${st.leader === 'primary' ? 'primary' : 'promoted standby'} (the replica was at version ${rep.ver}, older than ${p.minVer})` };
          }
          return { items: rep.items, ver: rep.ver, source: `the read replica (version ${rep.ver})` };
        },
        add: function* (ctx, p) {
          if (!p.user) return ctx.must(yield ctx.call('guest', 'put', { cookie: p.cookie, sku: p.sku, delta: 1 }, { timeout: 600 }));
          return yield* modify(ctx, p, (items) => Object.assign(items, { [p.sku]: (items[p.sku] || 0) + 1 }));
        },
        remove: function* (ctx, p) {
          if (!p.user) return ctx.must(yield ctx.call('guest', 'put', { cookie: p.cookie, sku: p.sku, delta: -Infinity }, { timeout: 600 }));
          return yield* modify(ctx, p, (items) => { delete items[p.sku]; return items; });
        },
        merge: function* (ctx, p) {
          const st = ctx.state;
          const g = ctx.must(yield ctx.call('guest', 'get', { cookie: p.cookie }, { timeout: 600 }));
          const before = ctx.must(yield ctx.call(st.leader, 'get', {}, { timeout: 600 })).items;
          const merged = st.config.merge;
          const w = merged
            ? yield* modify(ctx, { key: `merge-${p.cookie}` }, (items) => { for (const [k, n] of Object.entries(g.items)) items[k] = Math.max(items[k] || 0, n); return items; })
            : { ver: ctx.state.db[st.leader].ver };
          yield ctx.call('guest', 'clear', { cookie: p.cookie }, { timeout: 600 });
          return { ver: w.ver, merged, guest: g.items, before };
        },
      },
      guest: {
        get(ctx, p) { return { items: Object.assign({}, (ctx.state.guest[p.cookie] || {}).items || {}) }; },
        put(ctx, p) {
          const st = ctx.state;
          const g = (st.guest[p.cookie] = st.guest[p.cookie] || { items: {} });
          g.items[p.sku] = Math.max(0, (g.items[p.sku] || 0) + p.delta);
          if (!g.items[p.sku]) delete g.items[p.sku];
          return { ver: 0, items: Object.assign({}, g.items) };
        },
        clear(ctx, p) { delete ctx.state.guest[p.cookie]; return { cleared: true }; },
      },
      primary: dbHandlers(),
      standby: dbHandlers(),
      replica: {
        get(ctx) { const d = ctx.state.db.replica; return { ver: d.ver, items: Object.assign({}, d.items) }; },
        apply: applyCopy,
      },
    },
    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(300);
          const st = ctx.state;
          if (st.leader !== 'primary') continue;
          const h = yield ctx.call('primary', 'get', {}, { timeout: 250, quiet: 'all' });
          if (h.ok) continue;
          st.leader = 'standby';
          st.stats.failovers++;
          const sb = st.db.standby;
          st.db.replica = { ver: sb.ver, items: Object.assign({}, sb.items), keys: Object.assign({}, sb.keys) };
          ctx.log({ op: 'standby promoted', status: 'recovered', detail: `The primary stopped answering. The standby (version ${sb.ver}: ${list(sb.items)}) is now the primary, and the replica was re-synced from it.` });
        }
      }, { self: 'ha', quiet: 'all' });
    },
    consistency(sim) {
      const st = sim.state;
      const items = st.db[st.leader].items;
      if (leaderDown(sim)) return { key: 'stale', label: 'The cart database primary is down. Edits fail until the standby is promoted.' };
      for (const sku of Object.keys(ITEMS)) {
        const want = st.intent[sku] || 0;
        const have = items[sku] || 0;
        if (have < want) return { key: 'wrong', label: `${USER} added ${name(sku)} and was told it worked, but the cart ${have ? `has ${have} of ${want}` : 'no longer has it'}.` };
        if (have > want) return { key: 'wrong', label: `The cart has ${have} × ${name(sku)}; ${USER} asked for ${want}.` };
      }
      for (const dev of Object.keys(DEV)) {
        const m = sim.ui[dev].missing;
        if (m) return { key: 'stale', label: `The ${DEV[dev].toLowerCase()} just added ${name(m)}, but its cart page doesn’t show it: it read a replica that is behind. The item is safe in the primary.` };
      }
      return { key: 'ok', label: `The cart holds exactly what ${USER} added (${list(items)}), and each device sees its own changes.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const lag = st.db[st.leader].ver - st.db.replica.ver;
      return [
        { label: 'Cart version (primary)', value: st.db[st.leader].ver },
        { label: 'Replica behind by', value: `${lag} version${lag === 1 ? '' : 's'}`, tone: lag > 0 ? 'warn' : 'ok' },
        { label: 'Reads sent to primary', value: st.stats.primaryReads },
        { label: 'Version conflicts', value: st.stats.conflicts },
        { label: 'Duplicate edits ignored', value: st.stats.dups },
        { label: 'Failovers', value: st.stats.failovers },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Phone'], ['tablet', 'Tablet']], {
          note: `Both devices belong to ${USER}. The console below shows the cart database.`,
          below: '<div class="ops-console" data-ref="console"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const dev of Object.keys(DEV)) {
          const u = sim.ui[dev];
          const arg = (sku) => ({ dev, sku });
          const products = `<div class="app-list">${Object.entries(ITEMS).map(([sku, it]) => `<div class="app-kv"><span>${esc(it.name)}<br><span class="app-sub">$${it.price}</span></span>${Y.btn('add', u.busy ? '…' : 'Add', { arg: arg(sku), cls: 'secondary', disabled: u.busy })}</div>`).join('')}</div>`;
          const lines = Object.entries(u.shown).filter(([, n]) => n > 0);
          const total = lines.reduce((a, [k, n]) => a + ITEMS[k].price * n, 0);
          const cart = `<div class="app-card"><strong>🛒 Cart${lines.length ? ` (${lines.reduce((a, [, n]) => a + n, 0)})` : ''}</strong>
            ${lines.map(([k, n]) => `<span class="app-kv"><span>${esc(name(k))}${n > 1 ? ` ×${n}` : ''}</span>${Y.btn('remove', 'Remove', { arg: arg(k), cls: 'secondary' })}</span>`).join('') || '<span class="app-sub">Your cart is empty.</span>'}
            ${lines.length ? `<span class="app-kv"><span>Subtotal</span><span>$${total.toFixed(2)}</span></span>` : ''}
            ${u.source ? `<span class="app-sub">Read from ${esc(u.source.replace(/ \(.*/, ''))}</span>` : ''}</div>`;
          Y.paint(el, sim, dev, {
            head: `<div><p class="app-title">Amazon</p><p class="app-sub">${u.user ? `Hello, ${esc(u.user)}` : 'Hello, sign in'}</p></div>`,
            products, cart,
            actions: `<div class="app-row">${Y.btn('refresh', 'Open cart', { arg: { dev }, cls: 'secondary' })}${u.user ? '' : Y.btn('signin', 'Sign in', { arg: { dev } })}</div>`,
            msg: Y.msg(u.message, u.tone),
          });
        }
        const row = (id, label) => {
          const d = st.db[id];
          const lead = st.leader === id;
          const down = sim.nodes[id].modes.crashed || sim.nodes[id].modes.down;
          return `<div class="ops-row" data-tone="${down ? 'fail' : sim.nodes[id].modes.lag ? 'warn' : ''}"><div class="ops-name">${label}${lead ? ' (primary)' : ''}<span>${down ? 'down' : `v${d.ver}: ${esc(list(d.items))}`}</span></div></div>`;
        };
        const c = sim.scenario.consistency(sim);
        const guest = st.guest[COOKIE];
        SDL.ui.paintSections(el.querySelector('[data-ref="console"]'), {
          title: `<p class="ops-title">Cart database: ${USER}</p>`,
          rows: `<div class="ops-shards">${row('primary', 'Primary')}${row('standby', 'Standby')}${row('replica', 'Read replica')}
            <div class="ops-row"><div class="ops-name">Guest cart (cookie)<span>${guest ? esc(list(guest.items)) : 'none'}</span></div></div></div>`,
          intent: `<p class="app-sub">What ${USER} added and was told worked: ${esc(list(st.intent))}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        });
      },
    },
  });

  /** Apply a replicated copy if it is newer and comes from the current primary (a replica follows one primary’s log). */
  function applyCopy(ctx, p) {
    const st = ctx.state;
    const d = st.db[ctx.self];
    if (p.from && p.from !== st.leader) return { ver: d.ver, ignored: true };
    if (p.ver > d.ver) Object.assign(d, { ver: p.ver, items: Object.assign({}, p.items), keys: Object.assign({}, p.keys) });
    return { ver: d.ver };
  }
  /** Handlers shared by the primary and the standby (which takes over writes when promoted). */
  function dbHandlers() {
    return {
      get(ctx) { const d = ctx.state.db[ctx.self]; return { ver: d.ver, items: Object.assign({}, d.items) }; },
      apply: applyCopy,
      put: function* (ctx, p) {
        const st = ctx.state;
        const d = st.db[ctx.self];
        if (st.leader !== ctx.self) ctx.fail('READ_ONLY', 'Not the primary.');
        if (p.key && d.keys[p.key]) {
          st.stats.dups++;
          ctx.log({ op: `edit ${p.key} already applied`, status: 'dup', detail: 'The key is recorded with the cart, so the repeat returns the earlier result.' });
          return { ver: d.ver, items: Object.assign({}, d.items), dup: true };
        }
        if (p.expect != null && p.expect !== d.ver) { st.stats.conflicts++; ctx.fail('CONFLICT', `Expected version ${p.expect}, found ${d.ver}.`); }
        d.items = p.items;
        d.ver++;
        if (p.key) d.keys[p.key] = true;
        const ver = d.ver;
        replicate(ctx, ctx.self);
        if (st.config.sync && ctx.self === 'primary') {
          ctx.must(yield ctx.call('standby', 'apply', { ver, items: Object.assign({}, d.items), keys: Object.assign({}, d.keys) }, { timeout: 600 }));
        }
        return { ver, items: Object.assign({}, d.items) };
      },
    };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
