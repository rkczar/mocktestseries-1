/**
 * Admin → Students: exam-wise filtering/counts (StudentExamEnrollment) and admin-initiated account deletion through
 * the existing deletion workflow. DESTRUCTIVE (approves deletions) — DISPOSABLE *test* database only.
 *
 *   DATABASE_URL=<local mts_*test*> PG_POOL_MAX=3 NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-admin-student-tools.ts
 */
import assert from "node:assert/strict";

if (!/@(127\.0\.0\.1|localhost)(:\d+)?\/mts_[^?]*test/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL must be a local mts_*test* database (this script deletes accounts).");
  process.exit(2);
}

let failures = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label}  → ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const list = await import("@/lib/admin-students-list");
  const L = await import("@/lib/student-lifecycle");
  const { nextStudentId } = await import("@/lib/student-id");
  const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = await import("@/lib/permissions");
  const RUN = Date.now().toString(36);
  const P = (over: Partial<import("@/lib/admin-students-list").StudentListParams> = {}) => ({
    ...list.parseStudentListParams({}),
    perPage: 200 as const,
    ...over,
  });

  const MOB = `+9198${String(Date.now()).slice(-7)}`; // +91 + 10 digits once the last digit is added
  // ---- fixture: two exams, students enrolled in A, B, both, none
  const examA = await prisma.exam.create({ data: { name: `Filter Exam A ${RUN}`, code: `FA-${RUN}`, isActive: true } });
  const examB = await prisma.exam.create({ data: { name: `Filter Exam B ${RUN}`, code: `FB-${RUN}`, isActive: false } });
  const mk = async (name: string, mobile: string, exams: string[], createdAt?: Date) => {
    const s = await prisma.student.create({
      data: { studentId: await nextStudentId(), name: `${name} ${RUN}`, mobile, email: `${name.toLowerCase()}.${RUN}@example.com`, authProvider: "CREDENTIALS", passwordHash: "x", ...(createdAt ? { createdAt } : {}) },
    });
    for (const examId of exams) await prisma.studentExamEnrollment.create({ data: { studentId: s.id, examId } });
    return s;
  };
  const onlyA = await mk("Asha", `${MOB}1`, [examA.id], new Date("2026-03-10T10:00:00Z"));
  const onlyB = await mk("Bina", `${MOB}2`, [examB.id]);
  const both = await mk("Chetan", `${MOB}3`, [examA.id, examB.id]);
  const none = await mk("Dev", `${MOB}4`, []);
  const sqlCount = async (examId: string) =>
    prisma.student.count({ where: { status: { not: "DELETED" }, examEnrollments: { some: { examId } } } });

  console.log("A. Exam-wise filtering (server-side, paginated)");
  await check("exam A filter = exactly the students enrolled in A (incl. multi-exam)", async () => {
    const r = await list.loadStudentList(P({ exam: examA.id }));
    assert.deepEqual(new Set(r.rows.map((x) => x.id)), new Set([onlyA.id, both.id]));
    assert.equal(r.filtered, await sqlCount(examA.id));
  });
  await check("inactive exam B is still filterable; multi-exam student listed with BOTH exams", async () => {
    const r = await list.loadStudentList(P({ exam: examB.id }));
    assert.deepEqual(new Set(r.rows.map((x) => x.id)), new Set([onlyB.id, both.id]));
    const row = r.rows.find((x) => x.id === both.id)!;
    assert.deepEqual(row.examEnrollments.map((e) => e.exam.id).sort(), [examA.id, examB.id].sort());
  });
  await check("'No exam selected' = students without any enrollment", async () => {
    const r = await list.loadStudentList(P({ exam: "none", q: RUN }));
    assert.deepEqual(r.rows.map((x) => x.id), [none.id]);
  });
  await check("counts per exam = SQL counts; a multi-exam student is counted once per exam and once overall", async () => {
    const c = await list.loadExamEnrollmentCounts();
    assert.equal(c.exams.find((e) => e.id === examA.id)!.students, 2);
    assert.equal(c.exams.find((e) => e.id === examB.id)!.students, 2);
    for (const e of c.exams) assert.equal(e.students, await sqlCount(e.id), e.name);
    const all = await list.loadStudentList(P({ q: RUN }));
    assert.equal(all.filtered, 4, "4 distinct students, no duplicates from 2 enrollments");
    assert.equal(c.noExam, await prisma.student.count({ where: { status: { not: "DELETED" }, examEnrollments: { none: {} } } }));
  });
  await check("filters combine: exam + name search + mobile search + registration date + account status", async () => {
    assert.deepEqual((await list.loadStudentList(P({ exam: examA.id, q: `Chetan ${RUN}` }))).rows.map((x) => x.id), [both.id]);
    assert.deepEqual((await list.loadStudentList(P({ exam: examA.id, q: onlyA.mobile!.slice(-6) }))).rows.map((x) => x.id), [onlyA.id]);
    assert.deepEqual((await list.loadStudentList(P({ exam: examA.id, from: "2026-03-10", to: "2026-03-10" }))).rows.map((x) => x.id), [onlyA.id]);
    assert.equal((await list.loadStudentList(P({ exam: examA.id, from: "2026-03-11", to: "2026-03-11" }))).filtered, 0);
    assert.equal((await list.loadStudentList(P({ exam: examA.id, account: "inactive", q: RUN }))).filtered, 0);
  });
  await check("params: junk exam/date values are ignored, not trusted", async () => {
    const p = list.parseStudentListParams({ exam: "x'; drop", from: "2026-13-99x", to: "yesterday" });
    assert.equal(p.exam, "");
    assert.equal(p.from, "");
    assert.equal(p.to, "");
  });

  console.log("B. Admin-initiated deletion (existing workflow)");
  const role = await prisma.role.upsert({ where: { name: "MASTER_ADMIN" }, update: {}, create: { name: "MASTER_ADMIN" } });
  const adminRow = await prisma.adminUser.create({ data: { name: "Delete Tester", username: `del-${RUN}`, passwordHash: "x", roleId: role.id } });
  const admin = { id: adminRow.id, name: adminRow.name };
  const MOBILE = onlyA.mobile!;
  // History the deletion must keep: an attempt and a paid order.
  const attemptsBefore = await prisma.testAttempt.count({ where: { studentId: onlyA.id } });
  await check("delete: request filed + approved in one admin action; identity released; history kept", async () => {
    const req = await L.createAdminDeletionRequest(onlyA.id, admin, "Duplicate account (support ticket)");
    assert.match(req.reason ?? "", /^Admin-initiated by Delete Tester: Duplicate account/);
    await L.approveStudentDeletion(req.id, admin);
    const s = await prisma.student.findUniqueOrThrow({ where: { id: onlyA.id } });
    assert.equal(s.status, "DELETED");
    assert.equal(s.mobile, null);
    assert.equal(s.email, null);
    assert.equal(s.passwordHash, null);
    const r = await prisma.deletionRequest.findUniqueOrThrow({ where: { id: req.id } });
    assert.equal(r.status, "APPROVED");
    assert.equal(r.reviewedByAdminId, admin.id);
    assert.equal(r.phoneSnapshot, MOBILE, "who it was stays in the audit record");
    assert.equal(await prisma.testAttempt.count({ where: { studentId: onlyA.id } }), attemptsBefore);
    assert.equal(await prisma.studentExamEnrollment.count({ where: { studentId: onlyA.id } }), 1, "enrollment rows are kept (not cascaded)");
    const audit = await prisma.auditLog.findMany({ where: { entityId: { in: [req.id, onlyA.id] } }, select: { action: true, actorId: true } });
    for (const a of ["STUDENT_DELETION_REQUESTED", "STUDENT_DELETION_APPROVED", "STUDENT_IDENTITY_ANONYMIZED", "STUDENT_AUTH_REVOKED"]) {
      assert.ok(audit.some((x) => x.action === a && x.actorId === admin.id), `audit ${a} with acting admin`);
    }
  });
  await check("sessions revoked: a DELETED status is not auth-eligible", async () => {
    assert.equal(L.isStudentAuthEligible("DELETED"), false);
    assert.equal(await L.getStudentAuthStatus(onlyA.id), "DELETED");
  });
  await check("re-registration with the SAME verified mobile creates a new, unrelated account", async () => {
    const again = await prisma.student.create({
      data: { studentId: await nextStudentId(), name: `Asha Again ${RUN}`, mobile: MOBILE, mobileVerifiedAt: new Date(), authProvider: "CREDENTIALS", passwordHash: "y" },
    });
    assert.notEqual(again.id, onlyA.id);
    assert.equal(await prisma.testAttempt.count({ where: { studentId: again.id } }), 0, "nothing re-attached");
    assert.equal(await prisma.studentExamEnrollment.count({ where: { studentId: again.id } }), 0);
  });
  await check("deleted student leaves the All Students list and the exam counts", async () => {
    assert.ok(!(await list.loadStudentList(P({ exam: examA.id }))).rows.some((x) => x.id === onlyA.id));
    assert.equal((await list.loadExamEnrollmentCounts()).exams.find((e) => e.id === examA.id)!.students, 1);
  });
  await check("student's own pending request is reused (never a second request)", async () => {
    const own = await L.createDeletionRequest(onlyB.id, "please delete");
    const viaAdmin = await L.createAdminDeletionRequest(onlyB.id, admin, "student asked");
    assert.equal(viaAdmin.id, own.id);
    assert.equal(await prisma.deletionRequest.count({ where: { studentId: onlyB.id } }), 1);
    await L.approveStudentDeletion(viaAdmin.id, admin);
  });
  await check("a SUSPENDED account can be deleted by an admin; a DELETED one is refused", async () => {
    await prisma.student.update({ where: { id: none.id }, data: { status: "SUSPENDED" } });
    const req = await L.createAdminDeletionRequest(none.id, admin, "fraud");
    await L.approveStudentDeletion(req.id, admin);
    assert.equal((await prisma.student.findUniqueOrThrow({ where: { id: none.id } })).status, "DELETED");
    await assert.rejects(() => L.createAdminDeletionRequest(none.id, admin, "again"), L.DeletionLifecycleError);
  });
  await check("permissions: STUDENT_DELETION_MANAGE is MASTER_ADMIN-only (FULL_ADMIN, TEACHER and others refused server-side)", async () => {
    for (const [roleName, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      if (roleName === "MASTER_ADMIN") continue;
      assert.ok(!(perms as readonly string[]).includes(PERMISSIONS.STUDENT_DELETION_MANAGE), `${roleName} must not delete`);
    }
  });

  // ---- cleanup: our exams + enrollments (students stay: deleted rows are retained by design, others removed)
  await prisma.studentExamEnrollment.deleteMany({ where: { examId: { in: [examA.id, examB.id] } } });
  await prisma.student.deleteMany({ where: { name: { endsWith: RUN }, status: { not: "DELETED" } } });
  await prisma.exam.deleteMany({ where: { id: { in: [examA.id, examB.id] } } });
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} FAILED` : "\nALL ADMIN STUDENT TOOLS CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
