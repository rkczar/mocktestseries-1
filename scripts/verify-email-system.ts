/**
 * Verification for the Email Communication System (lib/email/*).
 *
 * SAFETY: writes students, orders, settings and email rows, so it REFUSES to
 * run unless DATABASE_URL points at a scratch database whose name contains
 * "emailverify". Resend's REST API is replaced in-process by a fake, so no
 * email is ever sent:
 *
 *   sudo -u postgres createdb -O <app user> mts_emailverify
 *   DATABASE_URL=<scratch> npx prisma migrate deploy
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-email-system.ts
 *
 * Proves: sanitizer + variable escaping; idempotent enqueue; FIRST_LOGIN
 * exactly once (concurrent claims, backfilled accounts never); provider
 * NOT CONFIGURED → nothing sent, automatic email SKIPPED, test email refused,
 * campaign refused; production-sending gate; worker send/retry/backoff/
 * permanent failure/429 handling; Idempotency-Key + List-Unsubscribe headers;
 * stale SENDING rows recovered; campaign queue exactly once, opted-out and
 * suppressed students excluded, audience filters (paid/free/exam/selected);
 * cancel; payment email exactly once across duplicate verify/webhook calls;
 * webhook signature (valid / bad / stale / unconfigured) and monotonic
 * status + suppression; preferences token tamper-proof; one-click opt-out.
 */
import "dotenv/config";
import crypto from "node:crypto";

if (!/emailverify/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at an *emailverify* scratch database.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Fake Resend
// ---------------------------------------------------------------------------
type Mode = "ok" | "500" | "422" | "429";
const fakeResend = { mode: "ok" as Mode, calls: [] as { headers: Record<string, string>; body: Record<string, unknown> }[] };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://api.resend.com")) return realFetch(input, init);
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  if (url.endsWith("/domains")) {
    return new Response(JSON.stringify({ data: [{ name: "mocktestseries.in", status: "verified" }] }), { status: 200 });
  }
  const body = JSON.parse(String(init?.body ?? "{}"));
  fakeResend.calls.push({ headers, body });
  if (fakeResend.mode === "500") return new Response(JSON.stringify({ name: "internal_server_error", message: "boom" }), { status: 500 });
  if (fakeResend.mode === "422") return new Response(JSON.stringify({ name: "validation_error", message: "Invalid `to` field" }), { status: 422 });
  if (fakeResend.mode === "429") return new Response(JSON.stringify({ name: "rate_limit_exceeded", message: "Too many requests" }), { status: 429, headers: { "retry-after": "1" } });
  return new Response(JSON.stringify({ id: `re_msg_${crypto.randomBytes(6).toString("hex")}` }), { status: 200 });
}) as typeof fetch;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
async function expectThrow(name: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (e) {
    check(name, re.test(e instanceof Error ? e.message : String(e)), e instanceof Error ? e.message : e);
  }
}

