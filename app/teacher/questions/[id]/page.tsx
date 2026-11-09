import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { inScopeOr404, requireTeacherPage } from "@/lib/teacher/page";
import { questionInScope } from "@/lib/teacher/scope";
import { CONTENT_SELECT, contentOf, diffContent, readContent, sameContent } from "@/lib/question-content";
import { parseQuestionListFilters, questionListQuery } from "@/lib/teacher/queries";
import { QuestionPreviewBody } from "@/components/content/question-preview-body";
import { QUESTION_PREVIEW_SELECT } from "@/lib/question-preview";
import { effectiveStatuses } from "@/lib/teacher/request-status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PendingSubmitButton } from "@/components/ui/pending-submit-button";
import { Flash, QuestionStatusBadge, ReasonForm, RequestStatusBadge, REQUEST_TYPE_LABEL, TARGET_KIND_LABEL, fmtDate } from "@/components/teacher/ui";
import { discardRevisionAction, requestDeletionAction, requestUnpublishAction, submitForPublicationAction, submitRevisionAction } from "@/app/teacher/actions";

export const metadata = { title: "Question — Teacher Portal" };

export default async function TeacherQuestion({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string; from?: string }> }) {
  const scope = await requireTeacherPage();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const q = await inScopeOr404(() => questionInScope(scope, id));
  const [row, extra, rev, requests, history, mocks, grands, lives, paper] = await Promise.all([
    prisma.question.findUniqueOrThrow({ where: { id: q.id }, select: CONTENT_SELECT }),
    prisma.question.findUniqueOrThrow({ where: { id: q.id }, select: { ...QUESTION_PREVIEW_SELECT, createdByAdminId: true, createdAt: true, exam: { select: { name: true } }, subject: { select: { name: true } }, topic: { select: { name: true } }, subTopic: { select: { name: true } } } }),
    prisma.questionRevision.findFirst({ where: { questionId: q.id, status: { in: ["DRAFT", "SUBMITTED"] } } }),
    prisma.teacherContentRequest.findMany({ where: { questionId: q.id, examId: { in: scope.examIds } }, orderBy: { createdAt: "desc" }, take: 30, include: { teacher: { select: { name: true } } } }),
    prisma.auditLog.findMany({ where: { entityType: "Question", entityId: q.id }, orderBy: { createdAt: "desc" }, take: 20, select: { action: true, createdAt: true, actor: { select: { name: true } } } }),
    prisma.mockTestQuestion.findMany({ where: { questionId: q.id, mockTest: { examId: { in: scope.examIds } } }, select: { excludedAt: true, mockTest: { select: { id: true, title: true, status: true, enrollmentEnabled: true } } } }),
    prisma.grandTestQuestion.findMany({ where: { questionId: q.id, grandTest: { examId: { in: scope.examIds } } }, select: { grandTest: { select: { id: true, title: true, status: true } } } }),
    prisma.liveTestQuestion.findMany({ where: { questionId: q.id, liveTest: { examId: { in: scope.examIds } } }, select: { liveTest: { select: { id: true, title: true, status: true } } } }),
    q.previousYearPaperId ? prisma.previousYearPaper.findFirst({ where: { id: q.previousYearPaperId, examId: { in: scope.examIds } }, select: { id: true, title: true, year: true } }) : null,
  ]);
  const eff = await effectiveStatuses(requests);
  const author = extra.createdByAdminId ? await prisma.adminUser.findUnique({ where: { id: extra.createdByAdminId }, select: { name: true } }) : null;
  const content = contentOf(row);
  const readOnly = !!q.retiredAt || q.status === "ARCHIVED";
  const openPublish = requests.find((r) => r.type === "PUBLISH_QUESTION" && r.status === "OPEN");
  const openDelete = requests.find((r) => r.type === "DELETE_REQUEST" && r.status === "OPEN");
  const revStale = rev ? !sameContent(readContent(rev.baseSnapshot), content) : false;
  const revChanges = rev ? diffContent(readContent(rev.baseSnapshot), readContent(rev.proposedSnapshot)) : [];
  const hid = { questionId: q.id };
  return (
    <>
      <Link href={`/teacher/questions?${questionListQuery(parseQuestionListFilters(new URLSearchParams(sp.from ?? "")))}`} className="w-fit text-sm underline">← Back to the question list</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg font-semibold">{q.code}</h1>
        <QuestionStatusBadge status={q.status} retired={!!q.retiredAt} />
        {!readOnly && !openPublish ? <Link href={`/teacher/questions/${q.id}/edit`} className="text-sm underline">{q.status === "PUBLISHED" ? (rev ? "Continue revision" : "Edit (creates a revision)") : "Edit draft"}</Link> : null}
      </div>
      <Flash ok={sp.ok} err={sp.err} />
      <Card>
        <CardHeader><CardTitle>Question</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-[var(--color-muted-foreground)]">
            {extra.exam.name} · {extra.subject.name}
            {extra.topic ? ` › ${extra.topic.name}` : ""}
            {extra.subTopic ? ` › ${extra.subTopic.name}` : ""} · {content.difficulty.toLowerCase()} · {content.questionType.replaceAll("_", " ").toLowerCase()}
          </p>
          <div className="flex flex-col gap-3" data-testid="full-preview">
            <QuestionPreviewBody q={extra} />
          </div>
          <p className="text-xs text-[var(--color-muted-foreground)]">Created {fmtDate(extra.createdAt)}{author ? ` by ${author.name}` : ""}{history[0] ? ` · last change: ${history[0].action.replaceAll("_", " ").toLowerCase()} by ${history[0].actor?.name ?? "system"}, ${fmtDate(history[0].createdAt)}` : ""}</p>
        </CardContent>
      </Card>

      {readOnly ? null : (
        <Card>
          <CardHeader><CardTitle>Actions</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            {q.status === "DRAFT" ? (
              openPublish ? <p className="text-sm">Waiting for publication approval (withdraw it from My Requests to edit again).</p> : (
                <ReasonForm action={submitForPublicationAction} hidden={hid} label="Submit for publication" button="Submit for approval" variant="primary" />
              )
            ) : null}
            {q.status === "PUBLISHED" && rev ? (
              <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm">
                <p className="font-medium">Open revision ({rev.status === "DRAFT" ? "draft" : "waiting for approval"}){revStale ? " — out of date" : ""}</p>
                {revStale ? <p className="text-[var(--color-error)]">The published question changed after this revision was started. Discard it and start again.</p> : null}
                <ul className="list-disc pl-5">
                  {revChanges.map((c) => <li key={c.field}><span className="font-medium">{c.field}:</span> {c.before || "—"} → {c.after || "—"}</li>)}
                </ul>
                {rev.status === "DRAFT" ? (
                  <div className="flex flex-col gap-2">
                    {!revStale ? <ReasonForm action={submitRevisionAction} hidden={hid} label="Submit revision for approval" button="Submit revision" variant="primary" /> : null}
                    <form action={discardRevisionAction}>
                      <input type="hidden" name="questionId" value={q.id} />
                      <PendingSubmitButton size="sm" variant="outline">Discard revision</PendingSubmitButton>
                    </form>
                  </div>
                ) : null}
              </div>
            ) : null}
            {openDelete ? <p className="text-sm">A permanent deletion request is waiting for the Master Admin.</p> : (
              <ReasonForm action={requestDeletionAction} hidden={hid} label="Request permanent deletion" button="Send deletion request" variant="danger" />
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Used in</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {mocks.length + grands.length + lives.length + (paper ? 1 : 0) === 0 ? <p className="text-[var(--color-muted-foreground)]">Not used in any test of your exams.</p> : null}
          {mocks.map((m) => (
            <div key={m.mockTest.id} className="flex flex-wrap items-center gap-2">
              <Badge>{m.mockTest.enrollmentEnabled ? "Live CBT" : "Mock Test"}</Badge>
              <Link className="underline" href={`/teacher/tests/${m.mockTest.id}`}>{m.mockTest.title}</Link>
              {m.excludedAt ? <Badge variant="warning">Unpublished from this test</Badge> : null}
            </div>
          ))}
          {[
            ...grands.map((g) => ({ kind: "GRAND_TEST", id: g.grandTest.id, title: g.grandTest.title })),
            ...lives.map((l) => ({ kind: "LIVE_TEST", id: l.liveTest.id, title: l.liveTest.title })),
            ...(paper ? [{ kind: "PYQ_PAPER", id: paper.id, title: `${paper.year} — ${paper.title}` }] : []),
          ].map((t) => (
            <div key={t.kind + t.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2"><Badge>{TARGET_KIND_LABEL[t.kind]}</Badge><span>{t.title}</span></div>
              {readOnly ? null : (
                <ReasonForm action={requestUnpublishAction} hidden={{ questionId: q.id, targetKind: t.kind, targetId: t.id }} label="Request unpublish (takes effect after approval)" button="Send unpublish request" />
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Requests and history</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {requests.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-2 last:border-0">
              <RequestStatusBadge status={eff.get(r.id) ?? "PENDING"} />
              <span className="font-medium">{REQUEST_TYPE_LABEL[r.type]}</span>
              <span className="text-[var(--color-muted-foreground)]">by {r.teacher.name}, {fmtDate(r.createdAt)} — “{r.reason}”</span>
              {r.decisionNote ? <span>Master Admin: “{r.decisionNote}”</span> : null}
            </div>
          ))}
          {history.map((h, i) => (
            <p key={i} className="text-xs text-[var(--color-muted-foreground)]">{fmtDate(h.createdAt)} · {h.action.replaceAll("_", " ").toLowerCase()} · {h.actor?.name ?? "system"}</p>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
