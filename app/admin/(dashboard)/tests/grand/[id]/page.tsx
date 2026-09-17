import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { GrandTestStatus, QuestionDifficulty } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GrandTestForm, type BlueprintLine } from "../grand-test-form";
import { PublishControl, ArchiveControl } from "../publish-archive-controls";

export const metadata = { title: "Grand Test — Mock Test Series.in Admin" };

const STATUS_BADGE_VARIANT = {
  DRAFT: "warning",
  PUBLISHED: "success",
  ARCHIVED: "neutral",
} as const;

export default async function GrandTestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const grandTest = await prisma.grandTest.findUnique({
    where: { id },
    include: {
      exam: true,
      questions: {
        orderBy: { order: "asc" },
        include: { question: { include: { subject: true, topic: true } } },
      },
    },
  });
  if (!grandTest) notFound();

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

  const blueprint = (grandTest.blueprint ?? []) as unknown as BlueprintLine[];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{grandTest.title}</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {grandTest.exam.name} · {grandTest.durationMinutes} min · Negative marking {grandTest.negativeMarking}
          </p>
        </div>
        <Badge variant={STATUS_BADGE_VARIANT[grandTest.status]}>{grandTest.status}</Badge>
      </div>

      {grandTest.status === GrandTestStatus.DRAFT ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Edit Blueprint</CardTitle>
              <CardDescription>
                Adjust the blueprint until every row&apos;s count sums to the total question count, then publish.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <GrandTestForm
                exams={exams}
                grandTestId={grandTest.id}
                initial={{
                  examId: grandTest.examId,
                  title: grandTest.title,
                  description: grandTest.description,
                  durationMinutes: grandTest.durationMinutes,
                  negativeMarking: grandTest.negativeMarking,
                  instructions: grandTest.instructions,
                  accessType: grandTest.accessType,
                  questionCount: grandTest.questionCount,
                  blueprint,
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Publish</CardTitle>
            </CardHeader>
            <CardContent>
              <PublishControl grandTestId={grandTest.id} />
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Resolved Question Set</CardTitle>
              <CardDescription>
                {grandTest.questions.length} questions, fixed at publish
                {grandTest.publishedAt ? ` on ${grandTest.publishedAt.toLocaleDateString()}` : ""}. Identical for every
                student.
              </CardDescription>
            </div>
            {grandTest.status === GrandTestStatus.PUBLISHED ? <ArchiveControl grandTestId={grandTest.id} /> : null}
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
                {grandTest.questions.map((gq, i) => (
                  <tr key={gq.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2 pr-4 text-[var(--color-muted-foreground)]">{i + 1}</td>
                    <td className="py-2 pr-4 font-medium text-[var(--color-foreground)]">{gq.question.code}</td>
                    <td className="py-2 pr-4">{gq.question.subject.name}</td>
                    <td className="py-2 pr-4">{gq.question.topic?.name ?? "—"}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={gq.question.difficulty === QuestionDifficulty.HARD ? "error" : "neutral"}>
                        {gq.question.difficulty}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
