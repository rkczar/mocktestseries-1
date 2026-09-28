import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Shown for an ABANDONED attempt — one closed by an admin data correction
 * (e.g. PYQ_DATA_CORRECTION: the paper it was frozen from was later found
 * to contain wrong questions). The attempt's snapshot and answers are kept
 * untouched for history; it just can no longer be continued, and starting
 * the test again creates a fresh attempt from the corrected content.
 */
export function AttemptResetNotice({ isPyq }: { isPyq: boolean }) {
  const href = isPyq ? "/student/dashboard#previous-year-papers" : "/student/dashboard";
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-4 py-10">
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <RotateCcw className="h-8 w-8 text-[var(--color-primary)]" aria-hidden />
          <h1 className="text-lg font-semibold text-[var(--color-foreground)]">This attempt was reset</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {isPyq
              ? "The question set of this previous year paper was corrected after you started. Your earlier attempt was closed without a score — start the paper again to take the corrected version."
              : "This test's content was corrected after you started. Your earlier attempt was closed without a score — start the test again to take the corrected version."}
          </p>
          <Button asChild>
            <Link href={href}>{isPyq ? "Go to Previous Year Papers" : "Go to Dashboard"}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
