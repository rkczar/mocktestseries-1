import { NextRequest, NextResponse } from "next/server";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
  isAllowedResourceMime,
  MAX_TEST_RESOURCE_BYTES,
  publicResourceUrlFor,
  randomResourceFilename,
  resolveTestResourcePath,
  testResourcesDir,
} from "@/lib/test-resources";
import type { ResourceReleasePolicy, TestResourceType } from "@prisma/client";

const VALID_TYPES: TestResourceType[] = ["PAPER_PDF", "SOLUTION_PDF", "OMR_TEMPLATE"];
const VALID_POLICIES: ResourceReleasePolicy[] = ["AFTER_AVAILABLE_FROM", "AFTER_SUBMISSION", "CUSTOM_DATE", "DISABLED"];

/**
 * Upload endpoint for TestResource (Paper PDF / Solution PDF / OMR Template),
 * mirroring app/api/admin/questions/images/route.ts exactly: PDF-only MIME
 * allowlist (lib/test-resources.ts), UUID filenames, AuditLog entry.
 */
export async function POST(request: NextRequest) {
  let session;
  try {
    session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    throw err;
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const type = formData.get("type") as string | null;
    const title = (formData.get("title") as string | null)?.trim();
    const mockTestId = (formData.get("mockTestId") as string | null) || null;
    const testSeriesId = (formData.get("testSeriesId") as string | null) || null;
    const examId = (formData.get("examId") as string | null) || null;
    const questionCountRaw = formData.get("questionCount") as string | null;
    const releasePolicyRaw = (formData.get("releasePolicy") as string | null) || "AFTER_AVAILABLE_FROM";
    const releaseAtRaw = formData.get("releaseAt") as string | null;

    if (!(file instanceof File)) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    if (!type || !VALID_TYPES.includes(type as TestResourceType)) {
      return NextResponse.json({ error: "Invalid resource type" }, { status: 400 });
    }
    if (!title) return NextResponse.json({ error: "Title is required" }, { status: 400 });
    if (!isAllowedResourceMime(file.type)) {
      return NextResponse.json({ error: "Only PDF files are allowed" }, { status: 400 });
    }
    if (file.size > MAX_TEST_RESOURCE_BYTES) {
      return NextResponse.json({ error: "File exceeds the 20MB limit" }, { status: 400 });
    }
    const releasePolicy = VALID_POLICIES.includes(releasePolicyRaw as ResourceReleasePolicy)
      ? (releasePolicyRaw as ResourceReleasePolicy)
      : "AFTER_AVAILABLE_FROM";

    const filename = randomResourceFilename(file.type);
    if (!filename) return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });

    const dir = testResourcesDir();
    await mkdir(dir, { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(path.join(dir, filename), buffer);

    const resource = await prisma.testResource.create({
      data: {
        type: type as TestResourceType,
        title,
        fileUrl: publicResourceUrlFor(filename),
        mimeType: file.type,
        fileSizeBytes: file.size,
        questionCount: questionCountRaw ? Number(questionCountRaw) : null,
        releasePolicy,
        releaseAt: releaseAtRaw ? new Date(releaseAtRaw) : null,
        mockTestId,
        testSeriesId,
        examId,
        createdByAdminId: session.user.id,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "TEST_RESOURCE_UPLOADED",
        entityType: "TestResource",
        entityId: resource.id,
        metadata: { type, mockTestId, testSeriesId, examId },
      },
    });

    return NextResponse.json({ success: true, resource });
  } catch (error) {
    console.error("POST /api/admin/test-resources error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload resource" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  let session;
  try {
    session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    throw err;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { id } = body as { id?: string };
    if (!id) return NextResponse.json({ error: "No resource id provided" }, { status: 400 });

    const resource = await prisma.testResource.findUnique({ where: { id } });
    if (!resource) return NextResponse.json({ error: "Resource not found" }, { status: 404 });

    const absolutePath = resolveTestResourcePath(resource.fileUrl);
    if (absolutePath) await unlink(absolutePath).catch(() => {});

    await prisma.testResource.delete({ where: { id } });
    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "TEST_RESOURCE_REMOVED",
        entityType: "TestResource",
        entityId: id,
        metadata: { type: resource.type },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/admin/test-resources error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to remove resource" },
      { status: 500 }
    );
  }
}
