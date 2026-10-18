import "server-only";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { AiImportFileRole, AiImportFileStatus, AiImportJobStatus, type AiImportFile, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runTool } from "@/lib/ai-import/tools";
import { imagesPerPage } from "@/lib/ai-import/pdf";
import { readDocx } from "@/lib/ai-import/docx";
import { notationRisk, scriptFragments, splitQuestions, type Line } from "@/lib/ai-import/local-parse";
import { parseImportFile } from "@/lib/bulk-import";
import { vaultPath } from "@/lib/ai-import/vault";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { estimateJobCost, type CostEstimate } from "@/lib/ai-import/estimate";
import { computeModelPlan } from "@/lib/ai-import/select";
import { logEvent } from "@/lib/ai-import/jobs";

/**
 * Free, local analysis of uploaded files (no AI, no network). Produces the
 * report shown before processing: everything here is MEASURED ("detected"),
 * except the cost/time estimate, which is labelled as an estimate.
 */

export interface PageFact {
  page: number;
  textChars: number;
  images: number;
  kind: "TEXT" | "SCANNED" | "BLANK" | "DOCUMENT";
  risk: string[];
  /** Question numbers recognized locally on this page. */
  localQuestions: number;
}

export interface FileFacts {
  kind: string;
  pages: number;
  textPages: number;
  scannedPages: number;
  blankPages: number;
  embeddedImages: number;
  /** Questions recognized by the local parser (lower bound when pages are scanned). */
  localQuestionCount: number;
  questionTypes: Record<string, number>;
  answerKeyDetected: boolean;
  formulasLikely: boolean;
  tablesLikely: boolean;
  documentType: "QUESTION_PAPER" | "ANSWER_KEY" | "PAPER_WITH_ANSWERS" | "SPREADSHEET" | "UNKNOWN";
  notes: string[];
  pagesDetail: PageFact[];
}

const KEY_PAIR = /(?:^|\s)(\d{1,3})\s*[.):\-–]?\s*\(?([A-Da-d1-4])\)?(?=\s|$)/g;

function looksLikeAnswerKey(text: string): boolean {
  const pairs = [...text.matchAll(KEY_PAIR)].length;
  return /answer\s*key|answers?\s*:/i.test(text) && pairs >= 10;
}

function typeCounts(texts: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (k: string, n: number) => n && (out[k] = (out[k] ?? 0) + n);
  const all = texts.join("\n");
  add("Assertion–Reason", (all.match(/\bAssertion\b/gi) ?? []).length);
  add("Match the Following", (all.match(/\b(List|Column)[\s-]*I\b(?![I])/gi) ?? []).length);
  add("Multiple correct", (all.match(/\bone or more\b|\bmore than one\b/gi) ?? []).length);
  add("Numerical", (all.match(/\b(integer|numerical value)\b/gi) ?? []).length);
  return out;
}

