import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicExamBySlug } from "@/lib/exam-public";
import { getSiteUrl } from "@/lib/site-url";
import { displayExamName } from "@/lib/exam-display";
import { examPageMetadata } from "@/lib/exam-seo";
import { getEditorialPage } from "@/lib/exam-editorial-pages";
import { EditorialExamPage } from "@/components/public-exam/editorial-page";

/** Hand-written Eligibility page; 404 for any exam without one (lib/exam-editorial-pages.ts). */
async function load(slug: string) {
  const exam = await getPublicExamBySlug(slug);
  const page = exam ? getEditorialPage(exam.code, "eligibility") : null;
  return exam && page ? { exam, page } : null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const data = await load((await params).slug);
  if (!data) return {};
  return examPageMetadata({ exam: data.exam, path: `/exams/${data.exam.publicSlug}/eligibility`, absoluteTitle: data.page.metaTitle, description: data.page.metaDescription });
}

export default async function ExamEligibilityPage({ params }: { params: Promise<{ slug: string }> }) {
  const data = await load((await params).slug);
  if (!data) notFound();
  return (
    <EditorialExamPage siteUrl={await getSiteUrl()} examName={displayExamName(data.exam.name)} slug={data.exam.publicSlug!} crumb="Eligibility" page={data.page} />
  );
}
