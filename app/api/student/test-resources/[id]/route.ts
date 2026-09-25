import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AttemptSourceType, AttemptStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireStudent, StudentUnauthorizedError } from "@/lib/student-session";
import { hasMockTestReleased } from "@/lib/mock-test-schedule";
import { canAccessTestResource } from "@/lib/test-resources-access";
import { resolveTestResourcePath } from "@/lib/test-resources";
import { getContentAccess, accessDeniedMessage } from "@/lib/payments/access";
import { brandOmrPdf, getOfficialInstagram, OMR_DOWNLOAD_FILENAME } from "@/lib/omr-sheet";

/**
 * The only enforcement point for TestResource downloads — every request re-
 * checks the release policy server-side via canAccessTestResource, never a
 * client-supplied "unlocked" flag. A global OMR_TEMPLATE (no mockTestId) is
 * reachable from the unauthenticated Public Exam Page, so it's the one case
 * allowed without a student session; every other resource type requires
 * requireStudent() first.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const resource = await prisma.testResource.findUnique({ where: { id } });
  if (!resource) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isPublicOmr = resource.type === "OMR_TEMPLATE" && !resource.mockTestId;

  let studentId: string | null = null;
  if (!isPublicOmr) {
    try {
      const student = await requireStudent();
      studentId = student.id;
    } catch (err) {
      if (err instanceof StudentUnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      throw err;
    }
  }

  let mockTestAvailable = true;
  let hasSubmittedAttempt = false;
  if (resource.mockTestId) {
    const mockTest = await prisma.mockTest.findUnique({
      where: { id: resource.mockTestId },
      select: { status: true, availableFrom: true, examId: true, testSeriesId: true, accessType: true },
    });
    mockTestAvailable = mockTest ? hasMockTestReleased(mockTest) : false;

    // Paper/Solution PDFs of a paid mock test are protected content: the
    // same entitlement gate as starting the test (OMR sheets are not).
    if (studentId && mockTest && resource.type !== "OMR_TEMPLATE") {
      const access = await getContentAccess(studentId, {
        kind: "MOCK_TEST",
        id: resource.mockTestId,
        examId: mockTest.examId,
        testSeriesId: mockTest.testSeriesId,
        accessType: mockTest.accessType,
      });
      if (!access.allowed) {
        return NextResponse.json({ error: accessDeniedMessage(access), access: access.status }, { status: 402 });
      }
    }

    if (studentId) {
      const submitted = await prisma.testAttempt.findFirst({
        where: {
          studentId,
          mockTestId: resource.mockTestId,
          sourceType: AttemptSourceType.MOCK_TEST,
          status: AttemptStatus.SUBMITTED,
        },
        select: { id: true },
      });
      hasSubmittedAttempt = Boolean(submitted);
    }
  }

  const allowed = canAccessTestResource({
    resourceType: resource.type,
    releasePolicy: resource.releasePolicy,
    releaseAt: resource.releaseAt,
    isActive: resource.isActive,
    mockTestAvailable,
    hasSubmittedAttempt,
  });
  if (!allowed) return NextResponse.json({ error: "This resource is not available yet." }, { status: 403 });

  const filePath = resolveTestResourcePath(resource.fileUrl);
  if (!filePath) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let buffer: Uint8Array;
  try {
    buffer = await readFile(filePath);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Every OMR download — Homepage, Student Dashboard, Practice with OMR, exam
  // pages, result print kit — is stamped here by the one canonical branding
  // step (lib/omr-sheet.ts). The stored file itself is never modified.
  const isOmr = resource.type === "OMR_TEMPLATE";
  if (isOmr) {
    try {
      buffer = await brandOmrPdf(buffer, { instagram: await getOfficialInstagram() });
    } catch (err) {
      // An unparseable upload still downloads as-is rather than 500ing.
      console.error("[omr] branding failed for resource", resource.id, err);
    }
  }

  // Strip anything outside a conservative safe set before it reaches a header
  // value — resource.title is admin-supplied and stored, not attacker
  // input off this request, but an unsanitized value could still break the
  // response (quotes/control characters) if a title is ever entered oddly.
  const safeFilename = isOmr
    ? OMR_DOWNLOAD_FILENAME
    : `${path.basename(resource.title || resource.id).replace(/[^a-zA-Z0-9 _.-]/g, "") || resource.id}.pdf`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": resource.mimeType,
      "Content-Disposition": `inline; filename="${safeFilename}"`,
      // Derived from the actual bytes read, not the stored fileSizeBytes —
      // never trust a persisted length to match the file on disk.
      "Content-Length": String(buffer.length),
    },
  });
}
