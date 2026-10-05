/**
 * Student Reviews / Testimonials — data-layer verification on a DISPOSABLE
 * database: sanitizer, settings normalization, the provenance/publish CHECK
 * constraints and trigger, and the public homepage selection (approved +
 * published only, inactive students hidden, Verified only for genuine
 * student reviews, featured/order/max, no private fields).
 *
 * `setup` also leaves a fixture for scripts/verify-reviews.mjs (browser/HTTP)
 * and prints it as JSON; `cleanup` removes it.
 *
 * `dashboard-setup <ai-actions-ux fixture.json>` prepares the Student
 * Dashboard suite (scripts/verify-reviews-dashboard.mjs) on a *payverify*
 * scratch DB already seeded by scripts/ai-actions-ux-fixture.ts: 4 published
 * + 1 hidden ADMIN_ADDED reviews, one approved STUDENT_SUBMITTED review by the
 * fixture's "nine" student (enrolled in the fixture exam), a PAID product for
 * that exam (so Access & Subscription renders), payment mode PAID, the production dashboard layout
 * saved before the reviews block existed, and the two QA admins.
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-reviews.ts [setup|cleanup|dashboard-setup <fixture>]
 */
import "dotenv/config";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { nextStudentId } from "@/lib/student-id";
import { readFileSync } from "node:fs";
import { computeHomepageReviews } from "@/lib/reviews";
import { setPaymentMode } from "@/lib/payments/settings";
import { normalizeStudentDashboardLayout } from "@/lib/student-dashboard-layout";
import { DEFAULT_STUDENT_DASHBOARD_LAYOUT, STUDENT_DASHBOARD_BLOCKS } from "@/lib/student-dashboard-blocks";
import {
  DEFAULT_REVIEWS_SECTION_SETTINGS,
  REVIEWS_SECTION_SETTING_KEY,
  cleanReviewText,
  looksLikeSpam,
  normalizeReviewsSectionSettings,
  publicStudentName,
} from "@/lib/reviews-shared";

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

const PASSWORD = "QaReviews!2345678";
const TAG = "qa-reviews";
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.error(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
}
async function rejects(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(name, false, "write succeeded");
  } catch {
    check(name, true);
  }
}

async function cleanup() {
  await prisma.review.deleteMany({});
  await prisma.setting.deleteMany({ where: { key: REVIEWS_SECTION_SETTING_KEY } });
  const students = await prisma.student.findMany({ where: { email: { endsWith: `@${TAG}.test` } }, select: { id: true } });
  const ids = students.map((s) => s.id);
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentLoginAttempt.deleteMany({ where: { OR: [{ studentId: { in: ids } }, { identifier: { endsWith: `@${TAG}.test` } }] } });
  await prisma.studentDevice.deleteMany({ where: { studentId: { in: ids } } }).catch(() => {});
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await prisma.exam.deleteMany({ where: { code: "QA-REVIEWS" } });
  const admins = await prisma.adminUser.findMany({ where: { username: { startsWith: `${TAG}-` } }, select: { id: true } });
  await prisma.loginAttempt.deleteMany({ where: { adminUserId: { in: admins.map((a) => a.id) } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { actorId: { in: admins.map((a) => a.id) } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: admins.map((a) => a.id) } } });
}

async function makeStudent(key: string, status: "ACTIVE" | "DELETED", examId: string, withAttempt: boolean, passwordHash: string) {
  const student = await prisma.student.create({
    data: {
      studentId: await nextStudentId(),
      name: `Qa ${key[0].toUpperCase()}${key.slice(1)} Student`,
      email: `${key}@${TAG}.test`,
      passwordHash,
      authProvider: "CREDENTIALS",
      status,
    },
  });
  await prisma.studentProfile.create({ data: { studentId: student.id } });
  await prisma.studentExamEnrollment.create({ data: { studentId: student.id, examId } });
  if (withAttempt) {
    await prisma.testAttempt.create({
      data: { studentId: student.id, sourceType: "SUBJECT_TEST", examId, durationMinutes: 10, totalQuestions: 5, status: "SUBMITTED", submittedAt: new Date() },
    });
  }
  return student;
}

