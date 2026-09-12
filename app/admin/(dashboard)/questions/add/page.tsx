import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QuestionForm, type ExamTree, type QuestionDefaults } from "../question-form";

export const metadata = { title: "Add Question — Mock Test Series.in Admin" };

async function loadExamTree(): Promise<ExamTree[]> {
  return prisma.exam.findMany({
    orderBy: { order: "asc" },
    include: {
      subjects: {
        orderBy: { order: "asc" },
        include: { topics: { orderBy: { order: "asc" }, include: { subTopics: { orderBy: { order: "asc" } } } } },
      },
      previousYearPapers: { orderBy: { year: "desc" } },
    },
  });
}

export default async function AddQuestionPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  const exams = await loadExamTree();

  let defaults: QuestionDefaults | undefined;
  if (id) {
    const question = await prisma.question.findUnique({
      where: { id },
      include: { options: { orderBy: { order: "asc" } } },
    });
    if (!question) notFound();
    defaults = {
      id: question.id,
      examId: question.examId,
      subjectId: question.subjectId,
      topicId: question.topicId,
      subTopicId: question.subTopicId,
      previousYearPaperId: question.previousYearPaperId,
      text: question.text,
      imageUrl: question.imageUrl,
      difficulty: question.difficulty,
      status: question.status,
      options: question.options,
    };
  }

  if (exams.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{id ? "Edit Question" : "Add Question"}</h1>
        <Card>
          <CardContent className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">
            Create an exam and at least one subject first (Admin → Exams) before adding questions.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{id ? "Edit Question" : "Add Question"}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{id ? `Editing ${defaults?.text.slice(0, 60)}` : "New Question"}</CardTitle>
        </CardHeader>
        <CardContent>
          <QuestionForm exams={exams} defaults={defaults} />
        </CardContent>
      </Card>
    </div>
  );
}
