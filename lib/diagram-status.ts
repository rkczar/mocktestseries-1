import type { BadgeProps } from "@/components/ui/badge";

export type DisplayStatusKey = "WORKING" | "BROKEN" | "MISSING" | "COMING_SOON" | "DEPRECATED" | "DISCONNECTED";

export interface DisplayStatus {
  key: DisplayStatusKey;
  label: string;
  variant: BadgeProps["variant"];
}

interface StatusInput {
  status: string;
  deprecated?: boolean;
  missing?: boolean;
  isolated?: boolean;
  noIncoming?: boolean;
}

/**
 * Single source of truth for the states shown across the Website Diagram
 * (node badges, drawer, registry, broken-pages table, summary cards).
 * Collapses the underlying RouteStatus enum plus live graph-shape signals
 * (file missing on disk, no wiring at all, unreachable) into: Live, Broken,
 * Missing, Coming Soon, Deprecated, Disconnected. Precedence: deprecated >
 * missing file > coming soon (DRAFT) > disconnected (fully isolated, no
 * wiring at all) > any other known problem > live.
 *
 * Disconnected is intentionally its own state, distinct from Broken: Broken
 * means something is wired but wrong (points at a missing route, an orphaned
 * parent, a misconfigured auth requirement); Disconnected means a real,
 * working page simply has no edges at all connecting it to the rest of the
 * site.
 */
export function resolveDisplayStatus(input: StatusInput): DisplayStatus {
  if (input.deprecated) return { key: "DEPRECATED", label: "Deprecated", variant: "neutral" };
  if (input.missing) return { key: "MISSING", label: "Missing", variant: "warning" };
  if (input.status === "DRAFT") return { key: "COMING_SOON", label: "Coming Soon", variant: "info" };
  if (input.isolated) return { key: "DISCONNECTED", label: "Disconnected", variant: "warning" };
  if (
    input.status === "BROKEN" ||
    input.status === "ORPHAN" ||
    input.status === "UNAUTHORIZED" ||
    input.status === "WARNING" ||
    input.noIncoming
  ) {
    return { key: "BROKEN", label: "Broken", variant: "error" };
  }
  return { key: "WORKING", label: "Live", variant: "success" };
}

/** Collapses the six display statuses into the five buckets used by the diagram's top summary cards. */
export type SummaryBucket = "LIVE" | "DRAFT" | "BROKEN" | "DISCONNECTED" | "DEPRECATED";

export function summaryBucket(key: DisplayStatusKey): SummaryBucket {
  switch (key) {
    case "WORKING":
      return "LIVE";
    case "COMING_SOON":
      return "DRAFT";
    case "DISCONNECTED":
      return "DISCONNECTED";
    case "DEPRECATED":
      return "DEPRECATED";
    case "BROKEN":
    case "MISSING":
    default:
      return "BROKEN";
  }
}
