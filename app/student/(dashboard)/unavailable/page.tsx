import Link from "next/link";
import { requireStudent } from "@/lib/student-session";
import { getPlatformControls, pausedMessage, PAUSABLE_CONTROLS, type PausableControl } from "@/lib/platform-controls";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Temporarily Unavailable — Mock Test Series.in", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * Where a student lands when a Platform Controls pause refused an action
 * that has no inline error surface (e.g. a plain "Start Test" form). The
 * message is the admin's public message for that control, else the default.
 */
export default async function UnavailablePage({ searchParams }: { searchParams: Promise<{ feature?: string }> }) {
  await requireStudent();
  const { feature } = await searchParams;
  const control: PausableControl = PAUSABLE_CONTROLS.includes(feature as PausableControl) ? (feature as PausableControl) : "tests";
  const message = pausedMessage(await getPlatformControls(), control);

  return (
    <div className="mx-auto w-full max-w-lg py-10">
      <Card>
        <CardHeader>
          <CardTitle>Temporarily unavailable</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-muted-foreground)]">{message}</p>
          <Button asChild className="w-fit">
            <Link href="/student/dashboard">Back to dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
