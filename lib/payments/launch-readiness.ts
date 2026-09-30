import "server-only";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { EntitlementStatus, PaymentStatus, WebhookEventStatus, type PaymentEnvironment } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRazorpayConfig, type RazorpayPublicConfig } from "@/lib/razorpay-config";
import {
  composeSellerAddress,
  getInvoiceSettings,
  getPaymentMode,
  getPaymentPolicy,
  getVerificationStudentIds,
  GSTIN_RE,
  type InvoiceSettings,
  type PaymentMode,
} from "@/lib/payments/settings";
import { PATTERNS, PRODUCTION_ROOTS } from "@/lib/backup/roots";
import { describeAccessDuration } from "@/lib/payments/pricing";
import { formatInr } from "@/lib/payments/money";
import { isPurchasable, PRODUCT_SELECT } from "@/lib/payments/access";
import { findPaymentMismatches } from "@/lib/payments/reconcile";
import { getLegalReadiness, type LegalReadiness } from "@/lib/legal-readiness";
import { loadCoverageProducts, summarizeCoverage } from "@/lib/test-series-assignment";

/**
 * Live Launch Readiness — computed on every request from REAL configuration
 * and records (gateway slots, webhook events, payments, entitlements,
 * invoices, products, legal pages, series coverage). Nothing is a stored
 * "PASS" flag, so a status can never be claimed without evidence.
 *
 * Critical technical items (LIVE keys, LIVE webhook secret, a successful
 * LIVE connection test since the keys last changed) BLOCK switching the
 * gateway to LIVE. Business/legal items that are not PASS must be explicitly
 * acknowledged by a Master Admin when switching (see saveGatewayModeAction).
 */

export type ReadinessStatus = "PASS" | "ACTION_REQUIRED" | "NOT_CONFIGURED";
export type ReadinessGroupKey = "TEST" | "LIVE" | "PRODUCT" | "INVOICE" | "LEGAL" | "WEBHOOK" | "COVERAGE" | "OPERATIONS";

export interface ReadinessItem {
  label: string;
  status: ReadinessStatus;
  detail: string;
}

export interface ReadinessGroup {
  key: ReadinessGroupKey;
  title: string;
  status: ReadinessStatus;
  items: ReadinessItem[];
}

export interface ChecklistStep {
  n: number;
  label: string;
  done: boolean;
  evidence: string;
}

export type FinalState = "NOT_READY" | "READY_FOR_CONTROLLED_LIVE_TEST" | "LIVE_UNVERIFIED" | "PRODUCTION_VERIFIED";

export const FINAL_STATE_LABELS: Record<FinalState, string> = {
  NOT_READY: "Not ready for LIVE",
  READY_FOR_CONTROLLED_LIVE_TEST: "Ready for controlled LIVE test",
  LIVE_UNVERIFIED: "LIVE active — controlled LIVE payment not yet verified",
  PRODUCTION_VERIFIED: "Production payments fully verified",
};

export interface E2EEvidence {
  orderNumber: string;
  paidAt: Date | null;
  paymentIdMasked: string;
  webhookEvents: string[];
  webhookAt: Date | null;
  entitlement: boolean;
  entitlementActive: boolean;
  invoiceNumber: string | null;
}

export interface LaunchReadiness {
  environment: "TEST" | "LIVE";
  mode: PaymentMode;
  groups: ReadinessGroup[];
  /** Critical technical requirements missing — switching to LIVE is refused. */
  liveBlockers: string[];
  /** Non-PASS business/legal/product items — switching to LIVE needs explicit acknowledgement. */
  acknowledgementsRequired: string[];
  checklist: ChecklistStep[];
  finalState: FinalState;
  testE2E: E2EEvidence | null;
  liveE2E: E2EEvidence | null;
  refundAccessPolicy: "REVOKE_IMMEDIATELY" | "RETAIN";
}

const worst = (items: ReadinessItem[]): ReadinessStatus =>
  items.some((i) => i.status === "ACTION_REQUIRED") ? "ACTION_REQUIRED" : items.some((i) => i.status === "NOT_CONFIGURED") ? "NOT_CONFIGURED" : "PASS";

