/*
 * Email: requirements and capacity.
 * A live back-of-the-envelope calculator. Accounts and mail per user set the
 * mailbox write rate; the spam multiplier sets how many SMTP attempts arrive
 * at the edge (most of them unwanted); message size and the durability scheme
 * turn delivered mail into raw storage a year. Storage growth and spam-driven
 * inbound are the two numbers that shape the design.
 */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;
  const esc = ui.esc;

  const INPUTS = [
    { id: 'accounts', label: 'Accounts', unit: 'million', min: 10, max: 3000, step: 10, value: 1800 },
    { id: 'mau', label: 'Accounts active each month', unit: '%', min: 10, max: 100, step: 5, value: 65 },
    { id: 'dau', label: 'Accounts active each day', unit: '%', min: 5, max: 80, step: 5, value: 35 },
    { id: 'recv', label: 'Wanted mail received per active user a day', unit: '', min: 1, max: 200, step: 1, value: 30 },
    { id: 'spam', label: 'SMTP attempts per wanted message (spam multiplier)', unit: '×', min: 1, max: 10, step: 0.5, value: 3 },
    { id: 'sent', label: 'Mail sent per daily user a day', unit: '', min: 0, max: 50, step: 1, value: 5 },
    { id: 'sizeKB', label: 'Average stored size, attachments included', unit: 'KB', min: 5, max: 1000, step: 5, value: 75 },
    { id: 'peak', label: 'Peak-to-average ratio', unit: '×', min: 1, max: 6, step: 0.5, value: 2 },
    { id: 'opens', label: 'Inbox and thread opens per daily user', unit: '', min: 1, max: 200, step: 1, value: 20 },
    { id: 'searches', label: 'Searches per daily user', unit: '', min: 0, max: 20, step: 0.5, value: 1 },
    { id: 'connected', label: 'Daily users holding a push connection', unit: '%', min: 0, max: 100, step: 5, value: 50 },
    { id: 'perGw', label: 'Connections per push gateway', unit: 'thousand', min: 10, max: 1000, step: 10, value: 100 },
    { id: 'years', label: 'Years of mail kept', unit: 'years', min: 1, max: 20, step: 1, value: 5 },
    { id: 'price', label: 'Raw disk cost', unit: '$/TB-month', min: 1, max: 20, step: 0.5, value: 4 },
  ];
  const REQS = [
    { id: 'ec', label: 'Erasure-code mail older than 30 days (about 1.5× instead of 3 copies)', value: true },
    { id: 'early', label: 'Reject most spam at connection or RCPT time, before DATA (reputation)', value: true },
    { id: 'index', label: 'Keep a per-user search index (about 30% of the mail size)', value: true },
    { id: 'single', label: 'Store list attachments once and reference them (about 15% saved)', value: true },
  ];
  const SCENARIOS = {
    big: { label: 'Global email service', set: { accounts: 1800, mau: 65, dau: 35, recv: 30, spam: 3, sizeKB: 75, years: 5 } },
    young: { label: 'New service, year one', set: { accounts: 20, mau: 80, dau: 50, recv: 20, spam: 3, sizeKB: 75, years: 1 } },
    flood: { label: 'Spam wave', set: { accounts: 1800, spam: 10 } },
  };
  const AVAIL = { '99.9': 525, '99.99': 52.6, '99.999': 5.26 };
  const META_BYTES = 600; // one message row with its labels and history entry
  const EARLY_SHARE = 0.8; // spam turned away before DATA when early rejection is on

  function fmt(n, d) {
    if (n >= 1e12) return (n / 1e12).toFixed(d == null ? 1 : d) + ' trillion';
    if (n >= 1e9) return (n / 1e9).toFixed(d == null ? 1 : d) + ' billion';
    if (n >= 1e6) return (n / 1e6).toFixed(d == null ? 1 : d) + ' million';
    if (n >= 1000) return Math.round(n).toLocaleString('en-US');
    return n.toFixed(d == null ? 1 : d);
  }
  const bytes = (b) => (b >= 1e18 ? (b / 1e18).toFixed(1) + ' EB' : b >= 1e15 ? (b / 1e15).toFixed(1) + ' PB' : b >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(1) + ' MB');
  const bps = (b) => (b >= 1e12 ? (b / 1e12).toFixed(1) + ' Tbps' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' Gbps' : (b / 1e6).toFixed(0) + ' Mbps');
  const money = (d) => (d >= 1e9 ? '$' + (d / 1e9).toFixed(1) + ' billion' : d >= 1e6 ? '$' + (d / 1e6).toFixed(0) + ' million' : '$' + Math.round(d).toLocaleString('en-US'));
  const rate = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : fmt(n, 0));

  function compute(v, r) {
    const accounts = v.accounts * 1e6;
    const mau = accounts * (v.mau / 100);
    const dau = accounts * (v.dau / 100);
    const wanted = mau * v.recv; // delivered to mailboxes a day
    const attempts = wanted * v.spam; // SMTP attempts at the edge a day
    const spamDay = attempts - wanted;
    const dataSpam = r.early ? spamDay * (1 - EARLY_SHARE) : spamDay; // spam that gets as far as DATA
    const sentDay = dau * v.sent;
    const writes = wanted + sentDay; // mailbox inserts (received + Sent copies)
    const writesAvg = writes / 86400;
    const writesPeak = writesAvg * v.peak;
    const smtpAvg = attempts / 86400;
    const smtpPeak = smtpAvg * v.peak;
    const classify = (wanted + dataSpam) / 86400 * v.peak; // messages scored per second at peak
    const size = v.sizeKB * 1e3;
    const ingestBytes = (wanted + dataSpam) * size; // bytes that cross the edge after DATA
    const ingestBps = (ingestBytes * 8) / 86400;
    const singleF = r.single ? 0.85 : 1;
    const logicalDay = writes * size * singleF;
    const logicalYear = logicalDay * 365;
    const total = logicalYear * v.years;
    const hot = Math.min(total, logicalDay * 30);
    const warm = total - hot;
    const raw = hot * 3 + warm * (r.ec ? 1.5 : 3);
    const raw3 = total * 3;
    const indexBytes = r.index ? total * 0.3 * 3 : 0;
    const meta = writes * 365 * v.years * META_BYTES * 3;
    const disk = raw + indexBytes + meta;
    const costYear = (disk / 1e12) * v.price * 12;
    const cost3 = ((raw3 + indexBytes + meta) / 1e12) * v.price * 12;
    const reads = (dau * v.opens) / 86400 * v.peak;
    const searches = (dau * v.searches) / 86400 * v.peak;
    const conns = dau * (v.connected / 100);
    const gateways = Math.ceil(conns / (v.perGw * 1e3));
    const perUserYear = (logicalYear / Math.max(1, mau));
    return { accounts, mau, dau, wanted, attempts, spamDay, dataSpam, sentDay, writes, writesAvg, writesPeak, smtpAvg, smtpPeak, classify, ingestBytes, ingestBps, logicalYear, total, raw, raw3, indexBytes, meta, disk, costYear, cost3, reads, searches, conns, gateways, perUserYear };
  }

  function insights(v, r, o) {
    const out = [];
    out.push(`${fmt(o.mau)} monthly users receiving ${v.recv} wanted messages a day is ${fmt(o.wanted)} deliveries, plus ${fmt(o.sentDay)} Sent copies: ${rate(o.writesAvg)} mailbox writes a second on average, ${rate(o.writesPeak)} at a ${v.peak}× peak. Each write touches one user’s mailbox, so sharding by user keeps every write local and every mailbox serializable.`);
    out.push(`At the edge it looks very different: ${v.spam}× as many SMTP attempts, ${rate(o.smtpPeak)} a second at peak, and ${fmt(o.spamDay)} of them a day are unwanted. ${r.early ? `Turning away about ${Math.round(EARLY_SHARE * 100)}% of the spam at connection or RCPT time, on reputation alone, means only ${fmt(o.dataSpam)} spam messages a day get as far as DATA and the classifier.` : 'Without early rejection every spam message is received in full and scored: turn it on to see what reputation at connection time saves.'} The classifier scores ${rate(o.classify)} messages a second at peak, which makes inbound filtering the largest compute cost.`);
    out.push(`Storage is the number that shapes the cost: ${bytes(o.logicalYear)} of new mail a year${r.single ? ' after storing list attachments once' : ''}, about ${bytes(o.perUserYear)} per active user, and ${bytes(o.total)} over ${v.years} years because mail is rarely deleted. ${r.ec ? `Keeping the last 30 days on three copies and erasure-coding the rest brings raw disk for messages to ${bytes(o.raw)} instead of ${bytes(o.raw3)}.` : `With three copies of everything that is ${bytes(o.raw)} of raw disk.`} With indexes and metadata the bill is about ${money(o.costYear)} a year at $${v.price}/TB-month.`);
    out.push(r.index ? `The search index adds ${bytes(o.indexBytes)} of disk. It is partitioned by user, so a query reads one user’s shard; ${rate(o.searches)} searches a second at peak is light next to the indexing work, which follows every mailbox write.` : 'Without a search index, every search scans the mailbox: cheap on disk, slow for anyone with years of mail.');
    out.push(`Reads are modest: ${rate(o.reads)} inbox and thread opens a second at peak, mostly recent mail, which a cache of each user’s first page absorbs.`);
    out.push(`${fmt(o.conns)} phones and tabs hold a push connection. At ${v.perGw} thousand per gateway that is ${fmt(o.gateways, 0)} gateways. A push only hints “your mailbox changed”; the device then fetches every change since its history id, so a lost hint delays mail but never loses it.`);
    out.push(`Ingest bandwidth after DATA is ${bps(o.ingestBps)} on average (${bytes(o.ingestBytes)} a day). Message bodies dominate; metadata is ${bytes(o.meta)} over ${v.years} years with replicas, small next to the bodies.`);
    return out;
  }

  ui.mountGmCapacity = function (pageId) {
    const main = ui.mountShell(pageId);
    const page = SDL.page(pageId);
    const vals = Object.fromEntries(INPUTS.map((i) => [i.id, i.value]));
    const reqs = Object.fromEntries(REQS.map((i) => [i.id, i.value]));
    let avail = '99.9';
    main.innerHTML = `
      <div class="lab-head">
        <h1>${esc(page.title)}</h1>
        <p class="lede">${esc(page.summary)}</p>
        <p class="disclaimer">Back-of-the-envelope estimates for learning. Gmail has said it has more than 1.8 billion accounts; the mail per user, spam multiplier, sizes, prices, and ratios are stated assumptions, not any company’s internals.</p>
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
          <h3 class="subhead">Availability target for reading mail</h3>
          <div class="ops-traffic" role="group" aria-label="Availability">${Object.keys(AVAIL).map((a) => `<button class="btn ops-tbtn" data-avail="${a}">${a}%</button>`).join('')}</div>
        </section>
        <div class="lab-main">
          <section class="panel panel-metrics" aria-labelledby="h-load"><h2 id="h-load">Sizing <span class="sim-tag">Estimated</span></h2><dl class="metric-grid" data-ref="load"></dl></section>
          <section class="panel panel-diagram" aria-labelledby="h-srv"><h2 id="h-srv">Raw disk over the retention period</h2><div data-ref="store"></div><p class="surge-meta" data-ref="caps"></p><h3 class="subhead">Per second at peak</h3><div data-ref="bars"></div></section>
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
        tile('Mail delivered a day', fmt(o.wanted), `${rate(o.writesPeak)}/s mailbox writes at peak`) +
        tile('SMTP attempts at peak', `${rate(o.smtpPeak)}/s`, `${fmt(o.spamDay)} unwanted a day`, 'warn') +
        tile('Classifier at peak', `${rate(o.classify)}/s`, 'messages scored', 'warn') +
        tile('New mail a year', bytes(o.logicalYear), `${bytes(o.perUserYear)} per active user`, 'warn') +
        tile('Raw disk', bytes(o.disk), `${vals.years} years, indexes and replicas included`, 'fail') +
        tile('Disk bill a year', money(o.costYear), `at $${vals.price}/TB-month`, 'fail') +
        tile('Push connections', fmt(o.conns), `${fmt(o.gateways, 0)} gateways`) +
        tile('Ingest bandwidth', bps(o.ingestBps), `${bytes(o.ingestBytes)} a day after DATA`);
      const store = { 'Three copies of all mail': o.raw3, 'Mail on the chosen scheme': o.raw, 'Search index': o.indexBytes, 'Metadata and history': o.meta };
      const smax = Math.max(...Object.values(store), 1);
      q('[data-ref="store"]').innerHTML = `<div class="cap-bars is-wide">${Object.entries(store).map(([k, b], i) => `<div class="cap-bar${i === 0 ? ' is-top' : ''}"><span class="cap-label">${esc(k)}</span><span class="cap-track"><i style="width:${(b / smax) * 100}%"></i></span><span class="cap-n">${bytes(b)}</span></div>`).join('')}</div>`;
      q('[data-ref="caps"]').textContent = 'Recent mail is read most, so it stays on full copies where any replica can serve it. Older mail moves to Reed–Solomon chunks, readable as long as enough chunks survive. Neither protects against software that deletes mail on every copy: that needs offline backups.';
      const bars = { 'SMTP attempts': o.smtpPeak, 'Classifier': o.classify, 'Mailbox writes': o.writesPeak, 'Inbox and thread opens': o.reads, 'Searches': o.searches };
      const max = Math.max(...Object.values(bars), 1);
      const topBar = Object.entries(bars).sort((a, b) => b[1] - a[1])[0][0];
      q('[data-ref="bars"]').innerHTML = `<div class="cap-bars is-wide">${Object.entries(bars).map(([k, n]) => `
        <div class="cap-bar${k === topBar ? ' is-top' : ''}"><span class="cap-label">${esc(k)}</span><span class="cap-track"><i style="width:${(n / max) * 100}%"></i></span><span class="cap-n">${rate(n)}/s</span></div>`).join('')}</div>`;
      q('[data-ref="insights"]').innerHTML = insights(vals, reqs, o).map((t) => `<li>${esc(t)}</li>`).join('');
      q('[data-ref="avail"]').textContent = `${avail}% allows about ${AVAIL[avail]} minutes a year when mail cannot be read. Receiving is different: while Gmail answers other servers with a temporary failure (4xx) they keep the mail and retry for days, so an inbound outage delays mail rather than losing it. Durability is a separate promise again: a message that got a 250 must never be lost.`;
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
