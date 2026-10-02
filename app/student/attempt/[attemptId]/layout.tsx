import { requireStudentOrLogin } from "@/lib/student-session";

export default async function AttemptLayout({ children }: { children: React.ReactNode }) {
  await requireStudentOrLogin();

  return <div className="min-h-screen bg-[var(--color-background)]">{children}</div>;
}
