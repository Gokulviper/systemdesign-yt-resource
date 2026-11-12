# Lab page validation checklist

Run this against every lab page before marking it `built` in `assets/js/ui/registry.js`.
Items marked (auto) are covered by `tests/browser_check.py` or `node --test tests/*.test.js`;
extend those scripts for each new page rather than checking by hand.

## 1. Product mock
- [ ] Every button, input, and selector changes simulation state (no inert or alert-only controls).
- [ ] Disabled controls say why they are disabled.
- [ ] Status text distinguishes saved, failed, pending, and unknown outcomes.

## 2. Normal flow (auto)
- [ ] The primary action animates packets along the correct edges, in the correct order.
- [ ] The final UI state matches the authoritative data.
- [ ] Data consistency reports Consistent once async work drains.

## 3. Inspection
- [ ] Every node opens the inspector by mouse and by keyboard (Enter or Space). (auto)
- [ ] The inspector lists responsibilities, interfaces, connections, owned data, and live numbers.
- [ ] Inspector failure buttons inject and restore; Escape closes and returns focus. (auto)

## 4. Failure injection
- [ ] Each failure in the catalog is relevant to this component.
- [ ] Injecting changes the node state on the diagram and the checkbox state. (auto)
- [ ] The affected request path changes: stop, retry, queue, degrade, or fallback, as designed.
- [ ] Partial failures stay partial (e.g. a broker outage does not fail the synchronous write).
- [ ] Each guided scenario reaches its documented end state. (auto, per page)
- [ ] Timed failures restore themselves; Restore everything clears all failures.

## 5. Honest outcomes
- [ ] The ledger never marks something committed that the database did not commit.
- [ ] Timeouts after commit show Unknown on the client and Yes under Durably committed.
- [ ] Retrying after an unknown outcome never duplicates the effect.
- [ ] Explanations state the consistency and correctness implications in plain language.

## 6. Timeline and metrics
- [ ] Every call logs an arrival and a completion; retries, timeouts, faults, and restores are logged.
- [ ] Selecting a timeline event shows component, operation, status, input, output, and error. (auto)
- [ ] Metrics change only in response to simulated activity, and are labelled simulated.
- [ ] Queue depth and lag rise during consumer or broker failures and fall on recovery. (auto)

## 7. Playback (auto)
- [ ] Pause freezes the clock; Step runs exactly one event; Play resumes.
- [ ] Replay reproduces an identical timeline.
- [ ] Reset returns every node, datum, metric, and UI element to its initial state.

## 8. Quality floor
- [ ] No console errors. (auto)
- [ ] All navigation links resolve. (auto)
- [ ] No horizontal page scroll at 390 px width; the diagram scrolls inside its own frame. (auto)
- [ ] Light and dark themes are both legible.
- [ ] Turning off "Animate packets" (or OS reduced motion) replaces motion with edge highlighting.
- [ ] Page states it is a reference design and that timings are illustrative.
