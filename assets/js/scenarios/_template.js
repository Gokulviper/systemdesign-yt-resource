/*
 * Scenario template. Copy to assets/js/scenarios/<page-id>.js and fill in.
 * Every field below is used by the shared engine and UI; delete what you do not need.
 */
(function (root) {
  'use strict';
  const SDL = root.SDL;

  function startMainAction(sim) {
    sim.startAction('User: do the main thing', function* (ctx) {
      // The ledger records what each layer knows. Set every layer by the end.
      ctx.ledger('displayed', 'pending', 'What the UI shows while waiting.');
      ctx.ledger('retrySafe', 'yes', 'Why a retry is safe (idempotency key, read-only…).');
      const r = yield ctx.call('gateway', 'doThing', { key: 'k-1' }, { timeout: 1500 });
      if (r.ok) {
        ctx.ledger('displayed', 'yes');
        ctx.ledger('accepted', 'yes');
        ctx.explain('One or two plain sentences on what happened and why it matters.');
      } else {
        ctx.ledger('displayed', 'no');
        ctx.ledger('accepted', 'no', null, { ifPending: true });
        ctx.ledger('committed', 'no', null, { ifPending: true });
        ctx.ledger('async', 'n/a');
        ctx.explain(`It failed with ${r.error.code}. Say what the user sees and what was (not) saved.`);
      }
    }, { self: 'client' });
  }

  SDL.scenarios['my-page'] = {
    id: 'my-page',
    seed: 1, // any integer: keeps every run reproducible
    productWidth: 560, // width of the sticky "Try it" sidebar
    intro: 'What to try first, in one or two sentences.',
    topology: {
      width: 1160,
      height: 560,
      nodes: [
        // kind: client | gateway | service | db | queue | worker | cache | cdn | store
        // serviceMs/servers: real capacity, so overload emerges from load.
        { id: 'client', label: 'User app', sub: 'Phone', kind: 'client', x: 100, y: 90, latency: 1, role: 'Responsibilities shown in the inspector.', owns: ['Nothing'] },
        { id: 'gateway', label: 'API gateway', sub: 'Edge', kind: 'gateway', x: 330, y: 90, latency: 2, role: '…', ops: [{ name: 'doThing', desc: '…' }], owns: ['Nothing durable'] },
        { id: 'db', label: 'Database', sub: 'Source of truth', kind: 'db', x: 560, y: 90, latency: 10, role: '…', owns: ['…'] },
      ],
      edges: [
        { from: 'client', to: 'gateway', latency: 30, label: 'HTTPS' },
        { from: 'gateway', to: 'db', latency: 5 }, // add via: [[x, y], …] to route around boxes
      ],
      queues: [], // { id, broker: '<node id>', label, groups: ['<consumer node id>'] }
    },
    failures: [
      { id: 'db-down', node: 'db', mode: 'down', label: 'Database unavailable', desc: 'What breaks and what does not.' },
    ],
    switches: [
      { id: 'idem', label: 'Idempotency keys', desc: 'Off: what goes wrong.', get: (s) => s.state.config.idem, set: (s, on) => { s.state.config.idem = on; } },
    ],
    presets: [
      { id: 'happy', label: 'Normal flow', desc: 'What the learner will see.', run: (sim) => { sim.restoreAll(); startMainAction(sim); } },
    ],
    initialState: () => ({ config: { idem: true }, rows: {} }),
    initialUI: () => ({ client: { message: 'Ready.' } }),
    actions: { main(sim) { startMainAction(sim); } },
    handlers: {
      gateway: { doThing: function* (ctx, p) { return ctx.must(yield ctx.call('db', 'write', p, { timeout: 800 })); } },
      db: { write(ctx, p) { ctx.state.rows[p.key] = true; ctx.ledger('committed', 'yes', 'Row written.'); return { saved: true }; } },
    },
    setup(sim) { /* start background processes and consumers here */ },
    consistency: (sim) => ({ key: 'ok', label: 'Everything agrees.' }), // ok | stale | wrong
    metrics: (snap, sim) => [{ label: 'Rows', value: Object.keys(sim.state.rows).length }],
    product: {
      mount(el, sim) {
        el.innerHTML = `${SDL.ui.phone.frame('client', 'User phone')}`;
        SDL.ui.phone.wire(el.querySelector('.phone'));
        el.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) sim.dispatch(b.dataset.act, {}); });
      },
      render(el, sim) {
        const ph = el.querySelector('.phone');
        SDL.ui.phone.render(ph, sim, 'client', null, false);
        SDL.ui.phone.paint(ph, { body: `<button class="app-btn" data-act="main">Do the thing</button><p class="app-msg">${SDL.ui.esc(sim.ui.client.message)}</p>` }, {});
      },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
