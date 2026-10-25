import "server-only";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AiImportJobStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseImportFile } from "@/lib/bulk-import";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { CHUNK_BYTES } from "@/lib/ai-import/config";
import { checkFilename, detectFile } from "@/lib/ai-import/detect";
import { pageLayout, pdfInfo } from "@/lib/ai-import/pdf";
import { readDocx } from "@/lib/ai-import/docx";
import { parsePdfPageLocal } from "@/lib/ai-import/pdf-local";
import { blockToQuestion, splitQuestions, type NumberingState } from "@/lib/ai-import/local-parse";
import { parseKeyText, sheetPairs } from "@/lib/ai-import/keys";
import { readsAgree } from "@/lib/ai-import/process";
import { adoptFile, removeVaultDir, tmpDir, vaultPath, workDir } from "@/lib/ai-import/vault";
import { ImportJobError, logEvent } from "@/lib/ai-import/jobs";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

/**
 * Optional reference paper of an import (a previous paper, a clean copy, an answer-key document…).
 *
 * It is SUPPORTING EVIDENCE only: it is read locally (text layer, DOCX, spreadsheet — no AI, nothing paid),
 * kept in the private vault with the import (REFERENCE_ADDED event: name, sha256, vault key, what was read)
 * and compared with the extracted questions by the full-paper verification (Verify 1). Conflicts are shown;
 * the source paper's content is never replaced. Unlinking a reference keeps its file.
 */

/**
 * A single-request reference (the older multipart route) must stay under nginx's 20 MB request limit. Larger
 * references — up to the importer's per-file limit, like the question paper — are sent in parts
 * (startReferenceUpload → putReferenceChunk → completeReferenceUpload), because nginx answers a bigger single
 * request with its own HTML 413 page before the app ever sees it.
 */
export const REFERENCE_MAX_BYTES = 18 * 1024 * 1024;

export interface ReferenceQuestion {
  section: string;
  number: number | null;
  stem: string;
  options: string[];
  answer: string[];
  pages: number[];
  /** Read by paid OCR / vision (REFERENCE_READ): the reader's confidence (0–1). Absent for text read locally. */
  confidence?: number;
  /** OCR too uncertain to be evidence ("reference unreadable"): never used for a conflict or an answer. */
  unreadable?: boolean;
}

/** Below this OCR confidence (or without readable text) a reference question is "unreadable", never authoritative. */
export const OCR_MIN_CONFIDENCE = 0.7;

export interface ReferencePaper {
  refId: string;
  name: string;
  ext: string;
  kind: string;
  sha256: string;
  storageKey: string;
  bytes: number;
  pageCount: number | null;
  uploadedAt: string;
  uploadedById: string | null;
  questions: ReferenceQuestion[];
  key: { number: number; section: string; raw: string }[];
  textChars: number;
  /** What could not be read, in plain words (e.g. a scanned reference has no text without AI). */
  note: string | null;
  /** Pages without a text layer: stored, NOT compared (OCR / vision would be paid AI). Absent on older references. */
  scannedPages?: number;
  /** The administrator-confirmed OCR / vision reading of the scanned pages (latest REFERENCE_READ event), if any. */
  ocr?: { model: string; at: string; pagesRead: number[]; failedPages: number[]; unreadable: number } | null;
}

const FINISHED: AiImportJobStatus[] = [AiImportJobStatus.NEEDS_REVIEW, AiImportJobStatus.COMPLETED, AiImportJobStatus.COMPLETED_WITH_ISSUES];
const OPEN_FOR_REFERENCE: AiImportJobStatus[] = [AiImportJobStatus.DRAFT, AiImportJobStatus.AWAITING_CONFIRMATION, AiImportJobStatus.PAUSED, AiImportJobStatus.PAUSED_BUDGET, AiImportJobStatus.FAILED, ...FINISHED];

