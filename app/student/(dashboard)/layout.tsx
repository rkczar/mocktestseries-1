import { redirect } from "next/navigation";
import { requireStudent, StudentUnauthorizedError } from "@/lib/student-session";
import { StudentShell } from "@/components/student/shell";
import { FloatingWhatsAppSupport } from "@/components/support/floating-whatsapp-support";

export default async function StudentDashboardLayout({ children }: { children: React.ReactNode }) {
  let student;
  try {
    student = await requireStudent();
  } catch (error) {
    if (error instanceof StudentUnauthorizedError) redirect("/login");
    throw error;
  }

  return (
    <>
      <StudentShell student={student}>
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">{children}</div>
      </StudentShell>
      <FloatingWhatsAppSupport surface="student" />
    </>
  );
}
