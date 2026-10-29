/**
 * Shared text-quality findings (Instagram captions). Pure and client-safe.
 *
 * These are heuristics about form — length, formatting, repetition, filler, stock phrasing, numbers that do not
 * appear in the source. They are NOT a fact check: medical correctness has its own review (Instagram medical
 * review). Nothing here rewrites text by itself; a `suggestion` is shown to the admin.
 */

export type LintSeverity = "error" | "warning" | "info";

export interface LintFinding {
  /** Stable code, e.g. "CAPTION_TOO_LONG". */
  code: string;
  severity: LintSeverity;
  message: string;
  /** Proposed correction, shown to the admin (never applied automatically). */
  suggestion?: string;
  /** The text the finding is about (a phrase, a hashtag, a character name). */
  excerpt?: string;
}

export function finding(code: string, severity: LintSeverity, message: string, extra: Omit<LintFinding, "code" | "severity" | "message"> = {}): LintFinding {
  return { code, severity, message, ...extra };
}

export function worst(findings: LintFinding[]): LintSeverity | null {
  if (findings.some((f) => f.severity === "error")) return "error";
  if (findings.some((f) => f.severity === "warning")) return "warning";
  return findings.length ? "info" : null;
}
