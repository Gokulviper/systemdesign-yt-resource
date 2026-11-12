# Adding a new system design

The lab is built to hold many systems side by side (ride hailing, a video
platform, and whatever comes next). A system is a group of pages; most pages
are labs driven by a scenario file. Nothing in the engine or the shared UI
needs to change to add one.

## 1. Register the system and its pages
In `assets/js/ui/registry.js`:

1. Add a group name, for example `const P = 'Payments platform';`, and add it to `SDL.GROUPS`.
2. Add an entry to `SDL.SYSTEMS` with `id`, `title`, `start` (the first page id), `groups`, and a one-line `blurb`.
3. Add one entry per page to `SDL.PAGES`. Planned pages need `status: 'planned'`,
   `stageLabel`, `summary`, `will` and `failures`; `npm run build`
   gets an honest placeholder page from `npm run build`. Built pages need `status: 'built'`
   and `system` (the company name used in the disclaimer).

The dashboard card, its progress bar, the topic menu, and previous/next links
all update automatically.

## 2. Plan the system before writing code
For the system as a whole, list: the end-to-end journey (one overview lab with
phones or the main UI), a requirements and capacity page, and 6 to 9 deep
dives, one per mechanism that is interesting under failure. For each deep dive
write down: the product mock, 8 to 13 components, the normal flow, 6 to 12
failures, 3 to 5 design switches, and 8 to 12 guided scenarios with the end
state each must reach.

## 3. Write each lab's scenario
Copy `assets/js/scenarios/_template.js` to `assets/js/scenarios/<page-id>.js`
and fill it in. The template documents every field. Rules that keep labs honest:

- Flows are generators that `yield ctx.call(...)`; never fake an outcome the
  engine did not produce.
- Give nodes `serviceMs` (and `servers`) when overload should emerge from load.
- Background traffic uses `quiet: 'all'`; log only milestones and failures.
- Every failure, switch, and guided scenario must change behaviour you can see
  on the diagram, the product mock, the ledger, and the consistency line.
- `consistency(sim)` must say `wrong` for real correctness bugs (double charge,
  lost event), `stale` for temporary lag, and `ok` otherwise.
- Use `SDL.ui.phone` for phones and `SDL.ui.paintSections` for any screen or
  console that updates while the user interacts with it.

## 4. Generate the pages
Pages are generated from the registry; never write HTML by hand.
- Simulation labs load `assets/js/scenarios/<page id>.js` (override with `scenario: 'file.js'` on the page entry),
  preceded by the system's shared file if `SDL.SYSTEMS[i].common` is set (for example `'yt-common.js'`).
- Calculator pages set `calc: { module: 'file.js', mount: 'functionName' }`; the module lives in
  `assets/js/pages/` and defines `SDL.ui.functionName(pageId)` using `SDL.ui.mountShell`.
- Each system needs a hub page entry: `{ id: '<sys>-hub', group: 'Start', hub: true, systemId: '<sys>', path: '<dir>/index.html' }`.

Then run `npm run build`.

## 5. Test
- Add `tests/<system>.test.js`: one test per guided scenario asserting its end
  state, plus a replay-determinism test.
- Extend `tests/browser_check.py`: real clicks on the product mock, every preset
  run in the browser, no console errors, no horizontal scroll at 390 px.
- Run `npm run verify` (build, unit tests, browser checks).
- Review screenshots mid-scenario, then work through `CHECKLIST.md`.