const strip = (s: string) => s.replace(/\s*⟦IMG:(?:\d+|missing)⟧\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
const toRef = (q: ExtractedQuestion): ReferenceQuestion => ({ section: q.section, number: q.number, stem: strip(q.stem).slice(0, 2000), options: q.options.map((o) => strip(o.text).slice(0, 500)), answer: q.printedAnswer, pages: q.pages });

/** Reads a reference file locally (never AI). */
async function readReference(full: string, kind: string, pages: number, jobId: string): Promise<Pick<ReferencePaper, "questions" | "key" | "textChars" | "note" | "scannedPages">> {
  const questions: ReferenceQuestion[] = [];
  let text = "";
  let note: string | null = null;
  if (kind === "pdf") {
    const work = workDir(jobId);
    await mkdir(work, { recursive: true, mode: 0o700 });
    const state: NumberingState = { last: 0, sectionIdx: 1 };
    let scanned = 0;
    for (let p = 1; p <= pages; p++) {
      const layout = await pageLayout(full, p, work);
      const pageText = layout.lines.map((l) => l.text).join("\n");
      text += `${pageText}\n`;
      if (pageText.replace(/\s+/g, "").length < 80) {
        scanned++;
        continue;
      }
      for (const q of parsePdfPageLocal({ lines: layout.lines, images: layout.images }, p, state).questions) questions.push(toRef(q));
    }
    if (scanned) note = `${scanned} of ${pages} page(s) have no text layer (scanned) — they cannot be compared without paid AI, so they are kept as a file only.`;
    if (scanned) {
      const key = parseKeyText(text).map((p) => ({ number: p.number, section: p.section, raw: p.raw }));
      if (!questions.length && !key.length) note = `${note} Nothing of this reference has been compared: reading it needs OCR / vision (${scanned} page image(s)).`;
      return { questions, key: questions.length >= 3 && key.length < 3 ? [] : key, textChars: text.length, note, scannedPages: scanned };
    }
  } else if (kind === "docx") {
    const doc = await readDocx(full);
    text = doc.lines.map((l) => l.text).join("\n");
    for (const b of splitQuestions(doc.lines).blocks) questions.push(toRef(blockToQuestion(b, 1, "DOCX").q));
  } else if (kind === "xlsx" || kind === "csv") {
    const bytes = await readFile(full);
    try {
      const parsed = await parseImportFile(new File([new Uint8Array(bytes)], `reference.${kind}`), "RICH");
      for (const r of parsed.rows) {
        const n = Number.parseInt(r.questionNumber ?? "", 10);
        questions.push({ section: "", number: Number.isFinite(n) ? n : null, stem: r.questionText.trim().slice(0, 2000), options: (["A", "B", "C", "D"] as const).map((l) => String(r[`option${l}` as const] ?? "").trim().slice(0, 500)), answer: [...new Set([...String(r.correctAnswer ?? "").toUpperCase().matchAll(/[A-D]/g)].map((m) => m[0]))], pages: [1] });
      }
    } catch {
      // Not a question sheet: maybe a two-column answer key.
    }
    const key = sheetPairs(bytes, kind);
    return { questions, key, textChars: bytes.length, note: !questions.length && !key.length ? "No questions or answer-key rows were recognized in the spreadsheet." : null };
  } else {
    return { questions: [], key: [], textChars: 0, note: "An image has no text layer: it is kept with the import for side-by-side checks, but it cannot be compared without paid AI.", scannedPages: 1 };
  }
  const key = parseKeyText(text).map((p) => ({ number: p.number, section: p.section, raw: p.raw }));
  if (!questions.length && !key.length && !note) note = "No numbered questions or answer-key entries were recognized in the reference.";
  return { questions, key: questions.length >= 3 && key.length < 3 ? [] : key, textChars: text.length, note };
}

/** The checks every reference passes before any byte is stored (job state, name, size, count). */
async function checkReference(jobId: string, rawName: string, size: number, maxBytes: number) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (!OPEN_FOR_REFERENCE.includes(job.status)) throw new ImportJobError("Add a reference paper before processing starts or once it has finished (not while it is running or after cancellation).", 409);
  const name = checkFilename(rawName);
  if (!name.ok) throw new ImportJobError(name.reason);
  const settings = await getImporterSettings();
  const max = Math.min(maxBytes, settings.limits.maxFileMb * 1024 * 1024);
  if (!size) throw new ImportJobError("The file is empty.");
  if (size > max) throw new ImportJobError(`The reference paper is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is ${Math.floor(max / 1024 / 1024)} MB.`, 413);
  if ((await listReferences(jobId)).length >= 5) throw new ImportJobError("An import holds at most 5 reference papers.");
  return { ext: name.ext, settings };
}

