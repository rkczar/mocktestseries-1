import { redirect } from "next/navigation";
import { requireStudent, StudentUnauthorizedError } from "@/lib/student-session";

export default async function AttemptLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireStudent();
  } catch (error) {
    if (error instanceof StudentUnauthorizedError) redirect("/login");
    throw error;
  }

  return <div className="min-h-screen bg-[var(--color-background)]">{children}</div>;
}
