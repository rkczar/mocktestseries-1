/**
 * Targeted verification for the pre-LIVE launch work: Mock → Test Series
 * assignment + paid coverage (lib/test-series-assignment.ts), invoice /
 * business settings, legal readiness (/refund-policy + owner review), Live
 * Launch Readiness + LIVE guard, renewal preview, Website Diagram wiring.
 *
 * SAFETY: writes fixtures and settings, so it REFUSES to run unless
 * DATABASE_URL points at a *payverify* scratch DB. No Razorpay call is made.
 * Run after scripts/verify-payments.ts on the same scratch DB so invoices exist:
 *
 *   DATABASE_URL=<scratch url> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-launch-readiness.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { MockTestStatus, StudentAuthProvider } from "@prisma/client";

if (!/payverify/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *payverify* scratch database.");
  process.exit(2);
}

let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const src = (p: string) => readFileSync(p, "utf8");

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const A = await import("@/lib/test-series-assignment");
  const { loadAccessContext, evaluateContentAccess } = await import("@/lib/payments/access");
  const S = await import("@/lib/payments/settings");
  const { saveRazorpayConfig } = await import("@/lib/razorpay-config");
  const { getLaunchReadiness } = await import("@/lib/payments/launch-readiness");
  const { getLegalReadiness, markLegalDocReviewed } = await import("@/lib/legal-readiness");
  const { renewalPreview } = await import("@/lib/payments/orders");
  const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = await import("@/lib/permissions");
  const { ROUTE_MANIFEST } = await import("@/lib/routes");
  const { ROUTE_CONNECTIONS } = await import("@/lib/route-connections");

  console.log("=== Pre-LIVE launch work (scratch DB) ===\n");
  const sfx = Date.now().toString(36);
  const now = new Date();
  const mkExam = (t: string) => prisma.exam.create({ data: { name: `LR ${t} ${sfx}`, code: `LR${t}-${sfx}`, durationMinutes: 30 } });
  const [exam, otherExam] = await Promise.all([mkExam("A"), mkExam("B")]);
  const [series, series2, otherSeries] = await Promise.all([
    prisma.testSeries.create({ data: { examId: exam.id, name: `LR Series ${sfx}`, status: "PUBLISHED", testCount: 10 } }),
    prisma.testSeries.create({ data: { examId: exam.id, name: `LR Series2 ${sfx}`, status: "PUBLISHED", testCount: 10 } }),
    prisma.testSeries.create({ data: { examId: otherExam.id, name: `LR Other ${sfx}`, status: "PUBLISHED", testCount: 10 } }),
  ]);
  const mkMock = (title: string, accessType: "FREE" | "PAID", testSeriesId: string | null, order: number) =>
    prisma.mockTest.create({ data: { examId: exam.id, testSeriesId, title, durationMinutes: 30, status: MockTestStatus.PUBLISHED, accessType, order } });
  const inSeriesPaid = await mkMock("In-series paid", "PAID", series.id, 1);
  const inSeriesFree = await mkMock("In-series free", "FREE", series.id, 2);
  const newPaid = await mkMock("New standalone paid", "PAID", null, 1);
  const product = await prisma.product.create({
    data: { code: `lr-${sfx}`, name: "LR Complete", productType: "TEST_SERIES", examId: exam.id, testSeriesId: series.id, accessType: "PAID", mrpPaise: 99900, sellingPricePaise: 49900, accessDurationType: "DAYS", accessDays: 180 },
  });
  const student = await prisma.student.create({ data: { studentId: `LR-${sfx}`, name: "LR Active", email: `lr-${sfx}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
  const activeUntil = new Date(now.getTime() + 100 * 86_400_000);
  await prisma.studentEntitlement.create({ data: { studentId: student.id, productId: product.id, source: "PURCHASE", startsAt: new Date(now.getTime() - 86_400_000), expiresAt: activeUntil } });
  const entCountBefore = await prisma.studentEntitlement.count({ where: { studentId: student.id } });
  const canOpen = async (mockId: string) => {
    const m = await prisma.mockTest.findUniqueOrThrow({ where: { id: mockId } });
    return evaluateContentAccess(await loadAccessContext(student.id), { kind: "MOCK_TEST", id: m.id, examId: m.examId, testSeriesId: m.testSeriesId, accessType: m.accessType }).allowed;
  };
  const products = async () => A.loadCoverageProducts(prisma);

  console.log("A. Mock → Test Series assignment");
  check("New mock is Standalone (testSeriesId null)", newPaid.testSeriesId === null);
  check("Uncovered paid standalone mock is flagged", !A.mockIsFree(newPaid, await products()) && A.purchasableProductsFor(newPaid, await products(), now).length === 0);
  check("Warning copy present", /not included in any purchasable plan/.test(A.UNCOVERED_PAID_MOCK_WARNING));
  check("Active student cannot open the standalone paid mock yet", !(await canOpen(newPaid.id)));
  check("Compatible series offers a plan (seriesPlanProducts)", A.seriesPlanProducts(series.id, exam.id, await products(), now).some((p) => p.id === product.id));
  const mockCount = await prisma.mockTest.count();
  await prisma.$transaction((tx) => A.assignMocksToSeries(tx, { seriesId: series.id, mockIds: [newPaid.id] }));
  const assigned = await prisma.mockTest.findUniqueOrThrow({ where: { id: newPaid.id } });
  check("Assign sets testSeriesId + next Test Number", assigned.testSeriesId === series.id && assigned.order === 3);
  check("No duplicate Mock record", (await prisma.mockTest.count()) === mockCount);
  check("Existing entitlement covers the newly assigned paid mock", await canOpen(newPaid.id));
  check("No per-mock entitlement created", (await prisma.studentEntitlement.count({ where: { studentId: student.id } })) === entCountBefore);
  check("FREE/PAID flag untouched", assigned.accessType === "PAID");
  check("Audit row written", (await prisma.auditLog.count({ where: { action: "MOCK_TEST_SERIES_ASSIGNMENT", entityId: newPaid.id } })) === 1);
  const refuse = async (fn: () => Promise<unknown>) => fn().then(() => false, (e) => e instanceof A.AssignmentError);
  check("Re-assign to same series refused", await refuse(() => A.assignMocksToSeries(prisma, { seriesId: series.id, mockIds: [newPaid.id] })));
  check("Assign to another series silently refused (must remove first)", await refuse(() => A.assignMocksToSeries(prisma, { seriesId: series2.id, mockIds: [newPaid.id] })));
  check("Cross-exam assignment refused", await refuse(() => A.assignMocksToSeries(prisma, { seriesId: otherSeries.id, mockIds: [inSeriesFree.id] })));
  await prisma.$transaction((tx) => A.removeMocksFromSeries(tx, { seriesId: series.id, mockIds: [newPaid.id] }));
  const removed = await prisma.mockTest.findUniqueOrThrow({ where: { id: newPaid.id } });
  check("Remove → Standalone, flag/order kept", removed.testSeriesId === null && removed.accessType === "PAID" && removed.order === 3);
  check("Access lost with removal (through the Product only)", !(await canOpen(newPaid.id)));
  await A.setMockSeriesAssignment(prisma, { mockTestId: newPaid.id, seriesId: series.id });
  check("Editor: Standalone → series", (await prisma.mockTest.findUniqueOrThrow({ where: { id: newPaid.id } })).testSeriesId === series.id);
  await A.setMockSeriesAssignment(prisma, { mockTestId: newPaid.id, seriesId: null });
  check("Editor: series → Standalone", (await prisma.mockTest.findUniqueOrThrow({ where: { id: newPaid.id } })).testSeriesId === null);
  check("Editor: cross-exam refused", await refuse(() => A.setMockSeriesAssignment(prisma, { mockTestId: newPaid.id, seriesId: otherSeries.id })));
  check("MASTER_ADMIN has TEST_SERIES_MANAGE", DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.TEST_SERIES_MANAGE));
  check("FULL_ADMIN lacks TEST_SERIES_MANAGE (read-only)", !DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.TEST_SERIES_MANAGE));
  const tsActions = src("app/admin/(dashboard)/exams/test-series/actions.ts");
  const mockActions = src("app/admin/(dashboard)/tests/mock/actions.ts");
  const gated = (s: string, fn: string) => new RegExp(`export async function ${fn}[\\s\\S]{0,200}?requirePermission\\(PERMISSIONS\\.TEST_SERIES_MANAGE\\)`).test(s);
  check("assign/remove actions gated by TEST_SERIES_MANAGE", gated(tsActions, "assignMocksToSeriesAction") && gated(tsActions, "removeMocksFromSeriesAction"));
  check("editor assignment action gated by TEST_SERIES_MANAGE", gated(mockActions, "setMockSeriesAssignmentAction"));
  check("UI renders read-only when !canManage", /readOnly=\{!canManage\}/.test(src("app/admin/(dashboard)/exams/test-series/[id]/page.tsx")) && /readOnly=\{!canManage\}/.test(src("app/admin/(dashboard)/tests/mock/[id]/page.tsx")));

  console.log("\nB. Coverage counts");
  const cov = A.summarizeCoverage(await prisma.mockTest.findMany({ where: { examId: exam.id } }), await products(), now);
  check(`Total 3 / Free 1 / Paid 2 / Covered 1 / Uncovered 1 (got ${cov.total}/${cov.free}/${cov.paid}/${cov.coveredPaid}/${cov.uncoveredPaid})`, cov.total === 3 && cov.free === 1 && cov.paid === 2 && cov.coveredPaid === 1 && cov.uncoveredPaid === 1 && cov.uncovered[0]?.id === newPaid.id);
  await prisma.product.update({ where: { id: product.id }, data: { purchaseEnabled: false } });
  const cov2 = A.summarizeCoverage(await prisma.mockTest.findMany({ where: { examId: exam.id } }), await products(), now);
  check("Non-purchasable product no longer counts as coverage", cov2.coveredPaid === 0 && cov2.uncoveredPaid === 2);
  await prisma.product.update({ where: { id: product.id }, data: { purchaseEnabled: true } });
  check("in-series paid mock covered", A.purchasableProductsFor(inSeriesPaid, await products(), now).length === 1);

  console.log("\nC. Invoice / business settings");
  const invBefore = await prisma.invoice.findMany({ select: { id: true, invoiceNumber: true, snapshot: true } });
  const form = (o: Record<string, string>) => (k: string) => o[k] ?? "";
  const unset = S.parseInvoiceSettingsInput(form({ legalName: "" }));
  check("GST registration stays null when not answered", unset.ok && unset.value.gstRegistered === null && unset.value.gstin === "" && unset.value.taxMode === "NONE");
  check("'No' + GSTIN refused", !S.parseInvoiceSettingsInput(form({ gstRegistered: "NO", gstin: "08ABCDE1234F1Z5" })).ok);
  check("'No' + tax lines refused", !S.parseInvoiceSettingsInput(form({ gstRegistered: "NO", taxMode: "INCLUSIVE", taxRatePercent: "18" })).ok);
  check("'Yes' without GSTIN refused", !S.parseInvoiceSettingsInput(form({ gstRegistered: "YES" })).ok);
  check("Bad PIN refused", !S.parseInvoiceSettingsInput(form({ pinCode: "12" })).ok);
  if (unset.ok) await S.saveInvoiceSettings({ ...unset.value, addressLine1: "Line 1", city: "Jaipur", state: "Rajasthan", pinCode: "302001" });
  const stored = await S.getInvoiceSettings();
  check("Persists via Setting (payments.invoice)", stored.addressLine1 === "Line 1" && stored.gstRegistered === null);
  check("Structured address composed", S.composeSellerAddress(stored) === "Line 1\nJaipur, Rajasthan - 302001\nIndia");
  const r1 = await getLaunchReadiness();
  const inv = r1.groups.find((g) => g.key === "INVOICE")!;
  const st = (l: string) => inv.items.find((i) => i.label === l)?.status;
  check("Missing legal name → ACTION_REQUIRED", st("Seller / business legal name") === "ACTION_REQUIRED");
  check("Unanswered GST → ACTION_REQUIRED (nothing assumed)", st("GST registration status") === "ACTION_REQUIRED" && st("GSTIN") === "ACTION_REQUIRED");
  const invAfter = await prisma.invoice.findMany({ select: { id: true, invoiceNumber: true, snapshot: true } });
  check(`Historical invoices unchanged (${invBefore.length} compared)`, invBefore.length > 0 && JSON.stringify(invBefore) === JSON.stringify(invAfter));

  console.log("\nD. Legal");
  // Scratch-DB fixtures from an earlier run of this script (versions >= 900000).
  await prisma.homepageConfig.deleteMany({ where: { version: { gte: 900000 } } });
  await prisma.setting.deleteMany({ where: { key: "legal.review" } });
  const legal0 = await getLegalReadiness();
  check("No published text → owner review not claimed", legal0.docs.every((d) => !d.reviewed));
  const copy = await import("@/lib/legal-payment-copy");
  const cfg = await prisma.homepageConfig.create({
    data: {
      version: 900000,
      status: "PUBLISHED",
      sections: {
        create: [
          { key: "CONTACT_INFO", content: { termsBody: `Intro\n\n${copy.TERMS_PAYMENT_SECTION}`, privacyBody: `Intro\n\n${copy.PRIVACY_PAYMENT_SECTION}`, refundBody: copy.REFUND_POLICY_DEFAULT } },
          { key: "FOOTER", content: { links: [["Terms", "/terms"], ["Privacy", "/privacy"], ["Refund & Cancellation Policy", "/refund-policy"], ["Contact", "/contact"]] } },
        ],
      },
    },
    include: { sections: true },
  });
  const legal1 = await getLegalReadiness();
  check("Payment-ready text has no content issue", legal1.docs.every((d) => d.hasContent && d.contentIssue === null));
  check("Owner review still required until acknowledged", legal1.docs.every((d) => !d.reviewed));
  check("Footer links detected", Object.values(legal1.footer).every(Boolean));
  await markLegalDocReviewed("refund", undefined);
  check("Owner review recorded for refund", (await getLegalReadiness()).docs.find((d) => d.key === "refund")?.reviewed === true);
  const ci = cfg.sections.find((s) => s.key === "CONTACT_INFO")!;
  await prisma.homepageSection.update({ where: { id: ci.id }, data: { content: { ...(ci.content as object), refundBody: `${copy.REFUND_POLICY_DEFAULT}\n\nEdited.` } } });
  check("Editing text resets owner review", (await getLegalReadiness()).docs.find((d) => d.key === "refund")?.reviewed === false);
  await prisma.homepageSection.update({ where: { id: ci.id }, data: { content: { ...(ci.content as object), termsBody: `Intro\n\n${copy.LEGACY_TERMS_PAYMENT_BLOCK}` } } });
  check("Stale 'does not charge' Terms flagged", /does not charge/.test((await getLegalReadiness()).docs.find((d) => d.key === "terms")?.contentIssue ?? ""));
  check("/refund-policy page + visibility key + sitemap", /LegalDocumentPage kind="refund"/.test(src("app/refund-policy/page.tsx")) && /key: "refund-policy"/.test(src("lib/page-visibility.ts")) && /refund-policy/.test(src("app/sitemap.ts")));
  check("Checkout links Terms / Privacy / Refund / Contact", ["/terms", "/privacy", "/refund-policy", "/contact"].every((h) => src("app/student/(dashboard)/checkout/[code]/checkout-client.tsx").includes(`href="${h}"`)));

  console.log("\nE. LIVE readiness + guard");
  await saveRazorpayConfig({ slot: "TEST", keyId: "rzp_test_LrVerify123", keySecret: "lr_secret", webhookSecret: "lr_whsec" });
  await saveRazorpayConfig({ environment: "TEST", enabled: true });
  const r = await getLaunchReadiness();
  const live = r.groups.find((g) => g.key === "LIVE")!;
  check("Gateway stays TEST", r.environment === "TEST");
  check("LIVE keys/webhook → NOT_CONFIGURED", ["LIVE Key ID", "LIVE Key Secret", "LIVE Webhook Secret"].every((l) => live.items.find((i) => i.label === l)?.status === "NOT_CONFIGURED"));
  check("4 LIVE blockers while LIVE is unconfigured", r.liveBlockers.length === 4);
  check("Never claims LIVE verified", r.finalState === "NOT_READY" && live.items.find((i) => i.label === "Controlled LIVE payment verified")?.status !== "PASS");
  const testE2EDb = await prisma.paymentWebhookEvent.count({ where: { environment: "TEST", status: "PROCESSED", eventType: { in: ["payment.captured", "order.paid"] } } });
  check(`TEST evidence derived from records (webhook rows ${testE2EDb}, e2e ${r.testE2E?.orderNumber ?? "none"})`, testE2EDb > 0 ? r.testE2E !== null : r.testE2E === null);
  check("Stale TEST connection result cleared on credential change", r.groups.find((g) => g.key === "TEST")!.items.find((i) => i.label === "TEST connection")?.status === "ACTION_REQUIRED");
  const gw = src("app/admin/(dashboard)/payments/actions.ts");
  check("saveGatewayModeAction refuses LIVE on blockers before saving", /readiness\.liveBlockers\.length\) return \{ error/.test(gw) && gw.indexOf("liveBlockers.length) return") < gw.indexOf("await saveRazorpayConfig({ environment, enabled })"));
  check("…and requires acknowledgement + typed LIVE", /acknowledgeReadiness/.test(gw) && /confirmLive"\) !== "LIVE"/.test(gw));

  console.log("\nF. Renewal preview");
  const cur = new Date(now.getTime() + 30 * 86_400_000);
  const act = { status: "ACTIVE_SUBSCRIPTION" as const, expiresAt: cur };
  const p180 = renewalPreview({ accessDurationType: "DAYS", accessDays: 180, accessExpiresAt: null }, act, now);
  check("180-day product → +180 days from current expiry", p180?.days === 180 && p180.newExpiresAt.getTime() - cur.getTime() === 180 * 86_400_000);
  check("Duration read from Product (90 → 90)", renewalPreview({ accessDurationType: "DAYS", accessDays: 90, accessExpiresAt: null }, act, now)?.days === 90);
  check("Lifetime → no extension", renewalPreview({ accessDurationType: "LIFETIME", accessDays: null, accessExpiresAt: null }, act, now) === null);
  check("Lifetime entitlement (no expiry) → no extension", renewalPreview({ accessDurationType: "DAYS", accessDays: 180, accessExpiresAt: null }, { status: "ACTIVE_SUBSCRIPTION", expiresAt: null }, now) === null);
  check("Fixed-date → no extension", renewalPreview({ accessDurationType: "FIXED_DATE", accessDays: null, accessExpiresAt: new Date(now.getTime() + 9e9) }, act, now) === null);
  check("Not active → no extension preview", renewalPreview({ accessDurationType: "DAYS", accessDays: 180, accessExpiresAt: null }, { status: "EXPIRED", expiresAt: cur }, now) === null);

  console.log("\nH. Website Diagram");
  const routes = new Set(ROUTE_MANIFEST.map((r) => r.route));
  check("/refund-policy in route manifest", routes.has("/refund-policy"));
  const newEdges = ROUTE_CONNECTIONS.filter((c) => c.to === "/refund-policy" || /Manage Tests|Mock Assignment|Course Assignment|Product → Test Series|Legal Readiness/.test(c.label ?? ""));
  check(`New edges (${newEdges.length}) reference manifest routes`, newEdges.length >= 6 && newEdges.every((c) => routes.has(c.from) && routes.has(c.to)));

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  await prisma.$disconnect();
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
