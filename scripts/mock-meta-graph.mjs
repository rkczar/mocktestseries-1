/**
 * Mock of graph.instagram.com for the Instagram connection + publishing tests.
 * Never talks to Meta. The scenario is chosen by the (fake) token:
 * IGAAMOCK<scenario>X<random>.
 *
 *   node scripts/mock-meta-graph.mjs 3199     # standalone, 127.0.0.1 only
 *
 * Connection scenarios: valid, nopublish, expired, invalid (echoes the token in
 * its error, to prove redaction), wrong (other username), wrongid, personal,
 * nobasic, ratelimit, limittimeout, timeout (never answers within 10 s),
 * garbage (non-JSON), creator.
 *
 * Publishing (POST /<id>/media, /<id>/media_publish; GET /<container|media>,
 * GET /<id>/media). Item containers really FETCH their image_url and check it
 * is a JPEG, like Meta. Extra scenarios:
 *   slow        containers report IN_PROGRESS for their first 2 status reads
 *   procerror   item containers end in status ERROR
 *   badimage    container creation fails with "media download failed" (2207052)
 *   quotafull   content_publishing_limit reports 100/100
 *   pubtimeout  media_publish publishes, then answers after 4 s (test timeout is shorter)
 *   publost     media_publish publishes, then answers HTTP 502 garbage (response lost)
 *   pubfailonce first media_publish fails WITHOUT publishing (HTTP 500), later ones work
 *   blackout    media_publish publishes but never answers, and status reads fail
 *               while state.blackout is true (POST /__mock/control {"blackout":false} ends it)
 * POST /__mock/control {"failNextPublish":true} → the next media_publish fails (HTTP 500) without publishing.
 *
 * GET /__mock/stats → what the mock saw; GET /__mock/state → containers + published media.
 */
import http from "node:http";

export const MOCK_USER_ID = "17841400000000001";
export const MOCK_OTHER_USER_ID = "17841499999999999";

