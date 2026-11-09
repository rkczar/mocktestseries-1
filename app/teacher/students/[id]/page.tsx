import Link from "next/link";
import { inScopeOr404, requireTeacherPage } from "@/lib/teacher/page";
import { studentInScope, teacherDisplayName, teacherStudentAttempts } from "@/lib/teacher/students";
import { getStudentAnalytics } from "@/lib/student-data";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StudentTestHistory } from "@/components/admin/student-test-history";
import { StudentAnalyticsSections } from "@/components/student/analytics-sections";

export const metadata = { title: "Student — Teacher Portal" };
export const dynamic = "force-dynamic";

const fmt = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }) : "Never");

/**
 * One student, limited to the teacher's exams: the student Analytics sections
 * and the Admin Test History table (also unreleased results — owner decision). No
 * email, mobile, devices, payments or account actions.
 */
export default async function TeacherStudent({ params }: { params: Promise<{ id: string }> }) {
  const scope = await requireTeacherPage();
  const { id } = await params;
  const s = await inScopeOr404(() => studentInScope(scope, id));
  const [attempts, a] = await Promise.all([teacherStudentAttempts(scope, s.id), getStudentAnalytics(s.id, { examIds: scope.examIds, includeUnreleased: true })]);
  return (
    <div className="flex flex-col gap-5">
      <Link href="/teacher/students" className="text-sm underline">← Students</Link>
      <div>
        <h1 className="text-xl font-semibold">{teacherDisplayName(s)}</h1>
        <p className="font-mono text-sm text-[var(--color-muted-foreground)]">{s.studentId}</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[var(--color-muted-foreground)]">
          <Badge variant={s.status === "ACTIVE" ? "success" : "warning"}>{s.status.replace(/_/g, " ")}</Badge> Registered {fmt(s.createdAt)} · Last sign-in {fmt(s.lastLoginAt)}
        </p>
      </div>

      <StudentAnalyticsSections analytics={a} />

      <Card>
        <CardHeader><CardTitle>Test Attempts</CardTitle><CardDescription>{attempts.length} attempts in your exams (max 100 shown)</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          <StudentTestHistory attempts={attempts} />
        </CardContent>
      </Card>
    </div>
  );
}
