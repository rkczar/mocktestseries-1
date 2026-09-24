import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const STATUS_VARIANT = {
  ACTIVE: "success",
  SUSPENDED: "warning",
  DELETION_REQUESTED: "warning",
  DELETED: "error",
} as const;

export async function AllStudentsPanel() {
  // Approved deletions leave an anonymized "Deleted Student" row behind for
  // retained attempt/payment history; it is not an active student. Who it
  // was lives in the deletion audit record (Deletion Requests tab).
  const students = await prisma.student.findMany({
    where: { status: { not: "DELETED" } },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { testAttempts: true } } },
    take: 200,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Students</CardTitle>
        <CardDescription>
          {students.length} shown (max 200) · deleted accounts are listed under Deleted Students
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {students.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
            No students have registered yet.
          </p>
        ) : (
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-4">Student ID</th>
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Email / Mobile</th>
                <th className="py-2 pr-4">Registered</th>
                <th className="py-2 pr-4">Last Activity</th>
                <th className="py-2 pr-4">Attempts</th>
                <th className="py-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-muted-foreground)]">
                    <Link href={`/admin/students/${s.id}`} className="text-[var(--color-primary)] hover:underline">
                      {s.studentId}
                    </Link>
                  </td>
                  <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{s.name}</td>
                  <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{s.email ?? s.mobile ?? "—"}</td>
                  <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{s.createdAt.toLocaleDateString()}</td>
                  <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                    {s.lastLoginAt ? s.lastLoginAt.toLocaleDateString() : "Never"}
                  </td>
                  <td className="py-2.5 pr-4">{s._count.testAttempts}</td>
                  <td className="py-2.5 pr-4">
                    <Badge variant={STATUS_VARIANT[s.status]}>{s.status.replace(/_/g, " ")}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
