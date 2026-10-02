# Email Communication System

Admin → Communications → **Email** (Compose · Templates · Campaigns · Email Logs · Settings).

## How it works

- **One provider abstraction**: `lib/email/provider.ts` (`EmailProvider` → `ResendProvider`, plain REST, no SDK).
  App code never calls it; it queues through `lib/email/events.ts` / `lib/email/queue.ts`.
- **Queue = PostgreSQL** (`EmailDeliveryLog`). Each email is one row with a UNIQUE `idempotencyKey`
  (`welcome:<student>`, `first-login:<student>`, `payment:<order>`, `invoice:<invoice>`,
  `campaign:<campaign>:<student>`, …), so duplicate events can't queue twice.
- **Worker**: `scripts/email-worker.ts`, run every minute by cron (`ops/email/mocktestseries-email.cron` →
  `/etc/cron.d/mocktestseries-email`), `flock`-guarded (one worker at a time), ~55 s per run, rate set in
  Settings (default 2/s). Rows are claimed with `FOR UPDATE SKIP LOCKED`; a killed worker's `SENDING` rows go
  back to the queue after 10 min, and Resend's `Idempotency-Key` (= row id) prevents a second delivery.
  Retries: 30 s, 2 min, 10 min, 30 min, 2 h, then `FAILED`. A 429 pauses the batch for `Retry-After`.
- **Gates** (worker): no `RESEND_API_KEY` → automatic email `SKIPPED`; production sending OFF → automatic email
  `SKIPPED`, campaigns paused; template disabled / no address / opted out / suppressed → `SKIPPED`;
  automatic email older than 24 h → `SKIPPED` (no late backlog).
- **Automatic events**: WELCOME (account creation: password, OTP, Google), FIRST_LOGIN (once ever, atomic
  claim on `Student.firstLoginEmailAt`, sent 15 min after the first sign-in; pre-email accounts were
  backfilled and never get it), FORGOT_PASSWORD (notice; the code stays SMS), PASSWORD_RESET (password
  changed), PAYMENT_SUCCESS (queued inside the same transaction that marks a server-verified order PAID),
  INVOICE (invoice issued later by an admin fulfilment repair). Nothing for ₹0 coupon orders.
- **Preferences**: campaigns/announcements are PROMOTIONAL and honour the opt-out. Account, password and payment
  email is TRANSACTIONAL. Signed link `/email/preferences?token=…`, RFC 8058 one-click
  `POST /api/email/unsubscribe?token=…`. A hard bounce suppresses everything; a complaint suppresses all
  non-critical email.
- **Webhook**: `POST /api/webhooks/resend` (Svix signature, 5 min tolerance). Disabled (503) until
  `RESEND_WEBHOOK_SECRET` is set.
- **RBAC**: reading the tabs = `COMMUNICATIONS_VIEW`; every change = `EMAIL_MANAGE` (MASTER_ADMIN only).

## Environment (shared `.env`)

```
RESEND_API_KEY=                 # blank = provider NOT CONFIGURED (app still runs)
EMAIL_FROM="MockTestSeries <support@mocktestseries.in>"
EMAIL_REPLY_TO="support@mocktestseries.in"
RESEND_WEBHOOK_SECRET=          # optional, whsec_… from Resend → Webhooks
```

## Go-live (after the Resend domain is verified)

1. Resend → API Keys → create a key (Sending access, domain mocktestseries.in).
2. Add `RESEND_API_KEY=re_…` to `/var/www/mocktestseries-shared/.env` (never commit it).
3. `pm2 reload mocktestseries` (the cron worker reads `.env` on its next run).
4. Admin → Communications → Email → Settings: Provider status = CONFIGURED, Queue worker = RUNNING,
   **Check connection**, then **Send test email** to your own inbox.
5. Confirm it arrived (check spam, and that SPF/DKIM pass in "Show original").
6. Turn **Production sending** ON.

Optional: Resend → Webhooks → `https://mocktestseries.in/api/webhooks/resend` with email.delivered,
email.bounced, email.complained, email.failed. Put its signing secret in `RESEND_WEBHOOK_SECRET` and reload.

## Verify

`scripts/verify-email-system.ts` (scratch DB whose name contains `emailverify`; Resend is faked in-process).