async function unitChecks() {
  check("sanitizer drops script blocks and tags", cleanReviewText('Great <script>alert(1)</script><img src=x onerror=alert(1)> <b>site</b>', 600) === "Great site");
  check("sanitizer strips stray angle brackets", !/[<>]/.test(cleanReviewText("a < b > c", 600)));
  check("sanitizer strips bidi/zero-width/control", cleanReviewText("a\u202Eb\u200Bc\u0007d", 600) === "abcd");
  check("sanitizer caps length", cleanReviewText("x".repeat(900), 600).length === 600);
  check("sanitizer keeps paragraphs (multiline)", cleanReviewText("one\n\n\n\ntwo", 600, { multiline: true }) === "one\n\ntwo");
  check("spam: link", looksLikeSpam("visit https://spam.example now"));
  check("spam: domain", looksLikeSpam("go to cheapmocks.in today"));
  check("spam: phone", looksLikeSpam("call 98765 43210"));
  check("spam: normal review passes", !looksLikeSpam("The RUHS mock tests and PYQ explanations helped me a lot in 2026."));
  check("public name = first + last initial", publicStudentName("Priya Kumari Sharma") === "Priya S.");
  check("public name single word", publicStudentName("Priya") === "Priya");
  check("public name empty", publicStudentName("") === "Student");
  const n = normalizeReviewsSectionSettings({ maxReviews: 999, speed: "WARP", heading: "  ", enabled: "yes", subtitle: "<b>Hi</b>" });
  check("settings: invalid fields fall back", n.maxReviews === 12 && n.speed === "NORMAL" && n.heading === "What Students Say" && n.enabled === true);
  check("settings: subtitle sanitized", n.subtitle === "Hi");
  // Student Dashboard block placement: the production layout saved before the block existed.
  const prodSaved = PRODUCTION_SAVED_LAYOUT.map((id) => ({ id, visible: true }));
  const prod = normalizeStudentDashboardLayout(prodSaved).map((b) => b.id);
  check("dashboard: reviews block directly above access-status in the saved production layout", prod[prod.indexOf("access-status") - 1] === "student-reviews", prod);
  check("dashboard: every other block keeps its saved order", JSON.stringify(prod.filter((id) => id !== "student-reviews" && id !== "share-review")) === JSON.stringify(prodSaved.map((b) => b.id)), prod);
  const moved = normalizeStudentDashboardLayout([{ id: "access-status", visible: true }, { id: "weak-topics", visible: true }]).map((b) => b.id);
  check("dashboard: follows access-status wherever the admin put it", moved[0] === "student-reviews" && moved[1] === "access-status", moved);
  const def = DEFAULT_STUDENT_DASHBOARD_LAYOUT.map((b) => b.id);
  check("dashboard: default layout also places it directly above access-status", def[def.indexOf("access-status") - 1] === "student-reviews" && def.length === STUDENT_DASHBOARD_BLOCKS.length);
  check("dashboard: access-status stays first in the registry", STUDENT_DASHBOARD_BLOCKS[0].id === "access-status");
  const hidden = normalizeStudentDashboardLayout([...prodSaved, { id: "student-reviews", visible: false }]);
  check("dashboard: an admin-hidden reviews block stays hidden", hidden.find((b) => b.id === "student-reviews")?.visible === false);
  check("settings: null -> defaults", JSON.stringify(normalizeReviewsSectionSettings(null)) === JSON.stringify(DEFAULT_REVIEWS_SECTION_SETTINGS));
}

const PRODUCTION_SAVED_LAYOUT = ["performance-summary", "practice-omr", "custom-module", "analytics-progress", "previous-year-papers", "mock-tests", "subject-test", "test-schedule", "test-on-the-go", "subjects", "continue-attempt", "recent-activity", "weak-topics", "access-status", "subscription-status", "install-app"];

async function createAdmins(passwordHash: string) {
  const masterRole = await prisma.role.findUnique({ where: { name: "MASTER_ADMIN" }, select: { id: true } });
  const fullRole = await prisma.role.findUnique({ where: { name: "FULL_ADMIN" }, select: { id: true } });
  if (!masterRole || !fullRole) throw new Error("Roles missing — run prisma/seed.ts on the scratch DB first.");
  await prisma.adminUser.create({ data: { name: "QA Reviews Master", username: `${TAG}-master`, passwordHash, roleId: masterRole.id } });
  await prisma.adminUser.create({ data: { name: "QA Reviews Full", username: `${TAG}-full`, passwordHash, roleId: fullRole.id } });
}

