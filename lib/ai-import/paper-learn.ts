import "server-only";
import { AiImportFileRole, AiImportQuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ImportJobError, logEvent } from "@/lib/ai-import/jobs";
import { readDocx } from "@/lib/ai-import/docx";
import { vaultPath } from "@/lib/ai-import/vault";
import { docxQuestions } from "@/lib/ai-import/process";
import { KEY_MIN_COVERAGE } from "@/lib/ai-import/keys";
import { learnPaperRules, ocrPairs, paperOf, type LearnInput, type PaperRuleProposal } from "@/lib/ai-import/paper-memory";
import { savePaperRuleProposals } from "@/lib/ai-import/taxonomy-memory";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

/**
 * Learns the paper-format memory of one import (lib/ai-import/paper-memory.ts) from deterministic evidence only:
 * the source document read again locally, an official key that was read completely and matched to questions an
 * administrator approved, the subjects of approved questions, and administrators' text corrections of AI-read
 * questions. Everything is stored as PROPOSED; an administrator confirms each rule before it is used.
 */

/** The paper this import is ("PAPER II"), from its Previous Year Paper, else its title. */
export async function paperIdentity(job: { title: string; previousYearPaperId: string | null }): Promise<string | null> {
  const pyp = job.previousYearPaperId ? await prisma.previousYearPaper.findUnique({ where: { id: job.previousYearPaperId }, select: { title: true } }) : null;
  return paperOf(pyp?.title) ?? paperOf(job.title);
}

const APPROVED = (q: { approvedById: string | null; status: AiImportQuestionStatus }) => !!q.approvedById || q.status === AiImportQuestionStatus.IMPORTED || q.status === AiImportQuestionStatus.PUBLISHED;

/** Printed number style of each question line of a Word file ("Q1." → "QN.", "1." → "N.", "1)" → "N)"). */
function numberStyles(lines: string[], questions: ExtractedQuestion[]): string[] {
  const out: string[] = [];
  let from = 0;
  for (const q of questions) {
    if (q.number === null) continue;
    const re = new RegExp(String.raw`^\s*(Q(?:uestion|ue|n)?\s*[.:]?\s*(?:No\.?\s*)?)?${q.number}\s*([.):])`, "i");
    const at = lines.findIndex((l, i) => i >= from && re.test(l));
    if (at < 0) continue;
    const m = re.exec(lines[at])!;
    out.push(`${m[1] ? "Q" : ""}N${m[2]}`);
    from = at + 1;
  }
  return out;
}

