/*
 * Metrics are computed from what the simulation actually recorded.
 * Nothing here invents numbers: rates come from completed user requests,
 * latency percentiles from their measured durations, queue depth and lag
 * from broker offsets, and cache hit rate from counters scenarios increment.
 */
(function (root) {
  'use strict';
  const SDL = (root.SDL = root.SDL || {});

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const i = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(sorted.length - 1, Math.max(0, i))];
  }

  function snapshot(sim, windowMs) {
    windowMs = windowMs || 5000;
    const reqs = sim.requests;
    const span = Math.max(1000, Math.min(windowMs, sim.now));
    const recent = reqs.filter((r) => r.t >= sim.now - windowMs);
    const ok = reqs.filter((r) => r.ok).length;
    const failed = reqs.length - ok;
    const lats = reqs.slice(-200).map((r) => r.latency).sort((a, b) => a - b);
    const queues = Object.keys(sim.queues).map((id) => sim.queueStats(id));
    const hits = sim.counters.cacheHit || 0;
    const misses = sim.counters.cacheMiss || 0;
    const health = { healthy: 0, processing: 0, degraded: 0, failed: 0, recovering: 0 };
    for (const id of Object.keys(sim.nodes)) health[sim.nodeStatus(id).key]++;
    return {
      now: sim.now,
      rate: recent.length / (span / 1000),
      total: reqs.length,
      ok,
      failed,
      errorRate: reqs.length ? failed / reqs.length : 0,
      p50: percentile(lats, 50),
      p95: percentile(lats, 95),
      p99: percentile(lats, 99),
      retries: sim.retries,
      queues,
      depth: queues.reduce((m, q) => Math.max(m, q.depth), 0),
      lag: queues.reduce((m, q) => Math.max(m, q.lag), 0),
      cacheHitRate: hits + misses ? hits / (hits + misses) : null,
      health,
    };
  }

  SDL.fmtMs = (ms) => (ms == null ? 'n/a' : `${Math.round(ms).toLocaleString('en-US')} ms`);
  SDL.percentile = percentile;
  SDL.snapshot = snapshot;
})(typeof window !== 'undefined' ? window : globalThis);
