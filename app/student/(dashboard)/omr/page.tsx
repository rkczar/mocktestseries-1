import { cookies } from "next/headers";
import { FileText } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { prisma } from "@/lib/prisma";
import { ACTIVE_EXAM_COOKIE } from "@/lib/active-exam";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/student/back-button";

export const metadata = { title: "Practice with OMR — Mock Test Series.in" };

export default async function StudentOmrPage() {
  await requireStudent();
  const cookieStore = await cookies();
  const activeExamId = cookieStore.get(ACTIVE_EXAM_COOKIE)?.value ?? null;

  const templates = await prisma.testResource.findMany({
    where: { type: "OMR_TEMPLATE", isActive: true },
    orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    select: { id: true, title: true, questionCount: true, examId: true },
  });

  // Templates matching the student's active exam surface first — same
  // "prefer that exam's assigned OMR" behavior the spec asks for, without a
  // second query.
  const sorted = activeExamId
    ? [...templates].sort((a, b) => Number(b.examId === activeExamId) - Number(a.examId === activeExamId))
    : templates;

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Practice with OMR Sheet</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Simulate the pen-and-paper exam experience — download a blank OMR sheet and practice offline.
        </p>
      </div>

      {sorted.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <FileText className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
            <p className="text-sm text-[var(--color-muted-foreground)]">No OMR templates are available yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((t) => (
            <Card key={t.id}>
              <CardHeader>
                <CardTitle className="text-base">{t.title}</CardTitle>
                {t.questionCount ? <CardDescription>{t.questionCount} Questions</CardDescription> : null}
              </CardHeader>
              <CardContent>
                <Button asChild size="sm" variant="outline">
                  <a href={`/api/student/test-resources/${t.id}`}>Download OMR Sheet</a>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