const item = (label: string, ok: boolean, detail: string, missing: ReadinessStatus = "ACTION_REQUIRED"): ReadinessItem => ({
  label,
  status: ok ? "PASS" : missing,
  detail,
});

const maskId = (s: string) => (s.length > 10 ? `${s.slice(0, 7)}…${s.slice(-4)}` : s);

const fmt = (d: Date | null | undefined) =>
  d ? d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " IST" : "—";

/**
 * Latest paid order of `environment` whose payment was captured AND for which
 * a signature-verified Razorpay webhook (payment.captured / order.paid) was
 * processed — i.e. the full gateway → webhook → fulfilment chain ran.
 */
async function latestE2E(environment: PaymentEnvironment): Promise<E2EEvidence | null> {
  const payments = await prisma.payment.findMany({
    where: { environment, status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED] } },
    orderBy: { capturedAt: "desc" },
    take: 20,
    select: { gatewayPaymentId: true, orderId: true, order: { select: { orderNumber: true, paidAt: true, entitlement: { select: { status: true, expiresAt: true } }, invoice: { select: { invoiceNumber: true } } } } },
  });
  if (payments.length === 0) return null;
  const events = await prisma.paymentWebhookEvent.findMany({
    where: { environment, status: WebhookEventStatus.PROCESSED, orderId: { in: payments.map((p) => p.orderId) }, eventType: { in: ["payment.captured", "order.paid"] } },
    orderBy: { receivedAt: "asc" },
    select: { orderId: true, eventType: true, receivedAt: true },
  });
  const now = new Date();
  for (const p of payments) {
    const ev = events.filter((e) => e.orderId === p.orderId);
    if (ev.length === 0) continue;
    const ent = p.order.entitlement;
    return {
      orderNumber: p.order.orderNumber,
      paidAt: p.order.paidAt,
      paymentIdMasked: maskId(p.gatewayPaymentId),
      webhookEvents: [...new Set(ev.map((e) => e.eventType))],
      webhookAt: ev[0].receivedAt,
      entitlement: Boolean(ent),
      entitlementActive: Boolean(ent && ent.status === EntitlementStatus.ACTIVE && (!ent.expiresAt || ent.expiresAt > now)),
      invoiceNumber: p.order.invoice?.invoiceNumber ?? null,
    };
  }
  return null;
}

function testGroup(rzp: RazorpayPublicConfig, latestTestWebhook: Date | null, e2e: E2EEvidence | null): ReadinessGroup {
  const t = rzp.test;
  const items = [
    item("TEST credentials", t.configured, t.configured ? `Key ID ${t.keyIdMasked}, secret stored (encrypted)` : "Save a TEST Key ID and Key Secret", "NOT_CONFIGURED"),
    item(
      "TEST connection",
      Boolean(t.lastTest?.ok),
      t.lastTest ? `${t.lastTest.ok ? "Passed" : "Failed"} ${fmt(new Date(t.lastTest.at))} — ${t.lastTest.message}` : "Not tested since the TEST credentials last changed — run Test connection"
    ),
    item("TEST webhook secret", t.webhookSecretConfigured, t.webhookSecretConfigured ? "Stored (encrypted)" : "Save the TEST webhook secret", "NOT_CONFIGURED"),
    item("Latest TEST webhook received", Boolean(latestTestWebhook), latestTestWebhook ? `Signed & processed ${fmt(latestTestWebhook)}` : "No signed TEST webhook has been processed yet"),
    item(
      "TEST end-to-end payment",
      Boolean(e2e && e2e.entitlement && e2e.invoiceNumber),
      e2e
        ? `${e2e.orderNumber} · ${e2e.paymentIdMasked} · webhook ${e2e.webhookEvents.join(", ")} · entitlement ${e2e.entitlement ? "granted" : "missing"} · invoice ${e2e.invoiceNumber ?? "missing"}`
        : "No TEST payment has been fulfilled through a signed Razorpay webhook yet"
    ),
  ];
  return { key: "TEST", title: "TEST Gateway", status: worst(items), items };
}

