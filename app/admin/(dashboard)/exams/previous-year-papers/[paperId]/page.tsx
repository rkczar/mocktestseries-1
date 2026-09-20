import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PaperToggle } from "../paper-toggle";
import { QuestionBankPicker } from "./question-bank-picker";
import { RemoveFromPaperButton } from "./remove-from-paper-button";

export const metadata = { title: "Previous Year Paper — Mock Test Series.in Admin" };

const STATUS_VARIANT: Record<string, "success" | "neutral" | "warning"> = {
  PUBLISHED: "success",
  DRAFT: "neutral",
  ARCHIVED: "warning",
};

export default async function PaperDetailPage({ params }: { params: Promise<{ paperId: string }> }) {
  const { paperId } = await params;

  const paper = await prisma.previousYearPaper.findUnique({
    where: { id: paperId },
    include: {
      exam: { select: { id: true, name: true } },
      questions: {
        orderBy: { code: "asc" },
        include: { subject: { select: { name: true } }, topic: { select: { name: true } }, options: { select: { isCorrect: true } } },
      },
      _count: { select: { questions: true, testAttempts: true } },
    },
  });

  if (!paper) notFound();

  const subjects = await prisma.subject.findMany({
    where: { examId: paper.examId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, topics: { orderBy: { name: "asc" }, select: { id: true, name: true } } },
  });

  const subjectCounts = new Map<string, number>();
  paper.questions.forEach((q) => subjectCounts.set(q.subject.name, (subjectCounts.get(q.subject.name) ?? 0) + 1));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href="/admin/exams?tab=pyp" className="text-xs text-[var(--color-primary)] hover:underline">
            ← Previous Year Papers
          </Link>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{paper.title}</h1>
        </div>
        <PaperToggle paperId={paper.id} isActive={paper.isActive} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Paper Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Info label="Exam" value={paper.exam.name} />
            <Info label="Year" value={String(paper.year)} />
            <Info label="Paper Code" value={paper.paperCode ?? "—"} />
            <Info label="Question Count" value={String(paper._count.questions)} />
            <Info label="Subjects" value={Array.from(subjectCounts.entries()).map(([name, n]) => `${name} (${n})`).join(", ") || "—"} />
            <Info label="Status" value={paper.isActive ? "Active" : "Inactive"} />
            <Info label="Test Attempts" value={String(paper._count.testAttempts)} />
          </div>
        </CardContent>
      </Card>

      <QuestionBankPicker paperId={paper.id} subjects={subjects} />

      <Card>
        <CardHeader>
          <CardTitle>Questions in This Paper</CardTitle>
          <CardDescription>{paper.questions.length} question{paper.questions.length === 1 ? "" : "s"} linked to this paper.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {paper.questions.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              No questions linked yet — use &quot;Add Questions from Question Bank&quot; above.
            </p>
          ) : (
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Code</th>
                  <th className="py-2 pr-4">Subject</th>
                  <th className="py-2 pr-4">Topic</th>
                  <th className="py-2 pr-4">Question</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Image</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {paper.questions.map((q) => (
                  <tr key={q.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-foreground)]">{q.code}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{q.subject.name}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{q.topic?.name ?? "—"}</td>
                    <td className="py-2.5 pr-4 max-w-[320px] truncate text-[var(--color-foreground)]">{q.text}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={STATUS_VARIANT[q.status] ?? "neutral"}>{q.status}</Badge>
                      {!q.options.some((o) => o.isCorrect) ? (
                        <Badge variant="warning" className="ml-1">
                          No Correct Answer
                        </Badge>
                      ) : null}
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{q.imageUrl ? "Yes" : "—"}</td>
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center justify-end gap-2">
                        <Button asChild size="compact" variant="outline">
                          <Link href={`/admin/questions?tab=add&id=${q.id}`}>Edit</Link>
                        </Button>
                        <RemoveFromPaperButton paperId={paper.id} questionId={q.id} />
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

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase text-[var(--color-muted-foreground)]">{label}</div>
      <div className="text-sm font-medium text-[var(--color-foreground)]">{value}</div>
    </div>
  );
}
