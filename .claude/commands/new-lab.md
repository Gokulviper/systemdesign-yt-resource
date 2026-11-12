---
description: Add one lab to an existing system (e.g. /new-lab rides rides-safety "Trip safety and SOS")
argument-hint: <system id> <page id> <title>
---
Add one lab: **$ARGUMENTS**.

1. Read `CLAUDE.md`. Open the system's existing labs and `assets/js/scenarios/_template.js`.
2. Write a short plan (product mock, components, flow, failures, switches, presets with expected end states) and wait for approval.
3. Implement: registry entry (planned → built), scenario file, test rows covering every preset, `npm run build`.
4. Verify every preset headlessly in Node first; fix the model when a story is wrong.
5. `npm run verify`, review screenshots with `/verify`, and report what changed.
