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
| `seo.intel.settings` | daily sync on/off (default OFF), history retention days (default 400, 30–1095), PageSpeed pages (1–3 same-site paths) |
| `seo.pagespeed.key` | PageSpeed Insights / CrUX API key (AES-256-GCM); admins only ever see an 8-char fingerprint |
| `seo.intel.pagespeed` | latest PageSpeed results (per page, mobile + desktop) + origin Chrome UX Report data |
| `seo.intel.psi-lock` | transient; one PageSpeed check at a time |
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

## PageSpeed Insights + Core Web Vitals

Lab test (Lighthouse performance score, LCP, CLS, TBT) for up to 3 of this site's pages on mobile and
desktop, plus real-user Chrome UX Report data (75th percentile LCP, INP, CLS, FCP, TTFB) for the whole
origin. Ratings use the web.dev Core Web Vitals thresholds and are always written as text.

- Uses its own **API key** (not the OAuth connection). In Google Cloud restrict it to
  *APIs: PageSpeed Insights API + Chrome UX Report API* and *Application: IP addresses* = this server's
  public IP. Never put it in `.env`, a URL, a ticket or chat.
- The app sends the key only in the `X-goog-api-key` header; `googleFetch` refuses any URL containing
  `key=` and any PageSpeed target outside `https://mocktestseries.in/`. `/admin`, `/api`, `/student`
  paths are refused as PageSpeed pages.
- A run sends all calls in parallel with a 45 s cap each (nginx allows 60 s); at most one run per
  2 minutes; Master Admin only (**Run PageSpeed check**); every admin role can view and download CSV.
- Google having too little Chrome user data (CrUX 404) is shown as "not enough data", not as an error.

Install / check / remove the key (hidden prompt; nothing is echoed or logged):

```bash
sudo /var/www/mocktestseries-current/ops/seo/set-pagespeed-key.sh          # paste at the hidden prompt
sudo /var/www/mocktestseries-current/ops/seo/set-pagespeed-key.sh status   # fingerprint + last check only
sudo /var/www/mocktestseries-current/ops/seo/set-pagespeed-key.sh clear
```

To rotate: create the new key in Cloud Console, run the script with it, check the fingerprint changed, then
delete the old key in Cloud Console.

## Daily automatic sync (optional)

1. Admin → SEO → Intelligence → Schedule & Retention → tick **Daily automatic sync** → Save.
2. Install the scheduler once (root):
   ```bash
   sudo install -m 644 /var/www/mocktestseries-current/ops/seo/mocktestseries-seo-intel.cron /etc/cron.d/mocktestseries-seo-intel
   ```
   Runs 21:40 UTC (03:10 IST). Log: `/var/log/mocktestseries/seo-intel-sync.log` (status lines only).
   It skips itself while the switch is OFF. Its Google part skips while Google is not connected or the
   connection needs a reconnect; its PageSpeed part skips while no API key is installed (the two run
   independently). Remove with `sudo rm /etc/cron.d/mocktestseries-seo-intel`.

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
| PageSpeed INVALID_ARGUMENT "API key not valid" | Wrong key, or the key's API restriction lacks PageSpeed Insights / CrUX → fix, re-run `set-pagespeed-key.sh` |
| PageSpeed PERMISSION_DENIED / "requests from this IP" | The key's IP restriction doesn't include this server's public IP |
| PageSpeed RESOURCE_EXHAUSTED | Daily quota reached; try tomorrow or raise the quota in Cloud Console |
| "Google did not answer in time" | PageSpeed took > 45 s for that page; run again later |

## Tests (scratch DB + mock Google only)

`scripts/verify-seo-intel.ts` (unit + history/retention) and `scripts/verify-seo-intel-http.mjs`
(end to end against `scripts/mock-google-seo.mjs`, which revokes grant-wide like Google). The app talks to
the mock only when `SEO_GOOGLE_TEST_BASE_URL=http://127.0.0.1:<port>` — never set it in production.
