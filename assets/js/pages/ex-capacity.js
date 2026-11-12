/*
 * Stock exchange: requirements and capacity.
 * A live back-of-the-envelope calculator. Per-component capacities are stated
 * assumptions, not measurements. Two numbers shape this design: the
 * microseconds one single-threaded engine gets per message on the hottest
 * symbol, and the bandwidth market data would need if it were sent to every
 * member separately instead of once by multicast.
 */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;
  const esc = ui.esc;

  const INPUTS = [
    { id: 'msgs', label: 'Order messages per day (new, cancel, replace)', unit: 'billion', min: 0.5, max: 50, step: 0.5, value: 10 },
    { id: 'otr', label: 'Order-to-trade ratio', unit: ':1', min: 5, max: 500, step: 5, value: 200 },
    { id: 'hours', label: 'Trading session', unit: 'hours', min: 1, max: 24, step: 0.5, value: 6.5 },
    { id: 'peak', label: 'Peak-to-average ratio (open, close, news)', unit: '×', min: 1, max: 10, step: 0.5, value: 3.5 },
    { id: 'symbols', label: 'Symbols listed', unit: '', min: 500, max: 20000, step: 500, value: 8000 },
    { id: 'partitions', label: 'Engine partitions (one thread each)', unit: '', min: 1, max: 64, step: 1, value: 16 },
    { id: 'hot', label: 'Hottest symbol’s share of peak traffic', unit: '%', min: 1, max: 60, step: 1, value: 7 },
    { id: 'members', label: 'Feed subscribers (members, vendors)', unit: '', min: 50, max: 5000, step: 50, value: 1000 },
    { id: 'mdBytes', label: 'Bytes per feed message', unit: 'B', min: 16, max: 200, step: 4, value: 40 },
    { id: 'jBytes', label: 'Bytes per journal entry', unit: 'B', min: 40, max: 400, step: 10, value: 100 },
    { id: 'retain', label: 'Journal retention', unit: 'years', min: 1, max: 10, step: 1, value: 7 },
    { id: 'resting', label: 'Resting orders per symbol', unit: 'thousand', min: 1, max: 200, step: 1, value: 50 },
  ];
  const REQS = [
    { id: 'multicast', label: 'Market data by multicast (one copy for everyone)', value: true },
    { id: 'journalFirst', label: 'Journal and replicate before acknowledging', value: true },
    { id: 'hotStandby', label: 'Hot standby applies the same stream (no replay on failover)', value: true },
    { id: 'isolate', label: 'Give the hottest symbol its own partition', value: true },
  ];
  const CAP = {
    gateways: { label: 'Order entry gateways', per: 200000, unit: 'messages/s each' },
    engines: { label: 'Engine partitions needed', per: 150000, unit: 'messages/s per single thread' },
    publishers: { label: 'Feed publishers', per: 10, unit: 'Gbps each' },
    journal: { label: 'Journal nodes', per: 1, unit: 'GB/s each' },
    tradecap: { label: 'Trade capture workers', per: 20000, unit: 'trades/s each' },
  };
  const SCENARIOS = {
    normal: { label: 'Normal day', set: { msgs: 10, peak: 3.5, hot: 7, members: 1000 } },
    meme: { label: 'Meme stock', set: { msgs: 14, peak: 5, hot: 35, members: 1000 } },
    witching: { label: 'Index rebalance close', set: { msgs: 16, peak: 7, hot: 7, members: 1500 } },
  };
  const AVAIL = { '99.99': 1.4, '99.999': 0.14, '99.9999': 0.014 }; // minutes per year of session time lost (6.5 h × 252 days)

  function fmt(n, d) {
    if (n >= 1e12) return (n / 1e12).toFixed(d == null ? 1 : d) + ' trillion';
    if (n >= 1e9) return (n / 1e9).toFixed(d == null ? 1 : d) + ' billion';
    if (n >= 1e6) return (n / 1e6).toFixed(d == null ? 1 : d) + ' million';
    if (n >= 100) return Math.round(n).toLocaleString('en-US');
    return n.toFixed(d == null ? 1 : d);
  }

  function compute(v, r) {
    const msgsDay = v.msgs * 1e9;
    const session = v.hours * 3600;
    const avg = msgsDay / session;
    const peak = avg * v.peak;
    const tradesDay = msgsDay / v.otr;
    const tradesPeak = peak / v.otr;
    const perPartition = peak / v.partitions;
    const hotRate = peak * (v.hot / 100);
    const hotPartitionRate = r.isolate ? hotRate : hotRate + (peak - hotRate) / v.partitions; // the hot symbol's partition also carries its share of everything else
    const budgetUs = 1e6 / hotPartitionRate;
    const feedMsgs = peak; // one feed message per book change
    const feedGbps = (feedMsgs * v.mdBytes * 8) / 1e9;
    const unicastGbps = feedGbps * v.members;
    const egressGbps = r.multicast ? feedGbps : unicastGbps;
    const journalTBday = (msgsDay * v.jBytes) / 1e12;
    const journalPB = (journalTBday * 252 * v.retain) / 1000;
    const bookGB = (v.symbols * v.resting * 1000 * 64) / 1e9;
    const latency = [
      ['Gateway: decode, validate, session', 5],
      ['Pre-trade risk', 3],
      ['Sequencer: stamp', 1],
      [r.journalFirst ? 'Journal and replicate, then ack' : 'Journal later (async)', r.journalFirst ? 20 : 0],
      ['Match', 5],
      ['Publish execution report and feed', 4],
    ];
    const totalUs = latency.reduce((s, x) => s + x[1], 0);
    const replaySeconds = r.hotStandby ? 0 : (msgsDay * 0.5) / 2e6; // half a day of journal at 2 million entries/s
    const servers = {
      gateways: Math.ceil(peak / CAP.gateways.per),
      engines: Math.max(v.partitions, Math.ceil(hotPartitionRate / CAP.engines.per) * (r.isolate ? 1 : v.partitions)),
      publishers: Math.ceil(egressGbps / CAP.publishers.per),
      journal: Math.max(1, Math.ceil((peak * v.jBytes) / 1e9 / CAP.journal.per) * 3),
      tradecap: Math.max(1, Math.ceil(tradesPeak / CAP.tradecap.per)),
    };
    return { msgsDay, avg, peak, tradesDay, tradesPeak, perPartition, hotRate, hotPartitionRate, budgetUs, feedGbps, unicastGbps, egressGbps, journalTBday, journalPB, bookGB, latency, totalUs, replaySeconds, servers };
  }

  function insights(v, r, o) {
    const out = [];
    out.push(`${fmt(o.msgsDay)} messages over a ${v.hours}-hour session is ${fmt(o.avg)} a second on average and ${fmt(o.peak)} a second at the peak. Only ${fmt(o.tradesDay)} of them become trades (${v.otr}:1): the system is sized for orders and cancels, not for fills.`);
    out.push(o.budgetUs < 7
      ? `The hottest symbol pushes ${fmt(o.hotPartitionRate)} messages a second through one single-threaded engine: ${o.budgetUs.toFixed(1)} µs per message. That is below what a journaling engine sustains; the answer is not more threads on that book (ordering forbids it) but a leaner hot path, or shedding and throttling at the gateway.`
      : `The hottest symbol’s partition sees ${fmt(o.hotPartitionRate)} messages a second: ${o.budgetUs.toFixed(1)} µs per message for one thread${r.isolate ? ', with nothing else sharing it' : `, and every other symbol on that partition waits behind it (turn on isolation to see the difference)`}. One book must be one thread, so this budget, not total volume, is the design constraint.`);
    out.push(r.multicast
      ? `The feed is ${fmt(o.feedGbps, 2)} Gbps at peak, sent once by multicast and received by all ${fmt(v.members, 0)} subscribers at the same moment. Unicast would be ${fmt(o.unicastGbps)} Gbps and would reach the nearest member first.`
      : `Sending the feed to ${fmt(v.members, 0)} subscribers separately is ${fmt(o.unicastGbps)} Gbps at peak, and the first subscriber served sees the price before the last. Multicast sends ${fmt(o.feedGbps, 2)} Gbps once.`);
    out.push(r.journalFirst
      ? `Order to acknowledgement is about ${o.totalUs} µs inside the venue, of which 20 µs is writing the message to the journal and a replica before anyone is told. That is the price of never losing an acknowledged order.`
      : `Order to acknowledgement is about ${o.totalUs} µs because the journal is written after the ack. A crash in that window loses acknowledged orders; the sequencer lab shows what that looks like.`);
    out.push(r.hotStandby
      ? 'A hot standby applies the same sequenced stream, so failover is a leadership change at the next sequence number: no replay.'
      : `A cold standby must replay the journal before it can trade: about ${fmt(o.replaySeconds, 0)} s for half a day at 2 million entries a second, with the market halted. Snapshots cut the tail but not the halt.`);
    out.push(`The journal grows by ${fmt(o.journalTBday, 1)} TB a day; ${v.retain} years of sessions is ${fmt(o.journalPB, 1)} PB. The whole book is only ${fmt(o.bookGB, 0)} GB in memory: the engine never touches a database.`);
    if (v.hot >= 25) out.push('A meme-stock day: one symbol is a quarter or more of all traffic. Isolation keeps the other symbols fast; per-participant throttles and a reject-over-queue policy keep that one symbol answering at all.');
    return out;
  }

  ui.mountExCapacity = function (pageId) {
    const main = ui.mountShell(pageId);
    const page = SDL.page(pageId);
    const vals = Object.fromEntries(INPUTS.map((i) => [i.id, i.value]));
    const reqs = Object.fromEntries(REQS.map((i) => [i.id, i.value]));
    let avail = '99.999';
    main.innerHTML = `
      <div class="lab-head">
        <h1>${esc(page.title)}</h1>
        <p class="lede">${esc(page.summary)}</p>
        <p class="disclaimer">Back-of-the-envelope estimates for learning, not Nasdaq’s figures. Per-component capacities are stated assumptions; real numbers depend on hardware, protocol, and software.</p>
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
          <h3 class="subhead">Availability target (session time)</h3>
          <div class="ops-traffic" role="group" aria-label="Availability">${Object.keys(AVAIL).map((a) => `<button class="btn ops-tbtn" data-avail="${a}">${a}%</button>`).join('')}</div>
        </section>
        <div class="lab-main">
          <section class="panel panel-metrics" aria-labelledby="h-load"><h2 id="h-load">Load at peak <span class="sim-tag">Estimated</span></h2><dl class="metric-grid" data-ref="load"></dl></section>
          <section class="panel panel-diagram" aria-labelledby="h-srv"><h2 id="h-srv">Servers by component</h2><div data-ref="bars"></div><p class="surge-meta" data-ref="caps"></p><h3 class="subhead">Latency budget, order to acknowledgement</h3><div data-ref="lat"></div></section>
          <section class="panel panel-ledger" aria-labelledby="h-ins"><h2 id="h-ins">What these numbers say</h2><ul class="ledger-notes" data-ref="insights"></ul><p class="recon" data-ref="avail"></p></section>
        </div>
      </div>`;
    const q = (s) => main.querySelector(s);
    function render() {
      for (const i of INPUTS) q(`[data-out="${i.id}"]`).textContent = `${vals[i.id]}${i.unit ? (i.unit.length <= 2 ? i.unit : ' ' + i.unit) : ''}`;
      main.querySelectorAll('[data-avail]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.avail === avail)));
      const o = compute(vals, reqs);
      const tile = (label, value, hint, tone) => `<div class="metric"${tone ? ` data-tone="${tone}"` : ''}><dt>${esc(label)}</dt><dd>${esc(value)}</dd>${hint ? `<p class="metric-hint">${esc(hint)}</p>` : ''}</div>`;
      const tight = o.budgetUs < 7;
      q('[data-ref="load"]').innerHTML =
        tile('Messages per second', fmt(o.peak), `${fmt(o.avg)} average`) +
        tile('Trades per second', fmt(o.tradesPeak), `${fmt(o.tradesDay)} a day`) +
        tile('Hottest partition', `${fmt(o.hotPartitionRate)} msg/s`, `${o.budgetUs.toFixed(1)} µs per message, one thread`, tight ? 'fail' : 'warn') +
        tile('Feed egress at peak', `${fmt(o.egressGbps, 2)} Gbps`, reqs.multicast ? `unicast would be ${fmt(o.unicastGbps)} Gbps` : '✕ unicast to every subscriber', reqs.multicast ? 'ok' : 'fail') +
        tile('Order to ack', `${o.totalUs} µs`, reqs.journalFirst ? 'journal and replica before ack' : '✕ ack before durable write', reqs.journalFirst ? 'ok' : 'fail') +
        tile('Failover replay', reqs.hotStandby ? 'none' : `${fmt(o.replaySeconds, 0)} s`, reqs.hotStandby ? 'hot standby already applied the stream' : 'market halted while the journal replays', reqs.hotStandby ? 'ok' : 'warn') +
        tile('Journal per day', `${fmt(o.journalTBday, 1)} TB`, `${fmt(o.journalPB, 1)} PB over ${vals.retain} years`) +
        tile('Book in memory', `${fmt(o.bookGB, 0)} GB`, `${fmt(vals.symbols, 0)} symbols × ${vals.resting}k resting orders`);
      const max = Math.max(...Object.values(o.servers), 1);
      const top = Object.entries(o.servers).sort((a, b) => b[1] - a[1])[0][0];
      q('[data-ref="bars"]').innerHTML = `<div class="cap-bars">${Object.entries(o.servers).map(([k, n]) => `
        <div class="cap-bar${k === top ? ' is-top' : ''}"><span class="cap-label">${esc(CAP[k].label)}</span><span class="cap-track"><i style="width:${(n / max) * 100}%"></i></span><span class="cap-n">${n}</span></div>`).join('')}</div>`;
      q('[data-ref="caps"]').textContent = 'Assumed capacity: ' + Object.values(CAP).map((c) => `${c.label.toLowerCase()} ${c.per.toLocaleString('en-US')} ${c.unit}`).join('; ') + '. Journal nodes are counted three times for replication. More engine threads never help one symbol: its messages must be applied in one order.';
      const lmax = Math.max(...o.latency.map((x) => x[1]), 1);
      q('[data-ref="lat"]').innerHTML = `<div class="cap-bars">${o.latency.map(([label, us]) => `<div class="cap-bar"><span class="cap-label">${esc(label)}</span><span class="cap-track"><i style="width:${(us / lmax) * 100}%"></i></span><span class="cap-n">${us} µs</span></div>`).join('')}</div>`;
      q('[data-ref="insights"]').innerHTML = insights(vals, reqs, o).map((t) => `<li>${esc(t)}</li>`).join('');
      q('[data-ref="avail"]').textContent = `${avail}% of session time allows about ${AVAIL[avail]} minutes of halted trading a year${avail === '99.9999' ? ': failover must be automatic and sub-second, which is why the standby is hot and the sequencer is replicated.' : avail === '99.999' ? ': one short automatic failover. A cold replay would spend the whole budget at once.' : ': a few short incidents a year, or one manual recovery.'}`;
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
