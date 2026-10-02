import Link from "next/link";
import { requireStudentOrLogin } from "@/lib/student-session";
import { getPlatformControls, pausedMessage, PAUSABLE_CONTROLS, type PausableControl } from "@/lib/platform-controls";
import { isTestRefusalKey, TEST_REFUSALS } from "@/lib/test-refusals";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Temporarily Unavailable — Mock Test Series.in", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * Where a student lands when an action with no inline error surface (a
 * public "Start Mock" / "Attempt paper" link, a plain "Start" form) was
 * refused:
 *   ?feature=<control>  a Platform Controls pause — the admin's public
 *                       message for that control, else the default;
 *   ?test=<reason>      a test that can't be started right now
 *                       (lib/test-refusals.ts — fixed texts only).
 */
export default async function UnavailablePage({ searchParams }: { searchParams: Promise<{ feature?: string; test?: string }> }) {
  await requireStudentOrLogin();
  const { feature, test } = await searchParams;

  let title = "Temporarily unavailable";
  let message: string;
  if (isTestRefusalKey(test)) {
    title = "This test can't be started right now";
    message = TEST_REFUSALS[test];
  } else {
    const control: PausableControl = PAUSABLE_CONTROLS.includes(feature as PausableControl) ? (feature as PausableControl) : "tests";
    message = pausedMessage(await getPlatformControls(), control);
  }

  return (
    <div className="mx-auto w-full max-w-lg py-10">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-muted-foreground)]">{message}</p>
          <div className="flex flex-wrap gap-2">
            {test ? (
              <Button asChild className="w-fit">
                <Link href="/student/test-series">Open Test Series</Link>
              </Button>
            ) : null}
            <Button asChild className="w-fit" variant={test ? "outline" : "primary"}>
              <Link href="/student/dashboard">Back to dashboard</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
