import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Student — Mock Test Series.in Admin" };

const SOURCE_LABEL = {
  MOCK_TEST: "Mock Test",
  PREVIOUS_YEAR_PAPER: "Previous Year Paper",
  CUSTOM_MODULE: "Custom Module",
  SUBJECT_TEST: "Subject Test",
  GRAND_TEST: "Grand Test",
} as const;

export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      profile: true,
      deletionRequests: { orderBy: { requestedAt: "desc" }, take: 1 },
      testAttempts: {
        orderBy: { startedAt: "desc" },
        take: 100,
        include: { exam: true, mockTest: true, customModule: true, previousYearPaper: true, grandTest: true },
      },
    },
  });
  if (!student) notFound();

  const latestDeletionRequest = student.deletionRequests[0];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{student.name}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)] font-mono">{student.studentId}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Email</p>
            <p className="text-[var(--color-foreground)]">{student.email ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Mobile</p>
            <p className="text-[var(--color-foreground)]">{student.mobile ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Auth Method</p>
            <p className="text-[var(--color-foreground)]">{student.authProvider}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Registered</p>
            <p className="text-[var(--color-foreground)]">{student.createdAt.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Last Activity</p>
            <p className="text-[var(--color-foreground)]">{student.lastLoginAt?.toLocaleString() ?? "Never"}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Status</p>
            <Badge variant={student.status === "ACTIVE" ? "success" : "warning"}>{student.status.replace(/_/g, " ")}</Badge>
          </div>
        </CardContent>
      </Card>

      {latestDeletionRequest ? (
        <Card>
          <CardHeader>
            <CardTitle>Deletion Request</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-[var(--color-muted-foreground)]">
            Status: <Badge variant="warning">{latestDeletionRequest.status}</Badge> · Requested{" "}
            {latestDeletionRequest.requestedAt.toLocaleString()}
            {latestDeletionRequest.reason ? <p className="mt-2">Reason: {latestDeletionRequest.reason}</p> : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Test History</CardTitle>
          <CardDescription>{student.testAttempts.length} attempts (max 100 shown)</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {student.testAttempts.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No attempts yet.</p>
          ) : (
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Score</th>
                  <th className="py-2 pr-4">Correct / Incorrect / Skipped</th>
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {student.testAttempts.map((a) => (
                  <tr key={a.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4">
                      <Badge variant="neutral">{SOURCE_LABEL[a.sourceType]}</Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-foreground)]">
                      {a.mockTest?.title ?? a.customModule?.title ?? a.previousYearPaper?.title ?? a.grandTest?.title ?? "—"}
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{a.exam.name}</td>
                    <td className="py-2.5 pr-4">{a.score !== null ? `${a.score} / ${a.maxScore}` : "—"}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      {a.correctCount ?? "—"} / {a.incorrectCount ?? "—"} / {a.unansweredCount ?? "—"}
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{a.startedAt.toLocaleDateString()}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={a.status === "SUBMITTED" ? "success" : a.status === "IN_PROGRESS" ? "info" : "neutral"}>
                        {a.status.replace(/_/g, " ")}
                      </Badge>
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
