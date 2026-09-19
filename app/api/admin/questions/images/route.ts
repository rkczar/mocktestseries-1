import { NextRequest, NextResponse } from "next/server";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
  isAllowedImageMime,
  MAX_QUESTION_IMAGE_BYTES,
  publicUrlFor,
  questionImagesDir,
  randomImageFilename,
  resolveQuestionImagePath,
} from "@/lib/question-images";

/**
 * Image upload endpoint for the Question Bank (Question.imageUrl and
 * QuestionOption.imageUrl). There was no image upload endpoint anywhere in
 * the app before this — see lib/question-images.ts for the shared-storage
 * convention this follows (mirrors the bulk-import upload route's
 * requirePermission + validate + respond shape).
 */
export async function POST(request: NextRequest) {
  let session;
  try {
    session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    throw err;
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const questionId = (formData.get("questionId") as string | null) || null;
    const target = (formData.get("target") as string | null) || "question";
    const previousUrl = (formData.get("previousUrl") as string | null) || null;

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    if (!isAllowedImageMime(file.type)) {
      return NextResponse.json({ error: "Only WEBP, PNG, or JPG/JPEG images are allowed" }, { status: 400 });
    }

    if (file.size > MAX_QUESTION_IMAGE_BYTES) {
      return NextResponse.json({ error: "Image exceeds the 2MB limit" }, { status: 400 });
    }

    const filename = randomImageFilename(file.type);
    if (!filename) {
      return NextResponse.json({ error: "Unsupported image type" }, { status: 400 });
    }

    const dir = questionImagesDir();
    await mkdir(dir, { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(path.join(dir, filename), buffer);

    const url = publicUrlFor(filename);

    // Best-effort: clean up whatever this upload is replacing. Never fails
    // the request if the old file is already gone.
    if (previousUrl) {
      const previousPath = resolveQuestionImagePath(previousUrl);
      if (previousPath) await unlink(previousPath).catch(() => {});
    }

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: previousUrl ? "QUESTION_IMAGE_REPLACED" : "QUESTION_IMAGE_UPLOADED",
        entityType: "Question",
        entityId: questionId,
        metadata: { target, url, previousUrl },
      },
    });

    return NextResponse.json({ success: true, url });
  } catch (error) {
    console.error("POST /api/admin/questions/images error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload image" },
      { status: 500 }
    );
  }
}

/** Removes a previously uploaded image. Disk removal is best-effort; the audit log always records the intent. */
export async function DELETE(request: NextRequest) {
  let session;
  try {
    session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    throw err;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { url, questionId, target } = body as { url?: string; questionId?: string; target?: string };

    if (!url) {
      return NextResponse.json({ error: "No image URL provided" }, { status: 400 });
    }

    const absolutePath = resolveQuestionImagePath(url);
    if (absolutePath) await unlink(absolutePath).catch(() => {});

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "QUESTION_IMAGE_REMOVED",
        entityType: "Question",
        entityId: questionId ?? null,
        metadata: { target: target ?? "question", url },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/admin/questions/images error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to remove image" },
      { status: 500 }
    );
  }
}
