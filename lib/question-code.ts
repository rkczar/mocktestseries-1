import "server-only";
import type { Prisma } from "@prisma/client";

/**
 * Canonical, human-readable Question codes — e.g. "RUHS MO 2024 W01", "RUHS MO
 * 2024 W02". DB `Question.id` (cuid) remains the authoritative identifier; the
 * code is a stable business label.
 *
 * Shape: `<NORMALIZED EXAM CODE> <YEAR> W<SEQ>` — the exam code "RUHS-MO"
 * normalizes to "RUHS MO", and W<SEQ> is a per-(exam, year) sequence padded to
 * at least two digits.
 *
 * Safety properties (backed by QuestionCodeCounter):
 *  - concurrency-safe: allocation is a single atomic `INSERT .. ON CONFLICT
 *    DO UPDATE .. RETURNING`, so concurrent admins can never get the same W.
 *  - never reuses deleted codes: the per-scope sequence only ever moves forward.
 *  - re-import never renumbers: existing rows' codes are never rewritten.
 *  - invalid import rows consume nothing: allocate inside the SAME transaction
 *    as the Question insert — if the row rolls back, the increment does too.
 */

const SEQUENCE_PREFIX = "W";
const MIN_SEQUENCE_PADDING = 2;

/** "RUHS-MO" -> "RUHS MO". Letters/digits kept, runs of other chars become one space. */
export function normalizeQuestionCodeExamCode(examCode: string): string {
  return examCode
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Canonical counter scope for a (exam, year): e.g. "RUHS MO 2024". */
export function questionCodeScope(examCode: string, examYear: number): string {
  return `${normalizeQuestionCodeExamCode(examCode)} ${String(examYear)}`;
}

/** Render a scope + sequence as a code, e.g. "RUHS MO 2024 W01". */
export function questionCodeFromSequence(scope: string, sequence: number): string {
  return `${scope} ${SEQUENCE_PREFIX}${String(sequence).padStart(MIN_SEQUENCE_PADDING, "0")}`;
}

/**
 * Atomically allocates the next canonical Question code for `scope`.
 *
 * Must be called inside a transaction (`tx`) whose final commit also inserts
 * the Question row, so a failed/invalid insert never burns a number.
 *
 * @example
 *   const question = await prisma.$transaction(async (tx) => {
 *     const code = await allocateQuestionCode(tx, "RUHS MO 2024");
 *     return tx.question.create({ data: { code, ... } });
 *   });
 */
export async function allocateQuestionCode(
  tx: Prisma.TransactionClient,
  scope: string
): Promise<string> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "QuestionCodeCounter" ("scope", "value")
    VALUES (${scope}, 1)
    ON CONFLICT ("scope")
    DO UPDATE SET "value" = "QuestionCodeCounter"."value" + 1
    RETURNING "value"
  `;
  const sequence = Number(rows[0]?.value ?? 0);
  return questionCodeFromSequence(scope, sequence);
}

/** Minimal reader surface the year-resolution helper needs (prisma or a tx). */
type CodeInputDb = Pick<Prisma.TransactionClient, "exam" | "previousYearPaper">;

/**
 * Resolve the exam code + exam year a new question's canonical code should use:
 * a linked Previous Year Paper wins (its `year`, code from the exam), else the
 * exam's own `year`. Returns `examYear: null` when neither has one — callers
 * then can't build a canonical code.
 */
export async function resolveQuestionCodeInput(
  db: CodeInputDb,
  args: { examId: string; previousYearPaperId: string | null | undefined }
): Promise<{ examCode: string; examYear: number | null }> {
  const exam = await db.exam.findUnique({
    where: { id: args.examId },
    select: { code: true, year: true },
  });
  if (!exam) throw new Error("Selected exam no longer exists.");

  if (args.previousYearPaperId) {
    const paper = await db.previousYearPaper.findUnique({
      where: { id: args.previousYearPaperId },
      select: { year: true },
    });
    if (paper) return { examCode: exam.code, examYear: paper.year };
  }

  return { examCode: exam.code, examYear: exam.year };
}