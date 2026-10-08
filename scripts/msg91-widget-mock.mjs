/**
 * TEST-ONLY MSG91 stand-in for scripts/verify-mobile-otp.mjs. Preloaded into a
 * LOCAL `next start` (NODE_OPTIONS="--import ./scripts/msg91-widget-mock.mjs")
 * so the production OTP code path (lib/otp.ts → MSG91 Widget sendOtp /
 * verifyOtp / verifyAccessToken) runs end-to-end WITHOUT sending a real SMS:
 * every request to api.msg91.com / control.msg91.com is answered here and
 * never leaves the machine. Issued codes go to MSG91_MOCK_FILE (the "phone"),
 * which the suite reads and later scans the server log for.
 *
 * Refuses to load unless MSG91_MOCK_FILE is set, so it can't be picked up by accident.
 */
import crypto from "node:crypto";
import fs from "node:fs";

const FILE = process.env.MSG91_MOCK_FILE;
if (!FILE) throw new Error("msg91-widget-mock: MSG91_MOCK_FILE is required");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { requests: {}, latest: {} };
  }
}
function save(db) {
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = async function mockedFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/^https:\/\/(api|control)\.msg91\.com\//.test(url)) return realFetch(input, init);

  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const db = load();
  if (url.endsWith("/widget/sendOtp")) {
    const reqId = crypto.randomUUID();
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    db.requests[reqId] = { identifier: body.identifier, code };
    db.latest[body.identifier] = { reqId, code };
    save(db);
    return json({ type: "success", message: reqId });
  }
  if (url.endsWith("/widget/verifyOtp")) {
    const r = db.requests[body.reqId];
    if (r && r.code === String(body.otp)) return json({ type: "success", message: `token-${body.reqId}` });
    return json({ type: "error", message: "OTP not match" });
  }
  if (url.endsWith("/widget/verifyAccessToken")) {
    const reqId = String(body["access-token"] ?? "").replace(/^token-/, "");
    const r = db.requests[reqId];
    return r ? json({ type: "success", message: r.identifier }) : json({ type: "error", message: "invalid token" });
  }
  if (url.includes("/api/balance.php")) return new Response("100", { status: 200 });
  return json({ type: "error", message: "msg91-widget-mock: unhandled endpoint" });
};
