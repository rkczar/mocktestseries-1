# JSON question import — schema `mocktestseries.questions/v1`

Admin → Questions → **Bulk Import** accepts JSON next to CSV / XLS / XLSX. JSON is
only another way to write the same rows: `lib/json-import.ts` turns the document
into the exact `BulkImportRow` values the spreadsheet parsers produce, so staging,
validation, duplicate detection, preview, Draft workflow, import history and
rollback are the existing pipeline, with the same messages and rules
(see `docs/RICH-IMPORT.md` for Rich mode).

| What you upload | Mode | Notes |
| --- | --- | --- |
| `questions.json` | Standard | Plain text single-correct questions (like the CSV template). |
| `questions.json` | Rich content | Formulas, chemistry, MSQ, Match the Following, Review Required. Images come from a separate ZIP image bundle. |
| `package.zip` = `questions.json` + images | Rich content | One file: the ZIP goes in the question-file slot and IS the image bundle. Exactly one `questions.json` (any folder). |

Rich imports are always saved as **DRAFT**. JSON imports never publish: `status`
may be left out or set to `"DRAFT"`; anything else refuses the file.

Examples (synthetic content; downloadable from the import page):
`docs/json-import-examples/` — `ruhs-mo.json`, `neet-ug-rich.json`,
`with-images.json`, `multiple-correct.json`, `match-the-following.json`.
They are generated from `lib/json-import-examples.ts`
(`npx tsx scripts/write-json-import-examples.ts`); `scripts/verify-json-import.ts`
checks the files match.

## Document

```json
{
  "schema": "mocktestseries.questions/v1",
  "defaults": { "subject": "Chemistry", "contentFormat": "RICH_V1", "difficulty": "MEDIUM" },
  "questions": [ { … }, { … } ]
}
```

- `schema` — optional; if present it must be exactly `mocktestseries.questions/v1`.
- `defaults` — optional; sets any of `exam`, `year`, `paperCode`, `subject`, `topic`,
  `subtopic`, `type`, `contentFormat`, `difficulty`, `source` for every question
  (a question's own value wins).
- `questions` — required, 1–2000 entries (Rich mode: at most 500 per import, as for XLSX).
- A bare array of questions is also accepted.
- Unknown fields anywhere are refused (a typo never silently drops data).

## Question

| Field | Type | Meaning (spreadsheet column) |
| --- | --- | --- |
| `code` | string | Your source code for the question, unique within the file. It is kept on the import row (history) and matched against existing question codes for duplicates (Skip / Replace / Add as new); the stored question gets the platform's own code, as with CSV. |
| `questionNumber` | number / string | QNo within its paper (duplicate aid for PYQ imports). |
| `exam` | string | Exam name or code. Leave out to use the Exam selected on the import page. |
| `year` | number / string | Exam Year. |
| `paperCode` | string | Rich: links the row to a Previous Year Paper of that exam. |
| `subject`, `topic`, `subtopic` | string | Taxonomy names, matched like the spreadsheet columns. |
| `type` | string | Rich: `SINGLE_CORRECT` (default), `MULTIPLE_CORRECT` (`MSQ`), `MATCH_THE_FOLLOWING` (`MTF`). |
| `contentFormat` | string | Rich: `PLAIN` (default) or `RICH_V1` (KaTeX `$…$` / `$$…$$`, mhchem `\ce{…}`). |
| `question` | string or `{text, images}` | Question text; images need Rich mode. |
| `options` | see below | Exactly four options, A–D. |
| `correct` | `"B"`, `"A,C"` or `["A","C"]` | Correct label(s). Several labels only for `MULTIPLE_CORRECT`. |
| `explanation` | string or `{text, images}` | Explanation text (+ Rich explanation images). Stored by **Rich content** imports only — a Standard import does not save explanations (same as a Standard CSV / XLSX). |
| `difficulty` | string | `EASY`, `MEDIUM` (default), `HARD`. |
| `source` | string | Question source, as in the spreadsheet. |
| `status` | string | Only `"DRAFT"` (or leave it out). |
| `review` | `{required, reason}` | Rich: Review Required flag and reason. |
| `matchLists` | `{listI, listII}` | Rich, Match the Following: `[{key, text, images}]` per list. |

**Options** — any one of:

```json
"options": ["Adrenaline", "Atropine", "Hydrocortisone", "Chlorpheniramine"]
"options": { "A": "40–50", "B": "60–100", "C": "100–120", "D": "120–140" }
"options": [ { "label": "A", "text": "Humerus" }, { "label": "C", "text": "Femur", "correct": true, "images": [ … ] }, … ]
```

With the object form, `"correct": true` on options may replace the `correct`
field; if both are given they must agree.

**Images** (Rich mode) — `[{ "file": "SAMPLE-004-Q1.png", "alt": "Circuit diagram" }]`,
`{ "file": "…", "decorative": true }`, or just `"SAMPLE-004-Q1.png"`. `file` is the
image's file name inside the ZIP (folders are ignored; names must be unique).
Limits and the file-name rules are those of the Rich importer: 8 question images,
3 per option, 8 explanation images, 1 per list entry; PNG / JPEG / WebP / AVIF,
8 MB per image.

## Validation

Refused before staging (nothing is created), with every problem listed as
`Question <n> › <field>: …`:

- not valid JSON, nested too deeply, larger than 10 MB, no questions, more than 2000;
- unknown fields, wrong types, missing `options` or `correct`, not exactly four options,
  an option label other than A–D, `correct` disagreeing with `"correct": true` options;
- Rich-only content (formulas format, images, MSQ / MTF, review) in Standard mode;
- `status` other than DRAFT;
- Standard mode: the same `code` twice in one file, ignoring case (Rich mode reports it per row);
- JSON package: no `questions.json`, or more than one.

Then the existing validators run per row, exactly as for a spreadsheet: unknown
exam / subject / topic, invalid or missing answer labels, unsupported question
type, duplicates (same code, same paper + QNo, same text), missing or invalid
images, list rules for Match the Following, and a file whose `exam` differs from
the selected Exam (Standard: a warning, the row is imported under the selected
Exam; Rich: an error — as for CSV / XLSX). ZIP safety (path traversal, absolute paths, symlinks, nested archives,
executables, SVG, zip bombs, encrypted entries, duplicate names) is the image
bundle's existing check and applies to JSON packages unchanged.
