/*
 * Device tokens and the registry.
 * A push is addressed to a token, not a person. The registry maps a user to
 * the tokens of the app installs they are logged in on, and every way that
 * map goes wrong is a scenario here: the OS rotates a token and the old row
 * lingers, an uninstall answered with "unregistered" (prune it) or with
 * silence (only a sweep of rows nobody refreshed will find it), a logout
 * that leaves the row behind on a device someone else now uses, and a cache
 * in front of the registry that still lists a device after the logout.
 * Tokens belong to the app install: logging in as someone else on the same
 * tablet keeps the same token.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const GRACE = 4000; // the provider still accepts a rotated token this long
  const STALE_MS = 6000; // the cleaner removes rows nobody refreshed for this long ("60 days")
  const SWEEP_MS = 500;
  const REFRESH_MS = 1000; // a logged-in app re-registers this often ("every app open")
  const CACHE_TTL = 5000;
  const DEVICES = ['phone', 'tablet'];
  const NAME = { phone: 'Maya’s phone', tablet: 'Family tablet' };
  const KINDS = {
    otp: { title: 'Your code is 482 913', text: 'Use it to sign in. Never share it.', team: 'Security team' },
    order: { title: 'Your order has shipped', text: 'Arriving Thursday.', team: 'Checkout team' },
  };

  const rowKey = (st, user, dev, token) => (st.config.byDevice ? `${user}|${dev}` : `${user}|${token}`);
  const tokenState = (st, token, now) => {
    const t = st.issued[token];
    if (!t) return 'unknown';
    if (t.state === 'rotated') return now - t.at < GRACE ? 'grace' : 'dead';
    return t.state; // live | uninstalled
  };

  /* ---------- device actions ---------- */
  function register(sim, dev, label) {
    const d = sim.state.devices[dev];
    if (!d.installed || !d.user) return;
    sim.startAction(label || `${NAME[dev]}: open the app`, function* (ctx) {
      Y.L(ctx, { displayed: 'n/a', retrySafe: ['yes', 'Registration is an upsert: the same call twice leaves one row.'] });
      const r = yield ctx.call('api', 'register', { user: d.user, dev, token: d.token }, { timeout: 800 });
      if (r.ok) Y.L(ctx, { accepted: 'yes', committed: ['yes', `Row ${r.value.key}.`], async: 'n/a' });
      else Y.failed(ctx);
    }, { self: dev });
  }
  function rotate(sim, dev) {
    const st = sim.state;
    const d = st.devices[dev];
    if (!d.installed) return;
    const old = d.token;
    st.issued[old].state = 'rotated';
    st.issued[old].at = sim.now;
    d.token = `tok-${dev}-${++st.seq.tok}`;
    st.issued[d.token] = { dev, state: 'live' };
    sim.note(`The OS gave ${NAME[dev]} a new push token (${d.token}). The provider keeps accepting ${old} for ${GRACE / 1000} s.`);
    register(sim, dev, `${NAME[dev]}: register the new token`);
  }
  function logout(sim, dev) {
    const st = sim.state;
    const d = st.devices[dev];
    if (!d.user) return;
    const user = d.user;
    d.user = null;
    sim.startAction(`${NAME[dev]}: ${user === 'maya' ? 'Maya' : 'Omar'} logs out`, function* (ctx) {
      Y.L(ctx, { displayed: 'yes', retrySafe: 'yes' });
      if (!st.config.unregister) {
        Y.L(ctx, { accepted: 'n/a', committed: ['no', 'Logout only cleared the session on the device. The registry row is still there.'], async: 'n/a' });
        ctx.explain(`The app forgot ${user === 'maya' ? 'Maya' : 'Omar'}, but the registry still maps them to this install’s token.`);
        return;
      }
      const r = yield ctx.call('api', 'unregister', { user, dev, token: d.token }, { timeout: 800 });
      if (r.ok) Y.L(ctx, { accepted: 'yes', committed: ['yes', 'Registry row deleted.'], async: 'n/a' });
      else Y.failed(ctx);
    }, { self: dev });
  }
  function login(sim, dev, user) {
    const st = sim.state;
    const d = st.devices[dev];
    if (!d.installed) { d.installed = true; d.token = `tok-${dev}-${++st.seq.tok}`; st.issued[d.token] = { dev, state: 'live' }; }
    d.user = user;
    register(sim, dev, `${NAME[dev]}: ${user === 'maya' ? 'Maya' : 'Omar'} logs in`);
  }
  function uninstall(sim, dev) {
    const st = sim.state;
    const d = st.devices[dev];
    if (!d.installed) return;
    d.installed = false;
    d.user = null;
    st.issued[d.token].state = 'uninstalled';
    sim.note(`${NAME[dev]}: app uninstalled. Nothing tells the registry; only the provider knows the token is gone${sim.nodes.apns.modes.silent ? ', and it is not saying' : ''}.`);
  }
  function send(sim, kind) {
    const st = sim.state;
    const k = KINDS[kind];
    const nid = `n${++st.seq.n}`;
    st.sends[nid] = { nid, kind, t: sim.now, user: 'maya', expect: DEVICES.filter((x) => st.devices[x].installed && st.devices[x].user === 'maya'), done: false };
    sim.startAction(`${k.team}: send Maya “${k.title}”`, function* (ctx) {
      Y.L(ctx, { displayed: 'n/a', retrySafe: ['yes', 'Keyed by notification id.'] });
      ctx.sim.enqueue('sends', { type: 'send', eventId: nid, payload: { nid, kind, user: 'maya' }, actionId: ctx.actionId });
      Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', 'Looking up Maya’s tokens.'] });
    }, { self: 'console' });
  }

  const sc = (SDL.scenarios['nt-tokens'] = {
    id: 'nt-tokens',
    seed: 941,
    minHopMs: 5,
    productWidth: 640,
    intro: 'Maya is logged in on her phone. Send her a code, then install the app on the family tablet, rotate a token, uninstall, or log Maya out of the tablet and hand it to Omar. The registry table below the phones shows every row the sender will use.',
    topology: {
      width: 1160, height: 560,
      nodes: [
        { id: 'console', label: 'Product teams', sub: 'Send to a user', kind: 'client', x: 90, y: 90, latency: 1, role: 'Teams address a user, never a device. Turning a user into tokens is the registry’s job.', owns: ['Nothing'] },
        { id: 'sendq', label: 'Send queue', sub: 'Jobs', kind: 'queue', x: 300, y: 90, latency: 3, queue: 'sends', role: 'One job per notification.', owns: ['send jobs'] },
        { id: 'workers', label: 'Send workers', sub: 'User → tokens → push', kind: 'worker', x: 520, y: 90, latency: 4, role: 'Look up the user’s tokens (cache first), send one push per token, and act on what the provider says about each token.', owns: ['Nothing durable'] },
        { id: 'regcache', label: 'Registry cache', sub: `TTL ${CACHE_TTL / 1000} s`, kind: 'cache', x: 740, y: 90, latency: 2, role: 'User → tokens, so a big send does not hammer the registry. Invalidated on every registry write, or left to expire.', ops: [{ name: 'get', desc: 'Cached tokens.' }, { name: 'put', desc: 'Fill.' }, { name: 'evict', desc: 'Invalidate.' }], owns: ['tokens[user] copies'] },
        { id: 'api', label: 'Device API', sub: 'Register, unregister', kind: 'gateway', x: 300, y: 300, latency: 3, role: 'Apps register their token on login and every app open, and unregister on logout.', ops: [{ name: 'register', desc: 'Upsert a row.' }, { name: 'unregister', desc: 'Delete a row.' }], owns: ['Nothing durable'] },
        { id: 'registry', label: 'Device registry', sub: 'Rows: user, device, token', kind: 'db', x: 740, y: 300, latency: 6, role: 'One row per (user, device) or per (user, token). Each row remembers when its app last refreshed it.', ops: [{ name: 'upsert', desc: 'Write a row.' }, { name: 'delete', desc: 'Remove a row.' }, { name: 'tokens', desc: 'Rows for a user.' }, { name: 'prune', desc: 'Remove a dead token.' }], owns: ['devices[user]'] },
        { id: 'cleaner', label: 'Stale-row cleaner', sub: `Unrefreshed for ${STALE_MS / 1000} s`, kind: 'worker', x: 960, y: 300, latency: 3, role: `Deletes rows no app has refreshed in ${STALE_MS / 1000} s (think 60 days). The only defence against uninstalls the provider never reports.`, owns: ['Nothing'] },
        { id: 'apns', label: 'Push provider', sub: 'APNs / FCM', kind: 'service', x: 520, y: 470, latency: 30, role: `Knows which tokens are real. Accepts a rotated token for ${GRACE / 1000} s, then answers 410 Unregistered. For an uninstalled app it answers 410, or, sometimes, 200 and silence.`, ops: [{ name: 'send', desc: 'Deliver to a token.' }], owns: ['The truth about tokens'] },
        { id: 'phone', label: 'Maya’s phone', sub: 'Her own', kind: 'client', x: 300, y: 470, latency: 1, role: 'Maya’s iPhone.', ops: [{ name: 'push', desc: 'Show a push.' }], owns: ['Its token'] },
        { id: 'tablet', label: 'Family tablet', sub: 'Shared', kind: 'client', x: 740, y: 470, latency: 1, role: 'Shared at home. Whoever is logged in sees what lands on it.', ops: [{ name: 'push', desc: 'Show a push.' }], owns: ['Its token'] },
      ],
      edges: [
        { from: 'console', to: 'sendq', latency: 4 },
        { from: 'sendq', to: 'workers', latency: 3 },
        { from: 'workers', to: 'regcache', latency: 3 },
        { from: 'workers', to: 'registry', latency: 4, via: [[560, 210], [740, 210]] },
        { from: 'workers', to: 'apns', latency: 4 },
        { from: 'phone', to: 'api', latency: 30 },
        { from: 'tablet', to: 'api', latency: 30, via: [[740, 395], [340, 395]] },
        { from: 'api', to: 'registry', latency: 4 },
        { from: 'api', to: 'regcache', latency: 4, via: [[300, 170], [700, 170]] },
        { from: 'cleaner', to: 'registry', latency: 3 },
        { from: 'apns', to: 'phone', latency: 30 },
        { from: 'apns', to: 'tablet', latency: 30 },
      ],
      queues: [{ id: 'sends', broker: 'sendq', label: 'send jobs', groups: ['workers'] }],
    },
    modeLabels: { silent: 'Accepts pushes for uninstalled apps' },
    failures: [
      { id: 'apns-silent', node: 'apns', mode: 'silent', label: 'Provider silent about uninstalls', desc: 'An uninstalled app’s token still gets 200. Nothing tells the sender the device is gone.' },
      { id: 'registry-down', node: 'registry', mode: 'down', label: 'Registry down', desc: 'Apps cannot register; workers fall back to the cache, then wait.' },
      { id: 'registry-slow', node: 'registry', mode: 'slow', params: { factor: 30 }, label: 'Registry slow', desc: 'Lookups take close to 200 ms. The cache absorbs it.' },
      { id: 'regcache-down', node: 'regcache', mode: 'down', label: 'Registry cache down', desc: 'Every send reads the registry directly.' },
      { id: 'cleaner-paused', node: 'cleaner', mode: 'paused', label: 'Cleaner paused', desc: 'Unrefreshed rows are never removed.' },
      { id: 'apns-down', node: 'apns', mode: 'down', label: 'Push provider down', desc: 'Every push fails. Tokens are not judged while the provider is down.' },
      { id: 'workers-paused', node: 'workers', mode: 'paused', label: 'Workers paused', desc: 'Sends wait in the queue.' },
    ],
    switches: Y.switches([
      ['byDevice', 'One row per device', 'Rows are keyed by (user, device): a new token overwrites the old one. Off: keyed by (user, token), so a rotated token leaves its old row behind.', (s) => {
        // Re-key existing rows under the new scheme, as a migration would.
        const st = s.state;
        const rows = {};
        for (const r of Object.values(st.rows)) { const k = rowKey(st, r.user, r.dev, r.token); if (!rows[k] || rows[k].seen < r.seen) rows[k] = r; }
        st.rows = rows;
      }],
      ['prune', 'Delete tokens the provider calls unregistered', 'A 410 deletes the row at once. Off: the row stays and every send calls the dead token again.'],
      ['unregister', 'Logout unregisters the device', 'Logout deletes the (user, device) row. Off: logout only clears the session on the device.'],
      ['invalidate', 'Invalidate the cache on registry writes', `Every register, unregister, and prune evicts the user’s cached tokens. Off: the cache serves its copy for up to ${CACHE_TTL / 1000} s.`],
    ]),
    presets: Y.presets({ byDevice: true, prune: true, unregister: true, invalidate: true }, [
      { id: 'one-device', label: 'Send a code to one device', desc: 'One row, one token, one push on Maya’s phone.', run: (s) => send(s, 'otp') },
      { id: 'two-devices', label: 'Install on the tablet, then send', desc: 'Maya logs in on the tablet; a second row appears. The code lands on both of her devices.', run: (s) => { login(s, 'tablet', 'maya'); s.schedule(300, () => send(s, 'otp')); } },
      { id: 'rotate-by-token', label: 'Token rotated, rows keyed by token', desc: `The OS rotates the phone’s token. The app registers the new one, and the old row stays because it has a different key. The provider still accepts the old token for ${GRACE / 1000} s: the phone shows the code twice.`, sw: { byDevice: false }, run: (s) => { s.schedule(100, () => rotate(s, 'phone')); s.schedule(600, () => send(s, 'otp')); } },
      { id: 'rotate-by-device', label: 'Token rotated, one row per device', desc: 'Same rotation. The row is keyed by (Maya, phone), so the new token overwrites the old one. One push.', run: (s) => { s.schedule(100, () => rotate(s, 'phone')); s.schedule(600, () => send(s, 'otp')); } },
      { id: 'uninstall-prune', label: 'Uninstalled, provider says 410, pruned', desc: 'Maya uninstalls the app from her phone and keeps using the tablet. The first send to the phone’s token gets 410 Unregistered and the row is deleted. Later sends go to the tablet only.', run: (s) => { login(s, 'tablet', 'maya'); s.schedule(100, () => uninstall(s, 'phone')); [600, 1300, 2000].forEach((t) => s.schedule(t, () => send(s, 'order'))); } },
      { id: 'uninstall-ignored', label: 'Uninstalled, 410 ignored', desc: 'Same uninstall without pruning. Every send calls the dead token again and gets 410 again, until the cleaner finally sweeps the row at 6 s. Providers throttle senders whose invalid-token rate stays high.', sw: { prune: false }, run: (s) => { login(s, 'tablet', 'maya'); s.schedule(100, () => uninstall(s, 'phone')); [600, 1300, 2000, 2700, 3400, 4100, 4800].forEach((t) => s.schedule(t, () => send(s, 'order'))); } },
      { id: 'uninstall-silent', label: 'Silent uninstall, cleaner paused', desc: 'The provider answers 200 for the uninstalled app, so the sender believes every push landed. The row is never refreshed, but the cleaner is paused: it stays for ever and every send is wasted.', run: (s) => { s.inject('apns', 'silent'); s.inject('cleaner', 'paused'); login(s, 'tablet', 'maya'); s.schedule(100, () => uninstall(s, 'phone')); [600, 1300, 2000, 2700].forEach((t) => s.schedule(t, () => send(s, 'order'))); } },
      { id: 'uninstall-sweep', label: 'Silent uninstall, cleaner sweeps', desc: `Same silence. No app has refreshed the phone’s row for ${STALE_MS / 1000} s, so the cleaner deletes it. Sends before the sweep were wasted; sends after it are not.`, run: (s) => { s.inject('apns', 'silent'); login(s, 'tablet', 'maya'); s.schedule(100, () => uninstall(s, 'phone')); [600, 2000, 6800, 7600].forEach((t) => s.schedule(t, () => send(s, 'order'))); } },
      { id: 'shared-no-unregister', label: 'Tablet handed to Omar, logout leaves the row', desc: 'Maya logs out of the tablet and Omar logs in. The token belongs to the install, so it is unchanged, and the (Maya, tablet) row is still there. Maya’s sign-in code appears on the tablet in front of Omar.', sw: { unregister: false }, run: (s) => { login(s, 'tablet', 'maya'); s.schedule(300, () => logout(s, 'tablet')); s.schedule(500, () => login(s, 'tablet', 'omar')); s.schedule(900, () => send(s, 'otp')); } },
      { id: 'shared-unregister', label: 'Tablet handed to Omar, logout unregisters', desc: 'Logout deletes the (Maya, tablet) row before Omar logs in. Maya’s code goes to her phone only.', run: (s) => { login(s, 'tablet', 'maya'); s.schedule(300, () => logout(s, 'tablet')); s.schedule(500, () => login(s, 'tablet', 'omar')); s.schedule(900, () => send(s, 'otp')); } },
      { id: 'cache-stale', label: 'Logout unregisters, cache not invalidated', desc: `An earlier send cached Maya’s two tokens. The logout deletes the registry row, but the cache keeps its copy for ${CACHE_TTL / 1000} s. The code goes to the tablet anyway, and Omar sees it.`, sw: { invalidate: false }, run: (s) => { login(s, 'tablet', 'maya'); s.schedule(300, () => send(s, 'order')); s.schedule(700, () => logout(s, 'tablet')); s.schedule(900, () => login(s, 'tablet', 'omar')); s.schedule(1300, () => send(s, 'otp')); } },
      { id: 'cache-invalidate', label: 'Logout unregisters, cache invalidated', desc: 'The unregister evicts Maya’s cached tokens. The next send misses the cache, reads the registry, and finds only her phone.', run: (s) => { login(s, 'tablet', 'maya'); s.schedule(300, () => send(s, 'order')); s.schedule(700, () => logout(s, 'tablet')); s.schedule(900, () => login(s, 'tablet', 'omar')); s.schedule(1300, () => send(s, 'otp')); } },
    ]),
    initialState: () => ({
      config: { byDevice: true, prune: true, unregister: true, invalidate: true },
      devices: { phone: { installed: true, user: 'maya', token: 'tok-phone-1' }, tablet: { installed: false, user: null, token: null } },
      issued: { 'tok-phone-1': { dev: 'phone', state: 'live' } },
      rows: { 'maya|phone': { user: 'maya', dev: 'phone', token: 'tok-phone-1', seen: 0 } },
      cache: {}, sends: {}, shown: [], leaks: [], judged: {},
      stats: { pushes: 0, deadSends: 0, gone410: 0, pruned: 0, swept: 0, hits: 0, misses: 0 },
      seq: { n: 0, tok: 1 },
    }),
    initialUI: () => ({ phone: { pushes: [], banner: null }, tablet: { pushes: [], banner: null } }),
    actions: {
      send(sim, a) { send(sim, a.kind); },
      open(sim, a) { register(sim, a.dev); },
      rotate(sim, a) { rotate(sim, a.dev); },
      logout(sim, a) { logout(sim, a.dev); },
      login(sim, a) { login(sim, a.dev, a.user); },
      uninstall(sim, a) { uninstall(sim, a.dev); },
    },
    handlers: {
      api: {
        register: function* (ctx, p) {
          const r = ctx.must(yield ctx.call('registry', 'upsert', p, { timeout: 600 }));
          if (ctx.state.config.invalidate) yield ctx.call('regcache', 'evict', { user: p.user }, { timeout: 300 });
          return r;
        },
        unregister: function* (ctx, p) {
          const r = ctx.must(yield ctx.call('registry', 'delete', p, { timeout: 600 }));
          if (ctx.state.config.invalidate) yield ctx.call('regcache', 'evict', { user: p.user }, { timeout: 300 });
          return r;
        },
      },
      registry: {
        upsert(ctx, p) {
          const st = ctx.state;
          const key = rowKey(st, p.user, p.dev, p.token);
          const prev = st.rows[key];
          st.rows[key] = { user: p.user, dev: p.dev, token: p.token, seen: ctx.now() };
          if (prev && prev.token !== p.token) ctx.log({ op: `row ${key}: token replaced`, status: 'ok', actionId: ctx.actionId, detail: `${prev.token} → ${p.token}. One row per device, so the old token is gone from the registry.` });
          return { key };
        },
        delete(ctx, p) {
          const st = ctx.state;
          let n = 0;
          for (const [k, r] of Object.entries(st.rows)) if (r.user === p.user && r.dev === p.dev) { delete st.rows[k]; n++; }
          return { deleted: n };
        },
        tokens(ctx, p) { return { rows: Object.values(ctx.state.rows).filter((r) => r.user === p.user).map((r) => ({ dev: r.dev, token: r.token })) }; },
        prune(ctx, p) {
          const st = ctx.state;
          let n = 0;
          for (const [k, r] of Object.entries(st.rows)) if (r.token === p.token) { delete st.rows[k]; n++; }
          st.stats.pruned += n;
          return { pruned: n };
        },
      },
      regcache: {
        get(ctx, p) {
          const c = ctx.state.cache[p.user];
          if (c && ctx.now() - c.t < CACHE_TTL) { ctx.state.stats.hits++; return { hit: true, rows: c.rows.slice(), age: ctx.now() - c.t }; }
          ctx.state.stats.misses++;
          return { hit: false };
        },
        put(ctx, p) { ctx.state.cache[p.user] = { rows: p.rows.slice(), t: ctx.now() }; return { ok: true }; },
        evict(ctx, p) { delete ctx.state.cache[p.user]; return { ok: true }; },
      },
      apns: {
        send: function* (ctx, p) {
          const st = ctx.state;
          const s = tokenState(st, p.token, ctx.now());
          if (s === 'live' || s === 'grace') return ctx.must(yield ctx.call(st.issued[p.token].dev, 'push', p, { timeout: 500 }));
          st.stats.deadSends++;
          if (s === 'uninstalled' && ctx.mode('silent')) return { accepted: true, silent: true };
          st.stats.gone410++;
          ctx.fail('UNREGISTERED', `410 Unregistered: ${p.token} is no longer valid.`);
        },
      },
      phone: { push: (ctx, p) => showPush(ctx, 'phone', p) },
      tablet: { push: (ctx, p) => showPush(ctx, 'tablet', p) },
    },
    setup(sim) {
      // Logged-in apps refresh their registration ("every app open").
      for (const dev of DEVICES) {
        sim.spawn(function* (ctx) {
          for (;;) {
            yield ctx.wait(REFRESH_MS);
            const d = ctx.state.devices[dev];
            if (d.installed && d.user) yield ctx.call('api', 'register', { user: d.user, dev, token: d.token }, { timeout: 800, quiet: 'all' });
          }
        }, { self: dev, quiet: 'all' });
      }
      // The cleaner.
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(SWEEP_MS);
          if (ctx.sim.nodes.cleaner.modes.paused) continue;
          const st = ctx.state;
          for (const [k, r] of Object.entries(st.rows)) {
            if (ctx.now() - r.seen > STALE_MS) {
              delete st.rows[k];
              st.stats.swept++;
              if (st.config.invalidate) delete st.cache[r.user];
              ctx.log({ node: 'cleaner', op: `swept ${k}`, status: 'ok', detail: `No app refreshed this row for ${STALE_MS / 1000} s. Deleted.` });
            }
          }
        }
      }, { self: 'cleaner', quiet: 'all' });
      Y.consumer(sim, 'sends', 'workers', 'workers', function* (ctx, msg) {
        const st = ctx.state;
        const p = msg.payload;
        const k = KINDS[p.kind];
        let rows = null;
        const c = yield ctx.call('regcache', 'get', { user: p.user }, { timeout: 300, actionId: msg.actionId });
        if (c.ok && c.value.hit) {
          rows = c.value.rows;
          ctx.log({ op: `cache hit: ${rows.length} token${rows.length === 1 ? '' : 's'}`, status: 'ok', actionId: msg.actionId, detail: `Cached ${Math.round(c.value.age)} ms ago: ${rows.map((r) => `${r.dev} (${r.token})`).join(', ') || 'none'}.` });
        } else {
          const r = yield ctx.call('registry', 'tokens', { user: p.user }, { timeout: 600, actionId: msg.actionId });
          if (!r.ok) return false;
          rows = r.value.rows;
          if (c.ok) yield ctx.call('regcache', 'put', { user: p.user, rows }, { timeout: 300, actionId: msg.actionId });
        }
        if (!rows.length) { ctx.log({ op: `${p.nid}: no devices`, status: 'note', actionId: msg.actionId, detail: 'Maya has no registered devices. Only the in-app inbox would have it.' }); }
        const results = [];
        for (const row of rows) {
          const r = yield ctx.call('apns', 'send', { nid: p.nid, user: p.user, token: row.token, title: k.title, text: k.text }, { timeout: 600, actionId: msg.actionId });
          results.push(r);
          if (!r.ok && r.error.code === 'UNREGISTERED') {
            st.judged[row.token] = true;
            if (st.config.prune) {
              yield ctx.call('registry', 'prune', { token: row.token }, { timeout: 600, actionId: msg.actionId });
              if (st.config.invalidate) yield ctx.call('regcache', 'evict', { user: p.user }, { timeout: 300, actionId: msg.actionId });
              ctx.log({ op: `pruned ${row.token}`, status: 'ok', actionId: msg.actionId, detail: 'The provider said this token is gone. Deleted at once, so no later send calls it.' });
            } else ctx.log({ op: `ignored 410 for ${row.token}`, status: 'fault', actionId: msg.actionId, detail: 'The row stays. The next send will call this token again.' });
          }
        }
        st.sends[p.nid].done = true;
        ctx.sim.setLedger(msg.actionId, 'async', results.some((r) => r.ok && !r.value.silent) ? 'yes' : 'no', `${results.filter((r) => r.ok && !r.value.silent).length} of ${rows.length} pushes reached a device.`);
        return true;
      });
    },
    consistency(sim) {
      const st = sim.state;
      if (st.leaks.length) {
        const l = st.leaks[0];
        return { key: 'wrong', label: `Maya’s “${KINDS[l.kind].title}” appeared on the ${l.dev === 'tablet' ? 'family tablet' : 'phone'} while ${l.viewer ? 'Omar was' : 'nobody was'} logged in. A push goes to an install, not a person: the registry still mapped Maya to it.` };
      }
      const seen = {};
      for (const x of st.shown) { const k = `${x.dev}|${x.nid}`; if (seen[k]) return { key: 'wrong', label: `${NAME[x.dev]} showed “${KINDS[x.kind].title}” twice: once through the old token and once through the new one. Two rows, one device.` }; seen[k] = true; }
      const now = sim.now;
      const deadRows = Object.values(st.rows).filter((r) => ['dead', 'uninstalled'].includes(tokenState(st, r.token, now)));
      if (deadRows.length && st.stats.deadSends) return { key: 'stale', label: `${st.stats.deadSends} push${st.stats.deadSends === 1 ? '' : 'es'} went to a token that no longer reaches anyone, and the row is still there${sim.nodes.apns.modes.silent ? ': the provider said 200 every time, so only a sweep of unrefreshed rows can find it' : ''}.` };
      if (deadRows.length) return { key: 'stale', label: `The registry holds a row for an install that is gone (${deadRows[0].dev}). It will waste the next send unless something removes it.` };
      const pending = Object.values(st.sends).filter((s) => !s.done);
      if (pending.length) return { key: 'stale', label: `${pending.length} send${pending.length === 1 ? '' : 's'} still waiting.` };
      const missed = Object.values(st.sends).find((s) => s.expect.some((d) => st.devices[d].installed && st.devices[d].user === 'maya' && !st.shown.some((x) => x.nid === s.nid && x.dev === d)));
      if (missed) return { key: 'stale', label: `“${KINDS[missed.kind].title}” did not reach one of Maya’s devices.` };
      const sends = Object.keys(st.sends).length;
      if (!sends) return { key: 'ok', label: 'Nothing sent yet. Every row in the registry belongs to a live install.' };
      const extra = st.stats.pruned ? ` One dead token was pruned on its first 410.` : st.stats.swept ? ` ${st.stats.swept} unrefreshed row${st.stats.swept === 1 ? ' was' : 's were'} swept${st.stats.deadSends ? `, after ${st.stats.deadSends} wasted send${st.stats.deadSends === 1 ? '' : 's'}` : ''}.` : '';
      return { key: 'ok', label: `Every push reached exactly Maya’s devices, once each.${extra}` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const rows = Object.values(st.rows);
      const dead = rows.filter((r) => ['dead', 'uninstalled'].includes(tokenState(st, r.token, sim.now))).length;
      return [
        { label: 'Registry rows', value: rows.length },
        { label: 'Rows for dead installs', value: dead, tone: dead ? 'warn' : '' },
        { label: 'Pushes shown', value: st.shown.length },
        { label: 'Sends to dead tokens', value: st.stats.deadSends, tone: st.stats.deadSends > 1 ? 'warn' : '' },
        { label: '410 Unregistered', value: st.stats.gone410 },
        { label: 'Pruned', value: st.stats.pruned },
        { label: 'Swept', value: st.stats.swept },
        { label: 'Shown to the wrong person', value: st.leaks.length, tone: st.leaks.length ? 'fail' : '' },
        { label: 'Cache hits / misses', value: `${st.stats.hits} / ${st.stats.misses}` },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone'], ['tablet', 'Family tablet']], {
          note: 'Each device can log in, log out, rotate its token, or uninstall the app. The console below sends to Maya, the person, and shows the registry rows the workers will use.',
          below: `<div class="ops-console"><p class="ops-title">Product teams</p><div class="ops-traffic">
              ${Y.btn('send', 'Security: send Maya a code', { arg: { kind: 'otp' } })}
              ${Y.btn('send', 'Checkout: order update', { arg: { kind: 'order' }, cls: 'secondary' })}
            </div><div data-ref="rows"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const dev of DEVICES) {
          const d = st.devices[dev];
          const u = sim.ui[dev];
          const who = d.user === 'maya' ? 'Maya' : d.user === 'omar' ? 'Omar' : null;
          const controls = !d.installed
            ? `${Y.btn('login', 'Install and log in as Maya', { arg: { dev, user: 'maya' } })}${dev === 'tablet' ? Y.btn('login', 'Install and log in as Omar', { arg: { dev, user: 'omar' }, cls: 'secondary' }) : ''}`
            : `${who ? Y.btn('logout', `Log ${who} out`, { arg: { dev }, cls: 'secondary' }) : `${Y.btn('login', 'Log in as Maya', { arg: { dev, user: 'maya' } })}${dev === 'tablet' ? Y.btn('login', 'Log in as Omar', { arg: { dev, user: 'omar' }, cls: 'secondary' }) : ''}`}
               ${Y.btn('rotate', 'OS rotates token', { arg: { dev }, cls: 'secondary' })}${Y.btn('uninstall', 'Uninstall', { arg: { dev }, cls: 'secondary' })}`;
          const list = u.pushes.slice(0, 4).map((n) => `<div class="app-card ${n.leak ? 'is-fail' : 'is-ok'}"><strong>${esc(n.title)}</strong><span class="app-sub">${n.leak ? `✕ For Maya, seen by ${n.viewer ? 'Omar' : 'whoever holds it'}` : `via ${esc(n.token)}`}</span></div>`).join('');
          Y.paint(el, sim, dev, {
            head: `<div><p class="app-title">${d.installed ? 'Shop app' : 'App not installed'}</p><p class="app-sub">${who ? `Logged in: ${who}` : d.installed ? 'Logged out' : '—'}${d.token && d.installed ? ` · ${esc(d.token)}` : ''}</p></div>`,
            controls: `<div class="app-row" style="flex-wrap:wrap">${controls}</div>`,
            body: `<p class="app-sub">Lock screen (${u.pushes.length})</p>${list || '<p class="app-sub">Nothing yet.</p>'}`,
          }, {}, u.banner);
        }
        const c = sim.scenario.consistency(sim);
        const rows = Object.entries(st.rows).map(([k, r]) => {
          const ts = tokenState(st, r.token, sim.now);
          const tone = ts === 'live' ? 'ok' : ts === 'grace' ? 'warn' : 'fail';
          const owner = st.devices[r.dev].user;
          const mis = owner && owner !== r.user;
          return `<div class="ops-row" data-tone="${mis ? 'fail' : tone}"><div class="ops-name">${esc(k)} → ${esc(r.token)}<span>${ts === 'live' ? 'live' : ts === 'grace' ? 'rotated, still accepted' : ts === 'dead' ? 'rotated, provider rejects it' : 'app uninstalled'} · refreshed ${((sim.now - r.seen) / 1000).toFixed(1)} s ago${mis ? ` · device now used by ${owner === 'omar' ? 'Omar' : 'Maya'}` : ''}</span></div></div>`;
        }).join('');
        const cached = st.cache.maya ? `Cache for Maya: ${st.cache.maya.rows.map((r) => r.dev).join(', ') || 'no devices'} (${((sim.now - st.cache.maya.t) / 1000).toFixed(1)} s old)` : 'Cache for Maya: empty';
        SDL.ui.paintSections(el.querySelector('[data-ref="rows"]'), {
          title: `<p class="ops-title">Device registry (${st.config.byDevice ? 'one row per device' : 'one row per token'})</p>`,
          rows: `<div class="ops-shards">${rows || '<p class="app-sub">No rows.</p>'}</div>`,
          cache: `<p class="app-sub">${esc(cached)}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });

  function showPush(ctx, dev, p) {
    const st = ctx.state;
    const d = st.devices[dev];
    const u = ctx.ui[dev];
    const leak = d.user !== p.user;
    const entry = { nid: p.nid, title: p.title, token: p.token, t: ctx.now(), leak, viewer: d.user };
    u.pushes.unshift(entry);
    u.banner = { title: p.title, body: p.text, tone: leak ? 'fail' : 'ok', t: ctx.now() };
    st.stats.pushes++;
    st.shown.push({ dev, nid: p.nid, kind: st.sends[p.nid].kind, token: p.token });
    if (leak) {
      st.leaks.push({ dev, nid: p.nid, kind: st.sends[p.nid].kind, viewer: d.user });
      ctx.log({ op: `Maya’s push shown to ${d.user || 'a logged-out device'}`, status: 'fault', actionId: ctx.actionId, detail: `${NAME[dev]} is now used by ${d.user === 'omar' ? 'Omar' : 'nobody'}, and it just displayed a notification meant for Maya.` });
    }
    return { shown: true };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
