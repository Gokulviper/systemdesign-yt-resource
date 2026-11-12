# System Design Lab

Interactive, failure-injectable simulations of real products: a ride-hailing app (built) and a YouTube-like platform (in progress). Plain HTML, CSS and
JavaScript, no build step, no dependencies, no backend, no API keys.

## Run it
Open `index.html` in a browser. Pages work straight from the file system (`file://`).
Fonts load from Google Fonts when online and fall back to system fonts offline.

## Layout
```
index.html                 dashboard
lab/sandbox.html           simulator sandbox (teaches the controls)
rides/ride-hailing.html    ride hailing end to end: two phones, 19 services, 16 failures, 12 guided scenarios
rides/location.html        deep dive: location tracking (buffering, out-of-order pings, trails)
rides/hotkeys.html         deep dive: hot keys and geo sharding (five mitigations)
rides/surge.html           deep dive: surge pricing (smoothing, price lock, fail-safes, caps)
rides/matching.html        deep dive: matching and dispatch (greedy vs batched, fairness, offers)
rides/trips.html           deep dive: trip lifecycle and events (concurrency, outbox, ordering)
rides/payments.html        deep dive: payments (holds, webhooks, double-entry ledger, refunds)
rides/realtime.html        deep dive: realtime connections (reconnect storms, registry, push, inbox)
rides/eta.html             deep dive: ETA and routing (Dijkstra, traffic probes, route cache)
rides/capacity.html        requirements and capacity calculator
docs/ADDING_A_SYSTEM.md    how to add the next system design
assets/js/scenarios/_template.js  annotated scenario template
fundamentals/*.html        7 fundamentals pages
components/*.html          16 component deep dives
assets/css/tokens.css      design tokens, light and dark
assets/css/lab.css         shared layout and components
assets/js/engine/sim.js    deterministic discrete-event engine (DOM-free)
assets/js/engine/metrics.js metrics derived from simulation state
assets/js/ui/registry.js   page list: navigation, status, planned content
assets/js/ui/shell.js      header, navigation, controller, page mounting
assets/js/ui/panels.js     diagram, timeline, metrics, ledger, failures, inspector, playback
assets/js/ui/phone.js      reusable phone mock: clock, network arrows, push banners, tap ripples
assets/js/scenarios/*.js   one scenario per lab
tests/engine.test.js       engine and scenario state-transition tests
tests/browser_check.py     browser checks for every page plus deep lab interactions
tools/build-labs.js        generates every HTML page from the registry (npm run build)
tools/build-pages.js       the shared HTML page template
CLAUDE.md                  instructions for Claude Code; .claude/commands/ has /new-system, /new-lab, /verify
CHECKLIST.md               per-page validation checklist
```

## How a scenario works
A scenario declares a topology (nodes, edges, queues), handlers for each node operation,
user actions, a failure catalog, guided scenarios, a consistency check, and a product mock.
Flows are generator functions that yield effects, and the engine resolves them on a virtual clock:

```js
const r = yield* ctx.retry({ attempts: 3, baseMs: 150 }, function* () {
  return yield ctx.call('gateway', 'add', { key, delta: 1 }, { timeout: 1200 });
});
```

Because one Simulator object drives every panel, the diagram, timeline, metrics, ledger and
product UI can never disagree. All randomness is seeded and every user action is recorded,
so Replay reproduces a run exactly.

## Building blocks a scenario can use
- `quiet: true` on a call hides its successes from the timeline (for background traffic like GPS pings); `quiet: 'all'` hides everything.
- `via: [[x, y], ...]` on an edge routes it around boxes.
- `switches` declare design decisions (compare-and-set, idempotency keys…) the learner can turn off to see what breaks.
- `productWidth` widens the sticky "Try it" sidebar, e.g. for two phones.
- `serviceMs` and `servers` on a node give it real capacity: requests queue when it is saturated, `sim.queueWait(id)` reports the wait, and the node shows as overloaded. Hot keys emerge from load instead of being injected.
- The `hot` failure mode models a hot shard as a single-server queue.
- `SDL.ui.paintSections` repaints app screens and consoles in sections, with `data-live` values updated in place.

## Tests
```
npm run build          # regenerate pages from the registry
npm test               # engine and every guided scenario
npm run test:browser   # needs: pip install playwright && playwright install chromium
npm run verify         # all three
```

## Adding a lab
1. Write `assets/js/scenarios/<id>.js`.
2. Create its HTML page with `SDL.ui.mountLab('<id>')` (see `lab/sandbox.html`).
3. Set its registry status to `built`.
4. Add unit tests for its state transitions and extend `tests/browser_check.py`.
5. Work through `CHECKLIST.md`.
