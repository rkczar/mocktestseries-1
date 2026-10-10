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
