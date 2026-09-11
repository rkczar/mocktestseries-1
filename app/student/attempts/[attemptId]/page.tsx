import type { Metadata } from "next";
import { CheckCircle2, Circle, XCircle } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AIExplanationButton } from "@/components/student/AIExplanationButton";
import { Container } from "@/components/common/Container";
import { requireStudent } from "@/lib/auth/requireStudent";
import { prisma } from "@/lib/db";
import type { AttemptAnalytics } from "@/lib/testing/scoring";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Test results" };

const OPTION_KEYS = ["A", "B", "C", "D"] as const;

export default async function AttemptResultsPage({
  params,
}: {
  params: Promise<{ attemptId: string }>;
}) {
  const { attemptId } = await params;
  const { student } = await requireStudent(`/student/attempts/${attemptId}`);

  const attempt = await prisma.testAttempt.findUnique({
    where: { id: attemptId },
    include: {
      test: {
        include: {
          testSeries: { include: { exam: true } },
          questions: {
            where: { status: "PUBLISHED" },
            orderBy: { order: "asc" },
            include: { subject: { select: { name: true } } },
          },
        },
      },
    },
  });

  if (!attempt || attempt.studentId !== student.id) notFound();
  if (!attempt.submittedAt) redirect(`/student/tests/${attempt.testId}/attempt/${attempt.id}`);

  const answers = (attempt.answers as Record<string, string> | null) ?? {};
  const analytics = attempt.analytics as unknown as AttemptAnalytics | null;

  return (
    <Container className="py-[clamp(28px,4vw,48px)]">
      <nav className="flex flex-wrap items-center gap-2 text-[13px] text-text-faint">
        <Link href="/student/dashboard" className="hover:text-primary">
          Dashboard
        </Link>
        <span>/</span>
        <span className="font-semibold text-text-muted">{attempt.test.title} · Results</span>
      </nav>

      <h1 className="mt-3 font-display text-[clamp(24px,3vw,32px)] font-bold text-text-heading">
        {attempt.test.title}
      </h1>
      <p className="mt-1 text-[14px] text-text-faint">
        {attempt.test.testSeries.exam.title} ·{" "}
        {attempt.submittedAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
      </p>

      <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
        <SummaryStat
          label="Score"
          value={`${attempt.score?.toFixed(2) ?? "—"} / ${attempt.test.totalMarks}`}
        />
        <SummaryStat label="Accuracy" value={`${analytics?.accuracy ?? 0}%`} />
        <SummaryStat label="Correct" value={String(analytics?.correct ?? 0)} tone="success" />
        <SummaryStat label="Incorrect" value={String(analytics?.incorrect ?? 0)} tone="error" />
        <SummaryStat label="Unattempted" value={String(analytics?.unattempted ?? 0)} />
      </div>

      {analytics && analytics.subjectBreakdown.length > 1 ? (
        <section className="mt-8">
          <h2 className="text-lg font-extrabold text-text-heading">Subject-wise breakdown</h2>
          <div className="mt-3 overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[480px] text-left text-[13.5px]">
              <thead className="bg-surface text-text-faint">
                <tr>
                  <th className="px-4 py-2.5 font-bold">Subject</th>
                  <th className="px-4 py-2.5 font-bold">Attempted</th>
                  <th className="px-4 py-2.5 font-bold">Correct</th>
                  <th className="px-4 py-2.5 font-bold">Incorrect</th>
                  <th className="px-4 py-2.5 font-bold">Marks</th>
                </tr>
              </thead>
              <tbody>
                {analytics.subjectBreakdown.map((row) => (
                  <tr key={row.subjectId} className="border-t border-border">
                    <td className="px-4 py-2.5 font-semibold text-text-heading">{row.subjectName}</td>
                    <td className="px-4 py-2.5 text-text-muted">
                      {row.attempted}/{row.total}
                    </td>
                    <td className="px-4 py-2.5 text-success-text">{row.correct}</td>
                    <td className="px-4 py-2.5 text-error">{row.incorrect}</td>
                    <td className="px-4 py-2.5 text-text-muted">{row.marks.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className="text-lg font-extrabold text-text-heading">Question review</h2>
        <ul className="mt-4 flex flex-col gap-4">
          {attempt.test.questions.map((question, i) => {
            const studentAnswer = answers[question.id];
            const isCorrect = studentAnswer === question.correctAnswer;
            const isAttempted = Boolean(studentAnswer);

            return (
              <li key={question.id} className="rounded-xl border border-border bg-surface p-5">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[13px] font-bold text-text-faint">
                    Question {i + 1}
                    {question.subject ? ` · ${question.subject.name}` : ""}
                  </p>
                  <StatusPill isAttempted={isAttempted} isCorrect={isCorrect} />
                </div>
                <p className="mt-2 text-[15.5px] leading-relaxed font-semibold text-text-heading">
                  {question.stem}
                </p>

                <div className="mt-4 flex flex-col gap-2">
                  {OPTION_KEYS.map((opt) => {
                    const label = question[`option${opt}` as `option${typeof opt}`];
                    const isCorrectOption = opt === question.correctAnswer;
                    const isStudentOption = opt === studentAnswer;
                    return (
                      <div
                        key={opt}
                        className={cn(
                          "flex items-center gap-3 rounded-[9px] border px-3.5 py-2.5 text-[14px]",
                          isCorrectOption
                            ? "border-success-border bg-success-tint text-success-text"
                            : isStudentOption
                              ? "border-error-border bg-error-tint text-error"
                              : "border-border bg-background text-text-muted",
                        )}
                      >
                        <span className="flex size-5.5 flex-none items-center justify-center rounded-full border border-current text-[11.5px] font-bold">
                          {opt}
                        </span>
                        <span className="min-w-0">{label}</span>
                        {isCorrectOption ? (
                          <CheckCircle2 className="ml-auto size-4 flex-none" strokeWidth={2} />
                        ) : isStudentOption ? (
                          <XCircle className="ml-auto size-4 flex-none" strokeWidth={2} />
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                {question.explanation ? (
                  <p className="mt-4 text-[14px] leading-relaxed text-text-muted">
                    <span className="font-bold text-text-heading">Explanation: </span>
                    {question.explanation}
                  </p>
                ) : null}

                {!isCorrect ? (
                  <AIExplanationButton
                    attemptId={attempt.id}
                    questionId={question.id}
                    initialExplanation={question.aiExplanation}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </Container>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "error";
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-[13px] text-text-faint">{label}</p>
      <p
        className={cn(
          "mt-1 text-[19px] font-extrabold",
          tone === "success" ? "text-success-text" : tone === "error" ? "text-error" : "text-text-heading",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function StatusPill({ isAttempted, isCorrect }: { isAttempted: boolean; isCorrect: boolean }) {
  if (!isAttempted) {
    return (
      <span className="flex items-center gap-1 rounded-full border border-border-strong px-2.5 py-1 text-[11.5px] font-bold text-text-faint">
        <Circle className="size-3" strokeWidth={2.5} />
        Unattempted
      </span>
    );
  }
  if (isCorrect) {
    return (
      <span className="flex items-center gap-1 rounded-full border border-success-border bg-success-tint px-2.5 py-1 text-[11.5px] font-bold text-success-text">
        <CheckCircle2 className="size-3" strokeWidth={2.5} />
        Correct
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 rounded-full border border-error-border bg-error-tint px-2.5 py-1 text-[11.5px] font-bold text-error">
      <XCircle className="size-3" strokeWidth={2.5} />
      Incorrect
    </span>
  );
}
