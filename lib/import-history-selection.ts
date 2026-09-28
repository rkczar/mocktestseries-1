/**
 * Shared (client + server) shapes for Import History → View Import question
 * selection. Pure — no database access — so the server resolves an "all
 * matching" selection with exactly the same filter the page rendered.
 */

export type RollbackClass = "SAFE_TO_DELETE" | "ARCHIVE_ONLY" | "PROTECTED" | "ALREADY_MISSING";

export type ImportAction = "CREATED" | "REPLACED" | "SKIPPED" | "FAILED" | "PENDING";

/**
 * Why a question is not simply deletable. PROTECT-level dependencies are
 * live test/paper definitions: archiving would silently change what students
 * are served (a Mock or PYQ attempt only serves PUBLISHED questions), and a
 * delete is blocked by the foreign key. ARCHIVE-level dependencies are
 * student history or student-owned content: the question may leave active
 * pools (ARCHIVED) but must never be hard-deleted.
 */
export type DependencyKind =
  | "MOCK_TEST"
  | "PYQ_PAPER"
  | "ADMIN_CUSTOM_MODULE"
  | "GRAND_TEST"
  | "LIVE_TEST"
  | "OVERWRITTEN"
  | "STUDENT_CUSTOM_MODULE"
  | "ATTEMPT_ACTIVE"
  | "ATTEMPT_HISTORY"
  | "SAVED"
  | "REPORTED"
  | "AI_VARIANTS";

export interface Dependency {
  kind: DependencyKind;
  level: "PROTECT" | "ARCHIVE";
  /** Resolve & Remove may remove this link after explicit confirmation. */
  detachable: boolean;
  count: number;
  label: string;
  /** Named targets (mock tests, paper, admin modules) with their own attempt counts where relevant. */
  items?: { id: string; title: string; attempts?: number }[];
}

export interface ImportedQuestionRow {
  rowId: string;
  rowNumber: number;
  questionId: string | null;
  questionCode: string | null;
  action: ImportAction;
  /** Outcome of an earlier delete/archive of this row, if any. */
  rollbackAction: "DELETED" | "ARCHIVED" | "PROTECTED" | "ALREADY_MISSING" | "FAILED" | null;
  rollbackReason: string | null;
  question: {
    text: string;
    status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
    exam: string | null;
    subject: string | null;
    topic: string | null;
    subTopic: string | null;
  } | null;
  /** Only for CREATED rows not yet deleted/missing; null otherwise. */
  classification: RollbackClass | null;
  reasons: string[];
  dependencies: Dependency[];
  /** CREATED + not yet processed + deletable or archivable. */
  eligible: boolean;
}

export const ROW_FILTERS = ["ALL", "ACTIVE", "ARCHIVED", "DELETED", "DELETABLE", "PROTECTED", "HISTORY", "OTHER"] as const;
export type RowFilter = (typeof ROW_FILTERS)[number];

export const ROW_FILTER_LABEL: Record<RowFilter, string> = {
  ALL: "All",
  ACTIVE: "Active",
  ARCHIVED: "Archived",
  DELETED: "Deleted",
  DELETABLE: "Deletable",
  PROTECTED: "Protected",
  HISTORY: "Archive only (history)",
  OTHER: "Replaced / Skipped",
};

export function parseRowFilter(value: string | undefined | null): RowFilter {
  return (ROW_FILTERS as readonly string[]).includes(value ?? "") ? (value as RowFilter) : "ALL";
}

export function rowMatches(row: ImportedQuestionRow, filter: RowFilter, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (q && !(row.questionCode ?? "").toLowerCase().includes(q) && !(row.question?.text ?? "").toLowerCase().includes(q)) return false;
  switch (filter) {
    case "ALL":
      return true;
    case "ACTIVE":
      return row.question !== null && row.question.status !== "ARCHIVED";
    case "ARCHIVED":
      return row.question?.status === "ARCHIVED";
    case "DELETED":
      return row.question === null;
    case "DELETABLE":
      return row.classification === "SAFE_TO_DELETE";
    case "PROTECTED":
      return row.classification === "PROTECTED";
    case "HISTORY":
      return row.classification === "ARCHIVE_ONLY";
    case "OTHER":
      return row.action !== "CREATED";
  }
}

/** Client selection sent to the server: explicit row ids, or every row matching a filter. Always re-validated server-side. */
export type ImportSelection = { kind: "ids"; rowIds: string[] } | { kind: "all"; filter: RowFilter; search: string };

export type ImportRunState = "ACTIVE" | "ARCHIVED" | "DELETED" | "PARTIALLY_DELETED" | "PARTIALLY_ARCHIVED" | "EMPTY";

export const RUN_STATE_LABEL: Record<ImportRunState, string> = {
  ACTIVE: "Active",
  ARCHIVED: "Archived",
  DELETED: "Deleted",
  PARTIALLY_DELETED: "Partially Deleted",
  PARTIALLY_ARCHIVED: "Partially Archived",
  EMPTY: "No questions created",
};

/** Lifecycle of the questions a run CREATED — the run record itself is never deleted. */
export function importRunState(c: { created: number; deleted: number; archived: number }): ImportRunState {
  if (c.created === 0) return "EMPTY";
  if (c.deleted === 0 && c.archived === 0) return "ACTIVE";
  if (c.deleted >= c.created) return "DELETED";
  if (c.deleted === 0 && c.archived >= c.created) return "ARCHIVED";
  return c.deleted > 0 ? "PARTIALLY_DELETED" : "PARTIALLY_ARCHIVED";
}
