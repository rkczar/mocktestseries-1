# AI System Audit — 2026-10-29

Read-only baseline taken before any change. Evidence comes from the code at the
production SHA and from read-only (`BEGIN READ ONLY`) aggregate queries on the
production database. No prompt or response text, and no secrets, were read.

## 0. Baseline

| Item | Value |
|---|---|
| Production release | `4939034f84681b2de0d908e522a6745751c49fb7` (deployed 2026-10-26 18:22:12 UTC) |
| origin/main | `4939034` (same as production) |
| `/var/www/mocktestseries` working copy | branch `fix/otp-webhook-insights-rbac` @ `10991b0` (old, clean). Never deploy from it. |
| Task branch / worktree | `feat/ai-reliability-openrouter` @ `/root/mts-worktrees/ai-reliability` (from `4939034`) |
| Other worktrees | 22 earlier task worktrees, left untouched |
| Deploy | `ops/deploy/mocktestseries-deploy.sh <full sha>` run **from a checkout of the release commit**, under `systemd-run --scope -p MemoryMax=4500M`; `APPLY_MIGRATIONS=1` when the release adds migrations |
| Rollback | atomic switch to `/var/www/mocktestseries-releases/4939034…` + `pm2 reload` |
| Supplied system report | `mocktestseries-system-report-2026-10-29-0749.{md,txt}` was **not found** on this server, so every fact below was verified directly |

Provider switches (production `Setting`, enabled flags only): `api.openrouter` ON (key present),
`api.gemini` ON (key present, **no Gemini call since 2026-10-13**), `api.openai` OFF, `api.anthropic` OFF,
`instagram.publishing` ON.

All 14 AI Engine features have `provider = openrouter`, `mode = cheapest`, with no pinned model and no fallbacks.
Privacy is `dataCollection = allow`. Budgets are unset, so the code defaults apply: ₹100/day, ₹1,500/month,
₹2 per text request, ₹10 per image.

## 1. AI workflow inventory

| # | Workflow | Entry point | Code | Path to the provider | Modality | Output contract | Retry / fallback today |
|---|---|---|---|---|---|---|---|
| A1 | Student Ask AI explanation | `/student/...` Ask AI → server action | `lib/ai-explanation.ts` `runAndPersist` | `generateForFeature("explanation")` → `generateTextViaOpenRouter` | text | JSON `{concept, optionAnalysis, …}` | 1 retry on 429/5xx/network, plus 2 OpenRouter `models` fallbacks (the next-cheapest approved models) |
| A2 | Explanation styles (variants of an explanation) | student | `lib/ai-explanation-variants.ts` | `generateForFeature("explanation")` | text | same JSON | same |
| A3 | Admin explanation regenerate | admin | `lib/ai-explanation.ts` | `explanation_admin` | text | same JSON | same |
| B1 | Student AI question variants | student | `lib/ai-variant.ts` | `variant` | text | JSON batch of MCQs, validated by `lib/ai-variant-validation.ts` | same |
| B2 | Admin AI variants | admin | `lib/ai-variant.ts` | `variant_admin` | text | same | same |
| C | AI Question Importer (PDF / scan / image / DOCX → questions) | `/admin/ai-import/*`, worker | `lib/ai-import/*` (`ai.ts importerAiCall`) | its own planner → `chatCompletion` (shared OpenRouter adapter); never Gemini | text + vision | JSON Schema / JSON mode where the route supports it; validated | 1 retry, model replacement, 429 breaker, ledger budget |
| D1 | IG carousel content from a PYQ / Most-Missed question | `/admin/instagram/*` | `lib/instagram/ai.ts`, `ai-core.ts` | `ig_carousel` (or a per-request legacy provider override) | text | JSON with answer-label echo | engine retry + fallbacks |
| D2 | IG examiner trap (generate + blind re-solve) | editor | `lib/instagram/ai-studio.ts`, `trap.ts` | `ig_trap` ×2 | text | JSON | same |
| D3 | IG diagram plan | editor | `ai-studio.ts`, `diagram.ts` | `ig_diagram` | text | JSON | same |
| D4 | IG caption versions | editor | `ai-studio.ts` | `ig_caption` | text | JSON | same |
| D5 | IG trends / competitor analysis | `/admin/instagram/trends` | `lib/instagram/trends.ts` | `ig_trends`, `ig_competitors` | text | JSON | same |
| D6 | IG medical image | editor | `lib/instagram/medical-image.ts` | `generateImageViaOpenRouter` **or a direct Gemini REST call** (legacy branch) | image out | PNG bytes | none |
| D7 | IG render / publish | editor, publish | `render.tsx` (Satori), `publish.ts` (Meta Graph) | not AI | — | — | publish lease + reconcile |
| E1 | Video script + storyboard | `/admin/video-studio`, cron worker | `lib/video-studio/pipeline.ts`, `script.ts` | `generateTextViaOpenRouter("video_script")` | text (+ image parts) | JSON | engine retry |
| E2 | Motion plan | worker | `lib/video-studio/motion/pipeline.ts` | `video_script` | text | JSON | engine retry |
| E3 | Voice (TTS) / word timing (STT) | worker | `lib/ai-engine/speech.ts` | OpenRouter `/audio/speech`, `/audio/transcriptions` | audio | bytes / JSON | — |
| E4 | Render | worker | `lib/video-studio/render-runner.ts` (Docker `mts-video-render:1`) | not AI | video | mp4 | job retry |
| F | Model catalog, eval, quotes, budgets, analytics | `/admin/ai/*` | `lib/ai-engine/*` | OpenRouter catalog (free metadata) | — | — | — |
| G1 | Legacy gateway providers | any feature set to `legacy`, or an IG per-request provider override | `lib/ai-gateway.ts`, `lib/ai-provider.ts` (Gemini/OpenAI REST), `lib/anthropic-client.ts` | direct provider calls | text | — | — |
| G2 | Provider admin tests / model lists | `/admin/ai/providers` | `gemini-config.ts`, `openai-config.ts`, `anthropic-config.ts` | direct list-models calls | — | — | — |

