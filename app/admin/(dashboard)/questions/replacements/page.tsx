import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ReplacementSummary } from "@/lib/question-replacement/plan";
import { RollbackButton } from "./rollback-button";

export const metadata = { title: "Question Replacement History — Mock Test Series.in Admin" };

/** Every Retire / Replace, newest first, with what it changed and its rollback (docs/QUESTION-RETIREMENT.md). */
export default async function ReplacementHistoryPage() {
  const [records, session] = await Promise.all([
    prisma.questionReplacement.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { items: { select: { oldQuestionId: true, newQuestionId: true } } },
    }),
    getAdminSession(),
  ]);
  const ids = [...new Set(records.flatMap((r) => r.items.flatMap((i) => [i.oldQuestionId, i.newQuestionId]).filter((x): x is string => !!x)))];
  const codes = new Map((await prisma.question.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })).map((q) => [q.id, q.code]));
  const admins = new Map(
    (await prisma.adminUser.findMany({ where: { id: { in: records.map((r) => r.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((a) => [a.id, a.name])
  );
  const isMaster = session?.user?.role === "MASTER_ADMIN";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/admin/questions" className="text-xs text-[var(--color-primary)] hover:underline">
          ← Question Bank
        </Link>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Question Replacement History</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Every retired or replaced question, what it changed, and its rollback.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Replacements</CardTitle>
          <CardDescription>{records.length} record(s)</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {records.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No question has been retired or replaced yet.</p>
          ) : (
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">When (UTC)</th>
                  <th className="py-2 pr-4">Change</th>
                  <th className="py-2 pr-4">Questions</th>
                  <th className="py-2 pr-4">Effect</th>
                  <th className="py-2 pr-4">By</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {records.map((r) => {
                  const s = r.summary as unknown as ReplacementSummary | null;
                  return (
                    <tr key={r.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                      <td className="py-2.5 pr-4 font-mono text-xs">{r.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                      <td className="py-2.5 pr-4">
                        {r.kind === "REPLACE" ? "Replaced" : "Retired"}
                        <div className="text-xs text-[var(--color-muted-foreground)]">{r.reason}</div>
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-xs">
                        {r.items.slice(0, 6).map((i) => (
                          <div key={i.oldQuestionId}>
                            <Link className="text-[var(--color-primary)] hover:underline" href={`/admin/questions/${i.oldQuestionId}/replace`}>
                              {codes.get(i.oldQuestionId) ?? i.oldQuestionId}
                            </Link>
                            {i.newQuestionId ? ` → ${codes.get(i.newQuestionId) ?? i.newQuestionId}` : ""}
                          </div>
                        ))}
                        {r.items.length > 6 ? <div>+{r.items.length - 6} more</div> : null}
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                        {s
                          ? `${s.references.swap} swapped · ${s.references.hold} held · ${s.references.skip} left out · ${s.attemptsInvalidated} attempt(s) reset${s.variantsRetired ? ` · ${s.variantsRetired} variant(s)` : ""}`
                          : "—"}
                      </td>
                      <td className="py-2.5 pr-4 text-xs">{r.createdById ? (admins.get(r.createdById) ?? "Admin") : r.createdBySource}</td>
                      <td className="py-2.5 pr-4">
                        <Badge variant={r.status === "APPLIED" ? "warning" : "neutral"}>{r.status === "APPLIED" ? "Applied" : "Rolled back"}</Badge>
                      </td>
                      <td className="py-2.5 pr-4">{isMaster && r.status === "APPLIED" ? <RollbackButton replacementId={r.id} /> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
