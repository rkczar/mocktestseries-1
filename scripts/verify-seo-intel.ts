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
import { KEY_SETTING_KEY, clearApiKey, getKeyView, parseCrux, parsePsi, setApiKey } from "@/lib/seo-intel/pagespeed";
import { normalisePagespeedPath } from "@/lib/seo-intel/history";
import { HISTORY_PREFIX, INTEL_SETTINGS_KEY, comparisonEntry, getIntelSettings, listHistory, pruneHistory, recordHistory, saveIntelSettings } from "@/lib/seo-intel/history";

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

  // History, retention and settings
  await prisma.setting.deleteMany({ where: { OR: [{ key: { startsWith: HISTORY_PREFIX } }, { key: INTEL_SETTINGS_KEY }] } });
  const def = await getIntelSettings();
  check("settings default: daily sync OFF, 400 days", def.autoSyncEnabled === false && def.historyDays === 400);
  check("historyDays clamped to 30–1095", (await saveIntelSettings({ historyDays: 5 })).historyDays === 30 && (await saveIntelSettings({ historyDays: 99999 })).historyDays === 1095);
  await saveIntelSettings({ autoSyncEnabled: true, historyDays: 60 });
  const s2 = await getIntelSettings();
  check("settings saved", s2.autoSyncEnabled === true && s2.historyDays === 60);
  const gsc = { property: "sc-domain:mocktestseries.in", range: { start: "2026-09-01", end: "2026-09-28" }, totals: { clicks: 10, impressions: 100, ctr: 0.1, position: 5 }, daily: [], topQueries: Array.from({ length: 25 }, (_, i) => ({ key: `q${i}`, clicks: 1, impressions: 1, ctr: 1, position: 1 })), topPages: [] };
  const ga4 = { propertyId: "553529096", range: { start: "2026-09-01", end: "2026-09-28" }, totals: { activeUsers: 7, sessions: 9, screenPageViews: 20, engagementRate: 0.5 }, daily: [], channels: [], landingPages: [] };
  const day = new Date("2026-10-22T06:00:00Z");
  check("recordHistory needs at least one fresh half", (await recordHistory({ gsc: null, ga4: null }, day)) === null);
  check("recordHistory stores the IST day", (await recordHistory({ gsc, ga4: null }, day)) === "2026-10-22");
  await recordHistory({ gsc: null, ga4 }, new Date("2026-10-22T10:00:00Z"));
  let h = await listHistory();
  check("same-day sync merges halves (GA4 added, GSC kept)", h.length === 1 && h[0].gsc?.totals.clicks === 10 && h[0].ga4?.totals.sessions === 9);
  check("history keeps only top 10 rows", h[0].gsc?.topQueries.length === 10);
  check("IST day boundary: 20:00 UTC counts as the next IST day", (await recordHistory({ gsc, ga4 }, new Date("2026-10-22T20:00:00Z"))) === "2026-10-23");
  for (const d of ["2026-10-14", "2026-08-01", "2026-08-24"]) {
    await prisma.setting.create({ data: { key: `${HISTORY_PREFIX}${d}`, value: { date: d, at: `${d}T00:00:00Z`, gsc: { range: gsc.range, totals: { ...gsc.totals, clicks: 5 }, topQueries: [], topPages: [] }, ga4: null } } });
  }
  h = await listHistory();
  check("history listed newest first", h.map((e) => e.date).join(",") === "2026-10-23,2026-10-22,2026-10-14,2026-08-24,2026-08-01");
  check("comparison = newest entry ≥7 days older", comparisonEntry(h)?.date === "2026-10-14");
  check("comparison falls back to oldest", comparisonEntry([h[0], h[1]])?.date === "2026-10-22");
  check("no comparison with one entry", comparisonEntry([h[0]]) === null);
  const pruned = await pruneHistory(60, new Date("2026-10-23T06:00:00Z"));
  h = await listHistory();
  // 2026-10-23 minus 60 days = 2026-08-24: kept (exactly 60 days), 2026-08-01 deleted.
  check("retention 60 days deletes only entries older than 60 days", pruned === 1 && h.map((e) => e.date).join(",") === "2026-10-23,2026-10-22,2026-10-14,2026-08-24");
  check("pruning never touches the snapshot/settings/client rows", Boolean(await prisma.setting.findUnique({ where: { key: INTEL_SETTINGS_KEY } })));
  await prisma.setting.deleteMany({ where: { OR: [{ key: { startsWith: HISTORY_PREFIX } }, { key: INTEL_SETTINGS_KEY }] } });

  // PageSpeed / CrUX
  const PSI_KEY = ["AIza", "SyUnitTestPageSpeedKey012345678abcd"].join("");
  check("redact removes Google API keys", !redact(`bad key ${PSI_KEY} and key=${PSI_KEY}`).includes("AIza"));
  check("googleFetch refuses an API key in the URL", await throws(() => googleFetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https%3A%2F%2Fmocktestseries.in%2F&key=${PSI_KEY}`, { method: "GET" })));
  check("googleFetch refuses PageSpeed for another site", await throws(() => googleFetch("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https%3A%2F%2Fevil.example%2F", { method: "GET" })));
  check("googleFetch refuses a look-alike site prefix", await throws(() => googleFetch("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https%3A%2F%2Fmocktestseries.in.evil.example%2F", { method: "GET" })));
  check("setApiKey rejects a non-key", await throws(() => setApiKey("not-a-key")));
  check("setApiKey rejects a too-short AIza key", await throws(() => setApiKey("AIzaShort")));
  const fp = await setApiKey(` ${PSI_KEY}\n`);
  const keyRow = JSON.stringify((await prisma.setting.findUnique({ where: { key: KEY_SETTING_KEY } }))?.value);
  check("API key stored encrypted (no plaintext)", !keyRow.includes(PSI_KEY) && keyRow.includes('"apiKeyCipher":"v1:'));
  const kv = await getKeyView();
  check("key view: installed + 8-char fingerprint, never the key", kv.installed && kv.fingerprint === fp.fingerprint && /^[0-9a-f]{8}$/.test(kv.fingerprint ?? "") && !JSON.stringify(kv).includes("AIza"));
  await clearApiKey();
  check("clearApiKey removes it", !(await getKeyView()).installed);
  check("paths: same-site only, private areas refused", normalisePagespeedPath("/exams") === "/exams" && normalisePagespeedPath(" / ") === "/" && [
    "https://evil.example/", "//evil.example", "/admin", "/admin/seo", "/api/health", "/student/dashboard", "exams", "/a b", "/<x>",
  ].every((x) => normalisePagespeedPath(x) === null));
  const ps = await saveIntelSettings({ pagespeedPaths: ["/", "/", "/admin", "/exams", "/a", "/b"] });
  check("pagespeedPaths de-duplicated, filtered, max 3", JSON.stringify(ps.pagespeedPaths) === JSON.stringify(["/", "/exams", "/a"]));
  check("pagespeedPaths fall back to defaults when none valid", JSON.stringify((await saveIntelSettings({ pagespeedPaths: ["/admin"] })).pagespeedPaths) === JSON.stringify(["/", "/exams", "/plans-and-pricing"]));
  await prisma.setting.deleteMany({ where: { key: INTEL_SETTINGS_KEY } });
  const fieldM = { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2600 }, INTERACTION_TO_NEXT_PAINT: { percentile: 210 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12 }, FIRST_CONTENTFUL_PAINT_MS: { percentile: 1500 }, EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 700 } };
  const pr = parsePsi(
    {
      loadingExperience: { metrics: fieldM, overall_category: "AVERAGE", origin_fallback: true },
      originLoadingExperience: { metrics: fieldM, overall_category: "AVERAGE" },
      lighthouseResult: { fetchTime: "2026-10-22T10:00:00.000Z", categories: { performance: { score: 0.876 } }, audits: { "largest-contentful-paint": { numericValue: 3100 }, "cumulative-layout-shift": { numericValue: 0.02 }, "total-blocking-time": { numericValue: 150 } } },
    },
    "2026-10-22T10:00:05.000Z"
  );
  check("parsePsi: score 0–100, lab metrics, fetch time", pr.ok && pr.score === 88 && pr.lab?.lcpMs === 3100 && pr.lab?.tbtMs === 150 && pr.fetchedAt === "2026-10-22T10:00:00.000Z");
  check("parsePsi: origin fallback → scope origin, CLS ÷100", pr.field?.scope === "origin" && pr.field.cls === 0.12 && pr.field.inpMs === 210);
  check("parsePsi: no score → error result", parsePsi({ lighthouseResult: {} }, "x").ok === false);
  const cr = parseCrux(
    { record: { metrics: { cumulative_layout_shift: { percentiles: { p75: "0.15" }, histogram: [{ density: 0.7 }, { density: 0.2 }, { density: 0.1 }] }, largest_contentful_paint: { percentiles: { p75: 2400 } } }, collectionPeriod: { firstDate: { year: 2026, month: 9, day: 1 }, lastDate: { year: 2026, month: 9, day: 28 } } } },
    "x"
  );
  check("parseCrux: string p75 parsed, densities, collection period", cr.metrics.cls?.p75 === 0.15 && cr.metrics.cls.good === 0.7 && cr.metrics.lcp?.p75 === 2400 && cr.metrics.inp === null && cr.collectionPeriod?.first === "2026-09-01");

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
