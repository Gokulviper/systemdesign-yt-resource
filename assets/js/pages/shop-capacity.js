/*
 * E-commerce: requirements and capacity.
 * A live back-of-the-envelope calculator. Every input recomputes every output;
 * per-server capacities are stated assumptions, not measurements. The point is
 * to find the number that shapes the design: here, writes per second on the
 * single inventory row of a product in a flash sale.
 */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;
  const esc = ui.esc;

  const INPUTS = [
    { id: 'dau', label: 'Daily active shoppers', unit: 'million', min: 1, max: 200, step: 1, value: 50 },
    { id: 'searches', label: 'Searches per shopper per day', unit: '', min: 1, max: 40, step: 1, value: 10 },
    { id: 'views', label: 'Product page views per shopper per day', unit: '', min: 1, max: 60, step: 1, value: 20 },
    { id: 'adds', label: 'Cart edits per shopper per day', unit: '', min: 0.2, max: 10, step: 0.2, value: 2 },
    { id: 'conversion', label: 'Shoppers who order each day', unit: '%', min: 1, max: 40, step: 1, value: 10 },
    { id: 'peak', label: 'Peak-to-average ratio', unit: '×', min: 1, max: 30, step: 1, value: 5 },
    { id: 'drop', label: 'Shoppers in a single-product drop', unit: 'thousand', min: 10, max: 5000, step: 10, value: 1000 },
    { id: 'window', label: 'Seconds in which they all try', unit: 's', min: 5, max: 600, step: 5, value: 60 },
    { id: 'lock', label: 'Time one stock update holds the row', unit: 'ms', min: 0.2, max: 10, step: 0.1, value: 1.5 },
    { id: 'page', label: 'Bytes per product page (mostly images)', unit: 'KB', min: 100, max: 4000, step: 100, value: 1000 },
    { id: 'retention', label: 'Order history kept', unit: 'years', min: 1, max: 10, step: 1, value: 7 },
  ];
  const REQS = [
    { id: 'cdn', label: 'Serve images and static pages from a CDN', value: true },
    { id: 'multi', label: 'Active-active in two regions', value: false },
    { id: 'buckets', label: 'Split a hot product’s stock into 10 buckets', value: false },
    { id: 'room', label: 'Admit drop shoppers through a waiting room', value: false },
  ];
  const CAP = {
    search: { label: 'Search nodes', per: 1000, unit: 'queries/s each, 3 replicas' },
    api: { label: 'Store API servers', per: 5000, unit: 'requests/s each' },
    cart: { label: 'Cart store nodes', per: 20000, unit: 'operations/s each' },
    orders: { label: 'Order database primaries', per: 2000, unit: 'writes/s each, about 6 writes per order' },
    notify: { label: 'Notification workers', per: 2000, unit: 'messages/s each' },
    origin: { label: 'Image origin servers', per: 10, unit: 'Gbps each' },
  };
  const SCENARIOS = {
    normal: { label: 'Normal day', set: { dau: 50, conversion: 10, peak: 5, drop: 50, window: 300 } },
    black: { label: 'Black Friday', set: { dau: 120, conversion: 20, peak: 20, drop: 500, window: 120 } },
    drop: { label: 'Single-product drop', set: { dau: 50, conversion: 10, peak: 5, drop: 1000, window: 60 } },
  };
  const AVAIL = { '99.9': 43.8, '99.95': 21.9, '99.99': 4.4 };

  function fmt(n, d) {
    if (n >= 1e9) return (n / 1e9).toFixed(d == null ? 1 : d) + ' billion';
    if (n >= 1e6) return (n / 1e6).toFixed(d == null ? 1 : d) + ' million';
    if (n >= 100) return Math.round(n).toLocaleString('en-US');
    return n.toFixed(d == null ? 1 : d);
  }

  function compute(v, r) {
    const shoppers = v.dau * 1e6;
    const day = 86400;
    const peak = (perDay) => (perDay / day) * v.peak;
    const searchQps = peak(shoppers * v.searches);
    const viewRps = peak(shoppers * v.views);
    const cartRps = peak(shoppers * v.adds);
    const ordersDay = shoppers * (v.conversion / 100);
    const orderRps = peak(ordersDay);
    const notifyRps = orderRps * 5;
    const regions = r.multi ? 2 : 1;
    const dropRps = (v.drop * 1000) / v.window;
    const rowCap = (1000 / v.lock) * (r.buckets ? 10 : 1);
    const admitted = r.room ? Math.min(dropRps, rowCap * 0.8) : dropRps;
    const egressGbps = (viewRps * v.page * 1000 * 8) / 1e9;
    const originGbps = r.cdn ? egressGbps * 0.05 : egressGbps;
    const ordersTB = (ordersDay * 365 * v.retention * 6000 * 3 * regions) / 1e12;
    const ledgerTB = (ordersDay * 365 * v.retention * 4 * 200 * 3 * regions) / 1e12;
    const cartGB = (shoppers * 2 * 2000) / 1e9;
    const servers = {
      search: Math.ceil(searchQps / CAP.search.per) * 3 * regions,
      api: Math.ceil((viewRps + cartRps + orderRps * 10 + searchQps) / CAP.api.per) * regions,
      cart: Math.ceil(cartRps * 3 / CAP.cart.per) * regions,
      orders: Math.max(1, Math.ceil((orderRps * 6) / CAP.orders.per)) * regions,
      notify: Math.ceil(notifyRps / CAP.notify.per) * regions,
      origin: Math.ceil(originGbps / CAP.origin.per),
    };
    return { searchQps, viewRps, cartRps, ordersDay, orderRps, notifyRps, dropRps, rowCap, admitted, egressGbps, originGbps, ordersTB, ledgerTB, cartGB, servers, reads: (v.searches + v.views) / (v.conversion / 100) };
  }

  function insights(v, r, o) {
    const out = [];
    const over = o.admitted / o.rowCap;
    if (over > 1) out.push(`A drop sends ${fmt(o.dropRps)} purchase attempts per second at one product, but its stock row can take only about ${fmt(o.rowCap)} locked updates per second (${v.lock} ms each${r.buckets ? ', across 10 buckets' : ''}). That is ${over.toFixed(1)}× its capacity: requests queue, time out, and retry. This one number decides the design: add a waiting room, split the stock into buckets, or take orders asynchronously.`);
    else out.push(`The hot product’s stock row handles the drop: ${fmt(o.admitted)} updates per second against about ${fmt(o.rowCap)} available${r.room ? ', because the waiting room admits shoppers no faster than the row can sell' : ''}.`);
    out.push(`Browsing outnumbers buying about ${fmt(o.reads, 0)} to 1 (searches and page views per order). Reads are served from caches, replicas, and the CDN; orders get the strongly consistent database.`);
    out.push(r.cdn
      ? `Product pages move ${fmt(o.egressGbps)} Gbps at peak. The CDN serves about 95% of it, leaving ${fmt(o.originGbps)} Gbps for the origin.`
      : `Without a CDN, ${fmt(o.egressGbps)} Gbps of images leave your own servers at peak. Bandwidth becomes the largest bill.`);
    out.push(`${fmt(o.ordersDay)} orders a day is only ${fmt(o.orderRps)} per second at peak: small next to browsing, but each order must be created exactly once.`);
    out.push(`Live carts fit in about ${fmt(o.cartGB, 0)} GB, small enough for an in-memory or key-value store. Orders and the payment ledger, kept for ${v.retention} years, grow to about ${fmt(o.ordersTB + o.ledgerTB, 0)} TB${r.multi ? ' across both regions' : ''}.`);
    if (v.peak >= 15) out.push(`A ${v.peak}× peak means capacity for ${v.peak} times the average. Known events such as Black Friday are planned for: scale up beforehand and load-test.`);
    if (r.multi) out.push('Active-active doubles most capacity and adds cross-region replication. Carts can be written in either region; stock and orders need one home region per item to avoid selling a unit twice.');
    return out;
  }

  ui.mountShopCapacity = function (pageId) {
    const main = ui.mountShell(pageId);
    const page = SDL.page(pageId);
    const vals = Object.fromEntries(INPUTS.map((i) => [i.id, i.value]));
    const reqs = Object.fromEntries(REQS.map((i) => [i.id, i.value]));
    let avail = '99.99';
    main.innerHTML = `
      <div class="lab-head">
        <h1>${esc(page.title)}</h1>
        <p class="lede">${esc(page.summary)}</p>
        <p class="disclaimer">Back-of-the-envelope estimates for learning, not Amazon’s figures. Per-server capacities are stated assumptions; real numbers depend on hardware, payload, and software.</p>
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
      const hot = o.admitted > o.rowCap;
      q('[data-ref="load"]').innerHTML =
        tile('Searches per second', fmt(o.searchQps)) +
        tile('Product page views per second', fmt(o.viewRps)) +
        tile('Cart writes per second', fmt(o.cartRps)) +
        tile('Orders per day', fmt(o.ordersDay)) +
        tile('Orders per second', fmt(o.orderRps), `peak, ${vals.peak}× average`) +
        tile('Notifications per second', fmt(o.notifyRps), 'about 5 per order') +
        tile('Hot product: attempts per second', fmt(o.dropRps), `${fmt(vals.drop * 1000)} shoppers in ${vals.window} s`, hot ? 'fail' : '') +
        tile('Hot product: row capacity', `${fmt(o.rowCap)} per second`, hot ? `✕ ${(o.admitted / o.rowCap).toFixed(1)}× over capacity` : '✓ within capacity', hot ? 'fail' : 'ok') +
        tile('CDN egress at peak', `${fmt(o.egressGbps)} Gbps`, reqs.cdn ? `origin ${fmt(o.originGbps)} Gbps` : 'no CDN: all from origin') +
        tile('Orders and ledger storage', `${fmt(o.ordersTB + o.ledgerTB, 0)} TB`, `${vals.retention} years, 3 replicas`) +
        tile('Live carts', `${fmt(o.cartGB, 0)} GB`);
      const max = Math.max(...Object.values(o.servers), 1);
      const top = Object.entries(o.servers).sort((a, b) => b[1] - a[1])[0][0];
      q('[data-ref="bars"]').innerHTML = `<div class="cap-bars">${Object.entries(o.servers).map(([k, n]) => `
        <div class="cap-bar${k === top ? ' is-top' : ''}"><span class="cap-label">${esc(CAP[k].label)}</span><span class="cap-track"><i style="width:${(n / max) * 100}%"></i></span><span class="cap-n">${n}</span></div>`).join('')}</div>`;
      q('[data-ref="caps"]').textContent = 'Assumed capacity: ' + Object.values(CAP).map((c) => `${c.label.toLowerCase()} ${c.per.toLocaleString('en-US')} ${c.unit}`).join('; ') + '. Servers do not fix a hot row: one product’s stock lives on one row however many machines you add.';
      q('[data-ref="insights"]').innerHTML = insights(vals, reqs, o).map((t) => `<li>${esc(t)}</li>`).join('');
      q('[data-ref="avail"]').textContent = `${avail}% availability allows about ${AVAIL[avail]} minutes of downtime per month${avail === '99.99' ? ': too little for manual recovery, so checkout failover must be automatic.' : avail === '99.9' ? '. On a busy day that is a lot of lost orders.' : ', roughly one short incident.'}`;
    }
    main.addEventListener('input', (e) => {
      const id = e.target.dataset.in;
      if (id) { vals[id] = Number(e.target.value); render(); }
    });
    main.addEventListener('change', (e) => {
      const id = e.target.dataset.req;
      if (id) { reqs[id] = e.target.checked; render(); }
    });
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
