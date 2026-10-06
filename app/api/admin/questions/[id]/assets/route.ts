import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { mediaUrl } from "@/lib/media-storage";
import { MEDIA_LIMITS } from "@/lib/media-processing";
import { attachQuestionAsset, QuestionMediaError, removeQuestionAsset, updateQuestionAsset } from "@/lib/question-media-admin";

/**
 * RICH_V1 question media (NEET Phase 2) — admin only (QUESTIONS_MANAGE).
 *   GET    → the question's asset references
 *   POST   multipart: file, role, optionLabel?, listKey? (LIST_ITEM), order?, alt | decorative, caption?, darkBacking?, replaceAssetId?
 *   PATCH  json: { assetId, alt?, decorative?, caption?, order?, darkBacking? }
 *   DELETE json: { assetId } — removes the reference only; the immutable file is kept.
 * Storage keys/paths are never accepted from the client.
 */

type Ctx = { params: Promise<{ id: string }> };

async function guard() {
  try {
    return { session: await requirePermission(PERMISSIONS.QUESTIONS_MANAGE) };
  } catch (err) {
    if (err instanceof UnauthorizedError) return { denied: NextResponse.json({ error: "Unauthorized" }, { status: 403 }) };
    throw err;
  }
}

function fail(error: unknown, op: string) {
  if (error instanceof QuestionMediaError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error(`${op} /api/admin/questions/[id]/assets error:`, error);
  return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
}

const view = (a: { id: string; role: string; optionLabel: string | null; listKey?: string | null; order: number; storageKey: string; alt: string; caption: string | null; width: number; height: number; bytes: number; sha256: string; darkBacking: boolean }) => ({
  id: a.id,
  role: a.role,
  optionLabel: a.optionLabel,
  listKey: a.listKey ?? null,
  order: a.order,
  url: mediaUrl(a.storageKey),
  storageKey: a.storageKey,
  alt: a.alt,
  decorative: a.alt === "",
  caption: a.caption,
  width: a.width,
  height: a.height,
  bytes: a.bytes,
  sha256: a.sha256,
  darkBacking: a.darkBacking,
});

export async function GET(_request: NextRequest, { params }: Ctx) {
  const g = await guard();
  if ("denied" in g) return g.denied;
  const { id } = await params;
  const assets = await prisma.questionAsset.findMany({ where: { questionId: id }, orderBy: [{ role: "asc" }, { optionLabel: "asc" }, { order: "asc" }] });
  return NextResponse.json({ assets: assets.map(view) });
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const g = await guard();
  if ("denied" in g) return g.denied;
  const { id } = await params;
  try {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MEDIA_LIMITS.maxUploadBytes + 64 * 1024) throw new QuestionMediaError(`Images must be at most ${MEDIA_LIMITS.maxUploadBytes / 1024 / 1024} MB.`, 413);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new QuestionMediaError("No file uploaded.");
    if (file.size > MEDIA_LIMITS.maxUploadBytes) throw new QuestionMediaError(`Images must be at most ${MEDIA_LIMITS.maxUploadBytes / 1024 / 1024} MB.`, 413);
    const str = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : undefined;
    };
    const { asset, media } = await attachQuestionAsset({
      questionId: id,
      actorId: g.session.user.id ?? null,
      file: { bytes: Buffer.from(await file.arrayBuffer()), filename: file.name || null, mime: file.type || null },
      role: str("role"),
      optionLabel: str("optionLabel"),
      listKey: str("listKey"),
      order: str("order"),
      alt: str("alt"),
      decorative: str("decorative"),
      caption: str("caption"),
      darkBacking: str("darkBacking"),
      replaceAssetId: str("replaceAssetId") || null,
    });
    return NextResponse.json({ asset: view(asset), deduplicated: !media.created });
  } catch (error) {
    return fail(error, "POST");
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const g = await guard();
  if ("denied" in g) return g.denied;
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.assetId !== "string") throw new QuestionMediaError("assetId is required.");
    const asset = await updateQuestionAsset({ questionId: id, assetId: body.assetId, actorId: g.session.user.id ?? null, alt: body.alt, decorative: body.decorative, caption: body.caption, order: body.order, darkBacking: body.darkBacking });
    return NextResponse.json({ asset: view(asset) });
  } catch (error) {
    return fail(error, "PATCH");
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const g = await guard();
  if ("denied" in g) return g.denied;
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.assetId !== "string") throw new QuestionMediaError("assetId is required.");
    await removeQuestionAsset({ questionId: id, assetId: body.assetId, actorId: g.session.user.id ?? null });
    return NextResponse.json({ success: true, fileKept: true });
  } catch (error) {
    return fail(error, "DELETE");
  }
}
