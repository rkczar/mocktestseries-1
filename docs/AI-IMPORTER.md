# AI Question Importer

Admin → **AI Question Importer** turns question papers and answer keys (PDF, scanned
PDF, JPG/PNG, DOCX, XLSX, CSV) into Question Bank questions. It is a preprocessing and
verification layer **in front of** the existing Bulk Import: approved questions enter
the Question Bank only through the Rich JSON package pipeline, so validation, duplicate
handling, DRAFT-only saving, Import History and "Delete Questions Created By This
Import" all apply unchanged.

```
upload (8 MB chunks, content-checked) → Original Paper Vault (private)
  → local analysis (free: poppler / DOCX XML / sheets) → estimate → admin confirms
  → worker: local extraction → AI vision only for scanned / unreliable pages
           → second read by a different model (low confidence) → answer keys
           → checks stage 1–4, taxonomy (existing ids), duplicates → statuses
  → Import as Draft / Import & Publish All Eligible / Import & Publish Selected
  → adapter → createBundle/putChunk/completeBundle → stageImportRun
     → processBundleSlice → validateImportRun → executeBulkImport (existing code)
  → reconcile every question back (lib/ai-import/adapter.ts)
```

## Code

| Area | Files |
| --- | --- |
| Settings, limits, labels | `lib/ai-import/config.ts`, `settings.ts` (Setting `ai.importer`) |
| Vault (private files) | `lib/ai-import/vault.ts` — `AI_IMPORT_VAULT_DIR`, default `/var/lib/mocktestseries/ai-import-vault` |
| Uploads, jobs, actions | `lib/ai-import/jobs.ts`, `review.ts`, `app/admin/(dashboard)/ai-importer/actions.ts`, `app/api/admin/ai-importer/*` |
| File checks | `detect.ts` (magic bytes), `zip-peek.ts` (hardened Office reader), `tools.ts` (poppler: timeout, `ulimit -v`, `nice`) |
| Reading | `pdf.ts` + `pdf-local.ts` + `local-parse.ts` (text layer + positioned images), `docx.ts`, sheets via `parseImportFile` |
| AI | `ai.ts` (budget, privacy, logging), `prompts.ts` (system rules + zod schemas), `process.ts` (pages), `keys.ts` (answer keys), `post.ts` (answers, taxonomy, duplicates, checks) |
| Import + publish | `adapter.ts` (the integration contract), `lib/question-publish-policy.ts` |
| Worker | `lib/ai-import/worker.ts`, `scripts/ai-import-worker.ts`, cron `ops/ai-import/` |
| Storage Manager | `lib/ai-import/storage.ts` |

Shared with Bulk Import (moved, behaviour unchanged): `lib/bulk-import-stage.ts`
(`stageImportRun` from `upload/route.ts`, `validateImportRun` from `validate/route.ts`).

## Answers

The official key is the only "official" answer. Statuses: Official Answer Key Matched ·
Answer Independently Verified (no key; the paper's printed answer and an independent AI
opinion agree) · Answer Unverified · Answer Key Missing · Answer Key Mismatch · Ambiguous
mapping · Possible withdrawn. An AI opinion never overwrites a key. A question without
any usable answer is not importable; an admin may choose the answer (recorded as
`ADMIN_CONFIRMED`). `Question.answerVerification` keeps the provenance visible in the
Question Bank (badges in All Questions and the question preview).

## Publishing policy

One rule for every path that turns a question PUBLISHED (`lib/question-publish-policy.ts`):
not flagged for review, valid answer key for its type, ≥ 2 options each with text or an
image, every referenced image present. Bulk Publish publishes the eligible questions and
reports the rest; already-published questions are never unpublished. A Standard import
row flagged for review is saved as Draft instead of Published (a REPLACE onto an
already-published question keeps it published). "Mark Reviewed (clear flag)" is the
explicit, audited way to clear a flag.

The importer's "Import & Publish" publishes only questions that passed every automated
check (no publish-blocking issue, verified/official/admin answer — or UNVERIFIED when
the policy allows it — topic when required, figures confirmed) and whose Bulk Import
row has no warning other than "Explanation: missing". It records the automated
clearance (`AI_IMPORT_AUTOCHECK_CLEARED`) before publishing through the policy above.

## Not importable (by design)

The Question Bank holds exactly four options (A–D) and no numerical type. Five-option,
numerical and subjective questions are extracted, kept and marked **Not importable**;
nothing is dropped or converted.

## Costs and privacy

Importer budget (Setting `ai.importer.budget`) is separate from the platform / student
AI budgets (`lib/ai-engine/budget.ts` excludes `qimport_*`). Every request reserves its
worst case against the job cap and the monthly importer budget under one advisory lock;
the job pauses (Paused — budget limit) before exceeding either. Unknown costs keep the
worst case. Privacy is sent per request (`provider.data_collection`, optional `zdr`).

## Storage

Vault: `files/` originals (content-addressed, deduplicated), `figures/` original figure
bytes, `renders/` page images (re-creatable), `tmp/` upload chunks, `work/` scratch.
Imported images become ordinary media (`/media/q/…`, MediaObject) through the existing
media engine. The Storage Manager deletes only provably safe items after a preview and
a typed confirmation, re-checking references at execution time; question media is
report-only. Auto cleanup is off by default.

## Operations

- Worker: started by the admin actions; optional cron backstop `ops/ai-import/mocktestseries-ai-import.cron`.
- Logs: `/var/log/mocktestseries/ai-import-worker.log` (ids and counts only).
- Emergency stop: Import Settings → paid AI off, or Admin → AI → Budgets → emergency stop.

## Tests

`scripts/ai-import-fixtures.ts` (synthetic papers, keys, hostile files) +
`scripts/mock-openrouter-vision.mjs` + `scripts/verify-ai-import.ts` (server, 126 checks)
and `scripts/verify-ai-import-ui.mjs` (browser). See ops/TEST-ENGINE.md step 13.
