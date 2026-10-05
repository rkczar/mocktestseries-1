import "server-only";
import { QuestionAssetRole, QuestionContentFormat, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MediaValidationError, storeScientificImage } from "@/lib/media-processing";

/**
 * Admin operations on a RICH_V1 question's media (NEET Phase 2). Minimum
 * authoring path; the full editor/importer comes later. Callers (the admin
 * API routes) enforce QUESTIONS_MANAGE first.
 *
 *  - attach: validate + process + store an immutable file, then add a
 *    QuestionAsset reference (QUESTION, OPTION + label, or EXPLANATION).
 *  - replace: a NEW file and a NEW reference in the old one's slot; the old
 *    reference row is removed, the old FILE is never touched.
 *  - remove: drops the reference only.
 *  - update: alt / decorative / caption / order / darkBacking.
 * Storage keys are always created here, never accepted from the client.
 */

export class QuestionMediaError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "QuestionMediaError";
  }
}

const ROLES = new Set<string>(Object.values(QuestionAssetRole));
const FILENAME_LIKE = /\.(png|jpe?g|webp|avif|gif|svg|bmp|tiff?)$/i;
export const ALT_MAX = 500;

/**
 * Alt policy: meaningful text (3–500 chars, not a filename), or an explicit
 * `decorative` flag that stores alt="" (screen readers skip the image).
 */
export function normalizeAlt(alt: unknown, decorative: unknown): string {
  if (decorative === true || decorative === "true" || decorative === "1" || decorative === "on") return "";
  const text = typeof alt === "string" ? alt.trim().replace(/\s+/g, " ") : "";
  if (text.length < 3) throw new QuestionMediaError("Describe the image (alt text, at least 3 characters) or mark it decorative.");
  if (text.length > ALT_MAX) throw new QuestionMediaError(`Alt text must be at most ${ALT_MAX} characters.`);
  if (FILENAME_LIKE.test(text) || /^(img|image|dsc|screenshot)[-_ ]?\d*$/i.test(text)) throw new QuestionMediaError("Alt text must describe the image, not repeat a file name.");
  return text;
}

function parseRole(role: unknown): QuestionAssetRole {
  if (typeof role !== "string" || !ROLES.has(role)) throw new QuestionMediaError("Role must be QUESTION, OPTION or EXPLANATION.");
  return role as QuestionAssetRole;
}

function parseOrder(order: unknown): number | null {
  if (order === undefined || order === null || order === "") return null;
  const n = Number(order);
  if (!Number.isInteger(n) || n < 0 || n > 99) throw new QuestionMediaError("Order must be a whole number from 0 to 99.");
  return n;
}

function parseCaption(caption: unknown): string | null {
  if (typeof caption !== "string" || !caption.trim()) return null;
  if (caption.length > 300) throw new QuestionMediaError("Caption must be at most 300 characters.");
  return caption.trim();
}

const parseBool = (v: unknown, fallback: boolean) => (v === undefined || v === null || v === "" ? fallback : v === true || v === "true" || v === "1" || v === "on");

async function loadRichQuestion(questionId: string) {
  const q = await prisma.question.findUnique({ where: { id: questionId }, select: { id: true, contentFormat: true, options: { select: { label: true } } } });
  if (!q) throw new QuestionMediaError("Question not found.", 404);
  if (q.contentFormat !== QuestionContentFormat.RICH_V1) throw new QuestionMediaError("Images can only be attached to RICH_V1 questions.");
  return q;
}

function slotFor(role: QuestionAssetRole, optionLabel: unknown, labels: string[]): string | null {
  if (role !== QuestionAssetRole.OPTION) return null;
  if (typeof optionLabel !== "string" || !labels.includes(optionLabel)) throw new QuestionMediaError(`Option images need an existing option label (${labels.join(", ")}).`);
  return optionLabel;
}

export async function attachQuestionAsset(input: {
  questionId: string;
  actorId: string | null;
  file: { bytes: Buffer; filename: string | null; mime: string | null };
  role: unknown;
  optionLabel?: unknown;
  order?: unknown;
  alt?: unknown;
  decorative?: unknown;
  caption?: unknown;
  darkBacking?: unknown;
  /** Replace: the new image takes this reference's role/label/order; the reference is removed, its file kept. */
  replaceAssetId?: string | null;
}) {
  const q = await loadRichQuestion(input.questionId);
  const replacing = input.replaceAssetId
    ? await prisma.questionAsset.findFirst({ where: { id: input.replaceAssetId, questionId: q.id } })
    : null;
  if (input.replaceAssetId && !replacing) throw new QuestionMediaError("The image to replace is not on this question.", 404);

  const role = replacing ? replacing.role : parseRole(input.role);
  const optionLabel = replacing ? replacing.optionLabel : slotFor(role, input.optionLabel, q.options.map((o) => o.label));
  const alt = normalizeAlt(input.alt, input.decorative);
  const caption = parseCaption(input.caption);
  const darkBacking = parseBool(input.darkBacking, replacing?.darkBacking ?? true);
  let order = replacing ? replacing.order : parseOrder(input.order);
  if (order === null) {
    const last = await prisma.questionAsset.findFirst({ where: { questionId: q.id, role, optionLabel }, orderBy: { order: "desc" }, select: { order: true } });
    order = last ? last.order + 1 : 0;
  }

  let media;
  try {
    media = await storeScientificImage(input.file.bytes, { declaredMime: input.file.mime, filename: input.file.filename, actorId: input.actorId });
  } catch (e) {
    if (e instanceof MediaValidationError) throw new QuestionMediaError(e.message);
    throw e;
  }

  const asset = await prisma.$transaction(async (tx) => {
    if (replacing) await tx.questionAsset.delete({ where: { id: replacing.id } });
    const created = await tx.questionAsset.create({
      data: {
        questionId: q.id,
        role,
        optionLabel,
        order: order!,
        storageKey: media.storageKey,
        mime: media.mime,
        width: media.width,
        height: media.height,
        bytes: media.bytes,
        sha256: media.sha256,
        alt,
        caption,
        darkBacking,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: replacing ? "QUESTION_ASSET_REPLACED" : "QUESTION_ASSET_ATTACHED",
        entityType: "Question",
        entityId: q.id,
        metadata: {
          assetId: created.id,
          role,
          optionLabel,
          order: created.order,
          storageKey: media.storageKey,
          sha256: media.sha256,
          newFile: media.created,
          ...(replacing ? { replacedAssetId: replacing.id, replacedStorageKey: replacing.storageKey } : {}),
        },
      },
    });
    return created;
  });
  return { asset, media };
}