/** Stores and reads one reference file for an import (single request, ≤ REFERENCE_MAX_BYTES). */
export async function addReference(input: { jobId: string; actorId: string; name: string; bytes: Buffer }): Promise<ReferencePaper> {
  await checkReference(input.jobId, input.name, input.bytes.length, REFERENCE_MAX_BYTES);
  const id = `ref${randomBytes(8).toString("hex")}`;
  const dir = tmpDir(id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(/* turbopackIgnore: true */ dir, "upload");
  try {
    await writeFile(tmp, input.bytes, { mode: 0o600 });
    return await storeReference({ jobId: input.jobId, actorId: input.actorId, name: input.name, refId: id, tmp });
  } finally {
    await removeVaultDir("tmp", id).catch(() => undefined);
  }
}

/** Detects, vaults, reads and records an assembled reference file (`tmp`); the caller removes `tmp`. */
async function storeReference(input: { jobId: string; actorId: string; name: string; refId: string; tmp: string }): Promise<ReferencePaper> {
  const id = input.refId;
  const tmp = input.tmp;
  const { ext, settings } = await checkReference(input.jobId, input.name, (await stat(tmp)).size, Number.MAX_SAFE_INTEGER);
  const det = await detectFile(tmp, ext);
  if (!det.ok) throw new ImportJobError(det.reason ?? "The file was refused.");
  let pageCount: number | null = null;
  if (det.kind === "pdf") {
    const info = await pdfInfo(tmp);
    if (info.encrypted) throw new ImportJobError("The PDF is password-protected or encrypted. Upload an unprotected copy.");
    if (info.pages < 1) throw new ImportJobError("The PDF has no pages.");
    if (info.pages > settings.limits.maxPagesPerFile) throw new ImportJobError(`The PDF has ${info.pages} pages; the limit is ${settings.limits.maxPagesPerFile}.`);
    pageCount = info.pages;
  } else if (det.kind === "png" || det.kind === "jpeg") pageCount = 1;
  const kind = det.kind!;
  const adopted = await adoptFile(tmp, "files", kind === "jpeg" ? "jpg" : ext);
  const read = await readReference(vaultPath(adopted.key), kind, pageCount ?? 1, input.jobId).catch((e) => ({ questions: [], key: [], textChars: 0, note: `The reference could not be read (${e instanceof Error ? e.message.slice(0, 160) : "error"}); it is kept as a file only.` }));
  const ref: ReferencePaper = { refId: id, name: input.name.trim().slice(0, 200), ext: ext, kind, sha256: adopted.sha256, storageKey: adopted.key, bytes: adopted.bytes, pageCount, uploadedAt: new Date().toISOString(), uploadedById: input.actorId, ...read };
  await logEvent(input.jobId, "REFERENCE_ADDED", `Reference paper “${ref.name}” added (${kind.toUpperCase()}${pageCount ? `, ${pageCount} page${pageCount === 1 ? "" : "s"}` : ""}): ${ref.questions.length} question(s)${ref.key.length ? ` and ${ref.key.length} answer-key entr${ref.key.length === 1 ? "y" : "ies"}` : ""} read locally. ${ref.questions.length || ref.key.length ? "Used as supporting evidence by Verify 1; the source paper is never changed by it." : "It will NOT be compared by Verify 1 (nothing could be read from it without paid AI)."}${ref.note ? ` ${ref.note}` : ""}`, ref as unknown as Record<string, unknown>, input.actorId);
  await prisma.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORT_REFERENCE_ADDED", entityType: "AiImportJob", entityId: input.jobId, metadata: { refId: id, name: ref.name, sha256: ref.sha256, bytes: ref.bytes } } });
  return ref;
}

// ---- Chunked reference upload (same parts as the question paper: CHUNK_BYTES each) ----------------------

interface RefUploadManifest {
  jobId: string;
  actorId: string;
  name: string;
  size: number;
  chunks: number;
  createdAt: string;
}

const manifestPath = (uploadId: string) => path.join(/* turbopackIgnore: true */ tmpDir(uploadId), "manifest.json");
const partPath = (uploadId: string, i: number) => path.join(/* turbopackIgnore: true */ tmpDir(uploadId), `part-${i}`);

async function readManifest(uploadId: string, actorId: string): Promise<RefUploadManifest> {
  if (!/^ru[a-f0-9]{16}$/.test(uploadId)) throw new ImportJobError("Unknown reference upload.", 404);
  const m = (await readFile(manifestPath(uploadId), "utf8").then((s) => JSON.parse(s) as RefUploadManifest).catch(() => null));
  if (!m) throw new ImportJobError("This reference upload expired or was cancelled — choose the file again.", 404);
  if (m.actorId !== actorId) throw new ImportJobError("This reference upload belongs to another administrator.", 403);
  return m;
}

/** Starts a chunked reference upload after the name/size/job checks (nothing is stored in the vault yet). */
export async function startReferenceUpload(input: { jobId: string; actorId: string; name: string; size: number }): Promise<{ uploadId: string; chunks: number; chunkBytes: number }> {
  if (!Number.isSafeInteger(input.size) || input.size < 0) throw new ImportJobError("The file size is missing.");
  await checkReference(input.jobId, input.name, input.size, Number.MAX_SAFE_INTEGER);
  const uploadId = `ru${randomBytes(8).toString("hex")}`;
  const chunks = Math.ceil(input.size / CHUNK_BYTES);
  await mkdir(tmpDir(uploadId), { recursive: true, mode: 0o700 });
  const m: RefUploadManifest = { jobId: input.jobId, actorId: input.actorId, name: input.name.trim().slice(0, 200), size: input.size, chunks, createdAt: new Date().toISOString() };
  await writeFile(manifestPath(uploadId), JSON.stringify(m), { mode: 0o600 });
  return { uploadId, chunks, chunkBytes: CHUNK_BYTES };
}

/** Stores one part (idempotent per index: a retried part replaces the earlier copy). */
export async function putReferenceChunk(input: { uploadId: string; actorId: string; index: number; bytes: Buffer }): Promise<void> {
  const m = await readManifest(input.uploadId, input.actorId);
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= m.chunks) throw new ImportJobError("Invalid part number.");
  const want = input.index === m.chunks - 1 ? m.size - CHUNK_BYTES * (m.chunks - 1) : CHUNK_BYTES;
  if (input.bytes.length !== want) throw new ImportJobError(`Part ${input.index + 1} has ${input.bytes.length} bytes; expected ${want}. Upload the file again.`);
  await writeFile(partPath(input.uploadId, input.index), input.bytes, { mode: 0o600 });
}

