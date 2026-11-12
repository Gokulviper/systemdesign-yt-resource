/*
 * Shared helpers for the video-platform labs. Nothing here touches the DOM at
 * load time, so scenarios stay testable in Node; the UI helpers only run in
 * the browser when a product mock mounts.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = (SDL.yt = {});

  Y.num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n).toLocaleString('en-US'));
  Y.money = (v) => '$' + Number(v).toFixed(2);

  /** Set several ledger layers at once: { displayed: ['yes', 'note'], committed: 'yes' }. */
  Y.L = (ctx, layers) => {
    for (const [k, v] of Object.entries(layers)) Array.isArray(v) ? ctx.ledger(k, v[0], v[1], v[2]) : ctx.ledger(k, v);
  };
  /** Standard ledger for a failed action: nothing accepted or committed unless already proven. */
  Y.failed = (ctx, note) => {
    ctx.ledger('displayed', 'no', note);
    ctx.ledger('accepted', 'no', null, { ifPending: true });
    ctx.ledger('committed', 'no', null, { ifPending: true });
    ctx.ledger('async', 'n/a', null, { ifPending: true });
  };

  /** Switches backed by state.config[id]. Each item: [id, label, desc, onSet?]. */
  Y.switches = (list) => list.map(([id, label, desc, onSet]) => ({
    id, label, desc,
    get: (s) => !!s.state.config[id],
    set: (s, on) => { s.state.config[id] = on; if (onSet) onSet(s, on); },
  }));
  /** Presets that restore everything and set switches to defaults (plus overrides) before running. */
  Y.presets = (defaults, list) => list.map((p) => ({
    id: p.id, label: p.label, desc: p.desc,
    run(sim) {
      sim.restoreAll();
      for (const [id, on] of Object.entries(Object.assign({}, defaults, p.sw || {}))) sim.do('setSwitch', { id, on });
      p.run(sim);
    },
  }));

  /** A queue consumer with optional deduplication by msg.eventId. */
  Y.consumer = (sim, queue, group, self, handle, dedupe) => {
    sim.spawn(function* (ctx) {
      for (;;) {
        const { msg } = yield ctx.take(queue, group);
        const st = ctx.state;
        st.processed = st.processed || {};
        const seen = (st.processed[group] = st.processed[group] || {});
        if (dedupe && dedupe(ctx.sim) && msg.eventId && seen[msg.eventId]) {
          st.dupSkipped = (st.dupSkipped || 0) + 1;
          ctx.log({ op: `duplicate ${msg.eventId} skipped`, status: 'dup', actionId: msg.actionId, detail: `${sim.nodes[self].label} already processed ${msg.eventId}.` });
          ctx.ack(queue, group);
          continue;
        }
        const ok = yield* handle(ctx, msg);
        if (ok === false) { ctx.nack(queue, group); yield ctx.wait(300); continue; }
        if (msg.eventId) seen[msg.eventId] = true;
        ctx.ack(queue, group);
      }
    }, { self });
  };
  /** Outbox relay: move messages from one queue to another, in batches like a polling relay. */
  Y.relay = (sim, from, group, self, to) => {
    sim.spawn(function* (ctx) {
      for (;;) {
        const { msgs } = yield ctx.take(from, group, 200);
        for (const msg of msgs) ctx.sim.enqueue(to, { type: msg.type, eventId: msg.eventId, payload: msg.payload, actionId: msg.actionId });
        ctx.ack(from, group);
      }
    }, { self });
  };
  /** Background load: calls fn(ctx, i) at `rate` per second while rate(sim) > 0. */
  Y.load = (sim, self, rate, fn) => {
    sim.spawn(function* (ctx) {
      let acc = 0;
      let i = 0;
      for (;;) {
        yield ctx.wait(50);
        acc += rate(ctx.sim) * 0.05;
        while (acc >= 1) { acc -= 1; const n = ++i; ctx.spawn((c) => fn(c, n), { quiet: 'all' }); }
      }
    }, { self, quiet: 'all' });
  };

  /**
   * Plain-text operational transformation for the collaborative-editing labs.
   * An op is { pos, ins } or { pos, del }. transform(op, prior, opFirst) rewrites
   * op so it means the same thing after prior has been applied; opFirst decides
   * who wins when two inserts land on the same position.
   */
  Y.ot = {
    apply(text, op) {
      const pos = Math.max(0, Math.min(op.pos, text.length));
      let t = text;
      if (op.del) t = t.slice(0, pos) + t.slice(pos + op.del);
      if (op.ins) t = t.slice(0, pos) + op.ins + t.slice(pos);
      if (op.then) t = Y.ot.apply(t, op.then);
      return t;
    },
    transform(op, prior, opFirst) {
      const o = Object.assign({}, op);
      if (prior.del) {
        const ps = prior.pos, pe = prior.pos + prior.del;
        if (o.del) {
          const os = o.pos, oe = o.pos + o.del;
          if (pe <= os) o.pos -= prior.del;
          else if (ps < oe) { o.pos = Math.min(os, ps); o.del = Math.max(0, ps - os) + Math.max(0, oe - pe); }
        } else if (pe <= o.pos) o.pos -= prior.del;
        else if (ps < o.pos) o.pos = ps;
      }
      if (prior.ins) {
        const n = prior.ins.length;
        if (prior.pos < o.pos || (prior.pos === o.pos && !opFirst)) o.pos += n;
        else if (o.del && prior.pos > o.pos && prior.pos < o.pos + o.del) {
          // The other side typed inside the range being deleted: delete around their text, keep it.
          const right = o.pos + o.del - prior.pos;
          o.del = prior.pos - o.pos;
          o.then = { pos: o.pos + n, del: right }; // after deleting the left part their text starts at o.pos
        }
      }
      return o;
    },
  };

  /**
   * A price-time order book for the exchange labs. Pure and deterministic: the
   * matching engine labs call match() from a handler and record what it returns.
   * Orders: { id, owner, side: 'buy'|'sell', px (number, null = market), qty, tif: 'gtc'|'ioc'|'fok', seq }.
   * match() returns { status: 'filled'|'partial'|'resting'|'cancelled'|'rejected', fills, remaining, stp, reason }.
   * Options: { prorata, stp, collar: { ref, pct } }.
   */
  Y.book = {
    create: () => ({ bids: [], asks: [], byId: {} }),
    best: (b) => ({ bid: b.bids.length ? b.bids[0].px : null, ask: b.asks.length ? b.asks[0].px : null }),
    /** Aggregated levels for one side, best first: [{ px, qty, n }]. */
    levels(b, side, n) {
      const out = [];
      for (const o of side === 'buy' ? b.bids : b.asks) {
        const last = out[out.length - 1];
        if (last && last.px === o.px) { last.qty += o.remaining; last.n++; } else out.push({ px: o.px, qty: o.remaining, n: 1 });
      }
      return n ? out.slice(0, n) : out;
    },
    remove(b, id) {
      const o = b.byId[id];
      if (!o) return null;
      const arr = o.side === 'buy' ? b.bids : b.asks;
      const i = arr.indexOf(o);
      if (i >= 0) arr.splice(i, 1);
      delete b.byId[id];
      return o;
    },
    rest(b, o) {
      const arr = o.side === 'buy' ? b.bids : b.asks;
      let i = 0;
      while (i < arr.length && (o.side === 'buy' ? arr[i].px >= o.px : arr[i].px <= o.px)) i++;
      arr.splice(i, 0, o);
      b.byId[o.id] = o;
    },
    match(b, order, opts) {
      opts = opts || {};
      const o = Object.assign({ tif: 'gtc' }, order, { remaining: order.qty });
      const opp = o.side === 'buy' ? b.asks : b.bids;
      const crosses = (px) => o.px == null || (o.side === 'buy' ? px <= o.px : px >= o.px);
      const fills = [];
      const stp = [];
      let reason = '';
      if (o.tif === 'fok') {
        let avail = 0;
        for (const m of opp) { if (!crosses(m.px)) break; if (opts.stp && m.owner === o.owner) continue; avail += m.remaining; }
        if (avail < o.qty) return { status: 'cancelled', fills, remaining: o.qty, stp, reason: `fill-or-kill: only ${avail} available at the limit` };
      }
      while (o.remaining > 0 && opp.length && crosses(opp[0].px)) {
        const px = opp[0].px;
        if (opts.collar && Math.abs(px - opts.collar.ref) > opts.collar.ref * opts.collar.pct) { reason = `price collar: ${px} is more than ${Math.round(opts.collar.pct * 100)}% from ${opts.collar.ref}`; break; }
        const level = opp.filter((m) => m.px === px);
        if (opts.stp) {
          const mine = level.filter((m) => m.owner === o.owner);
          if (mine.length) { for (const m of mine) { Y.book.remove(b, m.id); stp.push(m.id); } if (mine.length === level.length) continue; }
        }
        const avail = level.filter((m) => !stp.includes(m.id));
        if (opts.prorata && avail.length > 1) {
          const total = avail.reduce((s, m) => s + m.remaining, 0);
          const take = Math.min(o.remaining, total);
          let left = take;
          const alloc = avail.map((m) => Math.floor((take * m.remaining) / total));
          alloc.forEach((q) => { left -= q; });
          for (let i = 0; left > 0 && i < avail.length; i++) { const extra = Math.min(left, avail[i].remaining - alloc[i]); alloc[i] += extra; left -= extra; }
          avail.forEach((m, i) => { if (alloc[i] > 0) fills.push(fill(m, o, alloc[i])); });
          for (const m of avail) if (m.remaining === 0) Y.book.remove(b, m.id);
        } else {
          const m = avail[0];
          fills.push(fill(m, o, Math.min(o.remaining, m.remaining)));
          if (m.remaining === 0) Y.book.remove(b, m.id);
        }
      }
      let status;
      if (o.remaining === 0) status = 'filled';
      else if (o.px != null && o.tif === 'gtc' && !reason) { Y.book.rest(b, o); status = fills.length ? 'partial' : 'resting'; }
      else { status = fills.length ? 'partial' : 'cancelled'; if (!reason) reason = o.px == null ? 'market order: no more liquidity' : o.tif === 'ioc' ? 'immediate-or-cancel: rest cancelled' : 'nothing to match'; }
      return { status, fills, remaining: o.remaining, stp, reason };
      function fill(m, t, qty) { m.remaining -= qty; t.remaining -= qty; return { makerId: m.id, makerOwner: m.owner, takerId: t.id, takerOwner: t.owner, side: t.side, px: m.px, qty }; }
    },
  };

  /**
   * Consistent hashing for the key-value store labs. Deterministic FNV-1a hash,
   * a ring of tokens (virtual nodes), and preference lists. Positions are in [0, 1).
   */
  Y.ring = {
    hash(str) { return Y.ring.hashInt(str) / 4294967296; },
    /** The 32-bit integer behind hash(): modulo placement uses it directly. */
    hashInt(str) {
      let h = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      // Final avalanche so short, similar strings spread over the whole ring.
      h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
      return h >>> 0;
    },
    create(nodes, vnodes) {
      const r = { tokens: [], vnodes: vnodes || 1 };
      for (const n of nodes) Y.ring.add(r, n);
      return r;
    },
    add(r, node) {
      for (let i = 0; i < r.vnodes; i++) r.tokens.push({ pos: Y.ring.hash(`${node}#${i}`), node });
      r.tokens.sort((a, b) => a.pos - b.pos || (a.node < b.node ? -1 : 1));
    },
    remove(r, node) { r.tokens = r.tokens.filter((t) => t.node !== node); },
    nodes(r) { return Array.from(new Set(r.tokens.map((t) => t.node))); },
    /** The first n distinct nodes clockwise from a position. */
    ownersAt(r, pos, n) {
      const out = [];
      if (!r.tokens.length) return out;
      let i = r.tokens.findIndex((t) => t.pos >= pos);
      if (i < 0) i = 0;
      for (let k = 0; k < r.tokens.length && out.length < n; k++) {
        const t = r.tokens[(i + k) % r.tokens.length];
        if (!out.includes(t.node)) out.push(t.node);
      }
      return out;
    },
    owners(r, key, n) { return Y.ring.ownersAt(r, Y.ring.hash(key), n); },
    /** Modulo placement for comparison: hash(key) mod node count. */
    modulo(nodes, key, n) {
      const sorted = nodes.slice().sort();
      const i = Y.ring.hashInt(key) % sorted.length;
      const out = [];
      for (let k = 0; k < sorted.length && out.length < n; k++) out.push(sorted[(i + k) % sorted.length]);
      return out;
    },
    /** How many of `keys` each node coordinates (first owner). */
    distribution(r, keys) {
      const d = {};
      for (const n of Y.ring.nodes(r)) d[n] = 0;
      for (const k of keys) { const o = Y.ring.owners(r, k, 1)[0]; if (o) d[o]++; }
      return d;
    },
  };

  /** Vector clocks: { nodeId: counter }. */
  Y.vclock = {
    inc(vc, node) { const c = Object.assign({}, vc || {}); c[node] = (c[node] || 0) + 1; return c; },
    /** 'eq' | 'before' (a < b) | 'after' (a > b) | 'concurrent'. */
    compare(a, b) {
      a = a || {}; b = b || {};
      let less = false, more = false;
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const x = a[k] || 0, y = b[k] || 0;
        if (x < y) less = true; else if (x > y) more = true;
      }
      if (less && more) return 'concurrent';
      if (less) return 'before';
      if (more) return 'after';
      return 'eq';
    },
    merge(a, b) { const c = Object.assign({}, a || {}); for (const [k, v] of Object.entries(b || {})) c[k] = Math.max(c[k] || 0, v); return c; },
    /** Drop every version dominated by another; what remains are siblings. Versions: [{ clock, ... }]. */
    siblings(versions) {
      return versions.filter((v, i) => !versions.some((w, j) => j !== i && (Y.vclock.compare(v.clock, w.clock) === 'before' || (Y.vclock.compare(v.clock, w.clock) === 'eq' && j < i))));
    },
    fmt(vc) { return Object.entries(vc || {}).map(([k, v]) => `${k}:${v}`).join(' ') || '∅'; },
  };

  /**
   * Replica-side versioning for the key-value store labs. A replica holds, per key,
   * a list of versions { items, clock, ts, ... }. With vector clocks the list may hold
   * several concurrent versions (siblings); with last-writer-wins it holds one.
   */
  Y.kv = {
    union(lists) { const out = []; for (const l of lists) for (const it of l) if (!out.includes(it)) out.push(it); return out; },
    /**
     * Apply a write to one replica's versions. context = the clock the writer had read.
     * Returns { versions, siblings, lost }: lost = items a last-writer-wins overwrite discarded.
     */
    applyWrite(cur, incoming, context, vclock) {
      cur = cur || [];
      if (!vclock) {
        const latest = cur[0];
        // Later timestamp wins; an exact tie is broken by the writer id so every replica picks the same version.
        const older = latest && (latest.ts > incoming.ts || (latest.ts === incoming.ts && String(latest.by || '') > String(incoming.by || '')));
        if (older) return { versions: cur, siblings: 1, lost: incoming.items.filter((it) => !latest.items.includes(it)), kept: 'old' };
        const lost = latest ? latest.items.filter((it) => !incoming.items.includes(it)) : [];
        return { versions: [incoming], siblings: 1, lost, kept: 'new' };
      }
      // Drop every stored version the writer had seen (its context dominates); keep the rest as siblings.
      const keep = cur.filter((v) => { const c = Y.vclock.compare(v.clock, context || {}); return !(c === 'before' || c === 'eq'); });
      const versions = Y.vclock.siblings(keep.concat([incoming]));
      return { versions, siblings: versions.length, lost: [], kept: 'new' };
    },
    /** Reconcile versions gathered from several replicas into one value (carts merge by union). */
    reconcile(versions, vclock) {
      if (!versions.length) return { items: [], tombs: [], clock: {}, ts: 0, siblings: 0 };
      if (!vclock) { const latest = versions.slice().sort((a, b) => b.ts - a.ts || (String(b.by || '') > String(a.by || '') ? 1 : -1))[0]; return { items: latest.items, tombs: latest.tombs || [], clock: {}, ts: latest.ts, siblings: 1 }; }
      // Siblings merge by union; a tombstone (removed item) in any sibling wins over a concurrent add.
      const sib = Y.vclock.siblings(versions);
      const tombs = Y.kv.union(sib.map((v) => v.tombs || []));
      return { items: Y.kv.union(sib.map((v) => v.items)).filter((it) => !tombs.includes(it)), tombs, clock: sib.reduce((c, v) => Y.vclock.merge(c, v.clock), {}), ts: Math.max(...sib.map((v) => v.ts)), siblings: sib.length };
    },
  };

  /* ---------------- browser-only UI helpers ---------------- */
  /** Mount phones (and optional extra HTML) and wire data-act / data-field controls to sim.dispatch. */
  Y.mount = (el, sim, phones, opts) => {
    opts = opts || {};
    const P = SDL.ui.phone;
    const ph = phones.map(([id, title]) => P.frame(id, title)).join('');
    el.innerHTML = `${opts.note ? `<p class="panel-note phones-note">${opts.note}</p>` : ''}
      ${opts.side ? `<div class="hk-wrap">${ph}<div class="ops-console">${opts.side}</div></div>` : `<div class="phones">${ph}</div>`}
      ${opts.below || ''}`;
    el.querySelectorAll('.phone').forEach((p) => P.wire(p));
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      sim.dispatch(b.dataset.act, b.dataset.arg ? JSON.parse(b.dataset.arg) : {});
    });
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.field) sim.dispatch('set', { field: t.dataset.field, value: t.type === 'checkbox' ? t.checked : t.value });
    });
  };
  /** Paint one phone. */
  Y.paint = (el, sim, id, sections, live, banner) => {
    const ph = el.querySelector(`[data-phone="${id}"]`);
    SDL.ui.phone.render(ph, sim, id, banner || null, !!sim.nodes[id].modes.down);
    SDL.ui.phone.paint(ph, sections, live || {});
  };
  /** Generic 'set' action: field is a dotted path into sim.ui, e.g. "viewer.mode". */
  Y.setAction = (sim, a) => {
    const parts = a.field.split('.');
    let o = sim.ui;
    while (parts.length > 1) o = o[parts.shift()];
    o[parts[0]] = a.value;
  };
  /** A video thumbnail block for phone screens. */
  Y.video = (title, channel, meta, hue) => `
    <div class="yt-video"><div class="yt-thumb" style="--h:${hue == null ? 350 : hue}"><span aria-hidden="true">▶</span></div>
    <p class="yt-title">${SDL.ui.esc(title)}</p><p class="app-sub">${SDL.ui.esc(channel)}${meta ? `, ${SDL.ui.esc(meta)}` : ''}</p></div>`;
  Y.btn = (act, label, opts) => {
    opts = opts || {};
    return `<button class="app-btn ${opts.cls || ''}" data-act="${act}"${opts.arg ? ` data-arg='${JSON.stringify(opts.arg)}'` : ''}${opts.disabled ? ' disabled' : ''}>${label}</button>`;
  };
  Y.msg = (text, tone) => (text ? `<p class="app-msg" data-tone="${tone || ''}">${SDL.ui.esc(text)}</p>` : '');
})(typeof window !== 'undefined' ? window : globalThis);
