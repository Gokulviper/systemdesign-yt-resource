/*
 * Collaborative editing: requirements and capacity.
 * A live back-of-the-envelope calculator. Every input recomputes every output;
 * per-server capacities are stated assumptions. Aggregate load shards cleanly
 * by document, so the number that shapes the design is what one document can
 * demand of its single sequencer: editors’ operations times viewers.
 */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;
  const esc = ui.esc;

  const INPUTS = [
    { id: 'dau', label: 'Daily active users', unit: 'million', min: 5, max: 500, step: 5, value: 50 },
    { id: 'conc', label: 'Open at the same time at peak', unit: '%', min: 2, max: 40, step: 1, value: 10 },
    { id: 'typing', label: 'Open sessions actively typing', unit: '%', min: 2, max: 50, step: 1, value: 10 },
    { id: 'coalesce', label: 'Keystroke coalescing window', unit: 'ms', min: 0, max: 2000, step: 50, value: 500 },
    { id: 'collab', label: 'Other people in an active document', unit: '', min: 0, max: 20, step: 0.5, value: 1.5 },
    { id: 'opBytes', label: 'Bytes per operation with metadata', unit: 'B', min: 40, max: 400, step: 10, value: 100 },
    { id: 'snapEvery', label: 'Snapshot every N operations', unit: '', min: 10, max: 2000, step: 10, value: 200 },
    { id: 'retain', label: 'Keep raw operations for', unit: 'days', min: 1, max: 365, step: 1, value: 30 },
    { id: 'docKB', label: 'Average document snapshot', unit: 'KB', min: 5, max: 500, step: 5, value: 50 },
    { id: 'docs', label: 'Documents stored', unit: 'billion', min: 0.1, max: 10, step: 0.1, value: 2 },
    { id: 'hotViewers', label: 'Viewers on the biggest document', unit: 'thousand', min: 1, max: 500, step: 1, value: 10 },
    { id: 'hotEditors', label: 'Editors typing in it', unit: '', min: 1, max: 50, step: 1, value: 5 },
    { id: 'peak', label: 'Peak-to-average ratio', unit: '×', min: 1, max: 6, step: 0.5, value: 2 },
  ];
  const REQS = [
    { id: 'coalesceOn', label: 'Coalesce keystrokes into one operation per window', value: true },
    { id: 'compact', label: 'Compact raw operations older than the retention window', value: true },
    { id: 'fanWorkers', label: 'Fan out hot documents through broadcast workers, not the sequencer', value: true },
    { id: 'durable', label: 'Acknowledge only after the operation log write', value: true },
  ];
  const CAP = {
    gw: { label: 'WebSocket gateways', per: 50000, unit: 'open connections each' },
    session: { label: 'Session servers', per: 20000, unit: 'ops/s each (sequencing and transform)' },
    oplog: { label: 'Operation-log shards', per: 10000, unit: 'appends/s each' },
    fanout: { label: 'Broadcast workers', per: 100000, unit: 'pushes/s each' },
    snap: { label: 'Snapshot workers', per: 200, unit: 'snapshots/s each' },
    presence: { label: 'Presence cache nodes', per: 200000, unit: 'writes/s each' },
  };
  const SCENARIOS = {
    normal: { label: 'Normal day', set: { dau: 50, conc: 10, typing: 10, hotViewers: 10, hotEditors: 5, peak: 2 } },
    exams: { label: 'Exam week', set: { dau: 80, conc: 20, typing: 20, hotViewers: 10, hotEditors: 5, peak: 3 } },
    viral: { label: 'A document goes viral', set: { dau: 50, conc: 10, typing: 10, hotViewers: 200, hotEditors: 20, peak: 2 } },
  };
  const AVAIL = { '99.9': 43.8, '99.95': 21.9, '99.99': 4.4 };

  function fmt(n, d) {
    if (n >= 1e12) return (n / 1e12).toFixed(d == null ? 1 : d) + ' trillion';
    if (n >= 1e9) return (n / 1e9).toFixed(d == null ? 1 : d) + ' billion';
    if (n >= 1e6) return (n / 1e6).toFixed(d == null ? 1 : d) + ' million';
    if (n >= 100) return Math.round(n).toLocaleString('en-US');
    return n.toFixed(d == null ? 1 : d);
  }

  function compute(v, r) {
    const users = v.dau * 1e6;
    const sessions = users * (v.conc / 100) * v.peak;
    const typists = sessions * (v.typing / 100);
    const keysPerSec = 4; // characters per second while typing
    const opsPerTypist = r.coalesceOn && v.coalesce > 0 ? Math.min(keysPerSec, 1000 / v.coalesce) : keysPerSec;
    const ops = typists * opsPerTypist;
    const pushes = ops * v.collab;
    const ingestBps = ops * v.opBytes;
    const ingestTBday = (ingestBps * 86400) / 1e12;
    const rawPBYear = (ingestTBday * 365) / 1000;
    const snapsPerSec = ops / v.snapEvery;
    const snapTBday = (snapsPerSec * v.docKB * 1000 * 86400) / 1e12;
    const histPBYear = r.compact ? (ingestTBday * v.retain + snapTBday * 365) / 1000 : rawPBYear + (snapTBday * 365) / 1000;
    const docsPB = (v.docs * 1e9 * v.docKB * 1000) / 1e15;
    const hotOps = v.hotEditors * opsPerTypist;
    const hotPushes = hotOps * v.hotViewers * 1000;
    const hotSeqLoad = r.fanWorkers ? hotOps : hotPushes; // what the single sequencer must emit per second
    const hotSeqSeconds = hotSeqLoad / 100000; // one server pushes ~100k/s: seconds of backlog per second of typing
    const servers = {
      gw: Math.ceil(sessions / CAP.gw.per),
      session: Math.ceil(ops / CAP.session.per),
      oplog: Math.ceil(ops / CAP.oplog.per),
      fanout: Math.ceil(pushes / CAP.fanout.per),
      snap: Math.ceil(snapsPerSec / CAP.snap.per),
      presence: Math.ceil((typists * 2) / CAP.presence.per),
    };
    const ackMs = r.durable ? 35 : 8;
    return { sessions, typists, opsPerTypist, ops, pushes, ingestBps, ingestTBday, rawPBYear, histPBYear, docsPB, snapsPerSec, hotOps, hotPushes, hotSeqLoad, hotSeqSeconds, servers, ackMs };
  }

  function insights(v, r, o) {
    const out = [];
    out.push(r.coalesceOn && v.coalesce > 0
      ? `Each typist sends about ${o.opsPerTypist.toFixed(1)} operations a second with a ${v.coalesce} ms coalescing window, so ${fmt(o.typists)} typists produce ${fmt(o.ops)} operations a second. Coalescing is the cheapest capacity lever there is.`
      : `Without coalescing every character is an operation: ${fmt(o.typists)} typists produce ${fmt(o.ops)} operations a second, each a round trip, a log append, and a broadcast.`);
    out.push(`Aggregate load shards perfectly by document id: ${o.servers.session} session servers and ${o.servers.oplog} log shards handle it with no coordination between documents. The hard limit is inside one document, where a single sequencer must order every operation.`);
    out.push(r.fanWorkers
      ? `The biggest document has ${fmt(v.hotViewers * 1000)} viewers and ${v.hotEditors} typists. Its sequencer emits ${fmt(o.hotOps)} operations a second to broadcast workers, which turn them into ${fmt(o.hotPushes)} pushes a second across ${Math.ceil(o.hotPushes / CAP.fanout.per)} workers. The typists’ acknowledgements stay fast.`
      : `The biggest document has ${fmt(v.hotViewers * 1000)} viewers and ${v.hotEditors} typists. Fanning out from the sequencer itself means it must push ${fmt(o.hotPushes)} messages a second: about ${o.hotSeqSeconds.toFixed(1)} seconds of work for every second of typing. Past 1.0 the editors’ own acknowledgements queue behind viewers’ pushes. This is the hot-document problem.`);
    out.push(r.compact
      ? `The log takes ${fmt(o.ingestTBday, 1)} TB of operations a day. Keeping raw operations for ${v.retain} days plus a snapshot every ${v.snapEvery} operations holds history at about ${fmt(o.histPBYear, 1)} PB a year instead of ${fmt(o.rawPBYear, 1)} PB. Version history older than ${v.retain} days is served from snapshots.`
      : `The log takes ${fmt(o.ingestTBday, 1)} TB of operations a day and nothing is ever compacted: about ${fmt(o.histPBYear, 1)} PB a year of history, most of it single keystrokes nobody will ever replay.`);
    out.push(`${fmt(v.docs * 1e9)} documents at ${v.docKB} KB each are ${fmt(o.docsPB, 1)} PB of current snapshots: smaller than a year of raw history. The history, not the documents, is the storage bill.`);
    out.push(`${fmt(o.sessions)} open sessions need ${o.servers.gw} gateways. Most connections are idle; the cost is memory and the reconnect storm when a gateway dies (see the connections lab).`);
    out.push(r.durable ? `Acknowledging after the log write puts about ${o.ackMs} ms of storage latency into “Saved”, invisible under optimistic local echo. In return an acknowledged edit is never lost.` : `Acknowledging before the log write makes “Saved” appear ${o.ackMs} ms after submit, and lets an acknowledged edit vanish if the write then fails. The end-to-end lab shows what that looks like.`);
    return out;
  }

  ui.mountDocsCapacity = function (pageId) {
    const main = ui.mountShell(pageId);
    const page = SDL.page(pageId);
    const vals = Object.fromEntries(INPUTS.map((i) => [i.id, i.value]));
    const reqs = Object.fromEntries(REQS.map((i) => [i.id, i.value]));
    let avail = '99.99';
    main.innerHTML = `
      <div class="lab-head">
        <h1>${esc(page.title)}</h1>
        <p class="lede">${esc(page.summary)}</p>
        <p class="disclaimer">Back-of-the-envelope estimates for learning, not Google’s figures. Per-server capacities are stated assumptions; real numbers depend on hardware, payload, and software.</p>
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
          <section class="panel panel-metrics" aria-labelledby="h-load"><h2 id="h-load">Load at peak <span class="sim-tag">Estimated</span></h2><dl class="metric-grid" data-ref="load"></dl></section>
          <section class="panel panel-diagram" aria-labelledby="h-srv"><h2 id="h-srv">Servers by component</h2><div data-ref="bars"></div><p class="surge-meta" data-ref="caps"></p></section>
          <section class="panel panel-ledger" aria-labelledby="h-ins"><h2 id="h-ins">What these numbers say</h2><ul class="ledger-notes" data-ref="insights"></ul><p class="recon" data-ref="avail"></p></section>
        </div>
      </div>`;
    const q = (s) => main.querySelector(s);
    function render() {
      for (const i of INPUTS) q(`[data-out="${i.id}"]`).textContent = `${vals[i.id]}${i.unit ? (i.unit.length <= 2 ? i.unit : ' ' + i.unit) : ''}`;
      main.querySelectorAll('[data-avail]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.avail === avail)));
      const o = compute(vals, reqs);
      const tile = (label, value, hint, tone) => `<div class="metric"${tone ? ` data-tone="${tone}"` : ''}><dt>${esc(label)}</dt><dd>${esc(value)}</dd>${hint ? `<p class="metric-hint">${esc(hint)}</p>` : ''}</div>`;
      const hot = !reqs.fanWorkers && o.hotSeqSeconds > 1;
      q('[data-ref="load"]').innerHTML =
        tile('Open sessions', fmt(o.sessions), `${fmt(o.typists)} typing`) +
        tile('Operations per second', fmt(o.ops), `${o.opsPerTypist.toFixed(1)} per typist`) +
        tile('Pushes to collaborators per second', fmt(o.pushes)) +
        tile('Biggest document: sequencer output', `${fmt(o.hotSeqLoad)}/s`, reqs.fanWorkers ? '✓ operations to workers, pushes elsewhere' : `✕ ${o.hotSeqSeconds.toFixed(1)} s of pushes per second of typing`, hot ? 'fail' : reqs.fanWorkers ? 'ok' : 'warn') +
        tile('Operation log ingest', `${fmt(o.ingestBps / 1e6, 1)} MB/s`, `${fmt(o.ingestTBday, 1)} TB a day`) +
        tile('History per year', `${fmt(o.histPBYear, 1)} PB`, reqs.compact ? `raw would be ${fmt(o.rawPBYear, 1)} PB` : 'nothing compacted', reqs.compact ? '' : 'warn') +
        tile('Current documents', `${fmt(o.docsPB, 1)} PB`) +
        tile('Snapshots per second', fmt(o.snapsPerSec, 0));
      const max = Math.max(...Object.values(o.servers), 1);
      const top = Object.entries(o.servers).sort((a, b) => b[1] - a[1])[0][0];
      q('[data-ref="bars"]').innerHTML = `<div class="cap-bars">${Object.entries(o.servers).map(([k, n]) => `
        <div class="cap-bar${k === top ? ' is-top' : ''}"><span class="cap-label">${esc(CAP[k].label)}</span><span class="cap-track"><i style="width:${(n / max) * 100}%"></i></span><span class="cap-n">${n}</span></div>`).join('')}</div>`;
      q('[data-ref="caps"]').textContent = 'Assumed capacity: ' + Object.values(CAP).map((c) => `${c.label.toLowerCase()} ${c.per.toLocaleString('en-US')} ${c.unit}`).join('; ') + '. More servers do not help one document: its operations must pass through one sequencer in order.';
      q('[data-ref="insights"]').innerHTML = insights(vals, reqs, o).map((t) => `<li>${esc(t)}</li>`).join('');
      q('[data-ref="avail"]').textContent = `${avail}% availability allows about ${AVAIL[avail]} minutes of downtime per month${avail === '99.99' ? ': too little for manual recovery, so a session server that dies must be replaced by another rebuilding from the log automatically.' : avail === '99.9' ? '. A noticeable outage every month.' : ', roughly one short incident.'}`;
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