function liveGroup(rzp: RazorpayPublicConfig, liveWebhook: Date | null, e2e: E2EEvidence | null): ReadinessGroup {
  const l = rzp.live;
  const items = [
    item("LIVE Key ID", l.keyIdConfigured, l.keyIdConfigured ? `Configured (${l.keyIdMasked})` : "Not configured", "NOT_CONFIGURED"),
    item("LIVE Key Secret", l.keySecretConfigured, l.keySecretConfigured ? "Stored (encrypted)" : "Not configured", "NOT_CONFIGURED"),
    item("LIVE Webhook Secret", l.webhookSecretConfigured, l.webhookSecretConfigured ? "Stored (encrypted)" : "Not configured", "NOT_CONFIGURED"),
    { label: "Gateway environment", status: "PASS" as const, detail: rzp.environment === "LIVE" ? "LIVE — real money" : "TEST — LIVE is not active" },
    item(
      "LIVE connection tested",
      Boolean(l.lastTest?.ok),
      l.lastTest ? `${l.lastTest.ok ? "Passed" : "Failed"} ${fmt(new Date(l.lastTest.at))}` : l.configured ? "Not tested — use Test LIVE connection (read-only, stays in TEST)" : "Needs LIVE keys first",
      l.configured ? "ACTION_REQUIRED" : "NOT_CONFIGURED"
    ),
    item("LIVE webhook delivery verified", Boolean(liveWebhook), liveWebhook ? `Signed LIVE webhook processed ${fmt(liveWebhook)}` : "No signed LIVE webhook received yet", "NOT_CONFIGURED"),
    item(
      "Controlled LIVE payment verified",
      Boolean(e2e && e2e.entitlement && e2e.invoiceNumber),
      e2e ? `${e2e.orderNumber} · ${e2e.paymentIdMasked} · invoice ${e2e.invoiceNumber ?? "missing"}` : "No LIVE payment fulfilled through a signed webhook yet",
      "NOT_CONFIGURED"
    ),
  ];
  return { key: "LIVE", title: "LIVE Gateway", status: worst(items), items };
}

/**
 * FREE is a safe state for the controlled LIVE purchase as long as a payment
 * verification account exists to make it (everyone else stays free). PAID is
 * the general-sale state. MAINTENANCE blocks new purchases.
 */
function modeItem(mode: PaymentMode, verificationAccounts: number): ReadinessItem {
  if (mode === "PAID") return item("Payment mode", true, "PAID — pricing and entitlements apply to every student");
  if (mode === "MAINTENANCE") return item("Payment mode", false, "MAINTENANCE — new purchases are paused");
  return item(
    "Payment mode",
    verificationAccounts > 0,
    verificationAccounts > 0
      ? `FREE — all students keep free access; ${verificationAccounts} payment verification account(s) see PAID behaviour for the controlled purchase`
      : "FREE — all students keep free access. Add a payment verification account (Settings) to make the controlled LIVE purchase, or set PAID for general sale"
  );
}

async function productGroup(mode: PaymentMode, verificationAccounts: number, rzp: RazorpayPublicConfig, now: Date): Promise<ReadinessGroup> {
  const products = await prisma.product.findMany({
    where: { accessType: "PAID", isActive: true },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    select: { ...PRODUCT_SELECT, sellingPricePaise: true, mrpPaise: true, accessDays: true, testSeries: { select: { name: true, status: true } } },
  });
  const items: ReadinessItem[] = [
    modeItem(mode, verificationAccounts),
    item("Gateway", rzp.enabled && rzp.configured, `${rzp.environment} · ${rzp.enabled ? "enabled" : "disabled"}${rzp.configured ? "" : " · active slot not configured"}`),
  ];
  if (products.length === 0) items.push({ label: "Paid products", status: "NOT_CONFIGURED", detail: "No active PAID product" });
  for (const p of products) {
    const durationOk = p.accessDurationType === "LIFETIME" || (p.accessDurationType === "DAYS" ? (p.accessDays ?? 0) > 0 : Boolean(p.accessExpiresAt && p.accessExpiresAt > now));
    const seriesOk = p.productType !== "TEST_SERIES" || p.testSeries?.status === "PUBLISHED";
    const ok = isPurchasable(p, now) && p.sellingPricePaise > 0 && p.mrpPaise >= p.sellingPricePaise && durationOk && seriesOk;
    const parts = [
      `${formatInr(p.sellingPricePaise)} (MRP ${formatInr(p.mrpPaise)})`,
      describeAccessDuration(p),
      p.purchaseEnabled ? "purchase enabled" : "purchase DISABLED",
      p.isVisible ? "visible" : "HIDDEN",
      p.productType === "TEST_SERIES" ? `series: ${p.testSeries ? `${p.testSeries.name} (${p.testSeries.status})` : "none linked"}` : p.productType,
    ];
    items.push(item(`Product · ${p.name}`, ok, parts.join(" · ")));
  }
  return { key: "PRODUCT", title: "Product", status: worst(items), items };
}

