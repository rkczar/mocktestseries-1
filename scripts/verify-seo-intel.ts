/**
 * Unit-level checks for lib/seo-intel/google.ts on a DISPOSABLE database
 * (name must contain "seointel"): redaction, endpoint allow-list, client
 * credential validation + encryption, state-cookie tamper/expiry/initiator
 * checks, and isolation from the student Google login config. No network
 * except a loopback mock (none needed here).
 *
 *   DATABASE_URL=<scratch> AUTH_SECRET=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-seo-intel.ts
 */
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/secret-cipher";
import {
  CONNECTION_SETTING_KEY,
  beginAuthorization,
  clearAll,
  completeAuthorization,
  getConnectionView,
  googleFetch,
  redact,
  setClientCredentials,
} from "@/lib/seo-intel/google";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";

const url = process.env.DATABASE_URL ?? "";
if (!/seointel/.test(url)) {
  console.error("Refusing to run: DATABASE_URL must be a scratch database whose name contains 'seointel'.");
  process.exit(2);
}

let failed = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed++;
}
async function throws(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const CLIENT_ID = "123456789012-mockseoclientabcdefghijk.apps.googleusercontent.com";
const SECRET = "GOCSPX-unitTestSecret-abcdef123456";

async function main() {
  // Permissions
  check("MASTER_ADMIN has SEO_INTEL_VIEW + MANAGE", DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.SEO_INTEL_VIEW) && DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.SEO_INTEL_MANAGE));
  check("FULL_ADMIN has VIEW only", DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.SEO_INTEL_VIEW) && !DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.SEO_INTEL_MANAGE));
  check("TEACHER has VIEW only", DEFAULT_ROLE_PERMISSIONS.TEACHER.includes(PERMISSIONS.SEO_INTEL_VIEW) && !DEFAULT_ROLE_PERMISSIONS.TEACHER.includes(PERMISSIONS.SEO_INTEL_MANAGE));
  check("FULL_ADMIN still has no other manage key", DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.every((p) => p.endsWith(":view")));

  // Redaction
  const leaky = `HTTP 403 — token=ya29.AbCdEf123456 refresh 1//0gAbcdefghijklmnop secret GOCSPX-abcdefXYZ {"access_token":"zzz","refresh_token":"yyy"} code=4/0AbCdEf eyJhbGciOi.eyJzdWIiOjEyMzQ1Njc4OTAx.sig`;
  const r = redact(leaky, ["custom-secret-value"]);
  check("redact removes ya29 / 1// / GOCSPX / JWT / JSON token fields / code=", !/ya29\.|1\/\/0g|GOCSPX-|"zzz"|"yyy"|4\/0AbCdEf|eyJhbGciOi/.test(r));
  check("redact removes explicit secrets", !redact("x custom-secret-value y", ["custom-secret-value"]).includes("custom-secret-value"));
  check("redact caps length", redact("a".repeat(5000)).length <= 300);

  // Endpoint allow-list
  check("googleFetch blocks non-Google URL", await throws(() => googleFetch("https://evil.example/token", { method: "POST" })));
  check("googleFetch blocks other GA4 property", await throws(() => googleFetch("https://analyticsdata.googleapis.com/v1beta/properties/557243074:runReport", { method: "POST" })));
  check("googleFetch blocks userinfo / arbitrary googleapis", await throws(() => googleFetch("https://www.googleapis.com/oauth2/v3/userinfo", { method: "GET" })));

  // Client credentials
  await clearAll();
  check("rejects a non-client-ID", await throws(() => setClientCredentials("not-a-client", SECRET)));
  check("rejects an empty secret", await throws(() => setClientCredentials(CLIENT_ID, "  ")));
  await setClientCredentials(CLIENT_ID, SECRET);
  const row = await prisma.setting.findUnique({ where: { key: CONNECTION_SETTING_KEY } });
  const raw = JSON.stringify(row?.value);
  check("client secret stored encrypted (no plaintext in DB)", !raw.includes(SECRET) && /"clientSecretCipher":"v1:/.test(raw));
  check("stored cipher decrypts to the secret", decryptSecret((row?.value as { clientSecretCipher: string }).clientSecretCipher) === SECRET);
  const view = await getConnectionView();
  check("view: configured, not connected, GA4 553529096", view.credentialsConfigured && !view.connected && view.ga4PropertyId === "553529096");
  check("view carries no secret", !JSON.stringify(view).includes(SECRET) && !JSON.stringify(view).includes(CLIENT_ID));

  // Authorization start
  const start = await beginAuthorization("admin-a");
  const u = new URL(start.url);
  check("consent URL: PKCE S256 + offline + consent + state + nonce", u.searchParams.get("code_challenge_method") === "S256" && u.searchParams.get("access_type") === "offline" && u.searchParams.get("prompt") === "consent" && !!u.searchParams.get("state") && !!u.searchParams.get("nonce"));
  check("consent URL: read-only scopes only", u.searchParams.get("scope") === "openid email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly");
  check("consent URL: SEO client, not the student client", u.searchParams.get("client_id") === CLIENT_ID);
  check("consent URL: redirect URI is the SEO callback", u.searchParams.get("redirect_uri")?.endsWith("/api/admin/seo-intel/google/callback") === true);
  check("consent URL carries no secret / verifier", !start.url.includes(SECRET) && !/code_verifier/.test(start.url));
  check("state cookie is encrypted (v1:)", start.cookieValue.startsWith("v1:") && !start.cookieValue.includes(u.searchParams.get("state")!));

  const state = u.searchParams.get("state")!;
  const base = { adminId: "admin-a", cookieValue: start.cookieValue, state, code: "4/0MockCodeValue123", error: null };
  check("callback: missing cookie → state", (await completeAuthorization({ ...base, cookieValue: undefined })).ok === false && (await completeAuthorization({ ...base, cookieValue: undefined }) as { reason: string }).reason === "state");
  check("callback: wrong state → state", ((await completeAuthorization({ ...base, state: state + "x" })) as { reason: string }).reason === "state");
  const tampered = start.cookieValue.slice(0, -2) + (start.cookieValue.endsWith("00") ? "11" : "00");
  check("callback: tampered cookie → state", ((await completeAuthorization({ ...base, cookieValue: tampered })) as { reason: string }).reason === "state");
  check("callback: other admin → other-admin", ((await completeAuthorization({ ...base, adminId: "admin-b" })) as { reason: string }).reason === "other-admin");
  const expired = encryptSecret(JSON.stringify({ s: state, v: "v", n: "n", a: "admin-a", e: Date.now() - 1000 }));
  check("callback: expired → expired", ((await completeAuthorization({ ...base, cookieValue: expired })) as { reason: string }).reason === "expired");
  check("callback: Google error → denied", ((await completeAuthorization({ ...base, code: null, error: "access_denied" })) as { reason: string }).reason === "denied");
  check("callback: malformed code → bad-request", ((await completeAuthorization({ ...base, code: "<script>" })) as { reason: string }).reason === "bad-request");

  // Student login config untouched by everything above
  const providers = await prisma.setting.findUnique({ where: { key: "auth.providers" } });
  check("student auth.providers still holds its own client", JSON.stringify(providers?.value ?? {}).includes("studentloginclientxyz"));

  await clearAll();
  console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
