/**
 * Derives the Website Diagram's "Issues & Disconnections" panel (Section 7)
 * from the already-computed graph — pure aggregation, no additional
 * scanning. Every item traces back to a real signal already produced by
 * `lib/diagram-graph.ts` / `lib/diagram-source.ts`: a broken edge, a missing
 * page, an isolated node, a draft route, or a deprecated route still linked
 * to. Framework-agnostic, like the rest of the diagram lib, so it runs on
 * both the server (page.tsx) and the client canvas (graph-view.tsx).
 */

import type { DiagramGraph } from "./diagram-graph";

export type DiagramIssueKind =
  | "BROKEN_ROUTE"
  | "MISSING_PAGE"
  | "INVALID_DYNAMIC_LINK"
  | "ORPHAN"
  | "NO_INCOMING"
  | "DRAFT"
  | "DEPRECATED_REFERENCED"
  | "ADMIN_DISCONNECTED";

export interface DiagramIssue {
  id: string;
  kind: DiagramIssueKind;
  /** The node this issue should focus/highlight when clicked. */
  nodeId: string;
  title: string;
  detail: string;
}

export const DIAGRAM_ISSUE_LABELS: Record<DiagramIssueKind, string> = {
  BROKEN_ROUTE: "Broken connection",
  MISSING_PAGE: "Missing page",
  INVALID_DYNAMIC_LINK: "Invalid dynamic route link",
  ORPHAN: "Disconnected / orphan page",
  NO_INCOMING: "No incoming navigation",
  DRAFT: "Draft route",
  DEPRECATED_REFERENCED: "Deprecated route still referenced",
  ADMIN_DISCONNECTED: "Admin module not connected to its frontend page",
};

export function computeIssues(graph: DiagramGraph): DiagramIssue[] {
  const issues: DiagramIssue[] = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  for (const edge of graph.brokenEdges) {
    const dynamic = edge.to.includes("[") || edge.from.includes("[");
    const kind: DiagramIssueKind =
      edge.source === "admin-config" ? "ADMIN_DISCONNECTED" : dynamic ? "INVALID_DYNAMIC_LINK" : "BROKEN_ROUTE";
    issues.push({
      id: `edge:${edge.id}`,
      kind,
      nodeId: nodeById.has(edge.from) ? edge.from : edge.to,
      title: DIAGRAM_ISSUE_LABELS[kind],
      detail: `${edge.from} → ${edge.to} (${edge.label ?? edge.source})`,
    });
  }

  for (const node of graph.nodes) {
    if (node.missing) {
      issues.push({
        id: `missing:${node.id}`,
        kind: "MISSING_PAGE",
        nodeId: node.id,
        title: DIAGRAM_ISSUE_LABELS.MISSING_PAGE,
        detail: `${node.pageName} (${node.route}) is registered but no page.tsx exists on disk.`,
      });
    }
    if (node.isolated) {
      issues.push({
        id: `orphan:${node.id}`,
        kind: "ORPHAN",
        nodeId: node.id,
        title: DIAGRAM_ISSUE_LABELS.ORPHAN,
        detail: `${node.pageName} (${node.route}) has no incoming or outgoing connections.`,
      });
    }
    if (node.noIncoming) {
      issues.push({
        id: `noincoming:${node.id}`,
        kind: "NO_INCOMING",
        nodeId: node.id,
        title: DIAGRAM_ISSUE_LABELS.NO_INCOMING,
        detail: `${node.pageName} (${node.route}) is only reachable by typing the URL directly.`,
      });
    }
    if (node.status === "DRAFT" && !node.deprecated) {
      issues.push({
        id: `draft:${node.id}`,
        kind: "DRAFT",
        nodeId: node.id,
        title: DIAGRAM_ISSUE_LABELS.DRAFT,
        detail: `${node.pageName} (${node.route}) is registered but not built yet.`,
      });
    }
    if (node.deprecated && node.incoming.length > 0) {
      issues.push({
        id: `deprecated:${node.id}`,
        kind: "DEPRECATED_REFERENCED",
        nodeId: node.id,
        title: DIAGRAM_ISSUE_LABELS.DEPRECATED_REFERENCED,
        detail: `${node.pageName} (${node.route}) is deprecated but still has ${node.incoming.length} incoming connection${
          node.incoming.length === 1 ? "" : "s"
        }.`,
      });
    }
  }

  return issues;
}
