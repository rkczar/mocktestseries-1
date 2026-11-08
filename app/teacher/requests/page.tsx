import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { effectiveStatuses } from "@/lib/teacher/request-status";
import { requireTeacherPage } from "@/lib/teacher/page";
import { Card, CardContent } from "@/components/ui/card";
import { PendingSubmitButton } from "@/components/ui/pending-submit-button";
import { Flash, Pager, RequestStatusBadge, REQUEST_TYPE_LABEL, TARGET_KIND_LABEL, fmtDate } from "@/components/teacher/ui";
import { withdrawRequestAction } from "@/app/teacher/actions";

export const metadata = { title: "My Requests — Teacher Portal" };
const SIZE = 30;

export default async function TeacherRequests({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string; page?: string }> }) {
  const scope = await requireTeacherPage();
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  // Own requests only (other teachers' requests are visible per question).
  const where = { teacherId: scope.teacherId };
  const [total, rows] = await Promise.all([
    prisma.teacherContentRequest.count({ where }),
    prisma.teacherContentRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * SIZE,
      take: SIZE,
      include: { exam: { select: { name: true } }, question: { select: { id: true, code: true, examId: true } } },
    }),
  ]);
  const eff = await effectiveStatuses(rows);
  return (
    <>
      <h1 className="text-xl font-semibold">My Requests</h1>
      <Flash ok={sp.ok} err={sp.err} />
      <Card>
        <CardContent className="flex flex-col gap-3 py-3 text-sm">
          {rows.length === 0 ? <p className="text-[var(--color-muted-foreground)]">No requests yet.</p> : null}
          {rows.map((r) => (
            <div key={r.id} className="flex flex-col gap-1 border-b border-[var(--color-border)] pb-3 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <RequestStatusBadge status={eff.get(r.id) ?? "PENDING"} />
                <span className="font-medium">{REQUEST_TYPE_LABEL[r.type]}</span>
                <span className="text-[var(--color-muted-foreground)]">{r.exam.name}</span>
                {r.question && scope.examIds.includes(r.question.examId) ? <Link className="font-mono text-xs underline" href={`/teacher/questions/${r.question.id}`}>{r.question.code}</Link> : null}
                {r.targetKind ? <span className="text-[var(--color-muted-foreground)]">· {TARGET_KIND_LABEL[r.targetKind] ?? r.targetKind}</span> : null}
              </div>
              <p>Reason: {r.reason}</p>
              <p className="text-xs text-[var(--color-muted-foreground)]">Sent {fmtDate(r.createdAt)}{r.decidedAt ? ` · decided ${fmtDate(r.decidedAt)}` : ""}</p>
              {r.decisionNote ? <p>Master Admin: {r.decisionNote}</p> : null}
              {r.status === "OPEN" && r.type !== "UNPUBLISH_NOTICE" ? (
                <form action={withdrawRequestAction}>
                  <input type="hidden" name="requestId" value={r.id} />
                  <PendingSubmitButton size="sm" variant="outline">Withdraw</PendingSubmitButton>
                </form>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>
      <Pager page={page} pages={Math.max(1, Math.ceil(total / SIZE))} href={(p) => `/teacher/requests?page=${p}`} />
    </>
  );
}
