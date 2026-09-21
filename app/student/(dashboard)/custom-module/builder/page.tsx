import { redirect } from "next/navigation";

/**
 * The "Build Your Own" landing step was removed (Section 8) — /student/custom-module
 * now opens directly into the builder as its default tab. This route is kept
 * only so existing bookmarks/links (e.g. Exam detail's "Build Your Own
 * Module") still land somewhere real instead of 404ing.
 */
export default async function CustomModuleBuilderRedirect({ searchParams }: { searchParams: Promise<{ examId?: string }> }) {
  const { examId } = await searchParams;
  redirect(examId ? `/student/custom-module?examId=${examId}` : "/student/custom-module");
}
