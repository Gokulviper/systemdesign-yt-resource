/*
 * Deep dive: realtime connections and notifications.
 *
 * Phones hold WebSockets to one of three servers behind a load balancer. A
 * connection registry maps each user to the server holding their socket,
 * refreshed by heartbeats. To deliver a message the notification router looks
 * up the user, sends through that server, falls back to mobile push, and as a
 * last resort keeps the message in an inbox synced when the app reconnects.
 *
 * Each server can complete about 45 handshakes per second. When one crashes,
 * its 100 phones reconnect: all at once (a storm) or spread out with jitter.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;

  const SERVERS = ['gw1', 'gw2', 'gw3'];
  const CROWD = 300;
  const HEARTBEAT_MS = 1000;
  const EXPIRY_MS = 2500;
  const texts = ['Your driver is 3 minutes away', 'Your driver has arrived', 'Trip started', 'You have arrived. Rate your trip'];

  function* connectFlow(ctx, user, mine, firstDelay) {
    const st = ctx.state;
    const ui = ctx.ui.rider;
    if (firstDelay) yield ctx.wait(firstDelay);
    for (let attempt = 1; ; attempt++) {
      if (mine) { ui.link = 'reconnecting'; ui.attempts = attempt; }
      const r = yield ctx.call('lb', 'connect', { user }, { timeout: 800, quiet: mine ? false : 'all' });
      if (r.ok) {
        st.clientServer[user] = r.value.server;
        if (mine) {
          Object.assign(ui, { link: 'connected', server: r.value.server, reconnectedAt: ctx.now() });
          for (const m of r.value.missed || []) ui.messages.unshift({ text: m.text, via: 'synced on reconnect', t: ctx.now() });
          if ((r.value.missed || []).length) ctx.explain(`${r.value.missed.length} message${r.value.missed.length > 1 ? 's' : ''} could not be delivered while the app was unreachable. They waited in the inbox and were synced the moment the phone reconnected.`);
        }
        return true;
      }
      st.stats.connectFails++;
      const delay = st.config.jitter ? Math.round(Math.min(4000, 400 * Math.pow(2, attempt - 1)) * (0.5 + ctx.rand())) : 150;
      yield ctx.wait(delay);
    }
  }

  function startSend(sim) {
    const st = sim.state;
    const text = texts[st.seq.msg % texts.length];
    const id = 'm' + ++st.seq.msg;
    sim.startAction(`Trip service: “${text}”`, function* (ctx) {
      ctx.ledger('retrySafe', 'yes', 'Messages carry an ID; the app ignores repeats.');
      const r = yield ctx.call('notify', 'deliver', { user: 'rider', id, text }, { timeout: 3000 });
      if (r.ok) {
        ctx.ledger('accepted', 'yes');
        ctx.ledger('committed', 'yes', 'The message is recorded before delivery is attempted.');
        ctx.ledger('displayed', r.value.via === 'inbox' ? 'pending' : 'yes', `Delivered via ${r.value.via}.`);
        ctx.ledger('async', r.value.via === 'inbox' ? 'pending' : 'n/a', r.value.via === 'inbox' ? 'Waiting in the inbox for the app to reconnect.' : null);
        const why = { socket: `It went through the WebSocket on ${sim.nodes[r.value.server] ? sim.nodes[r.value.server].label : 'the server'}, the fastest path.`, push: 'The socket path failed, so it went out as a mobile push notification through Apple or Google.', inbox: 'Neither the socket nor push worked, so it waits in the inbox and will sync when the app reconnects.' }[r.value.via];
        ctx.explain(`The notification router looked up the rider in the connection registry. ${why}`);
      } else {
        ctx.ledger('accepted', 'no');
        ctx.ledger('committed', 'no');
        ctx.ledger('displayed', 'no');
        ctx.ledger('async', 'n/a');
      }
    }, { self: 'sender', detail: `The trip service sends the rider: “${text}”.` });
  }

  const sc = (SDL.scenarios['rides-realtime'] = {
    id: 'rides-realtime',
    seed: 83,
    productWidth: 600,
    intro: 'Send a trip update to the rider, then crash WebSocket server 2 (the rider is on it) and watch 100 phones reconnect. Try it with and without jitter.',
    topology: {
      width: 1160,
      height: 600,
      nodes: [
        { id: 'rider', label: 'Your rider app', sub: 'Phone in the sidebar', kind: 'client', x: 100, y: 90, latency: 1, role: 'Holds a WebSocket while open. In the background the OS closes it, so only push notifications get through.', ops: [{ name: 'push', desc: 'Message over the socket.' }, { name: 'notification', desc: 'Mobile push.' }], owns: ['Message list'] },
        { id: 'crowd', label: 'Other phones', sub: '300 connections', kind: 'client', x: 100, y: 330, latency: 1, role: '300 other phones spread across the servers.', owns: ['Their sockets'] },
        { id: 'lb', label: 'Load balancer', sub: 'Least connections', kind: 'gateway', x: 330, y: 90, latency: 2, role: 'Sends each new connection to the healthy server with the fewest connections, and relays socket traffic.', ops: [{ name: 'connect', desc: 'Pick a server and hand over.' }, { name: 'forward', desc: 'Relay a message down a socket.' }], owns: ['Server health'] },
        { id: 'gw1', label: 'WS server 1', sub: 'WebSockets', kind: 'gateway', x: 560, y: 90, latency: 2, serviceMs: 22, role: 'Holds WebSocket connections. Each handshake takes about 22 ms of work: roughly 45 per second.', ops: [{ name: 'handshake', desc: 'Accept a connection.' }, { name: 'send', desc: 'Write to a socket.' }], owns: ['Its open sockets'] },
        { id: 'gw2', label: 'WS server 2', sub: 'WebSockets', kind: 'gateway', x: 560, y: 300, latency: 2, serviceMs: 22, role: 'Same as server 1. The rider starts here.', ops: [{ name: 'handshake', desc: 'Accept a connection.' }, { name: 'send', desc: 'Write to a socket.' }], owns: ['Its open sockets'] },
        { id: 'gw3', label: 'WS server 3', sub: 'WebSockets', kind: 'gateway', x: 560, y: 510, latency: 2, serviceMs: 22, role: 'Same as server 1.', ops: [{ name: 'handshake', desc: 'Accept a connection.' }, { name: 'send', desc: 'Write to a socket.' }], owns: ['Its open sockets'] },
        { id: 'registry', label: 'Connection registry', sub: 'User → server', kind: 'cache', x: 790, y: 90, latency: 2, role: 'Which server holds each user’s socket. Servers refresh entries with heartbeats; entries without one for 2.5 s can be expired.', ops: [{ name: 'register', desc: 'Record a connection.' }, { name: 'lookup', desc: 'Find a user’s server.' }], owns: ['user → server, last heartbeat'] },
        { id: 'notify', label: 'Notification router', sub: 'Socket, push, inbox', kind: 'service', x: 790, y: 300, latency: 3, role: 'Delivers a message by socket if possible, then by mobile push, and otherwise keeps it in an inbox for the next reconnect.', ops: [{ name: 'deliver', desc: 'Route one message.' }, { name: 'sync', desc: 'Hand over missed messages.' }], owns: ['Inbox of undelivered messages'] },
        { id: 'sender', label: 'Trip service', sub: 'Sends updates', kind: 'service', x: 1020, y: 90, latency: 3, role: 'Sends trip updates to riders.', owns: ['Trips'] },
        { id: 'push', label: 'Mobile push', sub: 'APNs and FCM', kind: 'service', x: 1020, y: 510, latency: 40, role: 'Apple and Google push services: reach phones even when the app is closed, but slower and not guaranteed.', ops: [{ name: 'send', desc: 'Deliver a notification.' }], owns: ['Device tokens'] },
      ],
      edges: [
        { from: 'rider', to: 'lb', latency: 30, label: 'WebSocket' },
        { from: 'crowd', to: 'lb', latency: 30 },
        { from: 'lb', to: 'gw1', latency: 3 },
        { from: 'lb', to: 'gw2', latency: 3 },
        { from: 'lb', to: 'gw3', latency: 3 },
        { from: 'gw1', to: 'registry', latency: 3 },
        { from: 'gw2', to: 'registry', latency: 3 },
        { from: 'gw3', to: 'registry', latency: 3, via: [[680, 400], [700, 160]] },
        { from: 'notify', to: 'registry', latency: 3 },
        { from: 'notify', to: 'gw1', latency: 3 },
        { from: 'notify', to: 'gw2', latency: 3 },
        { from: 'notify', to: 'gw3', latency: 3 },
        { from: 'sender', to: 'notify', latency: 4 },
        { from: 'notify', to: 'push', latency: 30 },
        { from: 'push', to: 'rider', latency: 40, label: 'push', via: [[1020, 585], [230, 585], [230, 140]] },
      ],
    },

    failures: [
      { id: 'gw2-down', node: 'gw2', mode: 'down', label: 'WS server 2 crashes', desc: 'Its 100 phones, including yours, lose their sockets and reconnect.' },
      { id: 'registry-down', node: 'registry', mode: 'down', label: 'Registry unavailable', desc: 'The router cannot find anyone’s server; it must fall back to push.' },
      { id: 'push-down', node: 'push', mode: 'down', label: 'Mobile push outage', desc: 'Notifications to backgrounded apps cannot be delivered.' },
      { id: 'lb-slow', node: 'lb', mode: 'slow', params: { factor: 30 }, label: 'Load balancer slow', desc: 'Connections and socket messages are delayed.' },
    ],

    switches: [
      { id: 'jitter', label: 'Jittered exponential backoff on reconnect', desc: 'Off: every phone retries immediately, together, every 150 ms.', get: (s) => s.state.config.jitter, set: (s, on) => { s.state.config.jitter = on; } },
      { id: 'pushFallback', label: 'Fall back to mobile push', desc: 'Off: if the socket path fails, the message waits in the inbox.', get: (s) => s.state.config.pushFallback, set: (s, on) => { s.state.config.pushFallback = on; } },
      { id: 'cleanup', label: 'Expire registry entries without heartbeats', desc: 'Off: the registry keeps pointing at sockets that no longer exist.', get: (s) => s.state.config.cleanup, set: (s, on) => { s.state.config.cleanup = on; } },
    ],

    presets: (function () {
      const base = (sim, sw) => {
        sim.restoreAll();
        const def = { jitter: true, pushFallback: true, cleanup: true };
        for (const [id, on] of Object.entries(Object.assign(def, sw || {}))) sim.do('setSwitch', { id, on });
      };
      return [
        { id: 'deliver', label: 'Deliver over the socket', desc: 'Registry lookup, then down the rider’s WebSocket in about 100 ms.', run: (s) => { base(s); startSend(s); } },
        { id: 'crash', label: 'Server crash, jittered reconnect', desc: 'Server 2 dies. Its phones spread their reconnects over a few seconds; the remaining servers absorb them.', run: (s) => { base(s); s.schedule(300, () => s.inject('gw2', 'down')); s.schedule(5000, () => startSend(s)); } },
        { id: 'storm', label: 'Server crash, reconnect storm', desc: 'No jitter: 100 phones retry together every 150 ms. Timed-out handshakes still use server capacity, so hundreds of attempts fail and handshake queues pass a second before the herd finally gets through.', run: (s) => { base(s, { jitter: false }); s.schedule(300, () => s.inject('gw2', 'down')); s.schedule(5000, () => startSend(s)); } },
        { id: 'background', label: 'App in the background: push', desc: 'The socket is closed, so the message goes out as a push notification.', run: (s) => { base(s); s.do('background', {}); s.schedule(3200, () => startSend(s)); } },
        { id: 'inbox', label: 'Background, push down: inbox', desc: 'Neither path works. The message waits and syncs when the rider opens the app.', run: (s) => { base(s); s.inject('push', 'down'); s.do('background', {}); s.schedule(3200, () => startSend(s)); s.schedule(5000, () => s.do('foreground', {})); } },
        { id: 'stale', label: 'Stale registry entry', desc: 'Without expiry the registry still points at the closed socket, so delivery first tries a dead path and only then falls back.', run: (s) => { base(s, { cleanup: false }); s.do('background', {}); s.schedule(3200, () => startSend(s)); } },
        { id: 'registry-down', label: 'Registry down', desc: 'No lookups possible. Every message goes out by push, slower but delivered.', run: (s) => { base(s); s.inject('registry', 'down'); startSend(s); } },
      ];
    })(),

    initialState: () => {
      const servers = { gw1: { conns: {} }, gw2: { conns: { rider: true } }, gw3: { conns: {} } };
      const registry = { rider: { server: 'gw2', t: 0 } };
      for (let i = 1; i <= CROWD; i++) {
        const s = SERVERS[(i - 1) % 3];
        servers[s].conns['p' + i] = true;
        registry['p' + i] = { server: s, t: 0 };
      }
      return {
        config: { jitter: true, pushFallback: true, cleanup: true },
        servers, registry, inbox: [], seq: { msg: 0 },
        clientServer: Object.assign({ rider: 'gw2' }, Object.fromEntries(Object.entries(registry).map(([u, e]) => [u, e.server]))),
        stats: { connectFails: 0, socket: 0, push: 0, inbox: 0, deadPath: 0 },
      };
    },
    initialUI: () => ({ rider: { app: 'foreground', link: 'connected', server: 'gw2', attempts: 0, messages: [], banner: null, reconnectedAt: null } }),

    onFailureChange(sim, e) {
      if (!SERVERS.includes(e.node) || e.mode !== 'down' || !e.active) return;
      const st = sim.state;
      const users = Object.keys(st.servers[e.node].conns).filter((u) => st.clientServer[u] === e.node);
      st.servers[e.node].conns = {};
      for (const u of users) delete st.clientServer[u];
      sim.note(`${sim.nodes[e.node].label} crashed: ${users.length} sockets dropped. Every one of those phones will try to reconnect.`);
      for (const u of users) {
        const mine = u === 'rider';
        const first = st.config.jitter ? Math.round(sim.rng() * 2500) : Math.round(sim.rng() * 30);
        sim.spawn((c) => connectFlow(c, u, mine, first), { self: mine ? 'rider' : 'crowd', quiet: mine ? false : 'all' });
      }
    },

    actions: {
      send(sim) { startSend(sim); },
      background(sim) {
        const st = sim.state;
        const ui = sim.ui.rider;
        ui.app = 'background';
        ui.link = 'background';
        for (const s of SERVERS) delete st.servers[s].conns.rider;
        delete st.clientServer.rider;
        sim.note('The rider put the app in the background; the operating system closed its WebSocket. The registry entry stays until heartbeats stop refreshing it.');
      },
      foreground(sim) {
        sim.ui.rider.app = 'foreground';
        sim.spawn((c) => connectFlow(c, 'rider', true, 0), { self: 'rider' });
      },
    },

    handlers: {
      rider: {
        push(ctx, p) {
          ctx.ui.rider.messages.unshift({ text: p.text, via: 'WebSocket', t: ctx.now() });
          ctx.ui.rider.banner = { title: 'RideNow', body: p.text, tone: 'ok', t: ctx.now() };
          return { shown: true };
        },
        notification(ctx, p) {
          ctx.ui.rider.messages.unshift({ text: p.text, via: 'push notification', t: ctx.now() });
          ctx.ui.rider.banner = { title: 'RideNow (notification)', body: p.text, tone: 'warn', t: ctx.now() };
          return { shown: true };
        },
      },
      lb: {
        connect: function* (ctx, p) {
          const st = ctx.state;
          const up = SERVERS.filter((s) => !ctx.sim.nodes[s].modes.down);
          if (!up.length) ctx.fail('UNAVAILABLE', 'No WebSocket servers are healthy.');
          const target = up.sort((a, b) => Object.keys(st.servers[a].conns).length - Object.keys(st.servers[b].conns).length || (a < b ? -1 : 1))[0];
          return ctx.must(yield ctx.call(target, 'handshake', p, { timeout: 700 }));
        },
        forward: function* (ctx, p) { return ctx.must(yield ctx.call('rider', 'push', p, { timeout: 500 })); },
      },
      gw1: gwHandlers('gw1'),
      gw2: gwHandlers('gw2'),
      gw3: gwHandlers('gw3'),
      registry: {
        register(ctx, p) { ctx.state.registry[p.user] = { server: p.server, t: ctx.now() }; return { ok: true }; },
        heartbeat(ctx, p) { for (const u of p.users) ctx.state.registry[u] = { server: p.server, t: ctx.now() }; return { refreshed: p.users.length }; },
        lookup(ctx, p) { const e = ctx.state.registry[p.user]; return e ? Object.assign({ found: true }, e) : { found: false }; },
      },
      notify: {
        deliver: function* (ctx, p) {
          const st = ctx.state;
          const look = yield ctx.call('registry', 'lookup', { user: p.user }, { timeout: 400 });
          if (look.ok && look.value.found) {
            const r = yield ctx.call(look.value.server, 'send', p, { timeout: 700 });
            if (r.ok) { st.stats.socket++; return { via: 'socket', server: look.value.server }; }
            st.stats.deadPath++;
            ctx.log({ op: 'socket delivery failed', status: 'retry', error: r.error, detail: `The registry said ${look.value.server}, but the rider’s socket is not there (${r.error.code}). Trying the next channel.` });
          }
          if (st.config.pushFallback) {
            const r = yield ctx.call('push', 'send', p, { timeout: 1500 });
            if (r.ok) { st.stats.push++; return { via: 'push' }; }
          }
          st.inbox.push(p);
          st.stats.inbox++;
          return { via: 'inbox' };
        },
        sync(ctx, p) { const st = ctx.state; const missed = st.inbox.filter((m) => m.user === p.user); st.inbox = st.inbox.filter((m) => m.user !== p.user); return { missed }; },
      },
      push: { send: function* (ctx, p) { return ctx.must(yield ctx.call('rider', 'notification', p, { timeout: 800 })); } },
    },

    setup(sim) {
      for (const s of SERVERS) {
        sim.spawn(function* (ctx) {
          for (;;) {
            yield ctx.wait(HEARTBEAT_MS);
            if (ctx.sim.nodes[s].modes.down) continue;
            const st = ctx.state;
            // Ping/pong: sockets whose phone is connected elsewhere (ghosts from
            // timed-out handshakes) get no answer and are closed.
            for (const u of Object.keys(st.servers[s].conns)) if (st.clientServer[u] && st.clientServer[u] !== s) delete st.servers[s].conns[u];
            yield ctx.call('registry', 'heartbeat', { server: s, users: Object.keys(st.servers[s].conns) }, { timeout: 500, quiet: 'all' });
          }
        }, { self: s, quiet: 'all' });
      }
      sim.spawn(function* (ctx) {
        for (;;) {
          yield ctx.wait(500);
          const st = ctx.state;
          if (!st.config.cleanup || ctx.sim.nodes.registry.modes.down) continue;
          for (const [u, e] of Object.entries(st.registry)) if (ctx.now() - e.t > EXPIRY_MS && e.t >= 0 && !(ctx.now() < EXPIRY_MS)) delete st.registry[u];
        }
      }, { self: 'registry', quiet: 'all' });
    },

    consistency(sim) {
      const st = sim.state;
      if (st.inbox.length) return { key: 'stale', label: `${st.inbox.length} message${st.inbox.length > 1 ? 's are' : ' is'} waiting in the inbox until the rider’s app reconnects.` };
      const e = st.registry.rider;
      const holders = SERVERS.filter((s) => !sim.nodes[s].modes.down && st.servers[s].conns.rider);
      const holder = e && holders.includes(e.server) ? e.server : holders[0];
      if (e && e.server !== holder) return { key: 'stale', label: `The registry says the rider is on ${sim.nodes[e.server].label}, but ${holder ? `the socket is on ${sim.nodes[holder].label}` : 'no server holds their socket'}.` };
      const connected = new Set(SERVERS.filter((s) => !sim.nodes[s].modes.down).reduce((a, s) => a.concat(Object.keys(st.servers[s].conns)), []));
      const dropped = CROWD + 1 - connected.size - (sim.ui.rider.app === 'background' ? 1 : 0);
      if (dropped > 0) return { key: 'stale', label: `${dropped} phone${dropped > 1 ? 's are' : ' is'} still reconnecting.` };
      return { key: 'ok', label: 'Every open phone is connected and the registry knows where.' };
    },

    metrics(snap, sim) {
      const st = sim.state;
      const out = SERVERS.map((s) => ({ label: `${sim.nodes[s].label} handshake queue`, value: sim.nodes[s].modes.down ? 'down' : SDL.fmtMs(sim.queueWait(s)), tone: sim.nodes[s].modes.down ? 'fail' : sim.queueWait(s) > 500 ? 'fail' : sim.queueWait(s) > 100 ? 'warn' : 'ok' }));
      return out.concat([
        { label: 'Failed connection attempts', value: st.stats.connectFails, tone: st.stats.connectFails > 50 ? 'fail' : st.stats.connectFails ? 'warn' : '' },
        { label: 'Delivered by socket, push, inbox', value: `${st.stats.socket}, ${st.stats.push}, ${st.stats.inbox}` },
      ]);
    },

    product: {
      mount(el, sim) {
        el.innerHTML = `
          <p class="panel-note phones-note">The phone shows how each message reached the rider. The console shows connections per server and how long a new handshake would wait.</p>
          <div class="hk-wrap">
            ${SDL.ui.phone.frame('rider', 'Rider phone')}
            <div class="ops-console">
              <p class="ops-title">Connections</p>
              <div class="ops-traffic"><button class="btn btn-primary" data-act="send">Send the rider a trip update</button></div>
              <div class="ops-shards" data-ref="servers"></div>
              <p class="recon" data-ref="registry"></p>
            </div>
          </div>`;
        SDL.ui.phone.wire(el.querySelector('.phone'));
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-act]');
          if (!b || b.disabled) return;
          sim.dispatch(b.dataset.act, {});
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        const u = sim.ui.rider;
        const ph = el.querySelector('.phone');
        SDL.ui.phone.render(ph, sim, 'rider', u.banner, u.link === 'reconnecting');
        const status = { connected: `Live: connected to ${sim.nodes[u.server] ? sim.nodes[u.server].label : ''}`, reconnecting: `<span class="spinner"></span>Reconnecting, attempt ${u.attempts}…`, background: 'App in the background: socket closed' }[u.link];
        let body = `<div class="app-card ${u.link === 'connected' ? 'is-ok' : u.link === 'reconnecting' ? 'is-hot' : ''}"><strong>${status}</strong></div>`;
        body += u.app === 'foreground' ? '<button class="app-btn secondary" data-act="background">Put app in background</button>' : '<button class="app-btn" data-act="foreground">Open the app</button>';
        body += `<p class="app-sub">Messages</p>${u.messages.slice(0, 4).map((m) => `<div class="app-card"><strong>${esc(m.text)}</strong><span class="app-sub">via ${esc(m.via)}</span></div>`).join('') || '<p class="app-sub">None yet.</p>'}`;
        SDL.ui.phone.paint(ph, { head: '<div><p class="app-title">RideNow</p><p class="app-sub">Trip in progress</p></div>', body }, {});
        const rows = SERVERS.map((s) => `
          <div class="ops-row" data-shard="${s}">
            <div class="ops-name"><strong>${sim.nodes[s].label}</strong><span data-live="c-${s}"></span></div>
            <div class="ops-bar"><i data-live-width="w-${s}"></i></div>
            <span class="ops-val" data-live="v-${s}"></span>
          </div>`).join('');
        const live = {};
        for (const s of SERVERS) {
          const w = sim.queueWait(s);
          live[`c-${s}`] = `${Object.keys(st.servers[s].conns).length} connections`;
          live[`w-${s}`] = `${Math.min(100, (w / 1500) * 100)}%`;
          live[`v-${s}`] = sim.nodes[s].modes.down ? 'crashed' : `${Math.round(w)} ms handshake wait`;
        }
        const box = el.querySelector('[data-ref="servers"]');
        SDL.ui.paintSections(box, { rows }, live);
        box.querySelectorAll('.ops-row').forEach((r) => {
          const s = r.dataset.shard;
          const w = sim.queueWait(s);
          r.dataset.tone = sim.nodes[s].modes.down ? 'fail' : w > 500 ? 'fail' : w > 100 ? 'warn' : 'ok';
        });
        const e = st.registry.rider;
        const reg = el.querySelector('[data-ref="registry"]');
        const txt = `Registry: rider → ${e ? `${sim.nodes[e.server].label} (heartbeat ${((sim.now - e.t) / 1000).toFixed(1)} s ago)` : 'no entry'}`;
        if (reg.textContent !== txt) reg.textContent = txt;
      },
    },
  });

  function gwHandlers(id) {
    return {
      handshake: function* (ctx, p) {
        const st = ctx.state;
        st.servers[id].conns[p.user] = true;
        yield ctx.call('registry', 'register', { user: p.user, server: id }, { timeout: 400 });
        let missed = [];
        if (p.user === 'rider') {
          const m = yield ctx.call('notify', 'sync', { user: 'rider' }, { timeout: 400 });
          if (m.ok) missed = m.value.missed;
        }
        return { server: id, missed };
      },
      send: function* (ctx, p) {
        if (!ctx.state.servers[id].conns[p.user]) ctx.fail('NOT_CONNECTED', `${p.user} has no socket on this server.`);
        return ctx.must(yield ctx.call('lb', 'forward', p, { timeout: 500 }));
      },
    };
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
