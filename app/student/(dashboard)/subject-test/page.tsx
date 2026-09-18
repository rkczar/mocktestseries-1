import Link from "next/link";
import { BookOpen, ChevronRight } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getSubjectTestExams } from "@/lib/student-data";
import { Card, CardContent } from "@/components/ui/card";
import { BackButton } from "@/components/student/back-button";

export const metadata = { title: "Subject Test — Mock Test Series.in" };

export default async function SubjectTestPage() {
  await requireStudent();
  const exams = await getSubjectTestExams();

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Subject Test</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Pick an exam, then build a focused practice test by subject, year, topic or sub-topic.
        </p>
      </div>

      {exams.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-[var(--color-muted-foreground)]">
            <BookOpen className="mx-auto mb-2 h-8 w-8" aria-hidden />
            No exams are available right now.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {exams.map((exam) => (
            <Link key={exam.id} href={`/student/subject-test/${exam.id}`} className="group">
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="flex items-center justify-between gap-3 pt-5">
                  <div>
                    <p className="font-medium text-[var(--color-foreground)]">{exam.name}</p>
                    <p className="text-sm text-[var(--color-muted-foreground)]">
                      {exam._count.subjects} subject{exam._count.subjects === 1 ? "" : "s"}
                    </p>
                  </div>
                  <ChevronRight className="h-5 w-5 text-[var(--color-muted-foreground)] transition-transform group-hover:translate-x-0.5" aria-hidden />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}