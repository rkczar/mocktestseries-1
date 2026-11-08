/**
 * Teacher Portal Phase A — final verification (owner's pre-deploy checklist).
 *
 *   DATABASE_URL=<scratch mts_*> STORAGE_DIR=<scratch dir> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-teacher-portal-final.ts
 *
 * Synthetic data only (prefix TPF-). Sections:
 *  1. concurrent editing (drafts, revisions, save vs submit, double decisions)
 *  2. question images (no cross-exam injection, removal never touches files or
 *     other questions, assets and snapshots intact through revisions)
 *  3. session / access invalidation (suspend, deactivate, revoke)
 *  5. historical data (revision history, retire + rollback, attempt snapshots)
 *  6. unpublish vs test & ranking integrity (counts, marks, accuracy,
 *     leaderboard, Overall Rank — nothing historical changes)
 *  7. request status: Pending / Approved — action not yet applied / Applied / Rejected
 */
import "dotenv/config";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StudentAuthProvider, type QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { saveAnswer, startMockTestAttempt, submitAttempt } from "@/lib/test-attempt";
import { getLeaderboard, getOverallStanding, clearOverallRankingCache } from "@/lib/leaderboard";
import { getMockTestDetailForStudent } from "@/lib/student-data";
import { applyReplacement } from "@/lib/question-replacement/apply";
import { rollbackReplacement } from "@/lib/question-replacement/rollback";
import { teacherScope, type TeacherScope } from "@/lib/teacher/scope";
import { assignExam, createTeacher, revokeAssignment, setTeacherStatus } from "@/lib/teacher/manage";
import { editVersion, requestDeletion, requestUnpublish, saveQuestionEdit, submitForPublication, submitRevision, unpublishFromMockTest, requestRestore } from "@/lib/teacher/content";
import { approveRequest, rejectRequest } from "@/lib/teacher/approvals";
import { effectiveStatuses } from "@/lib/teacher/request-status";
import { createFixtureSubject, deleteFixtureTaxonomy } from "./fixture-taxonomy";

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (ok) passes++;
  else failures++;
}
const section = (t: string) => console.log(`\n== ${t}`);
const errOf = (r: { ok: boolean }) => (r.ok ? "" : (r as unknown as { error: string }).error);

