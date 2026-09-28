import Link from "next/link";
import { MonitorSmartphone } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Shown by the run page instead of the player when another of the student's
 * devices is running a test (One Active Test Device). No question data is
 * rendered; the attempt itself is untouched.
 */
export function TestOpenElsewhere({ attemptId }: { attemptId: string }) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-lg items-center px-4">
      <Card className="w-full">
        <CardContent className="flex flex-col items-center gap-4 pt-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-warning)]/15 text-[var(--color-warning)]">
            <MonitorSmartphone className="h-6 w-6" aria-hidden />
          </div>
          <div className="flex flex-col gap-1.5">
            <h1 className="text-lg font-semibold text-[var(--color-foreground)]">Test open on another device</h1>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Your account is running a test on another device. For exam security, a test can only run on one device at a
              time. Your answers are saved and safe.
            </p>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Continue on that device, or close the test there and try again here after about 3 minutes.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/student/dashboard">Go to Dashboard</Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`/student/attempt/${attemptId}/run`} prefetch={false}>
                Try again
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
