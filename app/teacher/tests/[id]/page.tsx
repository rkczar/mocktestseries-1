import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { inScopeOr404, requireTeacherPage } from "@/lib/teacher/page";
import { examInScope, mockTestInScope } from "@/lib/teacher/scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flash, QuestionStatusBadge, ReasonForm, fmtDate } from "@/components/teacher/ui";
import { requestRestoreAction, requestUnpublishAction, unpublishFromMockTestAction } from "@/app/teacher/actions";

export const metadata = { title: "Mock Test — Teacher Portal" };

export default async function TeacherTest({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const scope = await requireTeacherPage();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const mock = await inScopeOr404(() => mockTestInScope(scope, id));
  const [rows, open] = await Promise.all([
    prisma.mockTestQuestion.findMany({
      where: { mockTestId: mock.id },
      orderBy: { order: "asc" },
      select: { questionId: true, excludedAt: true, excludedReason: true, question: { select: { code: true, text: true, status: true, retiredAt: true, examId: true } } },
    }),
    prisma.teacherContentRequest.findMany({ where: { targetKind: "MOCK_TEST", targetId: mock.id, status: "OPEN" }, select: { type: true, questionId: true } }),
  ]);
  const pending = (type: string, qid: string) => open.some((r) => r.type === type && r.questionId === qid);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{mock.title}</h1>
        {mock.enrollmentEnabled ? <Badge>Live CBT</Badge> : null}
        <Badge variant={mock.status === "PUBLISHED" ? "success" : "neutral"}>{mock.status.toLowerCase()}</Badge>
      </div>
      <Flash ok={sp.ok} err={sp.err} />
      <p className="text-sm text-[var(--color-muted-foreground)]">
        {mock.enrollmentEnabled
          ? "Live CBT: an unpublish request takes effect only after Master Admin approval."
          : "Unpublish removes a question from this test for attempts started afterwards. Attempts already started or finished keep their questions and results. The Master Admin is notified and can restore it."}
      </p>
      <Card>
        <CardHeader><CardTitle>Questions ({rows.length})</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {rows.map((r, i) => {
            const mine = examInScope(scope, r.question.examId);
            const hid = { mockTestId: mock.id, questionId: r.questionId };
            return (
              <div key={r.questionId} className="flex flex-col gap-2 border-b border-[var(--color-border)] pb-3 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-8 text-[var(--color-muted-foreground)]">{i + 1}.</span>
                  {mine ? <Link className="font-mono text-xs underline" href={`/teacher/questions/${r.questionId}`}>{r.question.code}</Link> : <span className="font-mono text-xs">{r.question.code} (another exam)</span>}
                  <QuestionStatusBadge status={r.question.status} retired={!!r.question.retiredAt} />
                  {r.excludedAt ? <Badge variant="warning">Unpublished {fmtDate(r.excludedAt)}</Badge> : null}
                </div>
                {mine ? <p className="max-w-3xl truncate pl-10">{r.question.text}</p> : null}
                {r.excludedAt ? (
                  <div className="pl-10">
                    <p className="text-xs text-[var(--color-muted-foreground)]">Reason: {r.excludedReason}</p>
                    {pending("RESTORE_REQUEST", r.questionId) ? <p className="text-xs">Restore request waiting for approval.</p> : (
                      <ReasonForm action={requestRestoreAction} hidden={hid} label="Request restore" button="Send restore request" />
                    )}
                  </div>
                ) : mock.enrollmentEnabled ? (
                  <div className="pl-10">
                    {pending("UNPUBLISH_REQUEST", r.questionId) ? <p className="text-xs">Unpublish request waiting for approval.</p> : (
                      <ReasonForm action={requestUnpublishAction} hidden={{ questionId: r.questionId, targetKind: "MOCK_TEST", targetId: mock.id }} label="Request unpublish" button="Send unpublish request" />
                    )}
                  </div>
                ) : (
                  <div className="pl-10">
                    <ReasonForm action={unpublishFromMockTestAction} hidden={hid} label="Unpublish from this test" button="Unpublish now" variant="danger" />
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </>
  );
}
