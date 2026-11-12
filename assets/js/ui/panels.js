/* Lab panels. Each panel is a pure rendering of the Simulator and sends
   every change back through sim.dispatch or the controller, never by
   mutating state directly. Panels skip work when their inputs are unchanged. */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;
  const esc = ui.esc;
  const P = (ui.panels = {});
  const SVGNS = 'http://www.w3.org/2000/svg';

  const svg = (tag, attrs, parent) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  };
  const nodeLabel = (sim, id) => (id === 'system' ? 'Simulator' : sim.nodes[id] ? sim.nodes[id].label : id);
  const fmtT = (t) => `T+${Math.round(t).toLocaleString('en-US')} ms`;
  const json = (v) => {
    if (v === undefined) return '';
    const s = JSON.stringify(v, null, 2);
    return s.length > 1200 ? s.slice(0, 1200) + '\n…' : s;
  };

  const STATUS_ICON = { healthy: '●', processing: '◐', degraded: '▲', failed: '✕', recovering: '↻' };
  const STATUS_NAME = { healthy: 'Healthy', processing: 'Processing', degraded: 'Degraded', failed: 'Failed', recovering: 'Recovering' };
  const EVENT_STATUS = {
    ok: ['Success', 'ok'], err: ['Error', 'fail'], timeout: ['Timeout', 'fail'], retry: ['Retry', 'warn'],
    fault: ['Failure injected', 'fail'], recovered: ['Restored', 'recover'], start: ['User action', 'work'],
    note: ['Note', 'muted'], recv: ['Received', 'work'], lost: ['Reply lost', 'warn'], dup: ['Duplicate', 'msg'], hang: ['No reply', 'fail'],
  };
  const LEDGER_TEXT = {
    yes: ['✓ Yes', 'ok'], no: ['✕ No', 'fail'], pending: ['… Pending', 'work'], unknown: ['? Unknown', 'warn'], 'n/a': ['– Not needed', 'muted'],
  };
  const chip = (text, tone) => `<span class="chip chip-${tone}">${esc(text)}</span>`;
  /** Re-render el.innerHTML without losing keyboard focus on an element identified by attr. */
  function keepFocus(el, attr, fn) {
    const a = document.activeElement;
    const val = a && el.contains(a) ? a.getAttribute(attr) : null;
    fn();
    if (val != null) {
      const again = el.querySelector(`[${attr}="${val}"]`);
      if (again) again.focus();
    }
  }

  /* ---------- playback ---------- */
  P.Playback = class {
    constructor(el, sim, ctl) {
      this.el = el;
      el.innerHTML = `
        <div class="pb-group">
          <button class="btn btn-primary" data-pb="toggle" aria-pressed="true">Pause</button>
          <button class="btn" data-pb="step" title="Run the next simulated event">Step</button>
          <label class="pb-speed">Speed
            <select data-pb="speed">
              <option value="0.02">Very slow (0.02×)</option>
              <option value="0.05">Slow (0.05×)</option>
              <option value="0.1">Relaxed (0.1×)</option>
              <option value="0.2">Normal (0.2×)</option>
              <option value="0.5">Fast (0.5×)</option>
              <option value="1">Real time (1×)</option>
            </select>
          </label>
        </div>
        <div class="pb-group">
          <button class="btn" data-pb="replay">Replay</button>
          <button class="btn" data-pb="reset">Reset</button>
        </div>
        <div class="pb-group pb-readout">
          <span class="pb-clock" data-ref="clock">T+0 ms</span>
          <span class="pb-state" data-ref="state"></span>
        </div>
        <div class="pb-group pb-end">
          <label class="check"><input type="checkbox" data-pb="motion"> Animate packets</label>
          <span class="pb-keys">Keys: P to play or pause, full stop to step</span>
        </div>
        <p class="sr-only" role="status" aria-live="polite" data-ref="announce"></p>`;
      const q = (s) => el.querySelector(s);
      this.toggle = q('[data-pb="toggle"]');
      this.replayBtn = q('[data-pb="replay"]');
      this.clock = q('[data-ref="clock"]');
      this.state = q('[data-ref="state"]');
      this.announce = q('[data-ref="announce"]');
      this.motion = q('[data-pb="motion"]');
      this.motion.checked = !ctl.reducedMotion;
      this.toggle.addEventListener('click', () => ctl.toggle());
      q('[data-pb="step"]').addEventListener('click', () => {
        const ran = ctl.step();
        this.say(ran ? `Ran one event. Clock at ${fmtT(sim.now)}.` : 'Nothing is waiting to run. Act in the product first.');
      });
      const speedSel = q('[data-pb="speed"]');
      speedSel.value = String(ctl.speed);
      speedSel.addEventListener('change', (e) => {
        ctl.speed = Number(e.target.value);
        try { localStorage.setItem('sdl-speed', e.target.value); } catch (err) { /* storage unavailable */ }
      });
      q('[data-pb="reset"]').addEventListener('click', () => {
        ctl.reset();
        this.say('Reset. Every component is healthy and all data is back to its starting values.');
      });
      this.replayBtn.addEventListener('click', () => {
        const n = ctl.replay();
        this.say(`Replaying ${n} recorded action${n === 1 ? '' : 's'} from the start.`);
      });
      this.motion.addEventListener('change', () => {
        document.documentElement.classList.toggle('reduce-motion', !this.motion.checked);
      });
    }
    say(t) {
      this.announce.textContent = t;
    }
    render(sim, ctl) {
      this.clock.textContent = fmtT(sim.now);
      const busy = sim.hasWork();
      const label = !ctl.playing ? 'Paused' : busy ? 'Running' : 'Idle, waiting for you';
      if (this.state.textContent !== label) this.state.textContent = label;
      this.state.dataset.tone = !ctl.playing ? 'warn' : busy ? 'work' : 'muted';
      this.toggle.textContent = ctl.playing ? 'Pause' : 'Play';
      this.toggle.setAttribute('aria-pressed', String(ctl.playing));
      this.replayBtn.disabled = sim.actionLog.length === 0;
      document.documentElement.classList.toggle('sim-paused', !ctl.playing);
    }
  };

  /* ---------- product mock ---------- */
  P.Product = class {
    constructor(el, sim, ctl, product) {
      this.el = el;
      this.product = product;
      this.rev = -1;
      product.mount(el, sim, ctl);
    }
    render(sim, ctl) {
      if (sim.revision === this.rev) return;
      this.rev = sim.revision;
      this.product.render(this.el, sim, ctl);
    }
  };

  /* ---------- outcome ledger ---------- */
  P.Ledger = class {
    constructor(el, sim, ctl) {
      this.el = el;
      this.key = '';
      this.selected = null;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-action]');
        if (!b) return;
        this.selected = b.dataset.action;
        this.key = '';
        ctl.changed();
      });
    }
    render(sim) {
      const key = `${sim.resetCount}:${sim.ledgerRev}:${this.selected}`;
      if (key === this.key) return;
      this.key = key;
      const rows = sim.ledger.slice(-3).reverse();
      if (!rows.length) {
        this.el.innerHTML = '<p class="empty">Each action you take gets a row here showing what the user saw versus what the system actually did.</p>';
        return;
      }
      if (!rows.some((r) => r.id === this.selected)) this.selected = rows[0].id;
      const head = SDL.LEDGER_LAYERS.slice(1).map(([, l]) => `<th scope="col">${esc(l)}</th>`).join('');
      const body = rows
        .map((r) => {
          const cells = SDL.LEDGER_LAYERS.slice(1)
            .map(([k]) => {
              const [t, tone] = LEDGER_TEXT[r.layers[k]] || [r.layers[k], 'muted'];
              return `<td>${chip(t, tone)}</td>`;
            })
            .join('');
          return `<tr class="${r.id === this.selected ? 'is-selected' : ''}"><th scope="row"><button class="link-btn" data-action="${r.id}" aria-pressed="${r.id === this.selected}">${esc(r.label)}<span class="ledger-t">${fmtT(r.t)}</span></button></th>${cells}</tr>`;
        })
        .join('');
      const sel = rows.find((r) => r.id === this.selected);
      const notes = SDL.LEDGER_LAYERS.filter(([k]) => sel.notes[k])
        .map(([k, l]) => `<li><strong>${esc(l)}:</strong> ${esc(sel.notes[k])}</li>`)
        .join('');
      keepFocus(this.el, 'data-action', () => (this.el.innerHTML = `
        <div class="table-scroll"><table class="ledger">
          <thead><tr><th scope="col">Action</th>${head}</tr></thead><tbody>${body}</tbody>
        </table></div>
        ${notes ? `<ul class="ledger-notes" aria-label="Why, for ${esc(sel.label)}">${notes}</ul>` : ''}`));
    }
  };

  /* ---------- architecture diagram with request flow ---------- */
  const KIND_NAME = { client: 'Client', gateway: 'Gateway', service: 'Service', db: 'Database', queue: 'Queue', worker: 'Worker', cache: 'Cache', cdn: 'CDN', store: 'Object store' };
  const KIND_ICON = {
    client: '<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M1.5 5.5h13"/><circle cx="3.6" cy="4" r=".4"/>',
    gateway: '<path d="M8 1.5l5.5 2.2v4.1c0 3.2-2.4 5.6-5.5 6.7-3.1-1.1-5.5-3.5-5.5-6.7V3.7z"/><path d="M5.6 8l1.7 1.7 3.2-3.4"/>',
    service: '<path d="M8 1.5l5.6 3.2v6.6L8 14.5l-5.6-3.2V4.7z"/><circle cx="8" cy="8" r="2.2"/>',
    db: '<ellipse cx="8" cy="3.6" rx="5.5" ry="2.1"/><path d="M2.5 3.6v8.8c0 1.2 2.5 2.1 5.5 2.1s5.5-.9 5.5-2.1V3.6M2.5 8c0 1.2 2.5 2.1 5.5 2.1s5.5-.9 5.5-2.1"/>',
    queue: '<rect x="1.5" y="3" width="3.6" height="10" rx="1"/><rect x="6.2" y="3" width="3.6" height="10" rx="1"/><rect x="10.9" y="3" width="3.6" height="10" rx="1"/>',
    worker: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.4 3.4l1.6 1.6M11 11l1.6 1.6M3.4 12.6L5 11M11 5l1.6-1.6"/>',
    cache: '<path d="M9.2 1.5L3.5 9h4.2l-1 5.5L12.5 7H8.3z"/>',
    cdn: '<circle cx="8" cy="8" r="6.3"/><ellipse cx="8" cy="8" rx="2.6" ry="6.3"/><path d="M1.7 8h12.6"/>',
    store: '<path d="M2 4.5h12l-1.2 9.5H3.2z"/><path d="M1.5 2.5h13v2h-13z"/>',
  };
  const GLYPH = { ok: '✓', err: '✕', msg: '◆', lost: '?' };
  const TONE_TEXT = { ok: 'ok', err: 'fail', fail: 'fail', warn: 'warn', work: 'work', msg: 'msg', recover: 'recover', muted: 'muted' };

  function describe(sim, e) {
    const n = nodeLabel(sim, e.node);
    const f = e.from ? nodeLabel(sim, e.from) : null;
    const op = String(e.op).replace(/^receive /, '');
    if (e.status === 'recv') return f ? `${n} received “${op}” from ${f}.` : `${n} received “${op}”.`;
    if (e.status === 'ok' && e.durationMs != null) return `${n} finished “${op}” in ${ui.fmtMs(e.durationMs)}${f ? ` and is replying to ${f}` : ''}.`;
    if (e.status === 'err' && !e.from && e.detail) return e.detail;
    if (e.status === 'err') return `${n} failed “${op}” with ${e.error ? e.error.code : 'an error'}${f ? `. ${f} gets the error back` : ''}.`;
    if (e.status === 'start') return e.detail || `User action: ${op}.`;
    return e.detail || `${n}: ${op}.`;
  }

  P.Diagram = class {
    constructor(el, sim, ctl) {
      this.el = el;
      this.sim = sim;
      this.ctl = ctl;
      this.built = -1;
      this.pkEls = new Map();
      this.rpEls = new Map();
      this.nowKey = '';
      const kinds = [...new Set(sim.scenario.topology.nodes.map((n) => n.kind || 'service'))];
      el.innerHTML = `
        <div class="now-bar" aria-live="polite"><span class="now-dot" aria-hidden="true"></span><span class="now-time" data-ref="nowTime">T+0 ms</span><span class="now-text" data-ref="nowText">Waiting for your first action.</span></div>
        <div class="diagram-scroll"></div>
        <div class="legend" aria-label="Legend">
          <div class="legend-row"><span class="legend-head">Components</span>
            ${kinds.map((k) => `<span class="legend-item kind-${k}"><svg viewBox="0 0 16 16" width="16" height="16" class="kind-icon" aria-hidden="true">${KIND_ICON[k] || KIND_ICON.service}</svg>${KIND_NAME[k] || k}</span>`).join('')}
          </div>
          <div class="legend-row"><span class="legend-head">Traffic</span>
            <span class="legend-item"><i class="lg lg-req"></i>Request</span>
            <span class="legend-item"><i class="lg lg-ok">✓</i>Success reply</span>
            <span class="legend-item"><i class="lg lg-err">✕</i>Error reply</span>
            <span class="legend-item"><i class="lg lg-msg">◆</i>Event</span>
            <span class="legend-item"><i class="lg lg-lost">?</i>Lost reply</span>
          </div>
          <div class="legend-row"><span class="legend-head">States</span>
            ${Object.keys(STATUS_ICON).map((k) => `<span class="legend-item pill-${k}"><b aria-hidden="true">${STATUS_ICON[k]}</b>${STATUS_NAME[k]}</span>`).join('')}
          </div>
        </div>`;
      this.wrap = el.querySelector('.diagram-scroll');
      this.nowTime = el.querySelector('[data-ref="nowTime"]');
      this.nowText = el.querySelector('[data-ref="nowText"]');
      this.nowBar = el.querySelector('.now-bar');
    }
    build(sim) {
      this.built = sim.resetCount;
      this._paths = {};
      this.pkEls.clear();
      this.rpEls.clear();
      const topo = sim.scenario.topology;
      this.geo = {};
      for (const n of topo.nodes) this.geo[n.id] = { x: n.x, y: n.y, w: n.w || 164, h: n.h || 76 };
      this.wrap.innerHTML = '';
      const s = svg('svg', { class: 'diagram', viewBox: `0 0 ${topo.width} ${topo.height}`, role: 'group', 'aria-label': 'Live architecture diagram' }, this.wrap);
      const defs = svg('defs', {}, s);
      defs.innerHTML = `
        <pattern id="hatch-fail" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="8" class="hatch-fail"/></pattern>
        <pattern id="hatch-warn" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="8" class="hatch-warn"/></pattern>
        <filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="3.2"/></filter>`;
      this.gEdges = svg('g', { class: 'edges' }, s);
      this.gRipples = svg('g', { class: 'ripples', 'aria-hidden': 'true' }, s);
      this.gNodes = svg('g', { class: 'nodes' }, s);
      this.gPackets = svg('g', { class: 'packets', 'aria-hidden': 'true' }, s);
      this.edgeEls = sim.edges.map((e) => {
        const pts = this.path(e.from, e.to);
        const g = svg('g', { class: 'edge' }, this.gEdges);
        const ptsAttr = pts.map((q) => q.join(',')).join(' ');
        svg('polyline', { points: ptsAttr, class: 'edge-line' }, g);
        svg('polyline', { points: ptsAttr, class: 'edge-flow' }, g);
        if (e.label) {
          // label sits on the longest segment
          let best = 0;
          for (let i = 1; i < pts.length - 1; i++) if (Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) > Math.hypot(pts[best + 1][0] - pts[best][0], pts[best + 1][1] - pts[best][1])) best = i;
          const mx = (pts[best][0] + pts[best + 1][0]) / 2;
          const my = (pts[best][1] + pts[best + 1][1]) / 2;
          const w = e.label.length * 6.1 + 14;
          svg('rect', { x: mx - w / 2, y: my - 9, width: w, height: 18, rx: 9, class: 'edge-tag' }, g);
          const t = svg('text', { x: mx, y: my + 4, class: 'edge-label', 'text-anchor': 'middle' }, g);
          t.textContent = e.label;
        }
        return { e, g };
      });
      this.nodeEls = {};
      for (const n of topo.nodes) this.nodeEls[n.id] = this.buildNode(n);
    }
    buildNode(n) {
      const G = this.geo[n.id];
      const kind = n.kind || 'service';
      const x0 = G.x - G.w / 2;
      const y0 = G.y - G.h / 2;
      const r = 11;
      const band = 22;
      const g = svg('g', { class: `node kind-${kind}`, tabindex: '0', role: 'button', 'data-id': n.id }, this.gNodes);
      const inner = svg('g', { class: 'node-body' }, g);
      inner.style.transformOrigin = `${G.x}px ${G.y}px`;
      svg('rect', { class: 'node-halo', x: x0 - 6, y: y0 - 6, width: G.w + 12, height: G.h + 12, rx: r + 5 }, inner);
      svg('rect', { class: 'node-shape', x: x0, y: y0, width: G.w, height: G.h, rx: r }, inner);
      svg('rect', { class: 'node-hatch', x: x0, y: y0, width: G.w, height: G.h, rx: r }, inner);
      svg('path', { class: 'node-band', d: `M${x0} ${y0 + band}V${y0 + r}Q${x0} ${y0} ${x0 + r} ${y0}H${x0 + G.w - r}Q${x0 + G.w} ${y0} ${x0 + G.w} ${y0 + r}V${y0 + band}Z` }, inner);
      const icon = svg('svg', { class: 'kind-icon', x: x0 + 8, y: y0 + 3, width: 16, height: 16, viewBox: '0 0 16 16' }, inner);
      icon.innerHTML = KIND_ICON[kind] || KIND_ICON.service;
      const kt = svg('text', { class: 'node-kind', x: x0 + 29, y: y0 + 15.5 }, inner);
      kt.textContent = KIND_NAME[kind] || kind;
      const label = svg('text', { class: 'node-label', x: G.x, y: y0 + 41, 'text-anchor': 'middle' }, inner);
      label.textContent = n.label;
      const sub = svg('text', { class: 'node-sub', x: G.x, y: y0 + 56, 'text-anchor': 'middle' }, inner);
      sub.textContent = n.sub || '';
      const pill = svg('rect', { class: 'node-pill', y: y0 + G.h - 10, height: 20, rx: 10 }, inner);
      const status = svg('text', { class: 'node-status', x: G.x, y: y0 + G.h + 4, 'text-anchor': 'middle' }, inner);
      let bars = null;
      if (n.queue) {
        bars = [];
        const bw = 12;
        const gap = 3;
        const startX = G.x - (8 * bw + 7 * gap) / 2;
        for (let i = 0; i < 8; i++) bars.push(svg('rect', { class: 'qbar', x: startX + i * (bw + gap), y: y0 + G.h + 16, width: bw, height: 7, rx: 2 }, inner));
      }
      const open = () => this.ctl.inspect(n.id);
      g.addEventListener('click', open);
      g.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open();
        }
      });
      return { g, status, pill, bars, G };
    }
    clip(A, B) {
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const hw = A.w / 2 + 7;
      const hh = A.h / 2 + 12;
      const s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
      return [A.x + dx * s, A.y + dy * s];
    }
    /** Points from node a to node b, following the edge's waypoints if it has any. */
    path(a, b) {
      const key = a + '>' + b;
      this._paths = this._paths || {};
      if (this._paths[key]) return this._paths[key];
      const e = this.sim.edgeBetween(a, b);
      let via = (e && e.via) || [];
      if (e && e.from !== a) via = via.slice().reverse();
      const A = this.geo[a];
      const B = this.geo[b];
      const first = via.length ? { x: via[0][0], y: via[0][1] } : B;
      const last = via.length ? { x: via[via.length - 1][0], y: via[via.length - 1][1] } : A;
      const pts = [this.clip(A, first), ...via, this.clip(B, last)];
      this._paths[key] = pts;
      return pts;
    }
    /** Point at fraction f of a polyline, with the direction of the segment it lies on. */
    pointAt(pts, f) {
      const lens = [];
      let total = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        lens.push(l);
        total += l;
      }
      let d = Math.max(0, Math.min(1, f)) * total;
      for (let i = 0; i < lens.length; i++) {
        if (d <= lens[i] || i === lens.length - 1) {
          const k = lens[i] ? d / lens[i] : 0;
          const dx = (pts[i + 1][0] - pts[i][0]) / (lens[i] || 1);
          const dy = (pts[i + 1][1] - pts[i][1]) / (lens[i] || 1);
          return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k, dx, dy, total };
        }
        d -= lens[i];
      }
      return { x: pts[0][0], y: pts[0][1], dx: 1, dy: 0, total };
    }
    toneOf(p) {
      if (p.kind === 'msg') return 'msg';
      if (p.kind === 'req') return p.status === 'timeout' ? 'err' : 'req';
      if (p.status === 'ok') return 'ok';
      if (p.status === 'lost' || p.status === 'late') return 'lost';
      return 'err';
    }
    renderNow(sim) {
      const tl = sim.timeline;
      const e = tl[tl.length - 1];
      const key = `${sim.resetCount}:${e ? e.id : 0}`;
      if (key === this.nowKey) return;
      this.nowKey = key;
      if (!e) {
        this.nowTime.textContent = 'T+0 ms';
        this.nowText.textContent = 'Waiting for your first action. Press a button in “Try it”.';
        this.nowBar.dataset.tone = 'muted';
        return;
      }
      const tone = (EVENT_STATUS[e.status] || [0, 'muted'])[1];
      this.nowTime.textContent = fmtT(e.t);
      this.nowText.textContent = describe(sim, e);
      this.nowBar.dataset.tone = TONE_TEXT[tone] || 'muted';
    }
    render(sim, ctl) {
      if (this.built !== sim.resetCount) this.build(sim);
      this.renderNow(sim);
      const now = sim.now;
      // which node was just hit by an arriving packet
      const hits = {};
      for (const p of sim.packets) {
        const after = now - p.t1;
        if (after >= 0 && after < 200 && p.status !== 'lost') hits[p.to] = this.toneOf(p);
      }
      // nodes
      for (const id in this.nodeEls) {
        const st = sim.nodeStatus(id);
        const ne = this.nodeEls[id];
        const cls = `node kind-${sim.nodes[id].kind || 'service'} st-${st.key}${hits[id] ? ' hit-' + hits[id] : ''}${ctl.selectedNode === id ? ' is-selected' : ''}`;
        if (ne.g.getAttribute('class') !== cls) ne.g.setAttribute('class', cls);
        const txt = `${STATUS_ICON[st.key]} ${st.label}`;
        if (ne.status.textContent !== txt) {
          ne.status.textContent = txt;
          const w = Math.max(70, txt.length * 6.4 + 20);
          ne.pill.setAttribute('x', ne.G.x - w / 2);
          ne.pill.setAttribute('width', w);
          ne.g.setAttribute('aria-label', `${sim.nodes[id].label}: ${st.label}. Open details.`);
        }
        if (ne.bars) {
          const depth = sim.queueStats(sim.nodes[id].queue).depth;
          ne.bars.forEach((b, i) => b.classList.toggle('on', i < Math.min(8, depth)));
        }
      }
      // edges
      for (const { e, g } of this.edgeEls) {
        const on = sim.packets.filter((p) => (p.from === e.from && p.to === e.to) || (p.from === e.to && p.to === e.from));
        const live = on.filter((p) => now >= p.t0 && now <= p.t1);
        const lead = live[live.length - 1];
        const bad = on.some((p) => ['err', 'timeout', 'lost'].includes(p.status) && now - p.t1 < 900);
        const dead = sim.nodeStatus(e.from).key === 'failed' || sim.nodeStatus(e.to).key === 'failed';
        let cls = 'edge';
        if (lead) cls += ` is-active flow-${lead.from === e.from ? 'fwd' : 'rev'} tone-${this.toneOf(lead)}`;
        if (bad) cls += ' is-bad';
        if (dead) cls += ' is-dead';
        if (g.getAttribute('class') !== cls) g.setAttribute('class', cls);
      }
      // packets and ripples
      const seen = new Set();
      const seenR = new Set();
      for (const p of sim.packets) {
        if (now < p.t0) continue;
        const span = p.t1 - p.t0;
        const f = Math.min(1, (now - p.t0) / span);
        const after = now - p.t1;
        const tone = this.toneOf(p);
        const pts = this.path(p.from, p.to);
        const b = pts[pts.length - 1];
        // ripple where the packet lands
        if (after >= 0 && after < 300 && p.status !== 'lost' && Number.isFinite(b[0]) && Number.isFinite(b[1])) {
          seenR.add(p.id);
          let rp = this.rpEls.get(p.id);
          if (!rp) {
            rp = svg('circle', { class: `ripple rp-${tone}`, cx: b[0], cy: b[1] }, this.gRipples);
            this.rpEls.set(p.id, rp);
          }
          const k = after / 300;
          rp.setAttribute('r', 7 + 18 * k);
          rp.style.opacity = String(1 - k);
        }
        if (after > 0) continue;
        if (p.status === 'lost' && f > 0.75) continue;
        seen.add(p.id);
        let el = this.pkEls.get(p.id);
        if (!el) {
          el = svg('g', { class: 'packet' }, this.gPackets);
          el._glow = svg('circle', { r: 13, class: 'packet-glow', filter: 'url(#glow)' }, el);
          el._trail = [0, 1, 2, 3].map((i) => svg('circle', { r: 6 - i * 1.2, class: 'packet-trail' }, el));
          el._dot = svg('circle', { r: 8.5, class: 'packet-dot' }, el);
          el._glyph = svg('text', { class: 'packet-glyph', 'text-anchor': 'middle' }, el);
          const tagText = p.status === 'lost' ? 'reply lost' : p.kind === 'res' ? '' : p.label;
          if (tagText) {
            el._tag = svg('g', { class: 'packet-tag' }, el);
            const w = tagText.length * 6.3 + 14;
            el._tagW = w;
            svg('rect', { width: w, height: 18, rx: 9, class: 'packet-tag-bg' }, el._tag);
            const t = svg('text', { class: 'packet-tag-text', x: w / 2, y: 12.5, 'text-anchor': 'middle' }, el._tag);
            t.textContent = tagText;
          }
          this.pkEls.set(p.id, el);
        }
        el.setAttribute('class', `packet pk-${tone}`);
        el._glyph.textContent = GLYPH[tone] || '';
        el.style.opacity = p.status === 'lost' && f > 0.55 ? String(Math.max(0, 1 - (f - 0.55) / 0.2)) : '1';
        const off = p.kind === 'res' ? -7 : 7;
        const at = (t) => {
          const q = this.pointAt(pts, t);
          return [q.x - q.dy * off, q.y + q.dx * off];
        };
        const len = this.pointAt(pts, 0).total || 1;
        const [x, y] = at(f);
        if (!Number.isFinite(x) || !Number.isFinite(y)) { seen.delete(p.id); continue; }
        el._glow.setAttribute('cx', x);
        el._glow.setAttribute('cy', y);
        el._dot.setAttribute('cx', x);
        el._dot.setAttribute('cy', y);
        el._glyph.setAttribute('x', x);
        el._glyph.setAttribute('y', y + 3.6);
        const step = Math.min(0.06, 22 / len);
        el._trail.forEach((c, i) => {
          const [tx, ty] = at(Math.max(0, f - step * (i + 1)));
          c.setAttribute('cx', tx);
          c.setAttribute('cy', ty);
          c.style.opacity = f - step * (i + 1) > 0 ? String(0.45 - i * 0.1) : '0';
        });
        if (el._tag) {
          el._tag.setAttribute('transform', `translate(${x - el._tagW / 2} ${y - 31})`);
          el._tag.style.display = (f > 0.12 && f < 0.88) || p.status === 'lost' ? '' : 'none';
        }
      }
      for (const [id, el] of this.pkEls) if (!seen.has(id)) { el.remove(); this.pkEls.delete(id); }
      for (const [id, el] of this.rpEls) if (!seenR.has(id)) { el.remove(); this.rpEls.delete(id); }
    }
  };

  /* ---------- what just happened ---------- */
  P.Explain = class {
    constructor(el) {
      this.el = el;
      this.key = '';
      el.innerHTML = `<div class="explain"><h3 class="subhead">What just happened</h3><p data-ref="text"></p><p class="consistency" data-ref="cons"></p><p class="active-faults" data-ref="faults"></p></div>`;
      this.text = el.querySelector('[data-ref="text"]');
      this.cons = el.querySelector('[data-ref="cons"]');
      this.faults = el.querySelector('[data-ref="faults"]');
    }
    render(sim) {
      const c = sim.scenario.consistency ? sim.scenario.consistency(sim) : null;
      const fs = sim.activeFailures();
      const faults = fs.length
        ? 'Active failures: ' + fs.map((f) => `${sim.nodes[f.node].label} (${(sim.scenario.modeLabels || {})[f.mode] || SDL.MODE_LABELS[f.mode] || f.mode})`).join(', ') + '.'
        : 'No failures injected.';
      const key = sim.explanation + '|' + (c && c.label) + '|' + faults;
      if (key === this.key) return;
      this.key = key;
      this.text.textContent = sim.explanation;
      if (c) {
        this.cons.innerHTML = `${chip({ ok: 'Consistent', stale: 'Stale', wrong: 'Incorrect' }[c.key] || c.key, { ok: 'ok', stale: 'warn', wrong: 'fail' }[c.key] || 'muted')} ${esc(c.label)}`;
      }
      this.faults.textContent = faults;
      this.faults.dataset.tone = fs.length ? 'fail' : '';
    }
  };

  /* ---------- failure injection ---------- */
  P.Failures = class {
    constructor(el, sim, ctl) {
      this.el = el;
      this.key = '';
      const sc = sim.scenario;
      const byNode = (id) => (sim.nodes[id] ? sim.nodes[id].label : id);
      el.innerHTML = `
        <label class="field">Each failure lasts
          <select data-ref="dur">
            <option value="">Until I restore it</option>
            <option value="2000">2 s of simulated time</option>
            <option value="5000">5 s of simulated time</option>
            <option value="10000">10 s of simulated time</option>
          </select>
        </label>
        <ul class="fault-list">
          ${(sc.failures || []).map((f) => `
            <li><label class="fault">
              <input type="checkbox" data-fid="${f.id}">
              <span class="fault-text"><span class="fault-title">${esc(f.label)}</span>
              <span class="fault-node">${esc(byNode(f.node))}</span>
              <span class="fault-desc">${esc(f.desc)}</span></span>
            </label></li>`).join('')}
        </ul>
        <button class="btn" data-ref="restoreAll">Restore everything</button>
        <p class="panel-note">Failures can be combined. Each change is recorded, so Replay reproduces it.</p>
        ${(sc.switches || []).length ? `<h3 class="subhead">Design switches</h3>
        <p class="panel-note">Turn a safeguard off to see what it protects against.</p>
        <ul class="fault-list switch-list">${sc.switches.map((w) => `
          <li><label class="fault switch">
            <input type="checkbox" data-sw="${w.id}">
            <span class="fault-text"><span class="fault-title">${esc(w.label)}</span>
            <span class="fault-desc">${esc(w.desc)}</span></span>
          </label></li>`).join('')}</ul>` : ''}`;
      const dur = el.querySelector('[data-ref="dur"]');
      el.querySelectorAll('[data-fid]').forEach((cb) =>
        cb.addEventListener('change', () => {
          const f = sc.failures.find((x) => x.id === cb.dataset.fid);
          if (cb.checked) sim.dispatch('inject', { node: f.node, mode: f.mode, params: f.params, duration: dur.value ? Number(dur.value) : undefined });
          else sim.dispatch('restore', { node: f.node, mode: f.mode });
          if (!ctl.playing) ctl.play();
        })
      );
      el.querySelector('[data-ref="restoreAll"]').addEventListener('click', () => sim.dispatch('restoreAll'));
      el.querySelectorAll('[data-sw]').forEach((cb) =>
        cb.addEventListener('change', () => sim.dispatch('setSwitch', { id: cb.dataset.sw, on: cb.checked }))
      );
      this.restoreBtn = el.querySelector('[data-ref="restoreAll"]');
    }
    render(sim) {
      const fs = sim.activeFailures();
      const sws = (sim.scenario.switches || []).map((w) => (w.get(sim) ? 1 : 0)).join('');
      const key = fs.map((f) => f.node + f.mode).join(',') + '|' + sws + '|' + sim.resetCount;
      if (key === this.key) return;
      this.key = key;
      for (const w of sim.scenario.switches || []) {
        const cb = this.el.querySelector(`[data-sw="${w.id}"]`);
        cb.checked = !!w.get(sim);
        cb.closest('.fault').classList.toggle('is-off', !cb.checked);
      }
      for (const f of sim.scenario.failures || []) {
        const cb = this.el.querySelector(`[data-fid="${f.id}"]`);
        const on = sim.nodes[f.node].modes[f.mode] !== undefined;
        cb.checked = on;
        cb.closest('.fault').classList.toggle('is-on', on);
      }
      this.restoreBtn.disabled = fs.length === 0;
    }
  };

  /* ---------- guided scenarios ---------- */
  P.Presets = class {
    constructor(el, sim, ctl) {
      el.innerHTML = `
        <p class="panel-note">Each one restores every component, sets up the failure, and performs the user action for you.</p>
        <ul class="preset-list">
          ${(sim.scenario.presets || []).map((p) => `
            <li><div><p class="preset-title">${esc(p.label)}</p><p class="preset-desc">${esc(p.desc)}</p></div>
            <button class="btn" data-preset="${p.id}" aria-label="Run guided scenario: ${esc(p.label)}">Run</button></li>`).join('')}
        </ul>`;
      el.querySelectorAll('[data-preset]').forEach((b) =>
        b.addEventListener('click', () => {
          sim.dispatch('preset', { id: b.dataset.preset });
          if (!ctl.playing) ctl.play();
        })
      );
    }
    render() {}
  };

  /* ---------- timeline ---------- */
  P.Timeline = class {
    constructor(el, sim, ctl) {
      this.el = el;
      this.ctl = ctl;
      this.key = '';
      this.filter = 'all';
      el.innerHTML = `
        <div class="tl-tools">
          <label class="field field-inline">Show
            <select data-ref="filter">
              <option value="all">All events</option>
              <option value="problems">Errors, timeouts, retries</option>
              <option value="latest">Latest action only</option>
            </select>
          </label>
          <span class="tl-count" data-ref="count"></span>
        </div>
        <div class="tl-body">
          <ol class="tl-list" data-ref="list" aria-label="Timeline events"></ol>
          <div class="tl-detail" data-ref="detail" aria-live="polite"></div>
        </div>`;
      this.list = el.querySelector('[data-ref="list"]');
      this.detail = el.querySelector('[data-ref="detail"]');
      this.count = el.querySelector('[data-ref="count"]');
      el.querySelector('[data-ref="filter"]').addEventListener('change', (e) => {
        this.filter = e.target.value;
        this.key = '';
        ctl.changed();
      });
      this.list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-eid]');
        if (!b) return;
        ctl.selectedEvent = Number(b.dataset.eid);
        this.key = '';
        ctl.changed();
      });
    }
    render(sim, ctl) {
      const tl = sim.timeline;
      const lastId = tl.length ? tl[tl.length - 1].id : 0;
      const key = `${sim.resetCount}:${tl.length}:${lastId}:${this.filter}:${ctl.selectedEvent}`;
      if (key === this.key) return;
      this.key = key;
      let items = tl;
      if (this.filter === 'problems') items = tl.filter((e) => ['err', 'timeout', 'retry', 'fault', 'lost', 'hang', 'dup'].includes(e.status));
      if (this.filter === 'latest') {
        const a = sim.ledger.length ? sim.ledger[sim.ledger.length - 1].id : null;
        items = tl.filter((e) => e.actionId === a);
      }
      const shown = items.slice(-200);
      this.count.textContent = `${items.length} event${items.length === 1 ? '' : 's'}${items.length > shown.length ? `, showing the last ${shown.length}` : ''}`;
      const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
      const html = shown.length
        ? shown
            .map((e) => {
              const [label, tone] = EVENT_STATUS[e.status] || [e.status, 'muted'];
              const kind = sim.nodes[e.node] ? sim.nodes[e.node].kind || 'service' : 'system';
              return `<li><button class="tl-item tone-${tone}${ctl.selectedEvent === e.id ? ' is-selected' : ''}" data-eid="${e.id}" aria-pressed="${ctl.selectedEvent === e.id}">
                <span class="tl-time">${fmtT(e.t)}</span>
                <span class="tl-what"><i class="kind-dot kind-${kind}" aria-hidden="true"></i><span class="tl-node">${esc(nodeLabel(sim, e.node))}</span> <span class="tl-op">${esc(e.op)}</span></span>
                ${chip(label, tone)}</button></li>`;
            })
            .join('')
        : '<li class="empty">No events yet. Act in the product or run a guided scenario.</li>';
      keepFocus(this.list, 'data-eid', () => (this.list.innerHTML = html));
      if (atBottom) this.list.scrollTop = this.list.scrollHeight;
      const sel = tl.find((e) => e.id === ctl.selectedEvent);
      if (!sel) {
        this.detail.innerHTML = '<p class="empty">Select an event to see its input, output, and error details.</p>';
        return;
      }
      const [label, tone] = EVENT_STATUS[sel.status] || [sel.status, 'muted'];
      this.detail.innerHTML = `
        <dl class="kv">
          <div><dt>Time</dt><dd>${fmtT(sel.t)}</dd></div>
          <div><dt>Component</dt><dd>${esc(nodeLabel(sim, sel.node))}</dd></div>
          ${sel.from ? `<div><dt>Called by</dt><dd>${esc(nodeLabel(sim, sel.from))}</dd></div>` : ''}
          <div><dt>Operation</dt><dd>${esc(sel.op)}</dd></div>
          <div><dt>Status</dt><dd>${chip(label, tone)}</dd></div>
          ${sel.durationMs != null ? `<div><dt>Processing time</dt><dd>${ui.fmtMs(sel.durationMs)}</dd></div>` : ''}
          ${sel.actionId ? `<div><dt>Part of</dt><dd>${esc((sim.ledgerEntry(sel.actionId) || {}).label || sel.actionId)}</dd></div>` : ''}
        </dl>
        ${sel.detail ? `<p class="tl-detail-text">${esc(sel.detail)}</p>` : ''}
        ${sel.error ? `<p class="tl-error"><strong>${esc(sel.error.code)}</strong> ${esc(sel.error.message)}</p>` : ''}
        ${sel.input !== undefined ? `<p class="code-label">Input</p><pre class="code">${esc(json(sel.input))}</pre>` : ''}
        ${sel.output !== undefined ? `<p class="code-label">Output</p><pre class="code">${esc(json(sel.output))}</pre>` : ''}`;
    }
  };

  /* ---------- metrics ---------- */
  P.Metrics = class {
    constructor(el) {
      this.el = el;
      this.lastPaint = 0;
      this.rev = -1;
    }
    render(sim) {
      const t = performance.now();
      if (sim.revision === this.rev || t - this.lastPaint < 250) return;
      this.rev = sim.revision;
      this.lastPaint = t;
      const s = SDL.snapshot(sim);
      const tile = (label, value, tone, hint) =>
        `<div class="metric${tone ? ' tone-' + tone : ''}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd>${hint ? `<p class="metric-hint">${esc(hint)}</p>` : ''}</div>`;
      const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`);
      const c = sim.scenario.consistency ? sim.scenario.consistency(sim) : null;
      const h = s.health;
      const unhealthy = h.failed + h.degraded;
      let html = '<dl class="metric-grid">';
      const recent = sim.requests.slice(-24);
      if (recent.length) {
        const max = Math.max(...recent.map((r) => r.latency), 1);
        html += `<div class="metric metric-wide"><dt>Last ${recent.length} user requests, by latency</dt><dd class="spark" role="img" aria-label="${recent.filter((r) => r.ok).length} succeeded, ${recent.filter((r) => !r.ok).length} failed">${recent
          .map((r) => `<span class="spark-bar ${r.ok ? 'is-ok' : 'is-fail'}" style="height:${Math.max(10, (r.latency / max) * 100)}%" title="${r.ok ? 'Succeeded' : 'Failed'} in ${r.latency} ms"></span>`)
          .join('')}</dd></div>`;
      }
      html += tile('User requests per second', s.rate.toFixed(1), '', 'Completed in the last 5 s');
      html += tile('Succeeded', s.ok, s.ok ? 'ok' : '');
      html += tile('Failed or unknown', s.failed, s.failed ? 'fail' : '');
      html += tile('Error rate', pct(s.errorRate), s.errorRate > 0 ? 'fail' : '');
      html += tile('Latency P50', ui.fmtMs(s.p50), '', 'End to end, including retries');
      html += tile('Latency P95', ui.fmtMs(s.p95), s.p95 > 1000 ? 'warn' : '');
      html += tile('Latency P99', ui.fmtMs(s.p99), s.p99 > 1000 ? 'warn' : '');
      html += tile('Retries', s.retries, s.retries ? 'warn' : '');
      for (const q of s.queues) {
        html += tile(`Queue depth: ${q.label}`, q.depth, q.depth > 2 ? 'warn' : '');
        html += tile(`Consumer lag: ${q.label}`, ui.fmtMs(q.lag), q.lag > 1000 ? 'warn' : '');
      }
      if (s.cacheHitRate != null) html += tile('Cache hit rate', pct(s.cacheHitRate), s.cacheHitRate < 0.8 ? 'warn' : 'ok');
      if (sim.scenario.metrics) for (const m of sim.scenario.metrics(s, sim)) html += tile(m.label, m.value, m.tone, m.hint);
      html += tile('Service health', unhealthy ? `${unhealthy} of ${Object.keys(sim.nodes).length} impaired` : 'All healthy', h.failed ? 'fail' : h.degraded ? 'warn' : 'ok');
      if (c) html += tile('Data consistency', { ok: 'Consistent', stale: 'Stale', wrong: 'Incorrect' }[c.key] || c.key, { ok: 'ok', stale: 'warn', wrong: 'fail' }[c.key]);
      html += '</dl>';
      this.el.innerHTML = html;
    }
  };

  /* ---------- component inspector ---------- */
  P.Inspector = class {
    constructor(el, sim, ctl) {
      this.el = el;
      this.ctl = ctl;
      this.shown = null;
      this.lastPaint = 0;
      this.rev = -1;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.close != null) this.close();
        else if (b.dataset.inject) {
          const f = sim.scenario.failures.find((x) => x.id === b.dataset.inject);
          const on = sim.nodes[f.node].modes[f.mode] !== undefined;
          sim.dispatch(on ? 'restore' : 'inject', { node: f.node, mode: f.mode, params: f.params });
          this.rev = -1;
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && ctl.selectedNode) this.close();
      });
    }
    close() {
      const id = this.ctl.selectedNode;
      this.ctl.inspect(null);
      const node = document.querySelector(`.node[data-id="${id}"]`);
      if (node) node.focus();
    }
    render(sim, ctl) {
      const id = ctl.selectedNode;
      if (!id) {
        if (!this.el.hidden) this.el.hidden = true;
        this.shown = null;
        return;
      }
      const t = performance.now();
      const opening = this.shown !== id;
      if (!opening && (sim.revision === this.rev || t - this.lastPaint < 250)) return;
      this.rev = sim.revision;
      this.lastPaint = t;
      const n = sim.nodes[id];
      const st = sim.nodeStatus(id);
      const lat = n.stats.lat.slice().sort((a, b) => a - b);
      const neighbours = sim.edges.filter((e) => e.from === id || e.to === id).map((e) => (e.from === id ? e.to : e.from));
      const faults = (sim.scenario.failures || []).filter((f) => f.node === id);
      const recent = sim.timeline.filter((e) => e.node === id).slice(-5).reverse();
      const links = (n.links || []).map((l) => `<li><a href="${ui.href(l.id)}">${esc(l.label || SDL.page(l.id).title)}</a></li>`).join('');
      const paint = () => (this.el.innerHTML = `
        <div class="insp-head">
          <div><h2 id="inspector-title" tabindex="-1">${esc(n.label)}</h2><p class="insp-sub">${esc(n.sub || '')}</p></div>
          <button class="btn btn-quiet" data-close>Close</button>
        </div>
        <p class="insp-status st-${st.key}"><b aria-hidden="true">${STATUS_ICON[st.key]}</b> ${esc(st.label)}</p>
        <h3>Responsibilities</h3><p>${esc(n.role || '')}</p>
        ${n.ops && n.ops.length ? `<h3>Interfaces</h3><ul class="insp-list">${n.ops.map((o) => `<li><code>${esc(o.name)}</code> ${esc(o.desc)}</li>`).join('')}</ul>` : ''}
        <h3>Connected to</h3><ul class="insp-list">${neighbours.map((x) => `<li>${esc(sim.nodes[x].label)}</li>`).join('')}</ul>
        ${n.owns ? `<h3>Data it owns</h3><ul class="insp-list">${n.owns.map((o) => `<li><code>${esc(o)}</code></li>`).join('')}</ul>` : ''}
        <h3>Live numbers <span class="sim-tag">Simulated</span></h3>
        <dl class="kv">
          <div><dt>Requests received</dt><dd>${n.stats.req}</dd></div>
          <div><dt>Succeeded</dt><dd>${n.stats.ok}</dd></div>
          <div><dt>Failed</dt><dd>${n.stats.err}</dd></div>
          <div><dt>In progress</dt><dd>${n.inflight}</dd></div>
          <div><dt>Processing P95</dt><dd>${ui.fmtMs(SDL.percentile(lat, 95))}</dd></div>
          ${n.queue ? `<div><dt>Queue depth</dt><dd>${sim.queueStats(n.queue).depth}</dd></div>` : ''}
        </dl>
        ${faults.length ? `<h3>Failures for this component</h3><div class="insp-faults">${faults.map((f) => {
          const on = n.modes[f.mode] !== undefined;
          return `<button class="btn${on ? ' btn-danger-on' : ''}" data-inject="${f.id}" aria-pressed="${on}">${on ? 'Restore' : 'Inject'}: ${esc(f.label)}</button>`;
        }).join('')}</div>` : ''}
        <h3>Recent activity</h3>
        ${recent.length ? `<ul class="insp-list">${recent.map((e) => `<li><span class="tl-time">${fmtT(e.t)}</span> ${esc(e.op)} ${chip((EVENT_STATUS[e.status] || [e.status])[0], (EVENT_STATUS[e.status] || [0, 'muted'])[1])}</li>`).join('')}</ul>` : '<p class="empty">Nothing yet.</p>'}
        ${links ? `<h3>Related labs</h3><ul class="insp-list">${links}</ul>` : ''}`);
      keepFocus(this.el, 'data-inject', paint);
      if (opening) {
        this.el.hidden = false;
        this.shown = id;
        this.el.querySelector('#inspector-title').focus();
      }
    }
  };
})();
