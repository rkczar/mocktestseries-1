import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireStudent } from "@/lib/student-session";
import { ACTIVE_EXAM_COOKIE } from "@/lib/active-exam";
import { findPracticeOmrSheet } from "@/lib/omr-sheet";

/**
 * Retired intermediate page. The Student Dashboard's "Practice OMR Sheet"
 * card downloads the sheet directly; this route stays only so old links and
 * bookmarks keep working. It sends them to that same canonical download
 * (app/api/student/test-resources/[id]), whose access checks apply as usual.
 */
export default async function StudentOmrPage() {
  await requireStudent();
  const activeExamId = (await cookies()).get(ACTIVE_EXAM_COOKIE)?.value ?? null;
  const sheet = await findPracticeOmrSheet(activeExamId);
  redirect(sheet ? `/api/student/test-resources/${sheet.id}` : "/student/dashboard");
}
