import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatIst } from "@/lib/ist-time";
import { deriveAnnouncementState, type DerivedAnnouncementState } from "@/lib/announcement-visibility";
import { AnnouncementForm } from "./announcement-form";
import { AnnouncementStatusActions } from "./status-actions";

export const metadata = { title: "Announcements — Mock Test Series.in Admin" };

const STATE_BADGE_VARIANT: Record<DerivedAnnouncementState, "warning" | "success" | "neutral" | "info" | "error"> = {
  DRAFT: "neutral",
  SCHEDULED: "info",
  ACTIVE: "success",
  EXPIRED: "warning",
  ARCHIVED: "error",
};

const AUDIENCE_LABEL: Record<string, string> = {
  ALL_STUDENTS: "All Students",
  EXAM_STUDENTS: "Exam Students",
  ACTIVE_STUDENTS: "Active Students",
  SELECTED_STUDENTS: "Selected Students",
};

export default async function AnnouncementsPage() {
  const [exams, announcements] = await Promise.all([
    prisma.exam.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    prisma.announcement.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { exam: { select: { name: true } }, _count: { select: { recipients: true, reads: true } } },
    }),
  ]);

  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Announcements</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Broadcast a message to students via the notification bell and, optionally, a dashboard card. One row reaches
          every matching student — audience is resolved live, so it never needs per-student duplication or a resend.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New Announcement</CardTitle>
        </CardHeader>
        <CardContent>
          <AnnouncementForm exams={exams} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Announcements</CardTitle>
          <CardDescription>{announcements.length} total</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {announcements.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No announcements yet.</p>
          ) : (
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">Audience</th>
                  <th className="py-2 pr-4">Window</th>
                  <th className="py-2 pr-4">Reads</th>
                  <th className="py-2 pr-4">State</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {announcements.map((a) => {
                  const state = deriveAnnouncementState(a, now);
                  const audienceLabel =
                    a.audience === "EXAM_STUDENTS" && a.exam
                      ? `Exam: ${a.exam.name}`
                      : a.audience === "SELECTED_STUDENTS"
                        ? `${a._count.recipients} selected`
                        : AUDIENCE_LABEL[a.audience];
                  return (
                    <tr key={a.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{a.title}</td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{audienceLabel}</td>
                      <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                        {a.publishAt ? formatIst(a.publishAt) : "Manual"}
                        {a.expiresAt ? ` → ${formatIst(a.expiresAt)}` : ""}
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{a._count.reads}</td>
                      <td className="py-2.5 pr-4">
                        <Badge variant={STATE_BADGE_VARIANT[state]}>{state}</Badge>
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-3">
                          {state !== "ARCHIVED" ? (
                            <Link href={`/admin/website/announcements/${a.id}`} className="text-[var(--color-primary)] hover:underline">
                              Edit
                            </Link>
                          ) : null}
                          <AnnouncementStatusActions announcementId={a.id} status={a.status} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
