# System Design Lab

Interactive, failure-injectable system design labs. Each lab pairs a working
product mock (usually phones) with a live architecture diagram, animated
request flow, timeline, metrics, failure injection, design switches, and
guided scenarios. Static HTML/CSS/JS: no framework, no build step, no runtime
dependencies, works from `file://`.

Built so far: **Ride hailing** (10 labs) and **Video platform / YouTube** (23 labs).
The goal of this repository is to add more systems **by reusing what exists**.

## Golden rules
1. **Never rewrite the engine or shared UI to build a lab.** `assets/js/engine/`,
   `assets/js/ui/`, and `assets/css/` are shared by every lab. Extend them only
   when a capability is genuinely missing, keep changes backward compatible, and
   run the full suite afterwards (all existing labs must still pass).
2. **New labs are scenario files.** A lab = one entry in `assets/js/ui/registry.js`
   + one file in `assets/js/scenarios/` + rows in a test file. Start from
   `assets/js/scenarios/_template.js`. Study a similar existing lab before writing.
3. **Never hand-edit generated HTML.** Pages come from the registry: `npm run build`.
4. **Simulations must be deterministic.** No `Math.random`, `Date.now`, or
   `setTimeout` in scenarios. Use `ctx.rand()` / `sim.rng()`, `ctx.now()`,
   `ctx.wait()`, `sim.schedule()`. Replay must reproduce the timeline exactly.
5. **Never fake outcomes.** Results come from flows that `yield ctx.call(...)`.
   If a story needs a behaviour, model it (capacity, ordering, retries), do not script it.
6. **Plan before building a new system** (see `/new-system`). Get approval on the
   page list, components, failures, switches, and presets first.

## Commands
```
npm run build          # regenerate all HTML pages from the registry
npm test               # node --test tests/*.test.js  (engine + every guided scenario)
npm run test:browser   # Playwright over file:// (needs: pip install playwright && playwright install chromium)
npm run verify         # all of the above
npm run serve          # optional local server on :8080 (pages also work from file://)
```

## Architecture
```
index.html, rides/, youtube/, lab/      generated pages (do not edit)
assets/js/engine/sim.js                 deterministic discrete-event engine (DOM-free)
assets/js/engine/metrics.js             metrics from simulated activity; SDL.fmtMs, SDL.percentile
assets/js/ui/registry.js                SDL.SYSTEMS, SDL.GROUPS, SDL.PAGES: navigation, hubs, page generation
assets/js/ui/shell.js                   header, landing, hubs, controller, mountLab, mountShell
assets/js/ui/panels.js                  diagram + packets, timeline, metrics, ledger, failures, presets, inspector
assets/js/ui/phone.js                   phone frame, tap ripples, network arrows, banners, section painting
assets/js/scenarios/*.js                one scenario per lab; yt-common.js = shared helpers (usable by any system)
assets/js/pages/*.js                    calculator pages (no simulation)
tests/engine.test.js, rides*.test.js    engine and ride-hailing tests
tests/youtube.test.js                   table-driven: every preset of every listed lab -> expected end state
tests/browser_check.py                  generic checks for every built page + specific checks
tools/build-labs.js                     the page generator; tools/build-pages.js holds the HTML template
docs/ADDING_A_SYSTEM.md                 the full process for a new system
CHECKLIST.md                            per-lab acceptance criteria
```

## Engine essentials (read `sim.js` headers for detail)
- Flows are generators: `const r = yield ctx.call(node, op, payload, { timeout })`, `yield ctx.wait(ms)`,
  `const { msgs } = yield ctx.take(queue, group, max)` then `ctx.ack(queue, group)`, `yield ctx.join(procs)`,
  `yield* ctx.retry(policy, fn)`. Results are `{ ok, value }` or `{ ok: false, error: { code, message } }`.
- Handlers: `handlers[node][op] = (ctx, payload) => value` or a generator for downstream calls.
  Fail with `ctx.fail(code, message)`; propagate with `ctx.must(result)`.
- Real capacity: `serviceMs` (+ `servers`) on a node; requests queue; `sim.queueWait(id)`; node shows "Overloaded".
- Failure modes per node: `down`, `hang`, `slow {factor}`, `dropResponse`, `duplicate` (queue appends), `paused`
  (consumers), `reject {code}`, plus custom modes read with `ctx.mode('name')` and labelled via `modeLabels`.
- Background traffic: `quiet: 'all'` on calls (hidden from the timeline); log milestones with `ctx.log`.
- Ledger per user action: `sim.startAction(label, gen, { self })`, set layers with `ctx.ledger(...)` or `Y.L(ctx, {...})`.
- `consistency(sim)` returns `{ key: 'ok' | 'stale' | 'wrong', label }`:
  `wrong` = a real correctness bug (double charge, lost data, lost update); `stale` = temporary lag or degradation.

## Shared helpers (`SDL.yt` in yt-common.js; load it for any system via `common` in SDL.SYSTEMS)
`Y.switches`, `Y.presets(defaults, list)` (restores and sets switches before each preset), `Y.consumer`
(with dedupe), `Y.relay` (batched outbox relay), `Y.load` (background rate), `Y.mount` / `Y.paint`
(phones + optional side console, data-act / data-field wiring), `Y.L`, `Y.failed`, `Y.video`, `Y.btn`, `Y.msg`.

## Design system
Neutral chrome; colour encodes component kind (client indigo, gateway cyan, service blue, db orange, queue
purple, worker pink, cache green, cdn teal, store ochre) and runtime state (work blue, ok green, fail red,
degraded amber, recovering teal, event violet). Always pair colour with an icon or word. Light and dark themes.
Sentence case. Typographic quotes and apostrophes in visible text. Respect reduced motion.

## Definition of done for a lab
- Registry entry `status: 'built'`, page generated, reachable from its hub.
- Every preset has a row in a test table asserting its end state (and an extra check where useful);
  replay is deterministic; `npm run verify` passes with zero console errors and no horizontal scroll at 390 px.
- The product mock's primary control drives the simulation; no inert controls.
- Each failure and switch changes visible behaviour; explanations are plain language and technically correct.
- Review screenshots mid-scenario (`/verify`) and fix visual problems before reporting.
- Work through `CHECKLIST.md`.
