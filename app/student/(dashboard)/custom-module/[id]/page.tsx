import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, AlertTriangle, HelpCircle } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getCustomModuleDetailForStudent } from "@/lib/student-data";
import { startCustomModuleFromExamAction } from "@/app/student/(dashboard)/exams/[examId]/actions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/student/back-button";
import { ShareModuleControl } from "./share-module-control";

export const metadata = { title: "Custom Module — Mock Test Series.in" };

export default async function CustomModuleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const student = await requireStudent();
  const detail = await getCustomModuleDetailForStudent(id, student.id);
  if (!detail) notFound();

  const { module: m, attempts } = detail;
  const inProgress = attempts.find((a) => a.status === "IN_PROGRESS");
  const submitted = attempts.filter((a) => a.status === "SUBMITTED");

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/custom-module" />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{m.title}</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">{m.exam.name}</p>
        </div>
        {m.isStudentOwned && m.createdByStudentId === student.id ? (
          <ShareModuleControl moduleId={m.id} existingToken={m.shareToken} />
        ) : null}
      </div>

      {m.description ? (
        <Card>
          <CardContent className="pt-5">
            <p className="whitespace-pre-wrap text-sm text-[var(--color-muted-foreground)]">{m.description}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <HelpCircle className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Questions</p>
              <p className="font-semibold text-[var(--color-foreground)]">{m._count.questions}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <Clock className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Duration</p>
              <p className="font-semibold text-[var(--color-foreground)]">{m.durationMinutes ? `${m.durationMinutes} min` : "No limit"}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <AlertTriangle className="h-5 w-5 text-[var(--color-warning)]" aria-hidden />
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Negative Marking</p>
              <p className="font-semibold text-[var(--color-foreground)]">
                {m.negativeMarking > 0 ? `-${m.negativeMarking} per wrong` : "None"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {m.instructions ? (
        <Card>
          <CardHeader>
            <CardTitle>Instructions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-[var(--color-muted-foreground)]">{m.instructions}</p>
          </CardContent>
        </Card>
      ) : null}

      {inProgress ? (
        <Button asChild size="lg" className="w-full">
          <Link href={`/student/attempt/${inProgress.id}/run`}>Continue Module</Link>
        </Button>
      ) : (
        <form action={startCustomModuleFromExamAction.bind(null, m.id)}>
          <Button type="submit" size="lg" className="w-full">
            Start Module
          </Button>
        </form>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Previous Attempts</CardTitle>
          <CardDescription>{submitted.length} completed</CardDescription>
        </CardHeader>
        <CardContent>
          {submitted.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">No attempts yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-[var(--color-border)]">
              {submitted.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <p className="text-sm font-medium text-[var(--color-foreground)]">
                      {a.score?.toFixed(1) ?? "—"} / {a.maxScore}
                    </p>
                    <p className="text-xs text-[var(--color-muted-foreground)]">{a.submittedAt?.toLocaleString()}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/student/attempt/${a.id}/result`}>Result</Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/student/attempt/${a.id}/review`}>Review</Link>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
