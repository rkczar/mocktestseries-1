import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { QuestionDifficulty, AttemptStatus } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { deriveLiveTestState, type DerivedLiveTestState } from "@/lib/live-test";
import { formatIst, toIstDateTimeLocalValue } from "@/lib/ist-time";
import { LiveTestForm, type BlueprintLine } from "../live-test-form";
import { LockControl, CancelControl, EndNowControl, PublishResultControl, ReconcileControl } from "../live-controls";

export const metadata = { title: "Live Test — Mock Test Series.in Admin" };

const STATE_BADGE_VARIANT: Record<DerivedLiveTestState, "warning" | "success" | "neutral" | "info" | "error"> = {
  DRAFT: "neutral",
  SCHEDULED: "info",
  LIVE: "success",
  ENDED: "warning",
  RESULT_PUBLISHED: "success",
  CANCELLED: "error",
};

export default async function LiveTestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const liveTest = await prisma.liveTest.findUnique({
    where: { id },
    include: {
      exam: true,
      questions: { orderBy: { order: "asc" }, include: { question: { include: { subject: true, topic: true } } } },
    },
  });
  if (!liveTest) notFound();

  const exams = await prisma.exam.findMany({
    orderBy: { order: "asc" },
    select: {
      id: true,
      name: true,
      subjects: {
        orderBy: { order: "asc" },
        select: {
          id: true,
          name: true,
          topics: {
            orderBy: { order: "asc" },
            select: { id: true, name: true, subTopics: { orderBy: { order: "asc" }, select: { id: true, name: true } } },
          },
        },
      },
    },
  });

  const blueprint = (liveTest.blueprint ?? []) as unknown as BlueprintLine[];
  const now = new Date();
  const state = deriveLiveTestState(liveTest, now);

  const [attemptCounts, dangling] = await Promise.all([
    prisma.testAttempt.groupBy({ by: ["status"], where: { liveTestId: id }, _count: { _all: true } }),
    state === "ENDED" || state === "RESULT_PUBLISHED"
      ? prisma.testAttempt.count({ where: { liveTestId: id, status: AttemptStatus.IN_PROGRESS } })
      : Promise.resolve(0),
  ]);
  const countByStatus = Object.fromEntries(attemptCounts.map((c) => [c.status, c._count._all]));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{liveTest.title}</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {liveTest.exam.name} · {liveTest.studentDurationMinutes} min per student · Negative marking{" "}
            {liveTest.negativeMarking}
          </p>
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            {formatIst(liveTest.startAt)} → {formatIst(liveTest.endAt)}
          </p>
        </div>
        <Badge variant={STATE_BADGE_VARIANT[state]}>{state.replace("_", " ")}</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Attempts</CardTitle>
          <CardDescription>
            {countByStatus.IN_PROGRESS ?? 0} in progress · {countByStatus.SUBMITTED ?? 0} submitted ·{" "}
            {countByStatus.ABANDONED ?? 0} abandoned
          </CardDescription>
        </CardHeader>
        {dangling > 0 ? (
          <CardContent className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-4">
            <p className="text-xs text-[var(--color-warning)]">
              {dangling} attempt{dangling === 1 ? "" : "s"} past the window but still marked in progress (browser
              closed before submitting) — reconcile to finalize scores before publishing results.
            </p>
            <ReconcileControl liveTestId={liveTest.id} />
          </CardContent>
        ) : null}
      </Card>

      {liveTest.status === "DRAFT" ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Edit Schedule &amp; Blueprint</CardTitle>
              <CardDescription>
                Adjust the schedule and blueprint until every row&apos;s count sums to the total question count, then
                lock it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LiveTestForm
                exams={exams}
                liveTestId={liveTest.id}
                initial={{
                  examId: liveTest.examId,
                  title: liveTest.title,
                  description: liveTest.description,
                  startAt: toIstDateTimeLocalValue(liveTest.startAt),
                  endAt: toIstDateTimeLocalValue(liveTest.endAt),
                  studentDurationMinutes: liveTest.studentDurationMinutes,
                  negativeMarking: liveTest.negativeMarking,
                  instructions: liveTest.instructions,
                  accessType: liveTest.accessType,
                  questionCount: liveTest.questionCount,
                  blueprint,
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Lock &amp; Schedule</CardTitle>
            </CardHeader>
            <CardContent>
              <LockControl liveTestId={liveTest.id} />
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Resolved Question Set</CardTitle>
                <CardDescription>
                  {liveTest.questions.length} questions, fixed at lock
                  {liveTest.publishedAt ? ` on ${formatIst(liveTest.publishedAt)}` : ""}. Identical for every student.
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {state === "LIVE" ? <EndNowControl liveTestId={liveTest.id} /> : null}
                {state === "ENDED" ? <PublishResultControl liveTestId={liveTest.id} /> : null}
                {state === "SCHEDULED" || state === "LIVE" ? <CancelControl liveTestId={liveTest.id} /> : null}
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                    <th className="py-2 pr-4">#</th>
                    <th className="py-2 pr-4">Code</th>
                    <th className="py-2 pr-4">Subject</th>
                    <th className="py-2 pr-4">Topic</th>
                    <th className="py-2 pr-4">Difficulty</th>
                  </tr>
                </thead>
                <tbody>
                  {liveTest.questions.map((lq, i) => (
                    <tr key={lq.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="py-2 pr-4 text-[var(--color-muted-foreground)]">{i + 1}</td>
                      <td className="py-2 pr-4 font-medium text-[var(--color-foreground)]">{lq.question.code}</td>
                      <td className="py-2 pr-4">{lq.question.subject.name}</td>
                      <td className="py-2 pr-4">{lq.question.topic?.name ?? "—"}</td>
                      <td className="py-2 pr-4">
                        <Badge variant={lq.question.difficulty === QuestionDifficulty.HARD ? "error" : "neutral"}>
                          {lq.question.difficulty}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
