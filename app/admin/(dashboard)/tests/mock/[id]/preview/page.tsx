import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Preview Mock Test — Mock Test Series.in Admin" };

/**
 * Read-only preview of exactly what a student attempt would receive: the
 * test's PUBLISHED questions in stored order (the same filter and order
 * startMockTestAttempt uses), with the answer key shown for the admin.
 */
export default async function MockTestPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const mockTest = await prisma.mockTest.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      durationMinutes: true,
      negativeMarking: true,
      instructions: true,
      exam: { select: { name: true } },
      questions: {
        orderBy: { order: "asc" },
        select: {
          question: {
            select: {
              id: true,
              code: true,
              text: true,
              imageUrl: true,
              status: true,
              subject: { select: { name: true } },
              options: { orderBy: { order: "asc" }, select: { label: true, text: true, imageUrl: true, isCorrect: true } },
            },
          },
        },
      },
    },
  });
  if (!mockTest) notFound();

  const served = mockTest.questions.map((q) => q.question).filter((q) => q.status === "PUBLISHED");
  const hidden = mockTest.questions.length - served.length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          <Link href={`/admin/tests/mock/${mockTest.id}`} className="hover:underline">
            ← Back to editor
          </Link>
        </p>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Preview — {mockTest.title}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {mockTest.exam.name} · {served.length} questions students receive · {mockTest.durationMinutes} min · −{mockTest.negativeMarking} per wrong
          answer{hidden > 0 ? ` · ${hidden} draft question(s) hidden until published` : ""}
        </p>
      </div>
      {mockTest.instructions ? (
        <Card>
          <CardHeader>
            <CardTitle>Instructions</CardTitle>
            <CardDescription className="whitespace-pre-wrap">{mockTest.instructions}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {served.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">No published questions yet.</CardContent>
        </Card>
      ) : (
        <ol className="flex flex-col gap-3">
          {served.map((q, i) => (
            <li key={q.id}>
              <Card>
                <CardContent className="flex flex-col gap-2 pt-5 text-sm">
                  <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
                    <strong className="text-[var(--color-foreground)]">Q{i + 1}</strong> {q.code} · {q.subject.name}
                    <Badge variant="neutral">answer key visible to admin only</Badge>
                  </p>
                  <p className="whitespace-pre-wrap text-[var(--color-foreground)]">{q.text}</p>
                  {q.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- admin preview of an uploaded question image
                    <img src={q.imageUrl} alt={`${q.code} image`} className="max-h-60 w-fit rounded border border-[var(--color-border)]" />
                  ) : null}
                  <ul className="flex flex-col gap-1">
                    {q.options.map((o) => (
                      <li key={o.label} className={o.isCorrect ? "font-medium text-[var(--color-success)]" : "text-[var(--color-foreground)]"}>
                        {o.label}. {o.text} {o.isCorrect ? "✓" : ""}
                        {o.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- admin preview of an uploaded option image
                          <img src={o.imageUrl} alt={`${q.code} option ${o.label}`} className="mt-1 max-h-32 w-fit rounded border border-[var(--color-border)]" />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
