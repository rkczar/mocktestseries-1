import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { effectiveStatuses } from "@/lib/teacher/request-status";
import { Card, CardContent } from "@/components/ui/card";
import { Pager, RequestStatusBadge, REQUEST_TYPE_LABEL, TARGET_KIND_LABEL, fmtDate } from "@/components/teacher/ui";

export const metadata = { title: "Teacher Content Approvals — Mock Test Series.in Admin" };
const SIZE = 30;
const STATUSES = ["OPEN", "APPROVED", "REJECTED", "WITHDRAWN"] as const;
const TAB_LABEL: Record<string, string> = { OPEN: "Pending", NOT_APPLIED: "Approved — action not yet applied", APPROVED: "All approved", REJECTED: "Rejected", WITHDRAWN: "Withdrawn" };
const MANUAL_TYPES = { OR: [{ type: "DELETE_REQUEST" as const }, { type: "UNPUBLISH_REQUEST" as const, targetKind: { not: "MOCK_TEST" } }] };

export default async function TeacherApprovalsPage({ searchParams }: { searchParams: Promise<{ status?: string; type?: string; page?: string }> }) {
  if (!(await hasPermission(PERMISSIONS.TEACHER_APPROVALS_VIEW))) notFound();
  const sp = await searchParams;
  const notApplied = sp.status === "NOT_APPLIED";
  const status = notApplied ? "APPROVED" : STATUSES.find((s) => s === sp.status) ?? "OPEN";
  const type = Object.keys(REQUEST_TYPE_LABEL).find((t) => t === sp.type) as keyof typeof REQUEST_TYPE_LABEL | undefined;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const include = { teacher: { select: { name: true } }, exam: { select: { name: true } }, question: { select: { code: true } } } as const;
  // "Approved — action not yet applied" is derived from the current question/test state (lib/teacher/request-status.ts).
  const manualApproved = await prisma.teacherContentRequest.findMany({ where: { status: "APPROVED", ...MANUAL_TYPES }, orderBy: { decidedAt: "asc" }, take: 1000, include });
  const manualEff = await effectiveStatuses(manualApproved);
  const pendingAction = manualApproved.filter((r) => manualEff.get(r.id) === "NOT_APPLIED" && (!type || r.type === type));
  const where: Prisma.TeacherContentRequestWhereInput = { status, ...(type ? { type } : {}) };
  const [total, pageRows, counts] = await Promise.all([
    notApplied ? Promise.resolve(pendingAction.length) : prisma.teacherContentRequest.count({ where }),
    notApplied
      ? Promise.resolve(pendingAction.slice((page - 1) * SIZE, page * SIZE))
      : prisma.teacherContentRequest.findMany({ where, orderBy: { createdAt: status === "OPEN" ? "asc" : "desc" }, skip: (page - 1) * SIZE, take: SIZE, include }),
    prisma.teacherContentRequest.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const rows = pageRows;
  const eff = await effectiveStatuses(rows);
  const count = (s: string) => (s === "NOT_APPLIED" ? pendingAction.length : counts.find((c) => c.status === s)?._count._all ?? 0);
  const tab = notApplied ? "NOT_APPLIED" : status;
  const href = (p: Record<string, string>) => `/admin/users/teachers/approvals?${new URLSearchParams({ status: tab, ...(type ? { type } : {}), ...p })}`;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Teacher Content Approvals</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Publishing, changes to published questions, unpublish notices, restores and deletion requests from teachers. Only the Master Admin can decide.</p>
      </div>
      <nav className="flex flex-wrap gap-3 text-sm">
        {["OPEN", "NOT_APPLIED", "APPROVED", "REJECTED", "WITHDRAWN"].map((s) => (
          <Link key={s} href={`/admin/users/teachers/approvals?status=${s}`} className={s === tab ? "font-semibold underline" : "underline text-[var(--color-muted-foreground)]"}>
            {TAB_LABEL[s]} ({count(s)})
          </Link>
        ))}
      </nav>
      <form className="flex flex-wrap gap-2 text-sm">
        <input type="hidden" name="status" value={tab} />
        <select name="type" defaultValue={type ?? ""} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1">
          <option value="">All types</option>
          {Object.entries(REQUEST_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button type="submit" className="rounded border border-[var(--color-border)] px-3 py-1">Filter</button>
      </form>
      <Card>
        <CardContent className="overflow-x-auto py-3">
          {rows.length === 0 ? <p className="text-sm text-[var(--color-muted-foreground)]">Nothing here.</p> : (
            <table className="w-full text-sm">
              <thead className="text-left text-[var(--color-muted-foreground)]"><tr><th className="py-2 pr-3">Type</th><th className="pr-3">Teacher</th><th className="pr-3">Exam</th><th className="pr-3">Question</th><th className="pr-3">Reason</th><th className="pr-3">Sent</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-[var(--color-border)] align-top">
                    <td className="py-2 pr-3"><Link className="underline" href={`/admin/users/teachers/approvals/${r.id}`}>{REQUEST_TYPE_LABEL[r.type]}</Link>{r.targetKind ? <span className="block text-xs text-[var(--color-muted-foreground)]">{TARGET_KIND_LABEL[r.targetKind] ?? r.targetKind}</span> : null}</td>
                    <td className="pr-3">{r.teacher.name}</td>
                    <td className="pr-3">{r.exam.name}</td>
                    <td className="pr-3 font-mono text-xs">{r.question?.code ?? "—"}</td>
                    <td className="max-w-xs pr-3">{r.reason}</td>
                    <td className="whitespace-nowrap pr-3">{fmtDate(r.createdAt)}</td>
                    <td><RequestStatusBadge status={eff.get(r.id) ?? "PENDING"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <Pager page={page} pages={Math.max(1, Math.ceil(total / SIZE))} href={(p) => href({ page: String(p) })} />
    </div>
  );
}