Direct provider hosts outside the OpenRouter adapter (`lib/ai-engine/openrouter.ts`):
`lib/ai-provider.ts` (Gemini + OpenAI generate), `lib/gemini-config.ts` (model list), `lib/openai-config.ts` (model list),
`lib/anthropic-client.ts` (Claude SDK), `lib/instagram/medical-image.ts` (Gemini image REST).

## 2. Observed reliability (production `AiGatewayCall`, last 14 days)

| Feature | OK | Failed (category × n) | Avg latency OK |
|---|---|---|---|
| explanation | 423 | empty_response 28, model_unavailable 5, provider_error 3 | 21 s |
| explanation_admin | 6 | empty_response 7 | 8 s |
| variant | 60 | empty_response 3 | **84 s** |
| ig_carousel | 82 | empty_response 3, model_unavailable 2, provider_error 1 | **71 s** (max 735 s) |
| ig_trap | 31 | empty_response 1 (186 s) | 5 s |
| ig_diagram / ig_caption / ig_image | 28 / 17 / 2 | — | 5 / 8 / 11 s |
| video_script | 9 | — (but 3 jobs FAILED on unusable JSON, see F5) | 30 s |
| qimport_* | 792 | truncated 136, rate_limited 114, empty 32, no_endpoint 16, provider_error 7, model_unavailable 1 | 10–21 s |

Models that actually answered (last 7 days): `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` (up to 735 s),
`nvidia/nemotron-3.5-content-safety:free`, `liquid/lfm-2.5-2.6b:free`, `cohere/north-mini-code:free`, and once
`google/gemini-3.1-flash-image-preview` (image). `openai/gpt-5-nano:batch` failed every time.

## 3. Failure matrix (confirmed root causes)

