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
| Model selection | `select.ts` (automatic choice per task), `routes.ts` (OpenRouter provider routes + ZDR list, Setting `ai.importer.routes`), `selection-types.ts` |
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

## Model selection

Import Settings → **Model selection** is **Automatic** by default: no model is chosen per
import. For each task — page reading (digital and scanned / OCR pages), independent
verification, answer-key reading, topic classification — `lib/ai-import/select.ts`
evaluates every model APPROVED in Admin → AI → Models against the task's largest request:

- approved, not disabled, still listed, not expired, fixed published price, returns text;
- reads images when the task sends page images (an unreadable image price is refused);
- provider routes read from OpenRouter (`GET /models/{id}/endpoints`), serving normally
  (endpoint status 0), accepting `max_tokens`, with room for the request;
- with ZDR required: only routes on OpenRouter's public ZDR list (`GET /endpoints/zdr`);
- conservative MAXIMUM per request = the highest price over the catalog price and every
  eligible route (including long-prompt price overrides) × 5% margin, and it must fit the
  per-request limit.

The cheapest eligible model by that maximum wins (then typical cost, then id); verification
never uses the page-reading model. Route data is stored with its time; the settings page
uses the stored copy (no network call on page load, "Refresh provider routes" reads it
again), and confirming a job reads it again when it is older than 6 h. Unreadable routes,
an unreadable ZDR list or no exchange rate mean no model is chosen — the reason is shown,
and confirming refuses. Nothing is guessed: model ids, prices and capabilities come only
from the synced catalog and the route data.

The choice is **frozen on the job at confirmation** (`job.config.modelPlan`); later
settings changes do not change a running job. If the frozen model becomes unavailable
(unapproved, withdrawn, or OpenRouter answers "no endpoint" for it under the privacy and
price constraints), the worker chooses again: an equal or cheaper replacement is used and
recorded (event `MODEL_REPLACED`, shown on the job page); a more expensive one only when
"Allow a MORE EXPENSIVE model" is switched on (off by default) — otherwise the job pauses
and says why. A replacement is never the job's model for the other of page reading /
verification, so the second read stays independent. **Manual override** (Master Admin)
uses the administrator's models with the same checks.

## Costs and privacy

Importer budget (Setting `ai.importer.budget`) is separate from the platform / student
AI budgets (`lib/ai-engine/budget.ts` excludes `qimport_*`). Every request reserves its
worst case against the job cap and the monthly importer budget under one advisory lock;
the job pauses (Paused — budget limit) before exceeding either. Unknown costs keep the
worst case. Privacy is sent per request (`provider.data_collection`, optional `zdr`).

Hard guards (all fail closed, nothing is sent when they refuse):
- Confirm re-prices the job with the settings it freezes; an AI job whose estimate is
  unpriced or above the job budget is not started (the budget is never raised for you).
- The worst-case reservation uses the same 5% margin as the `max_price` sent to OpenRouter.
- The OpenRouter key is shared with student Ask AI: before each request the key's remaining
  credit is read and the request is refused unless `budget.keyReserveUsd` (default $5)
  would remain after its worst case AND every other importer request still in flight
  (checked inside the reservation lock). A key without a credit limit is refused while
  the reserve is above $0 (the reserve cannot be guaranteed).
- **Pilot ceilings are fixed in code** (`PILOT_LIMITS` in `lib/ai-import/config.ts`): ₹10
  all-time, ₹10 per IST month, ₹8 per job, ₹1 per request, at least $5 kept on the key for
  Ask AI. Import Settings can only lower them; larger saved values (including older
  settings documents) are clamped when read, and the reservation applies them again.
  Raising them needs a code change and a deploy.
- `budget.maxJobInr` is a hard ceiling per job: create, confirm and resume refuse a larger
  job budget, and every reservation uses min(job budget, ceiling), so lowering the ceiling
  also stops older jobs.
- `budget.totalInr` is an all-time importer cap that never resets: a pilot cannot gain a
  fresh monthly budget when the IST month changes.
- Confirm also refuses when the job's **conservative maximum** (every possible request at
  its reserved worst case: every AI page read and second-read, the answer opinion per
  question when on, a retry when on) is above the job budget or above what is left of the
  all-time or monthly budget. The estimate shows both the typical cost and this maximum.
- Worst case = input tokens (page images counted as 3,500 tokens each — above the published
  per-image formulas for a 1600 px page) + the full output limit + request price + the
  model's `pricing.image` read as a per-image-token price (the larger reading). A vision
  model whose image price cannot be read is unusable. If the provider still reports a cost
  above the reservation, the charge is recorded in full and the job pauses (scope
  `overrun`) — never silently.
- A second read refused by a limit keeps the extracted page (no paid re-read on resume),
  marks its questions for correction and pauses the job.
- One attempt per request; `budget.retryTransient` re-enables a single retry, which reserves
  again under the same limits.
- A replacement model priced above the frozen one is never used unless the administrator
  allowed it (see Model selection); manual fallbacks must cost no more than the chosen model.
- Requests send `max_price` (the frozen route maximum), `zdr` when required,
  `data_collection` and `require_parameters: true` (only routes honouring `max_tokens`).
  `max_price` caps the prompt and completion prices; image and per-request prices are
  bounded by the route data at selection time, and a provider charge above the reservation
  still pauses the job (`overrun`).
- ZDR status shown in Import Settings means OpenRouter's public ZDR list names every route
  the model may use, and ZDR is required on each request. Account-level OpenRouter settings
  (prompt logging, training providers) cannot be read through the API and must be
  confirmed by the account owner.
- Import Settings shows provider status (never any part of the key), route status, the
  chosen model per task with its reason, price, typical and maximum cost, image support,
  privacy route and why other models are ineligible.

## Safe reset of a processed job

A processed import that produced nothing can return to Uploading (job page → **Reset to
editable**, Master Admin, typed `RESET`), so wrong files can be removed or replaced and
analyzed again. `resetJob` (lib/ai-import/jobs.ts) holds the vault-files lock, the importer
budget lock and the job row lock, re-checks inside the transaction and refuses unless ALL
hold: finished or stopped status (never queued / processing / importing / cancelled), no
live worker lease, zero extracted questions, no import into the Question Bank, ₹0 spent
with no AI call or budget reservation ever made, no figures or key entries, and every
stored original present. On success it removes the page records and renders, clears the
analysis, estimate and frozen settings, sets the files back to uploaded, and writes event
`JOB_RESET` plus audit `AI_IMPORT_JOB_RESET` (with every check). Otherwise nothing changes
and the job page lists the failed checks and the safe alternative (a new import).

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
`scripts/mock-openrouter-vision.mjs` (models, provider routes, ZDR list, failure
switches) + `scripts/verify-ai-import.ts` (server; `ONLY=U` runs the automatic-selection
section alone), `scripts/verify-ai-import-ui.mjs`, `verify-ai-import-settings-ui.mjs` and
`verify-ai-import-remove-ui.mjs` (browser). See ops/TEST-ENGINE.md step 13.
