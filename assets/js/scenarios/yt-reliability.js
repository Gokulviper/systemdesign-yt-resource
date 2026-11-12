/*
 * Reliability. The watch page needs video metadata (critical) and
 * recommendations (optional). The page service has 20 request slots. When
 * recommendations slow down, missing timeouts let slow calls hold slots until
 * the whole page fails (a cascade); retries without a budget add load to the
 * struggling service; a circuit breaker stops calling it so it can recover.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const SLOTS = 20;

  function* page(ctx, mine) {
    const st = ctx.state;
    if (st.slots >= SLOTS) { st.rejected++; return { ok: false, error: { code: 'OVERLOADED', message: 'Page service has no free slots.' } }; }
    st.slots++;
    try {
      const t0 = ctx.now();
      const r = yield ctx.call('web', 'render', {}, { timeout: 4000, quiet: mine ? false : 'all' });
      ctx.sim.recordOutcome(r.ok, ctx.now() - t0);
      return r;
    } finally { st.slots--; }
  }

  const sc = (SDL.scenarios['yt-reliability'] = {
    id: 'yt-reliability',
    seed: 227,
    productWidth: 440,
    intro: 'Viewers load the watch page 40 times a second. Slow down recommendations and compare: no protection (a cascade), timeouts with a fallback, retries with and without a budget, and a circuit breaker.',
    topology: {
      width: 1000, height: 460,
      nodes: [
        { id: 'viewers', label: 'Viewers', sub: '40 pages per second', kind: 'client', x: 100, y: 230, latency: 1, role: 'Load watch pages; your phone is one of them.', owns: ['Nothing'] },
        { id: 'web', label: 'Watch page service', sub: '20 request slots', kind: 'service', x: 360, y: 230, latency: 3, role: 'Renders the page: video metadata is required, recommendations are optional.', ops: [{ name: 'render', desc: 'Build a page.' }], owns: ['Slots', 'Breaker state'] },
        { id: 'video', label: 'Video metadata', sub: 'Critical', kind: 'service', x: 640, y: 100, latency: 10, role: 'Title, description, manifest URL. The page cannot render without it.', ops: [{ name: 'get', desc: 'Metadata.' }], owns: ['videos'] },
        { id: 'reco', label: 'Recommendations', sub: 'Optional', kind: 'service', x: 640, y: 360, latency: 5, serviceMs: 20, servers: 2, role: '“Up next” suggestions. About 100 requests per second of capacity.', ops: [{ name: 'get', desc: 'Suggestions.' }], owns: ['Model'] },
        { id: 'fallback', label: 'Popular videos cache', sub: 'Fallback', kind: 'cache', x: 880, y: 230, latency: 2, role: 'A generic “up next” list for when recommendations are unavailable.', ops: [{ name: 'get', desc: 'Generic list.' }], owns: ['popular list'] },
      ],
      edges: [
        { from: 'viewers', to: 'web', latency: 25 },
        { from: 'web', to: 'video', latency: 3 },
        { from: 'web', to: 'reco', latency: 3 },
        { from: 'web', to: 'fallback', latency: 3, via: [[880, 100]] },
      ],
    },
    failures: [
      { id: 'reco-slow', node: 'reco', mode: 'slow', params: { factor: 40 }, label: 'Recommendations slow', desc: 'Each call takes about 0.8 s of work: capacity collapses to a few per second.' },
      { id: 'reco-down', node: 'reco', mode: 'down', label: 'Recommendations down', desc: 'Calls fail fast.' },
      { id: 'video-down', node: 'video', mode: 'down', label: 'Video metadata down', desc: 'A critical dependency: nothing can hide this.' },
    ],
    switches: Y.switches([
      ['timeout', 'Timeouts with fallback', 'Give recommendations 250 ms, then use the popular list. Off: wait as long as it takes.'],
      ['retries', 'Retry failed calls (3 attempts)', 'Retry recommendations on timeout.'],
      ['budget', 'Retry budget', 'Allow retries only while they are under 10% of calls.'],
      ['breaker', 'Circuit breaker', 'After 5 failures in a row, stop calling recommendations for 2 s, then probe.'],
    ]),
    presets: Y.presets({ timeout: true, retries: false, budget: true, breaker: true }, [
      { id: 'normal', label: 'Normal traffic', desc: 'Pages render in about 100 ms with personal recommendations.', run: (s) => s.schedule(1500, () => s.do('load', {})) },
      { id: 'cascade', label: 'Slow dependency, no protection', desc: 'Every page waits for slow recommendations; slots fill and pages fail, even though the video is fine.', sw: { timeout: false, breaker: false }, run: (s) => { s.inject('reco', 'slow', { factor: 40 }); s.schedule(2500, () => s.do('load', {})); } },
      { id: 'timeouts', label: 'Slow dependency, timeouts and fallback', desc: 'Pages render on time with a generic “up next” list.', sw: { breaker: false }, run: (s) => { s.inject('reco', 'slow', { factor: 40 }); s.schedule(2500, () => s.do('load', {})); } },
      { id: 'storm', label: 'Retries without a budget', desc: 'Every timeout is retried twice, tripling load on the struggling service.', sw: { breaker: false, retries: true, budget: false }, run: (s) => { s.inject('reco', 'slow', { factor: 40 }); s.schedule(2500, () => s.do('load', {})); } },
      { id: 'breaker', label: 'Circuit breaker', desc: 'After repeated failures the breaker opens: pages skip recommendations instantly, and the service gets room to recover.', run: (s) => { s.inject('reco', 'slow', { factor: 40 }, 3000); s.schedule(2500, () => s.do('load', {})); } },
      { id: 'critical', label: 'Critical dependency down', desc: 'Video metadata is down. Fallbacks cannot help; the honest answer is an error page.', run: (s) => { s.inject('video', 'down'); s.schedule(800, () => s.do('load', {})); } },
    ]),
    initialState: () => ({ config: { timeout: true, retries: false, budget: true, breaker: true }, slots: 0, rejected: 0, served: 0, failed: 0, fallbacks: 0, calls: 0, retriesUsed: 0, breaker: { state: 'closed', fails: 0, until: 0 }, mine: null }),
    initialUI: () => ({}),
    actions: {
      load(sim) {
        sim.startAction('You: open a watch page', function* (ctx) {
          Y.L(ctx, { committed: ['n/a', 'A read.'], async: 'n/a', retrySafe: 'yes', displayed: 'pending' });
          const r = yield* page(ctx, true);
          ctx.state.mine = r.ok ? { ok: true, reco: r.value.reco, ms: r.latency } : { ok: false, error: r.error.code };
          if (r.ok) Y.L(ctx, { displayed: ['yes', `Page in ${Math.round(r.latency)} ms, ${r.value.reco === 'personal' ? 'personal' : r.value.reco === 'fallback' ? 'generic' : 'no'} recommendations.`], accepted: 'yes' });
          else Y.failed(ctx, 'Error page.');
        }, { self: 'viewers' });
      },
      set: Y.setAction,
    },
    handlers: {
      web: {
        render: function* (ctx) {
          const st = ctx.state;
          const v = yield ctx.call('video', 'get', {}, { timeout: 800 });
          ctx.must(v);
          const b = st.breaker;
          let reco = 'none';
          if (st.config.breaker && b.state === 'open' && ctx.now() < b.until) reco = 'fallback';
          else {
            if (st.config.breaker && b.state === 'open') b.state = 'half-open';
            const attempts = st.config.retries ? 3 : 1;
            let ok = false;
            for (let a = 1; a <= attempts && !ok; a++) {
              if (a > 1 && st.config.budget && st.retriesUsed > st.calls * 0.1) break;
              if (a > 1) st.retriesUsed++;
              st.calls++;
              const r = yield ctx.call('reco', 'get', {}, { timeout: st.config.timeout ? 250 : 3500 });
              ok = r.ok;
            }
            if (ok) { reco = 'personal'; b.fails = 0; if (b.state === 'half-open') { b.state = 'closed'; ctx.log({ op: 'breaker closed', status: 'recovered', detail: 'The probe succeeded; recommendations are back.' }); } }
            else {
              b.fails++;
              if (st.config.breaker && (b.fails >= 5 || b.state === 'half-open') && b.state !== 'open') { b.state = 'open'; b.until = ctx.now() + 2000; ctx.log({ op: 'breaker opened', status: 'err', detail: 'Too many failures: skipping recommendations for 2 s.' }); }
              if (!st.config.timeout) ctx.fail('DEPENDENCY_FAILED', 'Recommendations failed and there is no fallback.');
              reco = 'fallback';
            }
          }
          if (reco === 'fallback') { st.fallbacks++; yield ctx.call('fallback', 'get', {}, { timeout: 200, quiet: 'all' }); }
          return { reco };
        },
      },
      video: { get() { return { ok: true }; } },
      reco: { get() { return { items: 10 }; } },
      fallback: { get() { return { items: 10 }; } },
    },
    setup(sim) {
      Y.load(sim, 'viewers', () => 40, function* (ctx) {
        const r = yield* page(ctx, false);
        if (r.ok) ctx.state.served++; else ctx.state.failed++;
      });
    },
    consistency(sim) {
      const snap = SDL.snapshot(sim, 2000);
      const recent = sim.requests.filter((r) => sim.now - r.t < 2000);
      const failRate = recent.length ? recent.filter((r) => !r.ok).length / recent.length : 0;
      const rej = sim.state.rejected;
      if (failRate > 0.2 || (rej && recent.length === 0)) return { key: 'wrong', label: `${Math.round(failRate * 100)}% of watch pages are failing${rej ? `, ${rej} rejected for lack of slots` : ''}.` };
      if (snap.p95 > 1000) return { key: 'stale', label: `Pages are slow: p95 ${SDL.fmtMs(snap.p95)}.` };
      if (sim.state.fallbacks && recent.length) return { key: 'stale', label: 'Degraded gracefully: pages render on time with generic recommendations.' };
      return { key: 'ok', label: 'Pages render fast with personal recommendations.' };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const recent = sim.requests.filter((r) => sim.now - r.t < 2000);
      const ok = recent.length ? Math.round((recent.filter((r) => r.ok).length / recent.length) * 100) : null;
      return [
        { label: 'Page success (last 2 s)', value: ok == null ? 'n/a' : `${ok}%`, tone: ok != null && ok < 80 ? 'fail' : 'ok' },
        { label: 'Slots in use', value: `${st.slots} of ${SLOTS}`, tone: st.slots >= SLOTS ? 'fail' : st.slots > SLOTS / 2 ? 'warn' : '' },
        { label: 'Recommendations queue', value: SDL.fmtMs(sim.queueWait('reco')), tone: sim.queueWait('reco') > 1000 ? 'fail' : '' },
        { label: 'Breaker', value: st.breaker.state },
        { label: 'Retries sent', value: st.retriesUsed },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['viewers', 'Your phone']], { note: 'Your page load competes with 40 others per second for the same 20 slots.' }); },
      render(el, sim) {
        const m = sim.state.mine;
        const body = `${Y.btn('load', 'Open a watch page')}${m ? (m.ok ? `<div class="app-card is-ok"><strong>Page loaded in ${Math.round(m.ms)} ms</strong><span class="app-sub">Up next: ${m.reco === 'personal' ? 'picked for you' : 'popular videos'}</span></div>` : `<div class="app-card is-fail"><strong>Something went wrong</strong><span class="app-sub">${m.error}</span></div>`) : ''}`;
        Y.paint(el, sim, 'viewers', { head: '<div><p class="app-title">YouTube</p></div>', body }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
