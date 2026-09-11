# AI System — Production Specification

Source: `ai-data.js`. Its own header is unusually explicit and should be treated as binding
guidance: "Gemini itself is never called from this static prototype (no secret can live safely
in frontend code, no server exists to hold one) — generatorFn stands in for the real
server-side call, and the cache/log/limit/linking behaviour around it is real."

## What's real vs. simulated
- **Real, reusable logic**: cache-or-generate flow, per-student usage logging kept separate
  from cached content, max-5-variants hard cap (enforced in code, not just UI), near-duplicate
  variant rejection (normalized text comparison), admin settings shape, admin analytics
  aggregation (requests/responses/API-calls/cache-hit-rate/per-student/per-question).
- **Simulated**: the actual model call (`generatorFn`) and the "AI service health" status,
  which is currently just a heuristic over recent failure counts, not a real health check.

## Content model
- `AiSolution` keyed by questionId: explanation, optionAnalysis (why each wrong option is
  wrong), memoryTrick, model, promptVersion, createdAt/updatedAt, generationStatus.
- `generatedVariants`: up to 5 AI-generated alternate/similar questions per parent question,
  each with a stable `AI01`..`AI05` code suffix, sequence number, and its own
  generationStatus. Capped and de-duplicated server-side, not just in the UI.
- `AiUsage` log entries are a **separate concept** from the cached content — one row per Ask-AI
  interaction (student, question, action type explanation/similar_questions, cache hit or not,
  model, status), used only for analytics, never for serving content.

## Reuse-before-generate rule (explicit user requirement)
On every request: check `AiSolution` cache for that questionId first → serve it if present and
caching is enabled → only call the model if no cached row exists. This is already how
`getOrGenerateSolution`/`getOrGenerateVariants` are written — preserve exactly this order of
operations server-side.

## Trigger model
- **Student-triggered**: "Ask AI" in the Test-Player review screen, and the Analysis/AI-USP
  explanation panel — never auto-generated on page load for every question a student sees.
- **Admin**: AI Solution Manager settings (model, temperature, max tokens, retry count, timeout,
  prompt templates for explanation vs. similar-question generation) and AI Analytics dashboards
  (see ADMIN-DASHBOARD.md).

## Status states
`generationStatus`: success / failed / disabled. There is no explicit "pending"/"approved"/
"rejected" review workflow in the current design — AI content is served directly to students
once generated, with no admin approval gate. Flag as ⚠️ needs clarification: does the business
want an admin-review step before an AI explanation goes live, or is direct-serve (current
design) acceptable?

## Security — non-negotiable for production
- **Never** call Gemini (or any provider) from the browser. All generation happens via a
  server-side API route/server action; the API key lives only in server env vars.
- Client only ever sees the question + the cached/generated explanation/variants — never a raw
  provider key or a raw provider request.
- Rate-limit the Ask-AI endpoint per student to control cost given generation is real API spend.
