import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { requireStudentOrLogin } from "@/lib/student-session";
import { getActiveExamsCatalog } from "@/lib/student-data";
import { Card, CardContent } from "@/components/ui/card";
import { BackButton } from "@/components/student/back-button";
import { EnrollToggle } from "./enroll-toggle";
import { getStudentExamAccessSummaries } from "@/lib/payments/student-access";
import { formatInr } from "@/lib/payments/money";

export const metadata = { title: "My Exams — Mock Test Series.in" };

export default async function MyExamsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const student = await requireStudentOrLogin();
  const { filter } = await searchParams;
  const allExams = await getActiveExamsCatalog(student.id);
  const exams = filter === "enrolled" ? allExams.filter((e) => e.isEnrolled) : allExams;
  // Per-exam access state for enrolled exams (each exam has its own products and entitlements).
  const summaries = new Map(
    (await getStudentExamAccessSummaries(student.id, allExams.filter((e) => e.isEnrolled))).map((a) => [a.exam.id, a])
  );
  const fmtDay = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">My Exams</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Exams are managed by Admin — new exams and papers appear here automatically once published. Enroll to keep
          a focused list of the exams you&apos;re preparing for.
        </p>
      </div>

      <div className="flex gap-2">
        <Link
          href="/student/exams"
          className={`rounded-[var(--radius-button)] border px-3 py-1.5 text-sm ${
            filter !== "enrolled"
              ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
              : "border-[var(--color-border)] text-[var(--color-muted-foreground)]"
          }`}
        >
          All Exams
        </Link>
        <Link
          href="/student/exams?filter=enrolled"
          className={`rounded-[var(--radius-button)] border px-3 py-1.5 text-sm ${
            filter === "enrolled"
              ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
              : "border-[var(--color-border)] text-[var(--color-muted-foreground)]"
          }`}
        >
          Enrolled ({allExams.filter((e) => e.isEnrolled).length})
        </Link>
      </div>

      {exams.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <GraduationCap className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
            <p className="text-sm text-[var(--color-muted-foreground)]">
              {filter === "enrolled" ? "You haven't enrolled in any exams yet." : "No exams are currently available."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {exams.map((exam) => (
            <Card key={exam.id} className="flex h-full flex-col transition-shadow hover:shadow-md">
              <Link href={`/student/exams/${exam.id}`}>
                <CardContent className="flex flex-col gap-2 pt-5">
                  <p className="font-medium text-[var(--color-foreground)]">{exam.name}</p>
                  {exam.year ? <p className="text-xs text-[var(--color-muted-foreground)]">{exam.year}</p> : null}
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-[var(--color-muted-foreground)]">
                    <span>{exam._count.previousYearPapers} PYQ papers</span>
                    <span>{exam._count.mockTests} mock tests</span>
                    <span>{exam._count.customModules} custom modules</span>
                  </div>
                </CardContent>
              </Link>
              <div className="mt-auto flex flex-col gap-2 px-5 pb-5">
                {(() => {
                  const a = summaries.get(exam.id);
                  if (!a) return null;
                  if (a.state === "ACTIVE")
                    return <p className="text-xs font-medium text-[var(--color-success)]">Access active{a.entitlement?.expiresAt ? ` till ${fmtDay(a.entitlement.expiresAt)}` : ""}</p>;
                  if (a.state === "EXPIRED") return <p className="text-xs font-medium text-[var(--color-warning)]">Access expired</p>;
                  if (a.state === "FREE" && a.checkoutHref)
                    return (
                      <Link href={a.checkoutHref} className="text-xs font-medium text-[var(--color-primary)] underline underline-offset-2">
                        Buy access{a.offer?.showPrice ? ` — ${formatInr(a.offer.price.pricePaise)}` : ""}
                      </Link>
                    );
                  return null;
                })()}
                <EnrollToggle examId={exam.id} initialEnrolled={exam.isEnrolled} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
