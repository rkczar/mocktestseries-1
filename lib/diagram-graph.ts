/**
 * Pure, framework-agnostic graph builder for the Website Diagram. Takes the
 * route registry (lib/routes.ts, mirrored into RouteRegistryEntry) plus the
 * curated cross-connections (lib/route-connections.ts) and produces a plain
 * node/edge graph — no React, no Next.js, so it's easy to reason about and
 * reuse identically for both the Wiring and Flow views.
 */

import * as dagre from "@dagrejs/dagre";
import type { ConnectionSource, RouteConnection } from "./route-connections";

export interface DiagramEntry {
  pageName: string;
  route: string;
  module: string;
  userType: string;
  authRequired: boolean;
  parentRoute?: string | null;
  status: string;
  /** True when this entry was found on disk (a real page.tsx) but isn't in the registry DB yet — the diagram picked it up automatically. */
  autoDiscovered?: boolean;
}

export interface ConnectionRef {
  nodeId: string;
  source: ConnectionSource;
  label?: string;
  broken: boolean;
}

export interface DiagramNode {
  id: string;
  pageName: string;
  route: string;
  module: string;
  userType: string;
  authRequired: boolean;
  status: string;
  autoDiscovered: boolean;
  incoming: ConnectionRef[];
  outgoing: ConnectionRef[];
  connectionCount: number;
  isolated: boolean;
  /** Has outgoing navigation but nothing links into it — a common, milder problem than a fully isolated page. */
  noIncoming: boolean;
  x: number;
  y: number;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  source: ConnectionSource;
  label?: string;
  broken: boolean;
}

export interface DiagramGraph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  brokenEdges: DiagramEdge[];
  isolatedNodes: DiagramNode[];
}

/** Every parentRoute relationship in the registry is an implicit edge. */
function treeEdges(entries: DiagramEntry[]): DiagramEdge[] {
  return entries
    .filter((entry) => entry.parentRoute)
    .map((entry) => ({
      id: `tree:${entry.parentRoute}->${entry.route}`,
      from: entry.parentRoute as string,
      to: entry.route,
      source: "internal" as ConnectionSource,
      label: "Parent navigation",
      broken: false, // corrected below once we know which routes actually exist
    }));
}

export function buildGraph(entries: DiagramEntry[], connections: RouteConnection[]): DiagramGraph {
  const routeSet = new Set(entries.map((e) => e.route));

  const allEdges: DiagramEdge[] = [
    ...treeEdges(entries).map((edge) => ({ ...edge, broken: !routeSet.has(edge.from) || !routeSet.has(edge.to) })),
    ...connections.map((conn, i) => ({
      id: `cross:${i}:${conn.from}->${conn.to}`,
      from: conn.from,
      to: conn.to,
      source: conn.source,
      label: conn.label,
      broken: !routeSet.has(conn.from) || !routeSet.has(conn.to),
    })),
  ];

  const incomingByRoute = new Map<string, ConnectionRef[]>();
  const outgoingByRoute = new Map<string, ConnectionRef[]>();
  for (const edge of allEdges) {
    if (!outgoingByRoute.has(edge.from)) outgoingByRoute.set(edge.from, []);
    outgoingByRoute.get(edge.from)!.push({ nodeId: edge.to, source: edge.source, label: edge.label, broken: edge.broken });

    if (!incomingByRoute.has(edge.to)) incomingByRoute.set(edge.to, []);
    incomingByRoute.get(edge.to)!.push({ nodeId: edge.from, source: edge.source, label: edge.label, broken: edge.broken });
  }

  const nodes: DiagramNode[] = entries.map((entry) => {
    const incoming = incomingByRoute.get(entry.route) ?? [];
    const outgoing = outgoingByRoute.get(entry.route) ?? [];
    return {
      id: entry.route,
      pageName: entry.pageName,
      route: entry.route,
      module: entry.module,
      userType: entry.userType,
      authRequired: entry.authRequired,
      status: entry.status,
      autoDiscovered: entry.autoDiscovered ?? false,
      incoming,
      outgoing,
      connectionCount: incoming.length + outgoing.length,
      // Homepage is the root of the tree and expected to have no incoming edge.
      isolated: incoming.length === 0 && outgoing.length === 0 && entry.route !== "/",
      noIncoming: incoming.length === 0 && outgoing.length > 0 && entry.route !== "/",
      x: 0,
      y: 0,
    };
  });

  const brokenEdges = allEdges.filter((e) => e.broken);
  const isolatedNodes = nodes.filter((n) => n.isolated);

  return { nodes, edges: allEdges, brokenEdges, isolatedNodes };
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 92;

/** Assigns x/y positions via dagre. Edges with a missing endpoint are skipped for layout purposes (they still render, just without pulling a nonexistent node). */
export function layoutGraph(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  direction: "TB" | "LR" = "TB",
): DiagramNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 48, ranksep: 96 });
  g.setDefaultEdgeLabel(() => ({}));

  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to) {
      g.setEdge(edge.from, edge.to);
    }
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id) as { x: number; y: number } | undefined;
    return pos ? { ...node, x: pos.x, y: pos.y } : node;
  });
}
