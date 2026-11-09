import Link from "next/link";
import { requireTeacherPage } from "@/lib/teacher/page";
import { TestHistoryView } from "@/components/admin/test-history-view";

export const metadata = { title: "Test History — Teacher Portal" };
export const dynamic = "force-dynamic";

/** Admin → Students → Test History, limited to the teacher's ACTIVE exams. */
export default async function TeacherHistory({ searchParams }: { searchParams: Promise<{ examId?: string }> }) {
  const scope = await requireTeacherPage();
  const { examId } = await searchParams;
  return (
    <div className="flex flex-col gap-5">
      <Link href="/teacher/students" className="text-sm underline">← Students</Link>
      <h1 className="text-xl font-semibold">Test History</h1>
      <TestHistoryView examId={examId} basePath="/teacher/students/history" studentHref={(id) => `/teacher/students/${id}`} scopeExamIds={scope.examIds} />
    </div>
  );
}
