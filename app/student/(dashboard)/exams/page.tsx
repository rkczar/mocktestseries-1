import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { getActiveExamsCatalog } from "@/lib/student-data";
import { Card, CardContent } from "@/components/ui/card";
import { BackButton } from "@/components/student/back-button";

export const metadata = { title: "My Exams — Mock Test Series.in" };

export default async function MyExamsPage() {
  const exams = await getActiveExamsCatalog();

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">My Exams</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Exams are managed by Admin — new exams and papers appear here automatically once published.
        </p>
      </div>

      {exams.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <GraduationCap className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
            <p className="text-sm text-[var(--color-muted-foreground)]">No exams are currently available.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {exams.map((exam) => (
            <Link key={exam.id} href={`/student/exams/${exam.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="flex flex-col gap-2 pt-5">
                  <p className="font-medium text-[var(--color-foreground)]">{exam.name}</p>
                  {exam.year ? <p className="text-xs text-[var(--color-muted-foreground)]">{exam.year}</p> : null}
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-[var(--color-muted-foreground)]">
                    <span>{exam._count.previousYearPapers} PYQ papers</span>
                    <span>{exam._count.mockTests} mock tests</span>
                    <span>{exam._count.customModules} custom modules</span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
