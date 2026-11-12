---
description: Run all tests, then screenshot labs mid-scenario and review them visually
argument-hint: [page id ...]
---
1. Run `npm run verify`. Fix any failure at its cause; never weaken a test to make it pass.
2. For each page in **$ARGUMENTS** (or every page changed in this session): open it with Playwright over `file://`,
   run two or three guided scenarios, pause mid-scenario (`window.SDL_LAB.ctl.pause()` and `window.SDL_LAB.sim.advanceTo(t)`),
   and screenshot the "Try it" panel and the diagram.
3. Look at every screenshot. Check: readable text, nothing cropped or overlapping, states and colours make sense,
   the explanation and consistency line match what the diagram shows, phones update correctly.
4. Report findings and fix what is wrong.
