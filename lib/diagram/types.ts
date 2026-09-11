// Shared types for the Website Diagram system. The graph itself is always derived from the
// actual app/ route tree + source files (see scanRoutes.ts / scanLinks.ts / buildGraph.ts) — these
// types describe the *result* of that detection, cached in DiagramSnapshot, plus the small
// amount of admin-authored metadata that genuinely cannot be detected (DiagramNodeMeta /
// DiagramPlannedPage).

export type DiagramSection =
  | "Public Website"
  | "Authentication"
  | "Student Area"
  | "Test Player"
  | "Admin Area"
  | "AI"
  | "API / Backend";

export type DiagramContentArea = "Exams" | "Tests" | "AI" | "General";

export type DiagramAccessLevel = "Public" | "Student" | "Admin" | "System";

export type DiagramNodeStatus =
  | "ACTIVE"
  | "COMING_SOON"
  | "DRAFT"
  | "IN_DEVELOPMENT"
  | "BROKEN"
  | "DISCONNECTED"
  | "NEEDS_REVIEW";

export type DiagramNodeKind = "page" | "api" | "missing" | "planned";

export interface DiagramNode {
  id: string;
  route: string | null;
  label: string;
  section: DiagramSection;
  contentArea: DiagramContentArea;
  accessLevel: DiagramAccessLevel;
  kind: DiagramNodeKind;
  status: DiagramNodeStatus;
  isDynamic: boolean;
  incoming: string[];
  outgoing: string[];
  brokenOutgoing: string[];
  notes: string | null;
  detectionSource: string;
  contentNote: string | null;
}

export type DiagramEdgeKind = "link" | "action" | "fetch" | "global-nav" | "broken";

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  kind: DiagramEdgeKind;
}

export interface DiagramSummary {
  totalPages: number;
  activePages: number;
  comingSoon: number;
  draftOrInDevelopment: number;
  brokenLinks: number;
  disconnectedPages: number;
  needsReview: number;
}

export interface DiagramGraph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  summary: DiagramSummary;
  generatedAt: string;
}
