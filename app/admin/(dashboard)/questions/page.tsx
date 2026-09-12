import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusSelect } from "./status-select";

export const metadata = { title: "All Questions — Mock Test Series.in Admin" };

const DIFFICULTY_VARIANT = { EASY: "success", MEDIUM: "warning", HARD: "error" } as const;

export default async function QuestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string; status?: string }>;
}) {
  const { examId, status } = await searchParams;
  const [exams, questions] = await Promise.all([
    prisma.exam.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    prisma.question.findMany({
      where: {
        examId: examId || undefined,
        status: status && status !== "ALL" ? (status as never) : undefined,
      },
      orderBy: { createdAt: "desc" },
      include: { exam: true, subject: true, topic: true },
      take: 200,
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">All Questions</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            The central Question Bank consumed by Mock Tests, Custom Modules, and Previous Year Papers.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/questions/add">Add Question</Link>
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-wrap gap-3 pt-5">
          <form className="flex flex-wrap gap-3">
            <select name="examId" defaultValue={examId ?? ""} className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm">
              <option value="">All exams</option>
              {exams.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            <select name="status" defaultValue={status ?? "ALL"} className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm">
              <option value="ALL">All statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="PUBLISHED">Published</option>
              <option value="ARCHIVED">Archived</option>
            </select>
            <Button type="submit" variant="outline" size="sm">
              Filter
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Questions</CardTitle>
          <CardDescription>{questions.length} shown (max 200)</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {questions.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              No questions match these filters yet.
            </p>
          ) : (
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Code</th>
                  <th className="py-2 pr-4">Question</th>
                  <th className="py-2 pr-4">Exam / Subject</th>
                  <th className="py-2 pr-4">Difficulty</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {questions.map((q) => (
                  <tr key={q.id} className="border-b border-[var(--color-border)] last:border-0 align-top">
                    <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-muted-foreground)]">{q.code}</td>
                    <td className="max-w-xs py-2.5 pr-4 text-[var(--color-foreground)]">{q.text.slice(0, 90)}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      {q.exam.name}
                      <br />
                      <span className="text-xs">{q.subject.name}{q.topic ? ` · ${q.topic.name}` : ""}</span>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={DIFFICULTY_VARIANT[q.difficulty]}>{q.difficulty}</Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusSelect questionId={q.id} status={q.status} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link href={`/admin/questions/add?id=${q.id}`} className="text-[var(--color-primary)] hover:underline">
                        Edit
                      </Link>
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
