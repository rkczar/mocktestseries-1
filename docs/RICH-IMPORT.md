# Rich content import (NEET Phase 3)

The ONE Bulk Import workspace (Question Bank → Bulk Import) has two modes:

| Mode | For | Behaviour |
|---|---|---|
| **Standard** (default, `importMode = LEGACY`) | today's CSV/XLS/XLSX text questions (RUHS) | exactly as before Phase 3 — same parsing, defaults, warnings, duplicate handling, statuses |
| **Rich content** (`importMode = RICH`) | RICH_V1 formulas, mhchem, images, explanations, Match the Following | the same engine + stricter capability-aware validation, an optional ZIP image bundle, always DRAFT |

There is no separate NEET importer, question table, player or media engine.

## Pipeline

```
XLSX (+ ZIP) ──upload──▶ BulkImportRun / BulkImportRow (staged, nothing in Question yet)
ZIP ──8 MB chunks──▶ private staging (IMPORT_STAGING_DIR, default /var/lib/mocktestseries/import-staging)
      └─ central directory vetted (lib/rich-import/zip.ts), nothing extracted to disk
row ──toManifestQuestion()──▶ typed manifest (lib/rich-import/manifest.ts, pure, never stored stale)
referenced images ──time-sliced──▶ storeScientificImage (Phase 2: decode-validate → sharp → SHA-256 →
      immutable q/<aa>/<sha>.webp under /media/ → MediaObject)    lib/rich-import/bundle.ts
row ──resolveImportRow()──▶ legacy rules + rich checks → ERROR / WARNING / INFO   lib/rich-import/validate.ts
preview ──▶ the production renderer (RichText / QuestionMedia / HumanExplanation)
Import as Draft ──▶ per-row transaction: Question + options + QuestionAsset refs + row provenance
```

## Canonical XLSX headers

Download it from the upload form (Rich mode → *Rich XLSX template*), which also has an
**Instructions** sheet. Names reuse the existing importer's columns.

| Column | | Rules |
|---|---|---|
| Code | optional | your stable id, unique in the file; DB code is still allocated canonically |
| Exam | optional | exact Exam name; blank = selected Exam; a different exam is an ERROR |
| Year | optional | 4 digits; blank = Exam year; must match the paper |
| Paper Code | conditional | code of an existing Previous Year Paper of the exam |
| QNo | optional | 1–999, unique per paper/year in the file |
| Subject | **required** | existing Subject (never created) |
| Chapter/Topic | optional | existing Topic (old header `Topic` also works) |
| Sub-topic | optional | existing Sub-topic |
| Question Type | optional | `SINGLE_CORRECT` (default, `MCQ`), `MULTIPLE_CORRECT` (`MSQ`), `MATCH_THE_FOLLOWING` (`MTF`) — NEET Phase 4 |
| Content Format | optional | `PLAIN` (default; text literal) or `RICH_V1` |
| Question Text | **required** | line breaks kept |
| Question Images | optional | images from the ZIP (max 8) |
| Option A–D | conditional | text; may be empty only when that option has an image |
| Option A–D Image | optional | max 3 per option |
| Correct | **required** | one letter A–D; `MULTIPLE_CORRECT`: every correct letter, e.g. `A,B,D` (≥ 2, each once) |
| Explanation | optional (WARNING if missing) | shown only after review/reveal |
| Explanation Images | optional | max 8 |
| Difficulty | optional | EASY / MEDIUM / HARD (blank → MEDIUM, WARNING; other → ERROR) |
| Source | optional | `PYQ` or blank |
| Review Required / Review Reason | optional | TRUE → editorial stage NEEDS_REVIEW, reason preserved |
| Status | optional | always saved DRAFT; PUBLISHED/ARCHIVED → WARNING only |
| List I / List II | conditional | **required** for `MATCH_THE_FOLLOWING` (2–10 entries each) |

These rich columns are recognized **only in Rich mode**; a Standard file that happens to carry
e.g. `Question Type` or `Review Required` (the Template Builder writes both) still ignores them.

### Formulas (RICH_V1)

`$…$` inline, `$$…$$` display, `\ce{…}` chemistry, `\pu{…}` units, `\$` literal dollar.
Stored verbatim and rendered at display time by `lib/rich-content.ts` — never converted to images,
never rewritten. Unclosed delimiters, KaTeX parse errors, `\(…\)`/`\[…\]`, disabled commands
(`\href`, `\url`, `\includegraphics`, `\html…`) and HTML tags are **WARNINGS** (shown, not fixed).
PLAIN text containing formula markup gets a WARNING (it will show literally).

