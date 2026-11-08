import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { CONTENT_SELECT, contentOf, diffContent, readContent, sameContent, type QuestionContent } from "@/lib/question-content";
import { getQuestionDependencies } from "@/lib/question-dependencies";
import { effectiveStatuses, isManualFollowUp } from "@/lib/teacher/request-status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flash, ReasonForm, RequestStatusBadge, REQUEST_TYPE_LABEL, TARGET_KIND_LABEL, fmtDate } from "@/components/teacher/ui";
import { approveTeacherRequestAction, rejectTeacherRequestAction } from "../../actions";

export const metadata = { title: "Teacher Request — Mock Test Series.in Admin" };

type Impact = { submittedAttempts?: number; inProgressAttempts?: number; servableQuestionsBefore?: number; leaderboardEnabled?: boolean; countsTowardOverall?: boolean };

async function targetTitle(kind: string | null, id: string | null): Promise<string | null> {
  if (!kind || !id) return null;
  if (kind === "MOCK_TEST") return (await prisma.mockTest.findUnique({ where: { id }, select: { title: true } }))?.title ?? "(deleted test)";
  if (kind === "GRAND_TEST") return (await prisma.grandTest.findUnique({ where: { id }, select: { title: true } }))?.title ?? "(deleted test)";
  if (kind === "LIVE_TEST") return (await prisma.liveTest.findUnique({ where: { id }, select: { title: true } }))?.title ?? "(deleted test)";
  const p = await prisma.previousYearPaper.findUnique({ where: { id }, select: { title: true, year: true } });
  return p ? `${p.year} — ${p.title}` : "(deleted paper)";
}

async function nameMap(c: (QuestionContent | null)[]) {
  const ids = [...new Set(c.flatMap((x) => (x ? [x.examId, x.subjectId, x.topicId, x.subTopicId] : [])).filter((v): v is string => !!v))];
  const [ex, su, to, st] = await Promise.all([
    prisma.exam.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.subject.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.topic.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.subTopic.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  ]);
  const m = new Map([...ex, ...su, ...to, ...st].map((x) => [x.id, x.name]));
  return (id: string | null) => (id ? m.get(id) ?? id : "—");
}

