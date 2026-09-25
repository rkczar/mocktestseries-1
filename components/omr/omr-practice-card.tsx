import { FileDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Presentation-only Practice OMR card shared by the Public Homepage and the
 * Student Dashboard. Both link to the same canonical download route
 * (/api/student/test-resources/<id>), which brands the PDF in lib/omr-sheet.ts
 * — this component holds no download logic of its own.
 */
export function omrDownloadHref(resourceId: string) {
  return `/api/student/test-resources/${resourceId}`;
}

export function OmrPracticeCard({
  resourceId,
  context,
  className,
}: {
  resourceId: string;
  context: "homepage" | "dashboard";
  className?: string;
}) {
  const homepage = context === "homepage";
  const Heading = homepage ? "h2" : "h3";

  return (
    <Card className={cn("flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:gap-6", homepage && "sm:p-8", className)}>
      <span
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius-card)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
        aria-hidden
      >
        <FileDown className="h-6 w-6" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-primary)]">Practice OMR Sheet</p>
        <Heading className={cn("font-semibold text-[var(--color-foreground)]", homepage ? "text-xl sm:text-2xl" : "text-base")}>
          {homepage ? "Practice Like the Real Exam" : "Download OMR Sheet for Practice"}
        </Heading>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {homepage
            ? "Download a printable OMR sheet and practice marking your answers before exam day."
            : "Practice marking answers offline using our printable OMR sheet."}
        </p>
        {homepage ? <p className="text-xs text-[var(--color-muted-foreground)]">Free • Printable • Practice Ready</p> : null}
      </div>
      <Button asChild variant={homepage ? "primary" : "outline"} size={homepage ? "default" : "sm"} className="w-full shrink-0 sm:w-auto">
        <a href={omrDownloadHref(resourceId)} target="_blank" rel="noopener">
          Download OMR Sheet
        </a>
      </Button>
    </Card>
  );
}
