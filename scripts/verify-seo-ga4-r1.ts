/**
 * SEO/GA4 Release 1 checks on a DISPOSABLE database (name must contain "seoga4") against the
 * loopback Google mock (scripts/mock-google-seo.mjs, started here):
 *   - googleFetch retry: network error / 429 / 5xx retried (max 3 tries); 4xx and invalid_grant never;
 *     calls without `retry` (OAuth code exchange, revoke) never retried
 *   - full runSync survives injected 5xx/429/drops; one history row per day
 *   - history retention "keep forever" (0) never prunes; 30–1095 still clamp/prune
 *   - claimSignupEvent: once per student, 24 h window, race-safe
 *   - /exams/rpsc-fso redirect entry: 301, exact path, internal, no chain
 *
 *   DATABASE_URL=<mts_*seoga4*> AUTH_SECRET=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-seo-ga4-r1.ts
 */
import { spawn } from "node:child_process";

const dbUrl = process.env.DATABASE_URL ?? "";
if (!/seoga4/.test(dbUrl.split("/").pop() ?? "")) {
  console.error("Refusing to run: DATABASE_URL must be a scratch database whose name contains 'seoga4'.");
  process.exit(2);
}
const PORT = 3549;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.SEO_GOOGLE_TEST_BASE_URL = BASE;
process.env.SEO_RETRY_DELAY_MS = "20";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};
const control = (body: unknown) => fetch(`${BASE}/__mock/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const stats = async () => ((await (await fetch(`${BASE}/__mock/stats`)).json()) as { stats: Record<string, number> }).stats;
const count = (s: Record<string, number>, prefix: string) => Object.entries(s).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0);

async function main() {
  const mock = spawn(process.execPath, ["scripts/mock-google-seo.mjs", String(PORT)], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${BASE}/__mock/stats`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const { prisma } = await import("@/lib/prisma");
    const { googleFetch, getAccessToken, setClientCredentials, CONNECTION_SETTING_KEY, isRetriableStatus } = await import("@/lib/seo-intel/google");
    const { runSync, SNAPSHOT_SETTING_KEY } = await import("@/lib/seo-intel/sync");
    const { encryptSecret } = await import("@/lib/secret-cipher");
    const H = await import("@/lib/seo-intel/history");
    const { claimSignupEvent } = await import("@/lib/signup-tracking");
    const { LEGACY_REDIRECTS } = await import("@/lib/legacy-redirects");
    const { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET } = (await import("./mock-google-seo.mjs" as string).catch(() => ({}))) as { MOCK_CLIENT_ID?: string; MOCK_CLIENT_SECRET?: string };
    const clientId = MOCK_CLIENT_ID ?? "123456789012-mockseoclientabcdefghijk.apps.googleusercontent.com";
    const clientSecret = MOCK_CLIENT_SECRET ?? "GOCSPX-mockSeoSecret-1234567890abc";

    // ---------------------------------------------------------------- retry policy (pure)
    check("P1 429 and 5xx are retriable", [429, 500, 502, 503, 504].every(isRetriableStatus));
    check("P2 4xx (400 invalid_grant, 401, 403, 404) are not", [400, 401, 403, 404].every((s) => !isRetriableStatus(s)));

    // ---------------------------------------------------------------- googleFetch against the mock
    const sitesUrl = `${BASE}/webmasters/v3/sites`;
    const sitesCalls = async () => count(await stats(), "GET /webmasters/v3/sites");
    let before = await sitesCalls();
    await control({ failNext: { count: 1, status: 503, match: "/webmasters/v3/sites" } });
    let r = await googleFetch(sitesUrl, { method: "GET", accessToken: "x", retry: true });
    check("R1 one 503 then success → retried once", r.status !== 503 && (await sitesCalls()) - before === 2, `status ${r.status}`);

    before = await sitesCalls();
    await control({ failNext: { count: 2, status: 429, match: "/webmasters/v3/sites" } });
    r = await googleFetch(sitesUrl, { method: "GET", accessToken: "x", retry: true });
    check("R2 two 429s then success → 3 tries", r.status !== 429 && (await sitesCalls()) - before === 3);

    before = await sitesCalls();
    await control({ failNext: { count: 5, status: 500, match: "/webmasters/v3/sites" } });
    r = await googleFetch(sitesUrl, { method: "GET", accessToken: "x", retry: true });
    check("R3 persistent 500 → gives up after 3 tries, returns 500", r.status === 500 && (await sitesCalls()) - before === 3);
    await control({ failNext: { count: 0 } });

    before = await sitesCalls();
    await control({ failNext: { count: 1, status: "drop", match: "/webmasters/v3/sites" } });
    r = await googleFetch(sitesUrl, { method: "GET", accessToken: "x", retry: true });
    check("R4 dropped connection then success → retried", r.status !== 0 && (await sitesCalls()) - before === 2, `status ${r.status}`);

    before = await sitesCalls();
    await control({ failNext: { count: 1, status: 503, match: "/webmasters/v3/sites" } });
    r = await googleFetch(sitesUrl, { method: "GET", accessToken: "x" });
    check("R5 without retry flag (code exchange / revoke path) → exactly 1 try", r.status === 503 && (await sitesCalls()) - before === 1);
    await control({ failNext: { count: 0 } });

    before = await sitesCalls();
    await control({ failNext: { count: 3, status: 403, match: "/webmasters/v3/sites" } });
    r = await googleFetch(sitesUrl, { method: "GET", accessToken: "x", retry: true });
    check("R6 403 → never retried", r.status === 403 && (await sitesCalls()) - before === 1);
    await control({ failNext: { count: 0 } });

    // ---------------------------------------------------------------- connected state + invalid_grant
    await prisma.setting.deleteMany({ where: { key: { startsWith: "seo." } } });
    await setClientCredentials(clientId, clientSecret);
    const refresh = "1//mock-seeded-refresh-r1";
    await control({ seedRefresh: { token: refresh, email: "seo-owner@example.test" }, scenario: "ok" });
    const conn = (await prisma.setting.findUniqueOrThrow({ where: { key: CONNECTION_SETTING_KEY } })).value as Record<string, unknown>;
    await prisma.setting.update({ where: { key: CONNECTION_SETTING_KEY }, data: { value: { ...conn, refreshTokenCipher: encryptSecret(refresh), accountEmail: "seo-owner@example.test", grantedScopes: ["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/analytics.readonly"], connectedAt: new Date().toISOString() } } });

    const tokenCalls = async () => count(await stats(), "POST /token");
    before = await tokenCalls();
    await control({ failNext: { count: 1, status: 503, match: "/token" } });
    const t = await getAccessToken().then(() => true, () => false);
    check("T1 token endpoint 503 once → refresh retried and succeeds", t && (await tokenCalls()) - before === 2);

    await control({ scenario: "invalidGrant" });
    before = await tokenCalls();
    const ig = await getAccessToken().then(() => "ok", (e: Error) => e.message);
    const after = (await prisma.setting.findUniqueOrThrow({ where: { key: CONNECTION_SETTING_KEY } })).value as { needsReconnect?: boolean };
    check("T2 invalid_grant → exactly 1 token call (never retried)", (await tokenCalls()) - before === 1, ig);
    check("T3 invalid_grant → needsReconnect flagged", after.needsReconnect === true);
    await prisma.setting.update({ where: { key: CONNECTION_SETTING_KEY }, data: { value: { ...(after as object), needsReconnect: false, needsReconnectReason: undefined } as object } });
    await control({ scenario: "ok" });

    // ---------------------------------------------------------------- full sync with injected failures + history
    await prisma.setting.deleteMany({ where: { key: { startsWith: H.HISTORY_PREFIX } } });
    await control({ failNext: { count: 2, status: 503, match: "searchAnalytics" } });
    const s1 = await runSync(null, "scheduled");
    check("S1 runSync with 2 injected 503s on Search Console → ok", s1.ok === true, s1.message);
    await control({ failNext: { count: 1, status: 429, match: "batchRunReports" } });
    // the 1-minute throttle: backdate the last sync (never delete it)
    const snap = (await prisma.setting.findUniqueOrThrow({ where: { key: SNAPSHOT_SETTING_KEY } })).value as { lastSync: { at: string } };
    await prisma.setting.update({ where: { key: SNAPSHOT_SETTING_KEY }, data: { value: { ...snap, lastSync: { ...snap.lastSync, at: new Date(Date.now() - 10 * 60_000).toISOString() } } as object } });
    const s2 = await runSync(null, "scheduled");
    check("S2 second sync same day with a GA4 429 → ok", s2.ok === true, s2.message);
    const hist = await prisma.setting.count({ where: { key: { startsWith: H.HISTORY_PREFIX } } });
    check("S3 two syncs on one day → exactly 1 history row", hist === 1, `${hist}`);

    // ---------------------------------------------------------------- retention
    await prisma.setting.deleteMany({ where: { key: H.INTEL_SETTINGS_KEY } });
    check("H1 default retention = keep forever (0)", (await H.getIntelSettings()).historyDays === 0);
    const old = ["2020-01-01", "2023-06-30", "2025-01-01"].map((d) => `${H.HISTORY_PREFIX}${d}`);
    for (const key of old) await prisma.setting.upsert({ where: { key }, create: { key, value: { seeded: true } }, update: { value: { seeded: true } } });
    const keysBefore = (await prisma.setting.findMany({ where: { key: { startsWith: H.HISTORY_PREFIX } }, select: { key: true } })).map((x) => x.key).sort().join();
    check("H2 prune with keep-forever deletes nothing", (await H.pruneHistory(0)) === 0);
    const keysAfter = (await prisma.setting.findMany({ where: { key: { startsWith: H.HISTORY_PREFIX } }, select: { key: true } })).map((x) => x.key).sort().join();
    check("H3 every history row still present", keysBefore === keysAfter);
    check("H4 saving 0 keeps 0", (await H.saveIntelSettings({ historyDays: 0 })).historyDays === 0);
    check("H5 out-of-range still clamps (5→30, 5000→1095)", (await H.saveIntelSettings({ historyDays: 5 })).historyDays === 30 && (await H.saveIntelSettings({ historyDays: 5000 })).historyDays === 1095);
    check("H6 a finite retention still prunes old rows (control)", (await H.pruneHistory(30)) === 3);
    await H.saveIntelSettings({ historyDays: 0 });

    // ---------------------------------------------------------------- sign_up claim
    const mk = (createdAt: Date) =>
      { const tag = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`; return prisma.student.create({ data: { name: "R1 Signup", email: `r1-${tag}@example.test`, studentId: `R1${tag}`.slice(0, 20), authProvider: "OTP", createdAt } as never }); };
    const fresh = await mk(new Date());
    const results = await Promise.all(Array.from({ length: 6 }, () => claimSignupEvent(fresh.id)));
    check("U1 6 concurrent first renders → exactly 1 claim", results.filter(Boolean).length === 1);
    check("U2 later render / other browser → no claim", (await claimSignupEvent(fresh.id)) === false);
    const stale = await mk(new Date(Date.now() - 25 * 60 * 60_000));
    check("U3 account older than 24 h → no event (existing students never fire)", (await claimSignupEvent(stale.id)) === false);
    const nearEdge = await mk(new Date(Date.now() - 23 * 60 * 60_000));
    check("U4 account 23 h old, first visit → 1 event", (await claimSignupEvent(nearEdge.id)) === true);
    check("U5 claim row is the fixed id ga4signup:<studentId>", (await prisma.auditLog.count({ where: { id: `ga4signup:${fresh.id}` } })) === 1);
    await prisma.auditLog.deleteMany({ where: { id: { in: [fresh.id, nearEdge.id].map((id) => `ga4signup:${id}`) } } });
    await prisma.student.deleteMany({ where: { id: { in: [fresh.id, stale.id, nearEdge.id] } } });

    // ---------------------------------------------------------------- redirect entry
    const fsoR = LEGACY_REDIRECTS.find((x) => x.source === "/exams/rpsc-fso");
    check("D1 /exams/rpsc-fso → /exams/rajasthan-food-safety-officer, 301", fsoR?.destination === "/exams/rajasthan-food-safety-officer" && fsoR.statusCode === 301);
    check("D2 exact path only (no wildcard)", LEGACY_REDIRECTS.every((x) => !/[:*()]/.test(x.source)));
    check("D3 no chains / loops", LEGACY_REDIRECTS.every((x) => !LEGACY_REDIRECTS.some((o) => o.source === x.destination.split("#")[0])));
    const nextConfig = (await import("../next.config")).default as { redirects: () => Promise<{ source: string; destination: string; permanent?: boolean; statusCode?: number }[]> };
    const all = await nextConfig.redirects();
    const cfg = all.find((x) => x.source === "/exams/rpsc-fso");
    check("D4 next.config emits statusCode 301 (not permanent:true)", cfg?.statusCode === 301 && cfg.permanent === undefined);
    check("D5 other legacy redirects unchanged (permanent:true)", all.filter((x) => x.source !== "/exams/rpsc-fso" && LEGACY_REDIRECTS.some((l) => l.source === x.source)).every((x) => x.permanent === true));

    await prisma.$disconnect();
  } finally {
    mock.kill();
  }
  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
