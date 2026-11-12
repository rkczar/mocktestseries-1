import Link from "next/link";
import { requireStudentOrLogin } from "@/lib/student-session";
import { getActiveExamsCatalog } from "@/lib/student-data";
import { examShortName } from "@/lib/exam-editorial-facts";
import { Card, CardContent } from "@/components/ui/card";
import { ChooseExamButton } from "./choose-exam-button";

export const metadata = { title: "Choose your exam — Mock Test Series.in" };

/**
 * Exam choice for the hybrid multi-exam flow: a new student (two or more active exams, so nobody is
 * auto-enrolled) picks here, and exam-page CTAs land here with ?exam=<publicSlug|code|id> so the
 * student confirms that exam with one tap. Existing enrollments are never changed by this page.
 */
export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ exam?: string }> }) {
  const student = await requireStudentOrLogin();
  const { exam: hint } = await searchParams;
  const exams = await getActiveExamsCatalog(student.id);
  const preferred = hint ? exams.find((e) => e.publicSlug === hint || e.code === hint || e.id === hint) : undefined;
  const ordered = preferred ? [preferred, ...exams.filter((e) => e.id !== preferred.id)] : exams;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">
          {preferred ? `Start preparing for ${examShortName(preferred.code, preferred.name)}` : "Choose your exam"}
        </h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          You can add more exams later from My Exams. Each exam keeps its own tests, results and access.
        </p>
      </div>
      {ordered.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">No exams are available right now.</CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {ordered.map((exam) => (
            <Card key={exam.id} className={exam.id === preferred?.id ? "border-[var(--color-primary)]" : undefined}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div className="min-w-0">
                  <p className="font-medium text-[var(--color-foreground)]">{examShortName(exam.code, exam.name)}</p>
                  <p className="text-xs text-[var(--color-muted-foreground)]">{exam.name}</p>
                </div>
                {exam.isEnrolled ? (
                  <ChooseExamButton examId={exam.id} label="Open" />
                ) : (
                  <ChooseExamButton examId={exam.id} label={exam.id === preferred?.id ? "Start" : "Choose"} />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Link href="/student/exams" className="text-sm text-[var(--color-primary)] underline-offset-2 hover:underline">
        See all exams
      </Link>
    </div>
  );
}