/** Per page: small text fragments (flattened sub/superscripts), from ONE pdftohtml pass over the document. */
async function scriptFragmentsPerPage(full: string): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  let xml: string;
  try {
    xml = (await runTool("pdftohtml", ["-xml", "-i", "-q", "-stdout", "-zoom", "1.5", full], { timeoutMs: 180_000, maxOutput: 64 * 1024 * 1024 })).toString("utf8");
  } catch {
    return out;
  }
  for (const page of xml.matchAll(/<page number="(\d+)"[^>]*height="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/g)) {
    const segs = [...page[3].matchAll(/<text [^>]*height="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)].map((m) => ({ text: m[2].replace(/<[^>]+>/g, ""), box: { x: 0, y: 0, w: 0, h: Number(m[1]) / Number(page[2]) } }));
    const n = scriptFragments(segs);
    if (n) out.set(Number(page[1]), n);
  }
  return out;
}

async function analyzePdf(file: AiImportFile): Promise<FileFacts> {
  const full = vaultPath(file.storageKey!);
  const pages = file.pageCount ?? 0;
  const text = (await runTool("pdftotext", ["-layout", "-enc", "UTF-8", full, "-"], { timeoutMs: 180_000, maxOutput: 64 * 1024 * 1024 })).toString("utf8");
  const perPage = text.split("\f").slice(0, pages);
  const imgs = await imagesPerPage(full, pages);
  const fragments = await scriptFragmentsPerPage(full);
  const state = { last: 0, sectionIdx: 1 };
  const detail: PageFact[] = [];
  let local = 0;
  for (let i = 0; i < pages; i++) {
    const t = perPage[i] ?? "";
    const chars = t.replace(/\s+/g, "").length;
    const images = imgs.get(i + 1) ?? 0;
    const kind: PageFact["kind"] = chars >= 80 ? "TEXT" : images > 0 || chars > 0 ? "SCANNED" : "BLANK";
    const lines: Line[] = t.split("\n").map((l) => ({ text: l.trim() })).filter((l) => l.text);
    const found = kind === "TEXT" ? splitQuestions(lines, state).blocks.length : 0;
    local += found;
    const risk = kind === "TEXT" ? notationRisk(t) : [];
    if (kind === "TEXT" && (fragments.get(i + 1) ?? 0) > 0) risk.push(`${fragments.get(i + 1)} subscript/superscript fragment(s) the text layer flattens`);
    detail.push({ page: i + 1, textChars: chars, images, kind, risk, localQuestions: found });
  }
  const textPages = detail.filter((d) => d.kind === "TEXT").length;
  const scannedPages = detail.filter((d) => d.kind === "SCANNED").length;
  const answerKeyDetected = perPage.some(looksLikeAnswerKey);
  const notes: string[] = [];
  if (scannedPages) notes.push(`${scannedPages} page(s) have no text layer (scanned) — they need AI vision (or manual entry).`);
  if (detail.some((d) => d.risk.length)) notes.push(`${detail.filter((d) => d.risk.length).length} page(s) may contain formulas or symbols the text layer can flatten — they will be read from the page image.`);
  return {
    kind: "PDF",
    pages,
    textPages,
    scannedPages,
    blankPages: detail.filter((d) => d.kind === "BLANK").length,
    embeddedImages: [...imgs.values()].reduce((a, b) => a + b, 0),
    localQuestionCount: local,
    questionTypes: typeCounts(perPage),
    answerKeyDetected,
    formulasLikely: detail.some((d) => d.risk.length > 0),
    tablesLikely: /\|.+\|/.test(text) || /\bTable\b/i.test(text),
    documentType: answerKeyDetected && local < 5 ? "ANSWER_KEY" : answerKeyDetected ? "PAPER_WITH_ANSWERS" : local > 0 || scannedPages > 0 ? "QUESTION_PAPER" : "UNKNOWN",
    notes,
    pagesDetail: detail,
  };
}

async function analyzeDocx(file: AiImportFile): Promise<FileFacts> {
  const doc = await readDocx(vaultPath(file.storageKey!));
  const { blocks } = splitQuestions(doc.lines);
  const text = doc.lines.map((l) => l.text).join("\n");
  const notes: string[] = [];
  if (doc.externalImages) notes.push(`${doc.externalImages} image(s) are linked from outside the document or in an unsupported format — they will be flagged.`);
  if (doc.unconvertedMath) notes.push(`${doc.unconvertedMath} equation part(s) use constructs the converter does not know — those questions will be flagged.`);
  const keyLike = looksLikeAnswerKey(text);
  return {
    kind: "DOCX",
    pages: 1,
    textPages: 1,
    scannedPages: 0,
    blankPages: 0,
    embeddedImages: doc.media.length,
    localQuestionCount: blocks.length,
    questionTypes: typeCounts([text]),
    answerKeyDetected: keyLike,
    formulasLikely: doc.richLines > 0,
    tablesLikely: false,
    documentType: keyLike && blocks.length < 5 ? "ANSWER_KEY" : blocks.length ? "QUESTION_PAPER" : "UNKNOWN",
    notes,
    pagesDetail: [{ page: 1, textChars: text.length, images: doc.media.length, kind: "DOCUMENT", risk: [], localQuestions: blocks.length }],
  };
}

async function analyzeSheet(file: AiImportFile): Promise<FileFacts> {
  const bytes = await readFile(vaultPath(file.storageKey!));
  const parsed = await parseImportFile(new File([new Uint8Array(bytes)], `${file.id}.${file.ext}`), "RICH");
  const notes = parsed.errors.slice(0, 5);
  notes.push("Spreadsheets in the Bulk Import template can also be imported directly with Question Bank → Bulk Import.");
  return {
    kind: file.ext.toUpperCase(),
    pages: 1,
    textPages: 1,
    scannedPages: 0,
    blankPages: 0,
    embeddedImages: 0,
    localQuestionCount: parsed.rows.length,
    questionTypes: {},
    answerKeyDetected: parsed.rows.some((r) => r.correctAnswer),
    formulasLikely: parsed.rows.some((r) => /\$|\\ce\{/.test(r.questionText)),
    tablesLikely: false,
    documentType: parsed.rows.length ? "SPREADSHEET" : "UNKNOWN",
    notes,
    pagesDetail: [{ page: 1, textChars: 0, images: 0, kind: "DOCUMENT", risk: [], localQuestions: parsed.rows.length }],
  };
}

async function analyzeImage(file: AiImportFile): Promise<FileFacts> {
  const meta = await sharp(vaultPath(file.storageKey!), { limitInputPixels: 60_000_000 }).metadata();
  const small = (meta.width ?? 0) < 900 && (meta.height ?? 0) < 900;
  return {
    kind: file.ext.toUpperCase(),
    pages: 1,
    textPages: 0,
    scannedPages: 1,
    blankPages: 0,
    embeddedImages: 1,
    localQuestionCount: 0,
    questionTypes: {},
    answerKeyDetected: false,
    formulasLikely: false,
    tablesLikely: false,
    documentType: "QUESTION_PAPER",
    notes: [`${meta.width}×${meta.height} px image — read with AI vision.${small ? " The resolution is low; small text may be unreadable." : ""}`],
    pagesDetail: [{ page: 1, textChars: 0, images: 1, kind: "SCANNED", risk: [], localQuestions: 0 }],
  };
}

export async function analyzeFile(file: AiImportFile): Promise<FileFacts> {
  const kind = (file.detected as { kind?: string } | null)?.kind;
  if (kind === "pdf") return analyzePdf(file);
  if (kind === "docx") return analyzeDocx(file);
  if (kind === "xlsx" || kind === "csv") return analyzeSheet(file);
  return analyzeImage(file);
}

export interface JobAnalysis {
  files: { fileId: string; name: string; role: string; facts: FileFacts | null; error: string | null }[];
  totals: { pages: number; textPages: number; scannedPages: number; localQuestions: number; embeddedImages: number; answerKeyFiles: number };
  estimate: CostEstimate;
  analyzedAt: string;
}

/** Worker step: analyze every uploaded file of a job, then wait for the admin's confirmation. */
export async function runAnalysis(jobId: string): Promise<void> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, include: { files: { orderBy: { createdAt: "asc" } } } });
  if (!job) return;
  const settings = await getImporterSettings();
  const results: JobAnalysis["files"] = [];
  for (const file of job.files) {
    if (file.status === AiImportFileStatus.REJECTED || file.status === AiImportFileStatus.UPLOADING || !file.storageKey) continue;
    try {
      const facts = await analyzeFile(file);
      results.push({ fileId: file.id, name: file.originalName, role: file.role, facts, error: null });
      await prisma.aiImportFile.update({ where: { id: file.id }, data: { status: AiImportFileStatus.ANALYZED, pageCount: facts.pages, detected: { ...((file.detected as object) ?? {}), facts } as unknown as Prisma.InputJsonValue } });
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 300) : "analysis failed";
      results.push({ fileId: file.id, name: file.originalName, role: file.role, facts: null, error: msg });
      await prisma.aiImportFile.update({ where: { id: file.id }, data: { status: AiImportFileStatus.REJECTED, errorMessage: `Could not be analyzed: ${msg}` } });
    }
  }
  const paperFacts = results.filter((r) => r.role === AiImportFileRole.PAPER && r.facts).map((r) => r.facts!);
  const keyFacts = results.filter((r) => r.role === AiImportFileRole.ANSWER_KEY && r.facts).map((r) => r.facts!);
  const totals = {
    pages: paperFacts.reduce((a, f) => a + f.pages, 0),
    textPages: paperFacts.reduce((a, f) => a + f.textPages, 0),
    scannedPages: paperFacts.reduce((a, f) => a + f.scannedPages, 0),
    localQuestions: paperFacts.reduce((a, f) => a + f.localQuestionCount, 0),
    embeddedImages: paperFacts.reduce((a, f) => a + f.embeddedImages, 0),
    answerKeyFiles: keyFacts.length,
  };
  // The model plan is chosen again (fresh routes) at confirmation; this one shows what it would be now.
  const plan = await computeModelPlan(settings, { refresh: settings.aiEnabled });
  const estimate = await estimateJobCost({ paperFacts, keyFacts, settings, plan });
  const analysis: JobAnalysis = { files: results, totals, estimate, analyzedAt: new Date().toISOString() };
  // Only while still analyzing: a job cancelled (or deleted) during the analysis stays that way.
  const r = await prisma.aiImportJob.updateMany({
    where: { id: jobId, status: AiImportJobStatus.ANALYZING },
    data: { analysis: analysis as unknown as Prisma.InputJsonValue, estCostInr: estimate.totalInr, estCostUsd: estimate.totalUsd, estimate: estimate as unknown as Prisma.InputJsonValue, status: AiImportJobStatus.AWAITING_CONFIRMATION },
  });
  if (!r.count) return;
  await logEvent(jobId, "ANALYZED", `Analysis finished: ${totals.pages} page(s), ${totals.localQuestions} question(s) recognized locally, ${totals.scannedPages} scanned page(s). Estimated AI cost ${estimate.totalInr === null ? "not available" : `₹${estimate.totalInr.toFixed(2)} (maximum ${estimate.maxInr === null ? "not available" : `₹${estimate.maxInr.toFixed(2)}`})`}.`, { totals });
}
