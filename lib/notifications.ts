import "server-only";
import type { Announcement, AnnouncementType, AnnouncementPriority, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isAnnouncementVisible } from "@/lib/announcement-visibility";

/**
 * Audience resolution and read-state for the Announcement system — see the
 * schema comment above `model Announcement` for the overall design. Nothing
 * here duplicates an Announcement row per student: audience is resolved at
 * read time against the student's own status/enrollments/explicit-recipient
 * rows, and read state is a single lazily-created StudentNotificationState
 * row per (student, announcement) pair the student has actually opened.
 */

export interface StudentAnnouncement {
  id: string;
  title: string;
  message: string;
  content: string | null;
  type: AnnouncementType;
  priority: AnnouncementPriority;
  ctaLabel: string | null;
  ctaRoute: string | null;
  showOnDashboard: boolean;
  publishAt: Date | null;
  createdAt: Date;
  isRead: boolean;
}

/** Announcement rows a given student is a candidate audience member for, regardless of publish window — filtering by time/status happens in the caller via `isAnnouncementVisible` so a single query can serve both "visible now" and "admin preview" needs. */
async function candidateAnnouncementsWhere(studentId: string): Promise<Prisma.AnnouncementWhereInput> {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { status: true, examEnrollments: { select: { examId: true } } },
  });
  if (!student) return { id: "__none__" };

  const examIds = student.examEnrollments.map((e) => e.examId);

  const or: Prisma.AnnouncementWhereInput[] = [{ audience: "ALL_STUDENTS" }, { audience: "SELECTED_STUDENTS", recipients: { some: { studentId } } }];
  if (student.status === "ACTIVE") or.push({ audience: "ACTIVE_STUDENTS" });
  if (examIds.length > 0) or.push({ audience: "EXAM_STUDENTS", examId: { in: examIds } });

  return { OR: or };
}

/**
 * Currently-visible announcements for a student, newest/most-important first,
 * each carrying whether *this* student has read it. Pass `dashboardOnly` to
 * scope to the homepage/dashboard card set rather than a full notification list.
 */
export async function getVisibleAnnouncementsForStudent(
  studentId: string,
  { limit = 50, dashboardOnly = false }: { limit?: number; dashboardOnly?: boolean } = {}
): Promise<StudentAnnouncement[]> {
  const audienceWhere = await candidateAnnouncementsWhere(studentId);

  const rows = await prisma.announcement.findMany({
    where: {
      ...audienceWhere,
      status: "PUBLISHED",
      // Dashboard cards the student closed (X) stay hidden for that student only.
      ...(dashboardOnly ? { showOnDashboard: true, reads: { none: { studentId, dismissedAt: { not: null } } } } : {}),
    },
    include: { reads: { where: { studentId }, select: { readAt: true } } },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: limit * 2, // over-fetch: some rows are filtered out below by the exact publishAt/expiresAt boundary
  });

  const now = new Date();
  const visible = rows.filter((row) => isAnnouncementVisible(row, now));

  return visible.slice(0, limit).map((row) => ({
    id: row.id,
    title: row.title,
    message: row.message,
    content: row.content,
    type: row.type,
    priority: row.priority,
    ctaLabel: row.ctaLabel,
    ctaRoute: row.ctaRoute,
    showOnDashboard: row.showOnDashboard,
    publishAt: row.publishAt,
    createdAt: row.createdAt,
    isRead: row.reads[0]?.readAt != null,
  }));
}

export async function markAnnouncementRead(studentId: string, announcementId: string): Promise<void> {
  await prisma.studentNotificationState.upsert({
    where: { studentId_announcementId: { studentId, announcementId } },
    update: { readAt: new Date() },
    create: { studentId, announcementId, readAt: new Date() },
  });
}

/**
 * Per-student Dashboard dismissal. Only this student's StudentNotificationState
 * row changes — the Announcement and every other student's view are untouched.
 * Dismissing also counts as reading it. Returns false if the announcement isn't
 * one this student can currently see.
 */
export async function dismissAnnouncementForStudent(studentId: string, announcementId: string): Promise<boolean> {
  const audienceWhere = await candidateAnnouncementsWhere(studentId);
  const row = await prisma.announcement.findFirst({
    where: { AND: [audienceWhere, { id: announcementId, status: "PUBLISHED" }] },
    select: { id: true, status: true, publishAt: true, expiresAt: true },
  });
  if (!row || !isAnnouncementVisible(row, new Date())) return false;

  const now = new Date();
  const existing = await prisma.studentNotificationState.findUnique({
    where: { studentId_announcementId: { studentId, announcementId } },
    select: { readAt: true },
  });
  await prisma.studentNotificationState.upsert({
    where: { studentId_announcementId: { studentId, announcementId } },
    update: { dismissedAt: now, ...(existing?.readAt ? {} : { readAt: now }) },
    create: { studentId, announcementId, readAt: now, dismissedAt: now },
  });
  return true;
}

export async function markAllAnnouncementsRead(studentId: string): Promise<void> {
  const visible = await getVisibleAnnouncementsForStudent(studentId, { limit: 200 });
  const unreadIds = visible.filter((a) => !a.isRead).map((a) => a.id);
  if (unreadIds.length === 0) return;

  const now = new Date();
  await prisma.$transaction(
    unreadIds.map((announcementId) =>
      prisma.studentNotificationState.upsert({
        where: { studentId_announcementId: { studentId, announcementId } },
        update: { readAt: now },
        create: { studentId, announcementId, readAt: now },
      })
    )
  );
}

/** How many currently-enrolled/eligible students a given audience configuration would actually reach — for the admin composer's "Reaches ~N students" preview. Never used for delivery, only for the count. */
export async function estimateAudienceReach(input: {
  audience: "ALL_STUDENTS" | "EXAM_STUDENTS" | "ACTIVE_STUDENTS" | "SELECTED_STUDENTS";
  examId?: string | null;
  selectedStudentIds?: string[];
}): Promise<number> {
  switch (input.audience) {
    case "ALL_STUDENTS":
      return prisma.student.count();
    case "ACTIVE_STUDENTS":
      return prisma.student.count({ where: { status: "ACTIVE" } });
    case "EXAM_STUDENTS":
      if (!input.examId) return 0;
      return prisma.studentExamEnrollment.count({ where: { examId: input.examId } });
    case "SELECTED_STUDENTS":
      return input.selectedStudentIds?.length ?? 0;
  }
}

export type { Announcement };
