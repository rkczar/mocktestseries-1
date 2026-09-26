import Link from "next/link";
import { cookies } from "next/headers";
import { ListChecks, Clock, HelpCircle, Trophy } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import {
  getPublishedCustomModulesForStudent,
  getStudentOwnedCustomModules,
  getActiveExamsCatalog,
  getSubjectTestSetup,
  isStudentEnrolledInExam,
} from "@/lib/student-data";
import { ACTIVE_EXAM_COOKIE } from "@/lib/active-exam";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BackButton } from "@/components/student/back-button";
import { CustomModuleTabs } from "./module-tabs";
import { CustomModuleBuilder } from "./builder/custom-module-builder";
import { moduleDurationLabel } from "@/lib/module-duration-label";

export const metadata = { title: "Custom Module — Mock Test Series.in" };

export default async function CustomModuleListPage({ searchParams }: { searchParams: Promise<{ examId?: string }> }) {
  const student = await requireStudent();
  const { examId: requestedExamId } = await searchParams;
  const cookieStore = await cookies();
  const activeExamCookie = cookieStore.get(ACTIVE_EXAM_COOKIE)?.value;

  const exams = await getActiveExamsCatalog();

  // Preselect: an explicit ?examId= (deep link from Exam detail) wins,
  // otherwise the student's Active Exam if they're still enrolled in it
  // (Section 9) — never an exam they aren't authorized/enrolled to use.
  let preselectExamId: string | undefined = requestedExamId && exams.some((e) => e.id === requestedExamId) ? requestedExamId : undefined;
  if (!preselectExamId && activeExamCookie) {
    const enrolled = await isStudentEnrolledInExam(student.id, activeExamCookie);
    if (enrolled) preselectExamId = activeExamCookie;
  }

  const [rows, myModules, initialSetup] = await Promise.all([
    getPublishedCustomModulesForStudent(student.id),
    getStudentOwnedCustomModules(student.id),
    preselectExamId ? getSubjectTestSetup(preselectExamId) : Promise.resolve(null),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Custom Module</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Build a focused practice set right here, or reuse one you or Admin already made.
        </p>
      </div>

      <CustomModuleTabs
        buildContent={
          <CustomModuleBuilder
            studentId={student.id}
            exams={exams.map((e) => ({ id: e.id, name: e.name }))}
            initialExam={
              initialSetup && preselectExamId
                ? {
                    id: preselectExamId,
                    name: initialSetup.exam.name,
                    subjects: initialSetup.exam.subjects,
                    years: initialSetup.years,
                  }
                : null
            }
          />
        }
        myModulesContent={<MyModulesPanel rows={rows} myModules={myModules} />}
      />
    </div>
  );
}

function MyModulesPanel({
  rows,
  myModules,
}: {
  rows: Awaited<ReturnType<typeof getPublishedCustomModulesForStudent>>;
  myModules: Awaited<ReturnType<typeof getStudentOwnedCustomModules>>;
}) {
  return (
    <div className="flex flex-col gap-6">
      {myModules.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-foreground)]">My Modules</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {myModules.map(({ module: m, latestAttempt }) => (
              <Link key={m.id} href={`/student/custom-module/${m.id}`}>
                <Card className="flex h-full flex-col transition-shadow hover:shadow-md">
                  <CardContent className="flex flex-1 flex-col gap-3 pt-5">
                    <div>
                      <p className="font-medium text-[var(--color-foreground)]">{m.title}</p>
                      <p className="text-xs text-[var(--color-muted-foreground)]">{m.exam.name}</p>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-[var(--color-muted-foreground)]">
                      <span className="flex items-center gap-1">
                        <HelpCircle className="h-3.5 w-3.5" aria-hidden /> {m._count.questions} Qs
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" aria-hidden />{" "}
                        {moduleDurationLabel({ durationMode: m.durationMode, durationMinutes: m.durationMinutes, questionCount: m._count.questions })}
                      </span>
                    </div>
                    {latestAttempt ? (
                      <Badge variant={latestAttempt.status === "IN_PROGRESS" ? "warning" : "success"} className="w-fit">
                        {latestAttempt.status === "IN_PROGRESS" ? "In Progress" : "Attempted"}
                      </Badge>
                    ) : null}
                    <div className="mt-auto pt-2">
                      <Button size="sm" tabIndex={-1} className="pointer-events-none">
                        {!latestAttempt ? "Start" : latestAttempt.status === "IN_PROGRESS" ? "Continue" : "View"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-foreground)]">Curated by Admin</h2>

        {rows.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
              <ListChecks className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
              <p className="text-sm text-[var(--color-muted-foreground)]">No custom modules are available.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map(({ module: m, bestScore, latestAttempt }) => (
              <Link key={m.id} href={`/student/custom-module/${m.id}`}>
                <Card className="flex h-full flex-col transition-shadow hover:shadow-md">
                  <CardContent className="flex flex-1 flex-col gap-3 pt-5">
                    <div>
                      <p className="font-medium text-[var(--color-foreground)]">{m.title}</p>
                      <p className="text-xs text-[var(--color-muted-foreground)]">{m.exam.name}</p>
                    </div>

                    <div className="flex flex-wrap gap-3 text-xs text-[var(--color-muted-foreground)]">
                      <span className="flex items-center gap-1">
                        <HelpCircle className="h-3.5 w-3.5" aria-hidden /> {m._count.questions} Qs
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" aria-hidden />{" "}
                        {moduleDurationLabel({ durationMode: m.durationMode, durationMinutes: m.durationMinutes, questionCount: m._count.questions })}
                      </span>
                      {bestScore !== null && bestScore !== undefined ? (
                        <span className="flex items-center gap-1">
                          <Trophy className="h-3.5 w-3.5" aria-hidden /> Best: {bestScore.toFixed(1)}
                        </span>
                      ) : null}
                    </div>

                    {latestAttempt ? (
                      <Badge variant={latestAttempt.status === "IN_PROGRESS" ? "warning" : "success"} className="w-fit">
                        {latestAttempt.status === "IN_PROGRESS" ? "In Progress" : "Attempted"}
                      </Badge>
                    ) : null}

                    <div className="mt-auto pt-2">
                      <Button size="sm" tabIndex={-1} className="pointer-events-none">
                        {!latestAttempt ? "Start" : latestAttempt.status === "IN_PROGRESS" ? "Continue" : "View"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