/** Joins the parts, then detects, vaults and reads the reference like a single-request one. Always clears the parts. */
export async function completeReferenceUpload(input: { uploadId: string; actorId: string }): Promise<ReferencePaper> {
  const m = await readManifest(input.uploadId, input.actorId);
  try {
    const have = new Set((await readdir(tmpDir(input.uploadId))).filter((f) => f.startsWith("part-")));
    const missing = Array.from({ length: m.chunks }, (_, i) => i).filter((i) => !have.has(`part-${i}`));
    if (missing.length) throw new ImportJobError(`${missing.length} part(s) of the reference never arrived. Upload the file again.`);
    const full = path.join(/* turbopackIgnore: true */ tmpDir(input.uploadId), "upload");
    await writeFile(full, Buffer.alloc(0), { mode: 0o600 });
    for (let i = 0; i < m.chunks; i++) await appendFile(full, await readFile(partPath(input.uploadId, i)));
    if ((await stat(full)).size !== m.size) throw new ImportJobError("The assembled reference has the wrong size. Upload the file again.");
    return await storeReference({ jobId: m.jobId, actorId: input.actorId, name: m.name, refId: `ref${randomBytes(8).toString("hex")}`, tmp: full });
  } finally {
    await removeVaultDir("tmp", input.uploadId).catch(() => undefined);
  }
}

