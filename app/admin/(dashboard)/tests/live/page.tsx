import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { deriveLiveTestState, type DerivedLiveTestState } from "@/lib/live-test";
import { formatIst } from "@/lib/ist-time";
import { LiveTestForm } from "./live-test-form";

export const metadata = { title: "Live Tests — Mock Test Series.in Admin" };

const STATE_BADGE_VARIANT: Record<DerivedLiveTestState, "warning" | "success" | "neutral" | "info" | "error"> = {
  DRAFT: "neutral",
  SCHEDULED: "info",
  LIVE: "success",
  ENDED: "warning",
  RESULT_PUBLISHED: "success",
  CANCELLED: "error",
};

export default async function LiveTestsPage() {
  const [exams, liveTests] = await Promise.all([
    prisma.exam.findMany({
      orderBy: { order: "asc" },
      select: {
        id: true,
        name: true,
        subjects: {
          orderBy: { order: "asc" },
          select: {
            id: true,
            name: true,
            topics: {
              orderBy: { order: "asc" },
              select: { id: true, name: true, subTopics: { orderBy: { order: "asc" }, select: { id: true, name: true } } },
            },
          },
        },
      },
    }),
    prisma.liveTest.findMany({
      orderBy: { startAt: "desc" },
      take: 200,
      include: { exam: true, _count: { select: { questions: true, testAttempts: true } } },
    }),
  ]);

  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Live Tests</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Blueprint-driven, scheduled tests with a shared server-time window. Locking resolves the blueprint once into
          a fixed question set — every student who joins sees the same questions, and no one gets more time than the
          window allows.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New Live Test</CardTitle>
        </CardHeader>
        <CardContent>
          {exams.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">Create an exam first (Admin → Exams).</p>
          ) : (
            <LiveTestForm exams={exams} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Live Tests</CardTitle>
          <CardDescription>{liveTests.length} total</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {liveTests.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No live tests yet.</p>
          ) : (
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Window</th>
                  <th className="py-2 pr-4">Attempts</th>
                  <th className="py-2 pr-4">State</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {liveTests.map((lt) => {
                  const state = deriveLiveTestState(lt, now);
                  return (
                    <tr key={lt.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{lt.title}</td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{lt.exam.name}</td>
                      <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                        {formatIst(lt.startAt)} → {formatIst(lt.endAt)}
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{lt._count.testAttempts}</td>
                      <td className="py-2.5 pr-4">
                        <Badge variant={STATE_BADGE_VARIANT[state]}>{state.replace("_", " ")}</Badge>
                      </td>
                      <td className="py-2.5 pr-4">
                        <Link href={`/admin/tests/live/${lt.id}`} className="text-[var(--color-primary)] hover:underline">
                          Manage
                        </Link>
                      </td>
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
