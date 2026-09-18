/**
 * Verifies the Announcement / Student Notification system:
 *
 *  1. Pure visibility boundary (lib/announcement-visibility.ts) — DRAFT/
 *     ARCHIVED never visible regardless of dates; PUBLISHED respects
 *     publishAt (exclusive before) and expiresAt (exclusive at/after);
 *     deriveAnnouncementState distinguishes SCHEDULED/ACTIVE/EXPIRED.
 *  2. Safe route validation (lib/safe-route.ts) — internal paths accepted,
 *     protocol-relative/absolute/backslash/whitespace routes rejected.
 *  3. Audience resolution (lib/notifications.ts, DB-backed) — ALL_STUDENTS
 *     reaches every student, EXAM_STUDENTS only reaches students enrolled
 *     in that exam, ACTIVE_STUDENTS excludes a SUSPENDED student,
 *     SELECTED_STUDENTS only reaches explicit recipients, and a DRAFT
 *     announcement is invisible to everyone regardless of audience.
 *  4. Read-state (lazy StudentNotificationState) — unread by default,
 *     markAnnouncementRead flips just that student's row, marking twice is
 *     idempotent, and markAllAnnouncementsRead clears every remaining
 *     unread announcement for that student without touching another
 *     student's state.
 *
 * All fixture rows are deleted at the end regardless of pass/fail. Run from
 * the repo root with the react-server condition so `import "server-only"`
 * resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-announcements.ts
 */
import "dotenv/config";
import { PrismaClient, StudentAuthProvider } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
import { isAnnouncementVisible, deriveAnnouncementState } from "@/lib/announcement-visibility";
import { isSafeInternalRoute } from "@/lib/safe-route";
import { getVisibleAnnouncementsForStudent, markAnnouncementRead, markAllAnnouncementsRead } from "@/lib/notifications";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}

function verifyPureVisibility() {
  console.log("\n-- Visibility boundary (pure) --");
  const now = new Date("2026-06-15T12:00:00Z");
  const past = new Date("2026-06-01T00:00:00Z");
  const future = new Date("2026-07-01T00:00:00Z");

  check("DRAFT never visible even with an open window", !isAnnouncementVisible({ status: "DRAFT", publishAt: past, expiresAt: future }, now));
  check("ARCHIVED never visible even with an open window", !isAnnouncementVisible({ status: "ARCHIVED", publishAt: past, expiresAt: future }, now));
  check("PUBLISHED with no dates is visible", isAnnouncementVisible({ status: "PUBLISHED", publishAt: null, expiresAt: null }, now));
  check("PUBLISHED before publishAt is not visible", !isAnnouncementVisible({ status: "PUBLISHED", publishAt: future, expiresAt: null }, now));
  check("PUBLISHED exactly at publishAt is visible", isAnnouncementVisible({ status: "PUBLISHED", publishAt: now, expiresAt: null }, now));
  check("PUBLISHED exactly at expiresAt is NOT visible (exclusive)", !isAnnouncementVisible({ status: "PUBLISHED", publishAt: null, expiresAt: now }, now));
  check("PUBLISHED just before expiresAt is visible", isAnnouncementVisible({ status: "PUBLISHED", publishAt: null, expiresAt: new Date(now.getTime() + 1) }, now));

  check("deriveAnnouncementState: DRAFT stays DRAFT", deriveAnnouncementState({ status: "DRAFT", publishAt: null, expiresAt: null }, now) === "DRAFT");
  check(
    "deriveAnnouncementState: PUBLISHED + future publishAt -> SCHEDULED",
    deriveAnnouncementState({ status: "PUBLISHED", publishAt: future, expiresAt: null }, now) === "SCHEDULED"
  );
  check(
    "deriveAnnouncementState: PUBLISHED + past expiresAt -> EXPIRED",
    deriveAnnouncementState({ status: "PUBLISHED", publishAt: null, expiresAt: past }, now) === "EXPIRED"
  );
  check(
    "deriveAnnouncementState: PUBLISHED + open window -> ACTIVE",
    deriveAnnouncementState({ status: "PUBLISHED", publishAt: past, expiresAt: future }, now) === "ACTIVE"
  );
}

