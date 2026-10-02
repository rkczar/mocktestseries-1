import { requireStudentOrLogin } from "@/lib/student-session";
import { StudentShell } from "@/components/student/shell";

export default async function StudentDashboardLayout({ children }: { children: React.ReactNode }) {
  const student = await requireStudentOrLogin();

  return (
    <StudentShell student={student}>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">{children}</div>
    </StudentShell>
  );
}
