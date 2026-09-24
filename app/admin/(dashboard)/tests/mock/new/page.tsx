import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { MockTestForm } from "../mock-test-form";

export const metadata = { title: "Create Mock Test — Mock Test Series.in Admin" };

/**
 * The one entry into the canonical Mock Test editor for a NEW test. Both
 * Admin → Tests → Mock Tests → Create Mock Test and Admin → Exams → Test
 * Series → [series] → Add Mock Test link here (the latter with
 * ?testSeriesId=, which fixes the exam and pre-fills the next Test Number).
 */
export default async function NewMockTestPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string; testSeriesId?: string }>;
}) {
  if (!(await hasPermission(PERMISSIONS.TEST_SERIES_MANAGE))) return <RestrictedCard title="Create Mock Test" />;
  const params = await searchParams;

  const series = params.testSeriesId
    ? await prisma.testSeries.findUnique({ where: { id: params.testSeriesId }, select: { id: true, name: true, examId: true } })
    : null;
  const examId = series?.examId ?? params.examId ?? null;
  const exam = examId ? await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, name: true } }) : null;

  if (!exam) {
    const [exams, allSeries] = await Promise.all([
      prisma.exam.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
      prisma.testSeries.findMany({ orderBy: [{ order: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, exam: { select: { name: true } } } }),
    ]);
    return (
      <div className="flex flex-col gap-6">
        <Header />
        <Card>
          <CardHeader>
            <CardTitle>Where does this Mock Test belong?</CardTitle>
            <CardDescription>Most tests belong to a Test Series — pick it and the exam follows. Standalone tests pick only an exam.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 md:grid-cols-2">
            <form className="flex flex-col gap-2" method="get">
              <label htmlFor="testSeriesId" className="text-sm font-medium text-[var(--color-foreground)]">
                Test Series
              </label>
              <SelectNative id="testSeriesId" name="testSeriesId" required defaultValue="">
                <option value="" disabled>
                  Select a Test Series
                </option>
                {allSeries.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.exam.name}
                  </option>
                ))}
              </SelectNative>
              <Button type="submit" className="w-fit">
                Continue
              </Button>
            </form>
            <form className="flex flex-col gap-2" method="get">
              <label htmlFor="examId" className="text-sm font-medium text-[var(--color-foreground)]">
                Standalone — Exam only
              </label>
              <SelectNative id="examId" name="examId" required defaultValue="">
                <option value="" disabled>
                  Select an exam
                </option>
                {exams.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </SelectNative>
              <Button type="submit" variant="outline" className="w-fit">
                Continue
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  const [subjects, last] = await Promise.all([
    prisma.subject.findMany({
      where: { examId: exam.id },
      orderBy: { order: "asc" },
      select: { id: true, name: true, topics: { orderBy: { order: "asc" }, select: { id: true, name: true } } },
    }),
    series ? prisma.mockTest.findFirst({ where: { testSeriesId: series.id }, orderBy: { order: "desc" }, select: { order: true } }) : null,
  ]);

  return (
    <div className="flex flex-col gap-6">
      <Header />
      <Card>
        <CardHeader>
          <CardTitle>Step 1 — Basic Details</CardTitle>
          <CardDescription>
            Exam: <strong>{exam.name}</strong> · Test Series: <strong>{series ? series.name : "Standalone"}</strong> ·{" "}
            <Link href="/admin/tests/mock/new" className="text-[var(--color-primary)] hover:underline">
              change
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MockTestForm examId={exam.id} testSeriesId={series?.id ?? null} subjects={subjects} nextTestNumber={series ? (last?.order ?? 0) + 1 : undefined} />
        </CardContent>
      </Card>
    </div>
  );
}

function Header() {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-[var(--color-muted-foreground)]">
        <Link href="/admin/tests" className="hover:underline">Tests</Link> ›{" "}
        <Link href="/admin/tests?tab=mock" className="hover:underline">Mock Tests</Link> › Create
      </p>
      <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Create Mock Test</h1>
      <p className="text-sm text-[var(--color-muted-foreground)]">
        Steps: 1 Basic Details · 2 Coverage · 3 Questions · 4 Schedule &amp; Availability · 5 Access &amp; Result · 6 Review &amp; Publish
      </p>
    </div>
  );
}
