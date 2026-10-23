/**
 * Mock of the Google endpoints SEO Intelligence uses (OAuth consent + token +
 * revoke, Search Console, GA4 Data API) for scripts/verify-seo-intel-http.mjs.
 * Never talks to Google. Point the app at it with
 * SEO_GOOGLE_TEST_BASE_URL=http://127.0.0.1:<port>.
 *
 *   node scripts/mock-google-seo.mjs 3542     # 127.0.0.1 only
 *
 * The consent page auto-approves. It checks client_id, redirect_uri, scopes and
 * PKCE (S256) exactly like Google would. Scenario (POST /__mock/control
 * {"scenario": "..."}): ok, denied, noRefresh, missingScope, badAud, unverified,
 * exchangeError (echoes the code in its error, to prove redaction), invalidGrant
 * (refresh fails), noSite, ga4Forbidden (echoes the bearer token in its error),
 * gscGarbage (non-JSON), gscPage2Error (Search Console 500 for any startRow > 0, to
 * prove a failure mid-pagination keeps the last good data).
 * gscRows (POST /__mock/control {"gscRows": n}): how many rows each Search Console
 * table has (default 5); every searchAnalytics and GA4 request body is kept for
 * GET /__mock/requests.
 *
 * Revocation is GRANT-WIDE, like Google: revoking any token of an account ends
 * that account's whole grant (every refresh + access token issued to it so far);
 * a later consent starts a new grant.
 *
 * PageSpeed (GET /pagespeedonline/v5/runPagespeed) and Chrome UX Report (POST
 * /crux/v1/records:queryRecord) require the mock API key in the X-goog-api-key
 * HEADER (a `key=` query parameter is recorded as a URL leak). psiScenario
 * (POST /__mock/control {"psiScenario": "..."}): ok, psiError (desktop /exams →
 * 500), quota (429), badKey (403 echoing the key, to prove redaction), slow
 * (answers after 3 s), cruxNoData (CrUX 404).
 *
 * GET /__mock/stats → request counts + revoked tokens; GET /__mock/grants →
 * per-account grant epoch + live refresh tokens; GET /__mock/secrets → every
 * secret value issued or received (for the leak scan).
 */
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] ?? 3542);
export const MOCK_CLIENT_ID = "123456789012-mockseoclientabcdefghijk.apps.googleusercontent.com";
export const MOCK_CLIENT_SECRET = "GOCSPX-mockSeoSecret-1234567890abc";
// Built at runtime so no API-key-shaped literal sits in source control.
export const MOCK_PSI_KEY = ["AIza", "SyMockPageSpeedKey0123456789abcdefg"].join("");
const SCOPE_GSC = "https://www.googleapis.com/auth/webmasters.readonly";
const SCOPE_GA4 = "https://www.googleapis.com/auth/analytics.readonly";

const state = {
  scenario: "ok",
  email: "seo-owner@example.test",
  codes: new Map(), // code -> { challenge, nonce, redirectUri, used }
  accounts: new Map(), // email -> { epoch } — bumping the epoch revokes the whole grant
  refresh: new Map(), // refresh -> { email, epoch }
  access: new Map(), // access -> { email, epoch }
  secrets: new Set([MOCK_CLIENT_SECRET, MOCK_PSI_KEY]),
  psiScenario: "ok",
  psiCalls: [],
  gscRows: 5,
  gscBodies: [],
  ga4Bodies: [],
  revoked: [],
  stats: {},
  urlLeaks: [],
};

const rand = (n = 24) => crypto.randomBytes(n).toString("base64url");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const bump = (k) => (state.stats[k] = (state.stats[k] ?? 0) + 1);
const account = (email) => {
  if (!state.accounts.has(email)) state.accounts.set(email, { epoch: 0 });
  return state.accounts.get(email);
};
const issue = (map, token, email) => map.set(token, { email, epoch: account(email).epoch });
const live = (rec) => Boolean(rec && account(rec.email).epoch === rec.epoch);
const subOf = (email) => BigInt(`0x${crypto.createHash("sha256").update(email).digest("hex").slice(0, 15)}`).toString();

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain" : "application/json", ...headers });
  res.end(text);
}

