import "server-only";
import { readFile } from "node:fs/promises";
import { AiImportJobStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatInr, usdToInr } from "@/lib/ai-engine/config";
import { getUsdInr, peekUsdInr } from "@/lib/ai-engine/fx";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { ImportJobError, logEvent } from "@/lib/ai-import/jobs";
import { kickWorker } from "@/lib/ai-import/kick";
import { pageText, renderPage } from "@/lib/ai-import/pdf";
import { visionImage } from "@/lib/ai-import/figures";
import { parsePage, type StepContext } from "@/lib/ai-import/process";
import { importerAiCall, ImporterAiFailure, ImporterAiUnavailable, PRICE_MARGIN, REQUEST_ATTEMPTS } from "@/lib/ai-import/ai";
import { EXTRACT_SYSTEM, extractUserText, toExtracted } from "@/lib/ai-import/prompts";
import { computeModelPlan, profileInputTokens, requestUsd } from "@/lib/ai-import/select";
import { OCR_MIN_CONFIDENCE, listReferences, type ReferencePaper, type ReferenceQuestion, type ReferenceRead } from "@/lib/ai-import/reference";
import { vaultPath } from "@/lib/ai-import/vault";
import type { TaskChoice } from "@/lib/ai-import/selection-types";

/**
 * Optional OCR / vision reading of a SCANNED reference paper (paid AI). Price → Confirm & Continue → read, like
 * Verify 2: the estimate and the maximum (every send it can make: REQUEST_ATTEMPTS per page to the model and, after
 * a failed page, REQUEST_ATTEMPTS to one fallback model) are shown first; nothing is sent without the
 * administrator's one confirmation. No application spending cap applies (owner decision 2026-10-26). The result is a REFERENCE_READ event (no migration):
 * evidence for Verify 1's comparison only. It never changes a question, an answer, a taxonomy or an image —
 * low-confidence pages / questions are marked "reference unreadable" and are never used as evidence.
 */

const FINISHED: AiImportJobStatus[] = [AiImportJobStatus.NEEDS_REVIEW, AiImportJobStatus.COMPLETED, AiImportJobStatus.COMPLETED_WITH_ISSUES];
const OUTPUT_TOKENS = 8000;

export interface ReferenceOcrState {
  status: "QUEUED" | "RUNNING" | "DONE" | "STOPPED";
  refId: string;
  name: string;
  model: string;
  choice: TaskChoice;
  /** The one model a failed page is sent to (optional: older requests have none). */
  fallback?: TaskChoice | null;
  pages: number[];
  estimateInr: number | null;
  maxInr: number;
  confirmedMaxInr: number;
  spentBeforeInr: number;
  requestedById: string | null;
  requestedAt: string;
  /** Pages read so far (with their questions) and pages that failed — a stopped reading resumes with the rest. */
  done: { page: number; questions: ReferenceQuestion[] }[];
  failedPages: number[];
  stopReason?: string | null;
  finishedAt?: string | null;
}

export interface ReferenceOcrPreview {
  refId: string;
  name: string;
  pages: number[];
  model: string | null;
  reason: string;
  perRequestMaxInr: number | null;
  /** The fallback model a failed page is sent to once (null = none suitable). */
  fallbackModel: string | null;
  estimateInr: number | null;
  maxInr: number | null;
  aiEnabled: boolean;
  problems: string[];
  canRun: boolean;
}

/** Pages of a reference that need OCR: PDF pages without a text layer, or the image itself. */
async function scannedPages(ref: ReferencePaper): Promise<number[]> {
  if (ref.kind === "png" || ref.kind === "jpeg") return [1];
  if (ref.kind !== "pdf" || !ref.pageCount) return [];
  const out: number[] = [];
  for (let p = 1; p <= ref.pageCount; p++) if ((await pageText(vaultPath(ref.storageKey), p)).replace(/\s+/g, "").length < 80) out.push(p);
  return out;
}