function invoiceGroup(inv: InvoiceSettings): ReadinessGroup {
  const address = composeSellerAddress(inv).trim();
  const gstAnswered = inv.gstRegistered !== null && inv.gstRegistered !== undefined;
  const items = [
    item("Seller / business legal name", Boolean(inv.legalName.trim()), inv.legalName.trim() || "Missing — enter the legal name to print on invoices"),
    item("Business address", Boolean(address), address ? address.replace(/\n/g, ", ") : "Missing"),
    item("Support email", Boolean(inv.supportEmail.trim()), inv.supportEmail.trim() || "Missing"),
    item("Support phone", Boolean(inv.supportPhone.trim()), inv.supportPhone.trim() || "Missing"),
    item("GST registration status", gstAnswered, gstAnswered ? (inv.gstRegistered ? "Registered (owner-confirmed)" : "Not registered (owner-confirmed)") : "Owner must confirm Yes or No — nothing is assumed"),
    item(
      "GSTIN",
      inv.gstRegistered === false || (inv.gstRegistered === true && GSTIN_RE.test(inv.gstin)),
      inv.gstRegistered === false ? "Not applicable" : inv.gstRegistered === true ? (inv.gstin ? `${inv.gstin.slice(0, 2)}…${inv.gstin.slice(-3)}` : "Missing") : "Depends on the GST registration answer"
    ),
    item(
      "Tax / GST mode",
      inv.taxMode === "NONE" || Boolean(inv.gstin),
      inv.taxMode === "NONE" ? "None — no tax lines printed" : `Prices include GST @ ${inv.taxRatePercent}% (${inv.taxSplit === "CGST_SGST" ? "CGST + SGST" : "IGST"})`
    ),
    item("Invoice prefix / numbering", Boolean(inv.invoicePrefix), `${inv.invoicePrefix}/<FY>/00001 (LIVE) · TEST-${inv.invoicePrefix}/<FY>/00001 (TEST)`),
    { label: "TEST / LIVE invoice distinction", status: "PASS" as const, detail: "TEST invoices use a separate TEST- number series and are marked TEST" },
  ];
  return { key: "INVOICE", title: "Invoice", status: worst(items), items };
}

function legalGroup(legal: LegalReadiness, refundPolicy: string): ReadinessGroup {
  const items: ReadinessItem[] = legal.docs.map((d) => ({
    label: d.title,
    status: d.visible && !d.contentIssue && d.reviewed ? "PASS" : !d.hasContent ? "NOT_CONFIGURED" : "ACTION_REQUIRED",
    detail: !d.visible
      ? `Hidden (Admin → Website → Pages & Content) — ${d.path}`
      : d.contentIssue ?? (d.reviewed ? `Owner reviewed ${fmt(d.reviewedAt ? new Date(d.reviewedAt) : null)}` : "Owner review required"),
  }));
  const f = legal.footer;
  const missing = [f.terms ? null : "Terms", f.privacy ? null : "Privacy", f.refund ? null : "Refund & Cancellation Policy", f.contact ? null : "Contact"].filter(Boolean);
  items.push(
    item("Footer links", missing.length === 0, missing.length ? `${missing.join(", ")} missing from the footer` : "Terms, Privacy, Refund & Cancellation, Contact linked"),
    {
      label: "Refund access policy (default)",
      status: "PASS",
      detail: refundPolicy === "REVOKE_IMMEDIATELY" ? "Full refund revokes access immediately (per refund, adjustable)" : "Full refund keeps access (per refund, adjustable)",
    }
  );
  return { key: "LEGAL", title: "Legal", status: worst(items), items };
}

