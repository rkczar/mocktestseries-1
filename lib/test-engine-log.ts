import "server-only";

/**
 * TEST ENGINE CORE — HIGH RISK SHARED PATH.
 * Changes to option selection, answer persistence, navigation, attempt
 * snapshots, timer, submission or answer reveal require the focused
 * test-engine regression suite before deployment (see ops/TEST-ENGINE.md).
 *
 * One structured line per engine failure or slow operation, grep-able in the
 * PM2 logs as `[test-engine]`. Only ids, the operation, a safe error code and
 * latency are logged — never answers, correct labels, tokens or secrets.
 */
export type EngineOp = "load" | "save" | "navigate" | "submit" | "reveal" | "start";

export type EngineErrorCode =
  | "EXPIRED"
  | "NOT_EDITABLE"
  | "NOT_IN_ATTEMPT"
  | "LOCKED"
  | "NOT_ALLOWED"
  | "NO_SELECTION"
  | "INVALID_OPTION"
  | "INTERNAL";

/** A known, student-safe engine failure. `message` is shown to the student. */
export class TestEngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "TestEngineError";
    this.code = code;
  }
}

/** Operations slower than this are logged even when they succeed. */
export const SLOW_OP_MS = 1500;

export function logEngine(entry: {
  op: EngineOp;
  attemptId?: string;
  questionId?: string;
  code: EngineErrorCode | "SLOW";
  ms?: number;
}) {
  console.error(`[test-engine] ${JSON.stringify({ ...entry, at: new Date().toISOString() })}`);
}