/** Cancels an unfinished reference upload (its parts are deleted; nothing was vaulted). */
export async function cancelReferenceUpload(input: { uploadId: string; actorId: string }): Promise<void> {
  await readManifest(input.uploadId, input.actorId);
  await removeVaultDir("tmp", input.uploadId);
}

/** The import's linked reference papers, oldest first (unlinked ones are left out; their files are kept). */
export async function listReferences(jobId: string): Promise<ReferencePaper[]> {
  const events = await prisma.aiImportEvent.findMany({ where: { jobId, type: { in: ["REFERENCE_ADDED", "REFERENCE_UNLINKED", "REFERENCE_READ"] } }, orderBy: { createdAt: "asc" }, select: { type: true, data: true } });
  const unlinked = new Set(events.filter((e) => e.type === "REFERENCE_UNLINKED").map((e) => (e.data as { refId?: string } | null)?.refId));
  // The latest confirmed OCR reading of each reference (lib/ai-import/reference-ocr.ts): its questions are the
  // reference's content for comparison; the stored file and the locally read text are never changed by it.
  const read = new Map<string, ReferenceRead>();
  for (const e of events) if (e.type === "REFERENCE_READ") read.set((e.data as unknown as ReferenceRead).refId, e.data as unknown as ReferenceRead);
  return events
    .filter((e) => e.type === "REFERENCE_ADDED" && !unlinked.has((e.data as { refId?: string } | null)?.refId))
    .map((e) => {
      const ref = e.data as unknown as ReferencePaper;
      const r = read.get(ref.refId);
      if (!r) return ref;
      return { ...ref, questions: [...ref.questions, ...r.questions], ocr: { model: r.model, at: r.at, pagesRead: r.pagesRead, failedPages: r.failedPages, unreadable: r.questions.filter((q) => q.unreadable).length } };
    });
}

/** Data of a REFERENCE_READ event: what the confirmed OCR / vision reading of a scanned reference found. */
export interface ReferenceRead {
  refId: string;
  model: string;
  at: string;
  pagesRead: number[];
  failedPages: number[];
  questions: ReferenceQuestion[];
}

export async function unlinkReference(jobId: string, refId: string, actorId: string): Promise<void> {
  const ref = (await listReferences(jobId)).find((r) => r.refId === refId);
  if (!ref) throw new ImportJobError("That reference paper is not linked to this import.", 404);
  await logEvent(jobId, "REFERENCE_UNLINKED", `Reference paper “${ref.name}” unlinked (its file is kept in the vault).`, { refId }, actorId);
}

// ---- Comparison (used by Verify 1) ----------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/\$|\\[a-z]+|[{}\s.,;:()[\]'"`]/g, "");
export function textSimilarity(x: string, y: string): number {
  const A = norm(x);
  const B = norm(y);
  if (!A && !B) return 1;
  const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 2) }, (_, i) => s.slice(i, i + 3)));
  const ga = grams(A);
  const gb = grams(B);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return ga.size + gb.size ? (2 * inter) / (ga.size + gb.size) : A === B ? 1 : 0;
}

export interface ReferenceComparison {
  /** The matching reference question was read by OCR too uncertainly to count ("reference unreadable"): no conflict, no answer. */
  unreadable?: boolean;
  matched: string | null;
  /** Wording similarity (0–1) of the matched reference question, or null when none matched. */
  similarity: number | null;
  conflicts: string[];
  /** The reference's answer for a question that has none (shown, applied only by an administrator). */
  suggestedAnswer: string[];
}

