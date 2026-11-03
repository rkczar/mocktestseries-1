import "server-only";
import { ImportRowSeverity, type Prisma } from "@prisma/client";
import { mergeRowData } from "@/lib/bulk-import";

/**
 * "Paper Question Number" checks for a bulk import that targets a Previous
 * Year Paper. The printed number becomes Question.paperQuestionNumber (the
 * order a PYQ attempt serves), so it is never guessed: once a file carries
 * the column, every row must have a valid, unique number that no live
 * question of the paper already holds. Problems never block the import —
 * they flag the row for review ("Paper Question Number …", a review trigger
 * in lib/bulk-import.ts), so the question stays Draft until fixed.
 *
 * Files WITHOUT the column keep today's behaviour (no checks, no number).
 */

type Db = Pick<Prisma.TransactionClient, "bulkImportRow" | "question">;

export async function paperNumberIssues(db: Db, runId: string, paperId: string | null | undefined): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!paperId) return out;

  const rows = await db.bulkImportRow.findMany({
    where: { runId, removedFromImport: false },
    select: { id: true, rowNumber: true, rawData: true, editedData: true },
    orderBy: { rowNumber: "asc" },
  });
  const raws = rows.map((r) => ({ id: r.id, rowNumber: r.rowNumber, raw: (mergeRowData(r.rawData, r.editedData).questionNumber ?? "").toString().trim() }));
  if (!raws.some((r) => r.raw)) return out;

  // Live questions of the paper — excluding this run's own (a resumed import must not collide with itself).
  const live = await db.question.findMany({
    where: { previousYearPaperId: paperId, retiredAt: null, paperQuestionNumber: { not: null }, OR: [{ importBatchId: null }, { importBatchId: { not: runId } }] },
    select: { code: true, paperQuestionNumber: true },
  });
  const liveByNumber = new Map(live.map((q) => [q.paperQuestionNumber!, q.code]));

  const rowsByNumber = new Map<number, number[]>();
  for (const r of raws) {
    const n = paperQuestionNumberOf(r.raw);
    if (n != null) rowsByNumber.set(n, [...(rowsByNumber.get(n) ?? []), r.rowNumber]);
  }

  for (const r of raws) {
    const issues: string[] = [];
    const n = r.raw ? paperQuestionNumberOf(r.raw) : null;
    if (!r.raw) issues.push("Paper Question Number missing — this row's printed position in the paper is not established. Add it before publishing.");
    else if (n == null) issues.push(`Paper Question Number "${r.raw}" is not a whole number from 1 upward.`);
    else {
      const others = (rowsByNumber.get(n) ?? []).filter((x) => x !== r.rowNumber);
      if (others.length) issues.push(`Paper Question Number ${n} is also used by row${others.length > 1 ? "s" : ""} ${others.join(", ")} of this file.`);
      if (liveByNumber.has(n)) issues.push(`Paper Question Number ${n} is already used by live question ${liveByNumber.get(n)} of this paper.`);
    }
    if (issues.length) out.set(r.id, issues);
  }
  return out;
}

/** Folds a row's number issues into its resolution: review-flagged, at least WARNING. */
export function applyPaperNumberIssues<T extends { warnings: string[]; reviewRequired: boolean; severity: ImportRowSeverity }>(resolved: T, issues: string[] | undefined): T {
  if (!issues?.length || resolved.severity === ImportRowSeverity.ERROR) return resolved;
  resolved.warnings.push(...issues);
  resolved.reviewRequired = true;
  if (resolved.severity === ImportRowSeverity.VALID) resolved.severity = ImportRowSeverity.WARNING;
  return resolved;
}

/** "38" → 38; anything that is not a plain positive whole number (Q38a, 2.1, blank) → null. */
export function paperQuestionNumberOf(raw: string | number | null | undefined): number | null {
  const v = typeof raw === "number" ? String(raw) : (raw ?? "").trim();
  if (!/^\d{1,4}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 5000 ? n : null;
}
