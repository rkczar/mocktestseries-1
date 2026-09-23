/**
 * Production-safe Razorpay TEST-mode smoke test. Run AFTER saving TEST
 * credentials in Admin → Payments → Gateway Settings:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/smoke-razorpay-test.ts
 *
 * It never charges anything and never touches students, products, orders or
 * the global payment mode. It refuses to run unless the active gateway
 * environment is TEST. Checks:
 *   1. Stored TEST key pair authenticates against the real Razorpay API.
 *   2. A ₹1 TEST gateway order can be created and read back (amount intact).
 *      (An unpaid TEST order simply expires on Razorpay's side.)
 *   3. The configured TEST webhook secret is accepted by the live webhook
 *      endpoint: a self-signed event for an unknown order is verified and
 *      recorded as IGNORED (ORPHAN_GATEWAY_ORDER); a wrongly-signed one → 400.
 * Prints only masked identifiers — never secrets.
 */
import "dotenv/config";
import crypto from "node:crypto";

async function main() {
  const { getRazorpayConfig, getRazorpayCredentials, testRazorpayConnection } = await import("../lib/razorpay-config");
  const { createRazorpayOrder, fetchRazorpayOrder } = await import("../lib/payments/razorpay");
  const { getSiteUrl } = await import("../lib/site-url");
  const { prisma } = await import("../lib/prisma");

  let failures = 0;
  const check = (label: string, ok: boolean) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failures++;
  };

  const cfg = await getRazorpayConfig();
  if (cfg.environment !== "TEST") {
    console.error("Refusing: gateway environment is not TEST.");
    process.exit(2);
  }
  console.log(`Razorpay TEST smoke — key ${cfg.test.keyIdMasked || "(none)"}\n`);
  check("TEST Key ID + Secret saved", cfg.test.configured);
  check("TEST webhook secret saved", cfg.test.webhookSecretConfigured);
  if (!cfg.test.configured) process.exit(1);

  const conn = await testRazorpayConnection();
  check(`Auth against Razorpay API: ${conn.message}`, conn.ok);

  const receipt = `smoke-${Date.now().toString(36)}`;
  try {
    const o = await createRazorpayOrder("TEST", { amountPaise: 100, currency: "INR", receipt, notes: { purpose: "smoke-test" } });
    const back = await fetchRazorpayOrder("TEST", o.id);
    check(`Create + fetch ₹1 TEST order (${o.id.slice(0, 10)}…)`, back.id === o.id && back.amount === 100 && back.status === "created");
  } catch (e) {
    check(`Create TEST order (${e instanceof Error ? e.message : "error"})`, false);
  }

  const creds = await getRazorpayCredentials("TEST");
  if (creds?.webhookSecret) {
    const url = `${await getSiteUrl()}/api/webhooks/razorpay`;
    const eventId = `smoke_${crypto.randomBytes(6).toString("hex")}`;
    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_Smoke" + Date.now().toString(36), order_id: "order_SmokeUnknown", amount: 100, currency: "INR", status: "captured" } } },
    });
    const sig = crypto.createHmac("sha256", creds.webhookSecret).update(body).digest("hex");
    const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig, "x-razorpay-event-id": eventId }, body });
    const row = await prisma.paymentWebhookEvent.findUnique({ where: { eventId } });
    check(`Live webhook accepts correctly-signed event (HTTP ${ok.status})`, ok.status === 200 && row?.status === "IGNORED");
    const bad = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": "00".repeat(32), "x-razorpay-event-id": eventId + "b" }, body });
    check(`Live webhook rejects bad signature (HTTP ${bad.status})`, bad.status === 400);
    if (row) await prisma.paymentWebhookEvent.delete({ where: { id: row.id } });
  }

  console.log(`\n${failures === 0 ? "SMOKE PASSED" : `${failures} CHECK(S) FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Smoke test error");
  process.exit(1);
});
