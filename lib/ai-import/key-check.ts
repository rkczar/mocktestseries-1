import "server-only";
import { AiImportFileRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseKeyHeader, type KeyHeader } from "@/lib/ai-import/keys";

/**
 * Does an uploaded answer key belong to this question paper? The identifiers PRINTED on the key (paper number,
 * series / set code — read by lib/ai-import/keys.ts) are compared with what is known about the paper: its own
 * printed header (cover / instructions page) first, then the paper code chosen for the job and its PYQ paper.
 * Only identifiers known on BOTH sides are compared; anything not printed is "unknown", never assumed. A
 * mismatch blocks the key's answers (post.ts ANSWER_KEY_PAPER_MISMATCH): they are kept for reference but never
 * become official answers of this paper. Read-only; no AI.
 */

export interface PaperIds {
  paper: string | null;
  series: string | null;
  totalQuestions: number | null;
  /** Where the paper-side identifiers come from. */
  source: string;
}

export interface KeyPaperCheck {
  keyFileId: string;
  keyFile: string;
  paperFileId: string | null;
  state: "MATCH" | "MISMATCH" | "UNKNOWN";
  key: KeyHeader | null;
  paper: PaperIds;
  /** Plain-English differences ("the key is for Paper I, the question paper is Paper II"). */
  differences: string[];
  detail: string;
}

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

/** "II", "2", "Paper-2", "(ii)" → "2"; null when it is not a paper number. */
export function paperNumber(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.toUpperCase().replace(/PAPER|NO\.?|[\s().:-]/g, "");
  if (/^\d{1,2}$/.test(t)) return String(Number(t));
  if (ROMAN[t]) return String(ROMAN[t]);
  return null;
}

/** "A", "(A)", "Series-A" → "A"; null when it is not a series / set letter or code. */
export function seriesCode(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.toUpperCase().replace(/SERIES|SET|BOOKLET|CODE|[\s().:-]/g, "");
  return /^[A-Z0-9]{1,3}$/.test(t) ? t : null;
}

/** Compares the key's identifiers with the paper's (pure). */
export function comparePaperIds(key: KeyHeader | null, paper: PaperIds): { state: KeyPaperCheck["state"]; differences: string[]; detail: string } {
  if (!key) return { state: "UNKNOWN", differences: [], detail: "The answer key does not print its paper or series, so it cannot be checked against the question paper." };
  const differences: string[] = [];
  const compared: string[] = [];
  const kp = paperNumber(key.paper);
  const pp = paperNumber(paper.paper);
  if (kp && pp) {
    compared.push(`Paper ${pp}`);
    if (kp !== pp) differences.push(`the key is printed for Paper ${key.paper}, the question paper is Paper ${paper.paper} (${paper.source})`);
  }
  const ks = seriesCode(key.series ?? key.set);
  const ps = seriesCode(paper.series);
  if (ks && ps) {
    compared.push(`Series ${ps}`);
    if (ks !== ps) differences.push(`the key is printed for Series ${key.series ?? key.set}, the question paper is Series ${paper.series} (${paper.source})`);
  }
  if (differences.length) return { state: "MISMATCH", differences, detail: `This answer key does not belong to this question paper: ${differences.join("; ")}.` };
  if (!compared.length) return { state: "UNKNOWN", differences, detail: `The key prints ${[key.paper && `Paper ${key.paper}`, key.series && `Series ${key.series}`, key.set && `Set ${key.set}`].filter(Boolean).join(", ") || "no paper or series"}, but the question paper's paper / series is not known, so they could not be compared.` };
  const totals = key.totalQuestions && paper.totalQuestions && key.totalQuestions !== paper.totalQuestions ? ` Note: the key says ${key.totalQuestions} questions, the paper is expected to have ${paper.totalQuestions}.` : "";
  return { state: "MATCH", differences, detail: `The key's printed ${compared.join(" and ")} match the question paper.${totals}` };
}

/** One check per answer-key file of the job. */
export async function keyPaperChecks(jobId: string): Promise<KeyPaperCheck[]> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { paperCode: true, previousYearPaperId: true, expectedQuestions: true } });
  if (!job) return [];
  const files = await prisma.aiImportFile.findMany({ where: { jobId }, select: { id: true, role: true, originalName: true, paperFileId: true, detected: true } });
  const keys = files.filter((f) => f.role === AiImportFileRole.ANSWER_KEY && (f.detected as { keyHeader?: unknown } | null)?.keyHeader !== undefined);
  if (!keys.length) return [];
  const papers = files.filter((f) => f.role === AiImportFileRole.PAPER);
  const pyq = job.previousYearPaperId ? await prisma.previousYearPaper.findUnique({ where: { id: job.previousYearPaperId }, select: { paperCode: true } }) : null;
  const printedOf = async (paperFileId: string | null): Promise<PaperIds | null> => {
    if (!paperFileId) return null;
    const pages = await prisma.aiImportPage.findMany({ where: { fileId: paperFileId, pageNumber: { lte: 3 } }, orderBy: { pageNumber: "asc" }, select: { pageNumber: true, textLayer: true, rawOutput: true } });
    for (const p of pages) {
      const ai = (p.rawOutput as { ai?: { paper_header?: { paper?: string | null; series?: string | null; set?: string | null; total_questions?: number | string | null } | null } } | null)?.ai?.paper_header;
      const h = ai ? { paper: ai.paper ?? null, series: ai.series ?? ai.set ?? null, totalQuestions: ai.total_questions ? Number.parseInt(String(ai.total_questions), 10) || null : null } : p.textLayer ? parseKeyHeader(p.textLayer) : null;
      if (h && (h.paper || h.series)) return { paper: h.paper, series: h.series ?? null, totalQuestions: h.totalQuestions ?? null, source: `printed on page ${p.pageNumber} of the question paper` };
    }
    return null;
  };
  const out: KeyPaperCheck[] = [];
  for (const k of keys) {
    const paperFileId = k.paperFileId ?? (papers.length === 1 ? papers[0].id : null);
    const printed = await printedOf(paperFileId);
    // The job's paper code (and its PYQ paper's) say which paper / series this import is, when the paper prints nothing.
    const code = job.paperCode ?? pyq?.paperCode ?? null;
    const fromCode: PaperIds = { paper: paperNumber(code) ? code : null, series: !paperNumber(code) && seriesCode(code) ? code : null, totalQuestions: job.expectedQuestions, source: "the paper code chosen for this import" };
    const paper: PaperIds = printed ? { ...printed, paper: printed.paper ?? fromCode.paper, series: printed.series ?? fromCode.series, totalQuestions: printed.totalQuestions ?? job.expectedQuestions } : fromCode;
    const key = ((k.detected as { keyHeader?: KeyHeader | null } | null)?.keyHeader ?? null) as KeyHeader | null;
    const c = comparePaperIds(key, paper);
    out.push({ keyFileId: k.id, keyFile: k.originalName, paperFileId, key, paper, ...c });
  }
  return out;
}
