/*
 * Searching your own mail.
 * Each mailbox has its own small index. Partitioned by user, a search touches
 * one shard; spread by message across every shard, each search asks all of
 * them, so one slow or dead shard hurts everyone. New mail becomes searchable
 * at the next index refresh (and PDF text only after extraction), so the
 * search frontend can merge in mail newer than the index watermark straight
 * from the mailbox (read-your-writes). A query cache makes repeats cheap, but a
 * missed invalidation can show mail the user deleted: key the cache by the
 * mailbox history id, or check every result against the mailbox before
 * showing it.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const SHARDS = ['s1', 's2', 's3'];
  const HOME = 's2'; // Maya’s shard when partitioned by user
  const REFRESH_MS = 800;
  const SHARD_TIMEOUT = 400;
  const SLOW_MS = 120;
  const OTHERS_RATE = 20;
  const WIN = 2000;
  const QUERIES = ['contract', 'from:omar contract', 'indemnity', 'invoice'];

  const INITIAL = [
    ['Omar', 'Contract v1', 'First draft of the contract for review.'],
    ['Acme Billing', 'Invoice 77', 'Your invoice for October.'],
    ['Lena', 'Photos from Goa', 'Beach photos from the trip.'],
    ['Omar', 'Re: contract dates', 'Can we sign the contract on Friday?'],
    ['Dev', 'Lunch Friday?', 'Lunch on Friday at noon?'],
    ['Landlord', 'Rent contract renewal', 'Your rent contract renews in March.'],
    ['Finch News', 'Weekly digest', 'Top stories this week.'],
    ['Acme Billing', 'Invoice 78', 'Your invoice for November.'],
    ['Omar', 'Flight details', 'Landing at 6 pm.'],
  ];
  const NEW = { from: 'Omar', subject: 'Contract final', body: 'Final version attached.', attach: { name: 'Contract-final.pdf', text: 'Indemnity clause and payment terms.' } };

  const words = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) || []);
  const bodyTerms = (m) => [...new Set([...words(`${m.subject} ${m.body}`), `from:${words(m.from)[0]}`, ...(m.attach ? ['has:attachment'] : [])])];
  const attachTerms = (m) => (m.attach ? [...new Set(words(m.attach.text))] : []);
  const qTerms = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (terms, q) => qTerms(q).every((t) => terms.includes(t));
  const num = (id) => +id.slice(1);
  const place = (st, id) => (st.config.byUser ? HOME : SHARDS[(num(id) - 1) % 3]);

  function initialState() {
    const st = {
      config: { byUser: true, merge: true, postFilter: true, histKey: true },
      msgs: {}, hidSeq: 0, wm: 0,
      index: { s1: {}, s2: {}, s3: {} },
      cache: {},
      view: { q: '', ids: [], pending: null },
      others: [], writes: 0, extracting: {}, lostInvalidations: 0,
    };
    INITIAL.forEach(([from, subject, body], i) => {
      const id = `m${i + 1}`;
      st.msgs[id] = { id, from, subject, body, attach: null, hid: ++st.hidSeq, created: st.hidSeq, deleted: false, extracted: true };
    });
    st.wm = st.hidSeq;
    reindex(st);
    return st;
  }
  /** Put every indexed document on the shard the current partitioning says. */
  function reindex(st) {
    const docs = {};
    for (const s of SHARDS) Object.assign(docs, st.index[s]);
    if (!Object.keys(docs).length) for (const m of Object.values(st.msgs)) if (!m.deleted) docs[m.id] = bodyTerms(m).concat(m.extracted ? attachTerms(m) : []);
    st.index = { s1: {}, s2: {}, s3: {} };
    for (const [id, terms] of Object.entries(docs)) st.index[place(st, id)][id] = terms;
    st.cache = {};
  }

  /** Which messages a perfect search would have returned at the moment the search began. */
  function truth(st, q, hidAt) {
    return Object.values(st.msgs).filter((m) => !m.deleted && m.created <= hidAt && matches(bodyTerms(m).concat(attachTerms(m)), q)).map((m) => m.id);
  }

  function search(sim, q) {
    sim.state.view.pending = q;
    sim.startAction(`Phone: search “${q}”`, function* (ctx) {
      const st = ctx.state;
      Y.L(ctx, { displayed: ['pending', 'Searching…'], retrySafe: ['yes', 'A search changes nothing.'], committed: ['n/a', 'Read only.'] });
      const r = yield ctx.call('api', 'search', { q }, { timeout: 2000 });
      st.view.pending = null;
      if (!r.ok) {
        st.view = { q, ids: [], error: r.error.code, t: ctx.now(), pending: null };
        Y.failed(ctx, `“Search is unavailable, try again” (${r.error.code}).`);
        return;
      }
      const v = r.value;
      st.view = { q, ids: v.ids, from: v.from, partial: v.partial, merged: v.merged, ms: v.ms, hidAt: v.hidAt, shards: v.shards, filtered: v.filtered, t: ctx.now(), pending: null };
      Y.L(ctx, {
        displayed: [v.partial.length ? 'pending' : 'yes', `${v.ids.length} result${v.ids.length === 1 ? '' : 's'} in ${v.ms} ms${v.partial.length ? `, without shard ${v.partial.map((s) => s.slice(1)).join(', ')}` : ''}.`],
        accepted: ['yes', v.from === 'cache' ? 'Served from the query cache.' : `Asked ${v.shards} shard${v.shards === 1 ? '' : 's'}.`],
        async: ['n/a', v.merged.length ? `${v.merged.length} just-arrived message${v.merged.length === 1 ? '' : 's'} merged from the mailbox.` : '—'],
      });
    }, { self: 'phone' });
  }
  function remove(sim, id) {
    const m = sim.state.msgs[id];
    if (!m || m.deleted) return;
    sim.startAction(`Phone: delete “${m.subject}”`, function* (ctx) {
      Y.L(ctx, { displayed: ['pending', 'Deleting…'], retrySafe: ['yes', 'Deleting twice is harmless.'] });
      const r = yield ctx.call('api', 'delete', { id }, { timeout: 1500 });
      if (!r.ok) { Y.failed(ctx, `Failed: ${r.error.code}.`); return; }
      const v = ctx.state.view;
      v.ids = v.ids.filter((x) => x !== id); // the app drops the row it just deleted
      Y.L(ctx, { displayed: ['yes', 'Gone from the list.'], committed: ['yes', `Deleted at history ${r.value.hid}.`], async: ['pending', r.value.invalidated ? 'Cache cleared; the index drops it at the next refresh.' : 'The cache invalidation was lost; the index drops it at the next refresh.'] });
    }, { self: 'phone' });
  }
  function arrive(sim) {
    if (sim.state.msgs.m10) return;
    sim.startAction('Omar sends “Contract final” with a PDF', function* (ctx) {
      Y.L(ctx, { displayed: ['n/a', 'Arrives on its own.'], retrySafe: ['n/a', 'Covered in the inbound lab.'] });
      const r = yield ctx.call('mbox', 'deliver', NEW, { timeout: 1500 });
      if (r.ok) Y.L(ctx, { accepted: ['yes', `History ${r.value.hid}.`], committed: ['yes', 'In Maya’s inbox now.'], async: ['pending', `Searchable at the next index refresh (every ${REFRESH_MS} ms); PDF text after extraction.`] });
    }, { self: 'api' });
  }

  const later = (sim, ms, fn) => sim.spawn(function* (ctx) { yield ctx.wait(ms); fn(ctx.sim); }, { self: 'phone', quiet: 'all' });

  function shardHandlers(sid) {
    return {
      search(ctx, p) {
        const st = ctx.state;
        if (p.other) return { ids: [], wm: st.wm };
        const ids = Object.entries(st.index[sid]).filter(([, terms]) => matches(terms, p.q)).map(([id]) => id);
        return { ids, wm: st.wm };
      },
      put(ctx, p) { const st = ctx.state; st.index[sid][p.id] = [...new Set((st.index[sid][p.id] || []).concat(p.terms))]; st.writes++; return { n: Object.keys(st.index[sid]).length }; },
      del(ctx, p) { delete ctx.state.index[sid][p.id]; ctx.state.writes++; return {}; },
    };
  }

  function* applyEvent(ctx, msg) {
    const st = ctx.state;
    const p = msg.payload;
    const shard = place(st, p.id);
    st.applied = st.applied || {};
    if (st.applied[msg.eventId]) st.dupApplied = (st.dupApplied || 0) + 1;
    st.applied[msg.eventId] = true;
    for (let tries = 0; tries < 30; tries++) {
      const r = yield ctx.call(shard, p.op === 'del' ? 'del' : 'put', { id: p.id, terms: p.terms }, { timeout: 800, actionId: msg.actionId });
      if (r.ok) break;
      yield ctx.wait(200);
    }
    st.wm = Math.max(st.wm, p.hid);
    const m = st.msgs[p.id];
    if (p.op === 'put' && m.attach && !m.extracted && !st.extracting[p.id]) {
      st.extracting[p.id] = true;
      ctx.spawn(function* (c) {
        const r = yield c.call('extract', 'text', { id: p.id }, { timeout: 30000, actionId: msg.actionId });
        if (!r.ok) { st.extracting[p.id] = false; return; }
        const w = yield c.call(place(st, p.id), 'put', { id: p.id, terms: r.value.terms }, { timeout: 800, actionId: msg.actionId });
        if (w.ok) { m.extracted = true; c.log({ op: `text of ${m.attach.name} indexed`, status: 'ok', actionId: msg.actionId, detail: `“${r.value.terms.slice(0, 3).join(' ')}…” is now searchable.` }); }
        st.extracting[p.id] = false;
      }, { self: 'indexers' });
    }
  }

  SDL.scenarios['gm-search'] = {
    id: 'gm-search',
    seed: 3011,
    minHopMs: 5,
    productWidth: 640,
    intro: 'Search Maya’s mail from the phone. Then search the moment new mail lands, delete a message and search again through the cache, or spread mailboxes across every shard and take one shard down.',
    topology: {
      width: 1160, height: 540,
      nodes: [
        { id: 'phone', label: 'Maya’s phone', sub: 'Gmail app', kind: 'client', x: 90, y: 300, latency: 1, role: 'Searches with operators like from:omar, and deletes from the results.', owns: ['The results on screen'] },
        { id: 'api', label: 'Gmail API', sub: 'Frontend', kind: 'gateway', x: 260, y: 300, latency: 3, role: 'Authenticates Maya and forwards search and delete.', ops: [{ name: 'search', desc: 'Run a query.' }, { name: 'delete', desc: 'Delete a message.' }], owns: ['Nothing durable'] },
        { id: 'sfe', label: 'Search frontend', sub: 'Plan, merge, filter', kind: 'service', x: 450, y: 210, latency: 3, role: 'Checks the cache, asks the shard (or every shard) that holds Maya’s index, merges in mail newer than the index watermark, and can check each result against the mailbox before returning it.', ops: [{ name: 'query', desc: 'Run a search for one user.' }], owns: ['Nothing durable'] },
        { id: 'qcache', label: 'Query cache', sub: 'Results by query', kind: 'cache', x: 450, y: 80, latency: 1, role: 'Recent results for each user and query. Cleared when the mailbox changes, unless the invalidation is lost. Keyed by history id, a changed mailbox simply never matches an old entry.', ops: [{ name: 'get', desc: 'Cached results.' }, { name: 'put', desc: 'Store results.' }, { name: 'invalidate', desc: 'Drop a user’s entries.' }], owns: ['cached results'] },
        { id: 'mbox', label: 'Mailbox store', sub: 'Source of truth', kind: 'db', x: 450, y: 440, latency: 3, role: 'Messages and the history id. Appends an index event for every insert and delete.', ops: [{ name: 'since', desc: 'Messages newer than a history id.' }, { name: 'exists', desc: 'Which of these ids still exist?' }, { name: 'delete', desc: 'Delete a message.' }], owns: ['messages', 'history id'] },
        { id: 's1', label: 'Index shard 1', sub: 'Users A–H', kind: 'db', x: 720, y: 100, latency: 3, serviceMs: 2, servers: 4, role: 'Inverted index: term → messages. Partitioned by user, it holds whole mailboxes for a third of users. Spread, it holds a third of every mailbox.', ops: [{ name: 'search', desc: 'Match terms.' }, { name: 'put', desc: 'Index a message.' }], owns: ['index segments'] },
        { id: 's2', label: 'Index shard 2', sub: 'Users I–P (Maya)', kind: 'db', x: 720, y: 220, latency: 3, serviceMs: 2, servers: 4, role: 'Holds Maya’s whole index when partitioned by user.', ops: [{ name: 'search', desc: 'Match terms.' }, { name: 'put', desc: 'Index a message.' }], owns: ['index segments'] },
        { id: 's3', label: 'Index shard 3', sub: 'Users Q–Z', kind: 'db', x: 720, y: 340, latency: 3, serviceMs: 2, servers: 4, role: 'Another third of users (or of every mailbox, when spread).', ops: [{ name: 'search', desc: 'Match terms.' }, { name: 'put', desc: 'Index a message.' }], owns: ['index segments'] },
        { id: 'idxq', label: 'Index queue', sub: 'Insert and delete events', kind: 'queue', x: 720, y: 460, latency: 2, role: 'Every mailbox change, in history order.', owns: ['index events'] },
        { id: 'indexers', label: 'Indexers', sub: `Refresh every ${REFRESH_MS} ms`, kind: 'worker', x: 980, y: 260, latency: 2, role: 'Take a batch of events, build the segment, and make it visible at the next refresh. Indexing is keyed by message id, so applying an event twice changes nothing. Attachments go to the extractor.', owns: ['index watermark'] },
        { id: 'extract', label: 'Attachment text', sub: 'PDF and Office', kind: 'worker', x: 980, y: 90, latency: 120, role: 'Pulls the text out of attachments so their words become searchable, after the message itself.', ops: [{ name: 'text', desc: 'Extract text.' }], owns: ['Nothing durable'] },
      ],
      edges: [
        { from: 'phone', to: 'api', latency: 40 },
        { from: 'api', to: 'sfe', latency: 3 },
        { from: 'api', to: 'mbox', latency: 3 },
        { from: 'sfe', to: 'qcache', latency: 1 },
        { from: 'sfe', to: 's1', latency: 3, via: [[600, 210], [600, 100]] },
        { from: 'sfe', to: 's2', latency: 3, via: [[600, 210], [600, 220]] },
        { from: 'sfe', to: 's3', latency: 3, via: [[600, 210], [600, 340]] },
        { from: 'sfe', to: 'mbox', latency: 3, via: [[400, 210], [400, 440]] },
        { from: 'mbox', to: 'qcache', latency: 2, via: [[540, 440], [540, 80]] },
        { from: 'mbox', to: 'idxq', latency: 2, via: [[600, 440], [600, 460]] },
        { from: 'idxq', to: 'indexers', latency: 2, via: [[980, 460]] },
        { from: 'indexers', to: 's1', latency: 3, via: [[860, 260], [860, 100]] },
        { from: 'indexers', to: 's2', latency: 3, via: [[860, 260], [860, 220]] },
        { from: 'indexers', to: 's3', latency: 3, via: [[860, 260], [860, 340]] },
        { from: 'indexers', to: 'extract', latency: 2 },
      ],
      queues: [{ id: 'index', broker: 'idxq', label: 'index events', groups: ['indexers'] }],
    },
    modeLabels: { missInvalidation: 'Loses invalidations' },
    failures: [
      { id: 'backlog', node: 'indexers', mode: 'paused', label: 'Indexer backlog', desc: 'Indexers stop for a while; new mail and deletes wait in the queue.' },
      { id: 's3-down', node: 's3', mode: 'down', label: 'Shard 3 down', desc: 'Partitioned by user: a third of users cannot search. Spread: everyone loses a third of their results.' },
      { id: 's2-down', node: 's2', mode: 'down', label: 'Shard 2 down (Maya’s)', desc: 'Maya’s own shard. Partitioned by user, her search fails outright.' },
      { id: 's1-slow', node: 's1', mode: 'slow', params: { factor: 40 }, label: 'Shard 1 GC pause', desc: 'Shard 1 answers 40× slower. Spread: every search waits for it.' },
      { id: 'extract-slow', node: 'extract', mode: 'slow', params: { factor: 40 }, label: 'Attachment extractor slow', desc: 'PDF text takes seconds to become searchable.' },
      { id: 'dup', node: 'idxq', mode: 'duplicate', label: 'Duplicate index event', desc: 'Every event is appended twice.' },
      { id: 'miss-inval', node: 'qcache', mode: 'missInvalidation', label: 'Cache misses an invalidation', desc: 'A mailbox change does not clear the cached results.' },
      { id: 'mbox-slow', node: 'mbox', mode: 'slow', params: { factor: 30 }, label: 'Mailbox slow', desc: 'Merging recent mail and post-filtering add latency to every search.' },
    ],
    switches: Y.switches([
      ['byUser', 'Partition the index by user', 'All of a mailbox on one shard: a search asks one shard. Off: messages are spread across every shard by id, so every search asks all three.', (s) => reindex(s.state)],
      ['merge', 'Merge mail newer than the index', 'Also ask the mailbox for messages past the index watermark, so mail you can see in the inbox is in the results (read-your-writes).'],
      ['postFilter', 'Check results against the mailbox', 'Before returning, drop any result the mailbox no longer has (deleted, or moved out of reach).'],
      ['histKey', 'Key the cache by history id', 'The cache key includes the mailbox’s history id, so any change makes old entries unreachable. Off: keyed by the query alone and cleared by an invalidation.'],
    ]),
    presets: Y.presets({ byUser: true, merge: true, postFilter: true, histKey: true }, [
      { id: 'normal', label: 'New mail, then search', desc: 'Omar’s “Contract final” arrives with a PDF. A second later Maya searches “contract”: one shard answers, and the new message is there.', run: (s) => { arrive(s); later(s, 1500, (x) => search(x, 'contract')); } },
      { id: 'just-arrived-no-merge', label: 'Search the moment it lands, no merge', desc: 'Maya sees Omar’s message in her inbox and searches 300 ms later. The index refreshes every 800 ms, so it is not there yet, and nothing fills the gap.', sw: { merge: false }, run: (s) => { arrive(s); later(s, 300, (x) => search(x, 'contract')); } },
      { id: 'just-arrived-merge', label: 'Search the moment it lands, merge', desc: 'Same search. The frontend also asks the mailbox for anything newer than the index watermark and matches it on the spot: the new message is in the results.', run: (s) => { arrive(s); later(s, 300, (x) => search(x, 'contract')); } },
      { id: 'deleted-via-cache', label: 'Deleted mail comes back from the cache', desc: 'Maya searches “contract”, deletes “Contract v1”, and searches again. The invalidation was lost and the cache is keyed by the query alone, so the second search shows the message she deleted.', sw: { histKey: false, postFilter: false }, run: (s) => { s.inject('qcache', 'missInvalidation'); search(s, 'contract'); later(s, 800, (x) => remove(x, 'm1')); later(s, 2600, (x) => search(x, 'contract')); } },
      { id: 'deleted-post-filter', label: 'Same, with a post-filter', desc: 'Same lost invalidation and stale cache entry. Before returning, the frontend asks the mailbox which results still exist and drops “Contract v1”.', sw: { histKey: false }, run: (s) => { s.inject('qcache', 'missInvalidation'); search(s, 'contract'); later(s, 800, (x) => remove(x, 'm1')); later(s, 2600, (x) => search(x, 'contract')); } },
      { id: 'deleted-history-key', label: 'Same, cache keyed by history id', desc: 'Same lost invalidation, no post-filter. The delete moved the mailbox to a new history id, so the second search uses a new key, misses the cache, and reads the index, which has already dropped the message.', sw: { postFilter: false }, run: (s) => { s.inject('qcache', 'missInvalidation'); search(s, 'contract'); later(s, 800, (x) => remove(x, 'm1')); later(s, 2600, (x) => search(x, 'contract')); } },
      { id: 'user-other-shard-down', label: 'Partitioned by user, shard 3 down', desc: 'Shard 3 is down. Maya’s index is on shard 2, so her search is complete and fast; the users on shard 3 get “try again” until it is back.', run: (s) => { s.inject('s3', 'down'); later(s, 300, (x) => search(x, 'contract')); } },
      { id: 'spread-shard-down', label: 'Spread across shards, shard 3 down', desc: 'Every mailbox is spread across all three shards. With shard 3 down, everyone’s search silently misses a third of the matches: Maya does not see “Rent contract renewal”.', sw: { byUser: false }, run: (s) => { s.inject('s3', 'down'); later(s, 300, (x) => search(x, 'contract')); } },
      { id: 'spread-slow-shard', label: 'Spread across shards, one GC pause', desc: 'Shard 1 pauses. Spread, every search waits for the slowest of three shards, so every user’s search is slow, not just a third of them.', sw: { byUser: false }, run: (s) => { s.inject('s1', 'slow', { factor: 40 }); later(s, 500, (x) => search(x, 'contract')); } },
      { id: 'duplicate-index-event', label: 'Index event delivered twice', desc: 'The queue appends Omar’s insert twice. The index is keyed by message id, so the second write changes nothing: one result.', run: (s) => { s.inject('idxq', 'duplicate'); arrive(s); later(s, 1500, (x) => search(x, 'contract')); } },
      { id: 'extractor-slow', label: 'Search the PDF before its text is extracted', desc: 'The message is indexed, but the extractor is slow, so “indemnity”, a word only in the PDF, finds nothing yet. The mailbox merge cannot help: the text does not exist until it is extracted.', run: (s) => { s.inject('extract', 'slow', { factor: 40 }); arrive(s); later(s, 2500, (x) => search(x, 'indemnity')); } },
    ]),
    initialState,
    initialUI: () => ({}),
    actions: {
      search(sim, a) { search(sim, a.q); },
      del(sim, a) { remove(sim, a.id); },
      arrive(sim) { arrive(sim); },
      set: Y.setAction,
    },
    handlers: {
      api: {
        search: function* (ctx, p) { return ctx.must(yield ctx.call('sfe', 'query', p, { timeout: 1800 })); },
        delete: function* (ctx, p) { return ctx.must(yield ctx.call('mbox', 'delete', p, { timeout: 1200 })); },
      },
      sfe: {
        query: function* (ctx, p) {
          const st = ctx.state;
          const cfg = st.config;
          const t0 = ctx.now();
          const hidAt = st.hidSeq; // for the checker only: what a perfect search would include
          let key = p.q;
          if (cfg.histKey) key = `${p.q} @${ctx.must(yield ctx.call('mbox', 'head', {}, { timeout: 800 })).hid}`;
          const targets = cfg.byUser ? [HOME] : SHARDS;
          let ids;
          let from = 'index';
          const partial = [];
          const merged = [];
          const c = yield ctx.call('qcache', 'get', { key }, { timeout: 300 });
          if (c.ok && c.value) { ids = c.value.ids.slice(); from = 'cache'; }
          else {
            const procs = targets.map((s) => ctx.spawn(function* (c2) { return yield c2.call(s, 'search', { q: p.q }, { timeout: SHARD_TIMEOUT }); }, { self: 'sfe' }));
            const rs = yield ctx.join(procs);
            ids = [];
            let wm = Infinity;
            rs.forEach((x, i) => { const r = x.value; if (r && r.ok) { ids.push(...r.value.ids); wm = Math.min(wm, r.value.wm); } else partial.push(targets[i]); });
            if (cfg.byUser && partial.length) ctx.fail('UNAVAILABLE', 'Maya’s index shard did not answer.');
            if (cfg.merge && wm !== Infinity) {
              const r = yield ctx.call('mbox', 'since', { hid: wm, q: p.q }, { timeout: 800 });
              if (r.ok) for (const id of r.value.ids) if (!ids.includes(id)) { ids.push(id); merged.push(id); }
            }
            if (!partial.length) yield ctx.call('qcache', 'put', { key, ids }, { timeout: 300 });
          }
          let filtered = 0;
          if (cfg.postFilter && ids.length) {
            const r = ctx.must(yield ctx.call('mbox', 'exists', { ids }, { timeout: 800 }));
            filtered = ids.length - r.live.length;
            ids = ids.filter((id) => r.live.includes(id));
          }
          ids.sort((a, b) => num(b) - num(a));
          return { ids, from, partial, merged, ms: ctx.now() - t0, hidAt, shards: from === 'cache' ? 0 : targets.length, filtered };
        },
      },
      qcache: {
        get(ctx, p) { const e = ctx.state.cache[p.key]; return e ? { ids: e.ids.slice() } : null; },
        put(ctx, p) { ctx.state.cache[p.key] = { ids: p.ids.slice(), t: ctx.now() }; return {}; },
        invalidate(ctx) {
          const st = ctx.state;
          if (ctx.mode('missInvalidation')) {
            st.lostInvalidations++;
            ctx.log({ op: 'invalidation lost', status: 'lost', detail: 'The cache never hears about this change. Entries keyed by the query alone still hold the old results.' });
            return { cleared: false };
          }
          st.cache = {};
          return { cleared: true };
        },
      },
      mbox: {
        head(ctx) { return { hid: ctx.state.hidSeq }; },
        since(ctx, p) { return { ids: Object.values(ctx.state.msgs).filter((m) => !m.deleted && m.created > p.hid && matches(bodyTerms(m), p.q)).map((m) => m.id) }; },
        exists(ctx, p) { return { live: p.ids.filter((id) => ctx.state.msgs[id] && !ctx.state.msgs[id].deleted) }; },
        deliver(ctx, p) {
          const st = ctx.state;
          const id = `m${Object.keys(st.msgs).length + 1}`;
          const hid = ++st.hidSeq;
          st.msgs[id] = Object.assign({ id }, p, { hid, created: hid, deleted: false, extracted: !p.attach, t: ctx.now() });
          ctx.sim.enqueue('index', { type: 'put', eventId: `h${hid}`, payload: { op: 'put', id, hid, terms: bodyTerms(st.msgs[id]) }, actionId: ctx.actionId });
          return { hid, id };
        },
        delete: function* (ctx, p) {
          const st = ctx.state;
          const m = st.msgs[p.id];
          if (!m || m.deleted) ctx.fail('NOT_FOUND', 'No such message.');
          m.deleted = true;
          const hid = ++st.hidSeq;
          ctx.sim.enqueue('index', { type: 'del', eventId: `h${hid}`, payload: { op: 'del', id: p.id, hid }, actionId: ctx.actionId });
          const r = yield ctx.call('qcache', 'invalidate', {}, { timeout: 300 });
          return { hid, invalidated: r.ok && r.value.cleared };
        },
      },
      s1: shardHandlers('s1'),
      s2: shardHandlers('s2'),
      s3: shardHandlers('s3'),
      extract: {
        text(ctx, p) { return { terms: attachTerms(ctx.state.msgs[p.id]) }; },
      },
    },
    setup(sim) {
      // Indexers: take a batch, wait for the refresh, make it visible.
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msgs } = yield ctx.take('index', 'indexers', 50);
          yield ctx.wait(REFRESH_MS);
          for (const msg of msgs) yield* applyEvent(ctx, msg);
          ctx.ack('index', 'indexers');
        }
      }, { self: 'indexers' });
      // Everyone else searching: a third of users live on each shard.
      Y.load(sim, 'sfe', () => OTHERS_RATE, function* (ctx) {
        const st = ctx.state;
        const t0 = ctx.now();
        const home = SHARDS[Math.floor(ctx.rand() * 3)];
        const targets = st.config.byUser ? [home] : SHARDS;
        const procs = targets.map((s) => ctx.spawn(function* (c) { return yield c.call(s, 'search', { other: true }, { timeout: SHARD_TIMEOUT, quiet: 'all' }); }, { quiet: 'all' }));
        const rs = yield ctx.join(procs);
        const bad = rs.filter((x) => !(x.value && x.value.ok)).length;
        st.others.push({ t: ctx.now(), ms: ctx.now() - t0, failed: st.config.byUser && bad > 0, partial: !st.config.byUser && bad > 0 });
        while (st.others.length && st.others[0].t < ctx.now() - WIN) st.others.shift();
      });
    },
    consistency(sim) {
      const st = sim.state;
      const v = st.view;
      const shown = v.ids.map((id) => st.msgs[id]);
      const leaked = shown.find((m) => m.deleted);
      if (leaked) return { key: 'wrong', label: `Maya’s results show “${leaked.subject}”, which she deleted${v.from === 'cache' ? ': the cached results were never invalidated, the key did not change, and nothing checked them against the mailbox' : ': the index had not dropped it yet and nothing checked the results against the mailbox'}. Deleted mail must never be shown.` };
      if (v.error) return { key: 'stale', label: `Maya’s search failed (“try again”): her index shard is down. Nothing is lost; search is back when the shard is.` };
      if (v.partial && v.partial.length) {
        const missing = truth(st, v.q, v.hidAt).filter((id) => !v.ids.includes(id));
        return { key: 'stale', label: `Maya’s results are silently incomplete${missing.length ? `: “${missing.map((id) => st.msgs[id].subject).join('”, “')}” is missing` : ''} because shard ${v.partial.map((s) => s.slice(1)).join(', ')} did not answer. Spread across shards, every user is missing part of their results.` };
      }
      if (v.hidAt != null) {
        const missing = truth(st, v.q, v.hidAt).filter((id) => !v.ids.includes(id));
        if (missing.length) {
          const m = st.msgs[missing[0]];
          const inText = m.attach && !matches(bodyTerms(m), v.q);
          return { key: 'stale', label: inText ? `“${v.q}” is only in ${m.attach.name}, whose text ${m.extracted ? 'was not extracted yet when Maya searched' : 'is still being extracted'}. Searchable soon; nothing is lost.` : `“${m.subject}” was in Maya’s inbox when she searched, but not in her results: the index had not refreshed yet and nothing merged in newer mail. Searching again now would find it.` };
        }
        if (v.ms > SLOW_MS) return { key: 'stale', label: `Maya’s search took ${v.ms} ms${!st.config.byUser ? ': spread across shards, it had to wait for the slowest one (shard 1, paused). Every user’s search is that slow' : ''}.` };
      }
      if (st.config.byUser) {
        const sick = SHARDS.filter((s) => s !== HOME && (sim.nodes[s].modes.down || sim.nodes[s].modes.slow));
        if (sick.length) return { key: 'stale', label: `Maya’s results are complete and fast, but the users on shard ${sick.map((s) => s.slice(1)).join(', ')} (a third of everyone) ${sim.nodes[sick[0]].modes.down ? 'get “try again”' : 'see slow searches'} until it recovers.` };
      }
      if (!v.ids.length && v.hidAt == null) return { key: 'ok', label: 'Search Maya’s mail from the phone.' };
      const notes = [];
      if (v.merged && v.merged.length) notes.push(`${v.merged.length} just-arrived message${v.merged.length === 1 ? ' was' : 's were'} merged from the mailbox`);
      if (v.filtered) notes.push(`the post-filter dropped ${v.filtered} deleted result${v.filtered === 1 ? '' : 's'}`);
      if (st.dupApplied) notes.push(`the duplicate index event was applied again and changed nothing`);
      return { key: 'ok', label: `Maya’s results for “${v.q}” are complete and contain nothing she deleted (${v.ms} ms, ${v.from === 'cache' ? 'from the cache' : `${v.shards} shard${v.shards === 1 ? '' : 's'} asked`})${notes.length ? `; ${notes.join('; ')}` : ''}.` };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const v = st.view;
      const o = st.others;
      const lat = o.map((x) => x.ms).sort((a, b) => a - b);
      const p99 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.99))] : 0;
      const badPct = o.length ? Math.round((100 * o.filter((x) => x.failed || x.partial).length) / o.length) : 0;
      const leaked = v.ids.filter((id) => st.msgs[id].deleted).length;
      const docs = SHARDS.reduce((n, s) => n + Object.keys(st.index[s]).length, 0);
      return [
        { label: 'Index lag', value: `${st.hidSeq - st.wm} event${st.hidSeq - st.wm === 1 ? '' : 's'}`, tone: st.hidSeq - st.wm ? 'warn' : '' },
        { label: 'Maya’s last search', value: v.ms != null ? `${v.ms} ms` : '–', tone: v.ms > SLOW_MS ? 'warn' : '' },
        { label: 'Shards per search', value: st.config.byUser ? 1 : 3 },
        { label: 'Others’ p99 (2 s)', value: `${p99} ms`, tone: p99 > SLOW_MS ? 'warn' : '' },
        { label: 'Others failed or partial', value: `${badPct}%`, tone: badPct ? 'warn' : '' },
        { label: 'Deleted results shown', value: leaked, tone: leaked ? 'fail' : '' },
        { label: 'Indexed messages', value: docs },
        { label: 'Index writes', value: st.writes },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone']], {
          note: 'Tap a query to search Maya’s mail; delete from the results. The panel shows the mailbox, the index, and the cache.',
          side: '<div data-ref="backend"></div>',
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const v = st.view;
        const cards = v.ids.map((id) => {
          const m = st.msgs[id];
          const tags = [];
          if (v.merged && v.merged.includes(id)) tags.push('just arrived');
          if (m.attach) tags.push(`📎 ${m.attach.name}`);
          return `<div class="app-card ${m.deleted ? 'is-fail' : ''}"><strong>${esc(m.from)}${m.deleted ? ' · ✕ you deleted this' : ''}</strong><div class="app-row"><span class="app-sub" style="flex:1">${esc(m.subject)}${tags.length ? ` · ${esc(tags.join(' · '))}` : ''}</span>${m.deleted ? '' : Y.btn('del', 'Delete', { arg: { id }, cls: 'secondary' })}</div></div>`;
        }).join('');
        const meta = v.pending ? `Searching “${esc(v.pending)}”…` : v.error ? '' : v.q ? `${v.ids.length} result${v.ids.length === 1 ? '' : 's'} · ${v.ms} ms · ${v.from === 'cache' ? 'from the cache' : `${v.shards} shard${v.shards === 1 ? '' : 's'}`}` : 'Pick a query.';
        Y.paint(el, sim, 'phone', {
          head: `<div><p class="app-title">Search mail</p><p class="app-sub">${v.q ? `🔍 ${esc(v.q)}` : '🔍 —'}</p></div>`,
          chips: [QUERIES.slice(0, 2), QUERIES.slice(2)].map((row) => `<div class="app-row">${row.map((q) => Y.btn('search', esc(q), { arg: { q }, cls: q === v.q ? '' : 'secondary' })).join('')}</div>`).join(''),
          meta: `<p class="app-sub">${meta}</p>${v.error ? Y.msg('Search is unavailable. Try again.', 'fail') : ''}${v.partial && v.partial.length ? Y.msg('Some results may be missing.', 'warn') : ''}`,
          results: cards || (v.q && !v.pending && !v.error ? '<p class="app-sub">No results.</p>' : ''),
        }, {});
        const c = sim.scenario.consistency(sim);
        const live = Object.values(st.msgs).filter((m) => !m.deleted).length;
        const shardRow = (s) => {
          const n = sim.nodes[s];
          const mine = Object.keys(st.index[s]).length;
          const state = n.modes.down ? '✕ down' : n.modes.slow ? '◐ slow' : '● up';
          return `<div class="ops-row" data-tone="${n.modes.down ? 'fail' : n.modes.slow ? 'warn' : ''}"><div class="ops-name">Shard ${s.slice(1)} · ${state}<span>${mine} of Maya’s messages${st.config.byUser && s === HOME ? ' (all of them)' : ''}</span></div></div>`;
        };
        const keys = Object.keys(st.cache);
        const pend = Object.values(st.msgs).filter((m) => m.attach && !m.extracted && !m.deleted);
        SDL.ui.paintSections(el.querySelector('[data-ref="backend"]'), {
          title: '<p class="ops-title">Search backend</p>',
          btns: `<div class="app-row">${Y.btn('arrive', '✉ Omar sends “Contract final” (PDF)', { cls: 'secondary', disabled: !!st.msgs.m10 })}</div>`,
          rows: `<div class="ops-shards">
            <div class="ops-row"><div class="ops-name">Mailbox<span>${live} messages · history ${st.hidSeq}</span></div></div>
            <div class="ops-row" data-tone="${st.hidSeq > st.wm ? 'warn' : ''}"><div class="ops-name">Index watermark<span>history ${st.wm}${st.hidSeq > st.wm ? ` · ${st.hidSeq - st.wm} behind` : ' · caught up'}${pend.length ? ` · extracting ${esc(pend[0].attach.name)}` : ''}</span></div></div>
            ${SHARDS.map(shardRow).join('')}
            <div class="ops-row"><div class="ops-name">Query cache<span>${keys.length ? keys.map((k) => `“${esc(k)}”`).join(', ') : 'empty'}</span></div></div></div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
