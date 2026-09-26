import { redirect } from "next/navigation";
import { requireStudent, StudentUnauthorizedError } from "@/lib/student-session";
import { FloatingWhatsAppSupport } from "@/components/support/floating-whatsapp-support";

export default async function AttemptLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireStudent();
  } catch (error) {
    if (error instanceof StudentUnauthorizedError) redirect("/login");
    throw error;
  }

  // On the live Test Player (…/run) the button renders in document flow after
  // the player instead of floating — see components/support/whatsapp-support-button.tsx.
  return (
    <div className="min-h-screen bg-[var(--color-background)]">
      {children}
      <FloatingWhatsAppSupport surface="student" />
    </div>
  );
}
