# Future question types: readiness and design (NEET Phase 2 analysis)

Status: **design only, nothing implemented.** Today every question is single
correct, and RUHS MO must stay exactly that. This records what Phase 3/4 needs
for `MULTIPLE_CORRECT` and `MATCH_THE_FOLLOWING` without making RUHS depend on
NEET behaviour.

## 1. What assumes "one correct option" today

`QuestionOption.isCorrect` is a boolean per option, so the **database already
allows** several correct options. Every layer above it assumes exactly one:

| Layer | Where | Assumption |
|---|---|---|
| Snapshot | `lib/test-attempt.ts#toSnapshot` | freezes `correctLabel: string` (the first `isCorrect`) |
| Answer | `Answer.selectedOptionLabel String?` | one selected label |
| Save / reveal | `saveAnswer`, `revealAnswer` | one label; reveal returns one `correctLabel` |
| Scoring | `submitAttempt` | `selected === snapshot.correctLabel`, +1 / −negativeMarking |
| Player | `run/test-player.tsx` | radio group, `reveal.correctLabel` |
| Review / Saved | `attempt-review.tsx`, Saved page | one "Correct answer" badge |
| Insights | `lib/question-insights*.ts` | `MULTIPLE_CORRECT_OPTIONS` is reported as a **data defect** |
| AI | `ai-explanation*.ts`, `ai-variant*.ts` | `options.find(isCorrect)`; variants require exactly one |
| Admin form / import | `question-form.tsx`, `bulk-import*.ts` | one `correctAnswer` letter |
| OMR entry | `omr-entry` | one bubble per question |
| Analytics | result page, `question-insights` | per-question right/wrong from the one key |

So multiple-correct cannot be "switched on" by data alone: every row above
would silently score/display it as single-correct.

## 2. Recommended additive schema (Phase 3/4)

```prisma
enum QuestionType { SINGLE_CORRECT  MULTIPLE_CORRECT  MATCH_THE_FOLLOWING }

model Question {
  // …
  questionType QuestionType @default(SINGLE_CORRECT)   // every existing row
  matchSpec    Json?        // MATCH_THE_FOLLOWING only, see §4
}

model Answer {
  // …
  selectedLabels String[]  @default([])   // MULTIPLE_CORRECT only; SINGLE keeps selectedOptionLabel
  marks          Float?                    // awarded marks (partial schemes); null = legacy +1/−n
}

// Exam-level scoring policy (configurable, never hard-coded globally)
model ScoringScheme { id, examId?, questionType, correct Float, wrong Float, partial Json? }
```

All additive with safe defaults: RUHS rows become `SINGLE_CORRECT` and keep
using `selectedOptionLabel` / `correctLabel` / the current `submitAttempt`
path byte-for-byte.

## 3. Snapshot v3 (only for non-SINGLE questions)

Keep v1/v2 untouched. A new type freezes `v: 3` with
`questionType`, `correctLabels: string[]` (MSQ) or the frozen `matchSpec`
(MTF), plus every v2 key. `toPlayerQuestions` strips `correctLabels` /
the MTF key exactly like `correctLabel` and `explanation` today.

## 4. Match the Following

NEET MTF is almost always rendered as **List I / List II + four coded
options** ("A-II, B-IV, C-I, D-III"), i.e. it is *scored as a single-correct
question*. The structure is presentation that the importer must preserve:

```json
{
  "listI":  [{ "key": "A", "text": "$\\vec{F} = q\\vec{v}\\times\\vec{B}$", "assetIds": [] },
             { "key": "B", "text": "", "assetIds": ["<QuestionAsset id>"] }],
  "listII": [{ "key": "I", "text": "Lorentz force", "assetIds": [] }, …]
}
```

- Entry `text` is RICH_V1 (KaTeX / mhchem through the one renderer).
- Entry images are ordinary `QuestionAsset` rows. The smallest additive change
  is a new role value `LIST_ITEM` plus `listKey String?` on QuestionAsset
  (e.g. `"I:A"`, `"II:III"`), so media keeps one table, one storage engine and
  snapshot v2 asset freezing.
- The four answer options stay normal `QuestionOption`s ("A-II, B-IV, …"),
  so scoring, OMR and analytics are unchanged → `questionType = MATCH_THE_FOLLOWING`
  with **single-correct scoring**. Abusing `Question.text` with ASCII tables
  is avoided.
- A future "drag to match" mode (pair-wise scoring) would add
  `Answer.matchPairs Json` and a scheme; not needed for NEET's current format.

## 5. Multiple correct (MSQ)

- Player: checkboxes when `questionType = MULTIPLE_CORRECT`; save sends a
  sorted label set; the monotonic `seq` rule and one-Answer-row invariant
  are unchanged.
- Practice Mode reveal: commits the set, returns `correctLabels`.
- Scoring through `ScoringScheme` (e.g. JEE-style partial: +1 per correct
  chosen if no wrong chosen, −2 if any wrong). Default scheme for any exam
  without one = all-or-nothing. **No partial scoring without owner approval.**
- Insights: `MULTIPLE_CORRECT_OPTIONS` stays a defect only for `SINGLE_CORRECT`.
- OMR: MSQ/MTF tests are online-only until an OMR layout exists.

## 5b. Phase 3 status (rich importer, implemented)

- The import manifest carries `questionType` and `correct: string[]` (lib/rich-import/manifest.ts).
- `MULTIPLE_CORRECT` rows are parsed and shown, then **blocked** with
  "MULTIPLE_CORRECT ENGINE NOT YET ENABLED" — never converted to single-correct.
- `MATCH_THE_FOLLOWING` imports as single-correct coded options; List I / List II are structured in
  staging and stored as readable lines in the question text, list images as captioned QUESTION assets.
- No schema change was needed: `Question.questionType` / `matchSpec` / `LIST_ITEM` stay proposals
  (§2, §4) until structured MTF rendering or MSQ scoring is approved.

## 6. Phasing

1. Phase 3 (import): import and preserve `questionType` + `matchSpec` + list
   images; still single-correct scoring; MTF renders lists.
2. Phase 4+: MSQ end-to-end (player, reveal, scoring scheme, review,
   analytics, AI guards) behind `questionType`, with its own regression suite
   and the RUHS gate.
