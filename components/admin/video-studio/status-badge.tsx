import { Badge } from "@/components/ui/badge";
import { JOB_STATUS_LABELS } from "@/lib/video-studio/types";

const TONE = { neutral: "neutral", progress: "info", review: "warning", done: "success", failed: "error" } as const;

export function JobStatusBadge({ status }: { status: string }) {
  const s = JOB_STATUS_LABELS[status] ?? { label: status, tone: "neutral" as const };
  return (
    <Badge variant={TONE[s.tone]} data-testid="job-status" data-status={status}>
      {s.label}
    </Badge>
  );
}
