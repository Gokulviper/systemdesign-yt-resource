/*
 * Notification platform: requirements and capacity.
 * A live back-of-the-envelope calculator. Users and notifications per user
 * set the daily volume; the campaign window sets the burst, and the burst is
 * what sizes the queues and workers. Channel mix splits the work, provider
 * caps stretch campaigns, the inbox and delivery events set storage, and
 * in-app connections set the gateway fleet.
 */
(function () {
  'use strict';
  const SDL = window.SDL;
  const ui = SDL.ui;
  const esc = ui.esc;

  const INPUTS = [
    { id: 'users', label: 'Daily active users', unit: 'million', min: 1, max: 1000, step: 1, value: 100 },
    { id: 'perUser', label: 'Notifications per user per day', unit: '', min: 1, max: 50, step: 1, value: 5 },
    { id: 'peak', label: 'Peak-to-average ratio', unit: '×', min: 1, max: 10, step: 0.5, value: 3 },
    { id: 'campaign', label: 'Campaign size', unit: 'million', min: 0, max: 500, step: 1, value: 20 },
    { id: 'window', label: 'Campaign window', unit: 'min', min: 1, max: 240, step: 1, value: 10 },
    { id: 'push', label: 'Share sent as push', unit: '%', min: 0, max: 100, step: 5, value: 70 },
    { id: 'email', label: 'Share sent as email', unit: '%', min: 0, max: 100, step: 5, value: 20 },
    { id: 'sms', label: 'Share sent as SMS', unit: '%', min: 0, max: 20, step: 0.5, value: 5 },
    { id: 'devices', label: 'Devices per user', unit: '', min: 1, max: 4, step: 0.1, value: 1.5 },
    { id: 'workerRate', label: 'Sends per second per worker', unit: '', min: 50, max: 2000, step: 50, value: 500 },
    { id: 'smsCap', label: 'SMS provider cap per account', unit: '/s', min: 10, max: 2000, step: 10, value: 300 },
    { id: 'retention', label: 'Inbox retention', unit: 'days', min: 7, max: 365, step: 1, value: 90 },
    { id: 'online', label: 'Users with the app open at peak', unit: '%', min: 1, max: 30, step: 1, value: 10 },
  ];
  const REQS = [
    { id: 'inbox', label: 'Mirror every push into the in-app inbox', value: true },
    { id: 'events', label: 'Track delivery events (sent, delivered, opened)', value: true },
    { id: 'campaignSms', label: 'Campaigns also go out by SMS', value: false },
    { id: 'lanes', label: 'Reserve worker capacity for critical messages (20%)', value: true },
  ];
  const SCENARIOS = {
    normal: { label: 'Consumer app', set: { users: 100, perUser: 5, campaign: 20, window: 10, sms: 5 } },
    blast: { label: 'Huge blast', set: { users: 300, perUser: 5, campaign: 200, window: 5, sms: 5 } },
    b2b: { label: 'Alerts, SMS-heavy', set: { users: 5, perUser: 10, campaign: 1, window: 60, sms: 20 } },
  };
  const AVAIL = { '99.9': 525, '99.99': 52.6, '99.999': 5.26 };
  const SMS_COST = 0.0075; // dollars per text, a typical list price
  const ROW = { inbox: 500, event: 100, token: 200 }; // bytes

  function fmt(n, d) {
    if (n >= 1e12) return (n / 1e12).toFixed(d == null ? 1 : d) + ' trillion';
    if (n >= 1e9) return (n / 1e9).toFixed(d == null ? 1 : d) + ' billion';
    if (n >= 1e6) return (n / 1e6).toFixed(d == null ? 1 : d) + ' million';
    if (n >= 1000) return Math.round(n).toLocaleString('en-US');
    return n.toFixed(d == null ? 1 : d);
  }
  const bytes = (b) => (b >= 1e15 ? (b / 1e15).toFixed(1) + ' PB' : b >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(1) + ' MB');
  const dur = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

  function compute(v, r) {
    const users = v.users * 1e6;
    const daily = users * v.perUser;
    const avg = daily / 86400;
    const peak = avg * v.peak;
    const campaign = v.campaign * 1e6;
    const blast = campaign ? campaign / (v.window * 60) : 0;
    const dominant = blast > peak ? 'campaign' : 'daily';
    const top = Math.max(peak, blast + avg); // a blast lands on top of normal traffic
    const share = { push: v.push / 100, email: v.email / 100, sms: v.sms / 100 };
    // Push fans out per device; email and SMS do not.
    const sendsPerSec = top * (share.push * v.devices + share.email) + avg * v.peak * share.sms;
    const reserve = r.lanes ? 0.8 : 1;
    const workers = Math.ceil(sendsPerSec / (v.workerRate * reserve));
    const smsDaily = daily * share.sms + (r.campaignSms ? campaign : 0);
    const smsPeak = avg * v.peak * share.sms + (r.campaignSms ? blast : 0);
    const smsAccounts = Math.ceil(smsPeak / v.smsCap);
    const smsCampaignSecs = r.campaignSms && campaign ? campaign / v.smsCap : 0;
    const smsCostDay = smsDaily * SMS_COST;
    const inboxPerDay = r.inbox ? daily * share.push : 0;
    const inboxBytes = inboxPerDay * ROW.inbox * v.retention;
    const eventsPerDay = r.events ? daily * (share.push * v.devices + share.email + share.sms) * 3 : 0;
    const eventBytesYear = eventsPerDay * ROW.event * 365;
    const tokens = users * v.devices * 1.3; // 30% dead tokens before cleanup
    const tokenBytes = tokens * ROW.token;
    const connections = users * (v.online / 100);
    const gateways = Math.ceil(connections / 65000);
    const backlog = Math.max(0, (sendsPerSec - workers * v.workerRate) * 60);
    const herd = blast * 0.05 * 60; // 5% open the app within a minute of the push
    return { users, daily, avg, peak, campaign, blast, dominant, top, sendsPerSec, workers, smsDaily, smsPeak, smsAccounts, smsCampaignSecs, smsCostDay, inboxPerDay, inboxBytes, eventsPerDay, eventBytesYear, tokens, tokenBytes, connections, gateways, backlog, herd };
  }

  function insights(v, r, o) {
    const out = [];
    out.push(`${fmt(o.users)} users × ${v.perUser} a day is ${fmt(o.daily)} notifications: ${fmt(o.avg, 0)} a second on average and ${fmt(o.peak, 0)} at a ${v.peak}× peak.`);
    out.push(o.dominant === 'campaign'
      ? `The campaign dominates: ${fmt(o.campaign)} recipients in ${v.window} minutes is ${fmt(o.blast, 0)} a second, ${(o.blast / Math.max(o.peak, 1)).toFixed(1)}× the daily peak. Size queues and workers for the blast, pace it, and keep a separate lane so a one-time code never waits behind it.`
      : `Daily traffic dominates: the campaign adds ${fmt(o.blast, 0)} a second, less than the daily peak of ${fmt(o.peak, 0)}. Pacing it over ${v.window} minutes already keeps it out of the way.`);
    out.push(`Push fans out per device (${v.devices} each), so the workers make about ${fmt(o.sendsPerSec, 0)} provider calls a second at the top: ${o.workers} workers at ${v.workerRate} each${r.lanes ? ', with a fifth of every worker held back for critical messages' : ''}.`);
    out.push(r.campaignSms && o.campaign
      ? `Sending the campaign by SMS at ${v.smsCap} a second per account takes ${dur(o.smsCampaignSecs)} on one account, and costs about $${fmt(o.campaign * SMS_COST, 0)}. That is why campaigns go by push and email, and SMS is kept for codes.`
      : `SMS runs at ${fmt(o.smsPeak, 0)} a second at peak, ${o.smsAccounts} provider account${o.smsAccounts === 1 ? '' : 's'} at ${v.smsCap} a second each, and costs about $${fmt(o.smsCostDay, 0)} a day at $${SMS_COST} a text. It is the only channel where every message has a price.`);
    out.push(r.inbox ? `The inbox stores ${fmt(o.inboxPerDay)} entries a day; ${v.retention} days of them at ${ROW.inbox} bytes is ${bytes(o.inboxBytes)}. Partition it by user and expire old entries by time.` : 'Without an inbox, a push that never lands leaves no trace in the app.');
    if (r.events) out.push(`Delivery events (sent, delivered, opened) are ${fmt(o.eventsPerDay)} a day, ${bytes(o.eventBytesYear)} a year: more than everything else combined. They belong in an append-only log and a warehouse, not the request store.`);
    out.push(`The device registry holds about ${fmt(o.tokens)} tokens, ${bytes(o.tokenBytes)}, counting the three in ten that are dead until a 410 or a sweep removes them. Small, but read on every send: cache it.`);
    out.push(`If ${v.online}% of users have the app open at peak, ${fmt(o.connections)} sockets need about ${o.gateways} connection servers at 65,000 each. A blast that makes 5% of recipients open the app within a minute sends ${fmt(o.herd, 0)} extra requests a minute at the product’s own backend.`);
    return out;
  }

  ui.mountNtCapacity = function (pageId) {
    const main = ui.mountShell(pageId);
    const page = SDL.page(pageId);
    const vals = Object.fromEntries(INPUTS.map((i) => [i.id, i.value]));
    const reqs = Object.fromEntries(REQS.map((i) => [i.id, i.value]));
    let avail = '99.99';
    main.innerHTML = `
      <div class="lab-head">
        <h1>${esc(page.title)}</h1>
        <p class="lede">${esc(page.summary)}</p>
        <p class="disclaimer">Back-of-the-envelope estimates for learning, not any company’s figures. Provider caps and prices are typical list values; everything else is a stated assumption.</p>
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
          <h3 class="subhead">Availability target for the send API</h3>
          <div class="ops-traffic" role="group" aria-label="Availability">${Object.keys(AVAIL).map((a) => `<button class="btn ops-tbtn" data-avail="${a}">${a}%</button>`).join('')}</div>
        </section>
        <div class="lab-main">
          <section class="panel panel-metrics" aria-labelledby="h-load"><h2 id="h-load">Sizing <span class="sim-tag">Estimated</span></h2><dl class="metric-grid" data-ref="load"></dl></section>
          <section class="panel panel-diagram" aria-labelledby="h-srv"><h2 id="h-srv">Requests per second: daily peak versus the campaign</h2><div data-ref="bars"></div><p class="surge-meta" data-ref="caps"></p><h3 class="subhead">Storage per year</h3><div data-ref="store"></div></section>
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
        tile('Notifications a day', fmt(o.daily), `${fmt(o.avg, 0)}/s average, ${fmt(o.peak, 0)}/s at peak`) +
        tile('Campaign burst', `${fmt(o.blast, 0)}/s`, o.dominant === 'campaign' ? 'the number that sizes the system' : 'below the daily peak', o.dominant === 'campaign' ? 'warn' : 'ok') +
        tile('Provider calls at the top', `${fmt(o.sendsPerSec, 0)}/s`, `push × ${vals.devices} devices`) +
        tile('Send workers', fmt(o.workers, 0), `${vals.workerRate}/s each${reqs.lanes ? ', 20% reserved' : ''}`) +
        tile('SMS a day', fmt(o.smsDaily), `$${fmt(o.smsCostDay, 0)} a day`, o.smsAccounts > 1 ? 'warn' : '') +
        tile('SMS accounts needed', fmt(o.smsAccounts, 0), `${vals.smsCap}/s cap each${reqs.campaignSms && o.campaign ? `; campaign takes ${dur(o.smsCampaignSecs)}` : ''}`, reqs.campaignSms && o.smsCampaignSecs > vals.window * 60 ? 'fail' : '') +
        tile('Inbox storage', bytes(o.inboxBytes), `${vals.retention} days retained`) +
        tile('Connection servers', fmt(o.gateways, 0), `${fmt(o.connections)} open sockets at peak`);
      const bars = { 'Daily peak': o.peak, 'Campaign burst': o.blast, 'Provider calls at the top': o.sendsPerSec, 'SMS at peak': o.smsPeak };
      const max = Math.max(...Object.values(bars), 1);
      const topBar = Object.entries(bars).sort((a, b) => b[1] - a[1])[0][0];
      q('[data-ref="bars"]').innerHTML = `<div class="cap-bars is-wide">${Object.entries(bars).map(([k, n]) => `
        <div class="cap-bar${k === topBar ? ' is-top' : ''}"><span class="cap-label">${esc(k)}</span><span class="cap-track"><i style="width:${(n / max) * 100}%"></i></span><span class="cap-n">${fmt(n, 0)}/s</span></div>`).join('')}</div>`;
      q('[data-ref="caps"]').textContent = `A campaign lands on top of normal traffic. Provider calls exceed notifications because one push goes to every device the user has. SMS is capped per provider account, so it is the slowest channel to scale.`;
      const store = { 'Inbox (retained)': o.inboxBytes, 'Delivery events': o.eventBytesYear, 'Device tokens': o.tokenBytes };
      const smax = Math.max(...Object.values(store), 1);
      q('[data-ref="store"]').innerHTML = `<div class="cap-bars is-wide">${Object.entries(store).map(([k, b]) => `<div class="cap-bar"><span class="cap-label">${esc(k)}</span><span class="cap-track"><i style="width:${(b / smax) * 100}%"></i></span><span class="cap-n">${bytes(b)}</span></div>`).join('')}</div>`;
      q('[data-ref="insights"]').innerHTML = insights(vals, reqs, o).map((t) => `<li>${esc(t)}</li>`).join('');
      q('[data-ref="avail"]').textContent = `${avail}% allows about ${AVAIL[avail]} minutes a year when teams cannot hand over a notification${avail === '99.999' ? ': the API must accept into a durable store even when every provider is down, which is what the outbox is for.' : avail === '99.99' ? ': accept into the outbox while providers misbehave, and let delivery catch up afterwards.' : ': teams must queue and retry on their side during an outage, with idempotency keys so nothing is sent twice.'}`;
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
