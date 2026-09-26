/**
 * TEST ENGINE CORE — HIGH RISK SHARED PATH (see ops/TEST-ENGINE.md).
 *
 * Client-side answer persistence queue for the test player. Framework-free
 * (no React, no server imports) so its ordering/retry contract is unit-tested
 * directly by scripts/verify-test-engine-core.ts.
 *
 * Contract:
 *  - At most ONE request in flight per question; while one is in flight,
 *    newer values coalesce into a single "latest" value sent afterwards, so
 *    rapid A → B → C always ends on C and never on a delayed B.
 *  - Every request carries a monotonic `seq`; the server ignores any save
 *    older than what it stored, so even a timed-out request that lands late
 *    can't overwrite a newer answer.
 *  - Each request is bounded by a timeout; transient failures retry with
 *    backoff, then surface as "failed" (never a permanent spinner) and can
 *    be retried manually. Fatal server answers (time up, submitted) stop
 *    retrying and are reported to the player.
 */

export type SaveResult =
  | { ok: true }
  | { ok: false; code: string; message?: string };

export type SaveStatus = "saving" | "retrying" | "failed";

export interface AnswerValue {
  selected: string | null;
  marked: boolean;
}

export interface SaveQueueOptions {
  send: (questionId: string, value: AnswerValue, seq: number) => Promise<SaveResult>;
  onStatus?: (questionId: string, status: SaveStatus | null) => void;
  /** EXPIRED / NOT_EDITABLE — the attempt can no longer take answers. */
  onFatal?: (code: string) => void;
  /** Retries exhausted for some question. */
  onExhausted?: () => void;
  /** Mirror of not-yet-accepted answers (sessionStorage in the browser). */
  onPendingChange?: (questionId: string, value: AnswerValue | null) => void;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  now?: () => number;
}

const FATAL_CODES = new Set(["EXPIRED", "NOT_EDITABLE"]);
/** The server rejected this value for good (locked/invalid) — retrying can't help. */
const DROP_CODES = new Set(["LOCKED", "INVALID_OPTION", "NOT_IN_ATTEMPT", "NOT_ALLOWED", "NO_SELECTION"]);

interface Entry {
  desired: (AnswerValue & { seq: number }) | null;
  inflight: boolean;
  failures: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

export class AnswerSaveQueue {
  private entries = new Map<string, Entry>();
  private waiters = new Set<() => void>();
  private lastSeq = 0;
  private stopped = false;
  private readonly opts: Required<Pick<SaveQueueOptions, "timeoutMs" | "retryDelaysMs" | "now">> & SaveQueueOptions;

  constructor(options: SaveQueueOptions) {
    this.opts = { timeoutMs: 12_000, retryDelaysMs: [1_000, 2_000, 4_000, 8_000, 15_000], now: Date.now, ...options };
  }

  /** Monotonic per-tab sequence (ms clock, strictly increasing). */
  nextSeq(): number {
    this.lastSeq = Math.max(this.opts.now(), this.lastSeq + 1);
    return this.lastSeq;
  }

  enqueue(questionId: string, value: AnswerValue) {
    if (this.stopped) return;
    const entry = this.entry(questionId);
    entry.desired = { ...value, seq: this.nextSeq() };
    this.opts.onPendingChange?.(questionId, value);
    this.pump(questionId);
  }

  /** Forget a queued value (e.g. the server froze this question on reveal). */
  drop(questionId: string) {
    const entry = this.entries.get(questionId);
    if (!entry) return;
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    entry.desired = null;
    entry.failures = 0;
    this.opts.onPendingChange?.(questionId, null);
    if (!entry.inflight) this.opts.onStatus?.(questionId, null);
    this.notify();
  }

  retryAll() {
    for (const [questionId, entry] of this.entries) {
      if (entry.desired && !entry.inflight) {
        entry.failures = 0;
        this.pump(questionId);
      }
    }
  }

  idle(): boolean {
    for (const entry of this.entries.values()) if (entry.inflight || entry.desired) return false;
    return true;
  }

  /** True once every queued save is accepted; false on timeout or exhausted retries. */
  flush(timeoutMs: number): Promise<boolean> {
    for (const [questionId, entry] of this.entries) {
      if (entry.desired && !entry.inflight && !entry.retryTimer) {
        entry.failures = Math.max(entry.failures - 1, 0);
        this.pump(questionId);
      }
    }
    if (this.idle()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(value);
      };
      const check = () => {
        if (this.idle()) return done(true);
        const exhausted = [...this.entries.values()].some((e) => e.desired && !e.inflight && !e.retryTimer);
        if (exhausted) done(false);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.waiters.add(check);
    });
  }

  /** Stop all activity (attempt over). */
  stop() {
    this.stopped = true;
    for (const entry of this.entries.values()) if (entry.retryTimer) clearTimeout(entry.retryTimer);
  }

  private entry(questionId: string): Entry {
    let entry = this.entries.get(questionId);
    if (!entry) {
      entry = { desired: null, inflight: false, failures: 0, retryTimer: null };
      this.entries.set(questionId, entry);
    }
    return entry;
  }

  private notify() {
    for (const waiter of [...this.waiters]) waiter();
  }

  private pump(questionId: string) {
    const entry = this.entries.get(questionId);
    if (!entry || entry.inflight || !entry.desired || this.stopped) return;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    const sending = entry.desired;
    entry.inflight = true;
    this.opts.onStatus?.(questionId, entry.failures > 0 ? "retrying" : "saving");

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<SaveResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, code: "TIMEOUT" }), this.opts.timeoutMs);
    });
    Promise.race([
      this.opts.send(questionId, { selected: sending.selected, marked: sending.marked }, sending.seq).catch(
        (): SaveResult => ({ ok: false, code: "NETWORK" })
      ),
      timeout,
    ]).then((result) => {
      if (timer) clearTimeout(timer);
      this.settle(questionId, entry, sending.seq, result && typeof result === "object" ? result : { ok: false, code: "BAD_RESPONSE" });
    });
  }

  private settle(questionId: string, entry: Entry, sentSeq: number, result: SaveResult) {
    entry.inflight = false;
    if (result.ok || DROP_CODES.has(result.code)) {
      entry.failures = 0;
      if (entry.desired && entry.desired.seq === sentSeq) {
        entry.desired = null;
        this.opts.onPendingChange?.(questionId, null);
      }
      if (entry.desired) return this.pump(questionId); // a newer value arrived meanwhile
      this.opts.onStatus?.(questionId, null);
      return this.notify();
    }
    if (FATAL_CODES.has(result.code)) {
      entry.desired = null;
      this.opts.onStatus?.(questionId, null);
      this.stop();
      this.opts.onFatal?.(result.code);
      return this.notify();
    }
    entry.failures += 1;
    const delays = this.opts.retryDelaysMs;
    if (entry.failures > delays.length) {
      this.opts.onStatus?.(questionId, "failed");
      this.opts.onExhausted?.();
      return this.notify();
    }
    this.opts.onStatus?.(questionId, "retrying");
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      this.pump(questionId);
    }, delays[entry.failures - 1]);
    this.notify();
  }
}