async function priceReferenceOcr(jobId: string, refId: string, refresh: boolean) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (!FINISHED.includes(job.status)) throw new ImportJobError("Read a reference once the import has finished processing.", 409);
  const ref = (await listReferences(jobId)).find((r) => r.refId === refId);
  if (!ref) throw new ImportJobError("That reference paper is not linked to this import.", 404);
  const settings = await getImporterSettings();
  const pages = ref.ocr ? [] : await scannedPages(ref);
  const problems: string[] = [];
  if (ref.ocr) problems.push(`“${ref.name}” was already read with ${ref.ocr.model}.`);
  else if (!pages.length) problems.push(`“${ref.name}” has no scanned page to read — its text was read without AI.`);
  if (!settings.aiEnabled) problems.push("Paid AI is switched off in Import Settings — reference OCR cannot run.");
  // The cheapest suitable image-reading model of the importer's list (the same selection rules as every request).
  const plan = await computeModelPlan({ ...settings, selection: { ...settings.selection, mode: "auto" } }, { refresh, jobId });
  const choice = plan.tasks.verify.model ? plan.tasks.verify : plan.tasks.extract;
  // One fallback for a failed page: the cheapest other eligible image-reading model (any price; it is priced below).
  const alt = choice.model ? (await computeModelPlan({ ...settings, selection: { ...settings.selection, mode: "auto" } }, { refresh: false, jobId }, { [choice.task]: [choice.model] })).tasks[choice.task] : null;
  const fallback = alt?.model && alt.model !== choice.model && alt.price ? alt : null;
  const fx = refresh ? await getUsdInr() : await peekUsdInr();
  let maxInr: number | null = null;
  let estimateInr: number | null = null;
  if (choice.model && choice.price && fx.rate) {
    const tokens = profileInputTokens("verify");
    const worst = requestUsd(choice.price, tokens, OUTPUT_TOKENS, 1) + (fallback?.price ? requestUsd(fallback.price, tokens, OUTPUT_TOKENS, 1) : 0);
    maxInr = Math.ceil((usdToInr(pages.length * REQUEST_ATTEMPTS * worst * PRICE_MARGIN, fx.rate) ?? 0) * 100) / 100;
    estimateInr = Math.ceil((usdToInr(pages.length * requestUsd(choice.price, tokens, 3200, 1), fx.rate) ?? 0) * 100) / 100;
  } else problems.push(`No suitable image-reading model: ${choice.reason}`);
  return { job, ref, settings, pages, choice, fallback, maxInr, estimateInr, problems };
}

export async function referenceOcrPreview(jobId: string, refId: string): Promise<ReferenceOcrPreview> {
  const p = await priceReferenceOcr(jobId, refId, false);
  return { refId, name: p.ref.name, pages: p.pages, model: p.choice.model, reason: p.choice.reason, perRequestMaxInr: p.choice.maxInr, fallbackModel: p.fallback?.model ?? null, estimateInr: p.estimateInr, maxInr: p.maxInr, aiEnabled: p.settings.aiEnabled, problems: p.problems, canRun: !p.problems.length && p.maxInr !== null };
}

export type ReferenceOcrRequest = { started: true; maxInr: number } | { started: false; preview: ReferenceOcrPreview; reason: string };

/**
 * Starts the reading only after the administrator confirmed the shown maximum; the price is computed again from fresh
 * routes first — a higher price than the one confirmed: nothing starts and the new maximum is shown to confirm.
 */
