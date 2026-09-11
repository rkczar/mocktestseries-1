# Test Player — Production Specification

Source: `Test-Player.dc.html` (largest and most stateful screen in the project).

## Flow
1. **Mode modal** on entry (`modeModal: true` initial state) — before the first question, the
   student is asked to choose the answer-reveal mode for this attempt:
   - **"Show Answers After Test Submission"** (reveal-at-end) — the default framing in the
     design copy ("Complete the entire test first and review all answers after submission").
   - The alternate mode (reveal-per-question) is the other tab in the same modal.
   Per the user's instruction, this choice must ultimately be **admin/exam/test-configured**
   (a property on the Test/Exam record), not left as a free per-attempt student toggle, unless
   the business wants students to keep choosing it themselves — clarify which with the business
   before building; the prototype currently lets the student pick every time.
2. **Question screen**: question stem, 4-option list, Prev/Save-and-continue/Mark-for-review/Next
   action bar, a color-coded palette grid (answered / unanswered / marked-for-review states) for
   jumping to any question, a live countdown timer (`seconds`, defaults to
   `TEST_META.durationSeconds` or 7200s fallback), and an "Ask AI Sub" button in the header.
3. **Submit**: a confirm modal (`showSubmitConfirm`) with a computed summary
   (`submitSummary` — presumably attempted/marked/skipped counts) before `confirmSubmit` locks
   the attempt in.
4. **Result / Review** (`isReview` state): per-question review list with correct/incorrect/
   unattempted color coding, a "marked" count card, and a **question-level action bar**:
   WhatsApp Share, Save/bookmark toggle, Report Question (opens a modal: reason picker + free-text
   comment, submit confirmation), and Ask AI (opens the AI explanation panel — reuses cached
   explanation, generates only if missing; see AI-SYSTEM.md).

## State to preserve server-side in production
The prototype already separates two persistence layers worth keeping conceptually distinct:
- **Durable attempt record** (survives even if the browser session cache is empty) — the
  Custom-Module-created attempt object, or equivalent Full-Mock-Test attempt row.
- **Session UI cache** (current index, marked/saved-locally state) — safe to keep client-side
  or in a lightweight session table, but must not be the only place answers live; a
  refresh/crash must not lose submitted answers.
Reopening from history must land read-only on the durable record, never regenerate/reshuffle
questions.

## Scope-check safety
The prototype actively **blocks starting a test** whose frozen question set fails a same-exam
sanity check ("cross-exam mismatch") rather than silently starting a broken test. Preserve this
defensive check (or a stronger server-side equivalent) — it's a real bug-prevention mechanism
worth keeping, not decoration.

## Negative marking
Test/Attempt-level `negativeMarking` field exists in `admin-test-data.js` (e.g. 0.25) — the
result/score computation must apply it. Verify the actual scoring formula against the design's
result screen once RESULTS-ANALYSIS.md's score fields are wired, since the current player file
computes correct/incorrect/skipped but the exact negative-marking arithmetic should be confirmed
with the business (flag as ⚠️ needs clarification: is negative marking per-question fixed value
or a fraction of that question's marks?).

## Report Question
Reason picker + optional comment + submit → currently only a client-side "sent" confirmation
with no persisted destination. Production needs a `QuestionReport` table and an admin queue to
triage it (see ADMIN-DASHBOARD.md's Question Queries module).

## WhatsApp Share
Present as a button in the review action bar; the prototype's handler (`shareWhatsApp`) likely
builds a `wa.me` share-intent URL client-side (standard, no server dependency) — confirm exact
share text/link target during build; no backend requirement here beyond generating a shareable
result/question URL.

## Mobile behavior
Palette grid and action bar use `auto-fit`/`flex-wrap` so they reflow rather than break, and
buttons are sized `min-height:44px` (meets the 44px tap-target minimum). Verify the sticky
timer/header doesn't collide with the palette on small screens during build — not something
that can be fully confirmed from source alone.
