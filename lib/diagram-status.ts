import type { BadgeProps } from "@/components/ui/badge";

export type DisplayStatusKey = "WORKING" | "BROKEN" | "MISSING" | "COMING_SOON" | "DEPRECATED";

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
 * Single source of truth for the five states shown across the Website
 * Diagram (node badges, drawer, registry, broken-pages table). Collapses the
 * underlying RouteStatus enum plus live graph-shape signals (file missing on
 * disk, no wiring at all, unreachable) into: Working, Broken, Missing, Coming
 * Soon, Deprecated. Precedence: deprecated > missing file > coming soon
 * (DRAFT) > any known problem > working.
 */
export function resolveDisplayStatus(input: StatusInput): DisplayStatus {
  if (input.deprecated) return { key: "DEPRECATED", label: "Deprecated", variant: "neutral" };
  if (input.missing) return { key: "MISSING", label: "Missing", variant: "warning" };
  if (input.status === "DRAFT") return { key: "COMING_SOON", label: "Coming Soon", variant: "info" };
  if (
    input.status === "BROKEN" ||
    input.status === "ORPHAN" ||
    input.status === "UNAUTHORIZED" ||
    input.status === "WARNING" ||
    input.isolated ||
    input.noIncoming
  ) {
    return { key: "BROKEN", label: "Broken", variant: "error" };
  }
  return { key: "WORKING", label: "Working", variant: "success" };
}
