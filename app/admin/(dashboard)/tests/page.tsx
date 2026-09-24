import Link from "next/link";
import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { deriveMockTestAvailability } from "@/lib/mock-test-schedule";
import { MockTestTable, MOCK_TEST_TABLE_SELECT, toMockTestTableRow } from "@/components/admin/mock-test-table";
import MockTestsPage from "./mock/page";
import CustomModulesPage from "../custom-modules/page";
import ScheduledTestsPage from "./scheduled/page";

export const metadata = { title: "Tests — Mock Test Series.in Admin" };

/**
 * Admin → Tests. Final architecture: ALL TESTS · MOCK TESTS · SCHEDULED
 * TESTS · CUSTOM MODULES. Mock Test is the one admin-created test (Test
 * Series → Mock Test → Questions → Schedule → Access → Attempt → Result);
 * Scheduled Tests is a view of scheduled Mock Tests, not another entity.
 * Grand / Custom / Random / Live Test and the generic Test Builder are
 * retired — their old URLs redirect here. Custom Module (a different,
 * question-set practice feature) is unchanged.
 */
async function AllTestsPanel() {
  const [canManage, mockTests, customModules] = await Promise.all([
    hasPermission(PERMISSIONS.TEST_SERIES_MANAGE),
    prisma.mockTest.findMany({
      orderBy: [{ exam: { order: "asc" } }, { testSeriesId: "asc" }, { order: "asc" }],
      select: MOCK_TEST_TABLE_SELECT,
    }),
    prisma.customModule.groupBy({ by: ["isStudentOwned"], _count: { _all: true } }),
  ]);
  const rows = mockTests.map(toMockTestTableRow);
  const now = new Date();
  const published = rows.filter((r) => r.status === "PUBLISHED");
  const stateCount = (s: string) => published.filter((r) => deriveMockTestAvailability(r, now) === s).length;
  const adminModules = customModules.find((c) => !c.isStudentOwned)?._count._all ?? 0;
  const studentModules = customModules.find((c) => c.isStudentOwned)?._count._all ?? 0;

  const tiles: [string, number][] = [
    ["Mock Tests", rows.length],
    ["Needs Questions", rows.filter((r) => r.questionCount === 0).length],
    ["Available", stateCount("AVAILABLE")],
    ["Upcoming", stateCount("UPCOMING")],
    ["Live Now", stateCount("LIVE_NOW")],
    ["Custom Modules", adminModules + studentModules],
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-center">
            <p className="text-xl font-semibold text-[var(--color-foreground)]">{value}</p>
            <p className="text-[11px] text-[var(--color-muted-foreground)]">{label}</p>
          </div>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>All Tests</CardTitle>
          <CardDescription>
            Every Mock Test ({rows.length}). Custom Modules — {adminModules} admin, {studentModules} student-built — are managed in the{" "}
            <Link href="/admin/tests?tab=custom-modules" className="text-[var(--color-primary)] hover:underline">
              Custom Modules
            </Link>{" "}
            tab. Subject Tests and Previous Year Papers are generated from the Question Bank and need no test setup here.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <MockTestTable rows={rows} canManage={canManage} />
        </CardContent>
      </Card>
    </div>
  );
}

export default async function TestsControlCenter() {
  const canManage = await hasPermission(PERMISSIONS.TEST_SERIES_MANAGE);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Tests</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Test Series → Mock Test → Questions → Schedule → Access → Student Attempt → Result → Review.
          </p>
        </div>
        {canManage ? (
          <Button asChild>
            <Link href="/admin/tests/mock/new">+ Create Mock Test</Link>
          </Button>
        ) : null}
      </div>

      <ControlCenterTabs
        defaultValue="all"
        tabs={[
          { value: "all", label: "All Tests", content: <AllTestsPanel /> },
          { value: "mock", label: "Mock Tests", content: <MockTestsPage searchParams={Promise.resolve({})} /> },
          { value: "scheduled", label: "Scheduled Tests", content: <ScheduledTestsPage searchParams={Promise.resolve({})} /> },
          { value: "custom-modules", label: "Custom Modules", content: <CustomModulesPage /> },
        ]}
      />
    </div>
  );
}
