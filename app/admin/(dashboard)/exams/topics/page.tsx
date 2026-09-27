import { prisma } from "@/lib/prisma";
import { examQuestionCounts, examTopicWhere, withExamTaxonomy } from "@/lib/exam-taxonomy";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { TopicForm } from "./topic-form";
import { TopicDeleteButton } from "./topic-delete-button";
import { TopicEditDialog } from "./topic-edit-dialog";
import { SubTopicsDialog } from "./sub-topics-dialog";
import { BulkAddTopicsDialog } from "./bulk-add-topics-dialog";
import { RemoveFromExamButton } from "../subjects/remove-from-exam-button";

export const metadata = { title: "Topics — Mock Test Series.in Admin" };

/**
 * Topics are canonical records under a Subject, linked per exam. With an
 * exam context the list shows that exam's linked topics (Remove from Exam
 * unlinks); without one it is the master overview (master delete, guarded).
 */
export default async function TopicsPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string; subjectId?: string }>;
}) {
  const { examId, subjectId } = await searchParams;

  const [examRows, topics, counts] = await Promise.all([
    prisma.exam.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.topic.findMany({
      // Section 13: never mix Topics from unrelated Exams in the normal view
      // — scoped to what the current Exam links (and the chosen Subject).
      where: { ...(subjectId ? { subjectId } : {}), ...(examId ? examTopicWhere(examId) : {}) },
      orderBy: [{ subject: { name: "asc" } }, { order: "asc" }, { name: "asc" }],
      include: {
        subject: { select: { name: true } },
        subTopics: { orderBy: { name: "asc" }, select: { id: true, name: true, examLinks: { where: { isActive: true }, select: { examId: true } } } },
        examLinks: { where: { isActive: true }, select: { examId: true, displayOrder: true, exam: { select: { name: true } } } },
        _count: { select: { questions: true } },
      },
    }),
    examId ? examQuestionCounts(prisma, examId) : Promise.resolve(null),
  ]);
  const exams = await withExamTaxonomy(prisma, examRows);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Topics</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Topics belong to a Subject and are shared across the exams that link them. Each topic can also have optional sub-topics
          for finer question categorization.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>Add Topic</CardTitle>
          <BulkAddTopicsDialog exams={exams} defaultSubjectId={subjectId} defaultExamId={examId} />
        </CardHeader>
        <CardContent>
          <TopicForm exams={exams} defaultSubjectId={subjectId} defaultExamId={examId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{examId ? "Linked Topics" : "All Master Topics"}</CardTitle>
          <CardDescription>
            {topics.length} topic{topics.length === 1 ? "" : "s"}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {topics.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No topics yet.</p>
          ) : (
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Subject</th>
                  <th className="py-2 pr-4">Exams</th>
                  <th className="py-2 pr-4">Questions</th>
                  <th className="py-2 pr-4">Sub-topics</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {topics.map((t) => (
                  <tr key={t.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{t.name}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{t.subject.name}</td>
                    <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">{t.examLinks.map((l) => l.exam.name).join(", ") || "—"}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{counts ? (counts.topic.get(t.id) ?? 0) : t._count.questions}</td>
                    <td className="py-2.5 pr-4">
                      <SubTopicsDialog
                        topicId={t.id}
                        topicName={t.name}
                        examId={examId}
                        initialSubTopics={t.subTopics.map((st) => ({ id: st.id, name: st.name, linked: examId ? st.examLinks.some((l) => l.examId === examId) : true }))}
                      />
                    </td>
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center justify-end gap-1">
                        <TopicEditDialog
                          id={t.id}
                          name={t.name}
                          order={examId ? (t.examLinks.find((l) => l.examId === examId)?.displayOrder ?? 0) : t.order}
                          examId={examId}
                        />
                        {examId ? (
                          <RemoveFromExamButton kind="topic" examId={examId} id={t.id} label={t.name} />
                        ) : (
                          <TopicDeleteButton topicId={t.id} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
