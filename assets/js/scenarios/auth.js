/*
 * Authentication and rate limiting. Signing in returns a short-lived access
 * token and a refresh token. The gateway verifies tokens either locally (a
 * signature check with cached keys) or by asking the auth service each time,
 * then applies a per-user token bucket stored in a shared limiter.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const TOKEN_TTL = 6000;
  const BUCKET = 5;
  const REFILL_PER_S = 2;

  function* call(ctx, path) {
    const st = ctx.state;
    const u = ctx.ui.app;
    if (u.token && u.token.exp <= ctx.now() && st.config.refresh) {
      const r = yield ctx.call('gateway', 'refresh', { refresh: u.refresh }, { timeout: 1000 });
      if (r.ok) { u.token = r.value.token; ctx.log({ op: 'access token refreshed', status: 'ok', detail: 'The access token expired; the app used its refresh token to get a new one without bothering the user.' }); }
    }
    return yield ctx.call('gateway', 'api', { token: u.token, path }, { timeout: 1500 });
  }
  function startSignIn(sim) {
    sim.startAction('User: sign in', function* (ctx) {
      const u = ctx.ui.app;
      Y.L(ctx, { displayed: 'pending', retrySafe: ['yes', 'Signing in twice just issues another session.'] });
      const r = yield ctx.call('gateway', 'login', { user: 'sam', password: '•••••' }, { timeout: 1500 });
      if (r.ok) { Object.assign(u, { token: r.value.token, refresh: r.value.refresh, message: 'Signed in.', tone: 'ok' }); Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: ['yes', 'Session recorded.'], async: 'n/a' }); ctx.explain(`The auth service checked the password and issued a signed access token valid for ${TOKEN_TTL / 1000} s plus a refresh token. From here the gateway can verify requests ${ctx.state.config.local ? 'on its own, using the signing key' : 'only by asking the auth service each time'}.`); }
      else { u.message = `Sign-in failed: ${r.error.message}`; u.tone = 'fail'; Y.failed(ctx); }
    }, { self: 'app' });
  }
  function startFetch(sim, label) {
    sim.startAction(label || 'User: open subscriptions', function* (ctx) {
      const u = ctx.ui.app;
      Y.L(ctx, { committed: ['n/a', 'A read.'], async: 'n/a', retrySafe: 'yes', displayed: 'pending' });
      const r = yield* call(ctx, '/subscriptions');
      if (r.ok) { u.message = 'Loaded your subscriptions.'; u.tone = 'ok'; Y.L(ctx, { displayed: 'yes', accepted: 'yes' }); }
      else { u.message = { UNAUTHENTICATED: /expired/i.test(r.error.message) ? 'Session expired. Please sign in again.' : 'This session has been signed out.', RATE_LIMITED: 'Slow down: too many requests.', UNAVAILABLE: 'Can’t reach YouTube right now.' }[r.error.code] || r.error.message; u.tone = r.error.code === 'RATE_LIMITED' ? 'warn' : 'fail'; Y.failed(ctx, u.message); }
      return r;
    }, { self: 'app' });
  }
  function startSpam(sim) {
    sim.startAction('User: refresh 12 times fast', function* (ctx) {
      const st = ctx.state;
      Y.L(ctx, { committed: 'n/a', async: 'n/a', retrySafe: 'yes', displayed: 'pending' });
      let ok = 0;
      let limited = 0;
      for (let i = 0; i < 12; i++) {
        const r = yield* call(ctx, '/home');
        if (r.ok) ok++; else if (r.error.code === 'RATE_LIMITED') limited++;
        yield ctx.wait(40);
      }
      st.burst = { ok, limited };
      ctx.ui.app.message = `${ok} requests served, ${limited} rejected with 429.`;
      Y.L(ctx, { displayed: ['yes', ctx.ui.app.message], accepted: ok ? 'yes' : 'no' });
      ctx.explain(limited ? `The token bucket holds ${BUCKET} requests and refills ${REFILL_PER_S} per second, so a burst of 12 gets about ${BUCKET + 1} through and the rest are told to slow down.` : 'Every request was served: nothing limited this burst.');
    }, { self: 'app' });
  }

  const sc = (SDL.scenarios.auth = {
    id: 'auth',
    seed: 193,
    productWidth: 440,
    intro: 'Sign in, then open your subscriptions. The gateway verifies the token and checks the rate limit on every request. Then take the auth service down, let the token expire, or hammer refresh.',
    topology: {
      width: 1100, height: 500,
      nodes: [
        { id: 'app', label: 'YouTube app', sub: 'Holds tokens', kind: 'client', x: 100, y: 90, latency: 1, role: 'Stores the access and refresh tokens and sends the access token on every call.', owns: ['Tokens'] },
        { id: 'gateway', label: 'API gateway', sub: 'Verify + limit', kind: 'gateway', x: 340, y: 90, latency: 2, role: 'Verifies the token (locally or by introspection) and applies the rate limit before any service sees the request.', ops: [{ name: 'api', desc: 'Authenticated call.' }, { name: 'login', desc: 'Sign in.' }, { name: 'refresh', desc: 'New access token.' }], owns: ['Cached signing keys'] },
        { id: 'authsvc', label: 'Auth service', sub: 'Sessions', kind: 'service', x: 340, y: 320, latency: 8, role: 'Checks passwords, issues and refreshes tokens, answers introspection, and records revocations.', ops: [{ name: 'login', desc: 'Issue tokens.' }, { name: 'introspect', desc: 'Is this token valid?' }, { name: 'refresh', desc: 'New access token.' }], owns: ['sessions', 'revocations'] },
        { id: 'users', label: 'User database', sub: 'Credentials', kind: 'db', x: 600, y: 320, latency: 10, role: 'Password hashes and account status.', ops: [{ name: 'check', desc: 'Verify a password.' }], owns: ['users'] },
        { id: 'limiter', label: 'Rate-limit store', sub: 'Token buckets', kind: 'cache', x: 600, y: 90, latency: 2, role: 'A shared token bucket per user, so every gateway server enforces the same limit.', ops: [{ name: 'take', desc: 'Take one token if available.' }], owns: ['bucket[user]'] },
        { id: 'api', label: 'Video API', sub: 'The real work', kind: 'service', x: 860, y: 90, latency: 6, role: 'Serves subscriptions, home, and so on to authenticated users.', ops: [{ name: 'get', desc: 'Serve a request.' }], owns: ['Nothing here'] },
      ],
      edges: [
        { from: 'app', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'authsvc', latency: 4, label: 'introspect' },
        { from: 'authsvc', to: 'users', latency: 4 },
        { from: 'gateway', to: 'limiter', latency: 3 },
        { from: 'gateway', to: 'api', latency: 4, via: [[340, 22], [860, 22]] },
      ],
    },
    failures: [
      { id: 'auth-down', node: 'authsvc', mode: 'down', label: 'Auth service down', desc: 'No sign-ins, refreshes, or introspection.' },
      { id: 'limiter-down', node: 'limiter', mode: 'down', label: 'Rate-limit store down', desc: 'The gateway cannot check buckets.' },
      { id: 'users-down', node: 'users', mode: 'down', label: 'User database down', desc: 'Passwords cannot be checked.' },
    ],
    switches: Y.switches([
      ['local', 'Verify tokens locally', 'Check the signature with cached keys. Off: ask the auth service on every request.'],
      ['refresh', 'Refresh expired tokens automatically', 'Off: the user is signed out when the access token expires.'],
      ['failOpen', 'Allow traffic if the limiter is down', 'Fail open: keep serving without limits. Off: fail closed and reject everything.'],
    ]),
    presets: Y.presets({ local: true, refresh: true, failOpen: true }, [
      { id: 'signin', label: 'Sign in and browse', desc: 'Sign in, then an authenticated request passes the gateway checks.', run: (s) => { startSignIn(s); s.schedule(800, () => startFetch(s)); } },
      { id: 'auth-down', label: 'Auth down, local verification', desc: 'Signed-in users keep browsing: the gateway never needs the auth service to check a token.', run: (s) => { startSignIn(s); s.schedule(800, () => s.inject('authsvc', 'down')); s.schedule(1200, () => startFetch(s)); } },
      { id: 'auth-down-bad', label: 'Auth down, introspection', desc: 'Every request depends on the auth service, so every signed-in user is locked out.', sw: { local: false }, run: (s) => { startSignIn(s); s.schedule(800, () => s.inject('authsvc', 'down')); s.schedule(1200, () => startFetch(s)); } },
      { id: 'expiry', label: 'Token expires, auto refresh', desc: 'After 6 s the access token expires; the app refreshes it silently.', run: (s) => { startSignIn(s); s.schedule(7000, () => startFetch(s, 'User: open subscriptions (after expiry)')); } },
      { id: 'expiry-bad', label: 'Token expires, no refresh', desc: 'The user is bounced to the sign-in screen mid-session.', sw: { refresh: false }, run: (s) => { startSignIn(s); s.schedule(7000, () => startFetch(s, 'User: open subscriptions (after expiry)')); } },
      { id: 'spam', label: 'Burst of requests', desc: '12 requests in half a second: the bucket lets about 6 through and returns 429 for the rest.', run: (s) => { startSignIn(s); s.schedule(800, () => startSpam(s)); } },
      { id: 'limiter-open', label: 'Limiter down, fail open', desc: 'The burst is fully served: the site stays up, but limits are not enforced.', run: (s) => { startSignIn(s); s.schedule(600, () => s.inject('limiter', 'down')); s.schedule(800, () => startSpam(s)); } },
      { id: 'limiter-closed', label: 'Limiter down, fail closed', desc: 'Every request is rejected: safe from abuse, but an outage for everyone.', sw: { failOpen: false }, run: (s) => { startSignIn(s); s.schedule(600, () => s.inject('limiter', 'down')); s.schedule(800, () => startSpam(s)); } },
      { id: 'revoke', label: 'Revoked token, local verification', desc: 'The session is revoked (stolen phone), but a locally verified token keeps working until it expires.', run: (s) => { startSignIn(s); s.schedule(800, () => s.do('revoke', {})); s.schedule(1300, () => startFetch(s, 'Attacker: use the stolen token')); } },
      { id: 'revoke-introspect', label: 'Revoked token, introspection', desc: 'The auth service knows about the revocation, so the stolen token is refused at once.', sw: { local: false }, run: (s) => { startSignIn(s); s.schedule(800, () => s.do('revoke', {})); s.schedule(1300, () => startFetch(s, 'Attacker: use the stolen token')); } },
    ]),
    initialState: () => ({ config: { local: true, refresh: true, failOpen: true }, sessions: {}, revoked: {}, bucket: { tokens: BUCKET, t: 0 }, unlimitedServed: 0, revokedAccepted: 0, lockedOut: 0, burst: null, seq: { tok: 0 } }),
    initialUI: () => ({ app: { token: null, refresh: null, message: 'Sign in to start.', tone: '' } }),
    actions: {
      signin(sim) { startSignIn(sim); },
      fetch(sim) { startFetch(sim); },
      spam(sim) { startSpam(sim); },
      revoke(sim) { const t = sim.ui.app.token; if (t) { sim.state.revoked[t.sid] = true; sim.note(`Session ${t.sid} revoked: the user reported a stolen phone.`); } },
      set: Y.setAction,
    },
    handlers: {
      gateway: {
        login: function* (ctx, p) { return ctx.must(yield ctx.call('authsvc', 'login', p, { timeout: 1200 })); },
        refresh: function* (ctx, p) { return ctx.must(yield ctx.call('authsvc', 'refresh', p, { timeout: 900 })); },
        api: function* (ctx, p) {
          const st = ctx.state;
          if (!p.token) ctx.fail('UNAUTHENTICATED', 'No token.');
          if (st.config.local) {
            if (p.token.exp <= ctx.now()) ctx.fail('UNAUTHENTICATED', 'Token expired.');
            if (st.revoked[p.token.sid]) st.revokedAccepted++;
          } else {
            const r = yield ctx.call('authsvc', 'introspect', { token: p.token }, { timeout: 500 });
            if (!r.ok) { st.lockedOut++; ctx.fail('UNAVAILABLE', 'Could not verify the session.'); }
            if (!r.value.active) ctx.fail('UNAUTHENTICATED', 'Token is no longer valid.');
          }
          const l = yield ctx.call('limiter', 'take', { user: p.token.user }, { timeout: 300 });
          if (!l.ok) { if (!st.config.failOpen) ctx.fail('UNAVAILABLE', 'Rate limiter unavailable; failing closed.'); st.unlimitedServed++; }
          else if (!l.value.allowed) ctx.fail('RATE_LIMITED', 'Too many requests.');
          return ctx.must(yield ctx.call('api', 'get', { path: p.path }, { timeout: 800 }));
        },
      },
      authsvc: {
        login: function* (ctx, p) {
          ctx.must(yield ctx.call('users', 'check', p, { timeout: 800 }));
          const st = ctx.state;
          const sid = 's' + ++st.seq.tok;
          st.sessions[sid] = true;
          return { token: { user: p.user, sid, exp: ctx.now() + TOKEN_TTL }, refresh: { sid } };
        },
        refresh(ctx, p) { if (ctx.state.revoked[p.refresh.sid]) ctx.fail('UNAUTHENTICATED', 'Session revoked.'); return { token: { user: 'sam', sid: p.refresh.sid, exp: ctx.now() + TOKEN_TTL } }; },
        introspect(ctx, p) { return { active: p.token.exp > ctx.now() && !ctx.state.revoked[p.token.sid] }; },
      },
      users: { check() { return { ok: true }; } },
      limiter: {
        take(ctx) {
          const b = ctx.state.bucket;
          b.tokens = Math.min(BUCKET, b.tokens + ((ctx.now() - b.t) / 1000) * REFILL_PER_S);
          b.t = ctx.now();
          if (b.tokens >= 1) { b.tokens -= 1; return { allowed: true }; }
          return { allowed: false };
        },
      },
      api: { get() { return { ok: true }; } },
    },
    consistency(sim) {
      const st = sim.state;
      if (st.revokedAccepted) return { key: 'wrong', label: `A revoked session was accepted ${st.revokedAccepted} time${st.revokedAccepted > 1 ? 's' : ''}: local verification cannot see revocations until the token expires.` };
      if (st.lockedOut) return { key: 'wrong', label: 'Signed-in users are locked out because every request depends on the auth service.' };
      if (sim.ui.app.tone === 'fail' && /sign in again/.test(sim.ui.app.message)) return { key: 'wrong', label: 'The user was signed out mid-session when the access token expired.' };
      if (st.burst && st.burst.ok === 0 && st.burst.limited === 0) return { key: 'wrong', label: 'Every request was rejected: failing closed turned a limiter outage into a site outage.' };
      if (st.unlimitedServed) return { key: 'stale', label: `${st.unlimitedServed} requests were served without a rate-limit check while the limiter was down.` };
      return { key: 'ok', label: 'Every request was authenticated and limited correctly.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const t = sim.ui.app.token;
      return [
        { label: 'Token expires in', value: t ? `${Math.max(0, (t.exp - sim.now) / 1000).toFixed(1)} s` : 'signed out' },
        { label: 'Bucket tokens', value: st.bucket.tokens.toFixed(1) },
        { label: 'Served without limits', value: st.unlimitedServed, tone: st.unlimitedServed ? 'warn' : '' },
        { label: 'Revoked token accepted', value: st.revokedAccepted, tone: st.revokedAccepted ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['app', 'Your phone']], { note: 'Every request carries the access token; the gateway checks it and the rate limit first.' }); },
      render(el, sim) {
        const u = sim.ui.app;
        const body = `${u.token ? `<div class="app-card is-ok"><strong>Signed in as Sam</strong><span class="app-sub">Access token expires in <span data-live="exp"></span></span></div>` : ''}
          ${Y.btn('signin', u.token ? 'Sign in again' : 'Sign in', { cls: u.token ? 'secondary' : '' })}
          ${Y.btn('fetch', 'Open subscriptions', { disabled: !u.token })}${Y.btn('spam', 'Refresh 12 times fast', { cls: 'secondary', disabled: !u.token })}${Y.msg(u.message, u.tone)}`;
        Y.paint(el, sim, 'app', { head: '<div><p class="app-title">YouTube</p></div>', body }, { exp: u.token ? `${Math.max(0, (u.token.exp - sim.now) / 1000).toFixed(1)} s` : '' });
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