export default async function TeacherRequestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const session = await getAdminSession();
  const perms = session?.user?.permissions ?? [];
  if (!perms.includes(PERMISSIONS.TEACHER_APPROVALS_VIEW)) notFound();
  const canDecide = perms.includes(PERMISSIONS.TEACHER_APPROVALS_MANAGE) && session?.user?.role === "MASTER_ADMIN";
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const r = await prisma.teacherContentRequest.findUnique({
    where: { id },
    include: { teacher: { select: { name: true, username: true } }, exam: { select: { name: true } }, question: { select: { id: true, code: true, status: true, retiredAt: true } }, revision: true },
  });
  if (!r) notFound();
  const reviewer = r.reviewerId ? await prisma.adminUser.findUnique({ where: { id: r.reviewerId }, select: { name: true } }) : null;
  const live = r.questionId ? await prisma.question.findUnique({ where: { id: r.questionId }, select: CONTENT_SELECT }) : null;
  const liveContent = live ? contentOf(live) : null;
  const base = r.revision ? readContent(r.revision.baseSnapshot) : null;
  const proposed = r.revision ? readContent(r.revision.proposedSnapshot) : null;
  const names = await nameMap([base, proposed, liveContent]);
  const changes = proposed ? diffContent(base, proposed, names) : [];
  const stale = !!(r.revision && liveContent && base && !sameContent(base, liveContent));
  const deps = r.questionId ? (await getQuestionDependencies([r.questionId])).get(r.questionId) : undefined;
  const target = await targetTitle(r.targetKind, r.targetId);
  const impact = (r.impact ?? null) as Impact | null;
  const exclusion = r.targetKind === "MOCK_TEST" && r.targetId && r.questionId
    ? await prisma.mockTestQuestion.findUnique({ where: { mockTestId_questionId: { mockTestId: r.targetId, questionId: r.questionId } }, select: { excludedAt: true } })
    : null;
  const timeline = await prisma.auditLog.findMany({
    where: { OR: [{ entityType: "TeacherContentRequest", entityId: r.id }, ...(r.revisionId ? [{ entityType: "QuestionRevision", entityId: r.revisionId }] : [])] },
    orderBy: { createdAt: "asc" },
    select: { action: true, createdAt: true, metadata: true, actor: { select: { name: true } } },
  });
  const hid = { requestId: r.id };
  const effective = (await effectiveStatuses([r])).get(r.id) ?? "PENDING";
  const manual = isManualFollowUp(r);
  const replaceHref = r.questionId ? `/admin/questions/${r.questionId}/replace` : null;
  const approveLabel: Record<string, string> = {
    PUBLISH_QUESTION: "Approve and publish",
    REVISION: "Approve and apply revision",
    UNPUBLISH_NOTICE: "Keep unpublished",
    UNPUBLISH_REQUEST: r.targetKind === "MOCK_TEST" ? "Approve and unpublish from this test" : "Approve (then apply with Retire / Replace)",
    RESTORE_REQUEST: "Approve and restore",
    DELETE_REQUEST: "Approve deletion (then apply with Retire / Replace)",
  };
  return (
    <div className="flex flex-col gap-5">
      <Link href="/admin/users/teachers/approvals" className="text-sm underline">← Approval queue</Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{REQUEST_TYPE_LABEL[r.type]}</h1>
        <RequestStatusBadge status={effective} />
      </div>
      <Flash err={sp.err} />
      {sp.ok ? <p className="text-sm text-[var(--color-success)]">{sp.ok}</p> : null}
      <Card>
        <CardContent className="flex flex-col gap-1 py-4 text-sm">
          <p><span className="text-[var(--color-muted-foreground)]">Teacher:</span> {r.teacher.name} (@{r.teacher.username})</p>
          <p><span className="text-[var(--color-muted-foreground)]">Exam:</span> {r.exam.name}</p>
          {r.question ? <p><span className="text-[var(--color-muted-foreground)]">Question:</span> <Link className="font-mono underline" href={`/admin/questions/add?id=${r.question.id}`}>{r.question.code}</Link> <Badge>{r.question.retiredAt ? "retired" : r.question.status.toLowerCase()}</Badge></p> : null}
          {target ? <p><span className="text-[var(--color-muted-foreground)]">{TARGET_KIND_LABEL[r.targetKind ?? ""] ?? "Target"}:</span> {target}{exclusion ? (exclusion.excludedAt ? " — currently unpublished from this test" : " — currently served in this test") : ""}</p> : null}
          <p><span className="text-[var(--color-muted-foreground)]">Reason:</span> {r.reason}</p>
          <p className="text-[var(--color-muted-foreground)]">Sent {fmtDate(r.createdAt)}{r.decidedAt ? ` · decided ${fmtDate(r.decidedAt)}${reviewer ? ` by ${reviewer.name}` : ""}` : ""}</p>
          {r.decisionNote ? <p>Decision note: {r.decisionNote}</p> : null}
        </CardContent>
      </Card>

      {impact ? (
        <Card>
          <CardHeader><CardTitle>Impact (when the request was made)</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <p>{impact.submittedAttempts ?? 0} submitted and {impact.inProgressAttempts ?? 0} in-progress attempt(s) of this test keep the question — their answers, scores and results do not change.</p>
            <p>New attempts get {Math.max(0, (impact.servableQuestionsBefore ?? 0) - 1)} question(s) instead of {impact.servableQuestionsBefore ?? 0}.</p>
            <p>
              Ranking: leaderboard {impact.leaderboardEnabled ? "ON" : "OFF"}{impact.countsTowardOverall ? ", counts toward Overall Rank" : ""}.
              {impact.leaderboardEnabled && (impact.submittedAttempts ?? 0) > 0 ? " Scores of attempts before and after this change are out of a different number of questions, so ranks across them are not strictly comparable." : ""}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {r.type === "REVISION" && proposed ? (
        <Card>
          <CardHeader><CardTitle>Before / after</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto text-sm">
            {stale ? <p className="mb-2 text-[var(--color-error)]">The live question has changed since this revision was made. Approving will be refused; reject it and ask the teacher to start again.</p> : null}
            <table className="w-full">
              <thead className="text-left text-[var(--color-muted-foreground)]"><tr><th className="py-1 pr-3">Field</th><th className="pr-3">Before</th><th>After</th></tr></thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.field} className="border-t border-[var(--color-border)] align-top">
                    <td className="py-1 pr-3 font-medium">{c.field}</td>
                    <td className="whitespace-pre-wrap pr-3 text-[var(--color-error)]">{c.before || "—"}</td>
                    <td className="whitespace-pre-wrap text-[var(--color-success)]">{c.after || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}

      {r.type !== "REVISION" && liveContent ? (
        <Card>
          <CardHeader><CardTitle>Question (current)</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <p className="whitespace-pre-wrap">{liveContent.text}</p>
            {liveContent.options.map((o) => <p key={o.label} className={o.isCorrect ? "font-medium text-[var(--color-success)]" : ""}>{o.label}. {o.text}{o.isCorrect ? " ✓" : ""}</p>)}
          </CardContent>
        </Card>
      ) : null}

      {deps ? (
        <Card>
          <CardHeader><CardTitle>Where this question is used</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <p>
              Attempts: {deps.attempts.submitted} submitted · {deps.attempts.inProgress} in progress · {deps.attempts.abandoned} abandoned. Used in {deps.mockTests} mock test(s), {deps.grandOrLive} grand/live test(s), {deps.adminModules} admin and {deps.studentModules} student module(s){deps.paperTitle ? ` · PYQ paper ${deps.paperTitle}` : ""}. {deps.bookmarks} bookmark(s), {deps.reports} report(s).
            </p>
            {deps.uses.slice(0, 25).map((u) => <p key={`${u.kind}-${u.id}`} className="text-[var(--color-muted-foreground)]">{u.kind.replaceAll("_", " ").toLowerCase()}: {u.title} (position {u.position}, {u.status.toLowerCase()})</p>)}
          </CardContent>
        </Card>
      ) : null}

      {manual && r.status !== "REJECTED" && r.status !== "WITHDRAWN" ? (
        <Card data-testid="follow-up">
          <CardHeader><CardTitle>{effective === "APPLIED" ? "Applied" : r.status === "OPEN" ? "After approval" : "Action not yet applied"}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {effective === "APPLIED" ? (
              <p>The change is in effect: {r.type === "DELETE_REQUEST" ? "the question is retired or deleted" : `the question is no longer in this ${TARGET_KIND_LABEL[r.targetKind ?? ""] ?? "test"}`}.</p>
            ) : (
              <>
                <p>
                  {r.type === "DELETE_REQUEST"
                    ? "Approving records the decision only. Retire or replace the question with Retire / Replace — it shows the full impact preview and asks for confirmation. Attempts and results are kept."
                    : `There is no per-test unpublish for a ${TARGET_KIND_LABEL[r.targetKind ?? ""] ?? "test"} in Phase A. Approving records the decision only; make the change with Retire / Replace.`}
                </p>
                {replaceHref && canDecide ? (
                  <p><Link className="font-medium underline" href={replaceHref} data-testid="retire-replace-link">Open Retire / Replace preview for {r.question?.code ?? "this question"} →</Link></p>
                ) : null}
                {r.status === "APPROVED" ? <p className="text-[var(--color-muted-foreground)]">This request shows as &ldquo;Applied&rdquo; automatically once the question is retired{r.type === "UNPUBLISH_REQUEST" ? ` or no longer in this ${TARGET_KIND_LABEL[r.targetKind ?? ""] ?? "test"}` : " or deleted"}.</p> : null}
              </>
            )}
          </CardContent>
        </Card>
      ) : null}

      {r.status === "OPEN" && canDecide ? (
        <Card>
          <CardHeader><CardTitle>Decision</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ReasonForm action={approveTeacherRequestAction} hidden={hid} label={approveLabel[r.type]} button={approveLabel[r.type]} variant="primary" required={false} field="note" placeholder="Note to the teacher (optional)" />
            <ReasonForm
              action={rejectTeacherRequestAction}
              hidden={hid}
              label={r.type === "UNPUBLISH_NOTICE" ? "Restore the question to the test" : "Reject"}
              button={r.type === "UNPUBLISH_NOTICE" ? "Restore" : "Reject"}
              variant="danger"
              field="note"
              required={r.type !== "UNPUBLISH_NOTICE"}
              placeholder={r.type === "UNPUBLISH_NOTICE" ? "Note to the teacher (optional)" : "Reason for the teacher (required)"}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>History</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          {timeline.map((t, i) => (
            <p key={i}><span className="text-[var(--color-muted-foreground)]">{fmtDate(t.createdAt)}</span> · {t.action.replaceAll("_", " ").toLowerCase()} · {t.actor?.name ?? "system"}</p>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
