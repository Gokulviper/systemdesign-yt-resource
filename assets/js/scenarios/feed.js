/*
 * Home feed and recommendations. The feed service gathers candidates from
 * three sources in parallel, asks an ML ranker to order them (the ranker reads
 * features), and returns a page. A deadline lets it return partial results
 * when a source is slow; fallbacks keep the page useful when ranking fails.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const POOL = {
    subs: [['Raft, part 2', 'Distributed Daily', 0.82], ['Tomato pruning', 'Ana’s Garden', 0.64]],
    trend: [['World cup final highlights', 'SportsHub', 0.41], ['New phone, 30 days later', 'TechNow', 0.38]],
    reco: [['Paxos made simple, live', 'CS Explained', 0.91], ['Designing a rate limiter', 'Backend Bits', 0.88], ['Kafka internals', 'Stream Talk', 0.86]],
  };
  const SOURCE_LABEL = { subs: 'Subscriptions', trend: 'Trending', reco: 'For you' };

  function startOpen(sim) {
    sim.startAction('Viewer: open home', function* (ctx) {
      const u = ctx.ui.viewer;
      u.loading = true;
      Y.L(ctx, { displayed: ['pending', 'Shows placeholders while the feed loads.'], committed: ['n/a', 'Reading the feed writes nothing.'], async: 'n/a', retrySafe: 'yes' });
      const t0 = ctx.now();
      const r = yield ctx.call('gateway', 'home', {}, { timeout: 3000 });
      u.loading = false;
      ctx.recordOutcome(r.ok, ctx.now() - t0);
      if (r.ok) {
        Object.assign(u, { items: r.value.items, mode: r.value.mode, missing: r.value.missing, took: ctx.now() - t0, error: null });
        Y.L(ctx, { displayed: ['yes', `${r.value.items.length} videos, ${r.value.mode}.`], accepted: 'yes' });
        const parts = [];
        if (r.value.missing.length) parts.push(`${r.value.missing.map((m) => SOURCE_LABEL[m]).join(' and ')} missed the deadline, so the page was built without ${r.value.missing.length > 1 ? 'them' : 'it'}`);
        if (r.value.mode !== 'ranked') parts.push('the ranker was unavailable, so the fallback ordered candidates by a simple popularity score');
        if (r.value.staleFeatures) parts.push('features were stale, so ranking quality dropped');
        ctx.explain(`The home page loaded in ${Math.round(ctx.now() - t0)} ms. ${parts.length ? 'It is degraded: ' + parts.join('; ') + '. The viewer still gets a useful page.' : 'All three sources answered and the ranker ordered the candidates.'}`);
      } else {
        Object.assign(u, { items: [], error: 'Something went wrong. Pull to refresh.', took: ctx.now() - t0 });
        Y.failed(ctx, 'Shows an error page.');
        ctx.explain(`The home page failed with ${r.error.code}: without a deadline or a fallback, one slow or broken dependency took down the whole page.`);
      }
    }, { self: 'viewer' });
  }

  const sc = (SDL.scenarios.feed = {
    id: 'feed',
    seed: 163,
    productWidth: 440,
    intro: 'Open the home page on the phone. Three candidate sources answer in parallel, the ranker orders them, and the page appears. Then slow a source or break the ranker.',
    topology: {
      width: 1100, height: 540,
      nodes: [
        { id: 'viewer', label: 'YouTube app', sub: 'Home page', kind: 'client', x: 100, y: 90, latency: 1, role: 'Shows the home feed.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Viewer traffic', kind: 'gateway', x: 320, y: 90, latency: 2, role: 'Routes the home request.', ops: [{ name: 'home', desc: 'Build the home page.' }], owns: ['Nothing durable'] },
        { id: 'feedsvc', label: 'Feed service', sub: 'Gather, rank, page', kind: 'service', x: 540, y: 90, latency: 4, role: 'Calls candidate sources in parallel with a deadline, then the ranker, with fallbacks.', ops: [{ name: 'home', desc: 'Assemble a page.' }], owns: ['Deadlines', 'Fallback rules'] },
        { id: 'subs', label: 'Subscriptions source', sub: 'Candidates', kind: 'service', x: 320, y: 300, latency: 30, role: 'New videos from channels you follow.', ops: [{ name: 'candidates', desc: 'Return candidates.' }], owns: ['Nothing'] },
        { id: 'trend', label: 'Trending source', sub: 'Candidates', kind: 'service', x: 540, y: 300, latency: 25, role: 'What is popular right now.', ops: [{ name: 'candidates', desc: 'Return candidates.' }], owns: ['Trending lists'] },
        { id: 'reco', label: 'Recommendations', sub: 'Candidates', kind: 'service', x: 760, y: 300, latency: 60, role: 'Personalised candidates from embeddings.', ops: [{ name: 'candidates', desc: 'Return candidates.' }], owns: ['Embedding index'] },
        { id: 'ranker', label: 'Ranker', sub: 'ML model', kind: 'service', x: 760, y: 90, latency: 40, role: 'Scores every candidate for this viewer and orders them.', ops: [{ name: 'rank', desc: 'Score and sort.' }], owns: ['Model'] },
        { id: 'features', label: 'Feature store', sub: 'User and video features', kind: 'cache', x: 980, y: 90, latency: 6, role: 'Recent watch history and video statistics the ranker uses.', ops: [{ name: 'get', desc: 'Features for scoring.' }], owns: ['features'] },
        { id: 'popular', label: 'Popular cache', sub: 'Fallback list', kind: 'cache', x: 980, y: 300, latency: 2, role: 'A precomputed, non-personal ordering used when ranking is unavailable.', ops: [{ name: 'get', desc: 'Popularity scores.' }], owns: ['popularity'] },
      ],
      edges: [
        { from: 'viewer', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'feedsvc', latency: 3 },
        { from: 'feedsvc', to: 'subs', latency: 4 },
        { from: 'feedsvc', to: 'trend', latency: 4 },
        { from: 'feedsvc', to: 'reco', latency: 4 },
        { from: 'feedsvc', to: 'ranker', latency: 4 },
        { from: 'ranker', to: 'features', latency: 3 },
        { from: 'feedsvc', to: 'popular', latency: 4, via: [[540, 190], [980, 190]] },
      ],
    },
    modeLabels: { stale: 'Serving stale features' },
    failures: [
      { id: 'reco-slow', node: 'reco', mode: 'slow', params: { factor: 30 }, label: 'Recommendations slow', desc: 'Candidate generation takes about 2 s.' },
      { id: 'ranker-down', node: 'ranker', mode: 'down', label: 'Ranker down', desc: 'No personalised ordering available.' },
      { id: 'ranker-slow', node: 'ranker', mode: 'slow', params: { factor: 25 }, label: 'Ranker slow', desc: 'Scoring takes about a second.' },
      { id: 'features-stale', node: 'features', mode: 'stale', label: 'Stale features', desc: 'The feature pipeline stalled; scores use day-old data.' },
      { id: 'subs-down', node: 'subs', mode: 'down', label: 'Subscriptions source down', desc: 'One source fails outright.' },
    ],
    switches: Y.switches([
      ['deadline', 'Deadline with partial results', 'Wait at most 300 ms for candidate sources, then go with what arrived. Off: wait for all.'],
      ['fallback', 'Fallback ordering', 'If ranking fails or is slow, order by popularity. Off: the page fails.'],
    ]),
    presets: Y.presets({ deadline: true, fallback: true }, [
      { id: 'open', label: 'Open the home page', desc: 'Three sources, ranked, in a few hundred milliseconds.', run: (s) => startOpen(s) },
      { id: 'reco-slow', label: 'Slow source, with a deadline', desc: 'Recommendations take 2 s. The page arrives on time without them.', run: (s) => { s.inject('reco', 'slow', { factor: 30 }); startOpen(s); } },
      { id: 'reco-slow-bad', label: 'Slow source, no deadline', desc: 'The whole page waits for the slowest source.', sw: { deadline: false }, run: (s) => { s.inject('reco', 'slow', { factor: 30 }); startOpen(s); } },
      { id: 'ranker-down', label: 'Ranker down, fallback', desc: 'The page is ordered by popularity: less personal, still useful.', run: (s) => { s.inject('ranker', 'down'); startOpen(s); } },
      { id: 'ranker-down-bad', label: 'Ranker down, no fallback', desc: 'An error page, because one model is down.', sw: { fallback: false }, run: (s) => { s.inject('ranker', 'down'); startOpen(s); } },
      { id: 'ranker-slow', label: 'Ranker slow, fallback', desc: 'The ranker misses its 400 ms budget; the fallback serves a page on time.', run: (s) => { s.inject('ranker', 'slow', { factor: 25 }); startOpen(s); } },
      { id: 'stale', label: 'Stale features', desc: 'Everything is up, but scores use day-old features: worse ordering, silently.', run: (s) => { s.inject('features', 'stale'); startOpen(s); } },
      { id: 'subs-down', label: 'A source fails', desc: 'Subscriptions errors; the page is built from the other two.', run: (s) => { s.inject('subs', 'down'); startOpen(s); } },
    ]),
    initialState: () => ({ config: { deadline: true, fallback: true } }),
    initialUI: () => ({ viewer: { items: [], loading: false, mode: null, missing: [], took: null, error: null } }),
    actions: { open(sim) { startOpen(sim); }, set: Y.setAction },
    handlers: {
      gateway: { home: function* (ctx) { return ctx.must(yield ctx.call('feedsvc', 'home', {}, { timeout: 2900 })); } },
      feedsvc: {
        home: function* (ctx) {
          const st = ctx.state;
          const srcs = ['subs', 'trend', 'reco'];
          const results = {};
          const procs = srcs.map((s) => ctx.spawn(function* (c) { const r = yield c.call(s, 'candidates', {}, { timeout: 2500 }); results[s] = r; return r.ok; }));
          if (st.config.deadline) {
            const t0 = ctx.now();
            while (Object.keys(results).length < 3 && ctx.now() - t0 < 300) yield ctx.wait(20);
          } else yield ctx.join(procs);
          const got = srcs.filter((s) => results[s] && results[s].ok);
          const missing = srcs.filter((s) => !got.includes(s));
          if (!got.length) ctx.fail('NO_CANDIDATES', 'No candidate source answered.');
          const cands = got.flatMap((s) => results[s].value.items.map((it) => Object.assign({ source: s }, it)));
          const r = yield ctx.call('ranker', 'rank', { cands }, { timeout: 400 });
          if (r.ok) return { items: r.value.items, mode: 'ranked', missing, staleFeatures: r.value.stale };
          if (!st.config.fallback) ctx.must(r);
          const p = yield ctx.call('popular', 'get', {}, { timeout: 300 });
          const items = cands.slice().sort((a, b) => (p.ok ? b.pop - a.pop : 0));
          return { items, mode: 'ordered by popularity (fallback)', missing, staleFeatures: false };
        },
      },
      subs: { candidates() { return { items: POOL.subs.map(([t, c, rel]) => ({ title: t, channel: c, rel, pop: 0.3 })) }; } },
      trend: { candidates() { return { items: POOL.trend.map(([t, c, rel]) => ({ title: t, channel: c, rel, pop: 0.9 })) }; } },
      reco: { candidates() { return { items: POOL.reco.map(([t, c, rel]) => ({ title: t, channel: c, rel, pop: 0.5 })) }; } },
      ranker: {
        rank: function* (ctx, p) {
          const f = yield ctx.call('features', 'get', {}, { timeout: 200 });
          const stale = f.ok && f.value.stale;
          const items = p.cands.map((c) => Object.assign({}, c, { score: stale ? c.pop * 0.6 + c.rel * 0.4 : c.rel })).sort((a, b) => b.score - a.score);
          return { items, stale };
        },
      },
      features: { get(ctx) { return { stale: !!ctx.mode('stale') }; } },
      popular: { get() { return { ok: true }; } },
    },
    consistency(sim) {
      const u = sim.ui.viewer;
      if (u.error) return { key: 'wrong', label: 'The viewer got an error page instead of a feed.' };
      if (!u.items.length) return { key: 'ok', label: 'Open the home page to load a feed.' };
      const rel = u.items.slice(0, 3).reduce((a, it) => a + it.rel, 0) / 3;
      if (u.took > 1500) return { key: 'stale', label: `The page took ${SDL.fmtMs(u.took)}: viewers notice anything over a second.` };
      if (u.missing.length || u.mode !== 'ranked' || rel < 0.8) return { key: 'stale', label: `Degraded but useful: ${[u.missing.length ? `missing ${u.missing.map((m) => SOURCE_LABEL[m]).join(', ')}` : '', u.mode !== 'ranked' ? 'not personalised' : '', rel < 0.8 ? `top results less relevant (${rel.toFixed(2)})` : ''].filter(Boolean).join('; ')}.` };
      return { key: 'ok', label: `Fully ranked from all sources in ${SDL.fmtMs(u.took)}.` };
    },
    metrics(snap, sim) {
      const u = sim.ui.viewer;
      const rel = u.items.length ? u.items.slice(0, 3).reduce((a, it) => a + it.rel, 0) / Math.min(3, u.items.length) : null;
      return [
        { label: 'Home page time', value: u.took == null ? 'n/a' : SDL.fmtMs(u.took), tone: u.took > 1500 ? 'fail' : u.took > 600 ? 'warn' : 'ok' },
        { label: 'Top-3 relevance', value: rel == null ? 'n/a' : rel.toFixed(2), tone: rel != null && rel < 0.8 ? 'warn' : 'ok' },
        { label: 'Sources used', value: u.items.length ? `${3 - u.missing.length} of 3` : 'n/a' },
      ];
    },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['viewer', 'Your phone']], { note: 'Each card shows which source it came from. Relevance is how well the order matches what this viewer likes.' }); },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const u = sim.ui.viewer;
        let body = Y.btn('open', u.loading ? '<span class="spinner"></span>Loading…' : u.items.length ? 'Refresh home' : 'Open home', { disabled: u.loading });
        if (u.error) body += Y.msg(u.error, 'fail');
        if (u.items.length) body += `<p class="app-sub">${esc(u.mode)}${u.missing.length ? `, without ${u.missing.map((m) => SOURCE_LABEL[m]).join(', ')}` : ''}</p><div class="yt-feed">${u.items.slice(0, 6).map((it, i) => `<div class="yt-card"><div class="yt-thumb" style="--h:${(i * 47) % 360}">▶</div><div><strong>${esc(it.title)}</strong><span class="app-sub">${esc(it.channel)}</span> <span class="yt-tag">${SOURCE_LABEL[it.source]}</span></div></div>`).join('')}</div>`;
        Y.paint(el, sim, 'viewer', { head: '<div><p class="app-title">YouTube</p><p class="app-sub">Home</p></div>', body }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