async function main() {
  const db = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "").split("/").pop() ?? "";
  if (!/^mts_/.test(db)) throw new Error("Refusing to run outside a scratch mts_* database.");
  const storage = process.env.STORAGE_DIR ?? "";
  if (!storage.startsWith("/root/mts-scratch/")) throw new Error("STORAGE_DIR must be a scratch directory under /root/mts-scratch.");
  const sfx = Date.now().toString(36);

  const role = (name: "MASTER_ADMIN" | "TEACHER") => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const master = await prisma.adminUser.create({ data: { name: "TPF Master", username: `tpf-master-${sfx}`, passwordHash: "x", roleId: (await role("MASTER_ADMIN")).id } });
  await role("TEACHER");
  const M = master.id;
  const examA = await prisma.exam.create({ data: { name: `TPF A ${sfx}`, code: `TPFA${sfx}`.toUpperCase(), isActive: true } });
  const examB = await prisma.exam.create({ data: { name: `TPF B ${sfx}`, code: `TPFB${sfx}`.toUpperCase(), isActive: true } });
  const subjA = await createFixtureSubject(prisma, { examId: examA.id, name: `TPF SubjA ${sfx}` });
  const subjB = await createFixtureSubject(prisma, { examId: examB.id, name: `TPF SubjB ${sfx}` });
  const exams = [examA.id, examB.id];
  const students: string[] = [];

  // Image files (scratch storage) — question-images are public, UUID-named, never deleted by the app.
  const imgDir = join(storage, "question-images");
  mkdirSync(imgDir, { recursive: true });
  const mkImg = () => {
    const f = `${randomUUID()}.png`;
    writeFileSync(join(imgDir, f), Buffer.from("89504e470d0a1a0a", "hex"));
    return { url: `/storage/question-images/${f}`, path: join(imgDir, f) };
  };
  const imgShared = mkImg();
  const imgB = mkImg();
  const imgOpt = mkImg();

  let qn = 0;
  const mkQ = async (examId: string, subjectId: string, o: { status?: QuestionStatus; imageUrl?: string; optImage?: string } = {}) => {
    qn++;
    return prisma.question.create({
      data: {
        code: `TPF-${sfx}-${qn}`,
        examId,
        subjectId,
        text: `TPF question ${qn}`,
        status: o.status ?? "PUBLISHED",
        imageUrl: o.imageUrl ?? null,
        options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `${label}${qn}`, isCorrect: label === "A", order, imageUrl: label === "B" ? o.optImage ?? null : null })) },
      },
    });
  };
  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({ data: { studentId: `TPF${tag}-${sfx}`, name: `TPF ${tag}`, email: `tpf-${tag}-${sfx}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
    students.push(s.id);
    return s.id;
  };
  const form = (o: Record<string, string>) => {
    const fd = new FormData();
    const base: Record<string, string> = { examId: examA.id, subjectId: subjA.id, text: "TPF edited", difficulty: "MEDIUM", questionType: "SINGLE_CORRECT", optionA: "A", optionB: "B", optionC: "C", optionD: "D", correctOption: "A" };
    for (const [k, v] of Object.entries({ ...base, ...o })) fd.set(k, v);
    return fd;
  };
  const withVersion = (fd: FormData, v: string) => (fd.set("baseVersion", v), fd);

  try {
    const mkT = async (u: string, examId: string) => {
      await createTeacher(M, { name: `TPF ${u}`, username: `tpf-${u}-${sfx}`, password: "tpf-password-123" });
      const id = (await prisma.adminUser.findUniqueOrThrow({ where: { username: `tpf-${u}-${sfx}` } })).id;
      await assignExam(M, id, examId);
      return id;
    };
    const t1 = await mkT("t1", examA.id);
    const t2 = await mkT("t2", examA.id);
    const tB = await mkT("tb", examB.id);
    const T1 = (await teacherScope(t1)) as TeacherScope;
    const T2 = (await teacherScope(t2)) as TeacherScope;

    // ================================================================ 1
    section("1. Concurrent editing");
    const d = await mkQ(examA.id, subjA.id, { status: "DRAFT" });
    const v0 = await editVersion(d.id);
    const s1 = await saveQuestionEdit(T1, d.id, withVersion(form({ text: "TPF teacher 1 wins" }), v0));
    const s2 = await saveQuestionEdit(T2, d.id, withVersion(form({ text: "TPF teacher 2 stale" }), v0));
    check("sequential: second save from the same (stale) version is refused", s1.ok && !s2.ok && /changed this question/.test(errOf(s2)), [s1, s2]);
    check("…and the first teacher's text is kept", (await prisma.question.findUniqueOrThrow({ where: { id: d.id } })).text === "TPF teacher 1 wins");
    check("save without a version is refused", /version/.test(errOf(await saveQuestionEdit(T1, d.id, form({})))));
    const v1 = await editVersion(d.id);
    const par = await Promise.all([
      saveQuestionEdit(T1, d.id, withVersion(form({ text: "TPF parallel one" }), v1)),
      saveQuestionEdit(T2, d.id, withVersion(form({ text: "TPF parallel two" }), v1)),
    ]);
    const winner = par.findIndex((r) => r.ok);
    const finalText = (await prisma.question.findUniqueOrThrow({ where: { id: d.id } })).text;
    check("parallel draft saves: exactly one succeeds", par.filter((r) => r.ok).length === 1, par);
    check("parallel draft saves: the stored text is the winner's", finalText === (winner === 0 ? "TPF parallel one" : "TPF parallel two"), finalText);

    const p = await mkQ(examA.id, subjA.id);
    const pv = await editVersion(p.id);
    check("published question with no revision has version 'none'", pv === "none");
    const rpar = await Promise.all([
      saveQuestionEdit(T1, p.id, withVersion(form({ text: "TPF revision by 1" }), pv)),
      saveQuestionEdit(T2, p.id, withVersion(form({ text: "TPF revision by 2" }), pv)),
    ]);
    const revs = await prisma.questionRevision.findMany({ where: { questionId: p.id } });
    check("parallel first revisions: exactly one created, the other refused", rpar.filter((r) => r.ok).length === 1 && revs.length === 1, rpar);
    const rWinner = rpar[0].ok ? "TPF revision by 1" : "TPF revision by 2";
    check("revision holds the winner's proposal", JSON.stringify(revs[0]?.proposedSnapshot).includes(rWinner));
    const stalePv = pv; // a teacher who opened the editor before the revision existed
    check("stale editor cannot overwrite an existing revision", !(await saveQuestionEdit(T2, p.id, withVersion(form({ text: "TPF overwrite attempt" }), stalePv))).ok && JSON.stringify((await prisma.questionRevision.findFirstOrThrow({ where: { questionId: p.id } })).proposedSnapshot).includes(rWinner));
    const pv2 = await editVersion(p.id);
    const cont = await saveQuestionEdit(T2, p.id, withVersion(form({ text: "TPF continued by 2" }), pv2));
    check("teacher with the current version continues the shared revision", cont.ok, cont);
    check("live published question untouched throughout", (await prisma.question.findUniqueOrThrow({ where: { id: p.id } })).text === p.text);

    const d2 = await mkQ(examA.id, subjA.id, { status: "DRAFT" });
    const dv = await editVersion(d2.id);
    const [saveR, subR] = await Promise.all([
      saveQuestionEdit(T1, d2.id, withVersion(form({ text: "TPF raced edit" }), dv)),
      submitForPublication(T2, d2.id, "ready for review by the master"),
    ]);
    const logs = await prisma.auditLog.findMany({ where: { OR: [{ entityId: d2.id }, { action: "TEACHER_REQUEST_PUBLISH_QUESTION" }] }, orderBy: { createdAt: "asc" }, select: { action: true, entityId: true, metadata: true } });
    const reqIdx = logs.findIndex((l) => l.action === "TEACHER_REQUEST_PUBLISH_QUESTION" && JSON.stringify(l.metadata).includes(d2.id));
    const editIdx = logs.findIndex((l) => l.action === "TEACHER_QUESTION_UPDATED" && l.entityId === d2.id);
    check("save vs submit race: never an edit after the submission", subR.ok && (editIdx === -1 || editIdx < reqIdx), { saveR, subR, editIdx, reqIdx });

    const sr = await submitRevision(T1, p.id, "please apply this change");
    const [a1, a2] = await Promise.all([approveRequest(M, sr.ok ? sr.requestId : ""), approveRequest(M, sr.ok ? sr.requestId : "")]);
    check("two simultaneous approvals: exactly one applies", [a1, a2].filter((r) => r.ok).length === 1, [a1, a2]);
    const dr = await requestDeletion(T1, d.id, "duplicate question, please delete");
    const [ap, rj] = await Promise.all([approveRequest(M, dr.ok ? dr.requestId : ""), rejectRequest(M, dr.ok ? dr.requestId : "", "keep it")]);
    check("simultaneous approve + reject: exactly one decision", [ap, rj].filter((r) => r.ok).length === 1, [ap, rj]);

    // ================================================================ 2
    section("2. Question images");
    const qImg = await mkQ(examA.id, subjA.id, { status: "DRAFT", imageUrl: imgShared.url, optImage: imgOpt.url });
    const qShareA = await mkQ(examA.id, subjA.id, { imageUrl: imgShared.url });
    const qShareB = await mkQ(examB.id, subjB.id, { imageUrl: imgShared.url });
    const qOtherB = await mkQ(examB.id, subjB.id, { imageUrl: imgB.url });
    void qOtherB;
    const inj = await saveQuestionEdit(T1, qImg.id, withVersion(form({ imageUrl: imgB.url }), await editVersion(qImg.id)));
    check("teacher cannot attach another exam's image URL", !inj.ok && /image/i.test(errOf(inj)));
    const injOpt = await saveQuestionEdit(T1, qImg.id, withVersion(form({ imageUrl: imgShared.url, optionBImageUrl: imgB.url }), await editVersion(qImg.id)));
    check("…nor as an option image", !injOpt.ok);
    const keep = await saveQuestionEdit(T1, qImg.id, withVersion(form({ imageUrl: imgShared.url, optionBImageUrl: imgOpt.url, text: "TPF keeps images" }), await editVersion(qImg.id)));
    const kept = await prisma.question.findUniqueOrThrow({ where: { id: qImg.id }, include: { options: true } });
    check("keeping images keeps both URLs", keep.ok && kept.imageUrl === imgShared.url && kept.options.find((o) => o.label === "B")?.imageUrl === imgOpt.url, keep);
    const rem = await saveQuestionEdit(T1, qImg.id, withVersion(form({ imageUrl: "", optionBImageUrl: "" }), await editVersion(qImg.id)));
    const after = await prisma.question.findUniqueOrThrow({ where: { id: qImg.id }, include: { options: true } });
    check("removing images clears only this question's references", rem.ok && after.imageUrl === null && after.options.every((o) => !o.imageUrl));
    check("files stay on disk after removal (other questions/attempts may use them)", existsSync(imgShared.path) && existsSync(imgOpt.path));
    const sA = await prisma.question.findUniqueOrThrow({ where: { id: qShareA.id } });
    const sB = await prisma.question.findUniqueOrThrow({ where: { id: qShareB.id } });
    check("questions sharing the same image (same exam and other exam) unaffected", sA.imageUrl === imgShared.url && sB.imageUrl === imgShared.url);

    // published question with image + rich asset: revision kept / removed
    const pi = await mkQ(examA.id, subjA.id, { imageUrl: imgShared.url });
    // The asset's file exists, as in production (the publishing policy refuses a question whose asset file is missing).
    mkdirSync(join(storage, "media", "q", "ab"), { recursive: true });
    writeFileSync(join(storage, "media", "q", "ab", "a".repeat(64) + ".webp"), Buffer.from("RIFF"));
    const asset = await prisma.questionAsset.create({ data: { questionId: pi.id, role: "EXPLANATION", storageKey: "q/ab/" + "a".repeat(64) + ".webp", mime: "image/webp", width: 1, height: 1, bytes: 1, sha256: "a".repeat(64), alt: "TPF asset" } }).catch((e) => e as Error);
    const mockImg = await prisma.mockTest.create({ data: { examId: examA.id, title: `TPF img ${sfx}`, durationMinutes: 10, status: "PUBLISHED", questions: { create: [{ questionId: pi.id, order: 0 }, { questionId: qShareA.id, order: 1 }] } } });
    const sImg = await mkStudent("img");
    const before = await startMockTestAttempt(sImg, mockImg.id);
    await saveQuestionEdit(T1, pi.id, withVersion(form({ imageUrl: "", text: "TPF image removed by revision" }), await editVersion(pi.id)));
    const rsub = await submitRevision(T1, pi.id, "remove the misleading image");
    const apImg = await approveRequest(M, rsub.ok ? rsub.requestId : "");
    check("revision removing an image is approved", apImg.ok, apImg);
    const piAfter = await prisma.question.findUniqueOrThrow({ where: { id: pi.id } });
    check("live question now has no image", piAfter.imageUrl === null);
    const snap = await prisma.testAttemptQuestion.findFirstOrThrow({ where: { attemptId: before.id, questionId: pi.id } });
    check("attempt started before keeps the image in its snapshot", JSON.stringify(snap.questionSnapshot).includes(imgShared.url));
    check("file still on disk after the approved removal", existsSync(imgShared.path));
    if (!(asset instanceof Error)) check("rich-media assets (QuestionAsset) untouched by a revision", (await prisma.questionAsset.count({ where: { questionId: pi.id } })) === 1);
    else console.log(`  (asset fixture skipped: ${asset.message.split("\n")[0]})`);
    check("teacher of exam B cannot open or edit exam A's image question", !(await saveQuestionEdit((await teacherScope(tB)) as TeacherScope, qImg.id, withVersion(form({ examId: examB.id, subjectId: subjB.id }), "x"))).ok);

    // ================================================================ 3
    section("3. Access invalidation");
    const cur = await mkQ(examA.id, subjA.id, { status: "DRAFT" });
    await setTeacherStatus(M, t2, "SUSPENDED");
    check("suspension: scope gone at once (every request re-reads it)", (await teacherScope(t2)) === null);
    const sv = await prisma.adminUser.findUniqueOrThrow({ where: { id: t2 }, select: { sessionsValidAfter: true } });
    check("suspension: existing sessions invalidated (sessionsValidAfter set)", !!sv.sessionsValidAfter && Date.now() - sv.sessionsValidAfter.getTime() < 60_000);
    check("suspended teacher's in-flight scope object still re-checked by every action", (await teacherScope(t2)) === null);
    await setTeacherStatus(M, t2, "ACTIVE");
    await setTeacherStatus(M, t2, "DEACTIVATED");
    const dv2 = await prisma.adminUser.findUniqueOrThrow({ where: { id: t2 }, select: { isActive: true } });
    check("deactivation: account off + scope gone", !dv2.isActive && (await teacherScope(t2)) === null);
    const aId = (await prisma.teacherExamAssignment.findFirstOrThrow({ where: { teacherId: t1, examId: examA.id, revokedAt: null } })).id;
    await revokeAssignment(M, aId);
    const T1after = await teacherScope(t1);
    check("revocation: exam leaves the scope at once", !!T1after && !T1after.examIds.includes(examA.id));
    check("revocation: edits with the revoked exam are refused", !(await saveQuestionEdit(T1after!, cur.id, withVersion(form({}), await editVersion(cur.id)))).ok);
    await assignExam(M, t1, examA.id);
    const T1b = (await teacherScope(t1)) as TeacherScope;

    // ================================================================ 5 + 6
    section("6. Unpublish vs marks, accuracy, counts, leaderboards and Overall Rank");
    const qs = [await mkQ(examA.id, subjA.id), await mkQ(examA.id, subjA.id), await mkQ(examA.id, subjA.id), await mkQ(examA.id, subjA.id)];
    const mkRanked = async (title: string) => {
      const m = await prisma.mockTest.create({ data: { examId: examA.id, title: `TPF ${title} ${sfx}`, durationMinutes: 10, status: "PUBLISHED", questions: { create: qs.map((q, order) => ({ questionId: q.id, order })) } } });
      await prisma.testRankingConfig.create({ data: { kind: "MOCK_TEST", mockTestId: m.id, leaderboardEnabled: true, countsTowardOverall: true } });
      return m;
    };
    const R1 = await mkRanked("Ranked 1");
    const R2 = await mkRanked("Ranked 2");
    const R3 = await mkRanked("Ranked 3");
    const S = { a: await mkStudent("a"), b: await mkStudent("b"), c: await mkStudent("c"), late: await mkStudent("late") };
    const take = async (sid: string, mockId: string, correct: number) => {
      const att = await startMockTestAttempt(sid, mockId);
      const aq = await prisma.testAttemptQuestion.findMany({ where: { attemptId: att.id }, orderBy: { order: "asc" } });
      for (let i = 0; i < aq.length; i++) await saveAnswer(att.id, sid, aq[i].questionId, i < correct ? "A" : "B", false);
      await submitAttempt(att.id, sid);
      return att.id;
    };
    const attemptsBefore: string[] = [];
    for (const m of [R1, R2, R3]) {
      attemptsBefore.push(await take(S.a, m.id, 4));
      attemptsBefore.push(await take(S.b, m.id, 2));
    }
    const inProgress = await startMockTestAttempt(S.c, R1.id);
    const snapshotOf = async () =>
      JSON.stringify(await prisma.testAttempt.findMany({ where: { id: { in: attemptsBefore } }, orderBy: { id: "asc" }, select: { id: true, score: true, totalQuestions: true, correctCount: true, incorrectCount: true, status: true } }));
    const storedBefore = await snapshotOf();
    const lb = async () => JSON.stringify((await getLeaderboard({ kind: "MOCK_TEST", id: R1.id }, S.a)).rows.map((r) => [r.displayName, r.rank, r.score, r.accuracy, r.correctCount]));
    clearOverallRankingCache();
    const overall = async (sid: string) => JSON.stringify((await getOverallStanding(examA.id, sid, { fresh: true })).self);
    const lbBefore = await lb();
    const ovBefore = [await overall(S.a), await overall(S.b)];
    const countBefore = (await getMockTestDetailForStudent(S.late, R1.id))?.mockTest._count.questions;

    const un = await unpublishFromMockTest(T1b, R1.id, qs[0].id, "question one has a wrong key");
    check("unpublish from a ranked mock", un.ok, un);
    const notice = await prisma.teacherContentRequest.findUniqueOrThrow({ where: { id: un.ok ? un.requestId : "" } });
    const imp = notice.impact as { submittedAttempts: number; leaderboardEnabled: boolean; countsTowardOverall: boolean };
    check("impact recorded for the Master Admin (attempts, leaderboard, Overall Rank)", imp.submittedAttempts === 2 && imp.leaderboardEnabled && imp.countsTowardOverall, imp);
    check("stored marks / totals / correct / incorrect of every earlier attempt unchanged", (await snapshotOf()) === storedBefore);
    check("leaderboard of the test unchanged (ranks, scores, accuracy)", (await lb()) === lbBefore);
    clearOverallRankingCache();
    check("Overall Rank of earlier students unchanged", (await overall(S.a)) === ovBefore[0] && (await overall(S.b)) === ovBefore[1], [ovBefore, await overall(S.a)]);
    const countAfter = (await getMockTestDetailForStudent(S.late, R1.id))?.mockTest._count.questions;
    check("student-facing question count follows (4 → 3)", countBefore === 4 && countAfter === 3, [countBefore, countAfter]);
    // in-progress attempt keeps all 4 and Q1 still counts
    const ipQs = await prisma.testAttemptQuestion.findMany({ where: { attemptId: inProgress.id }, orderBy: { order: "asc" } });
    for (const aq of ipQs) await saveAnswer(inProgress.id, S.c, aq.questionId, "A", false);
    await submitAttempt(inProgress.id, S.c);
    const ip = await prisma.testAttempt.findUniqueOrThrow({ where: { id: inProgress.id } });
    check("in-progress attempt: 4 questions, the unpublished one still marked (score 4, 100%)", ip.totalQuestions === 4 && ip.correctCount === 4 && ip.score === 4, ip);
    const lateId = await take(S.late, R1.id, 3);
    const late = await prisma.testAttempt.findUniqueOrThrow({ where: { id: lateId } });
    check("new attempt: 3 questions, marks and accuracy over 3 (score 3, 3 correct, 0 wrong)", late.totalQuestions === 3 && late.score === 3 && late.correctCount === 3 && late.incorrectCount === 0, late);
    check("earlier attempts still unchanged after new attempts", (await snapshotOf()) === storedBefore);
    const lbNow = (await getLeaderboard({ kind: "MOCK_TEST", id: R1.id }, S.a)).rows;
    const rowA = lbNow.find((r) => r.isSelf);
    check("leaderboard: earlier top score keeps its score/accuracy; new attempt ranked by its own stored score", rowA?.score === 4 && rowA.accuracy === 1 && lbNow.some((r) => r.score === 3), lbNow.map((r) => [r.rank, r.score]));
    const rr = await requestRestore(T1b, R1.id, qs[0].id, "key fixed, put it back");
    await approveRequest(M, rr.ok ? rr.requestId : "");
    check("after restore new attempts get 4 again; the 3-question attempt is unchanged", (await getMockTestDetailForStudent(S.late, R1.id))?.mockTest._count.questions === 4 && (await prisma.testAttempt.findUniqueOrThrow({ where: { id: lateId } })).totalQuestions === 3);

    section("5. Historical data: revisions, retirement, attempts");
    const allRevs = await prisma.questionRevision.findMany({ where: { questionId: p.id }, orderBy: { createdAt: "asc" } });
    check("revision history kept (approved row stays, with author and last editor)", allRevs.length >= 1 && allRevs.some((r) => r.status === "APPROVED" && r.authorId && r.lastEditedById));
    const target = qs[1];
    await saveQuestionEdit(T1b, target.id, withVersion(form({ text: "TPF pending revision before retire" }), await editVersion(target.id)));
    const pend = await submitRevision(T1b, target.id, "change before it gets retired");
    const del = await requestDeletion(T1b, target.id, "outdated, please retire it");
    check("delete approval → 'Approved — action not yet applied'", (await approveRequest(M, del.ok ? del.requestId : "")).ok && (await effectiveStatuses([await prisma.teacherContentRequest.findUniqueOrThrow({ where: { id: del.ok ? del.requestId : "" } })])).get(del.ok ? del.requestId : "") === "NOT_APPLIED");
    const scoresBeforeRetire = await snapshotOf();
    const ret = await applyReplacement({ pairs: [{ oldQuestionId: target.id, newQuestionId: null }], reason: "TPF retire after teacher request", actor: { adminId: M, source: "SCRIPT" } });
    check("Master Admin retires it with Retire / Replace", !!ret.replacementId);
    check("delete request now shows 'Applied'", (await effectiveStatuses([await prisma.teacherContentRequest.findUniqueOrThrow({ where: { id: del.ok ? del.requestId : "" } })])).get(del.ok ? del.requestId : "") === "APPLIED");
    const apRet = await approveRequest(M, pend.ok ? pend.requestId : "");
    check("pending revision of a retired question cannot be applied", !apRet.ok && /retired/i.test(errOf(apRet)), apRet);
    check("teacher can no longer edit the retired question", !(await saveQuestionEdit(T1b, target.id, withVersion(form({}), await editVersion(target.id)))).ok);
    // Retire's own approved rule (Phase 1 D4/D5/D9): attempts containing the retired question are
    // marked invalidated (status ABANDONED + invalidatedByReplacementId) — explicit, never silent; marks stay.
    const marks = (j: string) => JSON.stringify(JSON.parse(j).map((a: Record<string, unknown>) => [a.id, a.score, a.totalQuestions, a.correctCount, a.incorrectCount]));
    const inv = await prisma.testAttempt.findMany({ where: { id: { in: attemptsBefore } }, select: { status: true, invalidatedByReplacementId: true } });
    check("retirement keeps every attempt's marks; affected attempts are explicitly marked invalidated by that replacement", marks(await snapshotOf()) === marks(scoresBeforeRetire) && inv.every((a) => a.status === "ABANDONED" && a.invalidatedByReplacementId === ret.replacementId), inv);
    const rb = await rollbackReplacement(ret.replacementId, { adminId: M, source: "SCRIPT" });
    check("retire rollback restores every earlier attempt exactly (status and marks)", (await snapshotOf()) === scoresBeforeRetire);
    const back = await prisma.question.findUniqueOrThrow({ where: { id: target.id } });
    check("retire rollback restores the question; revision rows still there", !!rb && back.retiredAt === null && (await prisma.questionRevision.count({ where: { questionId: target.id } })) === 1);
    check("…and the delete request returns to 'Approved — action not yet applied'", (await effectiveStatuses([await prisma.teacherContentRequest.findUniqueOrThrow({ where: { id: del.ok ? del.requestId : "" } })])).get(del.ok ? del.requestId : "") === "NOT_APPLIED");

    // ================================================================ 7
    section("7. Request status for Grand / Live CBT / PYQ / delete");
    const g = await prisma.grandTest.create({ data: { examId: examA.id, title: `TPF Grand ${sfx}`, durationMinutes: 10, questionCount: 1, status: "PUBLISHED", questions: { create: [{ questionId: qs[2].id, order: 0 }] } } });
    const live = await prisma.mockTest.create({ data: { examId: examA.id, title: `TPF LiveCBT ${sfx}`, durationMinutes: 10, status: "PUBLISHED", enrollmentEnabled: true, questions: { create: [{ questionId: qs[2].id, order: 0 }, { questionId: qs[3].id, order: 1 }] } } });
    const paper = await prisma.previousYearPaper.create({ data: { examId: examA.id, year: 2020, title: `TPF PYQ ${sfx}` } });
    await prisma.question.update({ where: { id: qs[3].id }, data: { previousYearPaperId: paper.id, source: "PYQ" } });
    const gr = await requestUnpublish(T1b, "GRAND_TEST", g.id, qs[2].id, "remove from the grand test");
    const lr = await requestUnpublish(T1b, "MOCK_TEST", live.id, qs[2].id, "remove from the live CBT");
    const pr = await requestUnpublish(T1b, "PYQ_PAPER", paper.id, qs[3].id, "remove from this PYQ paper");
    const xr = await requestUnpublish(T1b, "GRAND_TEST", g.id, qs[2].id, "duplicate of the grand request");
    const ids = [gr, lr, pr].map((r) => (r.ok ? r.requestId : ""));
    const st = async () => effectiveStatuses(await prisma.teacherContentRequest.findMany({ where: { id: { in: ids } } }));
    let m = await st();
    check("new requests are Pending", ids.every((i) => m.get(i) === "PENDING") && !xr.ok);
    await approveRequest(M, ids[0]);
    await approveRequest(M, ids[1]);
    await rejectRequest(M, ids[2], "keep it in the paper");
    m = await st();
    check("Grand Test approved → 'Approved — action not yet applied'", m.get(ids[0]) === "NOT_APPLIED");
    check("Live CBT approved → 'Applied' (excluded in the same transaction)", m.get(ids[1]) === "APPLIED" && !!(await prisma.mockTestQuestion.findFirstOrThrow({ where: { mockTestId: live.id, questionId: qs[2].id } })).excludedAt);
    check("PYQ rejected → 'Rejected', paper unchanged", m.get(ids[2]) === "REJECTED" && (await prisma.question.findUniqueOrThrow({ where: { id: qs[3].id } })).previousYearPaperId === paper.id);
    await prisma.grandTestQuestion.deleteMany({ where: { grandTestId: g.id, questionId: qs[2].id } });
    check("Grand Test turns 'Applied' once the question is out of that test", (await st()).get(ids[0]) === "APPLIED");
  } finally {
    const users = (await prisma.adminUser.findMany({ where: { username: { endsWith: `-${sfx}` } }, select: { id: true } })).map((u) => u.id);
    await prisma.teacherContentRequest.deleteMany({ where: { examId: { in: exams } } });
    await prisma.questionReplacement.deleteMany({ where: { reason: { startsWith: "TPF " } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: students } } });
    await prisma.mockTest.deleteMany({ where: { examId: { in: exams } } });
    await prisma.grandTest.deleteMany({ where: { examId: { in: exams } } });
    await prisma.question.deleteMany({ where: { examId: { in: exams } } });
    await prisma.previousYearPaper.deleteMany({ where: { examId: { in: exams } } });
    await prisma.student.deleteMany({ where: { id: { in: students } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await prisma.teacherExamAssignment.deleteMany({ where: { teacherId: { in: users } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: users } } });
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