export async function requestReferenceOcr(input: { jobId: string; refId: string; actorId: string; confirmedMaxInr: number | null }): Promise<ReferenceOcrRequest> {
  const p = await priceReferenceOcr(input.jobId, input.refId, true);
  const preview: ReferenceOcrPreview = { refId: input.refId, name: p.ref.name, pages: p.pages, model: p.choice.model, reason: p.choice.reason, perRequestMaxInr: p.choice.maxInr, fallbackModel: p.fallback?.model ?? null, estimateInr: p.estimateInr, maxInr: p.maxInr, aiEnabled: p.settings.aiEnabled, problems: p.problems, canRun: !p.problems.length && p.maxInr !== null };
  if (!preview.canRun || p.maxInr === null || !p.choice.model) return { started: false, preview, reason: p.problems.join(" ") || "Reference OCR cannot run." };
  const confirmed = typeof input.confirmedMaxInr === "number" && Number.isFinite(input.confirmedMaxInr) ? input.confirmedMaxInr : null;
  if (confirmed === null) return { started: false, preview, reason: "Confirm the maximum cost first." };
  if (confirmed + 0.005 < p.maxInr) return { started: false, preview, reason: `The price changed: the maximum is now ${formatInr(p.maxInr)} (you confirmed ${formatInr(confirmed)}). Confirm the new maximum to continue.` };
  const budget = Math.max(p.job.budgetInr, Math.ceil((p.job.spentInr + p.maxInr) * 100) / 100);
  const state: ReferenceOcrState = { status: "QUEUED", refId: p.ref.refId, name: p.ref.name, model: p.choice.model, choice: p.choice, fallback: p.fallback, pages: p.pages, estimateInr: p.estimateInr, maxInr: p.maxInr, confirmedMaxInr: confirmed, spentBeforeInr: p.job.spentInr, requestedById: input.actorId, requestedAt: new Date().toISOString(), done: [], failedPages: [] };
  const r = await prisma.aiImportJob.updateMany({ where: { id: input.jobId, status: p.job.status }, data: { status: AiImportJobStatus.QUEUED, finishedAt: null, budgetInr: budget, config: { ...((p.job.config as object) ?? {}), referenceOcr: state } as unknown as Prisma.InputJsonValue } });
  if (!r.count) throw new ImportJobError("The import changed state at the same moment. Refresh and try again.", 409);
  await logEvent(input.jobId, "REFERENCE_OCR_REQUESTED", `Reference OCR of “${p.ref.name}” confirmed with ${p.choice.model}: ${p.pages.length} scanned page(s), estimated ${formatInr(p.estimateInr)}, maximum ${formatInr(p.maxInr)} (confirmed ${formatInr(confirmed)}). It is evidence only: no question, answer, subject or image is changed by it.`, { refId: p.ref.refId, model: p.choice.model, fallbackModel: p.fallback?.model ?? null, pages: p.pages, estimateInr: p.estimateInr, maxInr: p.maxInr, confirmedMaxInr: confirmed }, input.actorId);
  await prisma.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORT_REFERENCE_OCR_REQUESTED", entityType: "AiImportJob", entityId: input.jobId, metadata: { refId: p.ref.refId, model: p.choice.model, maxInr: p.maxInr, confirmedMaxInr: confirmed } } });
  kickWorker();
  return { started: true, maxInr: p.maxInr };
}

/** A reference question read by OCR: kept with its confidence; uncertain or textless reads are "unreadable". */
export function ocrQuestion(q: { section: string; number: number | null; stem: string; options: { text: string }[]; printedAnswer: string[]; pages: number[]; confidence: number }): ReferenceQuestion {
  const stem = q.stem.trim().slice(0, 2000);
  return { section: "", number: q.number, stem, options: q.options.map((o) => o.text.trim().slice(0, 500)), answer: q.printedAnswer, pages: q.pages, confidence: q.confidence, unreadable: q.confidence < OCR_MIN_CONFIDENCE || stem.replace(/\s+/g, "").length < 15 };
}

