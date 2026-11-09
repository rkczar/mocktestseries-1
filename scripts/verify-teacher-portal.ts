/**
 * Teacher Portal Phase A — server regression (docs/TEACHER-PORTAL.md).
 *
 *   DATABASE_URL=postgresql://…/mts_<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-teacher-portal.ts
 *
 * Synthetic data only (prefix TPA-); refuses to run outside an mts_* / scratch
 * database. Covers: role keys, teacher management (assign / revoke / suspend /
 * deactivate), exam scope + IDOR on every teacher operation, Draft create
 * (forced DRAFT, author, no image injection), Draft never served / never
 * attachable, shared editing between teachers of the same exam, publication
 * request → approval, revisions (live content untouched, shared revision,
 * stale refusal, approve applies exactly the proposal, attempt snapshots
 * unchanged), withdraw (own only), immediate Mock Test unpublish (future
 * attempts only; in-progress / submitted attempts, other tests and other exams
 * unchanged; exclusion survives builder rewrites; last-question guard), Live
 * CBT / Grand / Live / PYQ unpublish requests, restore, deletion request,
 * double-decision refusal, mandatory reasons and the audit trail.
 */
import "dotenv/config";
import { AttemptStatus, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";
import { startMockTestAttempt, submitAttempt } from "@/lib/test-attempt";
import { addQuestionsToMock, replaceQuestionInMock, writeAssignment, loadAssignment } from "@/lib/mock-test-questions";
import { teacherScope, type TeacherScope } from "@/lib/teacher/scope";
import { assignExam, createTeacher, revokeAssignment, setTeacherStatus } from "@/lib/teacher/manage";
import {
  createDraftQuestion,
  discardRevision,
  editVersion,
  requestDeletion,
  requestRestore,
  requestUnpublish,
  saveQuestionEdit,
  submitForPublication,
  submitRevision,
  unpublishFromMockTest,
  withdrawRequest,
} from "@/lib/teacher/content";
import { approveRequest, rejectRequest } from "@/lib/teacher/approvals";
import { createFixtureSubject } from "./fixture-taxonomy";

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (ok) passes++;
  else failures++;
}
const section = (t: string) => console.log(`\n== ${t}`);
const isErr = (r: { ok: boolean }, re?: RegExp) => !r.ok && (!re || re.test((r as unknown as { error: string }).error));

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const db = url.replace(/\?.*$/, "").split("/").pop() ?? "";
  if (!/^mts_/.test(db)) throw new Error(`Refusing to run outside a scratch mts_* database (got "${db}").`);
  const sfx = Date.now().toString(36);

  // ---------------------------------------------------------------- fixture
  const role = async (name: "MASTER_ADMIN" | "TEACHER" | "FULL_ADMIN") => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const masterRole = await role("MASTER_ADMIN");
  await role("TEACHER");
  const master = await prisma.adminUser.create({ data: { name: "TPA Master", username: `tpa-master-${sfx}`, passwordHash: "x", roleId: masterRole.id } });
  const M = master.id;

  const mkExam = (tag: string) => prisma.exam.create({ data: { name: `TPA ${tag} ${sfx}`, code: `TPA${tag}${sfx}`.toUpperCase(), isActive: true } });
  const examA = await mkExam("A");
  const examB = await mkExam("B");
  const examC = await mkExam("C");
  const subjA = await createFixtureSubject(prisma, { examId: examA.id, name: `TPA SubjA ${sfx}` });
  const subjB = await createFixtureSubject(prisma, { examId: examB.id, name: `TPA SubjB ${sfx}` });
  const subjC = await createFixtureSubject(prisma, { examId: examC.id, name: `TPA SubjC ${sfx}` });

  let qn = 0;
  const mkQ = async (examId: string, subjectId: string, status: QuestionStatus = "PUBLISHED") => {
    qn++;
    return prisma.question.create({
      data: {
        code: `TPA-${sfx}-${qn}`,
        examId,
        subjectId,
        text: `TPA question ${qn}`,
        status,
        options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `${label} of ${qn}`, isCorrect: label === "A", order })) },
      },
    });
  };
  const bankA = [];
  for (let i = 0; i < 6; i++) bankA.push(await mkQ(examA.id, subjA.id));
  const bankB = [await mkQ(examB.id, subjB.id), await mkQ(examB.id, subjB.id)];
  const draftSeed = await mkQ(examA.id, subjA.id, "DRAFT");
  const qC = await mkQ(examC.id, subjC.id);

  const mkMock = (examId: string, title: string, ids: string[], extra: Record<string, unknown> = {}) =>
    prisma.mockTest.create({ data: { examId, title: `TPA ${title} ${sfx}`, durationMinutes: 30, status: "PUBLISHED", ...extra, questions: { create: ids.map((questionId, order) => ({ questionId, order })) } } });
  const Q = bankA[0]; // the shared question
  const mockA1 = await mkMock(examA.id, "Mock A1", [Q.id, bankA[1].id, bankA[2].id, draftSeed.id]);
  const mockA2 = await mkMock(examA.id, "Mock A2", [Q.id, bankA[3].id]);
  const mockB = await mkMock(examB.id, "Mock B (cross-exam)", [Q.id, bankB[0].id, bankB[1].id]);
  const liveCbt = await mkMock(examA.id, "Live CBT", [Q.id, bankA[4].id], { enrollmentEnabled: true });
  const tiny = await mkMock(examA.id, "Tiny", [bankA[5].id]);
  const grand = await prisma.grandTest.create({ data: { examId: examA.id, title: `TPA Grand ${sfx}`, durationMinutes: 30, questionCount: 1, status: "PUBLISHED", questions: { create: [{ questionId: Q.id, order: 0 }] } } });
  const paper = await prisma.previousYearPaper.create({ data: { examId: examA.id, year: 2019, title: `TPA PYQ ${sfx}` } });
  await prisma.question.update({ where: { id: bankA[3].id }, data: { previousYearPaperId: paper.id, source: "PYQ" } });

  const students: string[] = [];
  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({ data: { studentId: `TPA${tag}-${sfx}`, name: `TPA ${tag}`, email: `tpa-${tag}-${sfx}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
    students.push(s.id);
    return s.id;
  };
  const S1 = await mkStudent("1");
  const S2 = await mkStudent("2");
  const S3 = await mkStudent("3");
  const S4 = await mkStudent("4");

  const form = (o: Record<string, string>) => {
    const fd = new FormData();
    const base: Record<string, string> = { examId: examA.id, subjectId: subjA.id, text: "TPA teacher question text", difficulty: "MEDIUM", questionType: "SINGLE_CORRECT", optionA: "Alpha", optionB: "Beta", optionC: "Gamma", optionD: "Delta", correctOption: "B" };
    for (const [k, v] of Object.entries({ ...base, ...o })) fd.set(k, v);
    return fd;
  };
  // Every editor save posts the version it was opened from (optimistic concurrency).
  const saveQ = async (sc: TeacherScope, id: string, fd: FormData) => {
    fd.set("baseVersion", await editVersion(id));
    return saveQuestionEdit(sc, id, fd);
  };
  const audits = async (entityId: string) => (await prisma.auditLog.findMany({ where: { entityId }, select: { action: true } })).map((a) => a.action);

  try {
    // ------------------------------------------------------------ A. role keys
    section("A. Role permissions");
    check("TEACHER holds only TEACHER_PORTAL", JSON.stringify(DEFAULT_ROLE_PERMISSIONS.TEACHER) === JSON.stringify([PERMISSIONS.TEACHER_PORTAL]));
    for (const k of [PERMISSIONS.EXAMS_MANAGE, PERMISSIONS.QUESTIONS_MANAGE, PERMISSIONS.TESTS_MANAGE, PERMISSIONS.TEST_SERIES_MANAGE, PERMISSIONS.SEO_INTEL_VIEW, PERMISSIONS.AI_IMPORTER_USE, PERMISSIONS.PAYMENTS_VIEW, PERMISSIONS.BACKUP_VIEW, PERMISSIONS.USERS_MANAGE, PERMISSIONS.STUDENTS_MANAGE]) {
      check(`TEACHER lacks ${k}`, !DEFAULT_ROLE_PERMISSIONS.TEACHER.includes(k));
    }
    check("FULL_ADMIN can view approvals, not decide or manage teachers", DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.TEACHER_APPROVALS_VIEW) && !DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.TEACHER_APPROVALS_MANAGE) && !DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.TEACHERS_MANAGE));
    check("MASTER_ADMIN holds every teacher key", [PERMISSIONS.TEACHERS_MANAGE, PERMISSIONS.TEACHER_APPROVALS_MANAGE, PERMISSIONS.TEACHER_APPROVALS_VIEW].every((k) => DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(k)));

    // ------------------------------------------------------------ B. management
    section("B. Teacher management");
    // Teacher Login: a registered mobile is required (unique, random per run).
    const testMobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    const mk = async (u: string) => {
      const r = await createTeacher(M, { name: `TPA Teacher ${u}`, username: `tpa-${u}-${sfx}`, email: "", password: "tpa-password-123", mobile: testMobile() });
      check(`create teacher ${u}`, r.ok, r);
      return (await prisma.adminUser.findUniqueOrThrow({ where: { username: `tpa-${u}-${sfx}` } })).id;
    };
    const t1 = await mk("t1");
    const t2 = await mk("t2");
    const t3 = await mk("t3");
    const tB = await mk("tb");
    check("duplicate username refused", !(await createTeacher(M, { name: "dup", username: `tpa-t1-${sfx}`, password: "tpa-password-123", mobile: testMobile() })).ok);
    check("short password refused", !(await createTeacher(M, { name: "x", username: `tpa-x-${sfx}`, password: "short", mobile: testMobile() })).ok);
    check("new teacher has empty scope", (await teacherScope(t1))?.examIds.length === 0);
    check("assign A to t1", (await assignExam(M, t1, examA.id)).ok);
    check("duplicate active assignment refused", !(await assignExam(M, t1, examA.id)).ok);
    check("assign A to t2", (await assignExam(M, t2, examA.id)).ok);
    check("assign C to t3", (await assignExam(M, t3, examC.id)).ok);
    check("assign B to tB", (await assignExam(M, tB, examB.id)).ok);
    check("assign B to t1 (to revoke)", (await assignExam(M, t1, examB.id)).ok);
    const revokeId = (await prisma.teacherExamAssignment.findFirstOrThrow({ where: { teacherId: t1, examId: examB.id, revokedAt: null } })).id;
    check("revoke B from t1", (await revokeAssignment(M, revokeId)).ok);
    const T1 = (await teacherScope(t1)) as TeacherScope;
    const T2 = (await teacherScope(t2)) as TeacherScope;
    const T3 = (await teacherScope(t3)) as TeacherScope;
    const TB = (await teacherScope(tB)) as TeacherScope;
    check("revoked exam leaves scope immediately", JSON.stringify(T1.examIds) === JSON.stringify([examA.id]), T1.examIds);
    check("re-assign after revoke allowed", (await assignExam(M, t1, examB.id)).ok && (await revokeAssignment(M, (await prisma.teacherExamAssignment.findFirstOrThrow({ where: { teacherId: t1, examId: examB.id, revokedAt: null } })).id)).ok);
    check("suspend t3", (await setTeacherStatus(M, t3, "SUSPENDED")).ok);
    check("suspended teacher has no scope", (await teacherScope(t3)) === null);
    const t3row = await prisma.adminUser.findUniqueOrThrow({ where: { id: t3 }, select: { isActive: true, sessionsValidAfter: true } });
    check("suspension signs the teacher out (sessionsValidAfter)", !!t3row.sessionsValidAfter && t3row.isActive);
    check("re-activate t3", (await setTeacherStatus(M, t3, "ACTIVE")).ok && (await teacherScope(t3)) !== null);
    check("a MASTER_ADMIN account is never a teacher scope", (await teacherScope(M)) === null);
    check("status of a non-teacher refused", !(await setTeacherStatus(M, M, "SUSPENDED")).ok);

    // ------------------------------------------------------------ C. Draft create
    section("C. Draft creation");
    const c1 = await createDraftQuestion(T1, form({ status: "PUBLISHED", source: "PYQ", previousYearPaperId: paper.id, reviewRequired: "on" }));
    check("teacher creates a question", c1.ok, c1);
    const newQ = c1.ok ? await prisma.question.findUniqueOrThrow({ where: { id: c1.questionId }, include: { options: true } }) : null;
    check("created as DRAFT even when the form says PUBLISHED", newQ?.status === "DRAFT");
    check("author recorded", newQ?.createdByAdminId === t1);
    check("source / PYQ link / review flag never taken from the teacher form", newQ?.source === "QUESTION_BANK" && newQ.previousYearPaperId === null && newQ.reviewRequired === false);
    check("answer key as posted (B)", newQ?.options.find((o) => o.isCorrect)?.label === "B");
    check("create in an unassigned exam refused", isErr(await createDraftQuestion(T1, form({ examId: examC.id, subjectId: subjC.id }))));
    check("create with an injected image URL refused", isErr(await createDraftQuestion(T1, form({ imageUrl: "/media/evil.png" })), /image/i));
    check("create with a subject of another exam refused", isErr(await createDraftQuestion(T1, form({ subjectId: subjC.id }))));
    check("create audit-logged", (await audits(newQ!.id)).includes("TEACHER_QUESTION_CREATED"));

    // ------------------------------------------------------------ D. Draft never served / attachable
    section("D. Drafts never reach students or tests");
    const a1 = await startMockTestAttempt(S1, mockA1.id);
    const a1Qs = await prisma.testAttemptQuestion.findMany({ where: { attemptId: a1.id }, select: { questionId: true } });
    check("a Draft already linked to a test is not served", !a1Qs.some((x) => x.questionId === draftSeed.id) && a1Qs.length === 3, a1Qs.length);
    const add = await addQuestionsToMock(mockA2.id, [newQ!.id, draftSeed.id]);
    check("builder refuses Draft questions", "added" in add && add.added === 0 && add.rejected === 2, add);
    const rep = await replaceQuestionInMock(mockA2.id, bankA[3].id, newQ!.id);
    check("replace refuses a Draft", "error" in rep);
    check("builder still adds a published question", (await addQuestionsToMock(mockA2.id, [bankA[2].id]).then((r) => "added" in r && r.added === 1)));

    // ------------------------------------------------------------ E. Scope / IDOR
    section("E. Exam scope (IDOR) — teacher of exam C against exam A ids");
    const before = await prisma.teacherContentRequest.count();
    check("view/edit question of another exam refused", isErr(await saveQ(T3, Q.id, form({}))));
    check("submit publication for another exam refused", isErr(await submitForPublication(T3, newQ!.id, "valid reason text")));
    check("revision submit for another exam refused", isErr(await submitRevision(T3, Q.id, "valid reason text")));
    check("delete request for another exam refused", isErr(await requestDeletion(T3, Q.id, "valid reason text")));
    check("unpublish from another exam's mock refused", isErr(await unpublishFromMockTest(T3, mockA1.id, Q.id, "valid reason text")));
    check("unpublish request for another exam's grand test refused", isErr(await requestUnpublish(T3, "GRAND_TEST", grand.id, Q.id, "valid reason text")));
    check("restore request for another exam refused", isErr(await requestRestore(T3, mockA1.id, Q.id, "valid reason text")));
    check("discard revision for another exam refused", isErr(await discardRevision(T3, Q.id)));
    check("unknown target kind refused", isErr(await requestUnpublish(T1, "EXAM", examA.id, Q.id, "valid reason text")));
    check("question not in the target refused", isErr(await requestUnpublish(T1, "GRAND_TEST", grand.id, bankA[1].id, "valid reason text")));
    check("own question of exam C still works for t3", (await saveQ(T3, qC.id, form({ examId: examC.id, subjectId: subjC.id }))).ok);
    check("nothing was written by refused calls", (await prisma.teacherContentRequest.count()) === before);

    // ------------------------------------------------------------ F. Shared editing
    section("F. Shared editing within an exam");
    const e2 = await saveQ(T2, newQ!.id, form({ text: "TPA edited by teacher 2" }));
    check("teacher 2 edits teacher 1's Draft directly", e2.ok && e2.outcome === "DRAFT_SAVED", e2);
    const afterEdit = await prisma.question.findUniqueOrThrow({ where: { id: newQ!.id } });
    check("Draft content updated, still DRAFT, author kept", afterEdit.text === "TPA edited by teacher 2" && afterEdit.status === "DRAFT" && afterEdit.createdByAdminId === t1);
    const editors = await prisma.auditLog.findMany({ where: { entityId: newQ!.id }, select: { actorId: true } });
    check("history records both teachers", new Set(editors.map((e) => e.actorId)).size === 2);
    check("Draft edit cannot change status via the form", (await saveQ(T1, newQ!.id, form({ text: "TPA edited by teacher 2", status: "PUBLISHED" }))).ok && (await prisma.question.findUniqueOrThrow({ where: { id: newQ!.id } })).status === "DRAFT");

    // ------------------------------------------------------------ G. Publication request
    section("G. Publication request");
    check("reason is mandatory", isErr(await submitForPublication(T1, newQ!.id, "short"), /reason/i));
    await prisma.question.update({ where: { id: newQ!.id }, data: { reviewRequired: true } });
    check("publishing policy checked before submitting", isErr(await submitForPublication(T1, newQ!.id, "ready for students now"), /review/i));
    await prisma.question.update({ where: { id: newQ!.id }, data: { reviewRequired: false } });
    const pub = await submitForPublication(T1, newQ!.id, "ready for students now");
    check("submitted", pub.ok, pub);
    check("second submission refused", isErr(await submitForPublication(T2, newQ!.id, "ready for students now")));
    check("Draft locked while waiting", isErr(await saveQ(T2, newQ!.id, form({})), /withdraw/i));
    check("teacher 2 cannot withdraw teacher 1's request", isErr(await withdrawRequest(T2, pub.ok ? pub.requestId : "")));
    check("still DRAFT before approval", (await prisma.question.findUniqueOrThrow({ where: { id: newQ!.id } })).status === "DRAFT");
    const ap = await approveRequest(M, pub.ok ? pub.requestId : "", "");
    check("Master Admin approves → PUBLISHED", ap.ok && (await prisma.question.findUniqueOrThrow({ where: { id: newQ!.id } })).status === "PUBLISHED", ap);
    check("double approval refused", !(await approveRequest(M, pub.ok ? pub.requestId : "")).ok);

    // ------------------------------------------------------------ H. Revisions
    section("H. Revisions of published questions");
    const liveBefore = await prisma.question.findUniqueOrThrow({ where: { id: Q.id }, include: { options: { orderBy: { label: "asc" } } } });
    const s2attempt = await startMockTestAttempt(S2, mockA2.id); // started BEFORE the revision is approved
    const r1 = await saveQ(T1, Q.id, form({ text: "TPA revised stem", correctOption: "C" }));
    check("edit of PUBLISHED creates a revision", r1.ok && r1.outcome === "REVISION_SAVED", r1);
    const liveAfterSave = await prisma.question.findUniqueOrThrow({ where: { id: Q.id }, include: { options: { orderBy: { label: "asc" } } } });
    check("live question untouched by the revision", liveAfterSave.text === liveBefore.text && liveAfterSave.options.find((o) => o.isCorrect)?.label === "A");
    const r2 = await saveQ(T2, Q.id, form({ text: "TPA revised stem v2", correctOption: "C" }));
    const rev = await prisma.questionRevision.findFirstOrThrow({ where: { questionId: Q.id, status: "DRAFT" } });
    check("teacher 2 continues the same revision", r2.ok && rev.authorId === t1 && rev.lastEditedById === t2);
    check("only one open revision per question", (await prisma.questionRevision.count({ where: { questionId: Q.id, status: { in: ["DRAFT", "SUBMITTED"] } } })) === 1);
    check("revision reason mandatory", isErr(await submitRevision(T1, Q.id, "")));
    const sr = await submitRevision(T1, Q.id, "fix the answer key, C is correct");
    check("revision submitted", sr.ok, sr);
    check("edits blocked while submitted", isErr(await saveQ(T2, Q.id, form({})), /waiting/i));
    // Admin changes the live question meanwhile → the revision is stale.
    await prisma.question.update({ where: { id: Q.id }, data: { text: "TPA admin hotfix" } });
    const stale = await approveRequest(M, sr.ok ? sr.requestId : "");
    check("approval refused for a stale revision", !stale.ok && /changed/i.test((stale as { error: string }).error), stale);
    check("stale revision closed, request rejected, live unchanged", (await prisma.questionRevision.findUniqueOrThrow({ where: { id: rev.id } })).status === "STALE" && (await prisma.teacherContentRequest.findUniqueOrThrow({ where: { id: sr.ok ? sr.requestId : "" } })).status === "REJECTED" && (await prisma.question.findUniqueOrThrow({ where: { id: Q.id } })).text === "TPA admin hotfix");
    const r3 = await saveQ(T1, Q.id, form({ text: "TPA revised stem v3", correctOption: "C" }));
    check("a fresh revision can start from the new live version", r3.ok, r3);
    const sr2 = await submitRevision(T1, Q.id, "fix the answer key, C is correct");
    const w = await withdrawRequest(T1, sr2.ok ? sr2.requestId : "");
    check("withdrawing a revision request reopens the draft", w.ok && (await prisma.questionRevision.count({ where: { questionId: Q.id, status: "DRAFT" } })) === 1);
    const sr3 = await submitRevision(T2, Q.id, "fix the answer key, C is correct");
    check("teacher 2 can submit the shared revision", sr3.ok, sr3);
    const ok3 = await approveRequest(M, sr3.ok ? sr3.requestId : "", "looks right");
    const live3 = await prisma.question.findUniqueOrThrow({ where: { id: Q.id }, include: { options: { orderBy: { label: "asc" } } } });
    check("approval applies exactly the proposal", ok3.ok && live3.text === "TPA revised stem v3" && live3.options.find((o) => o.isCorrect)?.label === "C" && live3.options.map((o) => o.text).join() === "Alpha,Beta,Gamma,Delta", ok3);
    check("status / source / author of the live question unchanged", live3.status === "PUBLISHED" && live3.source === liveBefore.source && live3.createdByAdminId === liveBefore.createdByAdminId);
    const snap = await prisma.testAttemptQuestion.findFirstOrThrow({ where: { attemptId: s2attempt.id, questionId: Q.id } });
    check("attempt started before approval keeps the old snapshot", JSON.stringify(snap.questionSnapshot).includes(liveBefore.text) && !JSON.stringify(snap.questionSnapshot).includes("TPA revised stem v3"));
    check("approval audit links the revision", (await prisma.auditLog.count({ where: { entityId: Q.id, action: "QUESTION_UPDATED", actorId: M } })) === 1);
    const r4 = await saveQ(T1, Q.id, form({ text: "TPA to be rejected", correctOption: "C" }));
    const sr4 = await submitRevision(T1, Q.id, "another change for review");
    check("reject needs a note", r4.ok && !(await rejectRequest(M, sr4.ok ? sr4.requestId : "", "")).ok);
    check("reject leaves the live question unchanged", (await rejectRequest(M, sr4.ok ? sr4.requestId : "", "not needed")).ok && (await prisma.question.findUniqueOrThrow({ where: { id: Q.id } })).text === "TPA revised stem v3");
    check("discard a draft revision", (await saveQ(T1, Q.id, form({ text: "TPA discard me", correctOption: "C" }))).ok && (await discardRevision(T1, Q.id)).ok);

    // ------------------------------------------------------------ I. Unpublish (Mock Test)
    section("I. Immediate unpublish from a Mock Test");
    const inProg = await startMockTestAttempt(S3, mockA1.id); // in progress before the unpublish
    const s1Submitted = await submitAttempt(a1.id, S1); // submitted before
    const scoreBefore = await prisma.testAttempt.findUniqueOrThrow({ where: { id: a1.id }, select: { score: true, totalQuestions: true } });
    check("reason mandatory", isErr(await unpublishFromMockTest(T1, mockA1.id, Q.id, "no")));
    const un = await unpublishFromMockTest(T1, mockA1.id, Q.id, "wrong answer key in this paper");
    check("unpublished", un.ok, un);
    const notice = un.ok ? await prisma.teacherContentRequest.findUniqueOrThrow({ where: { id: un.requestId } }) : null;
    const impact = notice?.impact as { submittedAttempts: number; inProgressAttempts: number; servableQuestionsBefore: number } | null;
    check("Master Admin notified (open notice with impact)", notice?.type === "UNPUBLISH_NOTICE" && notice.status === "OPEN" && impact?.submittedAttempts === 1 && impact.inProgressAttempts === 1 && impact.servableQuestionsBefore === 3, impact);
    check("second unpublish refused", isErr(await unpublishFromMockTest(T2, mockA1.id, Q.id, "wrong answer key in this paper")));
    const fresh = await startMockTestAttempt(S4, mockA1.id);
    const freshQs = await prisma.testAttemptQuestion.findMany({ where: { attemptId: fresh.id }, select: { questionId: true } });
    check("new attempt skips the question", !freshQs.some((x) => x.questionId === Q.id) && freshQs.length === 2, freshQs.length);
    const resumed = await startMockTestAttempt(S3, mockA1.id);
    const resumedQs = await prisma.testAttemptQuestion.count({ where: { attemptId: inProg.id, questionId: Q.id } });
    check("in-progress attempt resumes unchanged (still has the question)", resumed.id === inProg.id && resumedQs === 1);
    const scoreAfter = await prisma.testAttempt.findUniqueOrThrow({ where: { id: a1.id }, select: { score: true, totalQuestions: true, status: true } });
    check("submitted attempt and its result unchanged", s1Submitted !== undefined && scoreAfter.status === AttemptStatus.SUBMITTED && scoreAfter.score === scoreBefore.score && scoreAfter.totalQuestions === scoreBefore.totalQuestions);
    const otherMock = await startMockTestAttempt(S4, mockA2.id);
    check("same question still served in another test of the same exam", (await prisma.testAttemptQuestion.count({ where: { attemptId: otherMock.id, questionId: Q.id } })) === 1);
    const crossB = await startMockTestAttempt(S4, mockB.id);
    check("same question still served in another exam's test", (await prisma.testAttemptQuestion.count({ where: { attemptId: crossB.id, questionId: Q.id } })) === 1);
    check("question itself still PUBLISHED", (await prisma.question.findUniqueOrThrow({ where: { id: Q.id } })).status === "PUBLISHED");
    // builder rewrites keep the exclusion
    const cur = await loadAssignment(mockA1.id);
    await writeAssignment(mockA1.id, [...cur!.ids].reverse());
    const kept = await prisma.mockTestQuestion.findUniqueOrThrow({ where: { mockTestId_questionId: { mockTestId: mockA1.id, questionId: Q.id } } });
    check("reorder keeps the unpublish (who/why/when)", !!kept.excludedAt && kept.excludedById === t1 && kept.excludedReason === "wrong answer key in this paper");
    await addQuestionsToMock(mockA1.id, [bankA[5].id]);
    check("add keeps the unpublish", !!(await prisma.mockTestQuestion.findUniqueOrThrow({ where: { mockTestId_questionId: { mockTestId: mockA1.id, questionId: Q.id } } })).excludedAt);
    check("last servable question of a published test cannot be unpublished", isErr(await unpublishFromMockTest(T1, tiny.id, bankA[5].id, "trying to empty the test"), /last/i));
    check("Live CBT refuses an immediate unpublish", isErr(await unpublishFromMockTest(T1, liveCbt.id, Q.id, "wrong answer key in this paper"), /Live CBT/));
    // cross-exam: teacher of exam B can pull exam A's question from B's mock, but cannot open the question
    const unB = await unpublishFromMockTest(TB, mockB.id, Q.id, "not part of our syllabus");
    check("teacher of exam B unpublishes a reused exam-A question from B's mock", unB.ok, unB);
    check("…but cannot edit that question", isErr(await saveQ(TB, Q.id, form({ examId: examB.id, subjectId: subjB.id }))));
    check("exam-A mock A2 unaffected by B's unpublish", (await prisma.mockTestQuestion.findUniqueOrThrow({ where: { mockTestId_questionId: { mockTestId: mockA2.id, questionId: Q.id } } })).excludedAt === null);

    // ------------------------------------------------------------ J. Restore
    section("J. Restore");
    const rr = await requestRestore(T2, mockA1.id, Q.id, "answer key corrected now");
    check("restore request", rr.ok, rr);
    check("duplicate restore request refused", isErr(await requestRestore(T1, mockA1.id, Q.id, "answer key corrected now")));
    check("approve restore → back for new attempts", (await approveRequest(M, rr.ok ? rr.requestId : "")).ok && (await prisma.mockTestQuestion.findUniqueOrThrow({ where: { mockTestId_questionId: { mockTestId: mockA1.id, questionId: Q.id } } })).excludedAt === null);
    check("notice can still be acknowledged", (await approveRequest(M, un.ok ? un.requestId : "", "seen")).ok);
    const bNotice = unB.ok ? unB.requestId : "";
    check("Restore from the notice (reject) clears the exclusion", (await rejectRequest(M, bNotice)).ok && (await prisma.mockTestQuestion.findUniqueOrThrow({ where: { mockTestId_questionId: { mockTestId: mockB.id, questionId: Q.id } } })).excludedAt === null);
    check("notice cannot be withdrawn by the teacher", isErr(await withdrawRequest(T1, un.ok ? un.requestId : "")));

    // ------------------------------------------------------------ K. Requests that wait for approval
    section("K. Live CBT / Grand / PYQ unpublish requests");
    const lr = await requestUnpublish(T1, "MOCK_TEST", liveCbt.id, Q.id, "remove from the live exam");
    check("Live CBT unpublish request", lr.ok, lr);
    check("nothing changes before approval", (await prisma.mockTestQuestion.findUniqueOrThrow({ where: { mockTestId_questionId: { mockTestId: liveCbt.id, questionId: Q.id } } })).excludedAt === null);
    check("approval unpublishes it from the Live CBT", (await approveRequest(M, lr.ok ? lr.requestId : "")).ok && (await prisma.mockTestQuestion.findUniqueOrThrow({ where: { mockTestId_questionId: { mockTestId: liveCbt.id, questionId: Q.id } } })).excludedAt !== null);
    check("immediate-type mock refuses the request path", isErr(await requestUnpublish(T1, "MOCK_TEST", mockA2.id, Q.id, "remove from the mock please")));
    const gr = await requestUnpublish(T1, "GRAND_TEST", grand.id, Q.id, "remove from grand test");
    const pr = await requestUnpublish(T1, "PYQ_PAPER", paper.id, bankA[3].id, "remove from the PYQ paper");
    check("Grand Test and PYQ requests created", gr.ok && pr.ok, [gr, pr]);
    check("approving them records the decision without changing content", (await approveRequest(M, gr.ok ? gr.requestId : "")).ok && (await prisma.grandTestQuestion.count({ where: { grandTestId: grand.id, questionId: Q.id } })) === 1);

    // ------------------------------------------------------------ L. Deletion request
    section("L. Deletion request");
    check("reason mandatory", isErr(await requestDeletion(T1, bankA[1].id, "")));
    const dr = await requestDeletion(T1, bankA[1].id, "duplicate of another question");
    check("deletion request", dr.ok, dr);
    check("duplicate request refused", isErr(await requestDeletion(T2, bankA[1].id, "duplicate of another question")));
    check("approval never deletes by itself", (await approveRequest(M, dr.ok ? dr.requestId : "")).ok && (await prisma.question.count({ where: { id: bankA[1].id, status: "PUBLISHED" } })) === 1);

    // ------------------------------------------------------------ M. Suspended teacher / audit / DB rules
    section("M. Suspension, audit trail, database rules");
    await setTeacherStatus(M, t2, "DEACTIVATED");
    check("deactivated teacher: no scope, account off", (await teacherScope(t2)) === null && !(await prisma.adminUser.findUniqueOrThrow({ where: { id: t2 } })).isActive);
    const reqs = await prisma.teacherContentRequest.findMany({ where: { teacherId: { in: [t1, t2, tB] } }, select: { id: true, status: true } });
    let audited = true;
    for (const r of reqs) {
      const a = await audits(r.id);
      if (!a.some((x) => x.startsWith("TEACHER_REQUEST_"))) audited = false;
      if (r.status !== "OPEN" && !a.some((x) => /APPROVED|REJECTED|WITHDRAWN|RESTORED|STALE/.test(x))) audited = false;
    }
    check(`every request (${reqs.length}) has creation + decision audit entries`, audited);
    let dbRule = false;
    try {
      await prisma.teacherContentRequest.create({ data: { type: "DELETE_REQUEST", teacherId: t1, examId: examA.id, reason: "   " } });
    } catch {
      dbRule = true;
    }
    check("database refuses an empty reason", dbRule);
    let exRule = false;
    try {
      await prisma.mockTestQuestion.update({ where: { mockTestId_questionId: { mockTestId: mockA2.id, questionId: Q.id } }, data: { excludedAt: new Date() } });
    } catch {
      exRule = true;
    }
    check("database refuses an exclusion without who/why", exRule);
    const activeExclusions = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "MockTestQuestion" WHERE "excludedAt" IS NOT NULL`;
    check("rollback pre-check query works (active exclusions listed)", Number(activeExclusions[0].n) >= 1);
  } finally {
    // ---------------------------------------------------------- cleanup (synthetic rows only)
    const exams = [examA.id, examB.id, examC.id];
    const teachers = (await prisma.adminUser.findMany({ where: { username: { endsWith: `-${sfx}` } }, select: { id: true } })).map((u) => u.id);
    await prisma.teacherContentRequest.deleteMany({ where: { examId: { in: exams } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: students } } });
    await prisma.mockTest.deleteMany({ where: { examId: { in: exams } } });
    await prisma.grandTest.deleteMany({ where: { examId: { in: exams } } });
    await prisma.question.deleteMany({ where: { examId: { in: exams } } });
    await prisma.previousYearPaper.deleteMany({ where: { examId: { in: exams } } });
    await prisma.student.deleteMany({ where: { id: { in: students } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [...teachers] } } });
    await prisma.auditLog.deleteMany({ where: { actorId: M } });
    await prisma.teacherExamAssignment.deleteMany({ where: { teacherId: { in: teachers } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: teachers } } });
    const { deleteFixtureTaxonomy } = await import("./fixture-taxonomy");
    await deleteFixtureTaxonomy(prisma, exams);
    await prisma.exam.deleteMany({ where: { id: { in: exams } } });
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