async function dashboardSetup(fixturePath: string) {
  if (!/payverify/.test(process.env.DATABASE_URL ?? "")) throw new Error("dashboard-setup needs a *payverify* scratch DB (it sets payment mode PAID).");
  const fx = JSON.parse(readFileSync(fixturePath, "utf8")) as { examId: string; students: { nine: string } };
  await createAdmins(await argon2.hash(PASSWORD));
  const now = new Date();
  const admin = (displayName: string, rating: number, comment: string, extra: { isPublished?: boolean; isFeatured?: boolean; displayOrder?: number; examName?: string } = {}) =>
    prisma.review.create({ data: { source: "ADMIN_ADDED", status: "APPROVED", isPublished: true, approvedAt: now, displayName, rating, comment, ...extra } });
  await admin("Anita Verma", 5, "The full-length mock tests felt exactly like the real exam. Highly recommended.", { isFeatured: true, examName: "RUHS Medical Officer" });
  await admin("Rohit K.", 4, "PYQ explanations are clear and the analytics help me fix weak topics.", { displayOrder: 1 });
  await admin("Meena S.", 5, "Ask AI explanations saved me hours of searching through textbooks during revision.", { displayOrder: 2 });
  await admin("Karan P.", 4, "Daily practice with subject tests kept me consistent.", { displayOrder: 3 });
  await admin("Hidden Person", 5, "This hidden testimonial must never appear anywhere.", { isPublished: false });
  const comment = "Genuine student review from a verified account.";
  await prisma.review.create({
    data: { source: "STUDENT_SUBMITTED", status: "APPROVED", isPublished: true, displayOrder: 4, studentId: fx.students.nine, approvedAt: now, displayName: "Nine S.", rating: 5, comment, originalDisplayName: "Nine S.", originalRating: 5, originalComment: comment },
  });
  const series = await prisma.testSeries.create({ data: { examId: fx.examId, name: "QA Dash Series", status: "PUBLISHED", testCount: 4 } });
  await prisma.mockTest.create({ data: { examId: fx.examId, testSeriesId: series.id, title: "QA Dash Paid", durationMinutes: 30, status: "PUBLISHED", accessType: "PAID", order: 99 } });
  await prisma.product.deleteMany({ where: { code: "qa-dash" } });
  await prisma.product.create({
    data: { code: "qa-dash", name: "QA Complete Series", productType: "TEST_SERIES", examId: fx.examId, testSeriesId: series.id, accessType: "PAID", mrpPaise: 199900, sellingPricePaise: 79900, accessDurationType: "DAYS", accessDays: 180 },
  });
  // An active exam is what makes Access & Subscription render on the dashboard.
  await prisma.studentExamEnrollment.upsert({
    where: { studentId_examId: { studentId: fx.students.nine, examId: fx.examId } },
    create: { studentId: fx.students.nine, examId: fx.examId },
    update: {},
  });
  await setPaymentMode("PAID", undefined);
  const layout = PRODUCTION_SAVED_LAYOUT.map((id) => ({ id, visible: true }));
  await prisma.setting.upsert({ where: { key: "website.student_dashboard_layout" }, create: { key: "website.student_dashboard_layout", value: layout }, update: { value: layout } });
  console.log(JSON.stringify({ password: PASSWORD, master: `${TAG}-master` }));
}