function webhookGroup(rzp: RazorpayPublicConfig, testAt: Date | null, liveAt: Date | null, failedRecent: number): ReadinessGroup {
  const items = [
    item("TEST webhook", Boolean(rzp.test.webhookSecretConfigured && testAt), testAt ? `Last signed TEST delivery ${fmt(testAt)}` : "No signed TEST delivery processed yet"),
    item("LIVE webhook", Boolean(rzp.live.webhookSecretConfigured && liveAt), liveAt ? `Last signed LIVE delivery ${fmt(liveAt)}` : rzp.live.webhookSecretConfigured ? "Secret stored — no LIVE delivery yet" : "LIVE webhook secret not configured", "NOT_CONFIGURED"),
    item("Failed webhook events (7 days)", failedRecent === 0, failedRecent === 0 ? "None" : `${failedRecent} failed — see Webhook Events`),
  ];
  return { key: "WEBHOOK", title: "Webhook", status: worst(items), items };
}

async function coverageGroup(now: Date): Promise<ReadinessGroup> {
  const products = await loadCoverageProducts(prisma);
  const paidExamIds = [...new Set(products.filter((p) => p.accessType === "PAID" && isPurchasable(p, now) && p.examId).map((p) => p.examId as string))];
  const items: ReadinessItem[] = [];
  for (const examId of paidExamIds) {
    const [exam, mocks] = await Promise.all([
      prisma.exam.findUnique({ where: { id: examId }, select: { name: true } }),
      prisma.mockTest.findMany({ where: { examId, status: "PUBLISHED" }, select: { id: true, title: true, examId: true, testSeriesId: true, accessType: true } }),
    ]);
    const s = summarizeCoverage(mocks, products, now);
    items.push(
      item(
        exam?.name ?? examId,
        s.uncoveredPaid === 0,
        `${s.total} published mocks · ${s.free} free · ${s.coveredPaid} covered paid · ${s.uncoveredPaid} uncovered paid` +
          (s.uncovered.length ? ` — review: ${s.uncovered.map((m) => m.title).join(", ")}` : "")
      )
    );
  }
  if (items.length === 0) items.push({ label: "Paid coverage", status: "NOT_CONFIGURED", detail: "No purchasable paid product yet" });
  return { key: "COVERAGE", title: "Test Series Coverage", status: worst(items), items };
}