function verifySafeRoute() {
  console.log("\n-- Safe route validation (pure) --");
  check("accepts a plain internal path", isSafeInternalRoute("/student/live-tests"));
  check("accepts an internal path with a query string", isSafeInternalRoute("/student/exams?tab=upcoming"));
  check("rejects protocol-relative //evil.com", !isSafeInternalRoute("//evil.com"));
  check("rejects an absolute external URL", !isSafeInternalRoute("https://evil.com/phish"));
  check("rejects a bare host with no leading slash", !isSafeInternalRoute("evil.com"));
  check("rejects a route containing a backslash", !isSafeInternalRoute("/foo\\bar"));
  check("rejects a route containing whitespace", !isSafeInternalRoute("/foo bar"));
  check("rejects null/undefined/empty", !isSafeInternalRoute(null) && !isSafeInternalRoute(undefined) && !isSafeInternalRoute(""));
}

async function main() {
  console.log("=== Announcement / Notification Verification ===");
  verifyPureVisibility();
  verifySafeRoute();

  console.log("\n-- Audience resolution + read state (DB-backed) --");
  const suffix = Date.now().toString(36);
  const passwordHash = await argon2.hash("Passw0rd!234");

  const exam = await prisma.exam.create({ data: { name: `Announce Exam ${suffix}`, code: `ANNC-${suffix}` } });
  const otherExam = await prisma.exam.create({ data: { name: `Other Exam ${suffix}`, code: `OTHR-${suffix}` } });

  const studentAll = await prisma.student.create({
    data: { studentId: `ANNC-ALL-${suffix}`, name: "All Audience", email: `annc-all-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
  });
  const studentEnrolled = await prisma.student.create({
    data: { studentId: `ANNC-ENR-${suffix}`, name: "Enrolled Student", email: `annc-enr-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
  });
  const studentNotEnrolled = await prisma.student.create({
    data: { studentId: `ANNC-NOE-${suffix}`, name: "Not Enrolled", email: `annc-noe-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
  });
  const studentSuspended = await prisma.student.create({
    data: {
      studentId: `ANNC-SUS-${suffix}`,
      name: "Suspended Student",
      email: `annc-sus-${suffix}@example.test`,
      passwordHash,
      authProvider: StudentAuthProvider.CREDENTIALS,
      status: "SUSPENDED",
    },
  });
  const studentSelected = await prisma.student.create({
    data: { studentId: `ANNC-SEL-${suffix}`, name: "Selected Student", email: `annc-sel-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
  });
  const studentNotSelected = await prisma.student.create({
    data: { studentId: `ANNC-NSL-${suffix}`, name: "Not Selected", email: `annc-nsl-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
  });

  await prisma.studentExamEnrollment.create({ data: { studentId: studentEnrolled.id, examId: exam.id } });
  await prisma.studentExamEnrollment.create({ data: { studentId: studentNotEnrolled.id, examId: otherExam.id } });

  const draftAnnouncement = await prisma.announcement.create({
    data: { title: "Draft Only", message: "should never appear", audience: "ALL_STUDENTS", status: "DRAFT" },
  });
  const allAnnouncement = await prisma.announcement.create({
    data: { title: "For everyone", message: "hello all", audience: "ALL_STUDENTS", status: "PUBLISHED" },
  });
  const examAnnouncement = await prisma.announcement.create({
    data: { title: "For exam students", message: "hello exam", audience: "EXAM_STUDENTS", examId: exam.id, status: "PUBLISHED" },
  });
  const activeAnnouncement = await prisma.announcement.create({
    data: { title: "For active students", message: "hello active", audience: "ACTIVE_STUDENTS", status: "PUBLISHED" },
  });
  const selectedAnnouncement = await prisma.announcement.create({
    data: {
      title: "For selected students",
      message: "hello selected",
      audience: "SELECTED_STUDENTS",
      status: "PUBLISHED",
      recipients: { create: [{ studentId: studentSelected.id }] },
    },
  });

  try {
    const idsFor = async (studentId: string) => (await getVisibleAnnouncementsForStudent(studentId, { limit: 50 })).map((a) => a.id);

    const allIds = await idsFor(studentAll.id);
    check("DRAFT is never returned as visible", !allIds.includes(draftAnnouncement.id));
    check("ALL_STUDENTS announcement reaches an arbitrary student", allIds.includes(allAnnouncement.id));

    const enrolledIds = await idsFor(studentEnrolled.id);
    const notEnrolledIds = await idsFor(studentNotEnrolled.id);
    check("EXAM_STUDENTS reaches a student enrolled in that exam", enrolledIds.includes(examAnnouncement.id));
    check("EXAM_STUDENTS does not reach a student enrolled in a different exam", !notEnrolledIds.includes(examAnnouncement.id));

    const activeIds = await idsFor(studentAll.id);
    const suspendedIds = await idsFor(studentSuspended.id);
    check("ACTIVE_STUDENTS reaches an ACTIVE student", activeIds.includes(activeAnnouncement.id));
    check("ACTIVE_STUDENTS does not reach a SUSPENDED student", !suspendedIds.includes(activeAnnouncement.id));

    const selectedIds = await idsFor(studentSelected.id);
    const notSelectedIds = await idsFor(studentNotSelected.id);
    check("SELECTED_STUDENTS reaches an explicit recipient", selectedIds.includes(selectedAnnouncement.id));
    check("SELECTED_STUDENTS does not reach a non-recipient", !notSelectedIds.includes(selectedAnnouncement.id));

    console.log("\n-- Read state --");
    const before = await getVisibleAnnouncementsForStudent(studentAll.id, { limit: 50 });
    check("unread by default", before.find((a) => a.id === allAnnouncement.id)?.isRead === false);

    await markAnnouncementRead(studentAll.id, allAnnouncement.id);
    const afterOnce = await getVisibleAnnouncementsForStudent(studentAll.id, { limit: 50 });
    check("read after markAnnouncementRead", afterOnce.find((a) => a.id === allAnnouncement.id)?.isRead === true);

    await markAnnouncementRead(studentAll.id, allAnnouncement.id); // idempotent — must not throw on the unique constraint
    const afterTwice = await getVisibleAnnouncementsForStudent(studentAll.id, { limit: 50 });
    check("marking read twice is idempotent", afterTwice.find((a) => a.id === allAnnouncement.id)?.isRead === true);

    const otherStudentStillUnread = await getVisibleAnnouncementsForStudent(studentEnrolled.id, { limit: 50 });
    check(
      "marking one student's announcement read does not affect another student",
      otherStudentStillUnread.find((a) => a.id === allAnnouncement.id)?.isRead === false
    );

    await markAllAnnouncementsRead(studentEnrolled.id);
    const allReadNow = await getVisibleAnnouncementsForStudent(studentEnrolled.id, { limit: 50 });
    check("markAllAnnouncementsRead clears every visible unread announcement", allReadNow.every((a) => a.isRead));
  } finally {
    await prisma.studentNotificationState.deleteMany({
      where: { studentId: { in: [studentAll.id, studentEnrolled.id, studentNotEnrolled.id, studentSuspended.id, studentSelected.id, studentNotSelected.id] } },
    });
    await prisma.announcementRecipient.deleteMany({
      where: { announcementId: { in: [draftAnnouncement.id, allAnnouncement.id, examAnnouncement.id, activeAnnouncement.id, selectedAnnouncement.id] } },
    });
    await prisma.announcement.deleteMany({
      where: { id: { in: [draftAnnouncement.id, allAnnouncement.id, examAnnouncement.id, activeAnnouncement.id, selectedAnnouncement.id] } },
    });
    await prisma.studentExamEnrollment.deleteMany({ where: { studentId: { in: [studentEnrolled.id, studentNotEnrolled.id] } } });
    await prisma.student.deleteMany({
      where: { id: { in: [studentAll.id, studentEnrolled.id, studentNotEnrolled.id, studentSuspended.id, studentSelected.id, studentNotSelected.id] } },
    });
    await prisma.exam.deleteMany({ where: { id: { in: [exam.id, otherExam.id] } } });
  }

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} ===`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
