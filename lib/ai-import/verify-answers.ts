import "server-only";
import { prisma } from "@/lib/prisma";
import { parseKeyAnswer } from "@/lib/ai-import/fidelity";
import { keyPaperChecks } from "@/lib/ai-import/key-check";
import { effective } from "@/lib/ai-import/post";
import { compareAnswer, type AnswerVerdict, type KeyIssue } from "@/lib/ai-import/verify-answers-core";

export { compareAnswer, ANSWER_VERDICT_LABELS, type AnswerVerdict } from "@/lib/ai-import/verify-answers-core";

export interface AnswerCheckRow {
  id: string;
  label: string;
  saved: string[];
  adminChosen: boolean;
  keyRaw: string | null;
  keyPage: number | null;
  official: string[];
  verdict: AnswerVerdict;
  code: KeyIssue | null;
  reason: string;
  approved: boolean;
}

/**
 * Verify All Answers — READ-ONLY, for any exam: every question's saved answer against the answer key identified for
 * its paper (the key entries mapped to it, from key files whose paper identity is MATCH or CONFIRMED). Reuses the stored
 * key reading: no OCR, no AI, no re-scan, nothing written, never approves anything.
 */
export async function verifyAnswers(jobId: string): Promise<{ rows: AnswerCheckRow[]; counts: Record<AnswerVerdict, number> }> {
  const [questions, entries, checks] = await Promise.all([
    prisma.aiImportQuestion.findMany({ where: { jobId, status: { not: "REJECTED" } }, orderBy: [{ orderIndex: "asc" }, { id: "asc" }], select: { id: true, fileId: true, sourceNumber: true, sourceLabel: true, finalAnswer: true, answerConfirmedById: true, approvedById: true, data: true, editedData: true } }),
    prisma.aiImportKeyEntry.findMany({ where: { jobId }, select: { keyFileId: true, paperFileId: true, sourceNumber: true, section: true, rawValue: true, page: true, matchedQuestionId: true } }),
    keyPaperChecks(jobId),
  ]);
  // Same rule as post-processing: a key file whose identity was checked counts only when it is MATCH or CONFIRMED.
  const keyFileProblem = new Map(checks.filter((c) => c.state !== "MATCH" && c.state !== "CONFIRMED").map((c) => [c.keyFileId, `${c.state.toLowerCase()} — ${c.detail}`]));
  const rows = questions.map((q) => {
    const e = effective(q);
    const mapped = entries.filter((k) => k.matchedQuestionId === q.id);
    const section = e.section ?? "";
    const unmapped = mapped.length || q.sourceNumber === null ? [] : entries.filter((k) => !k.matchedQuestionId && k.sourceNumber === q.sourceNumber && (k.section ?? "") === section && (!k.paperFileId || k.paperFileId === q.fileId));
    const printed = e.options.map((o) => o.printed || o.label);
    const r = compareAnswer({
      saved: q.finalAnswer,
      keys: mapped.map((k) => ({ rawValue: k.rawValue, fileProblem: keyFileProblem.get(k.keyFileId) ?? null })),
      unmapped: unmapped.map((k) => k.rawValue),
      parse: (raw) => parseKeyAnswer(raw, printed),
    });
    return {
      id: q.id,
      label: `${section ? `${section} ` : ""}Q${q.sourceLabel}`,
      saved: q.finalAnswer,
      adminChosen: !!q.answerConfirmedById,
      keyRaw: (mapped.length ? mapped : unmapped).map((k) => k.rawValue).join(" / ") || null,
      keyPage: (mapped[0] ?? unmapped[0])?.page ?? null,
      official: r.official,
      verdict: r.verdict,
      code: r.code ?? null,
      reason: r.reason,
      approved: !!q.approvedById,
    };
  });
  const counts: Record<AnswerVerdict, number> = { MATCH: 0, MISMATCH: 0, UNVERIFIED: 0, NO_KEY: 0 };
  for (const r of rows) counts[r.verdict]++;
  return { rows, counts };
}