/** Newest nightly pg_dump (non-empty, < 30 h old) and every on-disk migration applied. */
async function operationsGroup(now: Date): Promise<ReadinessGroup> {
  let latest: { name: string; size: number; mtime: Date } | null = null;
  for (const name of await readdir(PRODUCTION_ROOTS.nightlyDb).catch(() => [] as string[])) {
    if (!PATTERNS.nightlyDump.test(name)) continue;
    const st = await stat(path.join(PRODUCTION_ROOTS.nightlyDb, name)).catch(() => null);
    if (st && st.size > 0 && (!latest || st.mtime > latest.mtime)) latest = { name, size: st.size, mtime: st.mtime };
  }
  const fresh = Boolean(latest && now.getTime() - latest.mtime.getTime() < 30 * 3600_000);

  const onDisk = (await readdir(path.join(process.cwd(), "prisma", "migrations")).catch(() => [] as string[])).filter((n) => /^\d{14}_/.test(n));
  const applied = await prisma.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`.catch(
    () => null
  );
  const appliedSet = new Set((applied ?? []).map((r) => r.migration_name));
  const pending = onDisk.filter((n) => !appliedSet.has(n));

  const items = [
    item(
      "Latest database backup",
      fresh,
      latest ? `${latest.name} · ${(latest.size / 1_048_576).toFixed(1)} MB · ${fmt(latest.mtime)}${fresh ? "" : " — older than 30 hours"}` : "No nightly database dump found"
    ),
    item(
      "Database migrations",
      applied !== null && onDisk.length > 0 && pending.length === 0,
      applied === null ? "Could not read the migration history" : pending.length ? `${pending.length} pending: ${pending.join(", ")}` : `All ${onDisk.length} applied`
    ),
  ];
  return { key: "OPERATIONS", title: "Operations", status: worst(items), items };
}

export async function getLaunchReadiness(): Promise<LaunchReadiness> {
  const now = new Date();
  const [rzp, mode, verificationIds, inv, policy, legal, testE2E, liveE2E, testHook, liveHook, failedRecent] = await Promise.all([
    getRazorpayConfig(),
    getPaymentMode(),
    getVerificationStudentIds(),
    getInvoiceSettings(),
    getPaymentPolicy(),
    getLegalReadiness(),
    latestE2E("TEST"),
    latestE2E("LIVE"),
    prisma.paymentWebhookEvent.findFirst({ where: { environment: "TEST", status: WebhookEventStatus.PROCESSED }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } }),
    prisma.paymentWebhookEvent.findFirst({ where: { environment: "LIVE", status: WebhookEventStatus.PROCESSED }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } }),
    prisma.paymentWebhookEvent.count({ where: { status: WebhookEventStatus.FAILED, receivedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }),
  ]);
  const testAt = testHook?.receivedAt ?? null;
  const liveAt = liveHook?.receivedAt ?? null;

  const groups = [
    testGroup(rzp, testAt, testE2E),
    liveGroup(rzp, liveAt, liveE2E),
    await productGroup(mode, verificationIds.length, rzp, now),
    invoiceGroup(inv),
    legalGroup(legal, policy.refundAccessPolicy),
    webhookGroup(rzp, testAt, liveAt, failedRecent),
    await coverageGroup(now),
    await operationsGroup(now),
  ];
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g])) as Record<ReadinessGroupKey, ReadinessGroup>;

  const l = rzp.live;
  const liveBlockers = [
    l.keyIdConfigured ? null : "LIVE Key ID is not configured",
    l.keySecretConfigured ? null : "LIVE Key Secret is not configured",
    l.webhookSecretConfigured ? null : "LIVE Webhook Secret is not configured",
    l.lastTest?.ok ? null : "LIVE connection has not passed a test since the LIVE keys last changed",
  ].filter((x): x is string => Boolean(x));

  const acknowledgementsRequired = (["PRODUCT", "INVOICE", "LEGAL", "COVERAGE", "OPERATIONS"] as const).flatMap((k) =>
    byKey[k].items.filter((i) => i.status !== "PASS").map((i) => `${byKey[k].title}: ${i.label} — ${i.detail}`)
  );
  if (!testE2E) acknowledgementsRequired.push("TEST Gateway: no TEST payment fulfilled through a signed webhook yet");

  // Controlled first LIVE purchase evidence (steps 12–20).
  const liveOrder = await prisma.paymentOrder.findFirst({
    where: { environment: "LIVE", status: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] } },
    orderBy: { paidAt: "desc" },
    select: {
      id: true,
      orderNumber: true,
      payments: { where: { status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED] } }, select: { gatewayPaymentId: true } },
      entitlement: { select: { status: true, expiresAt: true } },
      invoice: { select: { invoiceNumber: true, environment: true } },
      refunds: { where: { status: "PROCESSED" }, select: { id: true } },
    },
  });
  const liveOrderHook = liveOrder
    ? await prisma.paymentWebhookEvent.findFirst({ where: { orderId: liveOrder.id, environment: "LIVE", status: WebhookEventStatus.PROCESSED }, select: { eventType: true, receivedAt: true } })
    : null;
  const liveMismatches = liveOrder ? (await findPaymentMismatches()).filter((m) => m.environment === "LIVE") : [];
  const entActive = Boolean(liveOrder?.entitlement && liveOrder.entitlement.status === "ACTIVE" && (!liveOrder.entitlement.expiresAt || liveOrder.entitlement.expiresAt > now));
  const allPass = (k: ReadinessGroupKey) => byKey[k].status === "PASS";
  const legalDoc = (key: string) => legal.docs.find((d) => d.key === key);
  const docDone = (key: string) => Boolean(legalDoc(key)?.reviewed && !legalDoc(key)?.contentIssue);

  const checklist: ChecklistStep[] = [
    { n: 1, label: "LIVE credentials saved", done: l.configured, evidence: l.configured ? `Key ID ${l.keyIdMasked}` : "Not configured" },
    { n: 2, label: "LIVE connection PASS", done: Boolean(l.lastTest?.ok), evidence: l.lastTest ? l.lastTest.message : "Not tested" },
    { n: 3, label: "LIVE Razorpay webhook configured", done: l.webhookSecretConfigured, evidence: l.webhookSecretConfigured ? "LIVE webhook secret stored — delivery proven at step 14" : "LIVE webhook secret not saved" },
    {
      n: 4,
      label: "Required webhook events configured",
      done: Boolean(liveAt),
      evidence: liveAt ? "LIVE deliveries received" : "Confirm in Razorpay (LIVE): payment.authorized, payment.captured, payment.failed, order.paid, refund.created, refund.processed, refund.failed",
    },
    { n: 5, label: "Invoice / business details reviewed", done: allPass("INVOICE"), evidence: allPass("INVOICE") ? "All invoice items PASS" : "See Invoice readiness" },
    { n: 6, label: "Terms reviewed", done: docDone("terms"), evidence: legalDoc("terms")?.contentIssue ?? (docDone("terms") ? "Owner reviewed" : "Owner review required") },
    { n: 7, label: "Privacy reviewed", done: docDone("privacy"), evidence: legalDoc("privacy")?.contentIssue ?? (docDone("privacy") ? "Owner reviewed" : "Owner review required") },
    { n: 8, label: "Refund & Cancellation Policy reviewed", done: docDone("refund"), evidence: legalDoc("refund")?.contentIssue ?? (docDone("refund") ? "Owner reviewed" : "Owner review required") },
    { n: 9, label: "Product price / duration reviewed", done: allPass("PRODUCT"), evidence: allPass("PRODUCT") ? "All product items PASS" : "See Product readiness" },
    { n: 10, label: "Test Series coverage reviewed", done: allPass("COVERAGE"), evidence: allPass("COVERAGE") ? "No uncovered paid mocks" : "Uncovered paid mocks to review" },
    { n: 11, label: "Switch gateway to LIVE", done: rzp.environment === "LIVE", evidence: `Gateway is ${rzp.environment}` },
    { n: 12, label: "Make one controlled small real purchase", done: Boolean(liveOrder), evidence: liveOrder ? liveOrder.orderNumber : "No paid LIVE order yet" },
    { n: 13, label: "Verify Razorpay payment captured", done: Boolean(liveOrder?.payments.length), evidence: liveOrder?.payments[0] ? maskId(liveOrder.payments[0].gatewayPaymentId) : "—" },
    { n: 14, label: "Verify real signed LIVE webhook", done: Boolean(liveOrderHook), evidence: liveOrderHook ? `${liveOrderHook.eventType} ${fmt(liveOrderHook.receivedAt)}` : "—" },
    { n: 15, label: "Verify Payment row", done: liveOrder?.payments.length === 1, evidence: liveOrder ? `${liveOrder.payments.length} captured Payment row(s)` : "—" },
    { n: 16, label: "Verify entitlement", done: Boolean(liveOrder?.entitlement), evidence: liveOrder?.entitlement ? `Entitlement ${liveOrder.entitlement.status}` : "—" },
    { n: 17, label: "Verify LIVE invoice", done: liveOrder?.invoice?.environment === "LIVE", evidence: liveOrder?.invoice?.invoiceNumber ?? "—" },
    { n: 18, label: "Verify student access", done: entActive, evidence: liveOrder ? (entActive ? "Entitlement active now" : "Entitlement not active") : "—" },
    { n: 19, label: "Verify reconciliation", done: Boolean(liveOrder) && liveMismatches.length === 0, evidence: liveOrder ? `${liveMismatches.length} LIVE mismatch(es)` : "—" },
    { n: 20, label: "Verify refund flow (optional, owner's choice)", done: Boolean(liveOrder?.refunds.length), evidence: liveOrder?.refunds.length ? "Processed LIVE refund on record" : "Not run" },
  ];

  const liveVerified = Boolean(liveE2E && liveE2E.entitlement && liveE2E.invoiceNumber);
  const finalState: FinalState =
    rzp.environment === "LIVE"
      ? liveVerified
        ? "PRODUCTION_VERIFIED"
        : "LIVE_UNVERIFIED"
      : liveBlockers.length === 0 && acknowledgementsRequired.length === 0
        ? "READY_FOR_CONTROLLED_LIVE_TEST"
        : "NOT_READY";

  return { environment: rzp.environment, mode, groups, liveBlockers, acknowledgementsRequired, checklist, finalState, testE2E, liveE2E, refundAccessPolicy: policy.refundAccessPolicy };
}
