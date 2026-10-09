/**
 * Instagram API connection — library regression against a LOCAL mock of
 * graph.instagram.com (scripts/mock-meta-graph.mjs). Never talks to Meta:
 * every outbound fetch is checked and anything not aimed at the mock fails
 * the suite. All tokens are fake, generated per run.
 *
 *   set -a; . ./.env; set +a     # DATABASE_URL must be an *igstudio* scratch DB (part C writes one Setting row)
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ig-meta.ts
 */
import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { CONNECTION_SETTING_KEY, getConnectionConfigView, getLastConnectionResult, runConnectionTest, saveConnectionResult, tokenExpiry, type ConnectionTestResult } from "@/lib/instagram/meta";
import { INSTAGRAM_PUBLISHING_AVAILABLE } from "@/lib/instagram/types";
import { MOCK_USER_ID, mockToken, startMockGraph } from "./mock-meta-graph.mjs";

const PORT = Number(process.env.MOCK_GRAPH_PORT ?? 3198);
let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (ok) passes++;
  else failures++;
}

const IG_VARS = ["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_USER_ID", "INSTAGRAM_TOKEN_SET_AT", "INSTAGRAM_APP_SECRET", "INSTAGRAM_GRAPH_API_VERSION", "INSTAGRAM_GRAPH_API_BASE"];
function setEnv(vars: Record<string, string | undefined>) {
  for (const k of IG_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
}

// Capture all console output (to prove the token is never logged).
const logged: string[] = [];
for (const m of ["log", "error", "warn", "info", "debug"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    orig(...args);
  };
}

async function main() {
  const { server, stats, base } = await startMockGraph(PORT);
  const realFetch = globalThis.fetch;
  let strayRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    if (!u.startsWith(base + "/")) {
      strayRequests++;
      throw new Error(`blocked outbound request to ${u.slice(0, 40)}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const tokens: string[] = [];
  const results: ConnectionTestResult[] = [];
  const reset = () => {
    stats.requests.length = 0;
    stats.tokenInUrl = 0;
    stats.nonGet = 0;
    stats.missingAuth = 0;
  };
  async function scenario(name: string, extra: Record<string, string | undefined> = {}) {
    const token = mockToken(name);
    tokens.push(token);
    setEnv({ INSTAGRAM_ACCESS_TOKEN: token, INSTAGRAM_GRAPH_API_BASE: base, INSTAGRAM_USER_ID: MOCK_USER_ID, ...extra });
    reset();
    const r = await runConnectionTest();
    results.push(r);
    return { r, token, requests: [...stats.requests] };
  }

  try {
    // ------------------------------------------------------------------ A. scenarios
    console.log("\n--- A. Connection scenarios (mock Meta API) ---");
    {
      setEnv({ INSTAGRAM_GRAPH_API_BASE: base });
      reset();
      const r = await runConnectionTest();
      results.push(r);
      check("No token → NOT_CONFIGURED, no request made", r.status === "NOT_CONFIGURED" && !r.ok && stats.requests.length === 0, r);
      const v = getConnectionConfigView();
      check("No token → config view says not configured, no fingerprint", !v.tokenConfigured && v.tokenFingerprint === null && v.expiry.state === "unknown");
    }
    {
      const { r, requests } = await scenario("valid", { INSTAGRAM_TOKEN_SET_AT: new Date().toISOString() });
      check("Valid token → CONNECTED + ok", r.status === "CONNECTED" && r.ok, r);
      check("Valid → username mocktestseries.in, numeric user ID retrieved", r.account?.username === "mocktestseries.in" && r.account?.userId === MOCK_USER_ID, r.account);
      check("Valid → account type BUSINESS, media count read", r.account?.accountType === "BUSINESS" && r.account?.mediaCount === 12, r.account);
      check("Valid → publishing permission GRANTED (verified by a read), quota 0/50", r.publishPermission === "GRANTED" && r.publishingQuota?.usage === 0 && r.publishingQuota?.total === 50, r);
      check("Valid → all checks pass", r.checks.every((c) => c.state === "pass") && r.checks.length === 6, r.checks);
      check("Valid → exactly 2 requests: GET /me then GET /<id>/content_publishing_limit", requests.length === 2 && requests.every((q: { method: string }) => q.method === "GET") && /\/me$/.test(requests[0].path) && requests[1].path.endsWith(`/${MOCK_USER_ID}/content_publishing_limit`), requests);
      check("Valid → token sent in Authorization header, never in a URL", requests.every((q: { hasAuth: boolean }) => q.hasAuth) && stats.tokenInUrl === 0);
      check("Valid → default API version v25.0 used", requests.every((q: { path: string }) => q.path.startsWith("/v25.0/")), requests);
      check("Valid → no appsecret_proof when no app secret", requests.every((q: { proof: boolean }) => !q.proof));
    }
    {
      const { r } = await scenario("valid", { INSTAGRAM_USER_ID: undefined });
      const id = r.checks.find((c) => c.key === "userId");
      check("Valid but INSTAGRAM_USER_ID not pinned → CONNECTED, ID retrieved, warning to pin it", r.status === "CONNECTED" && id?.state === "warn" && id.detail.includes(MOCK_USER_ID), id);
    }
    {
      const { r } = await scenario("creator");
      check("Creator account (MEDIA_CREATOR) → CONNECTED", r.status === "CONNECTED" && r.account?.accountType === "MEDIA_CREATOR", r);
    }
    {
      const { r, requests } = await scenario("nopublish");
      check("Missing publishing permission → CONNECTED_NO_PUBLISH_PERMISSION, permission MISSING (not assumed)", r.status === "CONNECTED_NO_PUBLISH_PERMISSION" && r.publishPermission === "MISSING" && r.ok, r);
      check("Missing permission → reported clearly by name", r.summary.includes("instagram_business_content_publish") && r.checks.find((c) => c.key === "publishPermission")?.state === "warn");
      check("Missing permission → still only GET requests", requests.every((q: { method: string }) => q.method === "GET"));
    }
    {
      const { r, requests } = await scenario("expired");
      check("Expired token → TOKEN_EXPIRED, not ok", r.status === "TOKEN_EXPIRED" && !r.ok && r.error?.code === 190 && r.error?.subcode === 463, r);
      check("Expired → stops after /me, permission UNKNOWN", requests.length === 1 && r.publishPermission === "UNKNOWN");
    }
    {
      const { r, token } = await scenario("invalid");
      check("Invalid token → TOKEN_INVALID", r.status === "TOKEN_INVALID" && !r.ok, r);
      check("Invalid → Meta error that echoed the token is redacted", !JSON.stringify(r).includes(token) && !!r.error?.message.includes("[redacted]"), r.error);
    }
    {
      const { r, requests } = await scenario("wrong");
      check("Wrong Instagram account → WRONG_ACCOUNT, not ok", r.status === "WRONG_ACCOUNT" && !r.ok, r);
      check("Wrong account → username check fails naming both accounts", /someone\.else.*mocktestseries\.in/.test(r.checks.find((c) => c.key === "username")?.detail ?? ""));
      check("Wrong account → publishing permission not even queried", requests.length === 1 && r.publishPermission === "UNKNOWN");
    }
    {
      const { r } = await scenario("wrongid");
      check("Right username but different numeric ID than INSTAGRAM_USER_ID → WRONG_ACCOUNT", r.status === "WRONG_ACCOUNT" && r.checks.find((c) => c.key === "userId")?.state === "fail", r.checks);
    }
    {
      const { r } = await scenario("personal");
      check("Personal (non-professional) account → NOT_PROFESSIONAL", r.status === "NOT_PROFESSIONAL" && !r.ok, r);
    }
    {
      const { r } = await scenario("nobasic");
      check("No instagram_business_basic → PERMISSION_MISSING", r.status === "PERMISSION_MISSING" && !r.ok, r);
    }
    {
      const { r } = await scenario("ratelimit");
      check("Rate limit (#4) → RATE_LIMITED", r.status === "RATE_LIMITED" && !r.ok, r);
    }
    {
      const { r } = await scenario("garbage");
      check("Non-JSON 502 → API_ERROR, body not passed through", r.status === "API_ERROR" && !r.ok && !JSON.stringify(r).includes("bad gateway"), r);
    }
    {
      const t0 = Date.now();
      const { r } = await scenario("timeout");
      const took = Date.now() - t0;
      check("API timeout → TIMEOUT within ~10 s", r.status === "TIMEOUT" && !r.ok && took >= 9_500 && took < 12_000, { status: r.status, took });
    }
    {
      const { r } = await scenario("limittimeout");
      check("Timeout on the permission read → CONNECTED but permission UNKNOWN (never assumed granted)", r.status === "CONNECTED" && r.publishPermission === "UNKNOWN" && r.checks.find((c) => c.key === "publishPermission")?.state === "warn", r);
    }
    {
      const secret = "0123456789abcdef0123456789abcdef";
      const { r, requests } = await scenario("valid", { INSTAGRAM_APP_SECRET: secret, INSTAGRAM_GRAPH_API_VERSION: "v24.0" });
      check("App secret set → appsecret_proof sent on every request; version override honoured", r.status === "CONNECTED" && requests.every((q: { proof: boolean; path: string }) => q.proof && q.path.startsWith("/v24.0/")), requests);
      check("App secret never appears in the result", !JSON.stringify(r).includes(secret));
    }

    // ------------------------------------------------------------------ B. config + safety
    console.log("\n--- B. Config, expiry and safety guards ---");
    {
      setEnv({ INSTAGRAM_ACCESS_TOKEN: mockToken("valid"), INSTAGRAM_GRAPH_API_BASE: "https://evil.example.com" });
      const v = getConnectionConfigView();
      check("Non-loopback INSTAGRAM_GRAPH_API_BASE is refused (token can only go to Meta or 127.0.0.1)", v.warnings.some((w) => w.includes("not allowed")), v.warnings);
      setEnv({ INSTAGRAM_ACCESS_TOKEN: mockToken("valid"), INSTAGRAM_GRAPH_API_BASE: "http://127.0.0.1.evil.com:80" });
      check("Look-alike loopback host refused", getConnectionConfigView().warnings.some((w) => w.includes("not allowed")));
      setEnv({ INSTAGRAM_ACCESS_TOKEN: mockToken("valid"), INSTAGRAM_USER_ID: "abc", INSTAGRAM_TOKEN_SET_AT: "yesterday", INSTAGRAM_GRAPH_API_VERSION: "latest" });
      const w = getConnectionConfigView();
      check("Bad INSTAGRAM_USER_ID / TOKEN_SET_AT / version are ignored with warnings", w.userIdConfigured === null && w.tokenSetAt === null && w.apiVersion === "v25.0" && w.warnings.length === 3, w.warnings);
      const t = mockToken("valid");
      setEnv({ INSTAGRAM_ACCESS_TOKEN: t });
      check("Config view exposes yes/no + 8-char fingerprint only", JSON.stringify(getConnectionConfigView()).includes(t) === false && /^[0-9a-f]{8}$/.test(getConnectionConfigView().tokenFingerprint ?? ""));
    }
    {
      const now = new Date("2026-10-09T00:00:00Z");
      const day = 86_400_000;
      check("Expiry: unknown without install date", tokenExpiry(null, now).state === "unknown");
      check("Expiry: fresh token → ok, 60 days", tokenExpiry(now, now).state === "ok" && tokenExpiry(now, now).daysLeft === 60);
      check("Expiry: 50 days old → soon (warning)", tokenExpiry(new Date(now.getTime() - 50 * day), now).state === "soon");
      check("Expiry: 61 days old → expired", tokenExpiry(new Date(now.getTime() - 61 * day), now).state === "expired");
    }
    {
      const src = readFileSync("lib/instagram/meta.ts", "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      check("Publishing still disabled in code (INSTAGRAM_PUBLISHING_AVAILABLE === false)", INSTAGRAM_PUBLISHING_AVAILABLE === false);
      check("meta.ts only issues GET (no POST/DELETE/media_publish/media containers)", /method: "GET"/.test(code) && !/"(POST|DELETE|PUT|PATCH)"/.test(code) && !/media_publish|\/media\b|scheduled/i.test(code));
      check("meta.ts is server-only and allow-lists its two read endpoints", src.startsWith('import "server-only";') && src.includes("ALLOWED_PATH"));
      check("meta.ts never logs", !/console\./.test(code));

      // Only meta.ts may read the token; client components may import types only.
      const files: string[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = path.join(d, f);
          if (f === "node_modules" || f === ".next" || f.startsWith(".")) continue;
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.(ts|tsx|js|mjs)$/.test(f)) files.push(p);
        }
      };
      for (const d of ["app", "components", "lib", "proxy.ts"]) {
        try {
          if (statSync(d).isDirectory()) walk(d);
          else files.push(d);
        } catch {}
      }
      const readers = files.filter((f) => readFileSync(f, "utf8").includes("INSTAGRAM_ACCESS_TOKEN"));
      check("Only lib/instagram/meta.ts reads INSTAGRAM_ACCESS_TOKEN (app/components/lib)", readers.length === 1 && readers[0] === path.join("lib", "instagram", "meta.ts"), readers);
      const clientImporters = files.filter((f) => {
        const s = readFileSync(f, "utf8");
        return /^["']use client["']/.test(s.trimStart()) && /from "@\/lib\/instagram\/meta"/.test(s) && !/import type [^;]+from "@\/lib\/instagram\/meta"/.test(s);
      });
      check("No client component imports meta.ts at runtime (type-only imports)", clientImporters.length === 0, clientImporters);
      check("No NEXT_PUBLIC_ Instagram variable anywhere", !files.some((f) => /NEXT_PUBLIC_INSTAGRAM/.test(readFileSync(f, "utf8"))));
    }

    // ------------------------------------------------------------------ C. stored result (scratch DB)
    console.log("\n--- C. Last result storage (scratch DB) ---");
    const db = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "").split("/").pop() ?? "";
    if (!/igstudio/.test(db)) {
      check("Part C needs an *igstudio* scratch DB", false, db);
    } else {
      const before = await prisma.setting.findUnique({ where: { key: CONNECTION_SETTING_KEY } });
      const { r, token } = await scenario("valid");
      await saveConnectionResult(r, "fixture-actor");
      const back = await getLastConnectionResult();
      check("Result saved to Setting instagram.connection and read back", back?.status === "CONNECTED" && back.account?.userId === MOCK_USER_ID);
      const row = await prisma.setting.findUnique({ where: { key: CONNECTION_SETTING_KEY } });
      check("Stored row holds no token", !JSON.stringify(row?.value).includes(token) && !JSON.stringify(row?.value).includes("IGAAMOCK"));
      if (before) await prisma.setting.update({ where: { key: CONNECTION_SETTING_KEY }, data: { value: before.value as object } });
      else await prisma.setting.delete({ where: { key: CONNECTION_SETTING_KEY } });
    }

    // ------------------------------------------------------------------ D. leakage summary
    console.log("\n--- D. Token leakage ---");
    const allResults = JSON.stringify(results);
    check(`No fake token in any of ${results.length} results`, tokens.every((t) => !allResults.includes(t)));
    const allLogs = logged.join("\n");
    check("No fake token in anything logged during the run", tokens.every((t) => !allLogs.includes(t)) && !/IGAAMOCK/.test(allLogs));
    check("Mock never saw a token in a URL, never got a non-GET, never got an unauthenticated call", stats.tokenInUrl === 0 && stats.nonGet === 0, stats);
    check("No outbound request left this machine (all went to the mock)", strayRequests === 0, strayRequests);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    await prisma.$disconnect();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