/** The worker's part: reads the remaining pages one request each; a failed page is recorded and the rest continue. */
export async function runReferenceOcr(ctx: StepContext): Promise<ReferenceOcrState> {
  const saveState = async (patch: Partial<ReferenceOcrState>): Promise<ReferenceOcrState> => {
    const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: ctx.job.id }, select: { config: true } });
    const cfg = (j.config as Record<string, unknown>) ?? {};
    const next = { ...(cfg.referenceOcr as ReferenceOcrState), ...patch };
    await prisma.aiImportJob.update({ where: { id: ctx.job.id }, data: { config: { ...cfg, referenceOcr: next } as unknown as Prisma.InputJsonValue } });
    return next;
  };
  let state = (ctx.job.config as { referenceOcr?: ReferenceOcrState } | null)?.referenceOcr;
  if (!state) throw new Error("Reference OCR request missing.");
  const ref = (await listReferences(ctx.job.id)).find((r) => r.refId === state!.refId);
  if (!ref) throw new ImporterAiUnavailable("The reference paper was unlinked before it was read. Nothing was sent.");
  state = await saveState({ status: "RUNNING" });
  const exam = await prisma.exam.findUnique({ where: { id: ctx.job.examId }, select: { name: true } });
  const full = vaultPath(ref.storageKey);
  const done = [...state.done];
  const failed = new Set(state.failedPages);
  for (const page of state.pages) {
    if (done.some((d) => d.page === page)) continue;
    if (!(await ctx.stillRunning())) return state;
    try {
      const render = ref.kind === "pdf" ? await renderPage(full, page, ctx.settings.limits.renderDpi) : await readFile(full);
      const image = await visionImage(render);
      const request = { jobId: ctx.job.id, task: "verify" as const, settings: ctx.settings, noReplace: true, system: EXTRACT_SYSTEM, content: [{ type: "text" as const, text: extractUserText({ exam: exam?.name ?? "Exam", subject: null, page, pages: ref.pageCount ?? 1, textLayer: null }) }, { type: "image_url" as const, image_url: { url: image, detail: "high" as const } }], maxOutputTokens: OUTPUT_TOKENS, needsVision: true };
      const read = async (c: TaskChoice) => {
        const r = await importerAiCall({ ...request, models: [c.model!], override: c });
        return toExtracted(parsePage(r.text, "the reference OCR answer"), page, r.model);
      };
      let qs;
      try {
        qs = await read(state.choice);
      } catch (e) {
        // A failed page is sent ONCE to the fallback model (priced in the confirmed maximum); a provider stop is not.
        const fb = state.fallback;
        if (!(e instanceof ImporterAiFailure) || !fb?.model) throw e;
        await logEvent(ctx.job.id, "MODEL_SWITCHED", `Reference OCR page ${page}: ${state.model} failed (${e.message.slice(0, 200)}); the same page is sent once to ${fb.model}.`, { refId: ref.refId, page, from: state.model, to: fb.model });
        qs = await read(fb);
      }
      done.push({ page, questions: qs.map(ocrQuestion) });
      failed.delete(page);
    } catch (e) {
      // A stop (paid AI off, emergency stop, provider unavailable / credits exhausted) ends the reading with what was read so far.
      if (e instanceof ImporterAiUnavailable || (e instanceof Error && e.name === "ImporterBudgetError")) {
        await saveState({ done, failedPages: [...failed] });
        throw e;
      }
      if (!(e instanceof ImporterAiFailure)) throw e;
      failed.add(page);
      await logEvent(ctx.job.id, "REFERENCE_OCR_PAGE_FAILED", `Reference “${ref.name}” page ${page}: OCR failed (${e.message.slice(0, 240)}). That page stays unread — never counted as agreement.`, { refId: ref.refId, page, error: e.message.slice(0, 300) });
    }
    state = await saveState({ done, failedPages: [...failed] });
  }
  const questions = done.sort((a, b) => a.page - b.page).flatMap((d) => d.questions);
  const read: ReferenceRead = { refId: ref.refId, model: state.model, at: new Date().toISOString(), pagesRead: done.map((d) => d.page), failedPages: [...failed], questions };
  const unreadable = questions.filter((q) => q.unreadable).length;
  await logEvent(ctx.job.id, "REFERENCE_READ", `Reference “${ref.name}” read by OCR with ${state.model}: ${done.length} of ${state.pages.length} page(s), ${questions.length} question(s)${unreadable ? ` (${unreadable} unreadable — confidence below ${Math.round(OCR_MIN_CONFIDENCE * 100)}%, never used as evidence)` : ""}${failed.size ? `, ${failed.size} page(s) failed` : ""}. Run Verify 1 (free) to compare it; nothing was changed by this reading.`, read as unknown as Record<string, unknown>);
  return saveState({ status: "DONE", finishedAt: new Date().toISOString() });
}
