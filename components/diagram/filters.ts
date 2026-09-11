import type { DiagramContentArea, DiagramNode, DiagramNodeStatus, DiagramSection } from "@/lib/diagram/types";

export interface DiagramFilterState {
  search: string;
  sections: Set<DiagramSection> | "ALL";
  contentAreas: Set<DiagramContentArea> | "ALL";
  statuses: Set<DiagramNodeStatus> | "ALL";
}

export const DEFAULT_FILTERS: DiagramFilterState = { search: "", sections: "ALL", contentAreas: "ALL", statuses: "ALL" };

export function nodeMatchesFilters(node: DiagramNode, filters: DiagramFilterState): boolean {
  if (filters.sections !== "ALL" && !filters.sections.has(node.section)) return false;
  if (filters.contentAreas !== "ALL" && !filters.contentAreas.has(node.contentArea)) return false;
  if (filters.statuses !== "ALL" && !filters.statuses.has(node.status)) return false;

  const q = filters.search.trim().toLowerCase();
  if (!q) return true;
  return (
    node.label.toLowerCase().includes(q) ||
    (node.route ?? "").toLowerCase().includes(q) ||
    node.section.toLowerCase().includes(q) ||
    node.status.toLowerCase().includes(q)
  );
}

export function toggleInSet<T>(current: Set<T> | "ALL", value: T, allValues: T[]): Set<T> | "ALL" {
  const base = current === "ALL" ? new Set<T>() : new Set(current);
  if (base.has(value)) base.delete(value);
  else base.add(value);
  if (base.size === 0 || base.size === allValues.length) return "ALL";
  return base;
}
