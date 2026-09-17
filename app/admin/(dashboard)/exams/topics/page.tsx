import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { TopicForm } from "./topic-form";
import { TopicDeleteButton } from "./topic-delete-button";
import { SubTopicsDialog } from "./sub-topics-dialog";
import { BulkAddTopicsDialog } from "./bulk-add-topics-dialog";

export const metadata = { title: "Topics — Mock Test Series.in Admin" };

export default async function TopicsPage({
  searchParams,
}: {
  searchParams: Promise<{ subjectId?: string }>;
}) {
  const { subjectId } = await searchParams;

  const [exams, topics] = await Promise.all([
    prisma.exam.findMany({
      orderBy: { name: "asc" },
      include: { subjects: { orderBy: { name: "asc" }, select: { id: true, name: true } } },
    }),
    prisma.topic.findMany({
      where: { subjectId: subjectId || undefined },
      orderBy: [{ subjectId: "asc" }, { order: "asc" }, { name: "asc" }],
      include: {
        subject: { include: { exam: true } },
        subTopics: { orderBy: { order: "asc" } },
        _count: { select: { questions: true } },
      },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Topics</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Topics belong to a Subject. Each topic can also have optional sub-topics for finer question categorization.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>Add Topic</CardTitle>
          <BulkAddTopicsDialog exams={exams} defaultSubjectId={subjectId} />
        </CardHeader>
        <CardContent>
          <TopicForm exams={exams} defaultSubjectId={subjectId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Topics</CardTitle>
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
                  <th className="py-2 pr-4">Exam</th>
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
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{t.subject.exam.name}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{t._count.questions}</td>
                    <td className="py-2.5 pr-4">
                      <SubTopicsDialog topicId={t.id} topicName={t.name} initialSubTopics={t.subTopics} />
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <TopicDeleteButton topicId={t.id} />
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