export function mockToken(scenario) {
  const rand = Array.from({ length: 48 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
  return `IGAAMOCK${scenario}X${rand}`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

export function startMockGraph(port) {
  const stats = { requests: [], tokenInUrl: 0, nonGet: 0, missingAuth: 0, tokenInBody: 0, imageFetches: [], publishCalls: 0 };
  const state = { containers: new Map(), media: [], seq: 1, blackout: true, blackoutHit: false, failedOnce: new Set() };
  const nextId = (prefix) => `${prefix}${String(state.seq++).padStart(8, "0")}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (status, body) => {
      if (res.headersSent) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/__mock/stats") return json(200, stats);
    if (url.pathname === "/__mock/state") return json(200, { containers: [...state.containers.values()], media: state.media, blackout: state.blackout });
    if (url.pathname === "/__mock/reset") {
      Object.assign(stats, { requests: [], tokenInUrl: 0, nonGet: 0, missingAuth: 0, tokenInBody: 0, imageFetches: [], publishCalls: 0 });
      state.containers.clear();
      state.media.length = 0;
      state.blackout = true;
      state.blackoutHit = false;
      state.failedOnce.clear();
      return json(200, {});
    }
    if (url.pathname === "/__mock/control") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (typeof body.blackout === "boolean") state.blackout = body.blackout;
      if (typeof body.failNextPublish === "boolean") state.failNextPublish = body.failNextPublish;
      return json(200, { blackout: state.blackout, failNextPublish: !!state.failNextPublish });
    }

    const raw = req.method === "POST" ? await readBody(req) : "";
    const form = new URLSearchParams(raw);
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    stats.requests.push({ method: req.method, path: url.pathname, fields: url.searchParams.get("fields"), hasAuth: !!token, proof: url.searchParams.has("appsecret_proof") || form.has("appsecret_proof"), params: Object.fromEntries(form) });
    if (/IGAA|access_token/i.test(req.url)) stats.tokenInUrl++;
    if (/IGAA|access_token/i.test(raw)) stats.tokenInBody++;
    if (req.method !== "GET") stats.nonGet++;
    if (req.method !== "GET" && req.method !== "POST") return json(405, { error: { message: "mock: method not allowed", code: 1 } });
    if (!token) {
      stats.missingAuth++;
      return json(400, { error: { message: "An active access token must be used to query information about the current user.", type: "OAuthException", code: 2500 } });
    }
    const scenario = /^IGAAMOCK([a-z]+)X/.exec(token)?.[1] ?? "invalid";
    const p = url.pathname;
    const isMe = /^\/v\d+\.\d\/me$/.test(p);
    const limit = /^\/v\d+\.\d\/(\d+)\/content_publishing_limit$/.exec(p);
    const createMedia = req.method === "POST" ? /^\/v\d+\.\d\/(\d+)\/media$/.exec(p) : null;
    const publish = req.method === "POST" ? /^\/v\d+\.\d\/(\d+)\/media_publish$/.exec(p) : null;
    const listMedia = req.method === "GET" ? /^\/v\d+\.\d\/(\d+)\/media$/.exec(p) : null;
    const node = req.method === "GET" ? /^\/v\d+\.\d\/(\d+)$/.exec(p) : null;

    const me = (over = {}) =>
      json(200, { id: "26000000000000001", user_id: MOCK_USER_ID, username: "mocktestseries.in", account_type: "BUSINESS", name: "MockTestSeries.in", media_count: 12 + state.media.length, ...over });
    const quota = () => json(200, { data: [{ quota_usage: scenario === "quotafull" ? 100 : state.media.length, config: { quota_total: 100, quota_duration: 86400 } }] });
    const noPerm = () => json(403, { error: { message: "(#10) Application does not have permission for this action", type: "OAuthException", code: 10, fbtrace_id: "mock" } });

    // Account-level scenarios (apply to every call).
    switch (scenario) {
      case "expired":
        return json(400, { error: { message: "Error validating access token: Session has expired on Thursday, 08-Oct-26 10:00:00 PDT.", type: "OAuthException", code: 190, error_subcode: 463 } });
      case "invalid":
        return json(400, { error: { message: `Invalid OAuth access token - Cannot parse access token ${token}`, type: "OAuthException", code: 190 } });
      case "nobasic":
        return noPerm();
      case "ratelimit":
        return json(400, { error: { message: "(#4) Application request limit reached", type: "OAuthException", code: 4 } });
      case "timeout":
        return void setTimeout(me, 12_000);
      case "garbage":
        res.writeHead(502, { "content-type": "text/html" });
        return res.end(`<html>bad gateway ${token}</html>`);
    }
    const known = ["valid", "nopublish", "creator", "wrong", "wrongid", "personal", "limittimeout", "slow", "procerror", "badimage", "quotafull", "pubtimeout", "publost", "pubfailonce", "blackout"];
    if (!known.includes(scenario)) return json(400, { error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } });

    if (isMe) {
      if (scenario === "wrong") return me({ user_id: MOCK_OTHER_USER_ID, username: "someone.else" });
      if (scenario === "wrongid") return me({ user_id: MOCK_OTHER_USER_ID });
      if (scenario === "personal") return me({ account_type: "PERSONAL" });
      if (scenario === "creator") return me({ account_type: "MEDIA_CREATOR" });
      return me();
    }
    if (limit) {
      if (scenario === "nopublish" || scenario === "personal") return noPerm();
      if (scenario === "limittimeout") return void setTimeout(quota, 12_000);
      return limit[1] === MOCK_USER_ID ? quota() : noPerm();
    }

    const ownUser = (id) => id === MOCK_USER_ID;
    if (createMedia) {
      if (!ownUser(createMedia[1])) return json(400, { error: { message: "Unsupported post request.", type: "GraphMethodException", code: 100 } });
      if (scenario === "nopublish") return noPerm();
      if (form.get("media_type") === "CAROUSEL") {
        const children = (form.get("children") ?? "").split(",").filter(Boolean);
        const bad = children.find((c) => !state.containers.get(c)?.carouselItem);
        if (children.length < 2 || children.length > 10 || bad) return json(400, { error: { message: "(#100) Invalid children", type: "OAuthException", code: 100 } });
        const notReady = children.find((c) => state.containers.get(c).statusCode !== "FINISHED");
        if (notReady) return json(400, { error: { message: "Media is not ready", type: "OAuthException", code: 9007, error_subcode: 2207027 } });
        const id = nextId("1790");
        state.containers.set(id, { id, kind: "CAROUSEL", children, caption: form.get("caption") ?? "", statusCode: scenario === "slow" ? "IN_PROGRESS" : "FINISHED", reads: 0, published: false });
        return json(200, { id });
      }
      const imageUrl = form.get("image_url") ?? "";
      if (scenario === "badimage") return json(400, { error: { message: "Media download has failed. The media URI doesn't meet our requirements.", type: "OAuthException", code: 9004, error_subcode: 2207052 } });
      // Like Meta: download the image now, anonymously.
      let fetchOk = false;
      let bytes = 0;
      let contentType = "";
      try {
        const r = await fetch(imageUrl, { redirect: "error" });
        const buf = Buffer.from(await r.arrayBuffer());
        bytes = buf.length;
        contentType = r.headers.get("content-type") ?? "";
        fetchOk = r.ok && contentType.startsWith("image/jpeg") && buf[0] === 0xff && buf[1] === 0xd8;
      } catch {}
      stats.imageFetches.push({ url: imageUrl, ok: fetchOk, bytes, contentType });
      if (!fetchOk) return json(400, { error: { message: "Media download has failed. The media URI doesn't meet our requirements.", type: "OAuthException", code: 9004, error_subcode: 2207052 } });
      const id = nextId("1789");
      const carouselItem = form.get("is_carousel_item") === "true";
      state.containers.set(id, { id, kind: "IMAGE", carouselItem, imageUrl, bytes, caption: form.get("caption") ?? "", statusCode: scenario === "procerror" && carouselItem ? "ERROR" : scenario === "slow" ? "IN_PROGRESS" : "FINISHED", reads: 0, published: false });
      return json(200, { id });
    }

    if (publish) {
      stats.publishCalls++;
      if (!ownUser(publish[1])) return json(400, { error: { message: "Unsupported post request.", type: "GraphMethodException", code: 100 } });
      const c = state.containers.get(form.get("creation_id") ?? "");
      if (!c || c.carouselItem) return json(400, { error: { message: "(#100) Invalid creation_id", type: "OAuthException", code: 100 } });
      if (c.published) return json(400, { error: { message: "The media has already been published.", type: "OAuthException", code: 9007, error_subcode: 2207008 } });
      if (c.statusCode !== "FINISHED") return json(400, { error: { message: "Media ID is not available", type: "OAuthException", code: 9007, error_subcode: 2207027 } });
      if (state.failNextPublish) {
        state.failNextPublish = false;
        return json(500, { error: { message: "An unexpected error has occurred. Please retry your request later.", type: "OAuthException", code: 2, is_transient: true } });
      }
      if (scenario === "pubfailonce" && !state.failedOnce.has(c.id)) {
        state.failedOnce.add(c.id);
        return json(500, { error: { message: "An unexpected error has occurred. Please retry your request later.", type: "OAuthException", code: 2, is_transient: true } });
      }
      const mediaId = nextId("1801");
      c.published = true;
      c.statusCode = "PUBLISHED";
      state.media.unshift({ id: mediaId, caption: c.caption, timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "+0000"), permalink: `https://www.instagram.com/p/MOCK${mediaId}/`, media_type: c.kind === "CAROUSEL" ? "CAROUSEL_ALBUM" : "IMAGE", containerId: c.id, children: c.children ?? null });
      if (scenario === "pubtimeout") return void setTimeout(() => json(200, { id: mediaId }), 4_000);
      if (scenario === "publost") {
        res.writeHead(502, { "content-type": "text/html" });
        return res.end("<html>502 Bad Gateway</html>");
      }
      if (scenario === "blackout") {
        state.blackoutHit = true;
        return; // never answers
      }
      return json(200, { id: mediaId });
    }

    if (listMedia) {
      if (!ownUser(listMedia[1])) return noPerm();
      if (scenario === "blackout" && state.blackout && state.blackoutHit) return json(503, { error: { message: "Service unavailable", code: 2 } });
      return json(200, { data: state.media.slice(0, 25).map(({ id, caption, timestamp, permalink, media_type }) => ({ id, caption, timestamp, permalink, media_type })) });
    }

    if (node) {
      if (scenario === "blackout" && state.blackout && state.blackoutHit) return json(503, { error: { message: "Service unavailable", code: 2 } });
      const c = state.containers.get(node[1]);
      if (c) {
        c.reads++;
        if (c.statusCode === "IN_PROGRESS" && c.reads > 2) c.statusCode = "FINISHED";
        return json(200, { id: c.id, status_code: c.statusCode, status: c.statusCode === "ERROR" ? "Error: The image could not be processed (mock)." : c.statusCode });
      }
      const m = state.media.find((x) => x.id === node[1]);
      if (m) return json(200, { id: m.id, permalink: m.permalink, timestamp: m.timestamp, media_type: m.media_type });
      return json(400, { error: { message: "Unsupported get request.", type: "GraphMethodException", code: 100 } });
    }
    return json(404, { error: { message: "Unsupported request.", type: "GraphMethodException", code: 100 } });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, stats, state, base: `http://127.0.0.1:${port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 3199);
  startMockGraph(port).then(({ base }) => console.log(`mock graph on ${base}`));
}