| ID | Symptom | Evidence | Root cause | Layer | Fix |
|---|---|---|---|---|---|
| F1 | Students receive explanations that read "User Safety: safe" | **65 COMPLETED `AIExplanation` rows** from `nvidia/nemotron-3.5-content-safety:free` (all 65 contain "User Safety"); 66 "successful" gateway calls from that model in 7 days | "Cheapest Approved" routing ranks all free models equally. The approved set includes a **safety classifier**, which answers every prompt with a verdict. `validateExplanationContent` (`lib/ai-explanation.ts:130`) stores non-JSON text as `concept`, so the verdict is saved as a successful explanation | application (routing + validation) | Task-aware eligibility rejects classifier, guard, music and batch-only models. Structured validation rejects non-JSON output, and the result is never stored as success. The 65 rows are flagged for regeneration (admin action, paid) |
| F2 | IG carousel "The AI response was not valid JSON" | 5 `ig_carousel` calls answered by the content-safety model in about 3 s, logged `ok`; `parseAiResponse` then fails with `fatal` (`lib/instagram/ai-core.ts:180`) | Same routing defect as F1. The gateway logs success because it never validates the output, so the failure is invisible in AI → History | application | As F1, plus schema validation inside the gateway call so that an invalid answer counts as a failed attempt and moves on to a compatible fallback |
| F3 | Admin `/admin/instagram` and student 504s, very slow generation | ig_carousel average 71 s and max 735 s; variant average 84 s; explanation max 643 s; nginx limit 60 s | `request()` in `lib/ai-engine/openrouter.ts` clears the abort timer when the **headers** arrive, so `res.text()` is unbounded. Free reasoning models stream for minutes | provider adapter | One total deadline that covers the body read |
| F4 | `empty_response` (38 in explanation and variant) | `liquid/lfm-2.5-2.6b:free` 20 of 23 failed; reasoning model empty at the token limit | Reasoning models spend the whole `max_tokens` on reasoning; a tiny 2.6B model cannot follow the JSON contract. `finish_reason = length` is not inspected (engine path), so a cut-off answer is reported as "empty" | adapter + routing | Detect `length` → `truncated`. Bound reasoning (`reasoning.max_tokens`, `exclude`) on routes that accept it. The task profile prefers verified instruction-following models |
| F5 | Video jobs FAILED: "storyboard … contains no JSON object" ×2, "script JSON incomplete (cut off)" ×1 | `VideoJob.failedStage = script`, 2026-10-25 | Same as F1 (classifier answered) and F4 (cut off). The job then needs a new price confirmation | application | Shared structured-output call with schema-checked fallback |
| F6 | `model_unavailable` on `openai/gpt-5-nano:batch` | 3 failures × 1.1 s (ig_carousel) | `:batch` model ids are listed in `/models` but are not served by chat completions | routing | Eligibility excludes `:batch` ids |
| F7 | Approved "text" models that cannot write text answers | `google/lyria-3-*-preview` (music) approved; `openrouter/free` meta-router approved | The catalog approval trusted `output_modalities` containing "text" | routing | Exclusion rules (music/audio-out, meta-routers) in the task profile |
| F8 | Direct providers reachable at runtime | `api.gemini` enabled; IG per-request provider override and the `ig_image` legacy branch call Gemini directly; legacy routes can still reach OpenAI / Claude REST | Legacy gateway kept for rollback | gateway | Owner policy 2026-10-29: OpenRouter primary; **Gemini kept as the secondary fallback** (`runtime.geminiFallback`, default ON: a failed OpenRouter text request is retried once on Gemini) and as an explicit admin choice; **direct Claude / OpenAI refused** (`runtime.directClaudeOpenAi`, default OFF; their models run through OpenRouter). Credentials are kept. A static audit test fails on new direct provider calls |
| F9 | Hard budget stops interrupt work | Defaults ₹100/day, ₹1,500/month, ₹2/text request (`lib/ai-engine/config.ts DEFAULT_BUDGETS`). A quality model for a 3,000-token carousel can exceed ₹2 | Hard caps by design (2026-10-12) | engine | Daily/monthly become warnings by default (configurable back to hard stop). Per-request ceilings stay, raised to a realistic default. Bounded retries stay. The emergency stop stays |
| F10 | Retry has no backoff and ignores `Retry-After` | `engine.ts` loop retries immediately | — | engine | Bounded exponential backoff with jitter, `Retry-After` honoured within the deadline |
| F11 | Duplicate generation window | `STALE_GENERATION_MS = 2 min`, but calls ran up to 12 min | — | application | The total deadline (F3) keeps every call far below the stale window |
| F12 | No topic-based or custom IG post | `InstagramPost.questionId` required, series only `PYQ`/`MOST_MISSED` | Feature gap | feature | New "Create from Topic / Custom Prompt" workflow (series `TOPIC` / `CUSTOM`) reusing drafts, render, checks and publish |

Provider failures (true provider side): `rate_limited` 114 (importer, free models, 2026-10-19), `no_endpoint` 16
(privacy/price constraints), `provider_error` 7. Everything else above is an application-side defect.

Not available / not examined: PM2 stdout logs were not mined for prompts (by design). Meta publish failures:
none recorded (`publishError` empty, 28 STARTED = 28 PUBLISHED in 14 days).