export async function proposalsForJob(jobId: string): Promise<{ proposals: PaperRuleProposal[]; paper: string | null; examId: string }> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  const paper = await paperIdentity(job);
  const files = await prisma.aiImportFile.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });
  const questions = await prisma.aiImportQuestion.findMany({ where: { jobId }, orderBy: { orderIndex: "asc" } });
  const taxonomy = await getExamTaxonomy(prisma, job.examId);
  const subjectName = new Map(taxonomy.map((s) => [s.id, s.name]));
  const approved = questions.filter(APPROVED);
  const at = new Date().toISOString();
  const proposals: PaperRuleProposal[] = [];

  // Admin corrections of AI-read text (a text edit of a question an AI read), word by word.
  const edits = await prisma.aiImportQuestionVersion.findMany({ where: { jobId, kind: "ADMIN_EDIT" }, select: { questionId: true, changes: true } });
  const aiRead = new Set(questions.filter((q) => /^AI/.test(((q.data as unknown as ExtractedQuestion).method ?? ""))).map((q) => q.id));
  const counts = new Map<string, { wrong: string; right: string; count: number }>();
  for (const v of edits) {
    if (!aiRead.has(v.questionId) || !Array.isArray(v.changes)) continue;
    for (const c of v.changes as { field?: string; before?: string; after?: string }[]) {
      if (!/text|option/i.test(c.field ?? "") || typeof c.before !== "string" || typeof c.after !== "string") continue;
      for (const p of ocrPairs(c.before, c.after)) {
        const k = `${p.wrong}→${p.right}`;
        counts.set(k, { ...p, count: (counts.get(k)?.count ?? 0) + 1 });
      }
    }
  }

  const keyFiles = files.filter((f) => f.role === AiImportFileRole.ANSWER_KEY);
  for (const file of files.filter((f) => f.role === AiImportFileRole.PAPER && f.storageKey && !f.purgedAt)) {
    const kind = (file.detected as { kind?: string } | null)?.kind ?? file.ext;
    let source: LearnInput["source"] = null;
    if (kind === "docx") {
      const doc = await readDocx(vaultPath(file.storageKey!));
      const fresh = docxQuestions(doc).map((q) => ({ ...q, heading: q.hints?.subject ?? null }));
      source = { questions: fresh, numberStyles: numberStyles(doc.lines.map((l) => l.text), fresh), sectionRestarts: new Set(fresh.map((q) => q.section)).size - 1 };
    }
    // The official key counts only when read completely and matched to questions an administrator approved.
    let approvedKey: LearnInput["approvedKey"] = null;
    const approvedIds = new Set(approved.filter((q) => q.fileId === file.id).map((q) => q.id));
    for (const k of keyFiles.filter((x) => !x.paperFileId || x.paperFileId === file.id)) {
      const rows = await prisma.aiImportKeyEntry.findMany({ where: { keyFileId: k.id } });
      const expected = job.expectedQuestions ?? null;
      if (!expected || new Set(rows.map((r) => r.sourceNumber)).size < Math.ceil(expected * KEY_MIN_COVERAGE)) continue;
      const values = new Map(rows.filter((r) => (!!r.matchedQuestionId && approvedIds.has(r.matchedQuestionId)) || r.status === "WITHDRAWN").map((r) => [r.sourceNumber, r.rawValue.trim()] as const));
      if (values.size < Math.ceil(expected * 0.5)) continue;
      const kk = (k.detected as { kind?: string } | null)?.kind ?? k.ext;
      const read = kk === "xlsx" || kk === "csv" ? "sheet" : (await prisma.aiImportAiCall.count({ where: { jobId, task: "key" } })) ? "AI vision" : "text layer";
      approvedKey = { fileName: k.originalName, fileSha256: k.sha256, values, expected, fileKind: kk === "jpg" || kk === "jpeg" || kk === "png" ? "image" : kk, read };
    }
    const subjects = new Map<string, number>();
    for (const q of approved.filter((x) => x.fileId === file.id && x.subjectId)) subjects.set(subjectName.get(q.subjectId!) ?? q.subjectId!, (subjects.get(subjectName.get(q.subjectId!) ?? q.subjectId!) ?? 0) + 1);
    proposals.push(...learnPaperRules({ jobId, jobTitle: job.title, paper, fileName: file.originalName, fileSha256: file.sha256, at, source, approvedKey, approvedSubjects: subjects.size ? subjects : null, ocrCorrections: [...counts.values()] }));
    counts.clear();
  }
  return { proposals, paper, examId: job.examId };
}

/** Learns and stores (PROPOSED). Returns what changed in the memory. */
export async function learnPaperMemory(jobId: string, actorId: string): Promise<{ paper: string | null; proposals: number; added: number; updated: number; contradicted: number }> {
  const { proposals, paper, examId } = await proposalsForJob(jobId);
  if (!proposals.length) throw new ImportJobError("Nothing could be learned from this import (no readable source document, approved key or approved questions).");
  const r = await savePaperRuleProposals(examId, actorId, jobId, proposals);
  await logEvent(jobId, "PAPER_MEMORY_LEARNED", `Paper-format memory (${paper ?? "paper not identified"}): ${proposals.length} fact(s) measured from the source / approved data — ${r.added} new proposal(s), ${r.updated} with new evidence, ${r.contradicted} contradiction(s). Nothing is used until an administrator confirms it.`, { paper, ...r }, actorId);
  return { paper, proposals: proposals.length, ...r };
}