const refLabel = (r: { section: string; number: number | null }) => `${r.section ? `${r.section} ` : ""}Q${r.number ?? "?"}`;

/**
 * One question compared with a reference: matched by section + number, else by text (≥ 75 % similar, then the
 * numbering difference is a conflict). Question wording, options, numbers / symbols and the answer are compared.
 */
export function compareWithReference(q: ExtractedQuestion, answer: string[], ref: Pick<ReferencePaper, "questions" | "key">): ReferenceComparison {
  const out: ReferenceComparison = { matched: null, similarity: null, conflicts: [], suggestedAnswer: [] };
  // By number first (an OCR-read reference has no sections: its number alone is matched), then by wording.
  const sameNumber = (r: ReferenceQuestion) => r.number === q.number && (r.section === q.section || (r.confidence !== undefined && !r.section));
  let twin = ref.questions.find((r) => sameNumber(r) && !r.unreadable && textSimilarity(r.stem, q.stem) >= 0.5) ?? null;
  if (!twin) {
    const unreadable = ref.questions.find((r) => sameNumber(r) && r.unreadable);
    if (unreadable) return { ...out, matched: refLabel(unreadable), unreadable: true };
  }
  if (!twin && q.stem.trim()) {
    let best: { r: ReferenceQuestion; s: number } | null = null;
    for (const r of ref.questions) {
      const s = textSimilarity(r.stem, q.stem);
      if (s >= 0.75 && (!best || s > best.s)) best = { r, s };
    }
    if (best) {
      twin = best.r;
      if (best.r.number !== q.number || best.r.section !== q.section) out.conflicts.push(`The reference numbers this question ${refLabel(best.r)} (here ${refLabel(q)}) — check the question order.`);
    }
  }
  const keyEntry = ref.key.find((k) => k.number === q.number && k.section === q.section) ?? null;
  // Uncertain OCR is never presented as authoritative: shown as unreadable, compared with nothing.
  if (twin?.unreadable) return { ...out, matched: refLabel(twin), unreadable: true, conflicts: [] };
  if (twin) {
    out.matched = refLabel(twin);
    out.similarity = Math.round(textSimilarity(twin.stem, q.stem) * 100) / 100;
    const asQuestion: ExtractedQuestion = { ...q, stem: twin.stem, options: twin.options.map((t, i) => ({ label: String.fromCharCode(65 + i), printed: String.fromCharCode(65 + i), text: t })), printedAnswer: twin.answer, figures: q.figures };
    const v = readsAgree(q, asQuestion);
    if (!v.agree) {
      for (const part of v.detail.split("; ")) if (!/printed answer|figure/.test(part)) out.conflicts.push(`Reference: ${part}.`);
    }
  }
  const refAnswer = twin?.answer.length ? twin.answer : keyEntry ? [...new Set([...keyEntry.raw.toUpperCase().matchAll(/[A-D1-4]/g)].map((m) => (/\d/.test(m[0]) ? String.fromCharCode(64 + Number(m[0])) : m[0])))] : [];
  if (refAnswer.length) {
    if (answer.length && [...answer].sort().join() !== [...refAnswer].sort().join()) out.conflicts.push(`The reference gives answer ${refAnswer.join(", ")}, this question has ${answer.join(", ")}.`);
    else if (!answer.length) out.suggestedAnswer = refAnswer;
  }
  return out;
}

/** Reference questions with no counterpart in the source (possible missing questions — never added automatically). */
export function referenceOnly(ref: Pick<ReferencePaper, "questions">, questions: ExtractedQuestion[]): string[] {
  return ref.questions.filter((r) => !questions.some((q) => (q.number === r.number && q.section === r.section) || textSimilarity(q.stem, r.stem) >= 0.75)).map(refLabel);
}
