import { AiImportFileStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ensureRender } from "@/lib/ai-import/process";
import { cropFromRender } from "@/lib/ai-import/figures";
import { putContent } from "@/lib/ai-import/vault";
import { rescanTarget, type PlacedQuestion } from "@/lib/ai-import/rescan-target";
import { getImporterSettings } from "@/lib/ai-import/settings";
import type { NBox } from "@/lib/ai-import/types";

/**
 * Source evidence of an imported question (QuestionSource, 2026-11-26): provenance plus GENUINE crops of the original
 * question and of its answer-key entry, cut from the original page renders and stored content-addressed in the vault
 * (figures/), so they outlive render cleanup and original-file retention. Never AI-generated; when the original is gone
 * the row says so (cropNote / keyStatus) instead of inventing an image. Idempotent: re-capturing refreshes the row.
 */

type Crop = { key: string; page: number; box: NBox | null };
type Data = { section?: string; number?: number | null; region?: NBox | null; sourceText?: string | null; ocr?: { engine?: string; confidence?: number } | null; method?: string };

const PAD_X = 0.06;
const PAD_Y = 0.012;
const widen = (b: NBox): NBox => {
  const x = Math.max(0, b.x - PAD_X);
  const y = Math.max(0, b.y - PAD_Y);
  return { x, y, w: Math.min(1, b.x + b.w + PAD_X) - x, h: Math.min(1, b.y + b.h + PAD_Y) - y };
};
const validBox = (b: unknown): b is NBox => {
  const v = b as Partial<NBox> | null;
  return !!v && [v.x, v.y, v.w, v.h].every((n) => typeof n === "number" && Number.isFinite(n)) && v.w! > 0 && v.h! > 0;
};

async function store(bytes: Buffer): Promise<string> {
  return (await putContent("figures", bytes, "png")).key;
}