async function main() {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_WEBHOOK_SECRET;
  const { prisma } = await import("../lib/prisma");
  const { sanitizeEmailHtml, normalizeEmailUrl } = await import("../lib/email/sanitize");
  const { renderContent, TEMPLATE_DEFAULTS } = await import("../lib/email/templates");
  const { enqueueEmail, claimDueEmails, processClaimedEmail, runEmailWorkerBatch, releaseStaleLocks } = await import("../lib/email/queue");
  const { queueWelcomeEmail, queueFirstLoginEmail } = await import("../lib/email/events");
  const { saveEmailSettings, getEmailSettings } = await import("../lib/email/settings");
  const { getEmailEnvConfig } = await import("../lib/email/config");
  const admin = await import("../lib/email/admin");
  const { verifyResendSignature, handleResendEvent } = await import("../lib/email/webhook");
  const { preferencesToken, verifyPreferencesToken, setPromotionalOptOut } = await import("../lib/email/preferences");
  const { countAudience } = await import("../lib/email/audience");
  const { recordTrustedPayment } = await import("../lib/payments/orders");
  const noSleep = { sleep: async () => {} };

  const sfx = crypto.randomBytes(4).toString("hex");
  const mkStudent = (n: string, extra: Record<string, unknown> = {}) =>
    prisma.student.create({ data: { studentId: `EV-${sfx}-${n}`, name: `Student ${n}`, email: `${n}-${sfx}@example.com`, authProvider: "CREDENTIALS", ...extra } });
  const adminRole = await prisma.role.upsert({ where: { name: "MASTER_ADMIN" }, create: { name: "MASTER_ADMIN" }, update: {} });
  const adminUser = await prisma.adminUser.create({ data: { name: "Email Verifier", username: `ev-${sfx}`, passwordHash: "x", roleId: adminRole.id } });

  // ---- 1. Sanitizer & rendering --------------------------------------------
  const dirty = `<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://ok.example">ok</a><img src=x onerror=alert(1)><iframe src="https://evil"></iframe>`;
  const clean = sanitizeEmailHtml(dirty);
  check("sanitizer drops script/iframe/img/handlers/javascript: links", !/script|iframe|onerror|onclick|javascript:|<img/i.test(clean), clean);
  check("sanitizer keeps safe links with rel=noopener", /href="https:\/\/ok\.example"[^>]*rel="noopener noreferrer"/.test(clean), clean);
  const r = renderContent(
    { subject: "Hi {{studentName}}\r\nBcc: x", heading: "A <b> {{testName}}", bodyHtml: "<p>{{studentName}} {{process}} {{constructor}}</p>", ctaText: "Go", ctaUrl: "{{dashboardUrl}}" },
    { studentName: `<script>alert("x")</script>`, testName: "T&T", dashboardUrl: "https://mocktestseries.in/student/dashboard" }
  );
  check("variables are HTML-escaped in body", r.bodyHtml.includes("&lt;script&gt;") && !r.bodyHtml.includes("<script>"), r.bodyHtml);
  check("unknown / prototype variables render empty", !/process|constructor|function/.test(r.bodyHtml), r.bodyHtml);
  check("subject is single-line (no header injection)", !/[\r\n]/.test(r.subject), r.subject);
  check("heading escapes its own markup and values", r.heading === "A &lt;b&gt; T&amp;T", r.heading);
  check("URL variable resolves to https CTA", r.ctaUrl === "https://mocktestseries.in/student/dashboard", r.ctaUrl);
  check("javascript: CTA URL rejected", normalizeEmailUrl("javascript:alert(1)", "https://x.in") === null);
  check("site-relative CTA URL resolved", normalizeEmailUrl("/student/dashboard", "https://x.in") === "https://x.in/student/dashboard");
  check("every template key has a default", Object.keys(TEMPLATE_DEFAULTS).length === 9);

  // ---- 2. Idempotent enqueue + FIRST_LOGIN once ------------------------------
  const a = await mkStudent("a");
  await queueWelcomeEmail(a.id);
  await queueWelcomeEmail(a.id);
  check("WELCOME queued exactly once per student", (await prisma.emailDeliveryLog.count({ where: { idempotencyKey: `welcome:${a.id}` } })) === 1);
  await Promise.all([queueFirstLoginEmail(a.id), queueFirstLoginEmail(a.id), queueFirstLoginEmail(a.id)]);
  await queueFirstLoginEmail(a.id);
  check("FIRST_LOGIN queued exactly once under concurrent + repeated logins", (await prisma.emailDeliveryLog.count({ where: { studentId: a.id, templateKey: "FIRST_LOGIN" } })) === 1);
  check("firstLoginEmailAt flag set", (await prisma.student.findUniqueOrThrow({ where: { id: a.id } })).firstLoginEmailAt !== null);
  const legacy = await mkStudent("legacy", { firstLoginEmailAt: new Date("2026-01-01") });
  await queueFirstLoginEmail(legacy.id);
  check("pre-existing (backfilled) account never gets FIRST_LOGIN", (await prisma.emailDeliveryLog.count({ where: { studentId: legacy.id } })) === 0);
  const fl = await prisma.emailDeliveryLog.findFirstOrThrow({ where: { studentId: a.id, templateKey: "FIRST_LOGIN" } });
  check("FIRST_LOGIN scheduled as a follow-up (not immediate)", fl.nextAttemptAt.getTime() > Date.now() + 10 * 60_000);
  await prisma.emailDeliveryLog.update({ where: { id: fl.id }, data: { nextAttemptAt: new Date() } });

  // ---- 3. Provider NOT configured ------------------------------------------
  check("provider reports NOT CONFIGURED without key", getEmailEnvConfig().providerConfigured === false);
  const r0 = await runEmailWorkerBatch(noSleep);
  check("worker without key sends nothing", fakeResend.calls.length === 0 && r0.sent === 0, r0);
  const welcomeRow = await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `welcome:${a.id}` } });
  check("automatic email SKIPPED with 'Email provider not configured'", welcomeRow.status === "SKIPPED" && /not configured/i.test(welcomeRow.failureReason ?? ""), welcomeRow);
  await expectThrow("test email refused without key", () => admin.sendTestEmail("me@example.com", "WELCOME", adminUser.id), /not configured/i);
  const draft0 = await admin.saveCampaignDraft({ name: "N", templateKey: "CUSTOM", subject: "S", heading: "H", bodyHtml: "<p>B</p>", audience: "ALL" }, adminUser.id);
  await expectThrow("campaign refused without key", () => admin.queueCampaign(draft0.id, adminUser.id, 1), /not configured/i);

  // ---- 4. Key configured, sending OFF ---------------------------------------
  process.env.RESEND_API_KEY = "re_test_" + crypto.randomBytes(8).toString("hex");
  check("provider reports CONFIGURED with key", getEmailEnvConfig().providerConfigured === true);
  await saveEmailSettings({ sendingEnabled: false, ratePerSecond: 10 }, "verifier");
  const b = await mkStudent("b");
  await queueWelcomeEmail(b.id);
  await runEmailWorkerBatch(noSleep);
  const wb = await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `welcome:${b.id}` } });
  check("sending OFF: automatic email SKIPPED, not sent", wb.status === "SKIPPED" && /production sending is off/i.test(wb.failureReason ?? "") && fakeResend.calls.length === 0, wb);
  await expectThrow("sending OFF: campaign refused", () => admin.queueCampaign(draft0.id, adminUser.id, 1), /production sending is off/i);

  const test = await admin.sendTestEmail("Me@Example.com", "PAYMENT_SUCCESS", adminUser.id);
  check("test email works while sending is OFF (SENT + provider id)", test.status === "SENT" && Boolean(test.providerMessageId), test);
  const call = fakeResend.calls.at(-1)!;
  check("provider gets Idempotency-Key = row id", typeof call.headers["idempotency-key"] === "string" && call.headers["idempotency-key"].length > 10);
  check("provider never sees the API key in the body", !JSON.stringify(call.body).includes(process.env.RESEND_API_KEY!));
  check("from / reply_to set from config", call.body.from === "MockTestSeries <support@mocktestseries.in>" && call.body.reply_to === "support@mocktestseries.in", call.body);
  check("html + text parts present, footer has support address", String(call.body.html).includes("support@mocktestseries.in") && String(call.body.text).length > 20);

  // ---- 5. Sending ON: automatic emails, retries, failures ---------------------
  await saveEmailSettings({ sendingEnabled: true, ratePerSecond: 10 }, "verifier");
  const c = await mkStudent("c");
  await queueWelcomeEmail(c.id);
  fakeResend.mode = "500";
  await runEmailWorkerBatch(noSleep);
  let wc = await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `welcome:${c.id}` } });
  check("5xx → back to QUEUED with backoff", wc.status === "QUEUED" && wc.nextAttemptAt.getTime() > Date.now() + 20_000 && wc.attempts === 1, wc);
  fakeResend.mode = "ok";
  await prisma.emailDeliveryLog.update({ where: { id: wc.id }, data: { nextAttemptAt: new Date() } });
  await runEmailWorkerBatch(noSleep);
  wc = await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { id: wc.id } });
  check("retry succeeds → SENT", wc.status === "SENT" && wc.attempts === 2 && wc.sentAt !== null, wc);
  const sentCalls = fakeResend.calls.filter((x) => x.headers["idempotency-key"] === wc.id).length;
  check("retry reuses the same Idempotency-Key", sentCalls === 2, sentCalls);

  const d = await mkStudent("d");
  await queueWelcomeEmail(d.id);
  fakeResend.mode = "422";
  await runEmailWorkerBatch(noSleep);
  const wd = await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `welcome:${d.id}` } });
  check("4xx validation error → FAILED with reason", wd.status === "FAILED" && /422/.test(wd.failureReason ?? ""), wd);
  fakeResend.mode = "ok";
  await admin.retryFailedEmail(wd.id, adminUser.id);
  await runEmailWorkerBatch(noSleep);
  check("admin Retry re-sends a FAILED email", (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { id: wd.id } })).status === "SENT");

  const e1 = await mkStudent("e1");
  const e2 = await mkStudent("e2");
  await queueWelcomeEmail(e1.id);
  await queueWelcomeEmail(e2.id);
  fakeResend.mode = "429";
  const r429 = await runEmailWorkerBatch(noSleep);
  fakeResend.mode = "ok";
  const after429 = await prisma.emailDeliveryLog.findMany({ where: { studentId: { in: [e1.id, e2.id] } } });
  check("429 → batch stops, rows back to QUEUED, rate-limit reported", r429.rateLimitedFor === 1 && after429.every((x) => x.status === "QUEUED"), { r429, s: after429.map((x) => [x.status, x.attempts]) });
  await prisma.emailDeliveryLog.updateMany({ where: { studentId: { in: [e1.id, e2.id] } }, data: { nextAttemptAt: new Date() } });
  await runEmailWorkerBatch(noSleep);
  check("after 429 backoff both send", (await prisma.emailDeliveryLog.count({ where: { studentId: { in: [e1.id, e2.id] }, status: "SENT" } })) === 2);

  // Disabled template → skipped.
  await prisma.emailTemplate.create({ data: { key: "WELCOME", subject: "x", heading: "x", bodyHtml: "<p>x</p>", enabled: false } });
  const f = await mkStudent("f");
  await queueWelcomeEmail(f.id);
  await runEmailWorkerBatch(noSleep);
  check("disabled template → SKIPPED", (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `welcome:${f.id}` } })).status === "SKIPPED");
  await prisma.emailTemplate.deleteMany({ where: { key: "WELCOME" } });

  // No email address → skipped.
  const g = await prisma.student.create({ data: { studentId: `EV-${sfx}-g`, name: "No Email", mobile: `9${Date.now() % 1e9}`, authProvider: "OTP" } });
  await queueWelcomeEmail(g.id);
  await runEmailWorkerBatch(noSleep);
  check("student without email → SKIPPED", (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `welcome:${g.id}` } })).status === "SKIPPED");

  // Stale SENDING row (killed worker) is recovered.
  const h = await mkStudent("h");
  await enqueueEmail({ idempotencyKey: `stale:${h.id}`, templateKey: "WELCOME", studentId: h.id });
  const [claimed] = await claimDueEmails(1, { includeCampaigns: false, onlyId: (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `stale:${h.id}` } })).id });
  await prisma.emailDeliveryLog.update({ where: { id: claimed }, data: { lockedAt: new Date(Date.now() - 11 * 60_000) } });
  const again = await claimDueEmails(5, { includeCampaigns: false, onlyId: claimed });
  check("a SENDING row cannot be claimed twice", again.length === 0);
  await releaseStaleLocks();
  check("stale SENDING row returned to QUEUED", (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { id: claimed } })).status === "QUEUED");
  await runEmailWorkerBatch(noSleep);
  check("recovered row then sends", (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { id: claimed } })).status === "SENT");

  // Expired automatic email → skipped.
  const i = await mkStudent("i");
  await queueWelcomeEmail(i.id);
  await prisma.emailDeliveryLog.update({ where: { idempotencyKey: `welcome:${i.id}` }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
  await runEmailWorkerBatch(noSleep);
  check("automatic email older than 24h → SKIPPED (no late backlog)", (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `welcome:${i.id}` } })).status === "SKIPPED");

  // ---- 6. Payment email exactly once ---------------------------------------
  const exam = await prisma.exam.create({ data: { name: `Email Exam ${sfx}`, code: `EV${sfx}` } });
  const product = await prisma.product.create({
    data: { code: `ev-${sfx}`, name: "Email Verify Pack", productType: "EXAM_ACCESS", examId: exam.id, accessType: "PAID", mrpPaise: 49900, sellingPricePaise: 49900, accessDurationType: "LIFETIME" },
  });
  const buyer = await mkStudent("buyer");
  const order = await prisma.paymentOrder.create({
    data: {
      orderNumber: `ORD-EV-${sfx}`, receipt: `ORD-EV-${sfx}`, studentId: buyer.id, productId: product.id, status: "GATEWAY_ORDER_CREATED",
      gateway: "RAZORPAY", environment: "TEST", mrpPaise: 49900, sellingPricePaise: 49900, amountPaise: 49900,
      productSnapshot: { name: "Email Verify Pack", code: product.code }, gatewayOrderId: `order_ev_${sfx}`,
    },
  });
  const pay = { id: `pay_ev_${sfx}`, order_id: `order_ev_${sfx}`, amount: 49900, currency: "INR", status: "captured", method: "upi", amount_refunded: 0 };
  const outcomes = await Promise.all([
    recordTrustedPayment(order.id, pay as never, "CHECKOUT_SIGNATURE"),
    recordTrustedPayment(order.id, pay as never, "WEBHOOK"),
    recordTrustedPayment(order.id, pay as never, "RECONCILIATION"),
  ]);
  await recordTrustedPayment(order.id, pay as never, "WEBHOOK");
  check("one PAID outcome across concurrent verify/webhook/reconcile", outcomes.filter((o) => o === "PAID").length === 1, outcomes);
  const payRows = await prisma.emailDeliveryLog.findMany({ where: { studentId: buyer.id, templateKey: { in: ["PAYMENT_SUCCESS", "INVOICE"] } } });
  check("exactly one payment email queued for duplicate events", payRows.length === 1 && payRows[0].templateKey === "PAYMENT_SUCCESS", payRows.length);
  const vars = payRows[0].variables as Record<string, string>;
  check("payment email carries invoice no, amount and payment id", /\/\d{5}$/.test(vars.invoiceNumber) && vars.amount.includes("499") && vars.paymentId === pay.id, vars);
  const unpaidOrder = await prisma.paymentOrder.create({
    data: {
      orderNumber: `ORD-EV2-${sfx}`, receipt: `ORD-EV2-${sfx}`, studentId: buyer.id, productId: product.id, status: "GATEWAY_ORDER_CREATED",
      gateway: "RAZORPAY", environment: "TEST", mrpPaise: 49900, sellingPricePaise: 49900, amountPaise: 49900, productSnapshot: {}, gatewayOrderId: `order_ev2_${sfx}`,
    },
  });
  await recordTrustedPayment(unpaidOrder.id, { ...pay, id: `pay_ev2_${sfx}`, order_id: `order_ev2_${sfx}`, status: "failed" } as never, "WEBHOOK");
  await recordTrustedPayment(unpaidOrder.id, { ...pay, id: `pay_ev3_${sfx}`, order_id: `order_ev2_${sfx}`, amount: 100 } as never, "WEBHOOK");
  check("failed / mismatched payments queue no email", (await prisma.emailDeliveryLog.count({ where: { idempotencyKey: `payment:${unpaidOrder.id}` } })) === 0);
  await prisma.emailDeliveryLog.update({ where: { id: payRows[0].id }, data: { nextAttemptAt: new Date() } });
  await runEmailWorkerBatch(noSleep);
  const sentPay = await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { id: payRows[0].id } });
  check("payment email sends with rendered subject", sentPay.status === "SENT" && sentPay.subject === "Payment received: Email Verify Pack", sentPay.subject);

  // ---- 7. Campaigns ---------------------------------------------------------
  // Clean audience: drop the earlier fixtures to a known set.
  await prisma.student.updateMany({ where: { studentId: { startsWith: `EV-${sfx}` } }, data: { status: "SUSPENDED" } });
  const p1 = await mkStudent("p1");
  const p2 = await mkStudent("p2");
  const p3 = await mkStudent("p3");
  const optedOut = await mkStudent("optout");
  const bounced = await mkStudent("bounced");
  await prisma.student.updateMany({ where: { status: "ACTIVE", NOT: { studentId: { startsWith: `EV-${sfx}` } } }, data: { status: "SUSPENDED" } });
  await setPromotionalOptOut(optedOut.id, true, "verify");
  await prisma.emailPreference.create({ data: { studentId: bounced.id, suppressedAt: new Date(), suppressionReason: "Hard bounce" } });
  await prisma.studentEntitlement.create({ data: { studentId: p1.id, productId: product.id, source: "PURCHASE", startsAt: new Date(Date.now() - 1000) } });
  await prisma.studentExamEnrollment.create({ data: { studentId: p2.id, examId: exam.id } });

  const all = await countAudience({ audience: "ALL" });
  check("ALL: 5 active with email, 2 excluded (opted out + suppressed)", all.matching === 5 && all.sendable === 3 && all.excluded === 2, all);
  check("PAID audience = active paid entitlement", (await countAudience({ audience: "PAID" })).sendable === 1);
  check("FREE audience = the rest", (await countAudience({ audience: "FREE" })).sendable === 2);
  check("EXAM audience = enrolled students", (await countAudience({ audience: "EXAM", examId: exam.id })).sendable === 1);
  check("SELECTED audience honours opt-out", (await countAudience({ audience: "SELECTED", studentIds: [p3.id, optedOut.id] })).sendable === 1);

  await expectThrow("campaign rejects body with only script", () => admin.saveCampaignDraft({ name: "x", templateKey: "CUSTOM", subject: "S", heading: "", bodyHtml: "<script>x</script>", audience: "ALL" }, adminUser.id), /body is required/i);
  await expectThrow("campaign rejects javascript: CTA", () => admin.saveCampaignDraft({ name: "x", templateKey: "CUSTOM", subject: "S", heading: "", bodyHtml: "<p>b</p>", ctaText: "Go", ctaUrl: "javascript:alert(1)", audience: "ALL" }, adminUser.id), /button url/i);
  const camp = await admin.saveCampaignDraft(
    { name: "Launch", templateKey: "GENERAL_ANNOUNCEMENT", subject: "News for {{studentName}}", heading: "Hello", bodyHtml: "<p>Hi {{studentName}}</p><script>x</script>", ctaText: "Open", ctaUrl: "/student/dashboard", audience: "ALL" },
    adminUser.id
  );
  check("draft body sanitized at save", !camp.bodyHtml.includes("script") && camp.ctaUrl?.endsWith("/student/dashboard") === true, camp.bodyHtml);
  await expectThrow("stale recipient count is refused", () => admin.queueCampaign(camp.id, adminUser.id, 99), /changed to 3/);
  const results = await Promise.allSettled([admin.queueCampaign(camp.id, adminUser.id, 3), admin.queueCampaign(camp.id, adminUser.id, 3)]);
  check("double-submit queues the campaign exactly once", results.filter((x) => x.status === "fulfilled").length === 1, results.map((x) => x.status));
  check("one row per sendable recipient", (await prisma.emailDeliveryLog.count({ where: { campaignId: camp.id } })) === 3);
  await expectThrow("re-queue after send refused", () => admin.queueCampaign(camp.id, adminUser.id, 3), /already been queued/i);
  await expectThrow("sent campaign can't be edited", () => admin.saveCampaignDraft({ name: "x", templateKey: "CUSTOM", subject: "S", heading: "", bodyHtml: "<p>b</p>", audience: "ALL" }, adminUser.id, camp.id), /only draft/i);

  // Pause when sending is turned off mid-campaign.
  await saveEmailSettings({ sendingEnabled: false, ratePerSecond: 10 }, "verifier");
  const before = fakeResend.calls.length;
  await runEmailWorkerBatch(noSleep);
  check("sending OFF pauses campaign (rows stay QUEUED)", fakeResend.calls.length === before && (await prisma.emailDeliveryLog.count({ where: { campaignId: camp.id, status: "QUEUED" } })) === 3);
  await saveEmailSettings({ sendingEnabled: true, ratePerSecond: 10 }, "verifier");
  await runEmailWorkerBatch(noSleep);
  const campRows = await prisma.emailDeliveryLog.findMany({ where: { campaignId: camp.id } });
  check("campaign rows SENT after resume", campRows.every((x) => x.status === "SENT"), campRows.map((x) => x.status));
  check("campaign COMPLETED when all rows finished", (await prisma.emailCampaign.findUniqueOrThrow({ where: { id: camp.id } })).status === "COMPLETED");
  const promoCall = fakeResend.calls.at(-1)!;
  const hdrs = (promoCall.body.headers ?? {}) as Record<string, string>;
  check("promotional email has List-Unsubscribe one-click headers", /api\/email\/unsubscribe\?token=/.test(hdrs["List-Unsubscribe"] ?? "") && hdrs["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click", hdrs);
  check("promotional footer has unsubscribe link", String(promoCall.body.html).includes("Unsubscribe or manage email preferences"));
  check("campaign subject rendered per student", campRows.some((x) => x.subject === `News for ${p1.name}`), campRows.map((x) => x.subject));
  const listed = (await admin.listCampaigns()).find((x) => x.id === camp.id)!;
  check("campaign stats total/sent", listed.stats.total === 3 && listed.stats.sent === 3, listed.stats);

  // Cancel.
  const camp2 = await admin.saveCampaignDraft({ name: "C2", templateKey: "CUSTOM", subject: "S2", heading: "", bodyHtml: "<p>b</p>", audience: "ALL" }, adminUser.id);
  await saveEmailSettings({ sendingEnabled: false, ratePerSecond: 10 }, "verifier");
  await expectThrow("cannot queue while OFF", () => admin.queueCampaign(camp2.id, adminUser.id, 3), /off/i);
  await saveEmailSettings({ sendingEnabled: true, ratePerSecond: 10 }, "verifier");
  await admin.queueCampaign(camp2.id, adminUser.id, 3);
  await admin.cancelCampaign(camp2.id, adminUser.id);
  check("cancel marks queued rows CANCELLED", (await prisma.emailDeliveryLog.count({ where: { campaignId: camp2.id, status: "CANCELLED" } })) === 3);
  check("audit log for queue + cancel", (await prisma.auditLog.count({ where: { entityId: camp2.id, action: { in: ["EMAIL_CAMPAIGN_QUEUED", "EMAIL_CAMPAIGN_CANCELLED"] } } })) === 2);

  // Critical email still reaches an opted-out student; promo doesn't.
  await enqueueEmail({ idempotencyKey: `pw:${optedOut.id}`, templateKey: "PASSWORD_RESET", studentId: optedOut.id });
  await enqueueEmail({ idempotencyKey: `promo:${optedOut.id}`, templateKey: "GENERAL_ANNOUNCEMENT", studentId: optedOut.id });
  await runEmailWorkerBatch(noSleep);
  check("opted-out student still gets PASSWORD_RESET", (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `pw:${optedOut.id}` } })).status === "SENT");
  check("opted-out student does not get promotional email", (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `promo:${optedOut.id}` } })).status === "SKIPPED");
  await enqueueEmail({ idempotencyKey: `pw:${bounced.id}`, templateKey: "PASSWORD_RESET", studentId: bounced.id });
  await runEmailWorkerBatch(noSleep);
  check("hard-bounced address gets nothing (even critical)", (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `pw:${bounced.id}` } })).status === "SKIPPED");

  // ---- 8. Webhook ------------------------------------------------------------
  const target = campRows[0];
  const body = JSON.stringify({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: target.providerMessageId } });
  const now = Math.floor(Date.now() / 1000);
  const hdr = (h: Record<string, string>) => new Headers(h);
  check("webhook disabled (503) without secret", (() => { const v = verifyResendSignature(body, hdr({})); return !v.ok && v.status === 503; })());
  const keyBytes = crypto.randomBytes(24);
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${keyBytes.toString("base64")}`;
  const sign = (id: string, ts: number, raw: string) => `v1,${crypto.createHmac("sha256", keyBytes).update(`${id}.${ts}.${raw}`).digest("base64")}`;
  check("valid signature accepted", verifyResendSignature(body, hdr({ "svix-id": "msg_1", "svix-timestamp": String(now), "svix-signature": `v1,AAAA ${sign("msg_1", now, body)}` })).ok);
  check("tampered body rejected", !verifyResendSignature(body + " ", hdr({ "svix-id": "msg_1", "svix-timestamp": String(now), "svix-signature": sign("msg_1", now, body) })).ok);
  check("stale timestamp rejected", !verifyResendSignature(body, hdr({ "svix-id": "msg_1", "svix-timestamp": String(now - 3600), "svix-signature": sign("msg_1", now - 3600, body) })).ok);
  check("missing headers rejected", !verifyResendSignature(body, hdr({})).ok);
  await handleResendEvent(body);
  check("delivered event → DELIVERED", (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { id: target.id } })).status === "DELIVERED");
  await handleResendEvent(JSON.stringify({ type: "email.bounced", data: { email_id: target.providerMessageId, bounce: { type: "Permanent", subType: "General", message: "mailbox does not exist" } } }));
  await handleResendEvent(body); // replayed "delivered" after the bounce
  const bouncedRow = await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { id: target.id } });
  check("bounce wins over a replayed delivered (monotonic)", bouncedRow.status === "BOUNCED" && /Permanent/.test(bouncedRow.failureReason ?? ""), bouncedRow.status);
  check("hard bounce suppresses the address", (await prisma.emailPreference.findUniqueOrThrow({ where: { studentId: target.studentId! } })).suppressionReason === "Hard bounce");
  await handleResendEvent(JSON.stringify({ type: "email.complained", data: { email_id: campRows[1].providerMessageId } }));
  const compPref = await prisma.emailPreference.findUniqueOrThrow({ where: { studentId: campRows[1].studentId! } });
  check("complaint → COMPLAINED + opted out of promotional", compPref.promotionalOptOut && (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { id: campRows[1].id } })).status === "COMPLAINED");
  check("unknown email id ignored safely", (await handleResendEvent(JSON.stringify({ type: "email.delivered", data: { email_id: "nope" } }))).handled === false);

  // ---- 9. Preferences token --------------------------------------------------
  const tok = preferencesToken(p3.id);
  check("preferences token round-trips", verifyPreferencesToken(tok) === p3.id);
  check("tampered token rejected", verifyPreferencesToken(tok.slice(0, -2) + (tok.endsWith("A") ? "BB" : "AA")) === null);
  check("token for another id with same signature rejected", verifyPreferencesToken(`${Buffer.from(p2.id).toString("base64url")}.${tok.split(".")[1]}`) === null);
  await enqueueEmail({ idempotencyKey: `promo2:${p3.id}`, templateKey: "GENERAL_ANNOUNCEMENT", studentId: p3.id, notBefore: new Date(Date.now() + 3600_000) });
  await setPromotionalOptOut(p3.id, true, "verify");
  check("unsubscribing skips already-queued promotional mail", (await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `promo2:${p3.id}` } })).status === "SKIPPED");

  // ---- 10. Settings / provider check ----------------------------------------
  check("settings persisted", (await getEmailSettings()).sendingEnabled === true);
  const { getEmailProvider } = await import("../lib/email/provider");
  check("connection check (fake) reports domain", (await getEmailProvider().checkConnection()).message.includes("mocktestseries.in"));

  // Single test email via the queue path is logged and counted.
  check("test emails are logged with isTest", (await prisma.emailDeliveryLog.count({ where: { isTest: true, status: "SENT" } })) >= 1);
  await processClaimedEmail("does-not-exist");

  await prisma.$disconnect();
  console.log(failures === 0 ? "\nALL EMAIL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
