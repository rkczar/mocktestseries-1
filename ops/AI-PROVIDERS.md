# AI Providers (Gemini, OpenAI, Claude) and the AI Gateway

Admin → AI Solutions → **AI Providers** (`/admin/ai?tab=providers`, MASTER_ADMIN only).

## Adding or replacing the Anthropic Claude key (no server access needed)

1. Paste the key (`sk-ant-…`) in the Claude card and click **Save**.
2. Click **Test Connection**. It does three things:
   - lists models (free; this validates the key and loads the live model list);
   - checks the selected model is available to this key;
   - sends one tiny test request, to catch "no credit" and "no model access" problems.
3. Pick the model and effort, then switch **Enable Claude** on.
4. Under **Feature routing**, choose Claude as the primary provider (or a fallback) for each feature.

The key works on every PM2 worker on the next request: no `.env` edit, no restart, no redeploy.
**Replace API Key** and **Remove API Key** take effect immediately too. Removing the key also disables Claude.

## How the key is stored

- Setting `api.anthropic` holds only `apiKeyCipher`: AES-256-GCM, format `v1:iv:tag:ciphertext`, from `lib/secret-cipher.ts`.
  It also holds a masked hint (`sk-ant-••••1234`) and the test status.
- The encryption key is derived from **`AUTH_SECRET` in the shared server `.env`**
  (`/var/www/mocktestseries-shared/.env`). That file is outside the database, the release tree and Git.
  A database dump alone cannot decrypt the key. This is the same mechanism already used for the Gemini, OpenAI and Razorpay credentials.
- The key is never sent to the browser, written to logs, audit entries or `AiGatewayCall`, or returned by any action.

## Recovery and backup

- Back up the shared `.env` (it holds `AUTH_SECRET`) together with the database backups, kept separately and access-restricted.
- **If `AUTH_SECRET` is lost or rotated**, every stored provider key (Gemini, OpenAI, Claude, Razorpay) becomes unreadable.
  The cards then show "Not configured". Re-enter the keys in the Admin Panel; nothing else breaks.
  Rotating `AUTH_SECRET` also signs everyone out, so plan it.
- **If the Anthropic key leaks**: revoke it in the Anthropic Console, then use **Replace API Key** here.

## Routing and safety

- Every feature defaults to **Default routing**, which is exactly the existing AI Settings behaviour
  (active provider, then fallback provider). Nothing changes until a route is set to "Custom".
- A custom route sets: primary → first fallback → second fallback, a model override per provider,
  a timeout (5–180 s), retries for temporary errors (0–3) and a daily cap. It is stored in Setting `ai.gateway` and read on every call.
- Platform Controls → AI pause stops all gateway calls. "Ask AI disabled" still blocks the student features
  (AI Explanation, AI Variant) on custom routes.
- Usage and estimated cost come from the `AiGatewayCall` table, which stores tokens, model, latency and a sanitized error summary — never prompts or keys.
  Prices are editable estimates; the provider invoice is the source of truth.

## Tests

- `scripts/verify-ai-gateway.ts` — credentials, connection-test error categories, routing, retries, caps, and secret-leak checks.
  Runs against `scripts/mock-anthropic.mjs`.
- `ANTHROPIC_TEST_BASE_URL` is honoured only for `http://127.0.0.1:<port>`, so production always calls `api.anthropic.com`.

## AI Engine (OpenRouter) — added 2026-10-13

OpenRouter is the primary provider of the central AI Engine. Pages: Admin → AI → **Overview** (`/admin/ai`), **Providers**, **Models**, **Features**, **Analytics**, **Budgets**, **History**.
FULL_ADMIN can view these pages; only MASTER_ADMIN can change anything (`ai-engine:manage`).

### Safe rollout (one feature at a time)

1. **Key.** Either run `sudo /var/www/mocktestseries-current/ops/ai/set-openrouter-key.sh`, which reads the key from a hidden prompt, or paste the key in AI → Providers.
   - The key is stored encrypted in Setting `api.openrouter`, the same scheme as the Claude key. It never goes into `.env`.
   - Set a monthly credit limit on the key in the OpenRouter dashboard first. That limit is the provider-side backstop.
2. **Test Connection.** It calls `GET /api/v1/key`, which costs nothing and shows the key limit. Then click **Enable OpenRouter**. A new key always starts disabled.
3. **Models.** Click **Sync models**. Prices are copied from the OpenRouter Models API.
   - **Approve** the models you allow.
   - Mark **Medically approved** only after you have run **Evaluate (paid)** and reviewed the result.
     - Evaluate blind-solves up to 10 random published PYQ MCQs and compares the answers with the key.
     - Disagreements are only listed for review; no answer is ever changed.
4. **Features.** Switch a feature from *Legacy route* to *OpenRouter*, then check AI → History. Start with Instagram captions or trends; move student Ask AI last.
   - Medical features only use medically approved models.
5. **Rollback for a feature.** Set it back to *Legacy route*. This takes effect on the next request; no deploy is needed.

### Cost and budget rules

- **Cost preview.** Every admin-triggered AI action shows the **AI Cost Preview** first.
  - It shows the model, tokens, typical and maximum ₹, the per-request limit and the USD→INR rate.
  - **Generate Now** sends a one-time quote id. The action consumes it atomically, so a double click or a replay starts nothing.
  - Instagram Bulk Studio shows one combined preview and issues one quote per post and step.
- **Students.** Students never see a preview. Their requests are limited by approved models, the per-request limit, the daily student limits (AI → Settings) and the platform budgets.
- **Budgets.** Defaults are ₹100/day and ₹1,500/month, ₹2 per text request and ₹10 per image.
  - Before each request, its maximum possible cost is reserved under a Postgres advisory lock (`AiBudgetReservation`).
  - After the call, the reservation is settled to the cost OpenRouter reported (`usage.cost`).
  - An unknown cost (timeout, crash) keeps the reserved maximum.
- **Emergency stop** (AI → Budgets) stops every new AI request, OpenRouter and legacy alike. Cached explanations are still served.
- **USD→INR.** The rate comes from Frankfurter (ECB reference rates) and is refreshed lazily once a day. A manual override is available.
  - Each cost row stores the rate it used.
  - A rate older than 14 days is not used; paid requests then refuse until the rate is refreshed.
- **Analytics.** Costs are what the provider reported. Legacy Gemini/Claude/OpenAI requests and older rows count as requests but never as ₹0.
  - **Reconcile pending costs** (AI → Analytics) fills in costs that were reported late, via `GET /api/v1/generation`.

### Privacy

Every request sends `provider.data_collection = "deny"` (configurable) and optionally `zdr: true`.
OpenRouter then fails the request rather than use a provider outside the policy.

### Medical images

- Feature *Instagram Medical Images*:
  - *Legacy route*: the Gemini image model, unchanged, now logged and subject to the emergency stop.
  - *OpenRouter*: the Images API (`POST /api/v1/images`, 4:3, 1K) with an approved, medically approved image model.
- Images whose price is per token need **units per image** set on the Models page before they can be used.
- Every AI medical image must be checked before publishing.
