/**
 * TEST-ONLY Resend stand-in. Preloaded into a LOCAL `next start`
 * (NODE_OPTIONS="--import ./scripts/resend-mock.mjs") so the production email
 * code path (lib/email/provider.ts → POST https://api.resend.com/emails) runs
 * end-to-end WITHOUT sending a real email: every request to api.resend.com is
 * answered here and never leaves the machine. Each "delivered" message is
 * appended to RESEND_MOCK_FILE (the "inbox"), which the suite reads.
 *
 * Refuses to load unless RESEND_MOCK_FILE is set, so it can't be picked up by
 * accident. Chains with scripts/msg91-widget-mock.mjs (each wraps fetch).
 */
import crypto from "node:crypto";
import fs from "node:fs";

const FILE = process.env.RESEND_MOCK_FILE;
if (!FILE) throw new Error("resend-mock: RESEND_MOCK_FILE is required");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { messages: [] };
  }
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = async function resendMockFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.resend.com/")) return realFetch(input, init);

  if (url.endsWith("/emails") && (init?.method ?? "GET").toUpperCase() === "POST") {
    const body = JSON.parse(String(init.body ?? "{}"));
    const to = Array.isArray(body.to) ? body.to[0] : body.to;
    // A test address on purpose fails like a real provider rejection.
    if (/^fail@/.test(String(to))) return json(422, { name: "validation_error", message: "mock rejection" });
    const id = crypto.randomUUID();
    const db = load();
    db.messages.push({ id, to, subject: body.subject, text: body.text, at: new Date().toISOString() });
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
    return json(200, { id });
  }
  if (url.endsWith("/domains")) return json(200, { data: [{ name: "mocktestseries.in", status: "verified" }] });
  return json(404, { name: "not_found", message: "resend-mock: unhandled endpoint" });
};