### Image references

`file.png :: alt text | other.png :: decorative`
- separator `|` (or a line break); alt after `::`; `:: decorative` stores alt="" (screen readers skip).
- No alt → WARNING; a generic description ("Question figure 1", "Option A image") is used.
- Bare file names only (no paths, no URLs). Matching = basename, case-insensitive, exact. No fuzzy matching.
- Source filenames are never storage keys; files become content-addressed `q/<aa>/<sha256>.webp`.

### Match the Following

`List I`: one entry per line (or `|`), each starting with its key — `A. \ce{CH4}`; an entry image goes
after `@@`: `B. Alkene @@ list-b.png :: Ethene`. Options stay four coded single-correct options
("A-II, B-III, …"), so scoring/OMR/analytics are unchanged.

Since NEET Phase 4 a `MATCH_THE_FOLLOWING` row stores the **stem only** as question text and the
lists in `Question.matchSpec` (`{v:1, listI:[{key,text}], listII:[…]}`, entry text follows the row's
Content Format); entry images become `LIST_ITEM` assets with `listKey` `I:B` / `II:III` (caption
"List I (B)" kept). Validation: both lists, 2–10 entries, valid unique keys (A–Z, I–X, 1–99), text or
an image per entry, referenced images present, exactly one correct coded option. Lists given on a
non-MTF row keep the Phase 3 behaviour (appended to the text as lines, captioned QUESTION figures,
WARNING). Duplicate detection: a stem-only text match is a duplicate only when the existing Match
question also has identical lists (Match stems repeat); in-run dedup uses stem + lists.

### Multiple correct (NEET Phase 4)

`Question Type = MULTIPLE_CORRECT` with `Correct = A,B,D` imports `isCorrect` on A, B and D (the
canonical key; no second source). Fewer than two answers, an unknown letter or a repeated letter
(`A,A,C`) is an ERROR — never narrowed or silently de-duplicated. Scoring is all-or-nothing; MSQ
tests are online-only (OMR entry refuses a mock containing one).

## Image bundle (ZIP)

- Limits: 200 MB archive, 2000 entries, 8 MB per image, 1 GB declared expansion, ratio ≤ 100:1, depth ≤ 4.
- Accepted: PNG, JPEG, WebP, AVIF (type decided by decoding — Phase 2 rules).
- **Whole archive refused**: `..`/absolute/backslash/drive paths, control characters, symlinks, encrypted
  entries, ZIP64/multi-disk, duplicate names, overlapping entries, executables/scripts/HTML/SVG/XML,
  nested archives, bomb ratios.
- **Per entry**: unsupported types (gif, bmp, pdf, txt, …), oversize images, unknown compression →
  ERROR if a row references them, WARNING ("unused") otherwise. OS junk (`__MACOSX/`, `.DS_Store`,
  `._*`, dot-files) is ignored.
- Ambiguous basenames (`a/x.png` and `b/X.png`) are never matched.
- Only **referenced** images are processed (unused files never become media). Processing runs in
  ≤ 20 s slices (nginx cuts requests at 60 s); a slice can be retried; one worker per bundle (DB lease).
- The archive is deleted from staging once the run has no pending rows. Abandoned uploads can be
  removed by hand: `find /var/lib/mocktestseries/import-staging -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} +`
  (staging holds no media; media lives only under `/media/`).

## Validation severities

- **ERROR** (row cannot import): unknown/misplaced taxonomy, exam mismatch, missing/invalid/multiple
  answer, unsupported Question Type or Content Format, MULTIPLE_CORRECT with < 2 / repeated answers,
  MATCH_THE_FOLLOWING without valid lists or with ≠ 1 correct option, images on PLAIN, missing / ambiguous / unsupported / corrupt / unprocessed
  image, malformed image reference, duplicate Code or QNo in the file, unknown/mismatched Paper Code
  or Year, several papers in a year without a Paper Code, spreadsheet formula cell, text over limits,
  REPLACE of a non-draft or non-rich question.
- **WARNING** (importable after the admin ticks *I reviewed the warnings*): explanation missing,
  difficulty missing, alt text missing, suspicious markup, review flag, publish requested, possible
  duplicate, taxonomy linked to the exam on import.
