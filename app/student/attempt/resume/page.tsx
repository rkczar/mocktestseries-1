import { redirect } from "next/navigation";
import { requireStudent } from "@/lib/student-session";
import { startPreviousYearPaperAttempt, startMockTestAttempt } from "@/lib/test-attempt";

/**
 * The single resume destination every public SEO page (/exams/[slug]/...)
 * links "Attempt Paper" / "Take Mock Test" CTAs to, instead of duplicating
 * the authenticated start-attempt flow. Because this route lives under
 * /student, middleware.ts already gates it — an anonymous visitor is
 * bounced to /login?callbackUrl=/student/attempt/resume?paper=<id>, and
 * app/login/actions.ts#safeCallback already only honors callbackUrl values
 * that start with "/student", so this never becomes an open redirect. On
 * return from login the exact same URL (query string included, per the
 * middleware fix preserving request.nextUrl.search) re-runs this page,
 * now authenticated, and lands the student in the canonical TestAttempt —
 * no second test engine, no lost selection.
 */
export default async function ResumeAttemptPage({
  searchParams,
}: {
  searchParams: Promise<{ paper?: string; mockTest?: string }>;
}) {
  const { paper, mockTest } = await searchParams;
  const student = await requireStudent();

  if (paper) {
    const attempt = await startPreviousYearPaperAttempt(student.id, paper);
    redirect(`/student/attempt/${attempt.id}`);
  }

  if (mockTest) {
    const attempt = await startMockTestAttempt(student.id, mockTest);
    redirect(`/student/attempt/${attempt.id}`);
  }

  redirect("/student/dashboard");
}
