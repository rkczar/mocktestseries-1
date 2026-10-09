/**
 * WHATSAPP OTP FALLBACK (MSG91 Widget retryOtp) — library regression.
 *
 * Drives the production lib/otp.ts + lib/password-reset.ts with fetch stubbed
 * in-process (no SMS / WhatsApp ever leaves the machine). DISPOSABLE database
 * only — it writes OtpRequest rows, a test student and the auth.providers
 * setting:
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-whatsapp-otp.ts
 */
import "dotenv/config";

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
const AUTH_KEY = "wa-test-SECRET-authkey-91c2";
process.env.MSG91_AUTH_KEY = AUTH_KEY;
process.env.MSG91_WIDGET_ID = "wa-test-widget";

type Reply = { type: "success" | "error"; message: string } | "throw" | "html502";
type Endpoint = "sendOtp" | "retryOtp" | "verifyOtp" | "verifyAccessToken";
const calls: { url: string; ep: Endpoint; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
let script: Partial<Record<Endpoint, Reply>> = {};
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.WA-TEST-ACCESS-TOKEN.sig";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!/msg91\.com/.test(url)) return realFetch(input, init);
  const ep = url.split("/").pop() as Endpoint;
  calls.push({ url, ep, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body ?? "{}")) });
  const r = script[ep];
  if (r === "throw") throw new TypeError("fetch failed");
  if (r === "html502") return new Response("<html>502 Bad Gateway</html>", { status: 502 });
  return new Response(JSON.stringify(r ?? { type: "error", message: "unscripted" }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const logged: string[] = [];
for (const k of ["log", "warn", "error", "info"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    if (k === "log" || k === "info") orig(...a);
  };
}

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}\n`);
  if (!ok) failures++;
};

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const otp = await import("@/lib/otp");
  const { requestOtp, requestOtpOnWhatsApp, verifyOtp, OtpError, WHATSAPP_UNAVAILABLE, WHATSAPP_FAILED, WHATSAPP_NO_PENDING } = otp;
  const { saveAuthProviderConfig, isWhatsAppOtpAvailable, getAuthProviderConfig, bumpProviderConfigEpoch, getMsg91Credentials } = await import("@/lib/auth-provider-config");
  const { requestPasswordResetOnWhatsApp } = await import("@/lib/password-reset");

  const PREFIX = "+9192000000";
  const M = (n: number) => `${PREFIX}${String(n).padStart(2, "0")}`;
  const RESET_EMAIL = "wa-reset@whatsapp-otp.example.test";
  const clean = async () => {
    await prisma.otpRequest.deleteMany({ where: { mobile: { startsWith: PREFIX } } });
    await prisma.studentLoginAttempt.deleteMany({ where: { OR: [{ ipAddress: { startsWith: "10.88." } }, { identifier: { contains: "whatsapp-otp.example.test" } }] } });
    await prisma.student.deleteMany({ where: { email: RESET_EMAIL } });
  };
  await clean();
  const err = async (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof OtpError ? e.message : `NON-OTP ${String(e)}`));
  const rows = (m: string) => prisma.otpRequest.findMany({ where: { mobile: m }, orderBy: { createdAt: "asc" } });
  let ipN = 0;
  const IP = () => `10.88.0.${++ipN}`;
  /** Pretend the 60 s resend wait has passed for this number. */
  const pastCooldown = (m: string) => prisma.otpRequest.updateMany({ where: { mobile: m }, data: { lastSentAt: new Date(Date.now() - 61_000) } });
  const setWhatsApp = async (on: boolean) => {
    await saveAuthProviderConfig({ msg91: { enabled: true, whatsappRetryEnabled: on } });
    bumpProviderConfigEpoch();
  };
  const smsSend = async (m: string, reqId: string, purpose: "LOGIN" | "REGISTER" | "RESET_PASSWORD" | "VERIFY_MOBILE" = "LOGIN") => {
    script = { sendOtp: { type: "success", message: reqId } };
    await requestOtp(m, purpose, IP());
  };

  console.log("1. Switch OFF by default");
  await saveAuthProviderConfig({ msg91: { enabled: true } });
  const raw = await prisma.setting.findUnique({ where: { key: "auth.providers" } });
  const stored = (raw?.value as { msg91?: { whatsappRetryEnabled?: boolean } } | null)?.msg91;
  if (stored && "whatsappRetryEnabled" in stored) {
    await prisma.setting.update({ where: { key: "auth.providers" }, data: { value: { ...(raw!.value as object), msg91: { ...stored, whatsappRetryEnabled: undefined } } } });
  }
  bumpProviderConfigEpoch();
  check("whatsappRetryEnabled defaults to false", (await getAuthProviderConfig()).msg91.whatsappRetryEnabled === false);
  check("not available while OFF", (await isWhatsAppOtpAvailable()) === false);
  await smsSend(M(1), "req-a1");
  await pastCooldown(M(1));
  calls.length = 0;
  check("request refused while OFF (no MSG91 call)", (await err(requestOtpOnWhatsApp(M(1), "LOGIN", IP()))) === WHATSAPP_UNAVAILABLE && calls.length === 0);

  console.log("2. Retry with the original reqId on channel 12");
  await setWhatsApp(true);
  check("available when ON with Auth Key + Widget ID", (await isWhatsAppOtpAvailable()) === true);
  script = { retryOtp: { type: "success", message: "req-a1-wa" } };
  calls.length = 0;
  check("WhatsApp request accepted", (await err(requestOtpOnWhatsApp(M(1), "LOGIN", IP()))) === null);
  const rc = calls.find((c) => c.ep === "retryOtp");
  check("POST api.msg91.com/api/v5/widget/retryOtp", rc?.url === "https://api.msg91.com/api/v5/widget/retryOtp", rc?.url);
  const { widgetId: configuredWidget } = await getMsg91Credentials();
  check("body = { widgetId, reqId: ORIGINAL, retryChannel: 12 (number) }", rc?.body.widgetId === configuredWidget && rc?.body.reqId === "req-a1" && rc?.body.retryChannel === 12, rc?.body);
  check("Auth Key only in the authkey header", rc?.headers.authkey === AUTH_KEY && !JSON.stringify(rc?.body).includes(AUTH_KEY));
  const r1 = await rows(M(1));
  check("original SMS row superseded (consumed)", r1.length === 2 && r1[0].consumedAt !== null && r1[0].channel === "SMS", r1.map((r) => [r.channel, !!r.consumedAt]));
  check("new WHATSAPP row: new reqId, fresh 5-min expiry, 5 attempts", r1[1]?.channel === "WHATSAPP" && r1[1].providerRef === "req-a1-wa" && r1[1].consumedAt === null && r1[1].attempts === 0 && r1[1].maxAttempts === 5 && Math.round((r1[1].expiresAt.getTime() - r1[1].createdAt.getTime()) / 60000) === 5);

  console.log("3. Verification stays on the one secure backend path");
  script = { verifyOtp: { type: "success", message: TOKEN }, verifyAccessToken: { type: "success", message: "919200000001" } };
  calls.length = 0;
  check("code accepted after WhatsApp delivery", (await err(verifyOtp(M(1), "LOGIN", "123456"))) === null);
  check("verifyOtp used the NEW reqId", calls[0]?.ep === "verifyOtp" && calls[0].body.reqId === "req-a1-wa", calls[0]?.body);
  check("access token re-verified server-side for the same number", calls[1]?.ep === "verifyAccessToken" && calls[1].body["access-token"] === TOKEN);
  check("WhatsApp row consumed (single use)", (await rows(M(1)))[1].consumedAt !== null);
  script = { verifyOtp: { type: "success", message: TOKEN }, verifyAccessToken: { type: "success", message: "919999999999" } };
  await smsSend(M(2), "req-b1");
  await pastCooldown(M(2));
  script = { retryOtp: { type: "success", message: "req-b1-wa" } };
  await requestOtpOnWhatsApp(M(2), "LOGIN", IP());
  script = { verifyOtp: { type: "success", message: TOKEN }, verifyAccessToken: { type: "success", message: "919999999999" } };
  check("token for another number still refused after WhatsApp", (await err(verifyOtp(M(2), "LOGIN", "123456"))) === "Incorrect code.");

  console.log("4. Same limits as SMS");
  await smsSend(M(3), "req-c1");
  calls.length = 0;
  check("inside the 60 s resend wait → refused, no MSG91 call", /Please wait \d+s/.test((await err(requestOtpOnWhatsApp(M(3), "LOGIN", IP()))) ?? "") && calls.length === 0);
  await pastCooldown(M(3));
  script = { retryOtp: { type: "success", message: "req-c1-wa" } };
  await requestOtpOnWhatsApp(M(3), "LOGIN", IP());
  check("a WhatsApp send restarts the 60 s wait for SMS too", /Please wait \d+s/.test((await err(requestOtp(M(3), "LOGIN", IP()))) ?? ""));
  // 15-minute per-number/purpose cap (5) counts SMS and WhatsApp together.
  await pastCooldown(M(3));
  await smsSend(M(3), "req-c2");
  await pastCooldown(M(3));
  script = { retryOtp: { type: "success", message: "req-c2-wa" } };
  await requestOtpOnWhatsApp(M(3), "LOGIN", IP());
  await pastCooldown(M(3));
  script = { retryOtp: { type: "success", message: "req-c3-wa" } };
  check("5th send in 15 min (SMS, WA, SMS, WA, WA) still allowed", (await err(requestOtpOnWhatsApp(M(3), "LOGIN", IP()))) === null);
  await pastCooldown(M(3));
  const sixth = await err(requestOtpOnWhatsApp(M(3), "LOGIN", IP()));
  check("6th send (mixed channels) refused by the 15-min cap", /Too many|Please try again later/i.test(sixth ?? ""), sixth);
  check("…and no extra retryOtp went out", calls.filter((c) => c.ep === "retryOtp").length === 3);
  // Per-IP cap is shared too (lib/auth-rate-limit.ts counts OtpRequest rows per IP).
  const fixedIp = "10.88.9.9";
  let ipRefused: string | null = null;
  for (let i = 10; i < 30 && !ipRefused; i++) {
    script = { sendOtp: { type: "success", message: `req-ip-${i}` } };
    const e1 = await err(requestOtp(M(i), "LOGIN", fixedIp));
    if (e1) { ipRefused = e1; break; }
    await pastCooldown(M(i));
    script = { retryOtp: { type: "success", message: `req-ip-${i}-wa` } };
    ipRefused = await err(requestOtpOnWhatsApp(M(i), "LOGIN", fixedIp));
  }
  check("per-IP cap reached by mixed SMS + WhatsApp sends", /too many|try again later/i.test(ipRefused ?? ""), ipRefused);
  const waRowsFromIp = await prisma.otpRequest.count({ where: { ipAddress: fixedIp, channel: "WHATSAPP" } });
  check("…WhatsApp sends were counted toward it", waRowsFromIp >= 1, waRowsFromIp);

  console.log("5. Nothing to re-deliver");
  calls.length = 0;
  check("no SMS code yet → 'request a new code first'", (await err(requestOtpOnWhatsApp(M(40), "LOGIN", IP()))) === WHATSAPP_NO_PENDING && calls.length === 0);
  await smsSend(M(41), "req-e1");
  await prisma.otpRequest.updateMany({ where: { mobile: M(41) }, data: { expiresAt: new Date(Date.now() - 1000), lastSentAt: new Date(Date.now() - 61_000) } });
  check("expired SMS code → refused", (await err(requestOtpOnWhatsApp(M(41), "LOGIN", IP()))) === WHATSAPP_NO_PENDING);
  await smsSend(M(42), "req-e2");
  await prisma.otpRequest.updateMany({ where: { mobile: M(42) }, data: { consumedAt: new Date(), lastSentAt: new Date(Date.now() - 61_000) } });
  check("used SMS code → refused", (await err(requestOtpOnWhatsApp(M(42), "LOGIN", IP()))) === WHATSAPP_NO_PENDING);
  await smsSend(M(43), "req-e3", "REGISTER");
  await pastCooldown(M(43));
  check("purpose is respected (REGISTER code not re-sent for LOGIN)", (await err(requestOtpOnWhatsApp(M(43), "LOGIN", IP()))) === WHATSAPP_NO_PENDING);

  console.log("6. MSG91 refusals are honest and keep the SMS code usable");
  for (const [label, reply] of [
    ["MSG91 error (WhatsApp not set up on the Widget)", { type: "error", message: "Retry channel not configured" }],
    ["MSG91 502 HTML", "html502"],
    ["network failure", "throw"],
  ] as const) {
    const m = M(50 + ["MSG91 error (WhatsApp not set up on the Widget)", "MSG91 502 HTML", "network failure"].indexOf(label));
    await smsSend(m, `req-f-${m.slice(-2)}`);
    await pastCooldown(m);
    script = { retryOtp: reply as Reply };
    check(`${label} → clear WhatsApp failure`, (await err(requestOtpOnWhatsApp(m, "LOGIN", IP()))) === WHATSAPP_FAILED);
    const rr = await rows(m);
    check(`…no WHATSAPP row, SMS code still pending (${label})`, rr.length === 1 && rr[0].channel === "SMS" && rr[0].consumedAt === null);
  }
  await smsSend(M(60), "req-g1");
  await pastCooldown(M(60));
  script = { retryOtp: { type: "success", message: "OTP retry successful" } };
  await requestOtpOnWhatsApp(M(60), "LOGIN", IP());
  check("sentence instead of a reqId → original reqId kept", (await rows(M(60)))[1]?.providerRef === "req-g1");

  console.log("7. All four purposes");
  for (const [i, purpose] of (["LOGIN", "REGISTER", "RESET_PASSWORD", "VERIFY_MOBILE"] as const).entries()) {
    const m = M(70 + i);
    await smsSend(m, `req-p-${purpose}`, purpose);
    await pastCooldown(m);
    script = { retryOtp: { type: "success", message: `req-p-${purpose}-wa` } };
    await requestOtpOnWhatsApp(m, purpose, IP());
    script = { verifyOtp: { type: "success", message: TOKEN }, verifyAccessToken: { type: "success", message: m.replace("+", "") } };
    check(`${purpose}: WhatsApp re-delivery then verify`, (await err(verifyOtp(m, purpose, "123456"))) === null);
  }

  console.log("8. Forgot Password: no account enumeration");
  calls.length = 0;
  check("unknown identifier → same silent answer, no MSG91 call", (await requestPasswordResetOnWhatsApp("nobody@whatsapp-otp.example.test", IP()).then(() => "ok", (e) => String(e))) === "ok" && calls.length === 0);
  const student = await prisma.student.create({
    data: { studentId: `WA-${Date.now()}`, name: "WA Reset", email: RESET_EMAIL, mobile: M(80), authProvider: "CREDENTIALS" },
  });
  calls.length = 0;
  check("real account without a pending code → same silent answer, no MSG91 call", (await requestPasswordResetOnWhatsApp(RESET_EMAIL, IP()).then(() => "ok", (e) => String(e))) === "ok" && calls.length === 0);
  await smsSend(M(80), "req-r1", "RESET_PASSWORD");
  check("real account inside the 60 s wait → same silent answer", (await requestPasswordResetOnWhatsApp(RESET_EMAIL, IP()).then(() => "ok", (e) => String(e))) === "ok");
  await pastCooldown(M(80));
  script = { retryOtp: { type: "success", message: "req-r1-wa" } };
  await requestPasswordResetOnWhatsApp(RESET_EMAIL, IP());
  check("real account with a pending code → re-delivered on WhatsApp", (await rows(M(80))).some((r) => r.channel === "WHATSAPP" && r.providerRef === "req-r1-wa"));
  const resetIp = "10.88.7.7";
  let capMsg: string | null = null;
  for (let i = 0; i < 12 && !capMsg; i++) capMsg = await requestPasswordResetOnWhatsApp(`nobody${i}@whatsapp-otp.example.test`, resetIp).then(() => null, (e) => String(e.message));
  check("WhatsApp reset requests count toward the per-IP reset cap", /Too many reset requests/.test(capMsg ?? ""), capMsg);
  await prisma.student.delete({ where: { id: student.id } });

  console.log("9. SMS path unchanged");
  await smsSend(M(90), "req-s1");
  const s1 = (await rows(M(90)))[0];
  check("SMS send still uses sendOtp and stores channel SMS", s1.channel === "SMS" && s1.providerRef === "req-s1");

  console.log("10. Secrets never logged");
  const all = logged.join("\n");
  check(`Auth Key never in console output (${logged.length} lines)`, !all.includes(AUTH_KEY));
  check("access token never in console output", !all.includes("WA-TEST-ACCESS-TOKEN"));
  check("OTP codes never in console output", !/\b123456\b/.test(all));

  await setWhatsApp(false);
  await clean();
  await prisma.$disconnect();
  console.log(failures === 0 ? "\nALL WHATSAPP OTP CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
