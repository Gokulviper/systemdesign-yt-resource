/*
 * Scheduled and local-time sends, expiry, and collapse.
 * "Send at 9 am local" means a different instant for Maya and for Omar. Two
 * schedulers run; only the one holding the lease dispatches due slots. A
 * leader that stalls (a long garbage-collection pause) can wake up still
 * believing it leads: a fencing token on the dispatch write is what stops it
 * sending a second time. Slots missed during an outage are sent late or
 * skipped by policy. A push that outlives its content needs an expiry, and an
 * update to the same thing needs a collapse id so it replaces the first.
 * One simulated second stands for one hour on the phones' clocks.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const HOUR = 1000; // simulated ms per hour
  const BASE = { maya: 7, omar: 4 }; // local hour at T+0: Omar is three hours behind Maya
  const LEASE_MS = 600;
  const TICK = 50;
  const PAUSE_MS = 1500;
  const LATE_LIMIT = HOUR; // later than this, the skip policy drops a slot
  const NAME = { maya: 'Maya', omar: 'Omar' };

  // d0 is the moment the current simulated day started (each guided scenario starts a fresh morning).
  const clock = (user, t, d0) => {
    const h = BASE[user] + (t - (d0 || 0)) / HOUR;
    const hh = Math.floor(h) % 24;
    const mm = Math.floor((h - Math.floor(h)) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };

  function schedule(sim, items, label) {
    sim.startAction(label, function* (ctx) {
      Y.L(ctx, { displayed: ['n/a'], retrySafe: ['yes', 'Each schedule has its own id.'] });
      const r = yield ctx.call('schedules', 'create', { items }, { timeout: 600 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { accepted: 'yes', committed: 'yes', async: ['pending', r.value.map((x) => `${NAME[x.user]} at ${clock(x.user, x.at, ctx.state.day0)} local`).join(', ')] });
      ctx.explain(`Stored ${r.value.length} schedule${r.value.length > 1 ? 's' : ''}: ${r.value.map((x) => `${NAME[x.user]} at T+${SDL.fmtMs(x.at).replace(' ms', '')} ms, which is ${clock(x.user, x.at, ctx.state.day0)} on ${x.user === 'maya' ? 'her' : 'his'} clock`).join('; ')}.`);
    }, { self: 'console' });
  }
  const daily = (sim) => schedule(sim, [
    { user: 'maya', local: 9, title: 'Good morning: today’s deals', text: 'Picked for you.' },
    { user: 'omar', local: 9, title: 'Good morning: today’s deals', text: 'Picked for you.' },
  ], 'Deals team: “today’s deals” at 9 am local, for Maya and Omar');
  const mine = (sim) => schedule(sim, [{ user: 'maya', local: 9, title: 'Good morning: today’s deals', text: 'Picked for you.' }], 'Maya: send me today’s deals at 9 am');
  const sale = (sim) => schedule(sim, [{ user: 'maya', local: 9, title: 'Flash sale: 20% off, ends at 10:00', text: 'One hour only.', expiresLocal: 10, group: 'flash-sale' }], 'Deals team: flash-sale reminder at 9 am, ends at 10:00');
  const update = (sim) => schedule(sim, [{ user: 'maya', local: 9.5, title: 'Flash sale extended: 30% off until 11:00', text: 'Better deal, more time.', expiresLocal: 11, group: 'flash-sale' }], 'Deals team: sale update at 9:30');

  function scheduler(sim, self) {
    sim.spawn(function* (ctx) {
      for (;;) {
        yield ctx.wait(TICK);
        const st = ctx.state;
        if (ctx.mode('crashed')) { st.belief[self] = null; continue; }
        const r = yield ctx.call('lease', 'acquire', { who: self }, { timeout: 300, quiet: true });
        if (r.ok) st.belief[self] = r.value.granted ? { token: r.value.token, until: ctx.now() + LEASE_MS } : null;
        // Cannot reach the lease store: keep acting only while the last lease is still valid on our own clock.
        const b = st.belief[self];
        if (!b || ctx.now() >= b.until) continue;
        const due = st.scheds.filter((s) => s.status === 'pending' && s.at <= ctx.now());
        for (const s of due) {
          const late = ctx.now() - s.at;
          if (late > LATE_LIMIT && !st.config.lateSend) {
            yield ctx.call('schedules', 'skip', { id: s.id, token: b.token, late }, { timeout: 300 });
            continue;
          }
          if (self === 'schedA' && ctx.mode('gcPause')) {
            ctx.sim.restore('schedA', 'gcPause');
            ctx.log({ op: `read ${s.id} as due, then paused`, status: 'fault', detail: `Scheduler A holds lease token ${b.token}, reads ${s.id} as due, and freezes for ${PAUSE_MS / 1000} s in a garbage-collection pause. Its lease expires while it is frozen.` });
            yield ctx.wait(PAUSE_MS);
            ctx.log({ op: `woke up, still “leader” with token ${b.token}`, status: 'note', detail: 'From inside the process no time seems to have passed. It carries on with the dispatch it had started.' });
          }
          yield ctx.call('schedules', 'dispatch', { id: s.id, token: b.token, who: self, late }, { timeout: 300 });
        }
      }
    }, { self });
  }

  const sc = (SDL.scenarios['nt-schedule'] = {
    id: 'nt-schedule',
    seed: 1301,
    minHopMs: 5,
    productWidth: 640,
    intro: 'Schedule “today’s deals” for 9 am local and watch it reach Maya at T+2 s and Omar, three time zones behind, at T+5 s. One simulated second is an hour on the phones. Then crash or freeze the leading scheduler, take the lease store down over the slot, or hold a push past its expiry.',
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'console', label: 'Deals team', sub: 'Schedules sends', kind: 'client', x: 90, y: 90, latency: 1, role: 'Creates schedules: content, recipients, “9 am local”, an optional expiry and collapse group.', owns: ['Nothing'] },
        { id: 'schedules', label: 'Schedules', sub: 'Slots + fenced dispatch', kind: 'db', x: 330, y: 90, latency: 4, role: 'Each schedule becomes one slot per recipient at that person’s 9 am. Dispatch marks a slot sent and writes its job in the same transaction. With fencing it rejects a dispatch whose lease token is older than one it has already seen.', ops: [{ name: 'create', desc: 'Store slots.' }, { name: 'dispatch', desc: 'Mark sent + enqueue.' }, { name: 'skip', desc: 'Mark skipped.' }], owns: ['slots', 'highest token seen'] },
        { id: 'sendq', label: 'Send queue', sub: 'Due jobs', kind: 'queue', x: 570, y: 90, latency: 2, queue: 'sends', role: 'Jobs for slots that are due.', owns: ['jobs'] },
        { id: 'worker', label: 'Send worker', sub: 'Checks expiry', kind: 'worker', x: 810, y: 90, latency: 3, role: 'Sends each job. With expiry on, drops a job already past its expiry and passes the expiry to the provider.', owns: ['Nothing'] },
        { id: 'apns', label: 'Push provider', sub: 'Stores for offline phones', kind: 'service', x: 1050, y: 90, latency: 25, role: 'Delivers pushes. If a phone is offline it stores the push and delivers it when the phone returns, unless the push’s expiry has passed. A push with the same collapse id as one on screen replaces it.', ops: [{ name: 'send', desc: 'Accept a push.' }], owns: ['Stored pushes'] },
        { id: 'schedA', label: 'Scheduler A', sub: 'Dispatches if it leads', kind: 'worker', x: 210, y: 300, latency: 2, role: `Every ${TICK} ms: renew or take the lease, and if it holds one, dispatch due slots with its lease token.`, owns: ['Its belief that it leads'] },
        { id: 'lease', label: 'Lease store', sub: `${LEASE_MS} ms lease, rising tokens`, kind: 'db', x: 450, y: 300, latency: 3, role: `Grants one lease at a time for ${LEASE_MS} ms. Every new grant gets a higher token. It cannot tell a holder that its lease has ended; the holder finds out only when it next asks.`, ops: [{ name: 'acquire', desc: 'Take or renew the lease.' }], owns: ['holder', 'expiry', 'token'] },
        { id: 'schedB', label: 'Scheduler B', sub: 'Standby', kind: 'worker', x: 690, y: 300, latency: 2, role: 'Same code as A. Takes the lease when A’s expires.', owns: ['Its belief that it leads'] },
        { id: 'omar', label: 'Omar’s phone', sub: 'Three hours behind', kind: 'client', x: 810, y: 480, latency: 1, role: 'Omar’s 9 am is three hours after Maya’s.', ops: [{ name: 'push', desc: 'Show a push.' }], owns: ['Local time'] },
        { id: 'phone', label: 'Maya’s phone', sub: 'Can go offline', kind: 'client', x: 1050, y: 480, latency: 1, role: 'Maya’s phone. In a tunnel it is offline and the provider holds her pushes.', ops: [{ name: 'push', desc: 'Show a push.' }], owns: ['Local time'] },
      ],
      edges: [
        { from: 'console', to: 'schedules', latency: 20, label: 'HTTPS' },
        { from: 'phone', to: 'schedules', latency: 25, via: [[1120, 480], [1120, 30], [330, 30]] },
        { from: 'schedA', to: 'schedules', latency: 3, via: [[210, 200], [330, 200]] },
        { from: 'schedB', to: 'schedules', latency: 3, via: [[690, 200], [330, 200]] },
        { from: 'schedA', to: 'lease', latency: 3 },
        { from: 'schedB', to: 'lease', latency: 3 },
        { from: 'schedules', to: 'sendq', latency: 2 },
        { from: 'sendq', to: 'worker', latency: 2 },
        { from: 'worker', to: 'apns', latency: 3 },
        { from: 'apns', to: 'phone', latency: 30 },
        { from: 'apns', to: 'omar', latency: 30, via: [[980, 90], [980, 400], [810, 400]] },
      ],
      queues: [{ id: 'sends', broker: 'sendq', label: 'due jobs', groups: ['worker'] }],
    },
    modeLabels: { gcPause: 'Freezes for 1.5 s at the next dispatch', hold: 'Phone offline: holding pushes', dst: 'Time-zone rules out of date' },
    failures: [
      { id: 'schedA-crash', node: 'schedA', mode: 'crashed', label: 'Scheduler A crash', desc: 'A stops renewing. Its lease expires and B takes over.' },
      { id: 'gc-pause', node: 'schedA', mode: 'gcPause', label: 'Scheduler A freezes (split brain)', desc: `At its next dispatch, A freezes for ${PAUSE_MS / 1000} s after reading the slot as due. B takes the lease; A wakes up still believing it leads.` },
      { id: 'lease-down', node: 'lease', mode: 'down', label: 'Lease store down', desc: 'Nobody can take or renew the lease. Once the current lease runs out, no scheduler dispatches.' },
      { id: 'queue-paused', node: 'worker', mode: 'paused', label: 'Send worker paused', desc: 'Due jobs wait in the queue.' },
      { id: 'apns-hold', node: 'apns', mode: 'hold', label: 'Maya’s phone offline', desc: 'The provider stores Maya’s pushes until she is back.' },
      { id: 'dst', node: 'schedules', mode: 'dst', label: 'Time-zone rules out of date', desc: 'Omar’s zone changed its clocks; the server’s rules have not. New slots for Omar are computed an hour early.' },
    ],
    switches: Y.switches([
      ['fence', 'Fencing tokens', 'Dispatch carries the lease token; the schedule store rejects a token older than the highest it has seen. Off: any scheduler that thinks it leads can dispatch.'],
      ['lateSend', 'Send late slots', `A slot missed by more than an hour is still sent. Off: skip it.`],
      ['ttl', 'Expiry on pushes', 'Pushes carry an expiry; the worker and the provider drop them after it. Off: a stored push is delivered whenever the phone returns.'],
      ['collapse', 'Collapse ids', 'Pushes in the same group replace each other on the phone. Off: each one stacks.'],
    ]),
    presets: Y.presets({ fence: true, lateSend: true, ttl: true, collapse: true }, [
      { id: 'two-zones', label: '9 am in two time zones', desc: 'One schedule, two slots: Maya’s 9 am at T+2 s, Omar’s at T+5 s, three hours later. Each arrives at 09:00 on its own clock.', run: (s) => { s.state.day0 = s.now; daily(s); } },
      { id: 'leader-crash', label: 'Leading scheduler crashes', desc: `A crashes just before Maya’s slot. Its lease runs out within ${LEASE_MS} ms, B takes it with a higher token and dispatches. Maya’s push is a few minutes late; Omar’s is on time.`, run: (s) => { s.state.day0 = s.now; daily(s); s.schedule(1700, () => s.inject('schedA', 'crashed')); } },
      { id: 'split-brain-no-fence', label: 'Split brain, no fencing', desc: `A reads Maya’s slot as due and freezes. B takes the lease and sends it. A wakes up with its old token, still sure it leads, and sends it again.`, sw: { fence: false }, run: (s) => { s.state.day0 = s.now; s.inject('schedA', 'gcPause'); mine(s); } },
      { id: 'split-brain-fenced', label: 'Split brain, fencing token', desc: 'Same freeze. B’s dispatch carries token 2; when A wakes up, the schedule store has seen 2 and rejects A’s token 1. One push.', run: (s) => { s.state.day0 = s.now; s.inject('schedA', 'gcPause'); mine(s); } },
      { id: 'late-send', label: 'Lease store down over the slot: send late', desc: 'The lease store is down from 08:00 to 10:30 Maya’s time. Nobody leads, so the 9 am slot is missed. When the store returns, the policy sends it, an hour and a half late.', run: (s) => { s.state.day0 = s.now; mine(s); s.schedule(1000, () => s.inject('lease', 'down', true, 2500)); } },
      { id: 'late-skip', label: 'Lease store down over the slot: skip', desc: '“Good morning” at 10:30 is worse than none, so the policy skips slots more than an hour late. Which policy is right depends on the content: a bill reminder should still go.', sw: { lateSend: false }, run: (s) => { s.state.day0 = s.now; mine(s); s.schedule(1000, () => s.inject('lease', 'down', true, 2500)); } },
      { id: 'no-ttl-stale-push', label: 'Phone offline past the sale, no expiry', desc: 'The flash-sale reminder goes out at 9:00 while Maya’s phone is in a tunnel. The provider stores it. She comes back at 10:30 and the phone shows a sale that ended half an hour ago.', sw: { ttl: false }, run: (s) => { s.state.day0 = s.now; sale(s); s.inject('apns', 'hold', true, 3500); } },
      { id: 'ttl-drops', label: 'Phone offline past the sale, with expiry', desc: 'The push carries the sale’s end as its expiry. At 10:00 the provider drops it; at 10:30 Maya sees nothing about a sale she can no longer use.', run: (s) => { s.state.day0 = s.now; sale(s); s.inject('apns', 'hold', true, 3500); } },
      { id: 'no-collapse', label: 'Sale update, no collapse id', desc: 'The 9:00 reminder says 20% until 10:00; the 9:30 update says 30% until 11:00. Both stay on the lock screen, one of them wrong.', sw: { collapse: false }, run: (s) => { s.state.day0 = s.now; sale(s); update(s); } },
      { id: 'collapse', label: 'Sale update with a collapse id', desc: 'Same two pushes in the same group. The update replaces the reminder: one notification, the current one.', run: (s) => { s.state.day0 = s.now; sale(s); update(s); } },
    ]),
    initialState: () => ({
      config: { fence: true, lateSend: true, ttl: true, collapse: true },
      day0: 0, scheds: [], lease: { holder: null, until: 0, token: 0 }, maxToken: 0, belief: { schedA: null, schedB: null },
      stats: { dispatches: 0, fenced: 0, skipped: 0, expired: 0, replaced: 0 }, seq: 0,
    }),
    initialUI: () => ({ phone: { pushes: [], banner: null }, omar: { pushes: [], banner: null } }),
    actions: {
      mine(sim) { mine(sim); },
      daily(sim) { daily(sim); },
      sale(sim) { sale(sim); },
      update(sim) { update(sim); },
    },
    handlers: {
      schedules: {
        create(ctx, p) {
          const st = ctx.state;
          const out = [];
          for (const it of p.items) {
            const shift = it.user === 'omar' && ctx.mode('dst') ? -HOUR : 0;
            let at = st.day0 + (it.local - BASE[it.user]) * HOUR + shift;
            if (at < ctx.now()) at += 24 * HOUR; // already past today: tomorrow
            const s = { id: `s${++st.seq}`, user: it.user, at, title: it.title, text: it.text, expires: it.expiresLocal != null ? at + (it.expiresLocal - it.local) * HOUR : null, group: it.group || null, status: 'pending', dispatches: 0, delivered: 0, by: [], skew: shift };
            st.scheds.push(s);
            out.push({ user: s.user, at: s.at });
          }
          return out;
        },
        dispatch(ctx, p) {
          const st = ctx.state;
          const s = st.scheds.find((x) => x.id === p.id);
          if (st.config.fence && p.token < st.maxToken) {
            st.stats.fenced++;
            ctx.log({ op: `dispatch ${p.id} rejected: token ${p.token} < ${st.maxToken}`, status: 'dup', detail: `${ctx.sim.nodes[p.who].label} is acting on a lease that has since been granted to someone else. Fenced off.` });
            ctx.fail('FENCED', `Token ${p.token} is older than ${st.maxToken}.`);
          }
          st.maxToken = Math.max(st.maxToken, p.token);
          if (st.config.fence && s.status !== 'pending') return { already: true };
          s.status = 'sent';
          s.dispatches++;
          s.by.push(`${ctx.sim.nodes[p.who].label} (token ${p.token})`);
          st.stats.dispatches++;
          ctx.sim.enqueue('sends', { type: 'push', eventId: `${s.id}#${s.dispatches}`, payload: { id: s.id }, actionId: ctx.actionId });
          if (s.dispatches > 1) ctx.log({ op: `${s.id} dispatched a second time`, status: 'fault', detail: `By ${s.by.join(' and ')}. Without fencing the store cannot tell the old leader from the new one.` });
          return { sent: true, late: p.late };
        },
        skip(ctx, p) {
          const s = ctx.state.scheds.find((x) => x.id === p.id);
          if (s.status !== 'pending') return { already: true };
          s.status = 'skipped';
          ctx.state.stats.skipped++;
          ctx.log({ op: `${s.id} skipped: ${(p.late / HOUR).toFixed(1)} h late`, status: 'drop', detail: `More than an hour past ${NAME[s.user]}’s 9 am. The policy is to skip rather than send a morning message late.` });
          return { skipped: true };
        },
      },
      lease: {
        acquire(ctx, p) {
          const L = ctx.state.lease;
          const now = ctx.now();
          if (L.holder === p.who && L.until > now) { L.until = now + LEASE_MS; return { granted: true, token: L.token }; }
          if (!L.holder || L.until <= now) {
            const prev = L.holder;
            L.holder = p.who;
            L.until = now + LEASE_MS;
            L.token++;
            if (prev !== p.who) ctx.log({ op: `lease → ${ctx.sim.nodes[p.who].label}, token ${L.token}`, status: 'ok', detail: prev ? `${ctx.sim.nodes[prev].label}’s lease had expired.` : 'First grant.' });
            return { granted: true, token: L.token };
          }
          return { granted: false };
        },
      },
      apns: {
        send(ctx, p) {
          const st = ctx.state;
          const s = st.scheds.find((x) => x.id === p.id);
          ctx.spawn(function* (c) {
            if (s.user === 'maya') while (c.sim.nodes.apns.modes.hold) {
              if (p.expires != null && c.now() > p.expires) break;
              yield c.wait(50);
            }
            if (p.expires != null && c.now() > p.expires) {
              st.stats.expired++;
              c.log({ op: `${s.id} expired in storage`, status: 'drop', detail: `Its expiry was ${clock(s.user, p.expires, st.day0)}. The provider drops it instead of delivering it late.` });
              return;
            }
            yield c.call(s.user === 'maya' ? 'phone' : 'omar', 'push', { id: s.id, collapseId: p.collapseId }, { timeout: 500 });
          }, { self: 'apns' });
          return { stored: true };
        },
      },
      phone: { push(ctx, p) { return show(ctx, 'phone', p); } },
      omar: { push(ctx, p) { return show(ctx, 'omar', p); } },
    },
    setup(sim) {
      scheduler(sim, 'schedA');
      // B starts a moment later so A is the first leader.
      sim.schedule(50, () => scheduler(sim, 'schedB'));
      Y.consumer(sim, 'sends', 'worker', 'worker', function* (ctx, msg) {
        const st = ctx.state;
        const s = st.scheds.find((x) => x.id === msg.payload.id);
        if (st.config.ttl && s.expires != null && ctx.now() > s.expires) {
          st.stats.expired++;
          ctx.log({ op: `${s.id} expired before sending`, status: 'drop', detail: 'Past its expiry already. Not sent.' });
          return true;
        }
        yield ctx.call('apns', 'send', { id: s.id, expires: st.config.ttl ? s.expires : null, collapseId: st.config.collapse ? s.group : null }, { timeout: 500 });
        return true;
      });
    },
    consistency(sim) {
      const st = sim.state;
      const ui = sim.ui;
      const twice = st.scheds.find((s) => s.delivered > 1);
      if (twice) return { key: 'wrong', label: `${NAME[twice.user]} got “${twice.title}” twice, dispatched by ${twice.by.join(' and ')}. The frozen scheduler woke up believing it still led.` };
      const stale = st.scheds.find((s) => s.delivered && s.expires != null && s.shownAt > s.expires);
      if (stale) return { key: 'wrong', label: `At ${clock(stale.user, stale.shownAt, st.day0)} Maya’s phone shows “${stale.title}”. The sale ended at ${clock(stale.user, stale.expires, st.day0)}. The provider stored the push while she was offline and nothing told it the content had a deadline.` };
      const early = st.scheds.find((s) => s.delivered && s.skew);
      if (early) return { key: 'stale', label: `Omar’s “9 am” push arrived at ${clock('omar', early.shownAt, st.day0)} his time. The server’s time-zone rules missed his zone’s clock change.` };
      const groups = {};
      for (const id of ['phone', 'omar']) for (const n of ui[id].pushes) if (n.group) groups[n.group] = (groups[n.group] || 0) + 1;
      if (Object.values(groups).some((n) => n > 1)) return { key: 'stale', label: 'Two notifications about the same sale sit on the lock screen: “20% until 10:00” and “30% until 11:00”. One of them is now wrong, and Maya has to work out which.' };
      const overdue = st.scheds.find((s) => s.status === 'pending' && sim.now - s.at > 300);
      if (overdue) return { key: 'stale', label: `${NAME[overdue.user]}’s 9 am slot is ${((sim.now - overdue.at) / HOUR).toFixed(1)} h overdue: no scheduler holds the lease.` };
      if (!st.scheds.length) return { key: 'ok', label: 'Nothing scheduled.' };
      const parts = [];
      const done = st.scheds.filter((s) => s.delivered && !s.replaced);
      for (const s of done) parts.push(`${NAME[s.user]} at ${clock(s.user, s.shownAt, st.day0)} local${s.shownAt - s.at > 250 ? ` (${Math.round((s.shownAt - s.at) / HOUR * 60)} min late)` : ''}.`);
      if (st.stats.fenced) parts.push(`A stale dispatch from the frozen scheduler was fenced off.`);
      if (st.stats.skipped) parts.push(`${st.stats.skipped} slot skipped as too late.`);
      if (st.stats.expired) parts.push(`${st.stats.expired} push expired unseen, as intended.`);
      if (st.stats.replaced) parts.push('The update replaced the reminder.');
      if (st.scheds.some((s) => s.status === 'pending')) parts.push('Waiting for the next slot.');
      return { key: 'ok', label: parts.join(' ') };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const lateness = st.scheds.filter((s) => s.delivered).map((s) => s.shownAt - s.at);
      const L = st.lease;
      return [
        { label: 'Lease', value: L.holder && L.until > sim.now ? `${sim.nodes[L.holder].label.replace('Scheduler ', '')}, token ${L.token}` : 'nobody', tone: L.holder && L.until > sim.now ? '' : 'warn' },
        { label: 'Slots', value: st.scheds.length },
        { label: 'Worst lateness', value: lateness.length ? `${Math.round(Math.max(...lateness) / HOUR * 60)} min` : 'n/a', tone: lateness.some((x) => x > HOUR) ? 'warn' : '' },
        { label: 'Dispatches', value: st.stats.dispatches, tone: st.scheds.some((s) => s.dispatches > 1) ? 'fail' : '' },
        { label: 'Fenced off', value: st.stats.fenced },
        { label: 'Skipped', value: st.stats.skipped },
        { label: 'Expired unseen', value: st.stats.expired },
        { label: 'Replaced by collapse', value: st.stats.replaced },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone'], ['omar', 'Omar’s phone']], {
          note: 'One simulated second is one hour on the phones’ clocks. Maya can schedule her own 9 am deals; the deals team schedules for both and runs the flash sale.',
          below: `<div class="ops-console"><p class="ops-title">Deals team</p><div class="ops-traffic">
              ${Y.btn('daily', '9 am deals for Maya and Omar', {})}
              ${Y.btn('sale', 'Flash-sale reminder at 9:00', { cls: 'secondary' })}
              ${Y.btn('update', 'Sale update at 9:30', { cls: 'secondary' })}
            </div><div data-ref="slots"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const id of ['phone', 'omar']) {
          const user = id === 'phone' ? 'maya' : 'omar';
          const ui = sim.ui[id];
          const offline = id === 'phone' && sim.nodes.apns.modes.hold;
          const cards = ui.pushes.map((n) => `<div class="app-card ${n.expired ? 'is-warn' : 'is-ok'}"><strong>${esc(n.title)}</strong><span class="app-sub">${esc(n.text)}</span><span class="app-sub">arrived ${n.local}${n.replaced ? ' · replaced the earlier one' : ''}${n.expired ? ' · already over' : ''}</span></div>`).join('');
          Y.paint(el, sim, id, {
            head: `<div><p class="app-title">${clock(user, sim.now, st.day0)}</p><p class="app-sub">${NAME[user]}${offline ? ' · offline, in a tunnel' : ''}</p></div>`,
            act: id === 'phone' ? `<div class="app-sec">${Y.btn('mine', 'Send me deals at 9 am', {})}</div>` : '',
            body: `<p class="app-sub">Lock screen (${ui.pushes.length})</p>${cards || '<p class="app-sub">Nothing yet.</p>'}`,
          }, {}, ui.banner);
        }
        const c = sim.scenario.consistency(sim);
        const rows = st.scheds.map((s) => {
          const tone = s.dispatches > 1 ? 'fail' : s.status === 'pending' && sim.now > s.at + 300 ? 'warn' : 'ok';
          return `<span class="kv-file ${s.status !== 'pending' ? 'has-key' : ''}" data-tone="${tone}">${s.id} · ${NAME[s.user]} ${clock(s.user, s.at, st.day0)} · ${s.status}${s.dispatches > 1 ? ` ×${s.dispatches}` : ''}</span>`;
        }).join('');
        const L = st.lease;
        SDL.ui.paintSections(el.querySelector('[data-ref="slots"]'), {
          lease: `<p class="ops-val">Lease: ${L.holder && L.until > sim.now ? `${sim.nodes[L.holder].label}, token ${L.token}, ${SDL.fmtMs(L.until - sim.now)} left` : 'nobody holds it'} · A believes ${st.belief.schedA && sim.now < st.belief.schedA.until ? `it leads (token ${st.belief.schedA.token})` : 'it does not lead'} · B believes ${st.belief.schedB && sim.now < st.belief.schedB.until ? `it leads (token ${st.belief.schedB.token})` : 'it does not lead'}</p>`,
          rows: `<div class="kv-files">${rows || '<span class="app-sub">No slots yet.</span>'}</div>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });

  function show(ctx, id, p) {
    const st = ctx.state;
    const ui = ctx.ui[id];
    const s = st.scheds.find((x) => x.id === p.id);
    const user = id === 'phone' ? 'maya' : 'omar';
    s.delivered++;
    s.shownAt = ctx.now();
    const entry = { id: s.id, group: s.group, title: s.title, text: s.text, local: clock(user, ctx.now(), st.day0), expired: s.expires != null && ctx.now() > s.expires };
    const prev = p.collapseId ? ui.pushes.findIndex((n) => n.group === p.collapseId) : -1;
    if (prev >= 0) {
      st.stats.replaced++;
      const old = st.scheds.find((x) => x.id === ui.pushes[prev].id);
      if (old) old.replaced = true;
      ui.pushes.splice(prev, 1);
      entry.replaced = true;
      ctx.log({ op: `replaced by collapse id ${p.collapseId}`, status: 'dup', detail: 'Same group as a notification already on screen. The new one takes its place.' });
    }
    ui.pushes.unshift(entry);
    ui.banner = { title: s.title, body: s.text, tone: entry.expired ? 'warn' : 'ok', t: ctx.now() };
    return { shown: true };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
