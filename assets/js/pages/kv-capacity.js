/*
 * Distributed key-value store: requirements and capacity.
 * A live back-of-the-envelope calculator. Items, item size, and request rates
 * become partitions by size, by reads, and by writes; replication multiplies
 * storage; compaction adds more. The number that shapes the design is the
 * per-partition limit: one hot key cannot be helped by adding nodes.
 */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;
  const esc = ui.esc;

  const INPUTS = [
    { id: 'items', label: 'Items in the table', unit: 'billion', min: 0.1, max: 100, step: 0.1, value: 10 },
    { id: 'size', label: 'Average item size', unit: 'KB', min: 0.1, max: 64, step: 0.1, value: 1 },
    { id: 'reads', label: 'Peak reads per second', unit: 'thousand', min: 1, max: 5000, step: 1, value: 500 },
    { id: 'writes', label: 'Peak writes per second', unit: 'thousand', min: 1, max: 2000, step: 1, value: 100 },
    { id: 'rf', label: 'Replication factor (N)', unit: '', min: 1, max: 5, step: 1, value: 3 },
    { id: 'partGB', label: 'Maximum partition size', unit: 'GB', min: 1, max: 100, step: 1, value: 10 },
    { id: 'partReads', label: 'Reads per second per partition', unit: '', min: 500, max: 20000, step: 500, value: 3000 },
    { id: 'partWrites', label: 'Writes per second per partition', unit: '', min: 100, max: 10000, step: 100, value: 1000 },
    { id: 'nodeTB', label: 'Usable storage per node', unit: 'TB', min: 0.5, max: 16, step: 0.5, value: 2 },
    { id: 'hotShare', label: 'Hottest key’s share of all writes', unit: '%', min: 0, max: 20, step: 0.1, value: 0.2 },
    { id: 'growth', label: 'Growth per year', unit: '%', min: 0, max: 200, step: 5, value: 40 },
  ];
  const REQS = [
    { id: 'lsm', label: 'LSM storage engine (reserve 30% for compaction)', value: true },
    { id: 'strong', label: 'Strongly consistent reads (quorum or leader; 2× read cost)', value: false },
    { id: 'vnodes', label: 'Virtual nodes (even load; otherwise plan for 2× skew)', value: true },
    { id: 'cache', label: 'Read-through cache in front (80% hit rate on reads)', value: false },
  ];
  const SCENARIOS = {
    normal: { label: 'Large table', set: { items: 10, size: 1, reads: 500, writes: 100, hotShare: 0.2 } },
    hot: { label: 'One famous key', set: { items: 10, size: 1, reads: 500, writes: 100, hotShare: 3 } },
    small: { label: 'Small, read-heavy', set: { items: 0.5, size: 4, reads: 2000, writes: 20, hotShare: 0.1 } },
  };
  const AVAIL = { '99.9': 525, '99.99': 52.6, '99.999': 5.26 }; // minutes per year

  function fmt(n, d) {
    if (n >= 1e12) return (n / 1e12).toFixed(d == null ? 1 : d) + ' trillion';
    if (n >= 1e9) return (n / 1e9).toFixed(d == null ? 1 : d) + ' billion';
    if (n >= 1e6) return (n / 1e6).toFixed(d == null ? 1 : d) + ' million';
    if (n >= 1000) return Math.round(n).toLocaleString('en-US');
    return n.toFixed(d == null ? 1 : d);
  }
  const bytes = (b) => (b >= 1e15 ? (b / 1e15).toFixed(1) + ' PB' : b >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(1) + ' MB');

  function compute(v, r) {
    const items = v.items * 1e9;
    const rawBytes = items * v.size * 1000;
    const replicated = rawBytes * v.rf;
    const withCompaction = replicated * (r.lsm ? 1.3 : 1.0);
    const reads = v.reads * 1000;
    const writes = v.writes * 1000;
    const readCost = reads * (r.strong ? 2 : 1) * (r.cache ? 0.2 : 1); // replica reads actually served by partitions
    const bySize = Math.ceil(rawBytes / (v.partGB * 1e9));
    const byReads = Math.ceil(readCost / v.partReads);
    const byWrites = Math.ceil(writes / v.partWrites);
    const partitions = Math.max(bySize, byReads, byWrites);
    const dominant = partitions === bySize ? 'size' : partitions === byWrites ? 'writes' : 'reads';
    const replicaPartitions = partitions * v.rf;
    const skew = r.vnodes ? 1 : 2;
    const nodesByStorage = Math.ceil((withCompaction * skew) / (v.nodeTB * 1e12));
    const nodes = Math.max(v.rf, nodesByStorage);
    const perNodePartitions = Math.ceil(replicaPartitions / nodes);
    const writeBandwidth = writes * v.size * 1000 * v.rf; // bytes per second into storage
    const hotWrites = writes * (v.hotShare / 100);
    const hotOk = hotWrites <= v.partWrites;
    const yearBytes = withCompaction * (1 + v.growth / 100);
    const latency = [
      ['Client to request router', 1.0],
      ['Router: hash, look up partition', 0.2],
      ['Router to coordinator', 0.3],
      [r.strong ? 'Quorum of replicas (wait for the slower of two)' : 'One replica', r.strong ? 2.0 : 1.0],
      ['Storage engine: memtable or SSTable with bloom filter', 0.5],
      ['Reply', 1.3],
    ];
    const totalMs = latency.reduce((s, x) => s + x[1], 0);
    return { items, rawBytes, replicated, withCompaction, reads, writes, readCost, bySize, byReads, byWrites, partitions, dominant, replicaPartitions, nodes, nodesByStorage, perNodePartitions, writeBandwidth, hotWrites, hotOk, yearBytes, latency, totalMs };
  }

  function insights(v, r, o) {
    const out = [];
    out.push(`${fmt(o.items)} items of ${v.size} KB are ${bytes(o.rawBytes)} raw, ${bytes(o.replicated)} with ${v.rf} copies${r.lsm ? `, and about ${bytes(o.withCompaction)} on disk once the storage engine’s compaction headroom is counted` : ''}.`);
    out.push(`Partitions: ${fmt(o.bySize, 0)} by size, ${fmt(o.byReads, 0)} by reads, ${fmt(o.byWrites, 0)} by writes. ${o.dominant === 'size' ? 'Size sets the count: throughput per partition is nowhere near its limit, so the store is bounded by how much it holds, not how hard it is hit.' : o.dominant === 'writes' ? 'Writes set the count: each partition takes at most ' + fmt(v.partWrites, 0) + ' writes a second, so the table needs more partitions than its size alone would.' : 'Reads set the count: the read rate outgrows what the partitions needed for size can serve.' + (r.cache ? '' : ' A read-through cache would cut the partitions’ share.')}`);
    out.push(o.hotOk
      ? `The hottest key takes ${fmt(o.hotWrites, 0)} writes a second, under the ${fmt(v.partWrites, 0)} one partition can do. Fine today; a key that becomes ${Math.ceil(v.partWrites / Math.max(o.hotWrites, 1))}× more popular hits the ceiling.`
      : `The hottest key takes ${fmt(o.hotWrites, 0)} writes a second, more than the ${fmt(v.partWrites, 0)} one partition can do. No number of nodes fixes this: one key lives on one partition. The answers are write sharding of the key (key#1 … key#k), a cache, or admission control that throttles that key and protects its neighbours.`);
    out.push(r.strong
      ? `Strongly consistent reads consult a quorum (or the leader), so each read costs the store about twice as much and waits for the slower replica: about ${o.totalMs.toFixed(1)} ms in-region.`
      : `Eventually consistent reads take one replica: about ${o.totalMs.toFixed(1)} ms in-region, and a read right after a write may miss it. The quorum lab shows when that happens.`);
    out.push(`${fmt(o.nodes, 0)} storage nodes of ${v.nodeTB} TB hold the data${r.vnodes ? '' : ', doubled because without virtual nodes the busiest node holds about twice its share'}, about ${o.perNodePartitions} replica partitions each. Write bandwidth into storage is ${bytes(o.writeBandwidth)}/s, before the write-ahead log.`);
    out.push(`At ${v.growth}% growth the table is ${bytes(o.yearBytes)} on disk in a year: partitions split as they pass ${v.partGB} GB, and splitting is what the ring and rebalancing lab is about.`);
    return out;
  }

  ui.mountKvCapacity = function (pageId) {
    const main = ui.mountShell(pageId);
    const page = SDL.page(pageId);
    const vals = Object.fromEntries(INPUTS.map((i) => [i.id, i.value]));
    const reqs = Object.fromEntries(REQS.map((i) => [i.id, i.value]));
    let avail = '99.99';
    main.innerHTML = `
      <div class="lab-head">
        <h1>${esc(page.title)}</h1>
        <p class="lede">${esc(page.summary)}</p>
        <p class="disclaimer">Back-of-the-envelope estimates for learning, not Amazon DynamoDB’s figures. The per-partition limits are the published defaults of one real service; everything else is a stated assumption.</p>
      </div>
      <div class="cap-grid">
        <section class="panel panel-product" aria-labelledby="h-in">
          <h2 id="h-in">Inputs</h2>
          <div class="ops-traffic cap-scen" role="group" aria-label="Scenarios">${Object.entries(SCENARIOS).map(([k, s]) => `<button class="btn ops-tbtn" data-scen="${k}">${esc(s.label)}</button>`).join('')}</div>
          <div class="cap-inputs">${INPUTS.map((i) => `
            <div class="cap-input"><label for="in-${i.id}">${esc(i.label)}</label>
              <input type="range" id="in-${i.id}" data-in="${i.id}" min="${i.min}" max="${i.max}" step="${i.step}" value="${i.value}">
              <output for="in-${i.id}" data-out="${i.id}"></output></div>`).join('')}</div>
          <h3 class="subhead">Design choices</h3>
          <div class="cap-reqs">${REQS.map((r) => `<label class="check"><input type="checkbox" data-req="${r.id}"${r.value ? ' checked' : ''}> ${esc(r.label)}</label>`).join('')}</div>
          <h3 class="subhead">Availability target</h3>
          <div class="ops-traffic" role="group" aria-label="Availability">${Object.keys(AVAIL).map((a) => `<button class="btn ops-tbtn" data-avail="${a}">${a}%</button>`).join('')}</div>
        </section>
        <div class="lab-main">
          <section class="panel panel-metrics" aria-labelledby="h-load"><h2 id="h-load">Sizing <span class="sim-tag">Estimated</span></h2><dl class="metric-grid" data-ref="load"></dl></section>
          <section class="panel panel-diagram" aria-labelledby="h-srv"><h2 id="h-srv">Partitions by each limit</h2><div data-ref="bars"></div><p class="surge-meta" data-ref="caps"></p><h3 class="subhead">Latency budget, one read</h3><div data-ref="lat"></div></section>
          <section class="panel panel-ledger" aria-labelledby="h-ins"><h2 id="h-ins">What these numbers say</h2><ul class="ledger-notes" data-ref="insights"></ul><p class="recon" data-ref="avail"></p></section>
        </div>
      </div>`;
    const q = (s) => main.querySelector(s);
    function render() {
      for (const i of INPUTS) q(`[data-out="${i.id}"]`).textContent = `${vals[i.id]}${i.unit ? (i.unit.length <= 2 ? i.unit : ' ' + i.unit) : ''}`;
      main.querySelectorAll('[data-avail]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.avail === avail)));
      const o = compute(vals, reqs);
      const tile = (label, value, hint, tone) => `<div class="metric"${tone ? ` data-tone="${tone}"` : ''}><dt>${esc(label)}</dt><dd>${esc(value)}</dd>${hint ? `<p class="metric-hint">${esc(hint)}</p>` : ''}</div>`;
      q('[data-ref="load"]').innerHTML =
        tile('On disk', bytes(o.withCompaction), `${bytes(o.rawBytes)} raw × ${vals.rf} copies${reqs.lsm ? ' × 1.3 compaction' : ''}`) +
        tile('Partitions', fmt(o.partitions, 0), `set by ${o.dominant}; ${fmt(o.replicaPartitions, 0)} replica partitions`) +
        tile('Storage nodes', fmt(o.nodes, 0), `${vals.nodeTB} TB each, ${o.perNodePartitions} replica partitions per node`) +
        tile('Hottest key', `${fmt(o.hotWrites, 0)} writes/s`, o.hotOk ? `under the ${fmt(vals.partWrites, 0)}/s partition limit` : `✕ over the ${fmt(vals.partWrites, 0)}/s partition limit`, o.hotOk ? 'ok' : 'fail') +
        tile('Read latency', `${o.totalMs.toFixed(1)} ms`, reqs.strong ? 'quorum read' : 'one replica, may be stale', reqs.strong ? 'warn' : 'ok') +
        tile('Write bandwidth', `${bytes(o.writeBandwidth)}/s`, `${fmt(o.writes)} writes × ${vals.size} KB × ${vals.rf}`) +
        tile('Partition reads served', `${fmt(o.readCost)}/s`, reqs.cache ? 'after an 80% cache hit rate' : 'no cache') +
        tile('In one year', bytes(o.yearBytes), `${vals.growth}% growth`);
      const bars = { 'By size': o.bySize, 'By reads': o.byReads, 'By writes': o.byWrites };
      const max = Math.max(...Object.values(bars), 1);
      const top = Object.entries(bars).sort((a, b) => b[1] - a[1])[0][0];
      q('[data-ref="bars"]').innerHTML = `<div class="cap-bars">${Object.entries(bars).map(([k, n]) => `
        <div class="cap-bar${k === top ? ' is-top' : ''}"><span class="cap-label">${esc(k)}</span><span class="cap-track"><i style="width:${(n / max) * 100}%"></i></span><span class="cap-n">${fmt(n, 0)}</span></div>`).join('')}</div>`;
      q('[data-ref="caps"]').textContent = `Per-partition limits: ${vals.partGB} GB, ${fmt(vals.partReads, 0)} reads/s, ${fmt(vals.partWrites, 0)} writes/s. The table needs the largest of the three counts. Replicas multiply partitions, not keys: a hot key is hot on every one of its replicas.`;
      const lmax = Math.max(...o.latency.map((x) => x[1]), 0.1);
      q('[data-ref="lat"]').innerHTML = `<div class="cap-bars">${o.latency.map(([label, ms]) => `<div class="cap-bar"><span class="cap-label">${esc(label)}</span><span class="cap-track"><i style="width:${(ms / lmax) * 100}%"></i></span><span class="cap-n">${ms.toFixed(1)} ms</span></div>`).join('')}</div>`;
      q('[data-ref="insights"]').innerHTML = insights(vals, reqs, o).map((t) => `<li>${esc(t)}</li>`).join('');
      q('[data-ref="avail"]').textContent = `${avail}% allows about ${AVAIL[avail]} minutes of unavailability a year${avail === '99.999' ? ': a node failure must be invisible, which is what sloppy quorums, hinted handoff, and request routers that skip a dead replica are for.' : avail === '99.99' ? ': one node failure a month is fine if the router steps around it in seconds; a metadata outage that stops every router is not.' : ': a planned maintenance window a month fits; most of the budget goes to the long tail of slow disks.'}`;
    }
    main.addEventListener('input', (e) => { const id = e.target.dataset.in; if (id) { vals[id] = Number(e.target.value); render(); } });
    main.addEventListener('change', (e) => { const id = e.target.dataset.req; if (id) { reqs[id] = e.target.checked; render(); } });
    main.addEventListener('click', (e) => {
      const s = e.target.closest('[data-scen]');
      if (s) {
        Object.assign(vals, SCENARIOS[s.dataset.scen].set);
        for (const i of INPUTS) q(`[data-in="${i.id}"]`).value = vals[i.id];
        main.querySelectorAll('[data-scen]').forEach((b) => b.setAttribute('aria-pressed', String(b === s)));
        render();
      }
      const a = e.target.closest('[data-avail]');
      if (a) { avail = a.dataset.avail; render(); }
    });
    render();
    window.SDL_CAPACITY = { compute, vals, reqs };
  };
})();
