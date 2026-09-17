import Link from "next/link";
import { ListChecks, Clock, HelpCircle, Trophy, Plus } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getPublishedCustomModulesForStudent, getStudentOwnedCustomModules } from "@/lib/student-data";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BackButton } from "@/components/student/back-button";

export const metadata = { title: "Custom Module — Mock Test Series.in" };

export default async function CustomModuleListPage() {
  const student = await requireStudent();
  const [rows, myModules] = await Promise.all([
    getPublishedCustomModulesForStudent(student.id),
    getStudentOwnedCustomModules(student.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Custom Module</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">Focused practice sets curated by Admin, or build your own.</p>
        </div>
        <Button asChild size="sm">
          <Link href="/student/custom-module/builder">
            <Plus className="h-4 w-4" aria-hidden /> Build Your Own
          </Link>
        </Button>
      </div>

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
                      {m.durationMinutes ? (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" aria-hidden /> {m.durationMinutes} min
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
        </div>
      ) : null}

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
                    {m.durationMinutes ? (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" aria-hidden /> {m.durationMinutes} min
                      </span>
                    ) : null}
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
  );
}
