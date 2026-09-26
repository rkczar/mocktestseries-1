@AGENTS.md

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Test engine (high-risk shared core)

Before touching tests, attempts, the Test Player, answer save/reveal, timers,
submission, result or review, read `ops/TEST-ENGINE.md` (the local
`test-engine` project skill summarizes it). One canonical player
(`app/student/attempt/[attemptId]/run/test-player.tsx`) serves Mock, PYQ,
Subject Test and Custom Module: never fork it per test type, never add a test
route when `/student/attempt/[attemptId]/*` can do the job, never send correct
answers to the client before an authorized reveal, and run the focused
test-engine regression after any shared-player change. Custom Module and
Subject Test configure through `components/student/universal-test-setup.tsx`;
Mock Test, PYQ, Grand and Live are formal EXAM-mode tests with admin-defined
timing, enforced server-side in `lib/test-attempt.ts`.

## Student Dashboard

One Student Dashboard. New dashboard features register as blocks in
`lib/student-dashboard-blocks.ts` (stable IDs) and render in
`app/student/(dashboard)/dashboard/active-exam-dashboard.tsx`; Admin → Website
→ Student Dashboard (MASTER_ADMIN only) controls visibility and order, stored
in `Setting` and read per request. Never add a page just to show a dashboard
card, never duplicate cards, and never let the layout bypass access checks
(the local `student-dashboard` project skill has the full rules).
