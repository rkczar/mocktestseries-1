import { AiImportAnswerStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { keyPaperChecks } from "@/lib/ai-import/key-check";
import { parseKeyAnswer } from "@/lib/ai-import/fidelity";
import { captureQuestionSource } from "@/lib/question-source/capture";
import { KEY_MIN_COVERAGE } from "@/lib/ai-import/config";

const DROPPED = /^(bonus|dropped|deleted|withdrawn|\*|x|×)$/i;

export type LateKeyAction = "UPDATED" | "CONFIRMED" | "FLAGGED";

/**
 * The decision for one ALREADY-IMPORTED question when its official key entry is read after import (pure).
 *  - key = an option set: DRAFT whose Question Bank answer is still the import-time answer → UPDATED to the key;
 *    same answer → CONFIRMED (answerVerification OFFICIAL_KEY); otherwise (PUBLISHED, or an answer an administrator
 *    changed after import) → FLAGGED, never changed.
 *  - key = dropped / withdrawn → FLAGGED (a withdrawal is decided by an administrator, never automatically).
 */
export function lateKeyDecision(i: { status: string; current: string[]; importedAnswer: string[]; adminConfirmed?: boolean; questionType?: string; key: string[] | "WITHDRAWN"; optionLabels: string[] }): { action: LateKeyAction | null; reason: string | null } {
  const cur = [...i.current].sort().join(", ") || "none";
  if (i.key === "WITHDRAWN") return i.status === "WITHDRAWN" ? { action: null, reason: null } : { action: "FLAGGED", reason: `REVIEW_REQUIRED — the official key (read after import) withdraws this question; the Question Bank record is ${i.status} (not changed automatically).` };
  const key = [...i.key].sort();
  if (!key.length || !key.every((l) => i.optionLabels.includes(l))) return { action: null, reason: null };
  const k = key.join(", ");
  // The key must fit the question type (a single-correct question has exactly one answer) — never applied otherwise.
  const multi = i.questionType === "MULTIPLE_CORRECT";
  if (multi ? key.length < 2 : key.length !== 1) return k === cur ? { action: null, reason: null } : { action: "FLAGGED", reason: `ANSWER_UNVERIFIED — official key (read after import) says ${k}, which does not fit this ${multi ? "multiple" : "single"}-correct question (Question Bank answer ${cur}) — not changed automatically.` };
  if (k === cur) return { action: "CONFIRMED", reason: null };
  // An answer the administrator confirmed (before import) or changed (after) is never overwritten.
  const untouched = !i.adminConfirmed && [...i.importedAnswer].sort().join(", ") === cur;
  if (i.status === "DRAFT" && untouched) return { action: "UPDATED", reason: `REVIEW_REQUIRED — answer set from the official key read after import (was ${cur}, official ${k}).` };
  return { action: "FLAGGED", reason: `ANSWER_UNVERIFIED — official key (read after import) says ${k}; the ${i.status} Question Bank answer is ${cur}${untouched ? "" : " (changed by an administrator after import)"} — not changed automatically.` };
}

/**
 * Applies an official key read AFTER questions were imported (legacy papers imported without a key) to their existing
 * Question Bank records — never a re-import. Only key files whose paper identity MATCHes or was CONFIRMED as official
 * are used; one distinct value per number. Only questions that had NO key at import (KEY_MISSING / UNVERIFIED) — a
 * question matched (or mismatched) at import keeps that decision. Idempotent: the applied official answer is kept on the question's source
 * evidence (QuestionSourceEvidence.officialAnswer + keyStatus OFFICIAL), so a question is decided once per key value.
 */
export async function applyKeyToImported(jobId: string): Promise<{ updated: number; confirmed: number; flagged: number; skipped: number }> {
  const out = { updated: 0, confirmed: 0, flagged: 0, skipped: 0 };
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId, questionId: { not: null }, answerStatus: { in: [AiImportAnswerStatus.KEY_MISSING, AiImportAnswerStatus.UNVERIFIED] } }, select: { id: true, questionId: true, fileId: true, sourceNumber: true, sourceLabel: true, finalAnswer: true, answerConfirmedById: true, data: true, editedData: true } });
  if (!rows.length) return out;
  const official = new Set((await keyPaperChecks(jobId)).filter((c) => c.state === "MATCH" || c.state === "CONFIRMED").map((c) => c.keyFileId));
  if (!official.size) return out;
  const jobRow = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId }, select: { createdById: true, expectedQuestions: true } });
  const allEntries = await prisma.aiImportKeyEntry.findMany({ where: { jobId, keyFileId: { in: [...official] } }, select: { id: true, keyFileId: true, paperFileId: true, sourceNumber: true, section: true, rawValue: true } });
  // Same guard as post-processing: a vision-only key read only partly is never used.
  for (const f of await prisma.aiImportFile.findMany({ where: { id: { in: [...official] } }, select: { id: true, detected: true } })) {
    const d = f.detected as { kind?: string; keyMethod?: string; facts?: { textPages?: number } } | null;
    const visionOnly = d?.keyMethod ? d.keyMethod === "ai" : ["jpeg", "jpg", "png", "webp"].includes(d?.kind ?? "") || d?.facts?.textPages === 0;
    const read = new Set(allEntries.filter((e) => e.keyFileId === f.id).map((e) => e.sourceNumber)).size;
    if (visionOnly && jobRow.expectedQuestions && read < Math.ceil(jobRow.expectedQuestions * KEY_MIN_COVERAGE)) official.delete(f.id);
  }
  // Key entries belong to ONE question paper: its paperFileId, or the job's only paper (never another paper's key).
  const papers = [...new Set((await prisma.aiImportQuestion.findMany({ where: { jobId }, select: { fileId: true }, distinct: ["fileId"] })).map((q) => q.fileId))];
  const entries = allEntries.filter((e) => official.has(e.keyFileId)).map((e) => ({ ...e, paper: e.paperFileId ?? (papers.length === 1 ? papers[0] : null) }));
  if (!entries.length) return out;
  const qs = new Map((await prisma.question.findMany({ where: { id: { in: rows.map((r) => r.questionId!) } }, select: { id: true, status: true, questionType: true, answerVerification: true, options: { select: { id: true, label: true, isCorrect: true } }, sourceEvidence: { select: { officialAnswer: true, keyStatus: true } } } })).map((q) => [q.id, q]));
  const job = jobRow;
  for (const r of rows) {
    const q = qs.get(r.questionId!);
    if (!q || r.sourceNumber === null) continue;
    const section = (((r.editedData ?? r.data) ?? {}) as { section?: string }).section ?? "";
    const mine = entries.filter((e) => e.paper === r.fileId && e.sourceNumber === r.sourceNumber && e.section === section);
    const values = [...new Set(mine.map((e) => e.rawValue.toUpperCase().replace(/[()\s]/g, "")))];
    if (values.length !== 1) continue; // no entry, or entries disagree → nothing applied (the importer shows the conflict)
    const labels = q.options.map((o) => o.label);
    const key: string[] | "WITHDRAWN" = DROPPED.test(values[0]) ? "WITHDRAWN" : (parseKeyAnswer(mine[0].rawValue, labels).labels ?? []);
    const keyText = key === "WITHDRAWN" ? "WITHDRAWN" : [...key].sort().join(",");
    const ev = q.sourceEvidence;
    if (ev && ev.keyStatus === "OFFICIAL" && [...ev.officialAnswer].sort().join(",") === keyText) { out.skipped++; continue; } // already decided for this key value
    const current = q.options.filter((o) => o.isCorrect).map((o) => o.label);
    const { action, reason } = lateKeyDecision({ status: q.status, current, importedAnswer: r.finalAnswer, adminConfirmed: !!r.answerConfirmedById, questionType: q.questionType, key, optionLabels: labels });
    if (!action) continue;
    await prisma.$transaction([
      ...(action === "UPDATED" && key !== "WITHDRAWN" ? q.options.map((o) => prisma.questionOption.update({ where: { id: o.id }, data: { isCorrect: key.includes(o.label) } })) : []),
      prisma.question.update({ where: { id: q.id }, data: { ...(action !== "FLAGGED" ? { answerVerification: "OFFICIAL_KEY" } : {}), ...(reason ? { reviewRequired: true, reviewReason: reason.slice(0, 1000) } : {}) } }),
      // The importer record catches up with the key it now has (its evidence row reads these fields).
      prisma.aiImportQuestion.update({ where: { id: r.id }, data: { officialAnswerRaw: mine[0].rawValue, officialAnswer: key === "WITHDRAWN" ? [] : key, answerStatus: key === "WITHDRAWN" ? AiImportAnswerStatus.WITHDRAWN : action === "FLAGGED" ? AiImportAnswerStatus.KEY_MISMATCH : AiImportAnswerStatus.OFFICIAL_MATCHED } }),
      prisma.aiImportKeyEntry.updateMany({ where: { id: { in: mine.map((e) => e.id) } }, data: { matchedQuestionId: r.id, status: "OK" } }),
      prisma.auditLog.create({ data: { actorId: job.createdById, action: `QUESTION_LATE_KEY_${action}`, entityType: "Question", entityId: q.id, metadata: { jobId, importQuestionId: r.id, before: current, key: keyText, status: q.status } } }),
    ]);
    out[action === "UPDATED" ? "updated" : action === "CONFIRMED" ? "confirmed" : "flagged"]++;
    // Refreshes provenance (answer-key crop + official answer + keyStatus) — also what makes this idempotent.
    await captureQuestionSource(r.id).catch(() => undefined);
    await prisma.questionSourceEvidence.updateMany({ where: { questionId: q.id }, data: { keyStatus: "OFFICIAL", officialAnswer: key === "WITHDRAWN" ? ["WITHDRAWN"] : key } });
  }
  return out;
}
