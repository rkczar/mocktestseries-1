import "server-only";
import type { AiImportFigure, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

/**
 * Question history (AiImportQuestionVersion). Nothing an administrator did is
 * ever lost to an AI result:
 *  - before a re-scan replaces an untouched extraction, the old one is kept (EXTRACTION);
 *  - a re-scan of a manually corrected question never replaces it: the new read waits as a
 *    PENDING RESCAN version until the administrator chooses, field by field, what to keep;
 *  - every manual correction is recorded with its before/after values (ADMIN_EDIT).
 * Figure originals are content-addressed in the vault and never deleted here, so a snapshot can
 * always be restored.
 */

export interface FigureSnapshot {
  pageNumber: number;
  owner: string;
  optionLabel: string | null;
  sharedGroup: string | null;
  box: unknown;
  source: string;
  originalKey: string;
  originalSha256: string;
  originalMime: string;
  width: number;
  height: number;
  bytes: number;
  description: string | null;
  confidence: number | null;
  mappingStatus: string;
  confirmedById: string | null;
}

export function snapshotFigures(figs: AiImportFigure[]): FigureSnapshot[] {
  return figs.map((f) => ({
    pageNumber: f.pageNumber,
    owner: f.owner,
    optionLabel: f.optionLabel,
    sharedGroup: f.sharedGroup,
    box: f.box ?? null,
    source: f.source,
    originalKey: f.originalKey,
    originalSha256: f.originalSha256,
    originalMime: f.originalMime,
    width: f.width,
    height: f.height,
    bytes: f.bytes,
    description: f.description,
    confidence: f.confidence,
    mappingStatus: f.mappingStatus,
    confirmedById: f.confirmedById,
  }));
}

/** Figure rows recreated from a snapshot (the vault originals they point at are unchanged). */
export function figureRows(snap: FigureSnapshot[], q: { jobId: string; fileId: string; questionId: string }): Prisma.AiImportFigureCreateManyInput[] {
  return snap.map((f) => ({
    jobId: q.jobId,
    fileId: q.fileId,
    questionId: q.questionId,
    pageNumber: f.pageNumber,
    owner: f.owner,
    optionLabel: f.optionLabel,
    sharedGroup: f.sharedGroup,
    box: (f.box ?? undefined) as Prisma.InputJsonValue | undefined,
    source: f.source,
    originalKey: f.originalKey,
    originalSha256: f.originalSha256,
    originalMime: f.originalMime,
    width: f.width,
    height: f.height,
    bytes: f.bytes,
    description: f.description,
    confidence: f.confidence,
    mappingStatus: f.mappingStatus,
    confirmedById: f.confirmedById,
  }));
}

/** True when an administrator has touched the question's content or figures (a re-scan must not replace it). */
export function manuallyCorrected(q: { editedData: unknown }, figs: Pick<AiImportFigure, "confirmedById" | "source">[]): boolean {
  return !!q.editedData || figs.some((f) => !!f.confirmedById || f.source === "ADMIN_UPLOAD");
}

// ---- Field-by-field comparison --------------------------------------------------------------------

/** The fields a re-scan can change, in display order. Figures are compared and chosen as one set. */
export const RESCAN_FIELDS = ["number", "type", "stem", "option:A", "option:B", "option:C", "option:D", "option:E", "printedAnswer", "figures"] as const;
export type RescanField = (typeof RESCAN_FIELDS)[number];

export const FIELD_LABELS: Record<RescanField, string> = {
  number: "Question number",
  type: "Question type",
  stem: "Question text",
  "option:A": "Option A",
  "option:B": "Option B",
  "option:C": "Option C",
  "option:D": "Option D",
  "option:E": "Option E",
  printedAnswer: "Answer printed in the paper",
  figures: "Figures",
};

function figureSummary(f: Pick<FigureSnapshot, "owner" | "optionLabel" | "mappingStatus">[]): string {
  if (!f.length) return "none";
  return f.map((x) => `${x.owner === "OPTION" ? `option ${x.optionLabel}` : x.owner.toLowerCase()}${x.mappingStatus !== "OK" ? ` (${x.mappingStatus.toLowerCase()})` : ""}`).join(", ");
}

export function fieldValue(q: ExtractedQuestion, field: RescanField, figs: Pick<FigureSnapshot, "owner" | "optionLabel" | "mappingStatus">[]): string {
  switch (field) {
    case "number":
      return q.number === null ? "—" : `${q.section ? `${q.section} ` : ""}${q.number}`;
    case "type":
      return q.type;
    case "stem":
      return [q.instructions, q.passage, q.stem].filter((x) => x && x.trim()).join("\n\n");
    case "printedAnswer":
      return q.printedAnswer.join(", ") || "—";
    case "figures":
      return figureSummary(figs);
    default: {
      const label = field.slice(7);
      const o = q.options.find((x) => x.label === label);
      return o ? o.text || "(image only)" : "—";
    }
  }
}

export interface FieldDiff {
  field: RescanField;
  label: string;
  current: string;
  rescan: string;
  same: boolean;
}

/** Every comparable field of the current question and a re-scan result, marking what differs. */
export function compareVersions(current: ExtractedQuestion, currentFigs: Pick<FigureSnapshot, "owner" | "optionLabel" | "mappingStatus">[], next: ExtractedQuestion, nextFigs: Pick<FigureSnapshot, "owner" | "optionLabel" | "mappingStatus">[]): FieldDiff[] {
  const labels = new Set([...current.options.map((o) => o.label), ...next.options.map((o) => o.label)]);
  return RESCAN_FIELDS.filter((f) => !f.startsWith("option:") || labels.has(f.slice(7))).map((field) => {
    const a = fieldValue(current, field, currentFigs);
    const b = fieldValue(next, field, nextFigs);
    return { field, label: FIELD_LABELS[field], current: a, rescan: b, same: a.trim() === b.trim() };
  });
}

/**
 * The question after the administrator's choice: fields listed in `take` come from the re-scan,
 * every other field stays as it is now (manual corrections included).
 */
export function mergeChoice(current: ExtractedQuestion, next: ExtractedQuestion, take: Set<RescanField>): ExtractedQuestion {
  const out: ExtractedQuestion = { ...current, options: current.options.map((o) => ({ ...o })) };
  if (take.has("number")) {
    out.number = next.number;
    out.label = next.label;
    out.section = next.section;
  }
  if (take.has("type")) out.type = next.type;
  if (take.has("stem")) {
    out.stem = next.stem;
    out.instructions = next.instructions ?? null;
    out.passage = next.passage ?? null;
    out.contentFormat = next.contentFormat;
  }
  if (take.has("printedAnswer")) out.printedAnswer = [...next.printedAnswer];
  const labels = [...new Set([...current.options.map((o) => o.label), ...next.options.map((o) => o.label)])].sort();
  const options: ExtractedQuestion["options"] = [];
  for (const l of labels) {
    const src = take.has(`option:${l}` as RescanField) ? next.options.find((o) => o.label === l) : current.options.find((o) => o.label === l);
    if (src) options.push({ ...src });
  }
  out.options = options;
  out.notes = [...(current.notes ?? []), `Re-scan applied for: ${[...take].map((f) => FIELD_LABELS[f]).join(", ") || "nothing"}.`];
  return out;
}

export async function recordVersion(input: {
  questionId: string;
  jobId: string;
  kind: "EXTRACTION" | "RESCAN" | "ADMIN_EDIT";
  status?: string | null;
  data: ExtractedQuestion;
  figures?: FigureSnapshot[] | null;
  changes?: unknown;
  model?: string | null;
  actorId?: string | null;
  note?: string | null;
}) {
  return prisma.aiImportQuestionVersion.create({
    data: {
      questionId: input.questionId,
      jobId: input.jobId,
      kind: input.kind,
      status: input.status ?? null,
      data: input.data as unknown as Prisma.InputJsonValue,
      figures: (input.figures ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
      changes: (input.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      model: input.model ?? null,
      actorId: input.actorId ?? null,
      note: input.note?.slice(0, 500) ?? null,
    },
  });
}

/** Questions of a job with a re-scan result still waiting for the administrator's choice. */
export async function pendingRescanIds(jobId: string): Promise<Set<string>> {
  const rows = await prisma.aiImportQuestionVersion.findMany({ where: { jobId, kind: "RESCAN", status: "PENDING" }, select: { questionId: true } });
  return new Set(rows.map((r) => r.questionId));
}
