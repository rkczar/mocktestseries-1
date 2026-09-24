import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MockTestTable, MOCK_TEST_TABLE_SELECT, toMockTestTableRow } from "@/components/admin/mock-test-table";

export const metadata = { title: "Mock Tests — Mock Test Series.in Admin" };

/**
 * Every Mock Test across every exam and series, in one canonical list.
 * "+ Create Mock Test" and each row's Edit open the one Mock Test editor.
 */
export default async function MockTestsPage({ searchParams }: { searchParams: Promise<{ examId?: string }> }) {
  const { examId } = await searchParams;
  const [canManage, exams, mockTests] = await Promise.all([
    hasPermission(PERMISSIONS.TEST_SERIES_MANAGE),
    prisma.exam.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    prisma.mockTest.findMany({
      where: examId ? { examId } : undefined,
      orderBy: [{ exam: { order: "asc" } }, { testSeriesId: "asc" }, { order: "asc" }],
      select: MOCK_TEST_TABLE_SELECT,
    }),
  ]);
  const rows = mockTests.map(toMockTestTableRow);
  const needs = rows.filter((r) => r.questionCount === 0).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Mock Tests</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            The one admin-created test type. Questions come from the Question Bank (pick or bulk import); scheduling, fixed windows and result
            release are set per test.
          </p>
        </div>
        {canManage ? (
          <Button asChild>
            <Link href="/admin/tests/mock/new">+ Create Mock Test</Link>
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Mock Tests</CardTitle>
          <CardDescription>
            {rows.length} total{needs > 0 ? ` · ${needs} need questions` : ""}
            {exams.length > 1 ? (
              <>
                {" "}· Filter:{" "}
                <Link href="/admin/tests?tab=mock" className="text-[var(--color-primary)] hover:underline">
                  All
                </Link>
                {exams.map((e) => (
                  <span key={e.id}>
                    {" "}
                    ·{" "}
                    <Link href={`/admin/tests/mock?examId=${e.id}`} className="text-[var(--color-primary)] hover:underline">
                      {e.name}
                    </Link>
                  </span>
                ))}
              </>
            ) : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <MockTestTable rows={rows} canManage={canManage} />
        </CardContent>
      </Card>
    </div>
  );
}