export async function updateQuestionAsset(input: { questionId: string; assetId: string; actorId: string | null; alt?: unknown; decorative?: unknown; caption?: unknown; order?: unknown; darkBacking?: unknown }) {
  const asset = await prisma.questionAsset.findFirst({ where: { id: input.assetId, questionId: input.questionId } });
  if (!asset) throw new QuestionMediaError("Image not found on this question.", 404);
  const data: { alt?: string; caption?: string | null; order?: number; darkBacking?: boolean } = {};
  if (input.alt !== undefined || input.decorative !== undefined) data.alt = normalizeAlt(input.alt, input.decorative);
  if (input.caption !== undefined) data.caption = parseCaption(input.caption);
  if (input.order !== undefined) data.order = parseOrder(input.order) ?? asset.order;
  if (input.darkBacking !== undefined) data.darkBacking = parseBool(input.darkBacking, asset.darkBacking);
  const updated = await prisma.questionAsset.update({ where: { id: asset.id }, data });
  await prisma.auditLog.create({
    data: { actorId: input.actorId, action: "QUESTION_ASSET_UPDATED", entityType: "Question", entityId: input.questionId, metadata: { assetId: asset.id, changed: Object.keys(data) } },
  });
  return updated;
}

/** Removes the REFERENCE only. The immutable file stays: attempts may have frozen it. */
export async function removeQuestionAsset(input: { questionId: string; assetId: string; actorId: string | null }) {
  const asset = await prisma.questionAsset.findFirst({ where: { id: input.assetId, questionId: input.questionId } });
  if (!asset) throw new QuestionMediaError("Image not found on this question.", 404);
  await prisma.$transaction([
    prisma.questionAsset.delete({ where: { id: asset.id } }),
    prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        action: "QUESTION_ASSET_REMOVED",
        entityType: "Question",
        entityId: input.questionId,
        metadata: { assetId: asset.id, role: asset.role, optionLabel: asset.optionLabel, storageKey: asset.storageKey, fileKept: true },
      },
    }),
  ]);
}

/**
 * contentFormat + explanation for the test/authoring path. Switching the
 * format is allowed ONLY on DRAFT questions, so a published (e.g. RUHS)
 * question can never change how it renders from here.
 */
export async function setQuestionRichFields(input: { questionId: string; actorId: string | null; contentFormat?: unknown; explanation?: unknown }) {
  const q = await prisma.question.findUnique({ where: { id: input.questionId }, select: { id: true, status: true, contentFormat: true } });
  if (!q) throw new QuestionMediaError("Question not found.", 404);
  const data: { contentFormat?: QuestionContentFormat; explanation?: string | null } = {};
  if (input.contentFormat !== undefined) {
    if (input.contentFormat !== "PLAIN" && input.contentFormat !== "RICH_V1") throw new QuestionMediaError("contentFormat must be PLAIN or RICH_V1.");
    if (input.contentFormat !== q.contentFormat && q.status !== QuestionStatus.DRAFT) throw new QuestionMediaError("The content format can only be changed while the question is a DRAFT.");
    data.contentFormat = input.contentFormat as QuestionContentFormat;
  }
  if (input.explanation !== undefined) {
    if (input.explanation !== null && typeof input.explanation !== "string") throw new QuestionMediaError("Explanation must be text.");
    if (typeof input.explanation === "string" && input.explanation.length > 20_000) throw new QuestionMediaError("Explanation is too long.");
    data.explanation = typeof input.explanation === "string" && input.explanation.trim() ? input.explanation : null;
  }
  const updated = await prisma.question.update({ where: { id: q.id }, data, select: { id: true, contentFormat: true, explanation: true } });
  await prisma.auditLog.create({
    data: { actorId: input.actorId, action: "QUESTION_RICH_FIELDS_UPDATED", entityType: "Question", entityId: q.id, metadata: { changed: Object.keys(data), contentFormat: updated.contentFormat } },
  });
  return updated;
}
