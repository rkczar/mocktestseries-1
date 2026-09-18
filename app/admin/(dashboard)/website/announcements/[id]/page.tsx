import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toIstDateTimeLocalValue } from "@/lib/ist-time";
import { AnnouncementForm } from "../announcement-form";

export const metadata = { title: "Edit Announcement — Mock Test Series.in Admin" };

export default async function EditAnnouncementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [announcement, exams] = await Promise.all([
    prisma.announcement.findUnique({
      where: { id },
      include: { recipients: { include: { student: { select: { studentId: true } } } } },
    }),
    prisma.exam.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
  ]);
  if (!announcement) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/admin/website"
          className="mb-2 inline-flex items-center gap-1.5 text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to Website
        </Link>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Edit Announcement</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{announcement.title}</CardTitle>
        </CardHeader>
        <CardContent>
          {announcement.status === "ARCHIVED" ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">This announcement is archived and can no longer be edited.</p>
          ) : (
            <AnnouncementForm
              exams={exams}
              announcementId={announcement.id}
              initial={{
                title: announcement.title,
                message: announcement.message,
                content: announcement.content,
                type: announcement.type,
                priority: announcement.priority,
                audience: announcement.audience,
                examId: announcement.examId,
                ctaLabel: announcement.ctaLabel,
                ctaRoute: announcement.ctaRoute,
                showOnDashboard: announcement.showOnDashboard,
                publishAt: announcement.publishAt ? toIstDateTimeLocalValue(announcement.publishAt) : null,
                expiresAt: announcement.expiresAt ? toIstDateTimeLocalValue(announcement.expiresAt) : null,
                selectedStudentIds: announcement.recipients.map((r) => r.student.studentId).join(", "),
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
