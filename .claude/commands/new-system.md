---
description: Research, plan, and build a new system design (e.g. /new-system WhatsApp, focus on group chat and offline delivery) by reusing the existing engine, UI, and helpers
argument-hint: <system name>[: optional focus areas, audience, or constraints]
---
Add a new system design to this lab: **$ARGUMENTS**

Read `CLAUDE.md` and `docs/ADDING_A_SYSTEM.md` first. Reuse the engine, shared UI, and helpers; change them only if a capability is truly missing.
Anything after a colon in the arguments is my focus: weight the plan toward it, but still cover the essentials below.

# Stage 1: discovery and plan. Do not write code. Stop at the end and wait for my approval.

## Step 1. Research
- Use what you know about how this kind of system is built. If web search is available, also look for well-known
  engineering write-ups, conference talks, and common interview treatments of this system, and note the sources you used.
- Separate what is well established from what is your assumption. Never present guesses about a specific company’s
  internals as fact: these labs are reference architectures.

## Step 2. Work through this checklist and write the answers down
1. **Users and core journeys.** Who uses it and the 3 to 6 journeys that matter most (for example send message, receive offline, join group).
2. **Functional requirements.** Must-have versus nice-to-have, and what is explicitly out of scope.
3. **Non-functional requirements.** Scale (users, requests per second, data per day), latency targets for each journey,
   availability target, durability, consistency needs per piece of data, security and privacy, cost sensitivity.
4. **Capacity estimates.** Back-of-the-envelope numbers with stated assumptions: peak QPS per journey, storage per year,
   bandwidth, connections. Identify which number dominates the design.
5. **Data model.** Main entities, keys, access patterns, and which store suits each (and why).
6. **APIs.** The key endpoints or messages, including idempotency, pagination, and versioning where relevant.
7. **Signature problems.** The hard problems that define this system. Check each of these and say whether and how it applies:
   hot keys and celebrity users; fan-out (write versus read); ordering and exactly-once or at-least-once delivery;
   idempotency and retries; consistency and read-your-writes; concurrency and conflicts; caching and invalidation;
   sharding and rebalancing; geo-distribution and regional failure; real-time connections; backpressure and load shedding;
   rate limiting and abuse; search, ranking, or matching; storage growth and cost; privacy, encryption, compliance.
   Add any problems specific to this system that are not on the list.
8. **Failure modes.** For each major component: what fails, what the user sees, what must never happen (data loss,
   double charge, duplicate messages), and the mitigation.
9. **Interview coverage.** The questions an interviewer typically asks about this system, and the follow-ups that separate
   strong answers from weak ones.

## Step 3. Propose the labs
- One end-to-end lab (usually phones for the main actors), one requirements and capacity calculator, and 6 to 9 deep dives.
- For every lab: product mock, 6 to 13 components with kinds, the normal flow, 6 to 12 failures, 2 to 5 design switches,
  6 to 12 guided scenarios with the exact end state each reaches (`ok`, `stale`, or `wrong`) and why, and the metrics shown.
- Name the two existing labs each new lab will be modelled on (for example `rides.js` for phone journeys,
  `likes.js` / `notifications.js` for event pipelines, `rides-hotkeys.js` for capacity, `yt-calcs.js` for calculators).

## Step 4. Coverage check (required)
Show a table with one row per item from steps 7, 8, and 9: the problem or question, how important it is
(essential, important, optional), and the lab and guided scenario that teaches it. Any essential item without a lab is a gap:
either add it to a lab or explain why it is out of scope. Then list anything you deliberately left out.

## Step 5. Build plan
Registry additions (group name, `SDL.SYSTEMS` entry with `hub`, `common`, and the learning `path`), the build rounds
(3 to 4 labs each, most important first), and the open questions you need me to answer.

**Stop here and wait for approval.** I may add, remove, or reprioritise problems before any code is written.

# Later stages (after approval): one round at a time
- Add registry entries (`status: 'planned'`) and the hub; `npm run build` so honest placeholders appear.
- Build each lab from `assets/js/scenarios/_template.js`, reusing `yt-common.js` via the system’s `common` field.
- Add a table-driven test file for the system (pattern: `tests/youtube.test.js`): every preset, its end state, extra checks.
- Check every preset headlessly in Node before UI polish. When a story is wrong, fix the model, never the test.
- Flip finished labs to `status: 'built'`, run `npm run verify`, review screenshots with `/verify`, and update the
  coverage table to show what is now taught.
- Report after each round: files changed, scenarios and their outcomes, tests run, coverage table, known limitations, next round.
