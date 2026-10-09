import { Badge } from "@/components/ui/badge";
import { POST_STATUS_LABELS, type PostStatusLabel } from "@/lib/instagram/types";

const VARIANT: Record<PostStatusLabel, "neutral" | "primary" | "success" | "error" | "warning" | "info"> = {
  NOT_CREATED: "neutral",
  DRAFT: "info",
  READY: "primary",
  PUBLISHING: "warning",
  PUBLISHED: "success",
  FAILED: "error",
};

/** Instagram status of a question. "Instagram ✓ Posted" wins whenever any version was published. */
export function InstagramStatusBadge({ status, posted }: { status: PostStatusLabel; posted?: boolean }) {
  if (posted && status !== "PUBLISHED") {
    return (
      <span className="inline-flex flex-wrap gap-1">
        <Badge variant="success">{POST_STATUS_LABELS.PUBLISHED}</Badge>
        <Badge variant={VARIANT[status]}>{`New version: ${POST_STATUS_LABELS[status]}`}</Badge>
      </span>
    );
  }
  return (
    <Badge variant={VARIANT[status]} data-status={status}>
      {POST_STATUS_LABELS[status]}
    </Badge>
  );
}
