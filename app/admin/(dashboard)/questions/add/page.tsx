import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { withExamTaxonomy } from "@/lib/exam-taxonomy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { QuestionForm, type ExamTree, type QuestionDefaults } from "../question-form";
import { QuestionSourcePanel } from "@/components/admin/question-source-panel";
import { ReviewBar } from "../review/review-bar";
import { QuestionPreviewBody } from "@/components/content/question-preview-body";
import { QUESTION_PREVIEW_SELECT } from "@/lib/question-preview";

export const metadata = { title: "Add Question — Mock Test Series.in Admin" };

async function loadExamTree(): Promise<ExamTree[]> {
  // Each exam's LINKED canonical taxonomy (Exam -> Subject -> Topic -> SubTopic).
  const exams = await prisma.exam.findMany({
    orderBy: { order: "asc" },
    include: { previousYearPapers: { orderBy: { year: "desc" } } },
  });
  return withExamTaxonomy(prisma, exams);
}

export default async function AddQuestionPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  const exams = await loadExamTree();

  let defaults: QuestionDefaults | undefined;
  // Saved version for the student preview beside the form (same renderer as the preview page).
  const preview = id
    ? await prisma.question.findUnique({
        where: { id },
        select: QUESTION_PREVIEW_SELECT,
      })
    : null;
  if (id) {
    const question = await prisma.question.findUnique({
      where: { id },
      include: { options: { orderBy: { order: "asc" } } },
    });
    if (!question) notFound();
    defaults = {
      id: question.id,
      examId: question.examId,
      examYear: question.examYear,
      subjectId: question.subjectId,
      topicId: question.topicId,
      subTopicId: question.subTopicId,
      previousYearPaperId: question.previousYearPaperId,
      source: question.source,
      text: question.text,
      imageUrl: question.imageUrl,
      difficulty: question.difficulty,
      status: question.status,
      reviewRequired: question.reviewRequired,
      reviewReason: question.reviewReason,
      excludeFromPractice: question.excludeFromPractice,
      excludeFromPracticeReason: question.excludeFromPracticeReason,
      options: question.options,
      questionType: question.questionType,
      matchSpec: question.matchSpec,
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
      <div className={id ? "grid grid-cols-1 gap-4 xl:grid-cols-2" : ""}>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{id ? `Editing ${defaults?.text.slice(0, 60)}` : "New Question"}</CardTitle>
        </CardHeader>
        <CardContent>
          <QuestionForm exams={exams} defaults={defaults} />
        </CardContent>
      </Card>
      {id && preview ? (
        <aside className="flex min-w-0 flex-col gap-4" data-testid="edit-source-side">
          <Card>
            <CardHeader>
              <CardTitle>Student preview (saved version)</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3" data-testid="edit-student-preview">
              <QuestionPreviewBody q={preview} />
              <Link className="text-xs underline" href={`/admin/questions/preview/${id}`}>Images, explanation and full review screen</Link>
            </CardContent>
          </Card>
          <ReviewBar questionId={id} reviewRequired={defaults?.reviewRequired ?? false} reviewReason={defaults?.reviewReason ?? null} />
          <QuestionSourcePanel questionId={id} />
        </aside>
      ) : null}
      </div>
    </div>
  );
}
