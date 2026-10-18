/**
 * Browser side of the AI Question Importer's Server Actions. An action call can throw instead of
 * returning { ok: false }: the admin proxy answers a request without a valid admin session (the
 * 12 h login expired) with a redirect to the login page, which the action client can only report as
 * an "unexpected response", and a dropped connection throws too. Unhandled, either one crashes the
 * page. callImporter turns both into an ordinary { ok: false, error } the screens already show.
 */

export const SESSION_EXPIRED = "Your admin session has expired.";
const PROBE_PATH = "/admin/ai-importer";

/**
 * Why an action call threw. Ask the admin proxy about an importer page without following redirects:
 * a redirect means the session is gone; any other answer (or none) is not proof of that, so it stays
 * a connection problem. HEAD to a page only: the session cookie is not re-issued (the 12 h login is not extended).
 */
export async function failureKind(probePath = PROBE_PATH): Promise<"session" | "network"> {
  try {
    const r = await fetch(probePath, { method: "HEAD", redirect: "manual", cache: "no-store", credentials: "same-origin" });
    return r.type === "opaqueredirect" ? "session" : "network";
  } catch {
    return "network";
  }
}

/** The message for a thrown action call (reloading an /admin page with an expired session opens the login page and returns here). */
export async function thrownCallMessage(): Promise<string> {
  return (await failureKind()) === "session"
    ? `${SESSION_EXPIRED} Reload the page to sign in again — nothing was changed.`
    : "The server could not be reached, so it is not known whether this step ran. Check your connection, then reload the page to see the current state.";
}

export async function callImporter<T extends { ok: boolean }>(fn: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await fn();
  } catch {
    return { ok: false, error: await thrownCallMessage() };
  }
}
