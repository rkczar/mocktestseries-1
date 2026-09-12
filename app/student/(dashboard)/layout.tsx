import { redirect } from "next/navigation";
import { requireStudent, StudentUnauthorizedError } from "@/lib/student-session";
import { StudentHeader } from "@/components/student/header";

export default async function StudentDashboardLayout({ children }: { children: React.ReactNode }) {
  let student;
  try {
    student = await requireStudent();
  } catch (error) {
    if (error instanceof StudentUnauthorizedError) redirect("/login");
    throw error;
  }

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-background)]">
      <StudentHeader name={student.name ?? "Student"} studentId={student.studentId} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
