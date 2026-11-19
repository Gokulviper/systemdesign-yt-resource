/*
 * The in-app inbox and the unread badge on every device.
 * The inbox store is the truth. A new entry reaches Maya's phone over its
 * WebSocket when the app is open, by push when it is not, and her offline
 * tablet catches up when it reconnects. The badge can be derived from the
 * inbox (count unread entries) or kept as a stored counter that every create
 * and read must adjust; the counter drifts whenever one of those adjustments
 * is lost. Reading on one device must reach the others, and the inbox list
 * pages by cursor so that clearing entries does not make the next page skip.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;
  const Y = SDL.yt;

  const PAGE = 4;
  const TITLES = ['Your order has shipped', 'Your refund is on its way', 'Omar shared a list with you', 'Price drop on a saved item', 'Your review was published', 'New sign-in from Safari'];
  const DEV = { phone: 'phone', tablet: 'tablet' };
  const LABEL = { phone: 'Phone', tablet: 'Tablet' };

  const visible = (st) => st.entries.filter((e) => !e.archived);
  const unread = (st) => visible(st).filter((e) => !e.read).length;

  function create(sim) {
    const st = sim.state;
    const n = ++st.seq;
    sim.startAction(`Orders team: “${TITLES[(n - 1) % TITLES.length]}” to Maya`, function* (ctx) {
      Y.L(ctx, { displayed: ['n/a'], retrySafe: ['yes', 'Inbox insert is idempotent by id.'] });
      const r = yield ctx.call('api', 'create', { id: `n${n}`, title: TITLES[(n - 1) % TITLES.length] }, { timeout: 700 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      Y.L(ctx, { accepted: 'yes', committed: ['yes', 'In the inbox store.'], async: ['pending', 'Delivering to devices.'] });
    }, { self: 'console' });
  }

  function read(sim, dev, id) {
    const st = sim.state;
    const ui = sim.ui[dev];
    const e = ui.list.find((x) => x.id === id && !x.read);
    if (!e) return;
    e.read = true;
    ui.badge = Math.max(0, ui.badge - 1);
    sim.startAction(`Maya reads “${e.title}” on the ${dev}`, function* (ctx) {
      Y.L(ctx, { displayed: ['yes', 'Marked read on this device at once.'], retrySafe: 'yes' });
      const r = yield ctx.call('sync', 'markRead', { id, from: dev }, { timeout: 600 });
      if (!r.ok) {
        ctx.log({ op: 'read receipt lost', status: 'lost', detail: `The ${dev} shows it read, but the server never recorded it. The client does not retry.` });
        Y.L(ctx, { accepted: ['no', 'The read never reached the server.'], committed: 'no', async: 'n/a' });
        return;
      }
      if (r.value.badge != null) ui.badge = r.value.badge;
      Y.L(ctx, { accepted: 'yes', committed: 'yes', async: [st.config.sync ? 'yes' : 'n/a', st.config.sync ? 'Read state sent to the other devices.' : 'Other devices find out when they next refresh.'] });
    }, { self: dev });
  }

  function refresh(sim, dev) {
    sim.startAction(`Maya opens the app on the ${dev}`, function* (ctx) {
      Y.L(ctx, { displayed: ['pending'], retrySafe: 'yes' });
      const r = yield ctx.call('sync', 'catchUp', { dev }, { timeout: 700 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      const ui = ctx.ui[dev];
      ui.list = r.value.entries;
      ui.view = { ids: r.value.entries.slice(0, PAGE).map((e) => e.id), offset: PAGE };
      ui.badge = r.value.badge;
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'n/a', async: 'n/a' });
      ctx.explain(`The ${dev} fetched the inbox: ${r.value.unread} unread. Badge set to ${r.value.badge}${r.value.badge !== r.value.unread ? `, which is what the stored counter says, not what the inbox holds` : ''}.`);
    }, { self: dev });
  }

  function more(sim) {
    const st = sim.state;
    const ui = sim.ui.phone;
    sim.startAction('Maya scrolls to the next page on the phone', function* (ctx) {
      Y.L(ctx, { displayed: ['pending'], retrySafe: 'yes' });
      const last = ui.view.ids.length ? st.entries.find((e) => e.id === ui.view.ids[ui.view.ids.length - 1]) : null;
      const r = yield ctx.call('api', 'page', st.config.cursor ? { before: last ? last.t : null } : { offset: ui.view.offset }, { timeout: 600 });
      if (!r.ok) { Y.failed(ctx, r.error.code); return; }
      const fresh = r.value.filter((e) => !ui.view.ids.includes(e.id));
      ui.view.ids.push(...fresh.map((e) => e.id));
      ui.view.offset += PAGE;
      ui.view.pages = (ui.view.pages || 1) + 1;
      for (const e of r.value) if (!ui.list.some((x) => x.id === e.id)) ui.list.push(e);
      Y.L(ctx, { displayed: 'yes', accepted: 'yes', committed: 'n/a', async: 'n/a' });
      ctx.explain(st.config.cursor ? `Asked for entries older than the last one shown. Got ${r.value.length}.` : `Asked for offset ${ui.view.offset - PAGE}. Clearing entries moved everything up, so offset ${ui.view.offset - PAGE} now starts further down the list.`);
    }, { self: 'phone' });
  }

  function archive(sim, id) {
    const ui = sim.ui.phone;
    sim.startAction('Maya clears an entry on the phone', function* (ctx) {
      Y.L(ctx, { displayed: ['yes'], retrySafe: 'yes' });
      ui.view.ids = ui.view.ids.filter((x) => x !== id);
      ui.list = ui.list.filter((x) => x.id !== id);
      const r = yield ctx.call('api', 'archive', { id }, { timeout: 600 });
      Y.L(ctx, { accepted: r.ok ? 'yes' : 'no', committed: r.ok ? 'yes' : 'no', async: 'n/a' });
    }, { self: 'phone' });
  }

  function deliverTo(ctx, dev, p) {
    const ui = ctx.ui[dev];
    if (!ui.list.some((x) => x.id === p.entry.id)) ui.list.unshift(Object.assign({}, p.entry));
    if (p.badge != null) ui.badge = p.badge;
    return { shown: true };
  }

  const sc = (SDL.scenarios['nt-inbox'] = {
    id: 'nt-inbox',
    seed: 1409,
    minHopMs: 5,
    productWidth: 680,
    intro: 'Send a notification and watch it reach the phone over its open WebSocket and the tablet by push. Read on the tablet and watch the phone’s badge. Then drop the socket, take the tablet offline, lose a read receipt, take the badge counter down, or clear entries and scroll.',
    topology: {
      width: 1160, height: 580,
      nodes: [
        { id: 'console', label: 'Orders team', sub: 'Sends to Maya', kind: 'client', x: 90, y: 90, latency: 1, role: 'Creates inbox notifications.', owns: ['Nothing'] },
        { id: 'api', label: 'Notification API', sub: 'Create, page, clear', kind: 'gateway', x: 330, y: 90, latency: 3, role: 'Writes the inbox entry, adjusts the stored counter if there is one, and serves pages of the inbox.', ops: [{ name: 'create', desc: 'New entry.' }, { name: 'page', desc: 'A page of the inbox.' }, { name: 'archive', desc: 'Clear an entry.' }], owns: ['Nothing durable'] },
        { id: 'inboxdb', label: 'Inbox store', sub: 'The truth', kind: 'db', x: 570, y: 90, latency: 5, queue: 'events', role: 'Every entry and whether it is read. A derived badge is a count over this.', ops: [{ name: 'insert', desc: 'Add an entry.' }], owns: ['entries', 'read state'] },
        { id: 'fanout', label: 'Device fan-out', sub: 'Socket, else push', kind: 'worker', x: 810, y: 90, latency: 2, role: 'For each of Maya’s devices: send over its WebSocket if it has one open, otherwise by push.', owns: ['Nothing'] },
        { id: 'apns', label: 'Push provider', sub: 'Stores the last push', kind: 'service', x: 1050, y: 90, latency: 25, role: 'Delivers pushes with a badge number. For an offline device it keeps the latest one and delivers it on reconnect.', ops: [{ name: 'send', desc: 'Deliver a push.' }], owns: ['Last stored push per device'] },
        { id: 'counter', label: 'Badge counter', sub: 'Stored unread count', kind: 'cache', x: 90, y: 300, latency: 2, role: 'Used when the badge is a stored counter: plus one on create, minus one on read. Any lost adjustment is permanent.', ops: [{ name: 'incr', desc: 'Plus one.' }, { name: 'decr', desc: 'Minus one.' }, { name: 'get', desc: 'Read the count.' }], owns: ['unread count'] },
        { id: 'sync', label: 'Read-state sync', sub: 'Reads + catch-up', kind: 'service', x: 330, y: 300, latency: 3, role: 'Records reads, then tells Maya’s other devices so their badges follow. Also serves catch-up when a device reconnects or the app opens.', ops: [{ name: 'markRead', desc: 'Record a read.' }, { name: 'catchUp', desc: 'Entries + badge.' }], owns: ['Nothing durable'] },
        { id: 'gateway', label: 'WebSocket gateway', sub: 'Open app connections', kind: 'gateway', x: 810, y: 300, latency: 2, role: 'Holds a WebSocket for each device with the app open. Instant, but only while connected.', ops: [{ name: 'deliver', desc: 'Send on the socket.' }], owns: ['Connections'] },
        { id: 'phone', label: 'Maya’s phone', sub: 'App open, socket', kind: 'client', x: 570, y: 480, latency: 1, role: 'App in the foreground with a WebSocket.', ops: [{ name: 'event', desc: 'Socket message.' }, { name: 'push', desc: 'A push.' }], owns: ['Local list and badge'] },
        { id: 'tablet', label: 'Maya’s tablet', sub: 'Background or offline', kind: 'client', x: 1050, y: 480, latency: 1, role: 'No open app, so no socket: it gets pushes, or nothing while offline, and catches up when it reconnects.', ops: [{ name: 'event', desc: 'Socket message.' }, { name: 'push', desc: 'A push.' }], owns: ['Local list and badge'] },
      ],
      edges: [
        { from: 'console', to: 'api', latency: 20, label: 'HTTPS' },
        { from: 'api', to: 'inboxdb', latency: 3 },
        { from: 'api', to: 'counter', latency: 2, via: [[330, 190], [90, 190]] },
        { from: 'inboxdb', to: 'fanout', latency: 2 },
        { from: 'fanout', to: 'apns', latency: 3 },
        { from: 'fanout', to: 'gateway', latency: 2 },
        { from: 'sync', to: 'counter', latency: 2 },
        { from: 'sync', to: 'inboxdb', latency: 3, via: [[450, 300], [450, 160], [570, 160]] },
        { from: 'sync', to: 'gateway', latency: 2 },
        { from: 'sync', to: 'apns', latency: 3, via: [[250, 300], [250, 545], [1120, 545], [1120, 90]] },
        { from: 'gateway', to: 'phone', latency: 15, via: [[810, 420], [570, 420]] },
        { from: 'gateway', to: 'tablet', latency: 15, via: [[810, 480]] },
        { from: 'apns', to: 'tablet', latency: 30 },
        { from: 'apns', to: 'phone', latency: 30, via: [[1050, 200], [690, 200], [690, 480]] },
        { from: 'phone', to: 'sync', latency: 20, via: [[450, 480], [450, 340], [330, 340]] },
        { from: 'tablet', to: 'sync', latency: 20, via: [[1050, 520], [330, 520]] },
        { from: 'phone', to: 'api', latency: 20, via: [[520, 480], [520, 130], [330, 130]] },
      ],
      queues: [{ id: 'events', broker: 'inboxdb', label: 'new entries', groups: ['fanout'] }],
    },
    modeLabels: { dropSocket: 'Phone’s socket dropped', dropRead: 'Read receipts lost', retryCreate: 'Create retried by the client' },
    failures: [
      { id: 'socket-drop', node: 'gateway', mode: 'dropSocket', label: 'WebSocket drop', desc: 'The phone’s socket is gone. Until it reconnects, new entries go by push.' },
      { id: 'counter-down', node: 'counter', mode: 'down', label: 'Badge counter down', desc: 'Increments and decrements fail. With a stored counter they are simply lost.' },
      { id: 'inbox-slow', node: 'inboxdb', mode: 'slow', params: { factor: 30 }, label: 'Inbox write slow', desc: 'Inserts take about 150 ms instead of 5.' },
      { id: 'read-lost', node: 'sync', mode: 'dropRead', label: 'Read receipt lost', desc: 'Reads fail on the way to the server. The device still shows them read.' },
      { id: 'tablet-offline', node: 'tablet', mode: 'down', label: 'Tablet offline', desc: 'No socket and no push until it reconnects. On restore it catches up.' },
      { id: 'create-retried', node: 'api', mode: 'retryCreate', label: 'Entry created twice', desc: 'The client times out and retries a create. The inbox insert is idempotent by id; a stored counter’s increment is not.' },
    ],
    switches: Y.switches([
      ['derived', 'Badge derived from the inbox', 'Badge = unread entries in the inbox store. Off: a stored counter, plus one on create and minus one on read.'],
      ['sync', 'Read-state sync', 'A read on one device updates the badge on the others, by socket or a silent push. Off: they find out when the app is next opened.'],
      ['cursor', 'Cursor pagination', '“Next page” means “older than the last entry I showed”. Off: “skip the first N”.'],
    ]),
    presets: Y.presets({ derived: true, sync: true, cursor: true }, [
      { id: 'socket-and-push', label: 'One entry: socket to the phone, push to the tablet', desc: 'The phone’s app is open, so the entry arrives over the WebSocket in a few milliseconds. The tablet has no socket; it gets a push with the badge. Both show 1.', run: (s) => { s.state.dev.tablet = true; create(s); } },
      { id: 'socket-drop', label: 'Socket dropped: push instead', desc: 'The phone’s socket has dropped. Fan-out sees no connection and sends a push. Slightly slower, same result.', run: (s) => { s.state.dev.tablet = true; s.inject('gateway', 'dropSocket'); create(s); } },
      { id: 'offline-catchup', label: 'Tablet offline, then catches up', desc: 'Three entries arrive while the tablet is offline. When it reconnects, the provider delivers the latest push and the tablet asks for everything since: three entries, badge 3.', run: (s) => { s.inject('tablet', 'down', true, 2500); create(s); s.schedule(300, () => create(s)); s.schedule(600, () => create(s)); } },
      { id: 'read-no-sync', label: 'Read on the tablet, no sync', desc: 'Two entries; Maya reads both on the tablet. The server knows, but nothing tells the phone, whose badge still says 2.', sw: { sync: false }, run: (s) => { s.state.dev.tablet = true; create(s); s.schedule(200, () => create(s)); s.schedule(1500, () => read(s, 'tablet', 'n1')); s.schedule(1700, () => read(s, 'tablet', 'n2')); } },
      { id: 'read-sync', label: 'Read on the tablet, synced', desc: 'Same reads. Each one is pushed to the phone over its socket; the phone’s badge goes 2, 1, 0.', run: (s) => { s.state.dev.tablet = true; create(s); s.schedule(200, () => create(s)); s.schedule(1500, () => read(s, 'tablet', 'n1')); s.schedule(1700, () => read(s, 'tablet', 'n2')); } },
      { id: 'counter-drift', label: 'Stored counter loses decrements', desc: 'Three entries, counter 3. The counter is down while Maya reads all three on the tablet, so the decrements are lost. When she opens the app on the phone: nothing unread, badge 3, for ever.', sw: { derived: false }, run: (s) => { s.state.dev.tablet = true; create(s); s.schedule(200, () => create(s)); s.schedule(400, () => create(s)); s.schedule(1300, () => s.inject('counter', 'down', true, 1500)); s.schedule(1500, () => read(s, 'tablet', 'n1')); s.schedule(1700, () => read(s, 'tablet', 'n2')); s.schedule(1900, () => read(s, 'tablet', 'n3')); s.schedule(3500, () => refresh(s, 'phone')); } },
      { id: 'derived-count', label: 'Derived badge through the same outage', desc: 'Same reads, same counter outage, but the badge is counted from the inbox. There is nothing to lose: the phone shows 0.', run: (s) => { s.state.dev.tablet = true; create(s); s.schedule(200, () => create(s)); s.schedule(400, () => create(s)); s.schedule(1300, () => s.inject('counter', 'down', true, 1500)); s.schedule(1500, () => read(s, 'tablet', 'n1')); s.schedule(1700, () => read(s, 'tablet', 'n2')); s.schedule(1900, () => read(s, 'tablet', 'n3')); s.schedule(3500, () => refresh(s, 'phone')); } },
      { id: 'lost-read', label: 'Read receipt lost', desc: 'Maya reads on the tablet; the request fails and the client does not retry. The tablet says read, the server and the phone say unread. The next catch-up will bring it back as unread on the tablet.', run: (s) => { s.state.dev.tablet = true; create(s); s.schedule(1200, () => s.inject('sync', 'dropRead', true, 600)); s.schedule(1500, () => read(s, 'tablet', 'n1')); } },
      { id: 'offset-skips', label: 'Clear two, scroll: offset pagination', desc: `Page one shows the ${PAGE} newest. Maya clears two of them and scrolls. “Skip ${PAGE}” now skips two entries she has never seen.`, sw: { cursor: false }, run: (s) => { s.schedule(300, () => archive(s, 'o8')); s.schedule(600, () => archive(s, 'o7')); s.schedule(1000, () => more(s)); } },
      { id: 'cursor', label: 'Clear two, scroll: cursor', desc: '“Older than the last one shown” does not care what was cleared above it. Nothing is skipped.', run: (s) => { s.schedule(300, () => archive(s, 'o8')); s.schedule(600, () => archive(s, 'o7')); s.schedule(1000, () => more(s)); } },
    ]),
    initialState: () => {
      const entries = [];
      for (let i = 8; i >= 1; i--) entries.push({ id: `o${i}`, title: `Older update ${i}`, t: -100000 + i * 1000, read: true, archived: false });
      return { config: { derived: true, sync: true, cursor: true }, entries, counter: 0, dev: { tablet: false }, seq: 0, stats: { socket: 0, push: 0, catchUps: 0, lostDecr: 0, lostIncr: 0, syncs: 0 } };
    },
    initialUI: () => {
      const list = [];
      for (let i = 8; i >= 1; i--) list.push({ id: `o${i}`, title: `Older update ${i}`, t: -100000 + i * 1000, read: true });
      const page = list.slice(0, PAGE).map((e) => e.id);
      return {
        phone: { list: list.slice(), badge: 0, view: { ids: page, offset: PAGE }, banner: null },
        tablet: { list: list.slice(), badge: 0, view: { ids: page.slice(), offset: PAGE }, banner: null },
      };
    },
    actions: {
      create(sim) { create(sim); },
      read(sim, a) { read(sim, a.dev, a.id); },
      refresh(sim, a) { refresh(sim, a.dev); },
      more(sim) { more(sim); },
      archive(sim, a) { archive(sim, a.id); },
    },
    onFailureChange(sim, f) {
      if (f.node === 'tablet' && f.mode === 'down' && !f.active) {
        sim.state.dev.tablet = true;
        // Back online: the provider hands over the push it kept, and the app catches up.
        const held = sim.state.heldTablet;
        if (held) { sim.state.heldTablet = null; sim.spawn(function* (ctx) { yield ctx.call('tablet', 'push', held, { timeout: 500 }); }, { self: 'apns' }); }
        refresh(sim, 'tablet');
      }
      if (f.node === 'tablet' && f.mode === 'down' && f.active) sim.state.dev.tablet = false;
    },
    handlers: {
      api: {
        create: function* (ctx, p) {
          const st = ctx.state;
          ctx.must(yield ctx.call('inboxdb', 'insert', p, { timeout: 600 }));
          const times = ctx.mode('retryCreate') ? 2 : 1;
          for (let i = 0; i < times; i++) {
            if (i) ctx.log({ op: 'client retried the create', status: 'retry', detail: 'Same id, so the inbox insert is a no-op. The counter increment is not.' });
            if (!st.config.derived) {
              const r = yield ctx.call('counter', 'incr', {}, { timeout: 300 });
              if (!r.ok) { st.stats.lostIncr++; ctx.log({ op: 'increment lost', status: 'fault', detail: 'The counter is down. The badge will undercount by one, permanently.' }); }
            }
          }
          return { id: p.id };
        },
        page(ctx, p) {
          const v = visible(ctx.state);
          if (p.before !== undefined) return v.filter((e) => p.before == null || e.t < p.before).slice(0, PAGE).map((e) => Object.assign({}, e));
          return v.slice(p.offset, p.offset + PAGE).map((e) => Object.assign({}, e));
        },
        archive(ctx, p) { const e = ctx.state.entries.find((x) => x.id === p.id); if (e) e.archived = true; return { archived: true }; },
      },
      inboxdb: {
        insert(ctx, p) {
          const st = ctx.state;
          if (st.entries.some((e) => e.id === p.id)) return { existing: true };
          const e = { id: p.id, title: p.title, t: ctx.now(), read: false, archived: false };
          st.entries.unshift(e);
          ctx.sim.enqueue('events', { type: 'entry', eventId: p.id, payload: { entry: e }, actionId: ctx.actionId });
          return { inserted: true };
        },
      },
      counter: {
        incr(ctx) { return { n: ++ctx.state.counter }; },
        decr(ctx) { ctx.state.counter = Math.max(0, ctx.state.counter - 1); return { n: ctx.state.counter }; },
        get(ctx) { return { n: ctx.state.counter }; },
      },
      sync: {
        markRead: function* (ctx, p) {
          const st = ctx.state;
          if (ctx.mode('dropRead')) ctx.fail('UNAVAILABLE', 'The read never arrived.');
          const e = st.entries.find((x) => x.id === p.id);
          if (e && !e.read) {
            e.read = true;
            if (!st.config.derived) {
              const r = yield ctx.call('counter', 'decr', {}, { timeout: 300 });
              if (!r.ok) { st.stats.lostDecr++; ctx.log({ op: 'decrement lost', status: 'fault', detail: 'The counter is down. The stored badge stays one too high, permanently.' }); }
            }
          }
          const badge = yield* badgeOf(ctx);
          if (st.config.sync) {
            for (const dev of ['phone', 'tablet']) {
              if (dev === p.from || !online(ctx, dev)) continue;
              st.stats.syncs++;
              const via = dev === 'phone' && !ctx.sim.nodes.gateway.modes.dropSocket ? 'gateway' : 'apns';
              ctx.spawn(function* (c) { yield c.call(via, via === 'gateway' ? 'deliver' : 'send', { dev, state: true, id: p.id, badge }, { timeout: 500 }); }, { self: 'sync' });
            }
          }
          return { badge };
        },
        catchUp: function* (ctx, p) {
          const st = ctx.state;
          if (p.dev === 'tablet') st.stats.catchUps++;
          const badge = yield* badgeOf(ctx);
          return { entries: visible(st).map((e) => Object.assign({}, e)), badge, unread: unread(st), dev: p.dev };
        },
      },
      gateway: {
        deliver: function* (ctx, p) {
          if (p.dev === 'phone' && ctx.mode('dropSocket')) ctx.fail('UNAVAILABLE', 'No open socket for this device.');
          return ctx.must(yield ctx.call(p.dev, 'event', p, { timeout: 300 }));
        },
      },
      apns: {
        send: function* (ctx, p) {
          if (!online(ctx, p.dev)) {
            ctx.state.heldTablet = p;
            ctx.log({ op: `stored for the ${p.dev}`, status: 'note', detail: 'The device is offline. The provider keeps the latest push and delivers it on reconnect.' });
            return { stored: true };
          }
          return ctx.must(yield ctx.call(p.dev, 'push', p, { timeout: 500 }));
        },
      },
      phone: { event: (ctx, p) => onDevice(ctx, 'phone', p, 'socket'), push: (ctx, p) => onDevice(ctx, 'phone', p, 'push') },
      tablet: { event: (ctx, p) => onDevice(ctx, 'tablet', p, 'socket'), push: (ctx, p) => onDevice(ctx, 'tablet', p, 'push') },
    },
    setup(sim) {
      Y.consumer(sim, 'events', 'fanout', 'fanout', function* (ctx, msg) {
        const badge = yield* badgeOf(ctx);
        for (const dev of ['phone', 'tablet']) {
          const p = { dev, entry: msg.payload.entry, badge };
          if (dev === 'phone' && !ctx.sim.nodes.gateway.modes.dropSocket) {
            const r = yield ctx.call('gateway', 'deliver', p, { timeout: 400 });
            if (r.ok) { ctx.state.stats.socket++; continue; }
          }
          if (dev === 'phone') ctx.log({ op: 'no socket: push instead', status: 'retry', detail: 'The phone has no open WebSocket. Falling back to a push.' });
          const r = yield ctx.call('apns', 'send', p, { timeout: 500 });
          if (r.ok) ctx.state.stats.push++;
        }
        return true;
      });
    },
    consistency(sim) {
      const st = sim.state;
      const ui = sim.ui;
      const truth = unread(st);
      const view = ui.phone.view;
      if (view.pages > 1) {
        const shown = view.ids.map((id) => st.entries.find((e) => e.id === id)).filter(Boolean);
        const oldest = Math.min(...shown.map((e) => e.t));
        const skipped = visible(st).filter((e) => e.t >= oldest && !view.ids.includes(e.id));
        if (skipped.length) return { key: 'wrong', label: `Maya scrolled past ${skipped.map((e) => `“${e.title}”`).join(' and ')} without ever seeing ${skipped.length > 1 ? 'them' : 'it'}. Clearing two entries moved everything up, and “skip ${PAGE}” skipped over the gap.` };
      }
      if (!st.config.derived && sim.queueStats('events').depth === 0 && st.counter !== truth) {
        const showing = ['phone', 'tablet'].filter((d) => online({ sim }, d) && ui[d].badge === st.counter && st.counter !== truth);
        return { key: 'wrong', label: `The stored counter says ${st.counter}; the inbox has ${truth} unread. ${st.stats.lostDecr ? `${st.stats.lostDecr} decrement${st.stats.lostDecr > 1 ? 's were' : ' was'} lost while the counter was down` : `${st.stats.lostIncr} increment${st.stats.lostIncr > 1 ? 's were' : ' was'} lost or doubled`}, and nothing ever recounts. ${showing.length ? `The ${showing.join(' and ')} badge shows ${st.counter} with nothing to read.` : ''}` };
      }
      for (const d of ['phone', 'tablet']) {
        if (!online({ sim }, d)) continue;
        if (ui[d].badge !== truth && sim.queueStats('events').depth === 0) {
          const lost = st.entries.some((e) => !e.read && ui[d].list.some((x) => x.id === e.id && x.read));
          return { key: 'stale', label: lost ? `The ${d} shows ${ui[d].badge} unread; the server has ${truth}. The read never reached the server, so the other devices still show it unread and the next catch-up will undo it here.` : `The ${d}’s badge says ${ui[d].badge}, but everything was read on the other device. Nothing told the ${d}; it will correct itself when Maya next opens the app there.` };
        }
      }
      if (!st.seq && !(view.pages > 1)) return { key: 'ok', label: 'Nothing new yet.' };
      const parts = [`Both devices agree with the inbox: ${truth} unread.`];
      if (st.stats.socket) parts.push(`${st.stats.socket} delivered over the phone’s WebSocket.`);
      if (st.stats.push) parts.push(`${st.stats.push} by push.`);
      if (st.stats.catchUps && st.seq && st.stats.catchUps) parts.push('The tablet caught up on reconnect.');
      if (st.stats.syncs) parts.push(`${st.stats.syncs} read update${st.stats.syncs > 1 ? 's' : ''} synced to the other device.`);
      if (view.pages > 1) parts[0] = 'Every entry between the top and the last one shown was shown: nothing skipped.';
      return { key: 'ok', label: parts.join(' ') };
    },
    metrics(snap, sim) {
      const st = sim.state;
      const truth = unread(st);
      return [
        { label: 'Unread in the inbox', value: truth },
        { label: 'Stored counter', value: st.config.derived ? 'not used' : st.counter, tone: !st.config.derived && st.counter !== truth ? 'fail' : '' },
        { label: 'Phone badge', value: sim.ui.phone.badge, tone: sim.ui.phone.badge !== truth ? 'warn' : '' },
        { label: 'Tablet badge', value: online({ sim }, 'tablet') ? sim.ui.tablet.badge : 'offline', tone: online({ sim }, 'tablet') && sim.ui.tablet.badge !== truth ? 'warn' : '' },
        { label: 'By socket', value: st.stats.socket },
        { label: 'By push', value: st.stats.push },
        { label: 'Reads synced', value: st.stats.syncs },
        { label: 'Counter updates lost', value: st.stats.lostDecr + st.stats.lostIncr, tone: st.stats.lostDecr + st.stats.lostIncr ? 'fail' : '' },
      ];
    },
    product: {
      mount(el, sim) {
        Y.mount(el, sim, [['phone', 'Maya’s phone'], ['tablet', 'Maya’s tablet']], {
          note: 'Tap an unread entry to read it on that device. The phone can clear entries and load the next page.',
          below: `<div class="ops-console"><p class="ops-title">Orders team</p><div class="ops-traffic">${Y.btn('create', 'Send Maya a notification', {})}</div><div data-ref="truth"></div></div>`,
        });
      },
      render(el, sim) {
        const esc = SDL.ui.esc;
        const st = sim.state;
        for (const dev of ['phone', 'tablet']) {
          const ui = sim.ui[dev];
          const on = online({ sim }, dev);
          const fresh = ui.list.filter((e) => !e.id.startsWith('o'));
          const rows = dev === 'phone' ? ui.view.ids.map((id) => ui.list.find((e) => e.id === id) || st.entries.find((e) => e.id === id)).filter((e) => e && e.id.startsWith('o')) : [];
          const freshCards = fresh.map((e) => `<div class="app-card ${e.read ? '' : 'is-ok'}"><strong>${e.read ? '' : '● '}${esc(e.title)}</strong>${e.read ? '<span class="app-sub">read</span>' : Y.btn('read', 'Mark read', { arg: { dev, id: e.id }, cls: 'secondary' })}</div>`).join('');
          const older = dev === 'phone' ? rows.map((e) => `<div class="app-card"><strong>${esc(e.title)}</strong>${Y.btn('archive', 'Clear', { arg: { id: e.id }, cls: 'secondary' })}</div>`).join('') : '';
          Y.paint(el, sim, dev, {
            head: `<div><p class="app-title">Inbox · badge ${ui.badge}</p><p class="app-sub">${dev === 'phone' ? (sim.nodes.gateway.modes.dropSocket ? 'socket dropped' : 'app open, socket connected') : on ? 'app in background' : 'offline'}</p></div>`,
            act: `<div class="app-sec">${Y.btn('refresh', 'Open app', { arg: { dev }, disabled: !on })}</div>`,
            body: `${freshCards || '<p class="app-sub">No new notifications.</p>'}${dev === 'phone' ? `<p class="app-sub">Earlier</p>${older}${Y.btn('more', 'Load more', { cls: 'secondary' })}` : ''}`,
          }, {}, ui.banner);
        }
        const c = sim.scenario.consistency(sim);
        SDL.ui.paintSections(el.querySelector('[data-ref="truth"]'), {
          truth: `<p class="ops-val">Inbox store: ${visible(st).length} entries, ${unread(st)} unread${st.config.derived ? ' · badge derived from this' : ` · stored counter ${st.counter}`}</p>`,
          recon: `<p class="recon" data-tone="${c.key}">${c.key === 'ok' ? '✓' : c.key === 'stale' ? '…' : '✕'} ${esc(c.label)}</p>`,
        }, {});
      },
    },
  });

  function online(ctx, dev) { const sim = ctx.sim; return dev === 'phone' ? !sim.nodes.phone.modes.down : sim.state.dev.tablet && !sim.nodes.tablet.modes.down; }
  function* badgeOf(ctx) {
    const st = ctx.state;
    if (st.config.derived) return unread(st);
    const r = yield ctx.call('counter', 'get', {}, { timeout: 300, quiet: true });
    return r.ok ? r.value.n : null;
  }
  function onDevice(ctx, dev, p, via) {
    const ui = ctx.ui[dev];
    if (p.state) {
      const e = ui.list.find((x) => x.id === p.id);
      if (e) e.read = true;
      if (p.badge != null) ui.badge = p.badge;
      return { synced: true };
    }
    if (via === 'push') ui.banner = { title: p.entry.title, body: 'Shop', tone: 'ok', t: ctx.now() };
    void DEV; void LABEL;
    return deliverTo(ctx, dev, p);
  }
  void sc;
})(typeof window !== 'undefined' ? window : globalThis);
