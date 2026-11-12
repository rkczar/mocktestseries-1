import "server-only";
import { prisma } from "@/lib/prisma";
import { getExamFeatures } from "@/lib/exam-features";
import { getExamPyqInsights, pyqYearPath } from "@/lib/exam-pyq-insights";
import { hasPyqAnalysis, examInsightPath } from "@/lib/exam-pyq-analysis";
import { availableEditorialPaths } from "@/lib/exam-important-topics";
import { officialPaperFacts } from "@/lib/fso-official";
import { getPublicPaperDownloads } from "@/lib/paper-pdfs";

export type ExamPageStatus = "LIVE" | "NOT_PUBLISHED" | "OFF";

export interface ExamPageLink {
  label: string;
  href: string | null;
  status: ExamPageStatus;
}

/**
 * Teacher Portal → "Access Your Exam Pages": the public pages of ONE exam the caller has already
 * scoped (lib/teacher/scope.ts). Links only — publishing stays with the Master Admin. A page is LIVE
 * only when the public site actually serves it (exam active + public page on + its own data gate);
 * downloads show OFF while their switch is off. Unpublished pages never get a link.
 */
export async function getTeacherExamPages(examId: string): Promise<ExamPageLink[]> {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, code: true, isActive: true, publicPageEnabled: true, publicSlug: true } });
  if (!exam) return [];
  const isPublic = exam.isActive && exam.publicPageEnabled && !!exam.publicSlug;
  const base = `/exams/${exam.publicSlug}`;
  const [insights, extra, features] = await Promise.all([getExamPyqInsights(exam.id), availableEditorialPaths(exam), getExamFeatures(exam.id)]);
  const analysis = hasPyqAnalysis(insights);
  const page = (label: string, path: string, exists = true): ExamPageLink => ({
    label,
    href: isPublic && exists ? path : null,
    status: isPublic && exists ? "LIVE" : "NOT_PUBLISHED",
  });
  const keyYear = insights.indexableYears.find((y) => officialPaperFacts(exam.code, y));
  const links: ExamPageLink[] = [
    page("Overview", base),
    page("Syllabus", `${base}/syllabus`),
    page("Exam Pattern", `${base}/exam-pattern`),
    page("Previous Year Papers", `${base}/previous-year-papers`),
    ...(officialPaperFacts(exam.code, 2022) || officialPaperFacts(exam.code, 2019)
      ? [page("Answer Key", keyYear ? `${pyqYearPath(exam.publicSlug ?? "", keyYear)}#answer-key` : `${base}/previous-year-papers`, keyYear != null)]
      : []),
    page("Mock Test Series", `${base}/mock-test-series`),
    page("Preparation Strategy", examInsightPath(exam.publicSlug ?? "", "strategy"), analysis),
    ...(extra.includes("eligibility") ? [page("Eligibility", `${base}/eligibility`)] : []),
    ...(extra.includes("recruitment") ? [page("Recruitment", `${base}/recruitment`)] : []),
    page("Important Topics", `${base}/important-topics`, extra.includes("important-topics")),
  ];
  const omr = features.omrDownloadEnabled && exam.isActive
    ? await prisma.testResource.findFirst({ where: { type: "OMR_TEMPLATE", isActive: true, examId: exam.id, mockTestId: null }, select: { id: true } })
    : null;
  links.push({ label: "OMR Download", href: omr ? `/api/student/test-resources/${omr.id}` : null, status: omr ? "LIVE" : "OFF" });
  const pdfs = exam.isActive ? await getPublicPaperDownloads(exam.id, insights.papers.map((p) => p.id)) : [];
  links.push({ label: "Paper PDFs", href: pdfs.length && keyYear ? `${pyqYearPath(exam.publicSlug ?? "", keyYear)}#download` : null, status: pdfs.length ? "LIVE" : "OFF" });
  return links;
}
