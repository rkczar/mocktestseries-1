import Link from "next/link";
import { requireTeacherPage } from "@/lib/teacher/page";
import { parseStudentListParams } from "@/lib/admin-students-list";
import { studentScopeWhere } from "@/lib/teacher/students";
import { AllStudentsPanel } from "@/app/admin/(dashboard)/students/all-students-panel";

export const metadata = { title: "Students — Teacher Portal" };
export const dynamic = "force-dynamic";

/**
 * Teacher Portal → Students (read-only): the Admin student list, scoped to
 * students of the teacher's ACTIVE exams, without contact details or
 * per-student access labels.
 */
export default async function TeacherStudents({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const scope = await requireTeacherPage();
  if (scope.examIds.length === 0) return <p className="text-sm">No exam is assigned to you yet.</p>;
  const sp = await searchParams;
  const params = { ...parseStudentListParams(sp), access: "all" as const };
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Students</h1>
        <Link href="/teacher/students/history" className="text-sm underline">Test history (all students)</Link>
      </div>
      <AllStudentsPanel params={params} teacher={{ basePath: "/teacher/students", scope: { where: studentScopeWhere(scope.examIds), privacy: true } }} />
    </>
  );
}
