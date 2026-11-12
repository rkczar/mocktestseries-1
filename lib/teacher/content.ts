import "server-only";
import { Prisma, QuestionSource, QuestionStatus, type TeacherRequestType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { allocateQuestionCode, questionCodeScope, resolveQuestionCodeInput } from "@/lib/question-code";
import { assertHierarchyConsistency, legacyQuestionCode, matchSpecFromForm, orphanListImages, parseQuestionForm } from "@/lib/question-form-core";
import { structuralPublishIssues, publishRefusal } from "@/lib/question-publish-policy";
import { asJson, CONTENT_SELECT, contentFromForm, contentOf, readContent, sameContent, writeContent, type QuestionContent } from "@/lib/question-content";
import { SERVABLE_QUESTION_WHERE } from "@/lib/question-servable";
import { assertExamInScope, examInScope, mockTestInScope, questionInScope, TeacherAccessError, type TeacherScope } from "@/lib/teacher/scope";

/**
 * Teacher Portal Phase A content workflows (docs/TEACHER-PORTAL.md). Every
 * function takes the caller's TeacherScope (lib/teacher/scope.ts) and
 * re-checks every posted id against it. Nothing here publishes a question,
 * deletes anything or edits a PUBLISHED question's live content: those happen
 * only when a Master Admin approves a TeacherContentRequest
 * (lib/teacher/approvals.ts). The single immediate change a teacher can make
 * to a live test is a per-test Unpublish from a (non Live CBT) Mock Test,
 * which only affects attempts started afterwards.
 */

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export const MIN_REASON = 10;
export const MAX_REASON = 1000;

function cleanReason(reason: unknown): string | null {
  const r = String(reason ?? "").trim();
  return r.length >= MIN_REASON && r.length <= MAX_REASON ? r : null;
}
const REASON_ERROR = `A reason of at least ${MIN_REASON} characters is required.`;

function fail(error: unknown): { ok: false; error: string } {
  if (error instanceof TeacherAccessError) return { ok: false, error: error.message };
  if (error instanceof TeacherError) return { ok: false, error: error.message };
  throw error;
}

class TeacherError extends Error {}

async function audit(
  db: Pick<Prisma.TransactionClient, "auditLog">,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata?: Prisma.InputJsonValue
) {
  await db.auditLog.create({ data: { actorId, action, entityType, entityId, metadata } });
}

// ---------------------------------------------------------------------------
// Form → content (teacher rules on top of the shared admin validation)
// ---------------------------------------------------------------------------

/**
 * Parses the question form exactly like the admin form, then applies the
 * teacher rules: the exam must be assigned; status, source, PYQ link and
 * review flags are never taken from the form; images can be kept or removed
 * but not added or swapped (image upload is admin-only in Phase A).
 */
async function teacherContentFromForm(scope: TeacherScope, formData: FormData, existing: QuestionContent | null, questionId: string | null): Promise<QuestionContent> {
  const fd = new FormData();
  for (const [k, v] of formData.entries()) if (typeof v === "string") fd.append(k, v);
  fd.set("status", QuestionStatus.DRAFT);
  for (const k of ["source", "previousYearPaperId", "reviewRequired", "reviewReason"]) fd.delete(k);
  const parsed = parseQuestionForm(fd);
  if (!parsed.success) throw new TeacherError(parsed.error.issues[0]?.message ?? "Invalid input.");
  const data = parsed.data;
  assertExamInScope(scope, data.examId);
  const hierarchyError = await assertHierarchyConsistency(prisma, { examId: data.examId, subjectId: data.subjectId, topicId: data.topicId, subTopicId: data.subTopicId });
  if (hierarchyError) throw new TeacherError(hierarchyError);
  const match = await matchSpecFromForm(data, questionId);
  if (match.error) throw new TeacherError(match.error);
  const content = contentFromForm(data, match.spec, data.examYear ?? existing?.examYear ?? null);

  const allowedImages = new Set<string>([existing?.imageUrl, ...(existing?.options.map((o) => o.imageUrl) ?? [])].filter((u): u is string => !!u));
  for (const url of [content.imageUrl, ...content.options.map((o) => o.imageUrl)]) {
    if (url && !allowedImages.has(url)) throw new TeacherError("Teachers can keep or remove existing images, not add new ones. Ask the Master Admin to add images.");
  }
  if (questionId) {
    const orphans = await orphanListImages(questionId, match.spec);
    if (orphans.length) throw new TeacherError(`Remove the list image for ${orphans[0]} first (its entry is no longer in the list).`);
  }
  return content;
}

async function openRequest(type: TeacherRequestType, where: Prisma.TeacherContentRequestWhereInput) {
  return prisma.teacherContentRequest.findFirst({ where: { type, status: "OPEN", ...where }, select: { id: true } });
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

/** New question in an assigned exam: always DRAFT, author recorded. */
export async function createDraftQuestion(scope: TeacherScope, formData: FormData): Promise<Result<{ questionId: string }>> {
  try {
    const content = await teacherContentFromForm(scope, formData, null, null);
    const created = await prisma.$transaction(async (tx) => {
      const { examCode, examYear: resolvedYear } = await resolveQuestionCodeInput(tx, { examId: content.examId, previousYearPaperId: null });
      const year = content.examYear ?? resolvedYear;
      const code = year !== null ? await allocateQuestionCode(tx, questionCodeScope(examCode, year)) : legacyQuestionCode();
      const q = await tx.question.create({
        data: {
          code,
          examId: content.examId,
          examYear: year,
          subjectId: content.subjectId,
          topicId: content.topicId,
          subTopicId: content.subTopicId,
          text: content.text,
          imageUrl: null,
          difficulty: content.difficulty,
          questionType: content.questionType,
          matchSpec: content.matchSpec ? (content.matchSpec as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          status: QuestionStatus.DRAFT,
          source: QuestionSource.QUESTION_BANK,
          createdByAdminId: scope.teacherId,
        },
      });
      await tx.questionOption.createMany({
        data: content.options.map((o, order) => ({ questionId: q.id, label: o.label, text: o.text, imageUrl: null, isCorrect: o.isCorrect, order })),
      });
      await audit(tx, scope.teacherId, "TEACHER_QUESTION_CREATED", "Question", q.id, { code, examId: content.examId, status: "DRAFT" });
      return q;
    });
    return { ok: true, questionId: created.id };
  } catch (e) {
    return fail(e);
  }
}

export type SaveOutcome = "DRAFT_SAVED" | "REVISION_SAVED";

const CONFLICT = "Someone else changed this question after you opened it. Your changes were NOT saved — reload the page to see the latest version, then make your edit again.";

/**
 * Optimistic-concurrency token the editor posts back as `baseVersion`:
 * DRAFT → the question's updatedAt; PUBLISHED → the open revision's
 * updatedAt, or "none" when no revision is open. A save whose token no
 * longer matches is refused, so a teacher working from an older copy can
 * never overwrite a newer edit (draft or revision) by another teacher.
 */
export async function editVersion(questionId: string, db: Pick<Prisma.TransactionClient, "question" | "questionRevision"> = prisma): Promise<string> {
  const q = await db.question.findUnique({ where: { id: questionId }, select: { status: true, updatedAt: true } });
  if (!q) return "";
  if (q.status !== QuestionStatus.PUBLISHED) return `draft:${q.updatedAt.toISOString()}`;
  const rev = await db.questionRevision.findFirst({ where: { questionId, status: { in: ["DRAFT", "SUBMITTED"] } }, select: { updatedAt: true } });
  return rev ? `rev:${rev.updatedAt.toISOString()}` : "none";
}

async function lockQuestion(tx: Prisma.TransactionClient, questionId: string) {
  await tx.$queryRaw`SELECT id FROM "Question" WHERE id = ${questionId} FOR UPDATE`;
}

/**
 * Save from the teacher editor.
 *  - DRAFT question: written directly (it is never served), unless it is
 *    waiting for publication approval (withdraw that request first).
 *  - PUBLISHED question: the live row is NOT touched; the content is saved as
 *    the question's open revision (one per question, shared by every teacher
 *    of the exam) for Master Admin approval.
 *  - ARCHIVED / retired: read-only.
 */
export async function saveQuestionEdit(scope: TeacherScope, questionId: string, formData: FormData): Promise<Result<{ outcome: SaveOutcome }>> {
  try {
    const q = await questionInScope(scope, questionId);
    if (q.retiredAt || q.status === QuestionStatus.ARCHIVED || q.status === QuestionStatus.WITHDRAWN) throw new TeacherError("This question is archived, withdrawn or retired and is read-only.");
    const baseVersion = String(formData.get("baseVersion") ?? "");
    if (!baseVersion) throw new TeacherError("Reload the page and try again (the editor's version is missing).");
    const row = await prisma.question.findUniqueOrThrow({ where: { id: q.id }, select: CONTENT_SELECT });
    const current = contentOf(row);
    const content = await teacherContentFromForm(scope, formData, current, q.id);

    if (q.status === QuestionStatus.DRAFT) {
      if (await openRequest("PUBLISH_QUESTION", { questionId: q.id })) {
        throw new TeacherError("This question is waiting for publication approval. Withdraw that request before editing it.");
      }
      await prisma.$transaction(async (tx) => {
        await lockQuestion(tx, q.id);
        const fresh = await tx.question.findUnique({ where: { id: q.id }, select: { status: true, retiredAt: true } });
        if (fresh?.status !== QuestionStatus.DRAFT || fresh.retiredAt) throw new TeacherError("The question's status changed — reload and try again.");
        if ((await editVersion(q.id, tx)) !== baseVersion) throw new TeacherError(CONFLICT);
        if (await tx.teacherContentRequest.findFirst({ where: { type: "PUBLISH_QUESTION", status: "OPEN", questionId: q.id }, select: { id: true } })) {
          throw new TeacherError("This question is waiting for publication approval. Withdraw that request before editing it.");
        }
        await writeContent(tx, q.id, content);
        await audit(tx, scope.teacherId, "TEACHER_QUESTION_UPDATED", "Question", q.id, { status: "DRAFT" });
      });
      return { ok: true, outcome: "DRAFT_SAVED" };
    }

    // PUBLISHED → revision. The question row is locked so two saves of the
    // same question are serialized; the version token rejects a stale copy.
    await prisma.$transaction(async (tx) => {
      await lockQuestion(tx, q.id);
      if ((await editVersion(q.id, tx)) !== baseVersion) throw new TeacherError(CONFLICT);
      const open = await tx.questionRevision.findFirst({ where: { questionId: q.id, status: { in: ["DRAFT", "SUBMITTED"] } } });
      if (open?.status === "SUBMITTED") throw new TeacherError("A revision of this question is waiting for approval. Withdraw it before making more changes.");
      if (open && !sameContent(readContent(open.baseSnapshot), current)) {
        throw new TeacherError("The published question changed after this revision was started. Discard the revision and start again from the current version.");
      }
      if (!open && sameContent(content, current)) throw new TeacherError("No changes to save.");
      const rev = open
        ? await tx.questionRevision.update({ where: { id: open.id }, data: { proposedSnapshot: asJson(content), lastEditedById: scope.teacherId } })
        : await tx.questionRevision.create({
            data: { questionId: q.id, authorId: scope.teacherId, lastEditedById: scope.teacherId, baseSnapshot: asJson(current), proposedSnapshot: asJson(content) },
          });
      await audit(tx, scope.teacherId, open ? "TEACHER_REVISION_UPDATED" : "TEACHER_REVISION_CREATED", "QuestionRevision", rev.id, { questionId: q.id });
    });
    return { ok: true, outcome: "REVISION_SAVED" };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Another teacher just started a revision of this question — reload to continue it." };
    }
    return fail(e);
  }
}

/** Discards the open DRAFT (not yet submitted) revision of a question. */
export async function discardRevision(scope: TeacherScope, questionId: string): Promise<Result> {
  try {
    const q = await questionInScope(scope, questionId);
    const n = await prisma.$transaction(async (tx) => {
      const rev = await tx.questionRevision.findFirst({ where: { questionId: q.id, status: "DRAFT" }, select: { id: true } });
      if (!rev) return 0;
      await tx.questionRevision.update({ where: { id: rev.id }, data: { status: "WITHDRAWN", decidedAt: new Date(), decidedById: scope.teacherId } });
      await audit(tx, scope.teacherId, "TEACHER_REVISION_DISCARDED", "QuestionRevision", rev.id, { questionId: q.id });
      return 1;
    });
    return n ? { ok: true } : { ok: false, error: "There is no draft revision to discard." };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Requests to the Master Admin
// ---------------------------------------------------------------------------

async function createRequest(
  scope: TeacherScope,
  data: { type: TeacherRequestType; examId: string; reason: string; questionId?: string; revisionId?: string; targetKind?: string; targetId?: string; impact?: Prisma.InputJsonValue },
  tx: Prisma.TransactionClient
) {
  const r = await tx.teacherContentRequest.create({ data: { ...data, teacherId: scope.teacherId } });
  await audit(tx, scope.teacherId, `TEACHER_REQUEST_${data.type}`, "TeacherContentRequest", r.id, {
    questionId: data.questionId ?? null,
    targetKind: data.targetKind ?? null,
    targetId: data.targetId ?? null,
    reason: data.reason,
  });
  return r;
}

/** Ask the Master Admin to publish a teacher's DRAFT question. */
export async function submitForPublication(scope: TeacherScope, questionId: string, reasonIn: unknown): Promise<Result<{ requestId: string }>> {
  try {
    const reason = cleanReason(reasonIn);
    if (!reason) throw new TeacherError(REASON_ERROR);
    const q = await questionInScope(scope, questionId);
    if (q.status !== QuestionStatus.DRAFT || q.retiredAt) throw new TeacherError("Only Draft questions can be submitted for publication.");
    if (await openRequest("PUBLISH_QUESTION", { questionId: q.id })) throw new TeacherError("This question is already waiting for approval.");
    const refusal = await publishRefusal(q.id);
    if (refusal) throw new TeacherError(`${refusal} Fix it before submitting.`);
    const r = await prisma.$transaction(async (tx) => {
      // Same lock as the editor: a save and a submission of one Draft never interleave.
      await lockQuestion(tx, q.id);
      const fresh = await tx.question.findUnique({ where: { id: q.id }, select: { status: true, retiredAt: true } });
      if (fresh?.status !== QuestionStatus.DRAFT || fresh.retiredAt) throw new TeacherError("Only Draft questions can be submitted for publication.");
      if (await tx.teacherContentRequest.findFirst({ where: { type: "PUBLISH_QUESTION", status: "OPEN", questionId: q.id }, select: { id: true } })) {
        throw new TeacherError("This question is already waiting for approval.");
      }
      return createRequest(scope, { type: "PUBLISH_QUESTION", examId: q.examId, questionId: q.id, reason }, tx);
    });
    return { ok: true, requestId: r.id };
  } catch (e) {
    return fail(e);
  }
}

/** Submit the open DRAFT revision of a PUBLISHED question for approval. */
export async function submitRevision(scope: TeacherScope, questionId: string, reasonIn: unknown): Promise<Result<{ requestId: string }>> {
  try {
    const reason = cleanReason(reasonIn);
    if (!reason) throw new TeacherError(REASON_ERROR);
    const q = await questionInScope(scope, questionId);
    const rev = await prisma.questionRevision.findFirst({ where: { questionId: q.id, status: "DRAFT" } });
    if (!rev) throw new TeacherError("There is no draft revision to submit. Edit the question first.");
    const row = await prisma.question.findUniqueOrThrow({ where: { id: q.id }, select: CONTENT_SELECT });
    if (!sameContent(readContent(rev.baseSnapshot), contentOf(row))) {
      throw new TeacherError("The published question changed after this revision was started. Discard the revision and start again.");
    }
    const proposed = readContent(rev.proposedSnapshot);
    if (sameContent(proposed, readContent(rev.baseSnapshot))) throw new TeacherError("The revision has no changes.");
    const issues = structuralPublishIssues({ reviewRequired: false, reviewReason: null, questionType: proposed.questionType, options: proposed.options, assets: [], text: proposed.text, imageUrl: proposed.imageUrl });
    if (issues.length) throw new TeacherError(`The revised question could not be published: ${issues.map((i) => i.detail).join(" ")}`);
    const r = await prisma.$transaction(async (tx) => {
      const moved = await tx.questionRevision.updateMany({ where: { id: rev.id, status: "DRAFT" }, data: { status: "SUBMITTED", lastEditedById: scope.teacherId } });
      if (moved.count !== 1) throw new TeacherError("The revision changed — reload and try again.");
      return createRequest(scope, { type: "REVISION", examId: q.examId, questionId: q.id, revisionId: rev.id, reason }, tx);
    });
    return { ok: true, requestId: r.id };
  } catch (e) {
    return fail(e);
  }
}

/** Ask for permanent deletion (executed by the Master Admin with Retire / Replace). */
export async function requestDeletion(scope: TeacherScope, questionId: string, reasonIn: unknown): Promise<Result<{ requestId: string }>> {
  try {
    const reason = cleanReason(reasonIn);
    if (!reason) throw new TeacherError(REASON_ERROR);
    const q = await questionInScope(scope, questionId);
    if (q.retiredAt) throw new TeacherError("This question is already retired.");
    if (await openRequest("DELETE_REQUEST", { questionId: q.id })) throw new TeacherError("A deletion request for this question is already open.");
    const r = await prisma.$transaction((tx) => createRequest(scope, { type: "DELETE_REQUEST", examId: q.examId, questionId: q.id, reason }, tx));
    return { ok: true, requestId: r.id };
  } catch (e) {
    return fail(e);
  }
}

/** Withdraw one of the teacher's OWN open requests. An Unpublish notice can't be withdrawn (ask for a restore). */
export async function withdrawRequest(scope: TeacherScope, requestId: string): Promise<Result> {
  try {
    const r = await prisma.teacherContentRequest.findUnique({ where: { id: String(requestId) }, select: { id: true, teacherId: true, examId: true, status: true, type: true, revisionId: true } });
    if (!r || r.teacherId !== scope.teacherId || !examInScope(scope, r.examId)) throw new TeacherAccessError();
    if (r.status !== "OPEN") throw new TeacherError("This request is no longer open.");
    if (r.type === "UNPUBLISH_NOTICE") throw new TeacherError("An unpublish has already taken effect — submit a restore request instead.");
    await prisma.$transaction(async (tx) => {
      const moved = await tx.teacherContentRequest.updateMany({ where: { id: r.id, status: "OPEN" }, data: { status: "WITHDRAWN", decidedAt: new Date() } });
      if (moved.count !== 1) throw new TeacherError("This request is no longer open.");
      if (r.revisionId) await tx.questionRevision.updateMany({ where: { id: r.revisionId, status: "SUBMITTED" }, data: { status: "DRAFT" } });
      await audit(tx, scope.teacherId, "TEACHER_REQUEST_WITHDRAWN", "TeacherContentRequest", r.id);
    });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Unpublish from tests
// ---------------------------------------------------------------------------

/** Attempt / ranking facts shown to the Master Admin with an unpublish. */
export async function mockUnpublishImpact(db: Pick<Prisma.TransactionClient, "testAttempt" | "mockTestQuestion" | "testRankingConfig">, mockTestId: string, questionId: string) {
  const [submitted, inProgress, servable, ranking] = await Promise.all([
    db.testAttempt.count({ where: { mockTestId, status: "SUBMITTED" } }),
    db.testAttempt.count({ where: { mockTestId, status: "IN_PROGRESS" } }),
    db.mockTestQuestion.count({ where: { mockTestId, excludedAt: null, question: SERVABLE_QUESTION_WHERE } }),
    db.testRankingConfig.findUnique({ where: { mockTestId }, select: { leaderboardEnabled: true, countsTowardOverall: true } }),
  ]);
  return {
    questionId,
    submittedAttempts: submitted,
    inProgressAttempts: inProgress,
    servableQuestionsBefore: servable,
    leaderboardEnabled: ranking?.leaderboardEnabled ?? true,
    countsTowardOverall: ranking?.countsTowardOverall ?? false,
  };
}

/**
 * Immediate per-test Unpublish (Mock Tests that are not Live CBT). The row
 * stays in the test (order, history) with excludedAt set: every attempt
 * started from now on skips it; in-progress and finished attempts keep their
 * frozen questions. The Master Admin is notified through the approval queue
 * and can restore it.
 */
export async function unpublishFromMockTest(scope: TeacherScope, mockTestId: string, questionId: string, reasonIn: unknown): Promise<Result<{ requestId: string }>> {
  try {
    const reason = cleanReason(reasonIn);
    if (!reason) throw new TeacherError(REASON_ERROR);
    const mock = await mockTestInScope(scope, mockTestId);
    if (mock.enrollmentEnabled) throw new TeacherError("This is a Live CBT test: submit an unpublish request instead — it takes effect after Master Admin approval.");
    const r = await prisma.$transaction(async (tx) => {
      const row = await tx.mockTestQuestion.findUnique({ where: { mockTestId_questionId: { mockTestId: mock.id, questionId: String(questionId) } }, select: { id: true, excludedAt: true, question: { select: { examId: true } } } });
      if (!row) throw new TeacherAccessError();
      if (row.excludedAt) throw new TeacherError("This question is already unpublished from this test.");
      const impact = await mockUnpublishImpact(tx, mock.id, String(questionId));
      if (mock.status === "PUBLISHED" && impact.servableQuestionsBefore <= 1) {
        throw new TeacherError("This is the last question students can get in this published test. Ask the Master Admin to unpublish the whole test instead.");
      }
      const moved = await tx.mockTestQuestion.updateMany({ where: { id: row.id, excludedAt: null }, data: { excludedAt: new Date(), excludedById: scope.teacherId, excludedReason: reason } });
      if (moved.count !== 1) throw new TeacherError("This question was just changed — reload and try again.");
      await audit(tx, scope.teacherId, "TEACHER_QUESTION_UNPUBLISHED", "MockTest", mock.id, { questionId: String(questionId), reason });
      return createRequest(scope, { type: "UNPUBLISH_NOTICE", examId: mock.examId, questionId: String(questionId), targetKind: "MOCK_TEST", targetId: mock.id, reason, impact }, tx);
    });
    return { ok: true, requestId: r.id };
  } catch (e) {
    return fail(e);
  }
}

export type UnpublishTargetKind = "MOCK_TEST" | "GRAND_TEST" | "LIVE_TEST" | "PYQ_PAPER";
const TARGET_KINDS: UnpublishTargetKind[] = ["MOCK_TEST", "GRAND_TEST", "LIVE_TEST", "PYQ_PAPER"];

/** The question must really be in the target, and the target in an assigned exam. */
async function targetInScope(scope: TeacherScope, kind: UnpublishTargetKind, targetId: string, questionId: string): Promise<{ examId: string; title: string; liveCbt: boolean }> {
  const id = String(targetId);
  const qid = String(questionId);
  let t: { examId: string; title: string; liveCbt: boolean; member: boolean } | null = null;
  if (kind === "MOCK_TEST") {
    const m = await prisma.mockTest.findUnique({ where: { id }, select: { examId: true, title: true, enrollmentEnabled: true, questions: { where: { questionId: qid }, select: { id: true } } } });
    t = m && { examId: m.examId, title: m.title, liveCbt: m.enrollmentEnabled, member: m.questions.length > 0 };
  } else if (kind === "GRAND_TEST") {
    const g = await prisma.grandTest.findUnique({ where: { id }, select: { examId: true, title: true, questions: { where: { questionId: qid }, select: { id: true } } } });
    t = g && { examId: g.examId, title: g.title, liveCbt: false, member: g.questions.length > 0 };
  } else if (kind === "LIVE_TEST") {
    const l = await prisma.liveTest.findUnique({ where: { id }, select: { examId: true, title: true, questions: { where: { questionId: qid }, select: { id: true } } } });
    t = l && { examId: l.examId, title: l.title, liveCbt: false, member: l.questions.length > 0 };
  } else {
    const p = await prisma.previousYearPaper.findUnique({ where: { id }, select: { examId: true, title: true } });
    const member = p ? (await prisma.question.count({ where: { id: qid, previousYearPaperId: id } })) > 0 : false;
    t = p && { examId: p.examId, title: p.title, liveCbt: false, member };
  }
  if (!t || !t.member || !examInScope(scope, t.examId)) throw new TeacherAccessError();
  return t;
}

/** Unpublish that waits for approval: Live CBT Mock Tests, Grand Tests, Live Tests and PYQ papers. */
export async function requestUnpublish(scope: TeacherScope, kindIn: string, targetId: string, questionId: string, reasonIn: unknown): Promise<Result<{ requestId: string }>> {
  try {
    const reason = cleanReason(reasonIn);
    if (!reason) throw new TeacherError(REASON_ERROR);
    const kind = TARGET_KINDS.find((k) => k === kindIn);
    if (!kind) throw new TeacherAccessError();
    const t = await targetInScope(scope, kind, targetId, questionId);
    if (kind === "MOCK_TEST" && !t.liveCbt) throw new TeacherError("This Mock Test is not a Live CBT: unpublish the question directly.");
    if (await openRequest("UNPUBLISH_REQUEST", { questionId: String(questionId), targetKind: kind, targetId: String(targetId) })) {
      throw new TeacherError("An unpublish request for this question in this test is already open.");
    }
    const impact = kind === "MOCK_TEST" ? await mockUnpublishImpact(prisma, String(targetId), String(questionId)) : undefined;
    const r = await prisma.$transaction((tx) =>
      createRequest(scope, { type: "UNPUBLISH_REQUEST", examId: t.examId, questionId: String(questionId), targetKind: kind, targetId: String(targetId), reason, impact }, tx)
    );
    return { ok: true, requestId: r.id };
  } catch (e) {
    return fail(e);
  }
}

/** Ask the Master Admin to put an unpublished question back into a Mock Test. */
export async function requestRestore(scope: TeacherScope, mockTestId: string, questionId: string, reasonIn: unknown): Promise<Result<{ requestId: string }>> {
  try {
    const reason = cleanReason(reasonIn);
    if (!reason) throw new TeacherError(REASON_ERROR);
    const mock = await mockTestInScope(scope, mockTestId);
    const row = await prisma.mockTestQuestion.findUnique({ where: { mockTestId_questionId: { mockTestId: mock.id, questionId: String(questionId) } }, select: { excludedAt: true } });
    if (!row) throw new TeacherAccessError();
    if (!row.excludedAt) throw new TeacherError("This question is not unpublished from this test.");
    if (await openRequest("RESTORE_REQUEST", { questionId: String(questionId), targetKind: "MOCK_TEST", targetId: mock.id })) {
      throw new TeacherError("A restore request for this question is already open.");
    }
    const r = await prisma.$transaction((tx) =>
      createRequest(scope, { type: "RESTORE_REQUEST", examId: mock.examId, questionId: String(questionId), targetKind: "MOCK_TEST", targetId: mock.id, reason }, tx)
    );
    return { ok: true, requestId: r.id };
  } catch (e) {
    return fail(e);
  }
}
