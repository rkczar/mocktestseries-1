# Instagram API connection (read-only)

Admin → Instagram → Settings → **Instagram connection** checks the token installed on
the server against the Instagram API with Instagram Login (`graph.instagram.com`).
It only reads. Publishing, scheduling and deleting are not built, and publishing
stays off in code (`INSTAGRAM_PUBLISHING_AVAILABLE = false` in `lib/instagram/types.ts`).

## Environment (shared `.env`, never in git)

| Variable | Secret | Notes |
|---|---|---|
| `INSTAGRAM_ACCESS_TOKEN` | yes | Instagram User access token (long-lived, ~60 days) |
| `INSTAGRAM_USER_ID` | no | Numeric Instagram professional account ID; the test fails if the token belongs to another ID |
| `INSTAGRAM_TOKEN_SET_AT` | no | Written by the install script; drives the expiry warning (60 days, warns at 14) |
| `INSTAGRAM_APP_SECRET` | yes | Optional; only when "Require App Secret" is on in the Meta app (adds `appsecret_proof`) |
| `INSTAGRAM_GRAPH_API_VERSION` | no | Optional, default `v25.0` |
| `INSTAGRAM_GRAPH_API_BASE` | no | Tests only; accepted for `http://127.0.0.1:<port>` and nothing else |

Only `lib/instagram/meta.ts` (server-only) reads the token. The token goes in the
`Authorization` header only, never in a URL. Error texts are redacted, and nothing is
logged. The browser sees only "configured yes/no" and an 8-character SHA-256 fingerprint.

## Install / rotate the token

```bash
sudo /root/mts-set-instagram-token.sh          # hidden prompt for the token, then the numeric user ID (Enter keeps the pinned one)
pm2 reload mocktestseries
```

Then open Admin → Instagram → Settings → **Test connection**.

- **Never paste the token into chat, tickets or commits.** If a token was ever shared,
  revoke it in the Meta app (or let it expire) and generate a new one.
- `… status` shows which variables are set, without values.
- `… clear` blanks the token and app secret, for example after a leak.
- `… app-secret` sets `INSTAGRAM_APP_SECRET`.
- Each run leaves `.env.bak-*` with every Instagram and Resend secret blanked.

Shell check without the admin UI (saves nothing):

```bash
cd /var/www/mocktestseries-current
NODE_OPTIONS=--conditions=react-server npx tsx scripts/instagram-connection-test.ts
```

## What the test does

1. `GET /me?fields=user_id,username,account_type,name,media_count`. This checks that the
   token is valid, the username is `mocktestseries.in`, the `user_id` matches
   `INSTAGRAM_USER_ID`, and the account is Business or Creator.
2. `GET /<user_id>/content_publishing_limit`. Meta only allows this read with
   `instagram_business_content_publish`, so it proves the permission without publishing.
   A permission error is reported as **Missing**. Any other failure is reported as **Not verified**.

The last result is stored in the `Setting` row `instagram.connection`, which holds no
secrets. Each run writes an `AuditLog` entry `INSTAGRAM_CONNECTION_TESTED`.

## Tests (scratch only)

- `scripts/verify-ig-meta.ts`: library scenarios against `scripts/mock-meta-graph.mjs`.
  Outbound requests are blocked.
- `scripts/verify-ig-meta-ui.mjs`: browser checks on a scratch `next start`, one boot per
  scenario, plus token-leak scans of browser payloads, server logs, the DB dump and the
  client bundle.