async function main() {
  const mode = process.argv[2] ?? "check";
  await cleanup();
  if (mode === "cleanup") return;
  if (mode === "dashboard-setup") return dashboardSetup(process.argv[3]);

  await unitChecks();

  const passwordHash = await argon2.hash(PASSWORD);
  const exam = await prisma.exam.create({ data: { name: "QA Reviews Exam", code: "QA-REVIEWS" } });
  const reviewer = await makeStudent("reviewer", "ACTIVE", exam.id, true, passwordHash);
  const fresh = await makeStudent("fresh", "ACTIVE", exam.id, false, passwordHash);
  const approvedStudent = await makeStudent("approved", "ACTIVE", exam.id, true, passwordHash);
  const gone = await makeStudent("gone", "DELETED", exam.id, true, passwordHash);

  // --- DB-level provenance/publish rules ---------------------------------
  await rejects("DB: ADMIN_ADDED with a studentId is rejected", () =>
    prisma.review.create({ data: { source: "ADMIN_ADDED", status: "APPROVED", displayName: "X", rating: 5, comment: "c", studentId: fresh.id } })
  );
  await rejects("DB: STUDENT_SUBMITTED without a student is rejected", () =>
    prisma.review.create({ data: { source: "STUDENT_SUBMITTED", displayName: "X", rating: 5, comment: "c" } })
  );
  await rejects("DB: publishing a PENDING review is rejected", () =>
    prisma.review.create({ data: { source: "ADMIN_ADDED", status: "PENDING", isPublished: true, displayName: "X", rating: 5, comment: "c" } })
  );
  await rejects("DB: rating 0 is rejected", () => prisma.review.create({ data: { source: "ADMIN_ADDED", displayName: "X", rating: 0, comment: "c" } }));
  await rejects("DB: rating 6 is rejected", () => prisma.review.create({ data: { source: "ADMIN_ADDED", displayName: "X", rating: 6, comment: "c" } }));

  const now = new Date();
  const mk = (data: Parameters<typeof prisma.review.create>[0]["data"]) => prisma.review.create({ data, select: { id: true } });
  const adminFeatured = await mk({ source: "ADMIN_ADDED", status: "APPROVED", isPublished: true, isFeatured: true, displayOrder: 5, displayName: "Admin Featured", rating: 5, comment: "Manual featured testimonial.", approvedAt: now });
  await mk({ source: "ADMIN_ADDED", status: "APPROVED", isPublished: true, displayOrder: 1, displayName: "Admin Plain", rating: 4, comment: "Manual testimonial one.", examName: "QA Reviews Exam", approvedAt: now });
  await mk({ source: "ADMIN_ADDED", status: "APPROVED", isPublished: false, displayName: "Admin Hidden", rating: 5, comment: "Hidden testimonial.", approvedAt: now });
  const studentPublished = await mk({
    source: "STUDENT_SUBMITTED", status: "APPROVED", isPublished: true, displayOrder: 2, studentId: approvedStudent.id,
    displayName: "Qa A.", rating: 5, comment: "Genuine student review.", originalDisplayName: "Qa A.", originalRating: 5, originalComment: "Genuine student review.", approvedAt: now,
  });
  await mk({ source: "STUDENT_SUBMITTED", status: "APPROVED", isPublished: true, displayOrder: 0, studentId: gone.id, displayName: "Gone S.", rating: 5, comment: "Deleted account review." });
  await rejects("DB: trigger blocks converting a student review to ADMIN_ADDED", () =>
    prisma.review.update({ where: { id: studentPublished.id }, data: { source: "ADMIN_ADDED", studentId: null } })
  );
  await rejects("DB: trigger blocks moving a review to another student", () =>
    prisma.review.update({ where: { id: studentPublished.id }, data: { student: { connect: { id: fresh.id } } } })
  );

  // --- Public selection ----------------------------------------------------
  let { reviews } = await computeHomepageReviews();
  const names = reviews.map((r) => r.name);
  check("public: only approved + published, inactive student hidden", JSON.stringify([...names].sort()) === JSON.stringify(["Admin Featured", "Admin Plain", "Qa A."]), names);
  check("public: featured first, then display order", JSON.stringify(names) === JSON.stringify(["Admin Featured", "Admin Plain", "Qa A."]), names);
  check("public: Verified only on the student review", reviews.every((r) => r.verified === (r.name === "Qa A.")), reviews);
  check(
    "public: payload has only display fields (no ids/emails/student codes)",
    reviews.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(["comment", "exam", "key", "name", "rating", "verified"])) &&
      !JSON.stringify(reviews).match(/@|MTS|c[a-z0-9]{20,}/i)
  );
  check("public: exam shown", reviews.find((r) => r.name === "Admin Plain")?.exam === "QA Reviews Exam");

  await prisma.setting.create({
    data: { key: REVIEWS_SECTION_SETTING_KEY, value: { ...DEFAULT_REVIEWS_SECTION_SETTINGS, preferFeatured: false, showVerified: false, showExam: false, maxReviews: 2 } },
  });
  ({ reviews } = await computeHomepageReviews());
  check("settings: preferFeatured off -> display order only", JSON.stringify(reviews.map((r) => r.name)) === JSON.stringify(["Admin Plain", "Qa A."]), reviews.map((r) => r.name));
  check("settings: maxReviews respected", reviews.length === 2);
  check("settings: showVerified off hides badge", reviews.every((r) => !r.verified));
  check("settings: showExam off hides exam", reviews.every((r) => r.exam === null));
  await prisma.setting.update({ where: { key: REVIEWS_SECTION_SETTING_KEY }, data: { value: { ...DEFAULT_REVIEWS_SECTION_SETTINGS, enabled: false } } });
  const homepageOff = await computeHomepageReviews();
  check("settings: homepage off, dashboard on -> data still computed for the dashboard", homepageOff.reviews.length > 0 && !homepageOff.settings.enabled && homepageOff.settings.showOnDashboard);
  await prisma.setting.update({ where: { key: REVIEWS_SECTION_SETTING_KEY }, data: { value: { ...DEFAULT_REVIEWS_SECTION_SETTINGS, enabled: false, showOnDashboard: false } } });
  check("settings: both surfaces off -> no reviews", (await computeHomepageReviews()).reviews.length === 0);

  // Leave a clean state for the browser suite: no reviews, default settings.
  await prisma.review.deleteMany({});
  await prisma.setting.deleteMany({ where: { key: REVIEWS_SECTION_SETTING_KEY } });
  check("zero reviews -> nothing public", (await computeHomepageReviews()).reviews.length === 0);
  void adminFeatured;

  if (mode === "setup") {
    await createAdmins(passwordHash);
    console.log(
      JSON.stringify({
        password: PASSWORD,
        master: `${TAG}-master`,
        full: `${TAG}-full`,
        reviewer: reviewer.email,
        fresh: fresh.email,
        examName: exam.name,
      })
    );
  } else {
    await cleanup();
  }
  console.error(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
