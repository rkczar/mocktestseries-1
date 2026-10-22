# SEO Intelligence (Admin → SEO → Intelligence)

Read-only Google Search Console + GA4 reports for https://mocktestseries.in through ONE shared
Google connection. Nothing here changes the site's SEO settings, sitemap, robots.txt, canonical
URLs or structured data, and nothing writes to Google.

| | |
|---|---|
| GA4 property | `553529096` (fixed in `lib/seo-intel/google.ts`; never `557243074`) |
| Search Console | `sc-domain:mocktestseries.in`, else `https://mocktestseries.in/` (picked on sync) |
| Scopes | `openid email webmasters.readonly analytics.readonly` |
| Redirect URI | `https://mocktestseries.in/api/admin/seo-intel/google/callback` (exactly) |
| Who | every admin role can view; MASTER_ADMIN only connects, disconnects, syncs, changes schedule/retention |

## Where things are stored (Setting table, no own tables)

| Key | Content |
|---|---|
| `seo.google.oauth` | SEO OAuth client ID, client secret (AES-256-GCM, key from `AUTH_SECRET`), refresh token (encrypted), connected account email + Google `sub` |
| `seo.intel.snapshot` | latest 28-day report + last sync status (source, errors, fail streak) |
| `seo.intel.history.YYYY-MM-DD` | one summary per IST day with a successful sync (top 10 queries/pages/channels + totals) |
| `seo.intel.settings` | daily sync on/off (default OFF), history retention days (default 400, 30–1095) |
| `seo.intel.sync-lock` | transient; one sync at a time |

`AUTH_SECRET` (shared `.env`) is required to read the client secret and refresh token. Losing it means
re-installing the client and reconnecting — it is in the nightly config archive and every pre-deploy backup.

## One-time Google Cloud setup (project `mocktestseries-seo`)

1. **APIs**: Google Search Console API and Google Analytics Data API enabled.
2. **Google Auth Platform → Audience**: *Internal* (Workspace) or *External* + **Publish app**
   ("In production"). In *Testing*, Google expires the connection every 7 days.
3. **Data access**: add scopes `…/auth/webmasters.readonly` and `…/auth/analytics.readonly` (+ `openid`, `email`).
4. **Clients → Web client**: Authorized redirect URI exactly the URI above. Rotate the client secret if it
   was ever visible in a screenshot.
5. The connecting Google account needs at least **Restricted** access in Search Console (Settings → Users
   and permissions) and **Viewer** on GA4 property 553529096 (Admin → Property access management).
6. Keep this client in its own Cloud project, separate from the student "Sign in with Google" client:
   Google revokes a user's grant per project, so sharing a project couples the two.

## Install the client on the server (never paste it anywhere else)

```bash
sudo /var/www/mocktestseries-current/ops/seo/set-google-oauth.sh          # Client ID, then secret (hidden)
sudo /var/www/mocktestseries-current/ops/seo/set-google-oauth.sh status   # installed? connected as? (no secrets)
sudo /var/www/mocktestseries-current/ops/seo/set-google-oauth.sh clear    # revoke + remove connection and client
```

Then a Master Admin opens Admin → SEO → Intelligence → **Connect Google**, ticks BOTH Search Console and
Analytics on Google's consent screen, and presses **Sync now**.

## Daily automatic sync (optional)

1. Admin → SEO → Intelligence → Schedule & Retention → tick **Daily automatic sync** → Save.
2. Install the scheduler once (root):
   ```bash
   sudo install -m 644 /var/www/mocktestseries-current/ops/seo/mocktestseries-seo-intel.cron /etc/cron.d/mocktestseries-seo-intel
   ```
   Runs 21:40 UTC (03:10 IST). Log: `/var/log/mocktestseries/seo-intel-sync.log` (status lines only).
   It skips itself while the switch is OFF, while Google is not connected, and while the connection
   needs a reconnect. Remove with `sudo rm /etc/cron.d/mocktestseries-seo-intel`.

## Reconnect / revoke rules (Google revokes per account, grant-wide)

- Reconnecting the **same** Google account keeps the old token unrevoked (revoking it would end the new one too).
- Connecting a **different** account stores the new one first, then revokes the old account's grant.
- A failed attempt never revokes the live connection's grant.
- **Disconnect** revokes the connected account's grant and clears the stored token (client stays installed).

## Troubleshooting

| Page message | Fix |
|---|---|
| Needs reconnect | Grant revoked/expired (Testing audience, password change, removed at myaccount.google.com/permissions) → Master Admin: Connect Google |
| No verified Search Console property | Give the connected account access to the Domain or `https://mocktestseries.in/` property |
| GA4 PERMISSION_DENIED | Give the connected account Viewer on property 553529096 |
| Google refused the sign-in code | Redirect URI or client secret mismatch → fix in Cloud Console, re-run `set-google-oauth.sh` |
| missing-scopes | Tick both checkboxes on the consent screen |

## Tests (scratch DB + mock Google only)

`scripts/verify-seo-intel.ts` (unit + history/retention) and `scripts/verify-seo-intel-http.mjs`
(end to end against `scripts/mock-google-seo.mjs`, which revokes grant-wide like Google). The app talks to
the mock only when `SEO_GOOGLE_TEST_BASE_URL=http://127.0.0.1:<port>` — never set it in production.
