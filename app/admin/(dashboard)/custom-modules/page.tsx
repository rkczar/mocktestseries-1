import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CustomModuleForm } from "./custom-module-form";
import { CustomModuleStatusSelect } from "./status-select";

export const metadata = { title: "Custom Modules — Mock Test Series.in Admin" };

export default async function CustomModulesPage() {
  const exams = await prisma.exam.findMany({
    orderBy: { order: "asc" },
    include: { subjects: { orderBy: { order: "asc" }, include: { topics: { orderBy: { order: "asc" } } } } },
  });

  const modules = await prisma.customModule.findMany({
    orderBy: { createdAt: "desc" },
    include: { exam: true, _count: { select: { questions: true, testAttempts: true } } },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Custom Modules</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          The single canonical Custom Module system consumed by Student → Custom Module. A module must be Published
          + Active to appear to students.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New Custom Module</CardTitle>
        </CardHeader>
        <CardContent>
          {exams.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">Create an exam first (Admin → Exams).</p>
          ) : (
            <CustomModuleForm exams={exams} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Custom Modules</CardTitle>
          <CardDescription>{modules.length} total</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {modules.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No custom modules yet.</p>
          ) : (
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Mode</th>
                  <th className="py-2 pr-4">Questions</th>
                  <th className="py-2 pr-4">Attempts</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {modules.map((m) => (
                  <tr key={m.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{m.title}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{m.exam.name}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant="neutral">{m.selectionMode === "MANUAL" ? "Manual" : "Rule-based"}</Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={m._count.questions > 0 ? "success" : "warning"}>{m._count.questions}</Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{m._count.testAttempts}</td>
                    <td className="py-2.5 pr-4">
                      <CustomModuleStatusSelect moduleId={m.id} status={m.status} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link href={`/admin/custom-modules/${m.id}`} className="text-[var(--color-primary)] hover:underline">
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
