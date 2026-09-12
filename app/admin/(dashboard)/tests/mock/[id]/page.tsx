import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { QuestionStatus } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { QuestionPicker } from "@/components/admin/question-picker";
import { syncMockTestQuestionsAction } from "../actions";

export const metadata = { title: "Mock Test — Mock Test Series.in Admin" };

export default async function MockTestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const mockTest = await prisma.mockTest.findUnique({
    where: { id },
    include: { exam: true, questions: { select: { questionId: true } } },
  });
  if (!mockTest) notFound();

  const questions = await prisma.question.findMany({
    where: { examId: mockTest.examId, status: QuestionStatus.PUBLISHED },
    include: { subject: true, topic: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{mockTest.title}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {mockTest.exam.name} · {mockTest.durationMinutes} min · Negative marking {mockTest.negativeMarking}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Questions</CardTitle>
          <CardDescription>
            Only published questions from {mockTest.exam.name} are selectable. {mockTest.questions.length} currently
            selected.
          </CardDescription>
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
            initiallySelected={mockTest.questions.map((q) => q.questionId)}
            action={syncMockTestQuestionsAction.bind(null, mockTest.id)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
