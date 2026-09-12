import { ClipboardList, Clock, ListChecks, Trophy } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getPublishedMockTestsForStudent } from "@/lib/student-data";
import { startMockTestFromExamAction } from "@/app/student/(dashboard)/exams/[examId]/actions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BackButton } from "@/components/student/back-button";
import Link from "next/link";

export const metadata = { title: "Test Series — Mock Test Series.in" };

export default async function TestSeriesPage() {
  const student = await requireStudent();
  const rows = await getPublishedMockTestsForStudent(student.id);

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Test Series</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Published mock tests from Admin, ready to attempt.</p>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <ClipboardList className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
            <p className="text-sm text-[var(--color-muted-foreground)]">No mock tests are currently available.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(({ mockTest, bestScore, latestAttempt }) => (
            <Card key={mockTest.id} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col gap-3 pt-5">
                <div>
                  <p className="font-medium text-[var(--color-foreground)]">{mockTest.title}</p>
                  <p className="text-xs text-[var(--color-muted-foreground)]">{mockTest.exam.name}</p>
                </div>

                <div className="flex flex-wrap gap-3 text-xs text-[var(--color-muted-foreground)]">
                  <span className="flex items-center gap-1">
                    <ListChecks className="h-3.5 w-3.5" aria-hidden /> {mockTest._count.questions} Qs
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" aria-hidden /> {mockTest.durationMinutes} min
                  </span>
                  {bestScore !== null && bestScore !== undefined ? (
                    <span className="flex items-center gap-1">
                      <Trophy className="h-3.5 w-3.5" aria-hidden /> Best: {bestScore.toFixed(1)}
                    </span>
                  ) : null}
                </div>

                {latestAttempt ? (
                  <Badge variant={latestAttempt.status === "IN_PROGRESS" ? "warning" : "success"} className="w-fit">
                    {latestAttempt.status === "IN_PROGRESS" ? "In Progress" : "Attempted"}
                  </Badge>
                ) : null}

                <div className="mt-auto flex flex-wrap gap-2 pt-2">
                  {!latestAttempt ? (
                    <form action={startMockTestFromExamAction.bind(null, mockTest.id)}>
                      <Button type="submit" size="sm">
                        Start Test
                      </Button>
                    </form>
                  ) : latestAttempt.status === "IN_PROGRESS" ? (
                    <Button asChild size="sm">
                      <Link href={`/student/attempt/${latestAttempt.id}/run`}>Continue</Link>
                    </Button>
                  ) : (
                    <>
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/student/attempt/${latestAttempt.id}/result`}>Result</Link>
                      </Button>
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/student/attempt/${latestAttempt.id}/review`}>Review</Link>
                      </Button>
                      <form action={startMockTestFromExamAction.bind(null, mockTest.id)}>
                        <Button type="submit" size="sm">
                          Retake
                        </Button>
                      </form>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
