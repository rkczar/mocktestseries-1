import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GrandTestForm } from "./grand-test-form";

export const metadata = { title: "Grand Tests — Mock Test Series.in Admin" };

const STATUS_BADGE_VARIANT = {
  DRAFT: "warning",
  PUBLISHED: "success",
  ARCHIVED: "neutral",
} as const;

export default async function GrandTestsPage() {
  const [exams, grandTests] = await Promise.all([
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
    prisma.grandTest.findMany({
      orderBy: { createdAt: "desc" },
      include: { exam: true, _count: { select: { questions: true, testAttempts: true } } },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Grand Tests</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Blueprint-driven, exam-scoped full-length tests. On publish, the blueprint resolves once into a fixed,
          shared question set — every student who takes it sees the same questions in the same order.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New Grand Test</CardTitle>
        </CardHeader>
        <CardContent>
          {exams.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">Create an exam first (Admin → Exams).</p>
          ) : (
            <GrandTestForm exams={exams} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Grand Tests</CardTitle>
          <CardDescription>{grandTests.length} total</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {grandTests.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No grand tests yet.</p>
          ) : (
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Questions</th>
                  <th className="py-2 pr-4">Attempts</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {grandTests.map((gt) => (
                  <tr key={gt.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{gt.title}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{gt.exam.name}</td>
                    <td className="py-2.5 pr-4">
                      {gt._count.questions}/{gt.questionCount}
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{gt._count.testAttempts}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={STATUS_BADGE_VARIANT[gt.status]}>{gt.status}</Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link href={`/admin/tests/grand/${gt.id}`} className="text-[var(--color-primary)] hover:underline">
                        Manage
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
