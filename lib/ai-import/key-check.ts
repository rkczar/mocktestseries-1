import "server-only";
import { AiImportFileRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseKeyHeader, type KeyHeader } from "@/lib/ai-import/keys";
import { logEvent } from "@/lib/ai-import/jobs";

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

/** An administrator's audited statement that a key whose identity could not be checked belongs to this paper. */
export interface KeyPaperConfirmation {
  by: string; at: string; note: string; detail: string;
  /** Bound to the exact file (vault content hash), the printed identity and the job: any change voids it. */
  sha256: string; jobId: string; printedPaper: string | null; printedSeries: string | null;
  /** "PROVISIONAL" (e.g. a coaching site's key) is recorded but never supplies official answers. */
  source: "OFFICIAL" | "PROVISIONAL";
}
/** The vault key is content-addressed (files/<aa>/<sha256>.<ext>). */
export const shaOfStorageKey = (k: string | null | undefined) => /\/([0-9a-f]{64})\.[a-z0-9]+$/.exec(k ?? "")?.[1] ?? null;

export interface KeyPaperCheck {
  keyFileId: string;
  keyFile: string;
  paperFileId: string | null;
  /** UNKNOWN fails closed (no official answers) until an administrator confirms the key (CONFIRMED, audited). */
  state: "MATCH" | "MISMATCH" | "UNKNOWN" | "CONFIRMED" | "PROVISIONAL";
  key: KeyHeader | null;
  confirmed?: KeyPaperConfirmation | null;
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
  // A longer printed header ("T.B.C. : NTDC-T-GSPO — Paper-II", 2026-11-20 CMS 2026 job): the number after the LAST "Paper".
  const m = [...v.toUpperCase().matchAll(/\bPAPER\s*(?:NO\.?)?\s*[-–—:.]?\s*\(?([IVX]{1,4}|\d{1,2})\)?(?![A-Z0-9])/g)].pop();
  if (m) return /^\d+$/.test(m[1]) ? String(Number(m[1])) : ROMAN[m[1]] ? String(ROMAN[m[1]]) : null;
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
  // Fail closed: a printed paper that cannot be read as a number, or a paper whose own number is unknown, is not a match
  // even when the series agrees (a Paper II key carries "Series A" too).
  if (key.paper && !(kp && pp)) return { state: "UNKNOWN", differences, detail: `The key prints "${key.paper}", which could not be compared with ${pp ? `this question paper (Paper ${paper.paper})` : "this question paper (its paper number is not known)"} — its answers are not used until an administrator confirms the key belongs to this paper.` };
  if (!compared.length) return { state: "UNKNOWN", differences, detail: `The key prints ${[key.paper && `Paper ${key.paper}`, key.series && `Series ${key.series}`, key.set && `Set ${key.set}`].filter(Boolean).join(", ") || "no paper or series"}, but the question paper's paper / series is not known, so they could not be compared.` };
  const totals = key.totalQuestions && paper.totalQuestions && key.totalQuestions !== paper.totalQuestions ? ` Note: the key says ${key.totalQuestions} questions, the paper is expected to have ${paper.totalQuestions}.` : "";
  return { state: "MATCH", differences, detail: `The key's printed ${compared.join(" and ")} match the question paper.${totals}` };
}

/** A key value that is only an option mark (or the dropped mark): "B", "(c)", "a.", "3", "A, C", "X" — never option text, "60" or "unreadable". */
const KEY_MARK = /^\s*\(?\s*(?:[A-Ha-h]|[1-8])\s*\)?\.?\s*(?:(?:,|&|\/|and)\s*\(?\s*(?:[A-Ha-h]|[1-8])\s*\)?\.?\s*)*$|^\s*(?:x|×|\*|-|—|dropped|deleted|withdrawn|bonus|cancelled|all)\s*$/i;
export const isKeyMark = (raw: string) => KEY_MARK.test(raw);

/**
 * Whether a read "answer key" can be an answer key at all (2026-11-20: the CMS 2026 Paper II TEST BOOKLET, 32 scanned
 * pages, was linked as Paper I's key; vision models returned "(b) Kocher", "60", "unreadable" and bare option letters
 * for 114 numbers). Returns why not, or null. Fails closed: a booklet cover, or a reading where more than 1 in 10 entries
 * is not an option mark, never supplies official answers.
 */
export function notAnAnswerKey(key: Pick<KeyHeader, "paper" | "series"> & { exam?: string | null; set?: string | null } | null, pageCount: number | null, raws: string[]): string | null {
  const head = [key?.exam, key?.paper, key?.series, key?.set].filter(Boolean).join(" ");
  if (/\b(?:test|question)\s*booklet\b/i.test(head) && (pageCount ?? 0) >= 6) return `The file looks like a question booklet, not an answer key: it prints "${head.slice(0, 80)}" on ${pageCount} pages.`;
  if (!raws.length) return null;
  const bad = raws.filter((r) => !isKeyMark(r));
  if (bad.length * 10 > raws.length) return `${bad.length} of ${raws.length} entries read from this file are not option marks (e.g. ${[...new Set(bad)].slice(0, 3).map((b) => `"${b.slice(0, 30)}"`).join(", ")}) — it does not read as an answer key.`;
  return null;
}

