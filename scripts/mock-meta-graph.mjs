/**
 * Mock of graph.instagram.com for the Instagram connection tests. Never talks
 * to Meta. The scenario is chosen by the (fake) token: IGAAMOCK<scenario>X<random>.
 *
 *   node scripts/mock-meta-graph.mjs 3199     # standalone, 127.0.0.1 only
 *
 * Scenarios: valid, nopublish, expired, invalid (echoes the token in its error,
 * to prove redaction), wrong (other username), personal, nobasic, ratelimit,
 * timeout (never answers within 10 s), garbage (non-JSON).
 * GET /__mock/stats → what the mock saw (token in URL? non-GET calls? paths).
 */
import http from "node:http";

export const MOCK_USER_ID = "17841400000000001";
export const MOCK_OTHER_USER_ID = "17841499999999999";

export function mockToken(scenario) {
  const rand = Array.from({ length: 48 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
  return `IGAAMOCK${scenario}X${rand}`;
}

export function startMockGraph(port) {
  const stats = { requests: [], tokenInUrl: 0, nonGet: 0, missingAuth: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__mock/stats") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(stats));
    }
    if (url.pathname === "/__mock/reset") {
      Object.assign(stats, { requests: [], tokenInUrl: 0, nonGet: 0, missingAuth: 0 });
      return res.end("{}");
    }
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    stats.requests.push({ method: req.method, path: url.pathname, fields: url.searchParams.get("fields"), hasAuth: !!token, proof: url.searchParams.has("appsecret_proof") });
    if (/IGAA|access_token/i.test(req.url)) stats.tokenInUrl++;
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") {
      stats.nonGet++;
      return json(405, { error: { message: "mock: only GET", code: 1 } });
    }
    if (!token) {
      stats.missingAuth++;
      return json(400, { error: { message: "An active access token must be used to query information about the current user.", type: "OAuthException", code: 2500 } });
    }
    const scenario = /^IGAAMOCK([a-z]+)X/.exec(token)?.[1] ?? "invalid";
    const isMe = /^\/v\d+\.\d\/me$/.test(url.pathname);
    const limit = /^\/v\d+\.\d\/(\d+)\/content_publishing_limit$/.exec(url.pathname);

    const me = (over = {}) =>
      json(200, { id: "26000000000000001", user_id: MOCK_USER_ID, username: "mocktestseries.in", account_type: "BUSINESS", name: "MockTestSeries.in", media_count: 12, ...over });
    const quota = () => json(200, { data: [{ quota_usage: 0, config: { quota_total: 50, quota_duration: 86400 } }] });
    const noPerm = () => json(403, { error: { message: "(#10) Application does not have permission for this action", type: "OAuthException", code: 10, fbtrace_id: "mock" } });

    if (!isMe && !limit) return json(404, { error: { message: "Unsupported get request.", type: "GraphMethodException", code: 100 } });
    switch (scenario) {
      case "valid":
        return isMe ? me() : limit[1] === MOCK_USER_ID ? quota() : noPerm();
      case "nopublish":
        return isMe ? me() : noPerm();
      case "creator":
        return isMe ? me({ account_type: "MEDIA_CREATOR" }) : quota();
      case "expired":
        return json(400, { error: { message: "Error validating access token: Session has expired on Thursday, 08-Oct-26 10:00:00 PDT.", type: "OAuthException", code: 190, error_subcode: 463 } });
      case "invalid":
        return json(400, { error: { message: `Invalid OAuth access token - Cannot parse access token ${token}`, type: "OAuthException", code: 190 } });
      case "wrong":
        return isMe ? me({ user_id: MOCK_OTHER_USER_ID, username: "someone.else" }) : quota();
      case "wrongid":
        return isMe ? me({ user_id: MOCK_OTHER_USER_ID }) : quota();
      case "personal":
        return isMe ? me({ account_type: "PERSONAL" }) : noPerm();
      case "nobasic":
        return noPerm();
      case "ratelimit":
        return json(400, { error: { message: "(#4) Application request limit reached", type: "OAuthException", code: 4 } });
      case "limittimeout":
        if (isMe) return me();
        return void setTimeout(quota, 12_000);
      case "timeout":
        return void setTimeout(me, 12_000);
      case "garbage":
        res.writeHead(502, { "content-type": "text/html" });
        return res.end(`<html>bad gateway ${token}</html>`);
      default:
        return json(400, { error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } });
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, stats, base: `http://127.0.0.1:${port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 3199);
  startMockGraph(port).then(({ base }) => console.log(`mock graph on ${base}`));
}
