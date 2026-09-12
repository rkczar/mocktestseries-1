import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { QuestionStatus } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { QuestionPicker } from "@/components/admin/question-picker";
import { syncCustomModuleQuestionsAction, regenerateFromRuleAction } from "../actions";

export const metadata = { title: "Custom Module — Mock Test Series.in Admin" };

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <p className="text-xs uppercase text-[var(--color-muted-foreground)]">{label}</p>
      <p className="mt-1 text-xl font-semibold text-[var(--color-foreground)]">{value}</p>
    </div>
  );
}

export default async function CustomModuleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const customModule = await prisma.customModule.findUnique({
    where: { id },
    include: { exam: true, questions: { select: { questionId: true } } },
  });
  if (!customModule) notFound();

  const [questions, attempts] = await Promise.all([
    prisma.question.findMany({
      where: { examId: customModule.examId, status: QuestionStatus.PUBLISHED },
      include: { subject: true, topic: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.testAttempt.findMany({
      where: { customModuleId: id },
      select: { studentId: true, status: true, score: true, timeTakenSeconds: true, submittedAt: true, startedAt: true },
      orderBy: { startedAt: "desc" },
    }),
  ]);

  const submitted = attempts.filter((a) => a.status === "SUBMITTED" && a.score !== null);
  const scores = submitted.map((a) => a.score as number);
  const times = submitted.map((a) => a.timeTakenSeconds).filter((t): t is number => t !== null);
  const uniqueStudents = new Set(attempts.map((a) => a.studentId)).size;
  const lastAttempt = attempts[0]?.startedAt;

  const hasAttempts = attempts.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{customModule.title}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {customModule.exam.name} · {customModule.selectionMode === "MANUAL" ? "Manual selection" : "Rule-based selection"}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Analytics</CardTitle>
          <CardDescription>Computed live from real attempt data — never estimated.</CardDescription>
        </CardHeader>
        <CardContent>
          {!hasAttempts ? (
            <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">No attempts yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <StatTile label="Total Attempts" value={String(attempts.length)} />
              <StatTile label="Unique Students" value={String(uniqueStudents)} />
              <StatTile label="Completion Rate" value={`${Math.round((submitted.length / attempts.length) * 100)}%`} />
              <StatTile
                label="Average Score"
                value={scores.length ? (scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(1) : "—"}
              />
              <StatTile label="Highest Score" value={scores.length ? Math.max(...scores).toFixed(1) : "—"} />
              <StatTile label="Lowest Score" value={scores.length ? Math.min(...scores).toFixed(1) : "—"} />
              <StatTile
                label="Average Time"
                value={times.length ? `${Math.round(times.reduce((s, v) => s + v, 0) / times.length / 60)} min` : "—"}
              />
              <StatTile label="Last Attempt" value={lastAttempt ? lastAttempt.toLocaleDateString() : "—"} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Questions</CardTitle>
            <CardDescription>
              {customModule.questions.length} selected. Editing this list only affects attempts started after saving —
              historical attempts keep their own question snapshot.
            </CardDescription>
          </div>
          {customModule.selectionMode === "RULE_BASED" ? (
            <form action={regenerateFromRuleAction.bind(null, customModule.id)}>
              <Button type="submit" variant="outline" size="sm">
                Regenerate from Rule
              </Button>
            </form>
          ) : null}
        </CardHeader>
        <CardContent>
          <QuestionPicker
            questions={questions.map((q) => ({
              id: q.id,
              code: q.code,
              text: q.text,
              subjectName: q.subject.name,
              topicName: q.topic?.name ?? null,
              difficulty: q.difficulty,
            }))}
            initiallySelected={customModule.questions.map((q) => q.questionId)}
            action={syncCustomModuleQuestionsAction.bind(null, customModule.id)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
