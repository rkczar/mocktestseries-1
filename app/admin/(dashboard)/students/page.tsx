import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "All Students — Mock Test Series.in Admin" };

const STATUS_VARIANT = {
  ACTIVE: "success",
  SUSPENDED: "warning",
  DELETION_REQUESTED: "warning",
  DELETED: "error",
} as const;

export default async function StudentsPage() {
  const students = await prisma.student.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { testAttempts: true } } },
    take: 200,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">All Students</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Every registered student, regardless of sign-in method (Password, Google, Mobile OTP).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Students</CardTitle>
          <CardDescription>{students.length} shown (max 200)</CardDescription>
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
    </div>
  );
}
