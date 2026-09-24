import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, FileText, ListChecks } from "lucide-react";
import { getExamDetailForStudent } from "@/lib/student-data";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/student/back-button";
import { ExamSyllabus } from "@/components/student/exam-syllabus";
import { StartOrUnlock } from "@/components/student/start-or-unlock";
import { requireStudent } from "@/lib/student-session";
import { loadAccessContext, evaluateContentAccess } from "@/lib/payments/access";
import {
  startMockTestFromExamAction,
  startPaperFromExamAction,
  startCustomModuleFromExamAction,
} from "./actions";

export const metadata = { title: "Exam — Mock Test Series.in" };

export default async function ExamDetailPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  const detail = await getExamDetailForStudent(examId);
  if (!detail) notFound();

  const { exam, mockTests, customModules } = detail;
  const student = await requireStudent();
  const ctx = await loadAccessContext(student.id);

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/exams" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{exam.name}</h1>
        {exam.description ? <p className="text-sm text-[var(--color-muted-foreground)]">{exam.description}</p> : null}
      </div>

      {exam.subjects.length > 0 ? (
        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link href={`/student/subject-test/${examId}`}>Practice by subject →</Link>
        </Button>
      ) : null}

      {exam.syllabusEnabled ? <ExamSyllabus subjects={exam.subjects} description={exam.syllabusDescription} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ListChecks className="h-4 w-4" aria-hidden /> Mock Tests
          </CardTitle>
          <CardDescription>{mockTests.length} available</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-[var(--color-border)]">
          {mockTests.length === 0 ? (
            <p className="py-4 text-sm text-[var(--color-muted-foreground)]">No mock tests published yet.</p>
          ) : (
            mockTests.map((mt) => (
              <div key={mt.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="text-sm font-medium text-[var(--color-foreground)]">{mt.title}</p>
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    {mt._count.questions} Qs · {mt.durationMinutes} min
                  </p>
                </div>
                <StartOrUnlock access={evaluateContentAccess(ctx, { kind: "MOCK_TEST", id: mt.id, examId: exam.id, testSeriesId: mt.testSeriesId, accessType: mt.accessType })} action={startMockTestFromExamAction.bind(null, mt.id)} />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" aria-hidden /> Previous Year Papers
          </CardTitle>
          <CardDescription>{exam.previousYearPapers.length} available</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-[var(--color-border)]">
          {exam.previousYearPapers.length === 0 ? (
            <p className="py-4 text-sm text-[var(--color-muted-foreground)]">No previous year papers yet.</p>
          ) : (
            exam.previousYearPapers.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="text-sm font-medium text-[var(--color-foreground)]">{p.title}</p>
                  <p className="text-xs text-[var(--color-muted-foreground)]">{p.year}</p>
                </div>
                <StartOrUnlock access={evaluateContentAccess(ctx, { kind: "PREVIOUS_YEAR_PAPER", id: p.id, examId: exam.id })} action={startPaperFromExamAction.bind(null, p.id)} />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" aria-hidden /> Custom Modules
          </CardTitle>
          <CardDescription>{customModules.length} available</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-[var(--color-border)]">
          {customModules.length === 0 ? (
            <p className="py-4 text-sm text-[var(--color-muted-foreground)]">No custom modules for this exam yet.</p>
          ) : (
            customModules.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="text-sm font-medium text-[var(--color-foreground)]">{m.title}</p>
                  <p className="text-xs text-[var(--color-muted-foreground)]">{m._count.questions} Qs</p>
                </div>
                <StartOrUnlock access={evaluateContentAccess(ctx, { kind: "CUSTOM_MODULE", id: m.id, examId: exam.id, accessType: m.accessType })} action={startCustomModuleFromExamAction.bind(null, m.id)} />
              </div>
            ))
          )}
          <div className="pt-3">
            <Button asChild variant="outline" size="sm">
              <Link href={`/student/custom-module?examId=${examId}`}>Build Your Own Module →</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
