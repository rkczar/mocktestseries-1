import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const metadata = { title: "AI Question Variants — Mock Test Series.in Admin" };

export default async function AiVariantsPage({
  searchParams,
}: {
  searchParams?: Promise<{ examId?: string; q?: string }>;
}) {
  const params = (await searchParams) ?? {};

  const exams = await prisma.exam.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } });

  const questions = await prisma.question.findMany({
    where: {
      parentQuestionId: null, // canonical only — a variant is never itself a source
      status: "PUBLISHED",
      examId: params.examId || undefined,
      text: params.q ? { contains: params.q, mode: "insensitive" } : undefined,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { exam: true, _count: { select: { aiVariants: true } } },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Question Variants</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Up to 5 AI-generated alternate practice questions (AI01–AI05) per canonical question — similar rephrasings
          or deliberate lookalike traps testing the same concept.
        </p>
      </div>

      <Card>
        <CardContent className="pt-5">
          <form className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SelectNative name="examId" defaultValue={params.examId ?? ""}>
              <option value="">All Exams</option>
              {exams.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </SelectNative>
            <div className="flex gap-2">
              <Input name="q" placeholder="Search question text…" defaultValue={params.q ?? ""} />
              <Button type="submit">Filter</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Canonical Questions</CardTitle>
          <CardDescription>{questions.length} shown (PUBLISHED, top 100)</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {questions.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No questions match.</p>
          ) : (
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Code</th>
                  <th className="py-2 pr-4">Text</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Variants</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {questions.map((q) => (
                  <tr key={q.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{q.code}</td>
                    <td className="max-w-xs truncate py-2.5 pr-4 text-[var(--color-muted-foreground)]">{q.text}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{q.exam.name}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={q._count.aiVariants === 5 ? "success" : q._count.aiVariants > 0 ? "info" : "neutral"}>
                        {q._count.aiVariants}/5
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link href={`/admin/ai/variants/${q.id}`} className="text-[var(--color-primary)] hover:underline">
                        Manage
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