async function readBody(req) {
  let data = "";
  for await (const c of req) data += c;
  return data;
}

function bearer(req) {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

const DEVICES = ["MOBILE", "DESKTOP", "TABLET"];
const COUNTRIES = ["ind", "usa", "are", "npl"];
const gscKey = (kind, i) =>
  kind === "date"
    ? new Date(Date.UTC(2026, 8, 20 + i)).toISOString().slice(0, 10)
    : kind === "query"
      ? i === 4
        ? '=HYPERLINK("http://evil.example","click")' // CSV formula-injection probe
        : `ruhs mo mock test ${i + 1}`
      : kind === "device"
        ? DEVICES[i]
        : kind === "country"
          ? COUNTRIES[i]
          : `https://mocktestseries.in/exams/sample-${(i % 7) + 1}`;
const gscRows = (dims, limit, startRow = 0) => {
  if (dims.length === 0) return [{ clicks: 1234, impressions: 56789, ctr: 0.0217, position: 14.3 }];
  const kind = dims[0];
  const total = kind === "date" ? 28 : kind === "device" ? DEVICES.length : kind === "country" ? COUNTRIES.length : state.gscRows;
  const out = [];
  for (let i = startRow; i < Math.min(total, startRow + limit); i++) {
    out.push({ keys: dims.map((d) => gscKey(d, i)), clicks: Math.max(0, 100 - i), impressions: 2000 - i, ctr: 0.05, position: 3 + (i % 40) });
  }
  return out;
};

const ga4Report = (req) => {
  const dims = (req.dimensions ?? []).map((d) => d.name);
  const metrics = (req.metrics ?? []).map((m) => m.name);
  const mv = (i) => metrics.map((m) => ({ value: m === "engagementRate" ? "0.61" : String(500 - i * 7) }));
  if (dims.length === 0) return { metricHeaders: metrics.map((name) => ({ name })), rows: [{ metricValues: mv(0) }] };
  const keys =
    dims[0] === "date"
      ? Array.from({ length: 28 }, (_, i) => `202609${String(i + 1).padStart(2, "0")}`)
      : dims[0] === "sessionDefaultChannelGroup"
        ? ["Organic Search", "Direct", "Organic Social"]
        : req.dimensionFilter?.filter?.stringFilter?.value === "Organic Search"
          ? ["/exams/rajasthan-medical-officer/preparation-strategy", "/"]
          : ["/", "/exams/ruhs-mo", "/plans-and-pricing"];
  return {
    dimensionHeaders: dims.map((name) => ({ name })),
    metricHeaders: metrics.map((name) => ({ name })),
    rows: keys.map((k, i) => ({ dimensionValues: [{ value: k }], metricValues: mv(i) })),
  };
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  bump(`${req.method} ${p.replace(/\/sites\/[^/]+\//, "/sites/:site/")}`);
  // A secret must never travel in a URL query.
  for (const [k] of url.searchParams) if (/token|secret|verifier|^key$/i.test(k)) state.urlLeaks.push(`${p}?${k}`);
  if (url.search.includes(MOCK_PSI_KEY)) state.urlLeaks.push(`${p}?<api key value>`);

  try {
    if (p === "/__mock/control" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.scenario) state.scenario = body.scenario;
      if (Number.isInteger(body.gscRows)) state.gscRows = body.gscRows;
      if (body.email) state.email = body.email;
      if (body.psiScenario) state.psiScenario = body.psiScenario;
      if (body.resetPsiCalls) state.psiCalls = [];
      return send(res, 200, { scenario: state.scenario, psiScenario: state.psiScenario });
    }
    if (p === "/__mock/stats") return send(res, 200, { scenario: state.scenario, stats: state.stats, revoked: state.revoked, urlLeaks: state.urlLeaks, psiCalls: state.psiCalls });
    if (p === "/__mock/secrets") return send(res, 200, { secrets: [...state.secrets] });
    if (p === "/__mock/requests") return send(res, 200, { gsc: state.gscBodies, ga4: state.ga4Bodies });
    if (p === "/__mock/grants") {
      const grants = {};
      for (const [email, a] of state.accounts) grants[email] = { epoch: a.epoch, liveRefresh: [...state.refresh.values()].filter((r) => r.email === email && live(r)).length };
      return send(res, 200, { grants });
    }

    if (p === "/o/oauth2/v2/auth" && req.method === "GET") {
      const q = url.searchParams;
      const redirectUri = q.get("redirect_uri");
      const scopes = (q.get("scope") ?? "").split(" ");
      if (q.get("client_id") !== MOCK_CLIENT_ID) return send(res, 400, "Error 401: invalid_client");
      if (!redirectUri || !/\/api\/admin\/seo-intel\/google\/callback$/.test(redirectUri)) return send(res, 400, "Error 400: redirect_uri_mismatch");
      if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("state")) {
        return send(res, 400, "Error 400: invalid_request");
      }
      if (q.get("access_type") !== "offline" || !scopes.includes(SCOPE_GSC) || !scopes.includes(SCOPE_GA4)) return send(res, 400, "Error 400: bad scopes/offline");
      const back = new URL(redirectUri);
      back.searchParams.set("state", q.get("state"));
      if (state.scenario === "denied") back.searchParams.set("error", "access_denied");
      else {
        const code = `4/0Mock${rand(30)}`;
        state.secrets.add(code);
        state.codes.set(code, { challenge: q.get("code_challenge"), nonce: q.get("nonce"), redirectUri, used: false, email: state.email });
        back.searchParams.set("code", code);
        back.searchParams.set("scope", scopes.join(" "));
      }
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }

    if (p === "/token" && req.method === "POST") {
      const f = new URLSearchParams(await readBody(req));
      for (const k of ["code", "code_verifier", "refresh_token", "client_secret"]) if (f.get(k)) state.secrets.add(f.get(k));
      if (f.get("client_id") !== MOCK_CLIENT_ID || f.get("client_secret") !== MOCK_CLIENT_SECRET) return send(res, 401, { error: "invalid_client" });
      if (f.get("grant_type") === "authorization_code") {
        const entry = state.codes.get(f.get("code"));
        if (state.scenario === "exchangeError") return send(res, 400, { error: "invalid_grant", error_description: `Bad code ${f.get("code")} for secret ${f.get("client_secret")}` });
        if (!entry || entry.used) return send(res, 400, { error: "invalid_grant", error_description: "Code already used or unknown." });
        entry.used = true;
        if (entry.redirectUri !== f.get("redirect_uri")) return send(res, 400, { error: "redirect_uri_mismatch" });
        const challenge = crypto.createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
        if (challenge !== entry.challenge) return send(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed." });
        const access = `ya29.Mock${rand()}`;
        const refresh = `1//0Mock${rand()}`;
        issue(state.access, access, entry.email);
        state.secrets.add(access);
        state.secrets.add(refresh);
        if (state.scenario !== "noRefresh") issue(state.refresh, refresh, entry.email);
        const now = Math.floor(Date.now() / 1000);
        const idToken = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
          iss: "https://accounts.google.com",
          aud: state.scenario === "badAud" ? "someone-else.apps.googleusercontent.com" : MOCK_CLIENT_ID,
          sub: subOf(entry.email),
          email: entry.email,
          email_verified: state.scenario !== "unverified",
          nonce: entry.nonce,
          iat: now,
          exp: now + 3600,
        })}.${rand(32)}`;
        state.secrets.add(idToken);
        const body = {
          access_token: access,
          expires_in: 3599,
          token_type: "Bearer",
          id_token: idToken,
          scope: ["openid", "https://www.googleapis.com/auth/userinfo.email", SCOPE_GSC, ...(state.scenario === "missingScope" ? [] : [SCOPE_GA4])].join(" "),
          ...(state.scenario === "noRefresh" ? {} : { refresh_token: refresh }),
        };
        return send(res, 200, body);
      }
      if (f.get("grant_type") === "refresh_token") {
        const entry = state.refresh.get(f.get("refresh_token"));
        if (state.scenario === "invalidGrant" || !live(entry)) return send(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        const access = `ya29.Mock${rand()}`;
        issue(state.access, access, entry.email);
        state.secrets.add(access);
        return send(res, 200, { access_token: access, expires_in: 3599, token_type: "Bearer", scope: `${SCOPE_GSC} ${SCOPE_GA4}` });
      }
      return send(res, 400, { error: "unsupported_grant_type" });
    }

    if (p === "/revoke" && req.method === "POST") {
      const token = new URLSearchParams(await readBody(req)).get("token");
      const rec = state.refresh.get(token) ?? state.access.get(token);
      if (!rec) return send(res, 400, { error: "invalid_token" });
      // Grant-wide: every token this account was issued so far stops working.
      if (live(rec)) account(rec.email).epoch++;
      state.revoked.push(rec.email);
      return send(res, 200, {});
    }

    if (p === "/pagespeedonline/v5/runPagespeed" || p === "/crux/v1/records:queryRecord") {
      const apiKey = req.headers["x-goog-api-key"];
      const target = url.searchParams.get("url");
      const strategy = url.searchParams.get("strategy");
      state.psiCalls.push({ api: p.startsWith("/crux") ? "crux" : "psi", target, strategy, headerKey: apiKey === MOCK_PSI_KEY, t: Date.now() });
      if (state.psiScenario === "slow") await new Promise((r) => setTimeout(r, 3000));
      if (state.psiScenario === "badKey" || apiKey !== MOCK_PSI_KEY) {
        return send(res, 400, { error: { code: 400, status: "INVALID_ARGUMENT", message: `API key not valid. Please pass a valid API key. key=${apiKey} (${apiKey})` } });
      }
      if (state.psiScenario === "quota") return send(res, 429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric 'Queries'." } });
      if (p.startsWith("/crux")) {
        if (req.method !== "POST") return send(res, 405, {});
        const body = JSON.parse(await readBody(req));
        if (body.origin !== "https://mocktestseries.in" || body.url) return send(res, 400, { error: { status: "INVALID_ARGUMENT", message: "origin only" } });
        if (state.psiScenario === "cruxNoData") return send(res, 404, { error: { code: 404, status: "NOT_FOUND", message: "chrome ux report data not found" } });
        const phone = body.formFactor === "PHONE";
        const metric = (p75, d) => ({ histogram: [{ start: 0, density: d[0] }, { density: d[1] }, { density: d[2] }], percentiles: { p75 } });
        return send(res, 200, {
          record: {
            key: { origin: body.origin, formFactor: body.formFactor },
            metrics: {
              largest_contentful_paint: metric(phone ? 2900 : 1800, [0.7, 0.2, 0.1]),
              interaction_to_next_paint: metric(phone ? 180 : 90, [0.8, 0.15, 0.05]),
              cumulative_layout_shift: metric(phone ? "0.12" : "0.03", [0.75, 0.2, 0.05]),
              first_contentful_paint: metric(phone ? 1700 : 1100, [0.8, 0.15, 0.05]),
              experimental_time_to_first_byte: metric(phone ? 950 : 600, [0.6, 0.3, 0.1]),
            },
            collectionPeriod: { firstDate: { year: 2026, month: 9, day: 22 }, lastDate: { year: 2026, month: 10, day: 19 } },
          },
        });
      }
      if (!target || !target.startsWith("https://mocktestseries.in/")) return send(res, 400, { error: { status: "INVALID_ARGUMENT", message: "foreign url" } });
      if (state.psiScenario === "psiError" && strategy === "desktop" && target.endsWith("/exams")) {
        return send(res, 500, { error: { code: 500, status: "INTERNAL", message: "Lighthouse returned error: FAILED_DOCUMENT_REQUEST." } });
      }
      const mobile = strategy === "mobile";
      const home = target === "https://mocktestseries.in/";
      const fieldMetrics = (lcp) => ({
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: lcp, category: lcp <= 2500 ? "FAST" : "AVERAGE" },
        INTERACTION_TO_NEXT_PAINT: { percentile: 150, category: "FAST" },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 8, category: "FAST" },
        FIRST_CONTENTFUL_PAINT_MS: { percentile: 1500, category: "FAST" },
        EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 700, category: "FAST" },
      });
      return send(res, 200, {
        id: target,
        analysisUTCTimestamp: new Date().toISOString(),
        loadingExperience: home ? { id: target, metrics: fieldMetrics(2300), overall_category: "FAST" } : { id: "https://mocktestseries.in", metrics: fieldMetrics(2700), overall_category: "AVERAGE", origin_fallback: true },
        originLoadingExperience: { id: "https://mocktestseries.in", metrics: fieldMetrics(2700), overall_category: "AVERAGE" },
        lighthouseResult: {
          fetchTime: new Date().toISOString(),
          categories: { performance: { score: mobile ? 0.72 : 0.96 } },
          audits: {
            "largest-contentful-paint": { numericValue: mobile ? 3400.4 : 1200.2 },
            "cumulative-layout-shift": { numericValue: mobile ? 0.04 : 0.01 },
            "total-blocking-time": { numericValue: mobile ? 310 : 20 },
            "first-contentful-paint": { numericValue: mobile ? 1900 : 700 },
            "speed-index": { numericValue: mobile ? 4100 : 1300 },
          },
        },
      });
    }

    const token = bearer(req);
    if (p.startsWith("/webmasters/v3/") || p.startsWith("/v1beta/")) {
      if (!token || !live(state.access.get(token))) return send(res, 401, { error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid Credentials" } });
    }
    if (p === "/webmasters/v3/sites" && req.method === "GET") {
      if (state.scenario === "gscGarbage") return send(res, 200, "<html>oops</html>");
      const siteEntry = state.scenario === "noSite" ? [{ siteUrl: "https://other.example/", permissionLevel: "siteOwner" }] : [{ siteUrl: "sc-domain:mocktestseries.in", permissionLevel: "siteFullUser" }];
      return send(res, 200, { siteEntry });
    }
    const gsc = p.match(/^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/);
    if (gsc && req.method === "POST") {
      if (decodeURIComponent(gsc[1]) !== "sc-domain:mocktestseries.in") return send(res, 403, { error: { status: "PERMISSION_DENIED", message: "no access" } });
      const body = JSON.parse(await readBody(req));
      state.gscBodies.push({ dimensions: body.dimensions ?? [], rowLimit: body.rowLimit, startRow: body.startRow ?? 0 });
      if (state.scenario === "gscPage2Error" && (body.startRow ?? 0) > 0) return send(res, 500, { error: { code: 500, status: "INTERNAL", message: "Backend Error" } });
      // Search Console caps rowLimit at 25,000.
      return send(res, 200, { rows: gscRows(body.dimensions ?? [], Math.min(body.rowLimit ?? 1000, 25000), body.startRow ?? 0), responseAggregationType: "byProperty" });
    }
    if (p === "/v1beta/properties/553529096:batchRunReports" && req.method === "POST") {
      if (state.scenario === "ga4Forbidden") {
        return send(res, 403, { error: { code: 403, status: "PERMISSION_DENIED", message: `User does not have sufficient permissions for this property. token=${token} Bearer ${token}` } });
      }
      const body = JSON.parse(await readBody(req));
      state.ga4Bodies.push(body);
      // The GA4 Data API allows at most 5 requests per batch.
      if ((body.requests ?? []).length > 5) return send(res, 400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Too many requests in batch" } });
      return send(res, 200, { reports: (body.requests ?? []).map(ga4Report) });
    }
    if (p.startsWith("/v1beta/properties/")) return send(res, 403, { error: { status: "PERMISSION_DENIED", message: "wrong property" } });
    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock-google-seo on http://127.0.0.1:${PORT}`));
