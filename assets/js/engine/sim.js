/*
 * System Design Lab: simulation engine.
 *
 * A deterministic discrete-event simulator. Nothing here touches the DOM, so
 * every behaviour can be unit-tested in Node. One Simulator instance holds the
 * whole scenario state: nodes and their failure modes, in-flight requests,
 * queues, the timeline, the outcome ledger, and the product UI state.
 * Every visual on a page is a pure rendering of this object.
 *
 * Flows are written as generator functions that yield effects:
 *   const r = yield ctx.call('db', 'commit', payload, { timeout: 600 });
 *   yield ctx.wait(100);
 *   const { msg } = yield ctx.take('events', 'projector');
 * The engine resolves each effect on the virtual clock, so play, pause, step
 * and replay all work without the scenario doing anything special.
 */
(function (root) {
  'use strict';
  const SDL = (root.SDL = root.SDL || {});

  /* ---------- deterministic randomness ---------- */
  function createRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- errors ---------- */
  class SimError extends Error {
    constructor(code, message, detail) {
      super(message || code);
      this.code = code;
      this.detail = detail;
    }
  }
  const fail = (code, message, detail) => {
    throw new SimError(code, message, detail);
  };

  /* Failure modes and the node state they imply. */
  const FAILED_MODES = { down: 'Unavailable', hang: 'Not responding', crashed: 'Crashed' };
  const DEGRADED_MODES = {
    slow: 'Slow',
    stale: 'Serving stale data',
    duplicate: 'Duplicating deliveries',
    dropResponse: 'Losing replies',
    paused: 'Paused',
    reject: 'Rejecting requests',
    hot: 'Hot key contention',
    partial: 'Partial writes',
    reorder: 'Reordering events',
  };
  const MODE_LABELS = Object.assign({}, FAILED_MODES, DEGRADED_MODES);
  const RETRYABLE = ['UNAVAILABLE', 'TIMEOUT', 'OVERLOADED', 'RATE_LIMITED'];

  const LEDGER_LAYERS = [
    ['attempted', 'Attempted'],
    ['displayed', 'Client shows'],
    ['accepted', 'Server accepted'],
    ['committed', 'Durably committed'],
    ['async', 'Async work done'],
    ['retrySafe', 'Safe to retry'],
  ];

  const isGenFn = (fn) =>
    typeof fn === 'function' && fn.constructor && fn.constructor.name === 'GeneratorFunction';
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function toError(e) {
    if (e instanceof SimError) return { code: e.code, message: e.message, detail: e.detail };
    if (e && typeof e === 'object' && e.code && !(e instanceof Error)) return e;
    if (typeof console !== 'undefined') console.error('[SDL] scenario bug:', e);
    return { code: 'INTERNAL', message: String((e && e.message) || e) };
  }

  class Simulator {
    constructor(scenario, opts) {
      opts = opts || {};
      this.scenario = scenario;
      this.seed = opts.seed != null ? opts.seed : scenario.seed != null ? scenario.seed : 1;
      this.listeners = new Set();
      this.actionLog = [];
      this.revision = 0;
      this.resetCount = 0;
      this.reset();
    }

    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    emit() {
      this.revision++;
      this.listeners.forEach((fn) => fn(this));
    }

    /* ---------- lifecycle ---------- */
    reset(opts) {
      const keepLog = opts && opts.keepLog;
      const sc = this.scenario;
      this.resetCount++;
      this.now = 0;
      this._seq = 0;
      this._events = [];
      this._idSeq = 0;
      this.rng = createRng(this.seed);
      this.nodes = {};
      for (const n of sc.topology.nodes) {
        this.nodes[n.id] = Object.assign({ latency: 10 }, n, {
          modes: {},
          inflight: 0,
          recoverUntil: 0,
          stats: { req: 0, ok: 0, err: 0, lat: [] },
          _timers: {},
        });
      }
      this.edges = sc.topology.edges.map((e) => Object.assign({ latency: 12 }, e));
      this.queues = {};
      for (const q of sc.topology.queues || []) {
        const groups = {};
        for (const g of q.groups || []) groups[g] = { offset: 0, delivering: false };
        this.queues[q.id] = Object.assign({}, q, { msgs: [], groups });
      }
      this.packets = [];
      this.timeline = [];
      this.ledger = [];
      this._ledgerById = {};
      this.ledgerRev = 0;
      this.requests = [];
      this.counters = {};
      this.retries = 0;
      this.procs = 0;
      this._waiters = [];
      this.explanation = sc.intro || '';
      this.state = sc.initialState ? sc.initialState(this) : {};
      this.ui = sc.initialUI ? sc.initialUI(this) : {};
      if (!keepLog) this.actionLog = [];
      if (sc.setup) sc.setup(this);
      this.emit();
    }

    /* ---------- scheduler ---------- */
    schedule(delay, fn, late) {
      const ev = { t: this.now + Math.max(0, delay || 0), late: late ? 1 : 0, seq: this._seq++, fn };
      const a = this._events;
      let lo = 0;
      let hi = a.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const m = a[mid];
        const before =
          m.t < ev.t || (m.t === ev.t && (m.late < ev.late || (m.late === ev.late && m.seq < ev.seq)));
        if (before) lo = mid + 1;
        else hi = mid;
      }
      a.splice(lo, 0, ev);
      return ev;
    }
    cancel(ev) {
      if (ev) ev.cancelled = true;
    }
    pendingEvents() {
      return this._events.filter((e) => !e.cancelled).length;
    }
    hasWork() {
      return this._events.some((e) => !e.cancelled) || this.packets.some((p) => p.t1 > this.now);
    }
    /** Drop cancelled events sitting at the head of the queue. */
    _dropCancelled() {
      while (this._events.length && this._events[0].cancelled) this._events.shift();
    }
    _runNext() {
      while (this._events.length) {
        const ev = this._events.shift();
        if (ev.cancelled) continue;
        this.now = Math.max(this.now, ev.t);
        ev.fn();
        return true;
      }
      return false;
    }
    /** Execute exactly one pending event. Returns false when nothing is left. */
    step() {
      const ran = this._runNext();
      this._prune();
      this.emit();
      return ran;
    }
    /** Advance the virtual clock to t, executing every event due on the way. */
    advanceTo(t) {
      let ran = false;
      this._dropCancelled();
      while (this._events.length && this._events[0].t <= t) {
        if (this._runNext()) ran = true;
        this._dropCancelled();
      }
      const lastPacket = this.packets.reduce((m, p) => Math.max(m, p.t1), 0);
      const hasEvents = this._events.some((e) => !e.cancelled);
      const target = hasEvents ? t : Math.min(t, Math.max(this.now, lastPacket));
      const moved = target > this.now;
      if (moved) this.now = target;
      this._prune();
      if (ran || moved) this.emit();
    }
    runFor(ms) {
      this.advanceTo(this.now + ms);
    }
    runUntilIdle(limitMs) {
      const limit = this.now + (limitMs || 60000);
      while (this._events.some((e) => !e.cancelled) && this.now <= limit) this._runNext();
      this._prune();
      this.emit();
    }
    _prune() {
      if (this.packets.length > 40 || this.packets.some((p) => p.t1 < this.now - 700)) {
        this.packets = this.packets.filter((p) => p.t1 >= this.now - 700);
      }
    }

    /* ---------- processes ---------- */
    spawn(genFn, meta) {
      const p = {
        id: ++this._idSeq,
        meta: Object.assign({ self: 'client' }, meta),
        done: false,
        result: undefined,
        error: undefined,
        joiners: [],
      };
      p.ctx = this._ctx(p);
      p.gen = genFn(p.ctx);
      this.procs++;
      this._resume(p, undefined);
      return p;
    }
    _resume(p, value) {
      if (p.done) return;
      let r;
      try {
        r = p.gen.next(value);
      } catch (e) {
        this._finish(p, undefined, toError(e));
        return;
      }
      if (r.done) this._finish(p, r.value, undefined);
      else this._effect(p, r.value);
    }
    _finish(p, value, error) {
      p.done = true;
      p.result = value;
      p.error = error;
      this.procs--;
      p.joiners.forEach((fn) => fn());
    }
    _effect(p, eff) {
      switch (eff && eff.type) {
        case 'wait':
          this.schedule(eff.ms, () => this._resume(p));
          break;
        case 'call':
          this._call(p, eff);
          break;
        case 'take':
          this._waiters.push({ p, queue: eff.queue, group: eff.group || p.meta.self, self: p.meta.self, max: eff.max || 1 });
          this._pump();
          break;
        case 'join': {
          const procs = eff.procs;
          const results = [];
          let left = procs.length;
          if (!left) {
            this.schedule(0, () => this._resume(p, []));
            break;
          }
          procs.forEach((c, i) => {
            const done = () => {
              results[i] = c.error ? { ok: false, error: c.error } : { ok: true, value: c.result };
              if (--left === 0) this._resume(p, results);
            };
            if (c.done) this.schedule(0, done);
            else c.joiners.push(done);
          });
          break;
        }
        default:
          this._finish(p, undefined, {
            code: 'INTERNAL',
            message: 'Scenario yielded something that is not an effect: ' + JSON.stringify(eff),
          });
      }
    }

    /* ---------- request / response between nodes ---------- */
    edgeBetween(a, b) {
      return this.edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
    }
    _packet(from, to, kind, dur, label, actionId, status) {
      const pkt = {
        id: ++this._idSeq,
        from,
        to,
        kind,
        label,
        actionId,
        status: status || 'pending',
        t0: this.now,
        t1: this.now + Math.max(1, dur),
      };
      this.packets.push(pkt);
      return pkt;
    }
    _call(p, eff) {
      const from = eff.from || p.meta.self;
      const to = eff.to;
      const op = eff.op;
      const opts = eff.opts || {};
      const actionId = opts.actionId || p.meta.actionId;
      const edge = this.edgeBetween(from, to);
      // Every hop takes at least minHopMs of simulated time so packets stay visible.
      const minHop = this.scenario.minHopMs != null ? this.scenario.minHopMs : 25;
      const net = Math.max(minHop, opts.net != null ? opts.net : edge ? edge.latency : 12);
      const timeout = opts.timeout != null ? opts.timeout : 1500;
      const quiet = opts.quiet != null ? opts.quiet : p.meta.quiet || false;
      const payload = clone(eff.payload);
      const t0 = this.now;
      let settled = false;
      let timer = null;
      const settle = (res) => {
        if (settled) return false;
        settled = true;
        this.cancel(timer);
        res.latency = this.now - t0;
        this._resume(p, res);
        return true;
      };
      const target = this.nodes[to];
      if (!target) {
        this.schedule(0, () => settle({ ok: false, error: { code: 'INTERNAL', message: 'Unknown node ' + to } }));
        return;
      }
      const reqPkt = this._packet(from, to, 'req', net, op, actionId);
      timer = this.schedule(timeout, () => {
        const msg = `${target.label} did not answer within ${timeout} ms.`;
        if (settle({ ok: false, error: { code: 'TIMEOUT', message: msg }, unknown: true })) {
          reqPkt.status = 'timeout';
          if (quiet !== 'all') this._log({
            node: from,
            op: `${op} (waiting on ${target.label})`,
            status: 'timeout',
            actionId,
            input: payload,
            error: { code: 'TIMEOUT', message: msg },
            detail: 'The caller gave up. It cannot tell whether the operation ran.',
          });
        }
      });
      this.schedule(net, () => this._arrive({ from, to, op, payload, net, actionId, settle, reqPkt, quiet }));
    }
    _arrive(c) {
      const target = this.nodes[c.to];
      const m = target.modes;
      const arriveT = this.now;
      target.stats.req++;
      c.reqPkt.status = 'arrived';
      if (!c.quiet) this._log({
        node: c.to,
        from: c.from,
        op: `receive ${c.op}`,
        status: 'recv',
        actionId: c.actionId,
        input: c.payload,
        detail: `${target.label} received ${c.op} from ${this.nodes[c.from] ? this.nodes[c.from].label : c.from}.`,
      });

      const respond = (res) => {
        if (res.ok) target.stats.ok++;
        else target.stats.err++;
        target.stats.lat.push(this.now - arriveT);
        if (target.stats.lat.length > 300) target.stats.lat.shift();
        const hide = c.quiet === 'all' || (c.quiet && res.ok);
        if (!hide) this._log({
          node: c.to,
          from: c.from,
          op: c.op,
          status: res.ok ? 'ok' : 'err',
          actionId: c.actionId,
          input: c.payload,
          output: res.ok ? clone(res.value) : undefined,
          error: res.ok ? undefined : res.error,
          durationMs: this.now - arriveT,
        });
        if (m.dropResponse && res.ok) {
          this._packet(c.to, c.from, 'res', c.net, c.op, c.actionId, 'lost');
          if (c.quiet !== 'all') this._log({
            node: c.to,
            op: `${c.op} reply lost`,
            status: 'lost',
            actionId: c.actionId,
            detail: `${target.label} finished the work, but the reply never reached ${this.nodes[c.from] ? this.nodes[c.from].label : c.from}.`,
          });
          return;
        }
        const pkt = this._packet(c.to, c.from, 'res', c.net, c.op, c.actionId, res.ok ? 'ok' : 'err');
        this.schedule(c.net, () => {
          if (!c.settle(res)) pkt.status = 'late';
        });
      };

      if (m.down || m.crashed) {
        this.schedule(2, () =>
          respond({
            ok: false,
            error: { code: 'UNAVAILABLE', message: `${target.label} is not accepting connections.` },
          })
        );
        return;
      }
      if (m.hang) {
        if (c.quiet !== 'all') this._log({
          node: c.to,
          from: c.from,
          op: c.op,
          status: 'hang',
          actionId: c.actionId,
          input: c.payload,
          detail: `${target.label} accepted the connection but will never answer.`,
        });
        return;
      }
      if (m.reject) {
        const r = m.reject === true ? {} : m.reject;
        this.schedule(1, () =>
          respond({
            ok: false,
            error: { code: r.code || 'REJECTED', message: r.message || `${target.label} rejected the request.` },
          })
        );
        return;
      }

      target.inflight++;
      let proc = target.latency;
      if (m.slow) proc *= (m.slow && m.slow.factor) || 10;
      proc += target.latency * 0.2 * this.rng();
      if (target.serviceMs && !m.hot) {
        // Real capacity: `servers` workers, each taking serviceMs per request.
        // Requests queue when every worker is busy, so overload emerges from load.
        const k = target.servers || 1;
        if (!target._busy) target._busy = new Array(k).fill(0);
        let i = 0;
        for (let j = 1; j < k; j++) if (target._busy[j] < target._busy[i]) i = j;
        let svc = target.serviceMs * (m.slow ? (m.slow.factor || 10) : 1);
        svc += svc * 0.2 * this.rng();
        const start = Math.max(this.now, target._busy[i]);
        target._busy[i] = start + svc;
        proc = start - this.now + svc;
      }
      if (m.hot) {
        // A hot shard behaves like a single-server queue: each request waits for
        // the ones ahead of it. Once arrivals exceed capacity, waiting time grows.
        const svc = target.latency * ((m.hot && m.hot.factor) || 10);
        const start = Math.max(this.now, target.busyUntil || 0);
        target.busyUntil = start + svc;
        proc = start - this.now + svc;
      }
      proc = Math.round(proc);

      this.schedule(proc, () => {
        const handler = this._handler(c.to, c.op);
        const finish = (res) => {
          target.inflight = Math.max(0, target.inflight - 1);
          respond(res);
        };
        if (!handler) {
          finish({ ok: true, value: undefined });
          return;
        }
        if (isGenFn(handler)) {
          const sub = this.spawn((ctx) => handler(ctx, c.payload), {
            self: c.to,
            actionId: c.actionId,
            caller: c.from,
            quiet: c.quiet,
          });
          const done = () =>
            finish(sub.error ? { ok: false, error: sub.error } : { ok: true, value: sub.result });
          if (sub.done) done();
          else sub.joiners.push(done);
          return;
        }
        const ctx = this._ctx({ meta: { self: c.to, actionId: c.actionId, caller: c.from, quiet: c.quiet } });
        try {
          finish({ ok: true, value: handler(ctx, c.payload) });
        } catch (e) {
          finish({ ok: false, error: toError(e) });
        }
      });
    }
    _handler(node, op) {
      const h = this.scenario.handlers && this.scenario.handlers[node];
      return h ? h[op] : undefined;
    }

    /* ---------- queues ---------- */
    enqueue(queueId, msg) {
      const q = this.queues[queueId];
      if (!q) throw new Error('Unknown queue ' + queueId);
      const m = Object.assign({ id: ++this._idSeq, t: this.now, offset: q.msgs.length }, clone(msg));
      q.msgs.push(m);
      const broker = this.nodes[q.broker];
      if (broker && broker.modes.duplicate) {
        q.msgs.push(Object.assign({}, m, { id: ++this._idSeq, offset: q.msgs.length, duplicate: true }));
        this._log({
          node: q.broker,
          op: 'duplicate append',
          status: 'dup',
          actionId: m.actionId,
          detail: `Event ${m.eventId || m.id} was appended twice. Consumers will see it twice.`,
        });
      }
      this._pump();
      return m;
    }
    queueStats(queueId) {
      const q = this.queues[queueId];
      let depth = 0;
      let lag = 0;
      for (const g of Object.values(q.groups)) {
        const d = q.msgs.length - g.offset;
        depth = Math.max(depth, d);
        if (d > 0) lag = Math.max(lag, this.now - q.msgs[g.offset].t);
      }
      return { id: q.id, label: q.label || q.id, depth, lag, total: q.msgs.length };
    }
    _consumerBlocked(nodeId) {
      const n = this.nodes[nodeId];
      return !!(n && (n.modes.down || n.modes.crashed || n.modes.paused || n.modes.hang));
    }
    _pump() {
      for (const w of this._waiters.slice()) {
        const q = this.queues[w.queue];
        if (!q) continue;
        if (!q.groups[w.group]) q.groups[w.group] = { offset: 0, delivering: false };
        const g = q.groups[w.group];
        const broker = this.nodes[q.broker];
        if (g.delivering || g.offset >= q.msgs.length) continue;
        if (broker && (broker.modes.down || broker.modes.hang || broker.modes.crashed)) continue;
        if (this._consumerBlocked(w.self)) continue;
        this._waiters.splice(this._waiters.indexOf(w), 1);
        g.delivering = true;
        const msg = q.msgs[g.offset];
        const batch = q.msgs.slice(g.offset, g.offset + (w.max || 1));
        g.batch = batch.length;
        const edge = this.edgeBetween(q.broker, w.self);
        const minHop = this.scenario.minHopMs != null ? this.scenario.minHopMs : 25;
        const net = Math.max(minHop, edge ? edge.latency : 12);
        this._packet(q.broker, w.self, 'msg', net, msg.type, msg.actionId, 'msg');
        this.schedule(net, () => {
          if (this._consumerBlocked(w.self)) {
            g.delivering = false;
            this._waiters.push(w);
            return;
          }
          const cons = this.nodes[w.self];
          if (cons) cons.inflight++;
          if (!msg.quiet) this._log({
            node: w.self,
            op: `receive ${msg.type}`,
            status: msg.duplicate ? 'dup' : 'ok',
            actionId: msg.actionId,
            input: msg.payload,
            detail: `Read offset ${msg.offset} from ${q.label || q.id}${msg.duplicate ? ' (a duplicate copy)' : ''}.`,
          });
          this._resume(w.p, { msg: clone(msg), msgs: clone(batch), offset: msg.offset });
        });
      }
    }
    _settleDelivery(queueId, group, nodeId, advance) {
      const q = this.queues[queueId];
      const g = q.groups[group || nodeId];
      if (!g || !g.delivering) return;
      if (advance) g.offset += advance === true ? g.batch || 1 : advance;
      g.delivering = false;
      const cons = this.nodes[nodeId];
      if (cons) cons.inflight = Math.max(0, cons.inflight - 1);
      this._pump();
    }

    /* ---------- failures ---------- */
    inject(nodeId, mode, params, duration) {
      const n = this.nodes[nodeId];
      if (!n) throw new Error('Unknown node ' + nodeId);
      if (n._timers[mode]) this.cancel(n._timers[mode]);
      n.modes[mode] = params == null ? true : params;
      const label = (this.scenario.modeLabels && this.scenario.modeLabels[mode]) || MODE_LABELS[mode] || mode;
      this._log({
        node: nodeId,
        op: 'failure injected',
        status: 'fault',
        detail: `${n.label}: ${label}${duration ? `, for ${duration} ms` : ', until restored'}.`,
      });
      if (duration) n._timers[mode] = this.schedule(duration, () => this.restore(nodeId, mode));
      if (this.scenario.onFailureChange) this.scenario.onFailureChange(this, { node: nodeId, mode, active: true });
      this._pump();
    }
    restore(nodeId, mode) {
      const n = this.nodes[nodeId];
      const modes = mode ? [mode] : Object.keys(n.modes);
      const active = modes.filter((m) => n.modes[m] !== undefined);
      if (!active.length) return;
      for (const m of active) {
        delete n.modes[m];
        if (n._timers[m]) {
          this.cancel(n._timers[m]);
          delete n._timers[m];
        }
        if (this.scenario.onFailureChange) this.scenario.onFailureChange(this, { node: nodeId, mode: m, active: false });
      }
      n.recoverUntil = this.now + 600;
      this.schedule(600, () => {}); // keeps the clock moving so "recovering" visibly ends
      this._log({ node: nodeId, op: 'restored', status: 'recovered', detail: `${n.label} is back. Waiting work resumes.` });
      this._pump();
    }
    restoreAll() {
      for (const id of Object.keys(this.nodes)) if (Object.keys(this.nodes[id].modes).length) this.restore(id);
    }
    /** How long a new request would wait before a worker on this node is free. */
    queueWait(id) {
      const n = this.nodes[id];
      if (n._busy) return Math.max(0, Math.min(...n._busy) - this.now);
      return Math.max(0, (n.busyUntil || 0) - this.now);
    }
    activeFailures() {
      const out = [];
      for (const n of Object.values(this.nodes)) for (const m of Object.keys(n.modes)) out.push({ node: n.id, mode: m });
      return out;
    }
    nodeStatus(id) {
      const n = this.nodes[id];
      const custom = this.scenario.modeLabels || {};
      for (const k of Object.keys(FAILED_MODES)) if (n.modes[k]) return { key: 'failed', label: custom[k] || FAILED_MODES[k] };
      for (const k of Object.keys(n.modes)) return { key: 'degraded', label: custom[k] || DEGRADED_MODES[k] || k };
      if (this.now < n.recoverUntil) return { key: 'recovering', label: 'Recovering' };
      if (n.serviceMs) {
        const w = this.queueWait(id);
        if (w > 500) return { key: 'degraded', label: `Overloaded, ${(w / 1000).toFixed(1)} s queue` };
      }
      if (n.inflight > 0) return { key: 'processing', label: n.inflight === 1 ? 'Working on 1' : `Working on ${n.inflight}` };
      return { key: 'healthy', label: 'Healthy' };
    }

    /* ---------- timeline, ledger, metrics ---------- */
    _log(entry) {
      this.timeline.push(Object.assign({ id: ++this._idSeq, t: this.now }, entry));
      if (this.timeline.length > 600) this.timeline.splice(0, this.timeline.length - 600);
    }
    note(text, extra) {
      this._log(Object.assign({ node: 'system', op: 'note', status: 'note', detail: text }, extra));
    }
    explain(text) {
      this.explanation = text;
    }
    count(key, n) {
      this.counters[key] = (this.counters[key] || 0) + (n == null ? 1 : n);
    }
    recordOutcome(ok, latency) {
      this.requests.push({ t: this.now, ok: !!ok, latency: Math.round(latency) });
      if (this.requests.length > 2000) this.requests.shift();
    }
    setLedger(actionId, layer, value, note, opts) {
      const e = this._ledgerById[actionId];
      if (!e) return;
      if (opts && opts.ifPending && e.layers[layer] !== 'pending') return;
      e.layers[layer] = value;
      if (note) e.notes[layer] = note;
      this.ledgerRev++;
    }
    ledgerEntry(actionId) {
      return this._ledgerById[actionId];
    }
    /** Start a user action: creates a ledger row and runs the flow as the client. */
    startAction(label, genFn, opts) {
      opts = opts || {};
      const id = 'a' + (this.ledger.length + 1);
      const entry = {
        id,
        label,
        t: this.now,
        layers: { attempted: 'yes', displayed: 'pending', accepted: 'pending', committed: 'pending', async: 'pending', retrySafe: 'pending' },
        notes: {},
      };
      this.ledger.push(entry);
      this._ledgerById[id] = entry;
      this.ledgerRev++;
      this._log({ node: opts.self || 'client', op: label, status: 'start', actionId: id, detail: opts.detail || `User action: ${label}.` });
      this.spawn(genFn, { self: opts.self || 'client', actionId: id });
      return id;
    }

    /* ---------- actions and replay ---------- */
    /** Every user-initiated change goes through dispatch so it can be replayed. */
    dispatch(type, args) {
      args = args || {};
      this.actionLog.push({ t: this.now, type, args: clone(args) });
      this.do(type, args);
      this.emit();
    }
    /** Apply an action without logging it (used by replay and guided scenarios). */
    do(type, args) {
      args = args || {};
      if (type === 'inject') return this.inject(args.node, args.mode, args.params, args.duration);
      if (type === 'restore') return this.restore(args.node, args.mode);
      if (type === 'restoreAll') return this.restoreAll();
      if (type === 'setSwitch') {
        const w = (this.scenario.switches || []).find((x) => x.id === args.id);
        if (!w) throw new Error('Unknown switch ' + args.id);
        w.set(this, !!args.on);
        this.note(`Design switch ${args.on ? 'on' : 'off'}: ${w.label}.`);
        return;
      }
      if (type === 'preset') {
        const preset = (this.scenario.presets || []).find((p) => p.id === args.id);
        if (!preset) throw new Error('Unknown preset ' + args.id);
        this.note(`Guided scenario started: ${preset.label}.`);
        return preset.run(this, args);
      }
      const fn = this.scenario.actions && this.scenario.actions[type];
      if (!fn) throw new Error('Unknown action ' + type);
      return fn(this, args);
    }
    /** Reset to the initial state and re-run every recorded action at its original time. */
    replay() {
      const log = this.actionLog.slice();
      this.reset({ keepLog: true });
      for (const a of log) this.schedule(a.t, () => this.do(a.type, a.args), true);
      this.emit();
      return log.length;
    }

    /* ---------- the context object handed to flows and handlers ---------- */
    _ctx(p) {
      const sim = this;
      const meta = p.meta;
      const ctx = {
        sim,
        self: meta.self,
        actionId: meta.actionId,
        caller: meta.caller,
        get state() {
          return sim.state;
        },
        get ui() {
          return sim.ui;
        },
        now: () => sim.now,
        rand: () => sim.rng(),
        wait: (ms) => ({ type: 'wait', ms }),
        call: (to, op, payload, opts) => ({ type: 'call', to, op, payload, opts }),
        take: (queue, group, max) => ({ type: 'take', queue, group, max }),
        join: (procs) => ({ type: 'join', procs }),
        quiet: meta.quiet,
        spawn: (fn, extra) => sim.spawn(fn, Object.assign({ self: meta.self, actionId: meta.actionId, quiet: meta.quiet }, extra)),
        ack: (queue, group) => sim._settleDelivery(queue, group, meta.self, true),
        nack: (queue, group) => sim._settleDelivery(queue, group, meta.self, false),
        alive: () => !sim._consumerBlocked(meta.self),
        mode: (m, node) => sim.nodes[node || meta.self].modes[m],
        log: (e) => sim._log(Object.assign({ node: meta.self, actionId: meta.actionId }, e)),
        note: (text) => sim.note(text, { actionId: meta.actionId }),
        explain: (text) => sim.explain(text),
        count: (k, n) => sim.count(k, n),
        ledger: (layer, value, note, opts) => sim.setLedger(meta.actionId, layer, value, note, opts),
        recordOutcome: (ok, latency) => sim.recordOutcome(ok, latency),
        fail,
        /** Turn a failed call result into a thrown error, propagating its code. */
        must: (r) => {
          if (r && r.ok) return r.value;
          const e = (r && r.error) || { code: 'INTERNAL', message: 'Missing result' };
          throw new SimError(e.code, e.message, e.detail);
        },
        /** Bounded exponential backoff with jitter. attemptFn is a generator returning a call result. */
        retry: function* (policy, attemptFn) {
          const max = policy.attempts || 3;
          const base = policy.baseMs || 100;
          const cap = policy.capMs || 2000;
          const jitter = policy.jitter == null ? 0.25 : policy.jitter;
          const retryable = policy.retryable || ((r) => r.error && RETRYABLE.includes(r.error.code));
          let r;
          for (let a = 1; a <= max; a++) {
            r = yield* attemptFn(a);
            r.attempts = a;
            if (r.ok || !retryable(r) || a === max) return r;
            const backoff = Math.round(Math.min(cap, base * Math.pow(2, a - 1)) * (1 + jitter * (sim.rng() * 2 - 1)));
            sim.retries++;
            sim._log({
              node: meta.self,
              op: 'retry scheduled',
              status: 'retry',
              actionId: meta.actionId,
              error: r.error,
              detail: `Attempt ${a} of ${max} failed with ${r.error.code}. Waiting ${backoff} ms before attempt ${a + 1}.`,
            });
            yield { type: 'wait', ms: backoff };
          }
          return r;
        },
      };
      return ctx;
    }
  }

  Object.assign(SDL, {
    createRng,
    SimError,
    fail,
    Simulator,
    LEDGER_LAYERS,
    MODE_LABELS,
    RETRYABLE,
    clone,
    scenarios: SDL.scenarios || {},
  });
})(typeof window !== 'undefined' ? window : globalThis);