/** One check per answer-key file of the job. */
export async function keyPaperChecks(jobId: string): Promise<KeyPaperCheck[]> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { paperCode: true, previousYearPaperId: true, expectedQuestions: true } });
  if (!job) return [];
  const files = await prisma.aiImportFile.findMany({ where: { jobId }, select: { id: true, role: true, originalName: true, paperFileId: true, detected: true, pageCount: true, storageKey: true, sha256: true } });
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
    const notKey = notAnAnswerKey(key, k.pageCount, (await prisma.aiImportKeyEntry.findMany({ where: { keyFileId: k.id }, select: { rawValue: true } })).map((e) => e.rawValue));
    const stored = ((k.detected as { keyPaperConfirmed?: KeyPaperConfirmation } | null)?.keyPaperConfirmed ?? null) as KeyPaperConfirmation | null;
    // A confirmation counts only for the same file bytes, printed identity and job (fail closed otherwise).
    const sha = k.sha256 ?? shaOfStorageKey(k.storageKey);
    const confirmed = stored && sha && stored.sha256 === sha && stored.jobId === jobId && (stored.printedPaper ?? null) === (key?.paper ?? null) && (stored.printedSeries ?? null) === (key?.series ?? null) ? stored : null;
    const c = notKey ? { state: "MISMATCH" as const, differences: [notKey], detail: `This file never supplies official answers: ${notKey}` } : comparePaperIds(key, paper);
    // Only an UNKNOWN identity can be confirmed (audited); a mismatch or a non-key never can.
    const final = c.state === "UNKNOWN" && confirmed
      ? confirmed.source === "PROVISIONAL"
        ? { ...c, state: "PROVISIONAL" as const, detail: `PROVISIONAL key (not the official key) — confirmed for this paper on ${confirmed.at.slice(0, 16).replace("T", " ")} UTC (${confirmed.note}); kept for reference, never official answers.` }
        : { ...c, state: "CONFIRMED" as const, detail: `${c.detail} Confirmed as the OFFICIAL key by an administrator on ${confirmed.at.slice(0, 16).replace("T", " ")} UTC: ${confirmed.note}` }
      : stored && !confirmed ? { ...c, detail: `${c.detail} (An earlier confirmation no longer applies: the file, its printed identity or the import changed.)` } : c;
    out.push({ keyFileId: k.id, keyFile: k.originalName, paperFileId, key, paper, confirmed, ...final });
  }
  return out;
}

/** Audited confirmation that a key whose paper identity could not be checked belongs to this paper (never for a mismatch). */
export async function confirmKeyPaper(input: { jobId: string; keyFileId: string; actorId: string; note: string; source: "OFFICIAL" | "PROVISIONAL" }): Promise<KeyPaperCheck> {
  if (input.source !== "OFFICIAL" && input.source !== "PROVISIONAL") throw new Error("Say whether this is the official key or a provisional one.");
  const note = input.note.trim();
  if (note.length < 10) throw new Error("Say how you checked that this key belongs to this paper (at least 10 characters).");
  const check = (await keyPaperChecks(input.jobId)).find((c) => c.keyFileId === input.keyFileId);
  if (!check) throw new Error("This answer key was not found in this import.");
  if (check.state !== "UNKNOWN") throw new Error(check.state === "MISMATCH" ? "This key does not match this paper (or is not an answer key) — it cannot be confirmed. Upload the right key." : "Nothing to confirm: the key was already checked.");
  const file = await prisma.aiImportFile.findUniqueOrThrow({ where: { id: input.keyFileId }, select: { detected: true, storageKey: true, jobId: true, sha256: true } });
  const sha256 = file.sha256 ?? shaOfStorageKey(file.storageKey);
  if (!sha256 || file.jobId !== input.jobId) throw new Error("The key file's stored copy could not be identified, so it cannot be confirmed.");
  const confirmed: KeyPaperConfirmation = { by: input.actorId, at: new Date().toISOString(), note: note.slice(0, 500), detail: check.detail.slice(0, 500), sha256, jobId: input.jobId, printedPaper: check.key?.paper ?? null, printedSeries: check.key?.series ?? null, source: input.source };
  await prisma.aiImportFile.update({ where: { id: input.keyFileId }, data: { detected: { ...((file.detected as Record<string, unknown> | null) ?? {}), keyPaperConfirmed: confirmed } as never } });
  await logEvent(input.jobId, "KEY_PAPER_CONFIRMED", `${check.keyFile}: an administrator confirmed this answer key belongs to this paper as ${input.source === "PROVISIONAL" ? "a PROVISIONAL key (reference only, never official answers)" : "the OFFICIAL key"} — ${confirmed.note}`, { keyFileId: input.keyFileId, before: check.detail, sha256, source: input.source }, input.actorId);
  return (await keyPaperChecks(input.jobId)).find((c) => c.keyFileId === input.keyFileId)!;
}
