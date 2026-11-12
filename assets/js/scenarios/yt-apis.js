/*
 * APIs and data models: idempotency keys on writes, and offset versus cursor
 * pagination while new rows keep arriving.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;
  const PAGE = 5;

  function startPost(sim) {
    const st = sim.state;
    const key = 'idem-' + ++st.seq.key;
    sim.startAction('Client: POST /comments', function* (ctx) {
      Y.L(ctx, { displayed: 'pending', retrySafe: st.config.idem ? ['yes', `Header Idempotency-Key: ${key}`] : ['no', 'No key: the server cannot tell a retry from a new request.'] });
      const r = yield* ctx.retry({ attempts: 3, baseMs: 150 }, function* () {
        return yield ctx.call('gateway', 'post', { key: st.config.idem ? key : null, text: 'Great video!' }, { timeout: 900 });
      });
      ctx.ui.client.log.unshift(r.ok ? `POST /comments → 201 Created, id ${r.value.id}${r.value.replayed ? ' (replayed from key)' : ''}` : `POST /comments → ${r.error.code}`);
      if (r.ok) { Y.L(ctx, { displayed: 'yes', accepted: 'yes', async: 'n/a' }); ctx.explain(r.value.replayed ? 'The first attempt committed but its reply was lost. The retry carried the same Idempotency-Key, so the server returned the stored response instead of inserting again.' : 'One request, one row.'); }
      else Y.failed(ctx);
    }, { self: 'client' });
  }
  function startPage(sim, n) {
    const st = sim.state;
    sim.startAction(`Client: GET /comments page ${n}`, function* (ctx) {
      Y.L(ctx, { committed: ['n/a', 'A read.'], async: 'n/a', retrySafe: 'yes', displayed: 'pending' });
      const q = st.config.cursor ? (n === 1 ? { limit: PAGE } : { limit: PAGE, before: st.cursor }) : { limit: PAGE, offset: (n - 1) * PAGE };
      const r = yield ctx.call('gateway', 'list', q, { timeout: 900 });
      if (!r.ok) { Y.failed(ctx); return; }
      const ids = r.value.items.map((x) => x.id);
      if (n === 1) { st.pages = [ids]; } else st.pages.push(ids);
      st.cursor = r.value.next;
      ctx.ui.client.log.unshift(`GET /comments?${st.config.cursor ? (n === 1 ? 'limit=5' : `limit=5&before=${q.before}`) : `limit=5&offset=${q.offset}`} → ${ids.join(', ')}`);
      Y.L(ctx, { displayed: ['yes', `Page ${n}: ${ids.join(', ')}`], accepted: 'yes' });
      const seen = st.pages.flat();
      const dup = seen.filter((x, i) => seen.indexOf(x) !== i);
      ctx.explain(dup.length ? `Comment ${dup.join(', ')} appears on both pages: new comments arrived between requests, so every row shifted down and offset ${q.offset} now points at rows already shown.` : n > 1 ? `Page ${n} continues exactly where page 1 ended${st.config.cursor ? ': the cursor names the last item seen, not a position, so inserts above it do not matter' : ''}.` : 'First page, newest first.');
    }, { self: 'client' });
  }

  const sc = (SDL.scenarios['yt-apis'] = {
    id: 'yt-apis',
    seed: 197,
    productWidth: 440,
    intro: 'Use the API console: post a comment, or load page 1 then page 2 while other people keep commenting. Then switch off the idempotency key or cursor pagination and repeat.',
    topology: {
      width: 1000, height: 420,
      nodes: [
        { id: 'client', label: 'API client', sub: 'Your app', kind: 'client', x: 100, y: 90, latency: 1, role: 'Calls the public API.', owns: ['Cursor', 'Idempotency keys'] },
        { id: 'others', label: 'Other users', sub: 'Posting comments', kind: 'client', x: 100, y: 320, latency: 1, role: 'Keep adding comments while you page.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Versioned REST', kind: 'gateway', x: 360, y: 200, latency: 2, role: 'Validates requests and stores idempotency keys with their responses.', ops: [{ name: 'post', desc: 'POST /comments.' }, { name: 'list', desc: 'GET /comments.' }], owns: ['idempotency_keys → response'] },
        { id: 'svc', label: 'Comment service', sub: 'Business logic', kind: 'service', x: 600, y: 200, latency: 4, role: 'Creates and lists comments.', owns: ['Rules'] },
        { id: 'db', label: 'Comments table', sub: 'id, video, text, created', kind: 'db', x: 840, y: 200, latency: 8, role: 'Rows ordered by id (newest first) with an index for cursor queries.', ops: [{ name: 'insert', desc: 'New row.' }, { name: 'page', desc: 'Offset or cursor page.' }], owns: ['comments'] },
      ],
      edges: [
        { from: 'client', to: 'gateway', latency: 30 },
        { from: 'others', to: 'gateway', latency: 30 },
        { from: 'gateway', to: 'svc', latency: 3 },
        { from: 'svc', to: 'db', latency: 4 },
      ],
    },
    failures: [
      { id: 'drop', node: 'db', mode: 'dropResponse', label: 'Reply lost after insert', desc: 'The row commits; the client times out and retries.' },
      { id: 'db-down', node: 'db', mode: 'down', label: 'Database down', desc: 'Every call fails.' },
    ],
    switches: Y.switches([
      ['idem', 'Idempotency-Key header', 'Off: retries are indistinguishable from new requests.'],
      ['cursor', 'Cursor pagination', 'Page by “before id X”. Off: page by offset, which shifts when rows are inserted.'],
    ]),
    presets: Y.presets({ idem: true, cursor: true }, [
      { id: 'post', label: 'POST with a key, reply lost', desc: 'The retry returns the stored response: one comment.', run: (s) => { s.inject('db', 'dropResponse', true, 700); startPost(s); } },
      { id: 'post-bad', label: 'POST without a key, reply lost', desc: 'The retry inserts a second comment.', sw: { idem: false }, run: (s) => { s.inject('db', 'dropResponse', true, 700); startPost(s); } },
      { id: 'cursor', label: 'Page while others post, cursor', desc: 'Page 2 continues exactly after page 1.', run: (s) => { startPage(s, 1); s.schedule(400, () => s.do('others', { n: 3 })); s.schedule(1200, () => startPage(s, 2)); } },
      { id: 'offset', label: 'Page while others post, offset', desc: 'Three new comments push rows down: page 2 repeats items from page 1.', sw: { cursor: false }, run: (s) => { startPage(s, 1); s.schedule(400, () => s.do('others', { n: 3 })); s.schedule(1200, () => startPage(s, 2)); } },
    ]),
    initialState: () => ({ config: { idem: true, cursor: true }, rows: Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, text: 'Comment ' + (100 + i) })), keys: {}, pages: [], cursor: null, seq: { key: 0, id: 112 } }),
    initialUI: () => ({ client: { log: [] } }),
    actions: {
      post(sim) { startPost(sim); },
      page(sim, a) { startPage(sim, a.n); },
      others(sim, a) { for (let i = 0; i < a.n; i++) sim.spawn(function* (c) { yield c.call('gateway', 'post', { key: 'other-' + (++sim.state.seq.key), text: 'Nice!' }, { timeout: 900 }); }, { self: 'others' }); },
      set: Y.setAction,
    },
    handlers: {
      gateway: {
        post: function* (ctx, p) {
          const st = ctx.state;
          if (p.key && st.keys[p.key]) return Object.assign({ replayed: true }, st.keys[p.key]);
          const r = ctx.must(yield ctx.call('svc', 'post', p, { timeout: 800 }));
          return r;
        },
        list: function* (ctx, q) { return ctx.must(yield ctx.call('svc', 'list', q, { timeout: 800 })); },
      },
      svc: {
        post: function* (ctx, p) { return ctx.must(yield ctx.call('db', 'insert', p, { timeout: 600 })); },
        list: function* (ctx, q) { return ctx.must(yield ctx.call('db', 'page', q, { timeout: 600 })); },
      },
      db: {
        insert(ctx, p) {
          const st = ctx.state;
          const row = { id: ++st.seq.id, text: p.text };
          st.rows.push(row);
          if (p.key) st.keys[p.key] = { id: row.id };
          ctx.ledger('committed', 'yes', `Row ${row.id} inserted.`);
          return { id: row.id };
        },
        page(ctx, q) {
          const sorted = ctx.state.rows.slice().sort((a, b) => b.id - a.id);
          const items = q.before != null ? sorted.filter((r) => r.id < q.before).slice(0, q.limit) : sorted.slice(q.offset || 0, (q.offset || 0) + q.limit);
          return { items, next: items.length ? items[items.length - 1].id : null };
        },
      },
    },
    consistency(sim) {
      const st = sim.state;
      const mine = st.rows.filter((r) => r.text === 'Great video!');
      if (mine.length > 1) return { key: 'wrong', label: `One user action created ${mine.length} comments: a retry without an idempotency key.` };
      const seen = st.pages.flat();
      const dup = seen.filter((x, i) => seen.indexOf(x) !== i);
      if (dup.length) return { key: 'wrong', label: `Comment ${dup.join(', ')} was shown on two pages: offset pagination shifted under concurrent inserts.` };
      return { key: 'ok', label: 'Every action created exactly one row, and pages neither repeat nor skip.' };
    },
    metrics(snap, sim) { return [{ label: 'Rows in table', value: sim.state.rows.length }, { label: 'Stored idempotency keys', value: Object.keys(sim.state.keys).length }]; },
    product: {
      mount(el, sim) { Y.mount(el, sim, [['client', 'API console']], { note: 'Each line is a real request through the diagram and its response.' }); },
      render(el, sim) {
        const log = sim.ui.client.log.slice(0, 6).map((l) => `<div class="app-card"><code>${SDL.ui.esc(l)}</code></div>`).join('');
        Y.paint(el, sim, 'client', { head: '<div><p class="app-title">API console</p></div>', body: `${Y.btn('post', 'POST /comments')}<div class="app-row">${Y.btn('page', 'GET page 1', { cls: 'secondary', arg: { n: 1 } })}${Y.btn('page', 'GET page 2', { cls: 'secondary', arg: { n: 2 } })}</div>${Y.btn('others', 'Others post 3 comments', { cls: 'secondary', arg: { n: 3 } })}${log}` }, {});
      },
    },
  });
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
