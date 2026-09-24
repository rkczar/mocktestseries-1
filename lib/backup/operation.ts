/**
 * Client-side operation runner for Backup Center actions (pure — no React,
 * no server imports — so the verification suite exercises the exact logic
 * the UI uses).
 *
 * Guarantees:
 *  - `run` is invoked AT MOST ONCE per call. A destructive request is never
 *    retried automatically, whatever happens to the response.
 *  - Always settles: returns a final OperationResult for success, server
 *    refusal, thrown/lost response, or a hung request (timeoutMs).
 *  - Ambiguous outcome (the request threw or timed out, e.g. a 504 from the
 *    proxy while the server kept deleting): asks the server, read-only,
 *    whether the target still exists (`reconcile`) and reports THAT state.
 */

export interface ServerResult<T> {
  ok: boolean;
  error?: string;
  message?: string;
  data?: T;
}

export type OperationKind = "success" | "refused" | "reconciled-done" | "reconciled-not-done" | "unknown";

export interface OperationResult<T> {
  kind: OperationKind;
  ok: boolean;
  message: string;
  data?: T;
  /** The page's server data should be refreshed (the server state may have changed). */
  refresh: boolean;
}

export class OperationTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T> {
  if (!ms) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new OperationTimeoutError("timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export async function runOperation<T>(opts: {
  run: () => Promise<ServerResult<T>>;
  /** Read-only: does the target still exist on the server? */
  reconcile?: () => Promise<ServerResult<{ exists: boolean }>>;
  timeoutMs?: number;
  failureMessage?: string;
}): Promise<OperationResult<T>> {
  let r: ServerResult<T>;
  try {
    r = await withTimeout(opts.run(), opts.timeoutMs);
  } catch {
    if (!opts.reconcile) {
      return { kind: "unknown", ok: false, message: "The server did not answer in time. Refresh the page to see the current state before trying again.", refresh: true };
    }
    try {
      const c = await withTimeout(opts.reconcile(), 20_000);
      if (c.ok && c.data) {
        return c.data.exists
          ? { kind: "reconciled-not-done", ok: false, message: "The connection was interrupted. The server confirms the item still exists — nothing was deleted. You can try again.", refresh: true }
          : { kind: "reconciled-done", ok: true, message: "The connection was interrupted, but the server confirms the item was deleted.", refresh: true };
      }
    } catch {
      /* fall through */
    }
    return { kind: "unknown", ok: false, message: "The connection was interrupted and the result could not be confirmed. Refresh the page to check — do not resubmit blindly.", refresh: true };
  }
  if (!r || !r.ok) return { kind: "refused", ok: false, message: r?.error ?? opts.failureMessage ?? "The operation failed.", refresh: false };
  return { kind: "success", ok: true, message: r.message ?? "Done.", data: r.data, refresh: true };
}

/**
 * The per-control guard the UI hook wraps: blocks a second submit while the
 * same operation is running, ALWAYS clears busy in `finally`, and isolates
 * the post-result callback (banner / router refresh) so a failure there can
 * never leave a completed operation looking "Processing…".
 */
export function createOperationGuard(setBusy: (busy: boolean) => void) {
  let inflight = false;
  return async function execute<T>(
    opts: Parameters<typeof runOperation<T>>[0],
    after?: (r: OperationResult<T>) => void
  ): Promise<OperationResult<T> | null> {
    if (inflight) return null;
    inflight = true;
    setBusy(true);
    try {
      const r = await runOperation<T>(opts);
      try {
        after?.(r);
      } catch {
        /* a refresh/banner failure must not change the operation's outcome */
      }
      return r;
    } finally {
      inflight = false;
      setBusy(false);
    }
  };
}
