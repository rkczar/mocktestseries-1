import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { inScopeOr404, requireTeacherPage } from "@/lib/teacher/page";
import { questionInScope } from "@/lib/teacher/scope";
import { teacherExamTree } from "@/lib/teacher/queries";
import { editVersion } from "@/lib/teacher/content";
import { nextQuestionId, parseQuestionListFilters, questionListQuery } from "@/lib/teacher/queries";
import Link from "next/link";
import { Flash } from "@/components/teacher/ui";
import { CONTENT_SELECT, contentOf, readContent } from "@/lib/question-content";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QuestionForm, type QuestionDefaults } from "@/app/admin/(dashboard)/questions/question-form";
import { saveQuestionTeacherAction } from "@/app/teacher/actions";

export const metadata = { title: "Edit Question — Teacher Portal" };

export default async function EditTeacherQuestion({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; ok?: string; saved?: string }> }) {
  const scope = await requireTeacherPage();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const filters = parseQuestionListFilters(new URLSearchParams(sp.from ?? ""));
  const from = questionListQuery(filters);
  const q = await inScopeOr404(() => questionInScope(scope, id));
  if (q.retiredAt || q.status === "ARCHIVED" || q.status === "WITHDRAWN") notFound();
  // Version first: if anything changes while the page renders, the save is refused rather than overwriting it.
  const version = await editVersion(q.id);
  const [row, rev, tree] = await Promise.all([
    prisma.question.findUniqueOrThrow({ where: { id: q.id }, select: CONTENT_SELECT }),
    prisma.questionRevision.findFirst({ where: { questionId: q.id, status: { in: ["DRAFT", "SUBMITTED"] } }, select: { status: true, proposedSnapshot: true } }),
    teacherExamTree(scope),
  ]);
  if (rev?.status === "SUBMITTED") {
    return <p className="text-sm">A revision of this question is waiting for approval. Withdraw it from My Requests to make more changes.</p>;
  }
  // Published: continue the open revision if there is one, else start from the live content.
  const c = q.status === "PUBLISHED" && rev ? readContent(rev.proposedSnapshot) : contentOf(row);
  const defaults: QuestionDefaults = {
    id: q.id,
    examId: c.examId,
    examYear: c.examYear,
    subjectId: c.subjectId,
    topicId: c.topicId,
    subTopicId: c.subTopicId,
    previousYearPaperId: null,
    source: "QUESTION_BANK",
    text: c.text,
    imageUrl: c.imageUrl,
    difficulty: c.difficulty,
    status: q.status,
    options: c.options,
    questionType: c.questionType,
    matchSpec: c.matchSpec,
  };
  const published = q.status === "PUBLISHED";
  const next = await nextQuestionId(scope, filters, q.id);
  return (
    <Card>
      <CardHeader>
        <Link href={`/teacher/questions?${from}`} className="text-sm underline">← Back to the question list</Link>
        <CardTitle>Edit {q.code}</CardTitle>
      </CardHeader>
      <CardContent>
        {sp.ok ? <div className="mb-3"><Flash ok={sp.ok} /></div> : null}
        <p className="mb-4 text-sm text-[var(--color-muted-foreground)]">
          {published
            ? "This question is published. Your changes are saved as a revision; students keep seeing the current version until the Master Admin approves it."
            : "This question is a Draft and is never shown to students. Changes are saved directly."}
        </p>
        <QuestionForm
          exams={tree}
          defaults={defaults}
          teacher={{
            action: saveQuestionTeacherAction.bind(null, q.id),
            submitLabel: published ? "Save revision as Draft" : "Save Draft",
            version,
            hidden: { from },
            nextLabel: next ? "Save & next" : "Save & back to list",
          }}
        />
      </CardContent>
    </Card>
  );
}
