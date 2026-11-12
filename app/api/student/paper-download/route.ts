import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { requireStudent, StudentUnauthorizedError } from "@/lib/student-session";
import { getContentAccess } from "@/lib/payments/access";
import { enforcePaymentRateLimit, PaymentRateLimitError } from "@/lib/payments/rate-limit";
import { getExamFeatures } from "@/lib/exam-features";
import { getPaperPdfIndex, isPaperPdfLang } from "@/lib/paper-pdfs";
import { resolveTestResourcePath } from "@/lib/test-resources";
import { stampPaperPdf } from "@/lib/paper-pdf-stamp";
import { maskEmail, maskPhone } from "@/lib/pii-mask";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });

/**
 * The ONLY way to download a typeset Previous Year Paper PDF (GET ?paperId=…&lang=BILINGUAL|ENGLISH|HINDI).
 * Every request re-checks, in order: student login → exam active → the exam's Paper PDF switch →
 * the file is the current index entry and active → a PAID entitlement that covers this paper
 * (an actual purchase: free/unpriced access does not count) → 20 downloads per student per 24 h.
 * Then the stored file is stamped with the student's masked contact, logged, and sent as an
 * attachment with no-store. Switch OFF / unknown / inactive = 404, so nothing leaks.
 */
export async function GET(request: NextRequest) {
  let student: Awaited<ReturnType<typeof requireStudent>>;
  try {
    student = await requireStudent();
  } catch (err) {
    if (err instanceof StudentUnauthorizedError) return NextResponse.json({ error: "Please log in to download." }, { status: 401, headers: NO_STORE });
    return NextResponse.json({ error: "Please verify your account to download." }, { status: 403, headers: NO_STORE });
  }

  const paperId = request.nextUrl.searchParams.get("paperId") ?? "";
  const lang = request.nextUrl.searchParams.get("lang");
  if (!/^[a-z0-9]{10,40}$/i.test(paperId) || !isPaperPdfLang(lang)) return notFound();

  const paper = await prisma.previousYearPaper.findUnique({ where: { id: paperId }, select: { id: true, year: true, examId: true, isActive: true, exam: { select: { isActive: true } } } });
  if (!paper || !paper.isActive || !paper.exam.isActive) return notFound();
  if (!(await getExamFeatures(paper.examId)).paperDownloadEnabled) return notFound();

  const entry = (await getPaperPdfIndex(paper.examId)).find((e) => e.paperId === paper.id && e.lang === lang);
  const resource = entry ? await prisma.testResource.findUnique({ where: { id: entry.resourceId } }) : null;
  if (!entry || !resource || !resource.isActive || resource.type !== "PAPER_PDF" || resource.examId !== paper.examId) return notFound();

  const access = await getContentAccess(student.id, { kind: "PREVIOUS_YEAR_PAPER", id: paper.id, examId: paper.examId, accessType: "PAID" });
  if (!access.allowed || access.status !== "ACTIVE_SUBSCRIPTION") {
    return NextResponse.json({ error: "Buy access to download this paper.", access: access.status }, { status: 402, headers: NO_STORE });
  }

  try {
    await enforcePaymentRateLimit("paper-download", student.id);
  } catch (err) {
    if (err instanceof PaymentRateLimitError) return NextResponse.json({ error: "Download limit reached. Please try again tomorrow." }, { status: 429, headers: NO_STORE });
    throw err;
  }

  const filePath = resolveTestResourcePath(resource.fileUrl);
  if (!filePath) return notFound();
  let bytes: Uint8Array;
  try {
    bytes = await readFile(filePath);
  } catch {
    return notFound();
  }
  const contact = await prisma.student.findUnique({ where: { id: student.id }, select: { mobile: true, email: true } });
  const licensee = maskPhone(contact?.mobile) ?? maskEmail(contact?.email) ?? `student ${student.id.slice(-6)}`;
  const stamped = await stampPaperPdf(bytes, licensee);

  await prisma.studentActivity.create({
    data: { studentId: student.id, activity: "PAPER_PDF_DOWNLOADED", metadata: { examId: paper.examId, paperId: paper.id, year: paper.year, lang, resourceId: resource.id } },
  });

  return new NextResponse(new Uint8Array(stamped), {
    headers: {
      ...NO_STORE,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="RPSC-FSO-${paper.year}-${lang}.pdf"`,
      "Content-Length": String(stamped.length),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
