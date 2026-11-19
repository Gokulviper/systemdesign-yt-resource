/*
 * Preferences, unsubscribe, and the right to be forgotten.
 * Every send is checked against Maya's preferences: promotions by push and
 * by email can be turned off, order updates can be turned off, security
 * alerts cannot. The preference service reads through a cache, so an opt-out
 * is only as fast as the cache's invalidation. A job queued before the
 * opt-out is only stopped if preferences are checked again at send time.
 * If preferences cannot be read, marketing fails closed and security fails
 * open. Deleting the account must also purge jobs already queued, because a
 * missing preferences row reads as "defaults: opted in".
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const CACHE_TTL = 6000;
  const RECHECK_MS = 500;
  const KIND = {
    promoPush: { cat: 'marketing', ch: 'push', title: 'Weekend sale: 20% off shoes', who: 'Shoes team: promo push' },
    promoEmail: { cat: 'marketing', ch: 'email', title: 'Our spring catalogue is here', who: 'Marketing: promo email' },
    order: { cat: 'orders', ch: 'push', title: 'Your order has shipped', who: 'Orders team: shipping update' },
    security: { cat: 'security', ch: 'push', title: 'New sign-in from Safari on a Mac', who: 'Security: new sign-in alert' },
  };
  const DEFAULTS = () => ({ marketing: { push: true, email: true }, orders: true });

  const allowedBy = (v, cat, ch) => (cat === 'security' ? true : cat === 'marketing' ? v.marketing[ch] : v.orders);

  function send(sim, kind, delay) {
    const st = sim.state;
    const k = KIND[kind];
    sim.startAction(delay ? `${k.who}, scheduled ${delay / 1000} s from now` : k.who, function* (ctx) {
      Y.L(ctx, { displayed: ['n/a'], retrySafe: ['yes', 'One job id per request.'] });
      const r = yield ctx.call('api', 'send', { kind, delay: delay || 0 }, { timeout: 800 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      if (r.value.suppressed) { Y.L(ctx, { accepted: ['yes', 'Suppressed at enqueue.'], committed: 'n/a', async: ['n/a', r.value.why] }); return; }
      Y.L(ctx, { accepted: 'yes', committed: ['yes', `Job ${r.value.id} queued.`], async: ['pending'] });
      ctx.explain(`Checked at enqueue: allowed. Job ${r.value.id} is queued${delay ? ` to send at T+${SDL.fmtMs(st.jobs[r.value.id].notBefore)}` : ''}${st.config.checkAtSend ? ' and will be checked again just before sending' : '; nothing checks again before it is sent'}.`);
    }, { self: 'console' });
  }

  function setPref(sim, key, value, viaEmail) {
    const label = viaEmail ? 'Maya clicks “Unsubscribe” in the email' : `Maya turns ${key === 'push' ? 'promotional pushes' : key === 'email' ? 'promotional emails' : 'order updates'} ${value ? 'on' : 'off'}`;
    sim.startAction(label, function* (ctx) {
      Y.L(ctx, { displayed: ['yes', 'The setting flips at once.'], retrySafe: [viaEmail ? (ctx.sim.nodes.api.modes.toggleUnsub ? 'no' : 'yes') : 'yes', viaEmail ? (ctx.sim.nodes.api.modes.toggleUnsub ? 'The link flips the setting: a second click turns it back on.' : 'The link sets “off”; clicking again changes nothing.') : 'Sets a value, not a flip.'] });
      const r = yield ctx.call('api', viaEmail ? 'unsubscribe' : 'setPref', { key, value }, { timeout: 800 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { accepted: 'yes', committed: 'yes', async: [ctx.state.config.invalidate ? 'yes' : 'pending', ctx.state.config.invalidate ? 'Cache entry deleted on write.' : `The cache may serve the old value for up to ${CACHE_TTL / 1000} s.`] });
      ctx.explain(viaEmail ? `Promotional email is now ${r.value.email ? 'on' : 'off'}.${r.value.flipped ? ' The link flips the value, so this click turned it back on.' : ''}` : `Saved. ${ctx.state.config.invalidate ? 'The preference cache entry was deleted, so the next check reads the new value.' : 'The cache still holds the old value until it expires.'}`);
    }, { self: viaEmail ? 'email' : 'phone' });
  }

  function deleteAccount(sim) {
    sim.startAction('Maya deletes her account', function* (ctx) {
      Y.L(ctx, { displayed: ['yes', '“Your account will be deleted.”'], retrySafe: 'yes' });
      const r = yield ctx.call('api', 'deleteAccount', {}, { timeout: 800 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { accepted: 'yes', committed: ['yes', 'Deletion request stored.'], async: ['pending', 'The deletion worker removes her data.'] });
    }, { self: 'phone' });
  }

  const sc = (SDL.scenarios['nt-prefs'] = {
    id: 'nt-prefs',
    seed: 1511,
    minHopMs: 5,
    productWidth: 660,
    intro: 'Turn promotional pushes off on Maya’s phone and send a promo and an order update. Then turn off cache invalidation, queue a promo before the opt-out, click “Unsubscribe” twice, take the preferences store down, or delete the account with jobs still queued.',
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'console', label: 'Product teams', sub: 'Promos, orders, security', kind: 'client', x: 90, y: 90, latency: 1, role: 'Send promotions, order updates, and security alerts, some scheduled for later.', owns: ['Nothing'] },
        { id: 'api', label: 'Notification API', sub: 'Checks prefs at enqueue', kind: 'gateway', x: 330, y: 90, latency: 3, role: 'Accepts sends, preference changes, unsubscribe links, and deletion requests. Checks preferences before queuing a job.', ops: [{ name: 'send', desc: 'Queue a job.' }, { name: 'setPref', desc: 'Change a setting.' }, { name: 'unsubscribe', desc: 'Email link.' }, { name: 'deleteAccount', desc: 'Request deletion.' }], owns: ['Nothing durable'] },
        { id: 'sendq', label: 'Send queue', sub: 'Jobs, some scheduled', kind: 'queue', x: 570, y: 90, latency: 2, queue: 'sends', role: 'Queued jobs, each carrying the device token captured when it was queued.', owns: ['jobs'] },
        { id: 'worker', label: 'Send worker', sub: 'May re-check at send', kind: 'worker', x: 810, y: 90, latency: 3, role: 'Waits for a job’s send time, optionally checks preferences again, and sends. If preferences cannot be read, it holds marketing and sends security and order updates.', owns: ['Nothing'] },
        { id: 'email', label: 'Maya’s email', sub: 'With unsubscribe link', kind: 'client', x: 1050, y: 90, latency: 1, role: 'Receives promotional and other email. Every promotional email has an unsubscribe link.', ops: [{ name: 'receive', desc: 'Receive an email.' }], owns: ['Nothing'] },
        { id: 'prefs', label: 'Preference service', sub: 'Read through a cache', kind: 'service', x: 330, y: 300, latency: 2, role: 'Answers “may we send this category on this channel to this person?”. Security alerts are always allowed. A missing row is read as the defaults: opted in.', ops: [{ name: 'check', desc: 'Allowed?' }, { name: 'update', desc: 'Save a change.' }], owns: ['The rules'] },
        { id: 'cache', label: 'Preference cache', sub: `TTL ${CACHE_TTL / 1000} s`, kind: 'cache', x: 570, y: 300, latency: 1, role: `Caches each person’s preferences for ${CACHE_TTL / 1000} s. With invalidation, a write deletes the entry.`, ops: [{ name: 'get', desc: 'Read.' }, { name: 'set', desc: 'Fill.' }, { name: 'del', desc: 'Invalidate.' }], owns: ['Cached preferences'] },
        { id: 'deletion', label: 'Deletion worker', sub: 'Right to be forgotten', kind: 'worker', x: 810, y: 300, latency: 3, queue: 'deletions', role: 'Removes preferences, device tokens, and cached data, and with purging on, cancels the person’s queued jobs.', owns: ['Deletion requests'] },
        { id: 'prefsdb', label: 'Preferences store', sub: 'The truth', kind: 'db', x: 330, y: 480, latency: 6, role: 'One row per person: promotions by push and email, order updates.', ops: [{ name: 'get', desc: 'Read a row.' }, { name: 'patch', desc: 'Change one field.' }, { name: 'delete', desc: 'Remove a row.' }], owns: ['preferences', 'device tokens'] },
        { id: 'phone', label: 'Maya’s phone', sub: 'Settings + pushes', kind: 'client', x: 1050, y: 480, latency: 1, role: 'Notification settings and the lock screen.', ops: [{ name: 'push', desc: 'Show a push.' }], owns: ['Nothing'] },
      ],
      edges: [
        { from: 'console', to: 'api', latency: 20, label: 'HTTPS' },
        { from: 'email', to: 'api', latency: 25, via: [[1050, 30], [330, 30]] },
        { from: 'phone', to: 'api', latency: 25, via: [[1050, 545], [200, 545], [200, 150], [330, 150]] },
        { from: 'api', to: 'prefs', latency: 2 },
        { from: 'api', to: 'sendq', latency: 2 },
        { from: 'api', to: 'deletion', latency: 2, via: [[450, 90], [450, 220], [810, 220]] },
        { from: 'sendq', to: 'worker', latency: 2 },
        { from: 'worker', to: 'prefs', latency: 2, via: [[760, 90], [760, 190], [330, 190]] },
        { from: 'worker', to: 'email', latency: 20 },
        { from: 'worker', to: 'phone', latency: 25, via: [[930, 90], [930, 480]] },
        { from: 'prefs', to: 'cache', latency: 1 },
        { from: 'prefs', to: 'prefsdb', latency: 2 },
        { from: 'deletion', to: 'cache', latency: 1 },
        { from: 'deletion', to: 'prefsdb', latency: 2, via: [[810, 480]] },
        { from: 'deletion', to: 'sendq', latency: 2, via: [[690, 300], [690, 150], [570, 150]] },
      ],
      queues: [
        { id: 'sends', broker: 'sendq', label: 'jobs', groups: ['worker'] },
        { id: 'deletions', broker: 'deletion', label: 'deletion requests', groups: ['deletion'] },
      ],
    },
    modeLabels: { override: 'A team ignores opt-outs', toggleUnsub: 'Unsubscribe link flips the setting' },
    failures: [
      { id: 'prefsdb-down', node: 'prefsdb', mode: 'down', label: 'Preferences store down', desc: 'Checks that miss the cache cannot be answered. Marketing fails closed; security and orders fail open.' },
      { id: 'cache-down', node: 'cache', mode: 'down', label: 'Preference cache down', desc: 'Every check reads the store. Slower, still correct.' },
      { id: 'unsub-toggle', node: 'api', mode: 'toggleUnsub', label: 'Unsubscribe link flips the setting', desc: 'The link handler toggles instead of setting “off”. A second click resubscribes.' },
      { id: 'deletion-paused', node: 'deletion', mode: 'paused', label: 'Deletion worker paused', desc: 'Deletion requests wait. Maya’s data stays until it resumes.' },
      { id: 'override', node: 'prefs', mode: 'override', label: 'Team override of opt-outs', desc: 'A team has a flag that skips the marketing check “for important announcements”.' },
    ],
    switches: Y.switches([
      ['checkAtSend', 'Re-check at send time', 'The worker checks preferences again just before sending. Off: only the check at enqueue counts.'],
      ['invalidate', 'Invalidate cache on write', `A preference change deletes the cache entry. Off: the old value is served until it expires, up to ${CACHE_TTL / 1000} s.`],
      ['purge', 'Deletion purges queued jobs', 'Deleting an account also cancels its queued jobs. Off: queued jobs survive and are sent.'],
    ]),
    presets: Y.presets({ checkAtSend: true, invalidate: true, purge: true }, [
      { id: 'toggle-off', label: 'Turn promotional pushes off', desc: 'Maya turns promotional pushes off. A promo push is suppressed at enqueue; the order update still arrives.', run: (s) => { setPref(s, 'push', false); s.schedule(500, () => send(s, 'promoPush')); s.schedule(700, () => send(s, 'order')); } },
      { id: 'optout-cache-stale', label: 'Opt out, cache not invalidated', desc: `A first promo fills the cache with “opted in”. Maya opts out. The second promo is checked against the cache, which has ${CACHE_TTL / 1000} s left, and goes out.`, sw: { invalidate: false }, run: (s) => { send(s, 'promoPush'); s.schedule(600, () => setPref(s, 'push', false)); s.schedule(1200, () => send(s, 'promoPush')); } },
      { id: 'invalidate-on-write', label: 'Opt out, cache invalidated on write', desc: 'Same sequence. The opt-out deletes the cache entry; the second promo reads the store and is suppressed.', run: (s) => { send(s, 'promoPush'); s.schedule(600, () => setPref(s, 'push', false)); s.schedule(1200, () => send(s, 'promoPush')); } },
      { id: 'check-at-enqueue-only', label: 'Promo queued before the opt-out', desc: 'A promo is queued at T+0 to go out at T+2.5 s, and passes the enqueue check. Maya opts out at T+1 s. Nothing checks again, and it is sent.', sw: { checkAtSend: false }, run: (s) => { send(s, 'promoPush', 2500); s.schedule(1000, () => setPref(s, 'push', false)); } },
      { id: 'unsubscribe-twice', label: '“Unsubscribe” clicked twice', desc: 'Maya clicks the link in a promo email, then clicks it again because the page loaded slowly. The handler sets “off” both times. The next promo email is suppressed.', run: (s) => { send(s, 'promoEmail'); s.schedule(800, () => setPref(s, 'email', false, true)); s.schedule(1000, () => setPref(s, 'email', false, true)); s.schedule(1800, () => send(s, 'promoEmail')); } },
      { id: 'prefsdb-down', label: 'Preferences store down: fail closed for marketing', desc: 'The store is down and the cache is cold. The promo cannot be checked, so it is held; the order update cannot be checked either, and is sent, because missing an order update is worse than sending one she might have turned off.', run: (s) => { s.inject('prefsdb', 'down'); send(s, 'promoPush'); s.schedule(300, () => send(s, 'order')); } },
      { id: 'delete-purges', label: 'Delete the account, purge queued jobs', desc: 'An order update and a promo are queued for later. Maya deletes her account. The deletion worker removes her preferences and tokens and cancels both jobs.', run: (s) => { send(s, 'order', 2000); send(s, 'promoPush', 2500); s.schedule(800, () => deleteAccount(s)); } },
      { id: 'delete-leaves-queue', label: 'Delete the account, queued jobs survive', desc: 'Same deletion, without purging. The jobs carry the device token from when they were queued; at send time the missing preferences row reads as “opted in”. A deleted account gets two pushes.', sw: { purge: false }, run: (s) => { send(s, 'order', 2000); send(s, 'promoPush', 2500); s.schedule(800, () => deleteAccount(s)); } },
      { id: 'critical-ignores-optout', label: 'Security alert after opting out of everything', desc: 'Maya turns off promotions and order updates. A new sign-in alert still arrives: security messages are not a preference.', run: (s) => { setPref(s, 'push', false); s.schedule(200, () => setPref(s, 'orders', false)); s.schedule(800, () => send(s, 'promoPush')); s.schedule(1000, () => send(s, 'security')); } },
    ]),
    initialState: () => ({
      config: { checkAtSend: true, invalidate: true, purge: true },
      db: { maya: DEFAULTS() }, tokens: { maya: 'tok-maya-1' }, cache: {}, jobs: {}, deleted: false, deletedAt: null, deletionRequested: null,
      seq: 0, stats: { hits: 0, misses: 0, suppressed: 0, held: 0, purged: 0, afterOptOut: 0, afterDelete: 0, failOpen: 0 },
    }),
    initialUI: () => ({ phone: { prefs: DEFAULTS(), pushes: [], banner: null, deleted: false }, email: { inbox: [], banner: null } }),
    actions: {
      toggle(sim, a) { const p = sim.ui.phone.prefs; const cur = a.key === 'orders' ? p.orders : p.marketing[a.key]; setPref(sim, a.key, !cur); },
      unsub(sim) { setPref(sim, 'email', false, true); },
      send(sim, a) { send(sim, a.kind, a.delay || 0); },
      del(sim) { deleteAccount(sim); },
    },
    handlers: {
      api: {
        send: function* (ctx, p) {
          const st = ctx.state;
          const k = KIND[p.kind];
          const c = yield ctx.call('prefs', 'check', { user: 'maya', cat: k.cat, ch: k.ch }, { timeout: 500 });
          if (c.ok && !c.value.unknown && !c.value.allowed) {
            st.stats.suppressed++;
            ctx.log({ op: `${k.cat} ${k.ch} suppressed at enqueue`, status: 'drop', detail: `Maya has ${k.cat === 'marketing' ? `promotional ${k.ch}` : 'order updates'} turned off.` });
            return { suppressed: true, why: 'Opted out.' };
          }
          const id = `j${++st.seq}`;
          st.jobs[id] = { id, kind: p.kind, cat: k.cat, ch: k.ch, title: k.title, token: st.tokens.maya, notBefore: ctx.now() + (p.delay || 0), status: 'queued' };
          ctx.sim.enqueue('sends', { type: k.cat, eventId: id, payload: { id }, actionId: ctx.actionId });
          return { id };
        },
        setPref: function* (ctx, p) { return ctx.must(yield ctx.call('prefs', 'update', p, { timeout: 500 })); },
        unsubscribe: function* (ctx) {
          const st = ctx.state;
          const cur = st.db.maya ? st.db.maya.marketing.email : false;
          const flip = !!ctx.mode('toggleUnsub');
          const value = flip ? !cur : false;
          if (!flip && cur === false) ctx.log({ op: 'already unsubscribed', status: 'dup', detail: 'The link sets “off”. It is already off; nothing changes.' });
          const r = ctx.must(yield ctx.call('prefs', 'update', { key: 'email', value }, { timeout: 500 }));
          return Object.assign({}, r, { flipped: flip && value });
        },
        deleteAccount(ctx) {
          ctx.state.deletionRequested = ctx.now();
          ctx.sim.enqueue('deletions', { type: 'delete', eventId: 'del-maya', payload: { user: 'maya' }, actionId: ctx.actionId });
          return { requested: true };
        },
      },
      prefs: {
        check: function* (ctx, p) {
          const st = ctx.state;
          if (p.cat === 'security') return { allowed: true, why: 'security' };
          if (p.cat === 'marketing' && ctx.mode('override')) {
            ctx.log({ op: 'opt-out skipped: team override', status: 'fault', detail: 'The sending team’s “important announcement” flag bypasses the marketing check.' });
            return { allowed: true, override: true };
          }
          let v = null;
          const c = yield ctx.call('cache', 'get', { user: p.user }, { timeout: 200, quiet: true });
          if (c.ok && c.value) { st.stats.hits++; v = c.value; }
          else {
            st.stats.misses++;
            const r = yield ctx.call('prefsdb', 'get', { user: p.user }, { timeout: 300 });
            if (!r.ok) return { unknown: true };
            v = r.value || DEFAULTS();
            if (!r.value) ctx.log({ op: 'no preferences row: defaults', status: 'note', detail: 'No row for this person, so the service answers with the defaults: everything on.' });
            yield ctx.call('cache', 'set', { user: p.user, value: v }, { timeout: 200, quiet: true });
          }
          return { allowed: allowedBy(v, p.cat, p.ch), cached: !!(c.ok && c.value) };
        },
        update: function* (ctx, p) {
          const st = ctx.state;
          // The store applies the one changed field to its current row, so two quick changes cannot overwrite each other.
          const row = ctx.must(yield ctx.call('prefsdb', 'patch', { user: 'maya', key: p.key, value: p.value }, { timeout: 400 }));
          if (st.config.invalidate) yield ctx.call('cache', 'del', { user: 'maya' }, { timeout: 200 });
          ctx.ui.phone.prefs = JSON.parse(JSON.stringify(row));
          return { email: row.marketing.email, push: row.marketing.push, orders: row.orders };
        },
      },
      cache: {
        get(ctx, p) { const e = ctx.state.cache[p.user]; return e && ctx.now() - e.t < CACHE_TTL ? e.value : null; },
        set(ctx, p) { ctx.state.cache[p.user] = { value: JSON.parse(JSON.stringify(p.value)), t: ctx.now() }; return { ok: true }; },
        del(ctx, p) { delete ctx.state.cache[p.user]; return { ok: true }; },
      },
      prefsdb: {
        get(ctx, p) { return ctx.state.db[p.user] ? JSON.parse(JSON.stringify(ctx.state.db[p.user])) : null; },
        patch(ctx, p) {
          const row = ctx.state.db[p.user] || (ctx.state.db[p.user] = DEFAULTS());
          if (p.key === 'orders') row.orders = p.value; else row.marketing[p.key] = p.value;
          return JSON.parse(JSON.stringify(row));
        },
        delete(ctx, p) { delete ctx.state.db[p.user]; ctx.state.tokens[p.user] = null; return { ok: true }; },
      },
      phone: {
        push(ctx, p) {
          const ui = ctx.ui.phone;
          ui.pushes.unshift({ title: p.title, cat: p.cat, afterDelete: ctx.state.deleted });
          ui.banner = { title: p.title, body: p.cat === 'security' ? 'Security' : 'Shop', tone: ctx.state.deleted ? 'warn' : 'ok', t: ctx.now() };
          return { shown: true };
        },
      },
      email: {
        receive(ctx, p) {
          ctx.ui.email.inbox.unshift({ title: p.title, cat: p.cat });
          ctx.ui.email.banner = { title: p.title, body: 'Shop', tone: '', t: ctx.now() };
          return { shown: true };
        },
      },
    },
    setup(sim) {
      sim.spawn(function* (ctx) {
        for (;;) {
          const { msg } = yield ctx.take('sends', 'worker');
          ctx.ack('sends', 'worker');
          ctx.spawn((c) => sendJob(c, msg.payload.id), { actionId: msg.actionId });
        }
      }, { self: 'worker' });
      Y.consumer(sim, 'deletions', 'deletion', 'deletion', function* (ctx, msg) {
        const st = ctx.state;
        const u = msg.payload.user;
        ctx.must(yield ctx.call('prefsdb', 'delete', { user: u }, { timeout: 400 }));
        yield ctx.call('cache', 'del', { user: u }, { timeout: 200 });
        st.deleted = true;
        st.deletedAt = ctx.now();
        ctx.ui.phone.deleted = true;
        const queued = Object.values(st.jobs).filter((j) => j.status === 'queued' || j.status === 'held');
        if (st.config.purge) {
          for (const j of queued) { j.status = 'purged'; st.stats.purged++; }
          ctx.log({ op: `deleted Maya: preferences, tokens, ${queued.length} queued job${queued.length === 1 ? '' : 's'}`, status: 'ok', detail: 'Nothing about her is left to send.' });
        } else ctx.log({ op: 'deleted Maya: preferences and tokens', status: 'note', detail: `${queued.length} queued job${queued.length === 1 ? '' : 's'} still carry her old device token.` });
        ctx.sim.setLedger(msg.actionId, 'async', 'yes', st.config.purge ? 'Deleted, queued jobs purged.' : 'Deleted; queued jobs left in place.');
        return true;
      });
    },
    consistency(sim) {
      const st = sim.state;
      const sent = Object.values(st.jobs).filter((j) => j.status === 'sent');
      const afterDelete = sent.filter((j) => j.afterDelete);
      if (afterDelete.length) return { key: 'wrong', label: `Maya deleted her account, and ${afterDelete.length} push${afterDelete.length > 1 ? 'es' : ''} still reached her phone: ${afterDelete.map((j) => `“${j.title}”`).join(', ')}. The queued jobs carried her old token, and the missing preferences row read as “opted in”.` };
      const violated = sent.filter((j) => j.violation);
      if (violated.length) {
        const j = violated[0];
        const why = j.override ? 'A team override skipped the marketing check.' : j.cached ? 'The preference cache still said “opted in”: the opt-out did not invalidate it.' : !st.config.checkAtSend ? 'It passed the check when it was queued, before she opted out, and nothing checked again.' : sim.nodes.api.modes.toggleUnsub ? 'The second click on “Unsubscribe” flipped the setting back on.' : 'Her preference said no.';
        return { key: 'wrong', label: `“${j.title}” reached Maya after she had turned ${j.cat === 'marketing' ? `promotional ${j.ch}` : 'order updates'} off. ${why}` };
      }
      const held = Object.values(st.jobs).filter((j) => j.status === 'held');
      if (held.length) return { key: 'stale', label: `${held.length} promo${held.length > 1 ? 's are' : ' is'} held: the preferences store is down and the cache has nothing, so nobody can say whether Maya opted out. Marketing fails closed; ${sent.length ? `the ${sent.map((j) => j.cat === 'orders' ? 'order update' : 'security alert').join(' and ')} went out, failing open.` : 'security and orders would go out.'}` };
      if (st.deletionRequested != null && !st.deleted) return { key: 'stale', label: 'Maya asked for deletion; the deletion worker has not run. Her data is still here.' };
      if (st.deleted) return { key: 'ok', label: `Deleted: preferences, tokens, and ${st.stats.purged} queued job${st.stats.purged === 1 ? '' : 's'}. Nothing reached the phone afterwards.` };
      if (!sent.length && !st.stats.suppressed) return { key: 'ok', label: 'Nothing sent yet.' };
      const parts = [];
      if (st.stats.suppressed) parts.push(`${st.stats.suppressed} suppressed by Maya’s preferences.`);
      if (sent.some((j) => j.cat === 'security')) parts.push('The security alert went through: it is not a preference.');
      if (sent.length) parts.push(`${sent.length} delivered, each one allowed at the moment it was sent.`);
      return { key: 'ok', label: parts.join(' ') };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const jobs = Object.values(st.jobs);
      const bad = jobs.filter((j) => j.status === 'sent' && (j.violation || j.afterDelete)).length;
      const left = st.deleted ? jobs.filter((j) => j.status === 'queued' || j.status === 'held').length : 0;
      return [
        { label: 'Sent against preferences', value: bad, tone: bad ? 'fail' : '' },
        { label: 'Suppressed', value: st.stats.suppressed },
        { label: 'Held (fail closed)', value: jobs.filter((j) => j.status === 'held').length },
        { label: 'Cache hits / misses', value: `${st.stats.hits} / ${st.stats.misses}` },
        { label: 'Account', value: st.deleted ? 'deleted' : st.deletionRequested != null ? 'deletion pending' : 'active', tone: st.deletionRequested != null && !st.deleted ? 'warn' : '' },
        { label: 'Purged jobs', value: st.stats.purged },
        { label: 'Jobs left after delete', value: left, tone: left ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone'], ['email', 'Maya’s email']], {
          note: 'Change Maya’s settings on the phone and unsubscribe from the email. The teams below send promos, order updates, and security alerts.',
          below: `<div class="ops-console"><p class="ops-title">Product teams</p><div class="ops-traffic">
              ${Y.btn('send', 'Promo push', { arg: { kind: 'promoPush' } })}
              ${Y.btn('send', 'Promo email', { arg: { kind: 'promoEmail' }, cls: 'secondary' })}
              ${Y.btn('send', 'Order update', { arg: { kind: 'order' }, cls: 'secondary' })}
              ${Y.btn('send', 'Security alert', { arg: { kind: 'security' }, cls: 'secondary' })}
              ${Y.btn('send', 'Promo push in 2.5 s', { arg: { kind: 'promoPush', delay: 2500 }, cls: 'secondary' })}
            </div><div data-ref="jobs"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const ui = sim.ui.phone;
        const p = ui.prefs;
        const row = (key, label, on) => Y.btn('toggle', `${label}: ${on ? 'on' : 'off'}`, { arg: { key }, cls: on ? '' : 'secondary', disabled: ui.deleted });
        Y.paint(el, sim, 'phone', {
          head: `<div><p class="app-title">Notifications</p><p class="app-sub">${ui.deleted ? 'Account deleted' : 'Maya · settings'}</p></div>`,
          act: `<div class="app-sec">${row('push', 'Promotions by push', p.marketing.push)}${row('email', 'Promotions by email', p.marketing.email)}${row('orders', 'Order updates', p.orders)}<p class="app-sub">Security alerts: always on</p>${Y.btn('del', 'Delete my account', { cls: 'secondary', disabled: ui.deleted || st.deletionRequested != null })}</div>`,
          body: `<p class="app-sub">Lock screen (${ui.pushes.length})</p>${ui.pushes.slice(0, 4).map((n) => `<div class="app-card ${n.afterDelete ? 'is-warn' : ''}"><strong>${esc(n.title)}</strong><span class="app-sub">${n.cat}${n.afterDelete ? ' · after the account was deleted' : ''}</span></div>`).join('') || '<p class="app-sub">Nothing.</p>'}`,
        }, {}, ui.banner);
        const em = sim.ui.email;
        Y.paint(el, sim, 'email', {
          head: '<div><p class="app-title">Mail</p><p class="app-sub">maya@example.com</p></div>',
          body: `${em.inbox.slice(0, 4).map((m, i) => `<div class="app-card"><strong>${esc(m.title)}</strong>${m.cat === 'marketing' && i === 0 ? Y.btn('unsub', 'Unsubscribe', { cls: 'secondary' }) : ''}</div>`).join('') || '<p class="app-sub">No mail.</p>'}`,
        }, {}, em.banner);
        const c = sim.scenario.consistency(sim);
        const jobs = Object.values(st.jobs).map((j) => `<span class="kv-file ${j.status === 'sent' ? 'has-key' : ''}">${j.id} · ${j.cat} ${j.ch} · ${j.status}${j.status === 'queued' && j.notBefore > sim.now ? ` in ${SDL.fmtMs(j.notBefore - sim.now)}` : ''}</span>`).join('');
        const cached = st.cache.maya && sim.now - st.cache.maya.t < CACHE_TTL ? `cached: promo push ${st.cache.maya.value.marketing.push ? 'on' : 'off'}, ${SDL.fmtMs(CACHE_TTL - (sim.now - st.cache.maya.t))} left` : 'nothing cached';
        SDL.ui.paintSections(el.querySelector('[data-ref="jobs"]'), {
          truth: `<p class="ops-val">Store: ${st.db.maya ? `promo push ${st.db.maya.marketing.push ? 'on' : 'off'}, promo email ${st.db.maya.marketing.email ? 'on' : 'off'}, orders ${st.db.maya.orders ? 'on' : 'off'}` : 'no row for Maya'} · ${cached}</p>`,
          jobs: `<div class="kv-files">${jobs || '<span class="app-sub">No jobs yet.</span>'}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });

  function* sendJob(c, id) {
    const st = c.state;
    const j = st.jobs[id];
    if (j.notBefore > c.now()) yield c.wait(j.notBefore - c.now());
    let check = null;
    for (;;) {
      if (j.status === 'purged') { c.log({ op: `${id} purged`, status: 'drop', detail: 'Cancelled by the account deletion. Not sent.' }); return; }
      check = null;
      if (st.config.checkAtSend) {
        const r = yield c.call('prefs', 'check', { user: 'maya', cat: j.cat, ch: j.ch }, { timeout: 500 });
        check = r.ok ? r.value : { unknown: true };
        if (check.unknown) {
          if (j.cat === 'marketing') {
            if (j.status !== 'held') { j.status = 'held'; st.stats.held++; c.log({ op: `${id} held: preferences unreadable`, status: 'retry', detail: 'Cannot tell whether Maya opted out of promotions. Marketing fails closed: wait and try again.' }); }
            yield c.wait(RECHECK_MS);
            continue;
          }
          st.stats.failOpen++;
          c.log({ op: `${id}: preferences unreadable, sending`, status: 'note', detail: `${j.cat === 'security' ? 'Security alerts' : 'Order updates'} fail open: not sending is worse than sending one she might have turned off.` });
        } else if (!check.allowed) {
          j.status = 'suppressed';
          st.stats.suppressed++;
          c.log({ op: `${id} suppressed at send`, status: 'drop', detail: 'Checked again just before sending: Maya has opted out since this was queued.' });
          c.sim.setLedger(c.actionId, 'async', 'n/a', 'Suppressed at send time.');
          return;
        }
      }
      break;
    }
    if (j.status === 'purged') return;
    const truth = st.db.maya;
    j.status = 'sent';
    j.afterDelete = st.deleted;
    j.violation = !st.deleted && j.cat !== 'security' && truth && !allowedBy(truth, j.cat, j.ch);
    j.cached = !!(check && check.cached);
    j.override = !!(check && check.override);
    if (j.ch === 'push') yield c.call('phone', 'push', { title: j.title, cat: j.cat, token: j.token }, { timeout: 500 });
    else yield c.call('email', 'receive', { title: j.title, cat: j.cat }, { timeout: 500 });
    c.sim.setLedger(c.actionId, 'async', j.violation || j.afterDelete ? 'no' : 'yes', j.afterDelete ? 'Sent to a deleted account.' : j.violation ? 'Sent against her preference.' : 'Delivered.');
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
