/**
 * Focused regression for the Razorpay TEST/LIVE webhook-secret guard
 * (lib/razorpay-config.ts saveRazorpayConfig).
 *
 * Background: webhooks are routed to an environment by whichever slot's
 * secret verifies the signature. When TEST and LIVE shared one webhook
 * secret, real LIVE events resolved as TEST and were ignored as orphans.
 *
 * SAFETY: writes the `api.razorpay` setting and webhook-event rows, so it
 * REFUSES to run unless DATABASE_URL points at a scratch database whose name
 * contains "payverify". No network call is made.
 *
 *   DATABASE_URL=<scratch url> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-razorpay-webhook-secret-guard.ts
 *
 * Proves: a webhook secret equal to the other slot's is rejected for LIVE and
 * TEST (also with surrounding whitespace), before any write, with an error
 * that never contains either secret; distinct secrets save; blank fields keep
 * stored values; same-slot re-save is allowed; Key ID / Key Secret behaviour
 * is unchanged; and with distinct secrets a LIVE-signed webhook resolves as
 * LIVE while a TEST-signed one resolves as TEST.
 */
import "dotenv/config";
import crypto from "node:crypto";

if (!/payverify/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *payverify* scratch database.");
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { saveRazorpayConfig, getRazorpayCredentials, getRazorpayConfig, RazorpayConfigError } = await import("@/lib/razorpay-config");
  const { handleRazorpayWebhook } = await import("@/lib/payments/webhooks");

  const rand = (p: string) => `${p}_${crypto.randomBytes(12).toString("hex")}`;
  const A = rand("whsec_a");
  const B = rand("whsec_b");
  const row = async () => JSON.stringify((await prisma.setting.findUnique({ where: { key: "api.razorpay" } }))?.value ?? null);

  async function rejected(update: Parameters<typeof saveRazorpayConfig>[0], secrets: string[]) {
    const before = await row();
    try {
      await saveRazorpayConfig(update);
      return { threw: false, leak: false, unchanged: (await row()) === before, message: "" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        threw: e instanceof RazorpayConfigError,
        leak: secrets.some((s) => message.includes(s) || message.includes(s.slice(0, 12))),
        unchanged: (await row()) === before,
        message,
      };
    }
  }

  await prisma.setting.deleteMany({ where: { key: "api.razorpay" } });
  await prisma.paymentWebhookEvent.deleteMany({});

  // 1. First secret saves normally.
  await saveRazorpayConfig({ slot: "TEST", keyId: "rzp_test_GuardKey123", keySecret: rand("ks_test"), webhookSecret: A });
  check("TEST webhook secret saves when LIVE has none", (await getRazorpayCredentials("TEST"))?.webhookSecret === A);

  // 2. LIVE equal to TEST is rejected (even before LIVE keys exist), nothing written, no leak.
  let r = await rejected({ slot: "LIVE", webhookSecret: A }, [A]);
  check("LIVE webhook secret equal to TEST is rejected", r.threw);
  check("rejection writes nothing", r.unchanged);
  check("rejection message never contains a secret", !r.leak);
  check("rejection message names both environments", /LIVE Webhook Secret must be different from the TEST Webhook Secret/.test(r.message));

  r = await rejected({ slot: "LIVE", keyId: "rzp_live_GuardKey456", keySecret: rand("ks_live"), webhookSecret: `  ${A}  ` }, [A]);
  check("LIVE equal-after-trim is rejected with keys in the same save", r.threw && r.unchanged && !r.leak);
  check("rejected save did not store the LIVE Key ID either", !(await getRazorpayConfig()).live.keyIdConfigured);

  // 3. Distinct LIVE secret saves.
  const liveKeySecret = rand("ks_live");
  await saveRazorpayConfig({ slot: "LIVE", keyId: "rzp_live_GuardKey456", keySecret: liveKeySecret, webhookSecret: B });
  let live = await getRazorpayCredentials("LIVE");
  check("distinct LIVE webhook secret saves", live?.webhookSecret === B && live?.keySecret === liveKeySecret);

  // 4. TEST equal to LIVE is rejected.
  r = await rejected({ slot: "TEST", webhookSecret: B }, [A, B]);
  check("TEST webhook secret equal to LIVE is rejected", r.threw && r.unchanged && !r.leak);
  check("rejection message names both environments (TEST)", /TEST Webhook Secret must be different from the LIVE Webhook Secret/.test(r.message));
  check("TEST secret still the original after rejection", (await getRazorpayCredentials("TEST"))?.webhookSecret === A);

  // 5. Blank fields keep stored values (unchanged semantics).
  const newLiveKeySecret = rand("ks_live2");
  await saveRazorpayConfig({ slot: "LIVE", keySecret: newLiveKeySecret, webhookSecret: undefined });
  live = await getRazorpayCredentials("LIVE");
  check("blank webhook field keeps stored LIVE webhook secret", live?.webhookSecret === B && live?.keySecret === newLiveKeySecret);
  await saveRazorpayConfig({ slot: "LIVE", webhookSecret: "   " });
  check("whitespace-only webhook field is treated as blank", (await getRazorpayCredentials("LIVE"))?.webhookSecret === B);
  await saveRazorpayConfig({ slot: "LIVE" });
  live = await getRazorpayCredentials("LIVE");
  check("all-blank save keeps LIVE key id/secret/webhook", live?.keyId === "rzp_live_GuardKey456" && live?.keySecret === newLiveKeySecret && live?.webhookSecret === B);

  // 6. Re-saving the same slot's own secret is fine; rotating to a new distinct one is fine.
  await saveRazorpayConfig({ slot: "LIVE", webhookSecret: B });
  check("re-saving LIVE's own secret is allowed", (await getRazorpayCredentials("LIVE"))?.webhookSecret === B);
  const C = rand("whsec_c");
  await saveRazorpayConfig({ slot: "TEST", webhookSecret: C });
  check("rotating TEST to a new distinct secret is allowed", (await getRazorpayCredentials("TEST"))?.webhookSecret === C);

  // 7. Key ID / Key Secret behaviour unchanged.
  r = await rejected({ slot: "LIVE", keyId: "rzp_test_WrongPrefix1" }, []);
  check("Key ID prefix validation unchanged", r.threw && r.unchanged && /must look like "rzp_live_/.test(r.message));
  await saveRazorpayConfig({ slot: "LIVE", keySecret: C });
  check("Key Secret is not subject to the webhook guard", (await getRazorpayCredentials("LIVE"))?.keySecret === C);

  // 8. Mode/enabled-only saves never touch secrets.
  await saveRazorpayConfig({ environment: "LIVE", enabled: true });
  const cfg = await getRazorpayConfig();
  check("environment switch still works", cfg.environment === "LIVE" && cfg.enabled);
  check("environment switch keeps both webhook secrets", (await getRazorpayCredentials("TEST"))?.webhookSecret === C && (await getRazorpayCredentials("LIVE"))?.webhookSecret === B);

  // 9. With distinct secrets, webhooks resolve to the signing environment (orphan order → IGNORED, no fulfilment).
  const envOf = async (secret: string) => {
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: rand("pay"), order_id: rand("order"), amount: 100, currency: "INR", status: "captured" } } } });
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const eventId = rand("evt").slice(0, 40);
    const res = await handleRazorpayWebhook(body, sig, eventId);
    const ev = await prisma.paymentWebhookEvent.findUnique({ where: { eventId } });
    return { http: res.httpStatus, env: ev?.environment ?? null };
  };
  const l = await envOf(B);
  check("LIVE-signed webhook resolves as LIVE", l.http === 200 && l.env === "LIVE");
  const t = await envOf(C);
  check("TEST-signed webhook resolves as TEST", t.http === 200 && t.env === "TEST");
  const bad = await envOf(rand("unknown"));
  check("unknown-secret webhook is rejected before any write", bad.http === 400 && bad.env === null);

  await prisma.$disconnect();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll webhook-secret guard checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