- **INFO**: defaults applied, formula/chemistry/image counts, target status and editorial stage.

"Import as Draft" is disabled (and refused server-side, 409 `ROWS_HAVE_ERRORS`) while ERROR rows
exist; the existing explicit **Import Valid Only** imports the valid/warning rows only.
Messages read `Field: message`; the **Error Report** (CSV) has Row, Question Code, Field,
Severity, Message, Suggested Action, plus bundle-level lines — no server paths.

## Spreadsheet formulas / macros

The workbook is data. Rich mode reads formulas as text only to **refuse** those cells (ERROR,
"Paste Special → Values"); SheetJS never evaluates formulas and VBA/macros are not loaded.
`.xls` is refused in Rich mode (use `.xlsx` or `.csv`).

## Status and editorial stage

Import ≠ publish. Every rich question is saved **DRAFT** whatever the file or a row override says.
Editorial stage: `NEEDS_REVIEW` when the author flagged it, a warning exists, or the legacy rules
flagged review; otherwise `DRAFT`. Never `VERIFIED` / `READY_TO_PUBLISH` (technical validation is
not content correctness). `reviewRequired` follows NEEDS_REVIEW; `reviewReason` keeps
"Author: <reason>" and the first system warning.

## Duplicates

Existing semantics and detection (same Code, same paper + question number, same exam + subject + text),
existing strategies SKIP / REPLACE / ADD_AS_NEW. Rich REPLACE is allowed **only** onto questions that
are already RICH_V1 **and** DRAFT — a published (e.g. RUHS) or a PLAIN question (e.g. the 180 legacy NEET
drafts) is never rewritten by a rich import. REPLACE writes new option rows and new QuestionAsset
references; files are never overwritten or deleted, so submitted attempts keep their frozen images.

## Transactions, failure recovery, idempotency

- Media first (outside the DB), then one transaction per row: Question + options + QuestionAsset
  references + BulkImportRow provenance commit together or not at all. A failed row stays FAILED /
  PENDING with its message; the run is never marked IMPORTED with pending rows.
- Orphan media (processed but never referenced) is harmless and immutable by design.
- Upload: a client `idempotencyKey` returns the existing run on retry.
- Chunks: idempotent per index. Processing: DB lease, finished images skipped.
- Import: run-level execution lease (`executingAt`) → a second concurrent call gets 409 `ALREADY_RUNNING`;
  each row is claimed inside its transaction (`status = PENDING`), so it can never be written twice.
  (The lease also protects Standard imports, which previously could double-process on a double click.)

## History, traceability, rollback

- `BulkImportRun.importMode`, `assetCount`, `formatCounts`, the existing counts, admin, file, exam,
  paper, timestamps; Import History shows a RICH badge and the counts.
- Every question has `importBatchId`; every row keeps `questionId` (traceable both ways).
- Rollback = the existing *Delete Questions Created By This Import* flow (lib/import-rollback.ts):
  questions in papers/tests are PROTECTED, ones with attempt history are ARCHIVED, only unreferenced
  ones are deleted. Deleting a question removes its QuestionAsset references only — MediaObjects and
  files are never deleted; attempts are never touched.

## Resource design (2-CPU VPS)

Chunked upload (≤ 8 MB per request), archive read entry-by-entry (≤ 8 MB in memory), one image
decoded at a time, processing in ≤ 20 s slices, commit = DB only. Measured numbers are in the Phase 3
report (`scripts/verify-rich-import-scale.mjs`).

## Not in Phase 3

- (Phase 4 added: `MULTIPLE_CORRECT` import + scoring, `Question.questionType` / `matchSpec`,
  `LIST_ITEM` assets, snapshot v3 for advanced types — see docs/NEET-QUESTION-TYPES.md.)
- Partial-credit MSQ schemes, drag-to-match.
- Real NEET media bulk import — waits for the off-site backup (`mts-offsite`).

## Tests

`scripts/verify-rich-import.ts` (server), `scripts/verify-rich-import.mjs` (browser, desktop + mobile),
`scripts/verify-rich-import-scale.mjs` (45 / 180 / stress), `scripts/legacy-import-parity.ts`
(baseline-vs-new diff), fixtures `scripts/rich-import-fixtures.ts` (synthetic only). See ops/TEST-ENGINE.md step 10.
