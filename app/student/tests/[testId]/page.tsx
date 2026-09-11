import type { Metadata } from "next";
import { Clock, FileText, Target } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Container } from "@/components/common/Container";
import { StartTestButton } from "@/components/student/StartTestButton";
import { requireStudent } from "@/lib/auth/requireStudent";
import { prisma } from "@/lib/db";

import { startAttemptAction } from "./actions";

async function getTest(testId: string) {
  return prisma.test.findUnique({
    where: { id: testId },
    include: {
      testSeries: { include: { exam: true } },
      questions: { where: { status: "PUBLISHED" }, select: { id: true } },
    },
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ testId: string }>;
}): Promise<Metadata> {
  const { testId } = await params;
  const test = await getTest(testId);
  return { title: test ? `${test.title} · Test` : "Test" };
}

export default async function TestIntroPage({ params }: { params: Promise<{ testId: string }> }) {
  const { testId } = await params;
  const { student } = await requireStudent(`/student/tests/${testId}`);

  const test = await getTest(testId);
  if (!test || !test.isPublished) notFound();

  const [inProgress, pastAttempts] = await Promise.all([
    prisma.testAttempt.findFirst({
      where: { studentId: student.id, testId, submittedAt: null },
      orderBy: { startedAt: "desc" },
    }),
    prisma.testAttempt.findMany({
      where: { studentId: student.id, testId, submittedAt: { not: null } },
      orderBy: { submittedAt: "desc" },
      take: 10,
    }),
  ]);

  const questionCount = test.questions.length;

  return (
    <Container className="py-[clamp(28px,4vw,48px)]">
      <nav className="flex flex-wrap items-center gap-2 text-[13px] text-text-faint">
        <Link href="/" className="hover:text-primary">
          Home
        </Link>
        <span>/</span>
        <Link href={`/test-series/${test.testSeries.slug}`} className="hover:text-primary">
          {test.testSeries.title}
        </Link>
        <span>/</span>
        <span className="font-semibold text-text-muted">{test.title}</span>
      </nav>

      <div className="mt-4 flex items-start gap-4">
        <span className="flex size-12 flex-none items-center justify-center rounded-xl border border-primary-border bg-primary-tint">
          <FileText className="size-6 text-primary" strokeWidth={1.9} />
        </span>
        <div className="min-w-0">
          <p className="font-mono text-[11.5px] font-semibold tracking-[.1em] text-brand-accent-text uppercase">
            {test.testSeries.exam.title}
          </p>
          <h1 className="mt-1.5 font-display text-[clamp(26px,3vw,36px)] leading-[1.15] font-bold tracking-[-.015em] text-text-heading">
            {test.title}
          </h1>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-4">
        <div className="rounded-xl border border-border bg-surface p-4">
          <Clock className="size-4.5 text-primary" strokeWidth={1.9} />
          <p className="mt-2 text-[13px] text-text-faint">Duration</p>
          <p className="text-[15px] font-bold text-text-heading">{test.durationMin} minutes</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4">
          <FileText className="size-4.5 text-primary" strokeWidth={1.9} />
          <p className="mt-2 text-[13px] text-text-faint">Questions</p>
          <p className="text-[15px] font-bold text-text-heading">
            {questionCount} · {test.totalMarks} marks
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4">
          <Target className="size-4.5 text-primary" strokeWidth={1.9} />
          <p className="mt-2 text-[13px] text-text-faint">Negative marking</p>
          <p className="text-[15px] font-bold text-text-heading">
            {test.negativeMark > 0 ? `−${test.negativeMark} per wrong answer` : "None"}
          </p>
        </div>
      </div>

      <form action={startAttemptAction} className="mt-8">
        <input type="hidden" name="testId" value={test.id} />
        <StartTestButton
          label={inProgress ? "Resume test" : "Start test"}
          disabled={questionCount === 0}
        />
        {questionCount === 0 ? (
          <p className="mt-2 text-sm text-text-faint">
            Questions for this test are being added from the Admin Panel — check back soon.
          </p>
        ) : null}
      </form>

      {pastAttempts.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-lg font-extrabold text-text-heading">Your past attempts</h2>
          <ul className="mt-4 flex flex-col gap-3">
            {pastAttempts.map((attempt) => (
              <li
                key={attempt.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-background px-4.5 py-4"
              >
                <div className="min-w-0">
                  <p className="font-bold text-text-heading">
                    {attempt.score?.toFixed(2) ?? "—"} / {test.totalMarks}
                  </p>
                  <p className="mt-1 text-[13px] text-text-faint">
                    {attempt.submittedAt
                      ? new Date(attempt.submittedAt).toLocaleString("en-IN", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : ""}
                  </p>
                </div>
                <Link
                  href={`/student/attempts/${attempt.id}`}
                  className="rounded-[9px] border border-border-strong px-4 py-2.5 text-sm font-bold whitespace-nowrap text-primary hover:bg-accent"
                >
                  View results
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Container>
  );
}
