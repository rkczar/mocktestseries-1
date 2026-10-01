import { getPublicExamBySlug } from "@/lib/exam-public";
import { displayExamName } from "@/lib/exam-display";
import { renderExamOgImage } from "@/lib/og/render";

// Exam names change rarely; the URL also carries the exam's updatedAt
// (lib/social-metadata.ts), so a rename gets a fresh URL for social caches.
export const revalidate = 86400;

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) return new Response("Not found", { status: 404 });
  return renderExamOgImage(displayExamName(exam.name));
}
