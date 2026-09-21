import { StudentHeader } from "@/components/student/header";
import { SiteFooter } from "@/components/homepage/site-footer";
import { getPublicChrome } from "@/components/homepage/public-page-shell";
import { getVisibleAnnouncementsForStudent } from "@/lib/notifications";

/**
 * The one shared Header + Footer shell for "normal" student pages (Section
 * 19/20/21) — the Dashboard group layout and the post-submission Result/
 * Review pages all render this instead of each hardcoding their own footer.
 * The footer itself is the exact same canonical `<SiteFooter>` + content
 * used by the public site (components/homepage/public-page-shell.tsx), never
 * a second copy — editing the Homepage Builder's Footer section updates
 * every one of these pages too. The focused Test Player (run/page.tsx) is
 * the deliberate exception and never uses this shell.
 */
export async function StudentShell({
  student,
  children,
}: {
  student: { id: string; name: string | null; studentId: string };
  children: React.ReactNode;
}) {
  const [announcements, { footer, contactInfo }] = await Promise.all([
    getVisibleAnnouncementsForStudent(student.id, { limit: 30 }),
    getPublicChrome(),
  ]);
  const growWithUsEnabled = (contactInfo?.content as Record<string, unknown> | undefined)?.growWithUsEnabled !== false;

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-background)]">
      <StudentHeader
        name={student.name ?? "Student"}
        studentId={student.studentId}
        announcements={announcements.map((a) => ({
          id: a.id,
          title: a.title,
          message: a.message,
          priority: a.priority,
          ctaLabel: a.ctaLabel,
          ctaRoute: a.ctaRoute,
          createdAt: a.createdAt.toISOString(),
          isRead: a.isRead,
        }))}
      />
      <main className="flex-1">{children}</main>
      {footer?.isEnabled !== false ? (
        <SiteFooter
          content={(footer?.content as Record<string, unknown>) ?? {}}
          resolved={footer?.resolved ?? {}}
          growWithUsEnabled={growWithUsEnabled}
        />
      ) : null}
    </div>
  );
}
