import Link from "next/link";
import { Radio, Calendar, CheckCircle2, Trophy, Clock, HelpCircle } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getLiveTestsForStudent } from "@/lib/student-data";
import { formatIst } from "@/lib/ist-time";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BackButton } from "@/components/student/back-button";
import { startLiveTestFromListAction } from "./actions";

export const metadata = { title: "Live Tests — Mock Test Series.in" };

type Row = Awaited<ReturnType<typeof getLiveTestsForStudent>>["upcoming"][number];

export default async function StudentLiveTestsPage() {
  const student = await requireStudent();
  const { upcoming, live, completed, resultsAvailable } = await getLiveTestsForStudent(student.id);

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Live Tests</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Scheduled tests everyone takes together, in the same window. Times are shown in IST.
        </p>
      </div>

      <Section
        icon={<Radio className="h-4 w-4 text-[var(--color-success)]" aria-hidden />}
        title="Live Now"
        rows={live}
        empty="No live test is running right now."
        renderAction={(row) => <StartOrContinue row={row} />}
      />

      <Section
        icon={<Calendar className="h-4 w-4" aria-hidden />}
        title="Upcoming"
        rows={upcoming}
        empty="No upcoming live tests scheduled."
        renderAction={(row) => (
          <span className="text-xs text-[var(--color-muted-foreground)]">Starts {formatIst(row.liveTest.startAt)}</span>
        )}
      />

      <Section
        icon={<Trophy className="h-4 w-4 text-[var(--color-accent)]" aria-hidden />}
        title="Results Available"
        rows={resultsAvailable}
        empty="No published results yet."
        renderAction={(row) =>
          row.attempt ? (
            <Button asChild size="sm">
              <Link href={`/student/attempt/${row.attempt.id}/result`}>View Result</Link>
            </Button>
          ) : (
            <span className="text-xs text-[var(--color-muted-foreground)]">You didn&apos;t attempt this</span>
          )
        }
      />

      <Section
        icon={<CheckCircle2 className="h-4 w-4" aria-hidden />}
        title="Completed"
        rows={completed}
        empty="No completed live tests."
        renderAction={(row) =>
          row.attempt ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/student/attempt/${row.attempt.id}/result`}>View Score</Link>
            </Button>
          ) : (
            <span className="text-xs text-[var(--color-muted-foreground)]">You didn&apos;t attempt this</span>
          )
        }
      />
    </div>
  );
}

function Section({
  icon,
  title,
  rows,
  empty,
  renderAction,
}: {
  icon: React.ReactNode;
  title: string;
  rows: Row[];
  empty: string;
  renderAction: (row: Row) => React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon} {title}
        </CardTitle>
        <CardDescription>{rows.length} test{rows.length === 1 ? "" : "s"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-[var(--color-border)]">
        {rows.length === 0 ? (
          <p className="py-4 text-sm text-[var(--color-muted-foreground)]">{empty}</p>
        ) : (
          rows.map((row) => (
            <div key={row.liveTest.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="text-sm font-medium text-[var(--color-foreground)]">{row.liveTest.title}</p>
                <p className="text-xs text-[var(--color-muted-foreground)]">{row.liveTest.exam.name}</p>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-[var(--color-muted-foreground)]">
                  <span className="flex items-center gap-1">
                    <HelpCircle className="h-3.5 w-3.5" aria-hidden /> {row.liveTest.questionCount} Qs
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" aria-hidden /> {row.liveTest.studentDurationMinutes} min
                  </span>
                  <span>
                    {formatIst(row.liveTest.startAt)} → {formatIst(row.liveTest.endAt)}
                  </span>
                  {row.attempt?.status === "IN_PROGRESS" ? <Badge variant="warning">In Progress</Badge> : null}
                </div>
              </div>
              {renderAction(row)}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function StartOrContinue({ row }: { row: Row }) {
  if (row.attempt?.status === "IN_PROGRESS") {
    return (
      <Button asChild size="sm">
        <Link href={`/student/attempt/${row.attempt.id}`}>Continue</Link>
      </Button>
    );
  }
  if (row.attempt?.status === "SUBMITTED") {
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={`/student/attempt/${row.attempt.id}/result`}>View Result</Link>
      </Button>
    );
  }
  return (
    <form action={startLiveTestFromListAction.bind(null, row.liveTest.id)}>
      <Button type="submit" size="sm">
        Start
      </Button>
    </form>
  );
}