/** Captures (or refreshes) the source evidence of one imported importer question. Returns null when it is not imported. */
export async function captureQuestionSource(aiImportQuestionId: string): Promise<{ questionId: string; crops: number; key: string | null } | null> {
  const q = await prisma.aiImportQuestion.findUnique({ where: { id: aiImportQuestionId }, include: { job: { select: { id: true, title: true, year: true, previousYearPaperId: true } } } });
  if (!q?.questionId) return null;
  const [file, paper, settings] = await Promise.all([
    prisma.aiImportFile.findUnique({ where: { id: q.fileId } }),
    q.job.previousYearPaperId ? prisma.previousYearPaper.findUnique({ where: { id: q.job.previousYearPaperId }, select: { title: true, year: true } }) : null,
    getImporterSettings(),
  ]);
  const dpi = settings.limits.renderDpi;
  const e = ((q.editedData ?? q.data) ?? {}) as Data;
  const raw = (q.data ?? {}) as Data;

  // Question crop(s): the question's own band (same targeting as Re-scan), its two-page continuation, or the whole page.
  const crops: Crop[] = [];
  let cropNote: string | null = null;
  if (!file || file.status === AiImportFileStatus.PURGED || !file.storageKey) cropNote = "Original paper file is no longer stored (retention) — source crop unavailable.";
  else if (!q.pages.length) cropNote = "No source page was recorded for this question.";
  else {
    try {
      const others = (await prisma.aiImportQuestion.findMany({ where: { fileId: q.fileId, id: { not: q.id } }, select: { pages: true, data: true, editedData: true } })).map((o): PlacedQuestion => {
        const d = ((o.editedData ?? o.data) ?? {}) as Data;
        return { section: d.section ?? "", number: typeof d.number === "number" ? d.number : null, pages: o.pages, region: d.region ?? null };
      });
      const t = rescanTarget({ section: e.section ?? "", number: typeof e.number === "number" ? e.number : q.sourceNumber, pages: q.pages, region: e.region ?? raw.region ?? null }, others, false);
      const parts: { page: number; box: NBox | null }[] = t.kind === "REGION" ? [{ page: t.page, box: t.box }] : t.kind === "STACK" ? [{ page: t.pages[0], box: t.boxes[0] }, { page: t.pages[1], box: t.boxes[1] }] : t.pages.slice(0, 2).map((p) => ({ page: p, box: null }));
      for (const part of parts) {
        const render = await ensureRender(q.job, file, part.page, dpi);
        const bytes = part.box ? (await cropFromRender(render, part.box, 0))?.bytes : render;
        if (bytes) crops.push({ key: await store(bytes), page: part.page, box: part.box });
      }
      if (t.kind === "PAGES") cropNote = `Whole page shown: ${t.why}.`;
    } catch (err) {
      cropNote = `Source crop could not be made: ${(err as Error).message.slice(0, 160)}`;
    }
  }

  // Answer-key evidence: the matched key entry's cell (local OCR box) or its whole key page.
  const entry = await prisma.aiImportKeyEntry.findFirst({ where: { OR: [{ matchedQuestionId: q.id }, ...(q.sourceNumber !== null ? [{ jobId: q.jobId, sourceNumber: q.sourceNumber, section: e.section ?? "" }] : [])] }, orderBy: [{ matchedQuestionId: "asc" }, { createdAt: "desc" }] });
  const keyFile = entry ? await prisma.aiImportFile.findUnique({ where: { id: entry.keyFileId } }) : null;
  let keyCrop: { key: string; page: number; box: NBox | null; kind: "CELL" | "PAGE" } | null = null;
  let keyStatus: string;
  if (!entry) keyStatus = (await prisma.aiImportFile.count({ where: { jobId: q.jobId, role: "ANSWER_KEY" } })) ? "NO_ENTRY" : "NOT_AVAILABLE";
  else {
    const conf = (keyFile?.detected as { keyPaperConfirmed?: { source?: string } } | null)?.keyPaperConfirmed?.source;
    keyStatus = conf === "PROVISIONAL" ? "PROVISIONAL" : q.answerStatus === "OFFICIAL_MATCHED" || q.answerStatus === "WITHDRAWN" || conf === "OFFICIAL" ? "OFFICIAL" : "UNCONFIRMED";
    if (keyFile && keyFile.status !== AiImportFileStatus.PURGED && keyFile.storageKey && entry.page) {
      try {
        const render = await ensureRender(q.job, keyFile, entry.page, dpi);
        if (validBox(entry.box)) {
          const b = widen(entry.box as NBox);
          const c = await cropFromRender(render, b, 0);
          if (c) keyCrop = { key: await store(c.bytes), page: entry.page, box: b, kind: "CELL" };
        }
        if (!keyCrop) keyCrop = { key: await store(render), page: entry.page, box: null, kind: "PAGE" };
      } catch {
        keyCrop = null;
      }
    }
  }

  const data = {
    aiImportQuestionId: q.id,
    jobId: q.jobId,
    jobTitle: q.job.title,
    fileId: q.fileId,
    fileName: file?.originalName ?? null,
    year: paper?.year ?? q.job.year ?? null,
    paperTitle: paper?.title ?? null,
    section: e.section ?? "",
    sourceNumber: q.sourceNumber,
    sourceLabel: q.sourceLabel,
    pages: q.pages,
    questionCrops: crops.length ? (crops as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    cropNote,
    sourceText: raw.sourceText ?? (raw.ocr as { text?: string } | null)?.text ?? null,
    ocrEngine: raw.ocr?.engine ?? raw.method ?? null,
    ocrConfidence: typeof raw.ocr?.confidence === "number" ? raw.ocr.confidence : q.confidence,
    extraction: raw.method ?? null,
    issueCodes: q.issueCodes,
    issues: (q.issues ?? Prisma.DbNull) as Prisma.InputJsonValue,
    answerStatus: q.answerStatus,
    officialAnswerRaw: q.officialAnswerRaw,
    officialAnswer: q.officialAnswer,
    extractedAnswer: q.sourceAnswer,
    aiAnswer: q.aiAnswer,
    keyFileId: keyFile?.id ?? null,
    keyFileName: keyFile?.originalName ?? null,
    keyPage: entry?.page ?? null,
    keyCrop: keyCrop ? (keyCrop as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    keyStatus,
  };
  await prisma.questionSourceEvidence.upsert({ where: { questionId: q.questionId }, create: { questionId: q.questionId, ...data }, update: data });
  return { questionId: q.questionId, crops: crops.length, key: keyCrop?.kind ?? null };
}

/** All vault keys referenced by source evidence (kept by the storage cleanup). */
export async function questionSourceKeys(): Promise<string[]> {
  const rows = await prisma.questionSourceEvidence.findMany({ select: { questionCrops: true, keyCrop: true } });
  const out: string[] = [];
  for (const r of rows) {
    for (const c of (Array.isArray(r.questionCrops) ? r.questionCrops : []) as { key?: string }[]) if (c?.key) out.push(c.key);
    const k = (r.keyCrop as { key?: string } | null)?.key;
    if (k) out.push(k);
  }
  return out;
}
