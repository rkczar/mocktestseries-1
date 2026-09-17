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
  /** True when this route is registered but no matching page.tsx exists on disk right now. */
  missing?: boolean;
  /** True when this route is listed in lib/deprecated-routes.ts. */
  deprecated?: boolean;
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
  missing: boolean;
  deprecated: boolean;
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
      missing: entry.missing ?? false,
      deprecated: entry.deprecated ?? false,
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

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 92;

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

export interface GroupBox {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed: boolean;
  nodeIds: string[];
}

const GROUP_GAP = 56;
const GROUP_HEADER_HEIGHT = 48;
const GROUP_PADDING = 24;
const ROW_GAP = 40;
const MAX_NODES_PER_ROW = 4;

/**
 * Lays the graph out as a vertical stack of grouped containers instead of
 * one flat dagre pass over every node. A flat pass over ~90 nodes puts every
 * top-level fan-out (e.g. Admin Dashboard's dozen sections) on a single
 * dagre rank, which is what made the previous Website Diagram absurdly wide.
 * Here, each group gets its own small dagre TB layout (so intra-group
 * hierarchy still reads correctly), and any rank inside a group that would
 * exceed `MAX_NODES_PER_ROW` wraps onto additional rows instead of growing
 * sideways — so the whole diagram grows down, not out. Inter-group edges
 * aren't fed into any group's dagre pass; they're still returned as normal
 * edges and drawn by the canvas using each node's final position, same as
 * any other edge.
 */
const COLLAPSED_GROUP_HEIGHT = GROUP_HEADER_HEIGHT;
const COLLAPSED_GROUP_WIDTH = 280;

export function layoutGraphGrouped(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  groupByNodeId: Map<string, string>,
  groupOrder: string[],
  collapsedKeys: ReadonlySet<string> = new Set(),
): { nodes: DiagramNode[]; groups: GroupBox[] } {
  const nodesByGroup = new Map<string, DiagramNode[]>();
  for (const node of nodes) {
    const key = groupByNodeId.get(node.id) ?? "UNGROUPED";
    if (!nodesByGroup.has(key)) nodesByGroup.set(key, []);
    nodesByGroup.get(key)!.push(node);
  }

  const orderedKeys = [
    ...groupOrder.filter((k) => nodesByGroup.has(k)),
    ...[...nodesByGroup.keys()].filter((k) => !groupOrder.includes(k)),
  ];

  const positioned: DiagramNode[] = [];
  const groups: GroupBox[] = [];
  let cursorY = 0;

  for (const key of orderedKeys) {
    const groupNodes = nodesByGroup.get(key)!;
    const nodeIds = groupNodes.map((n) => n.id);

    if (collapsedKeys.has(key)) {
      for (const node of groupNodes) {
        positioned.push({ ...node, x: GROUP_PADDING, y: cursorY + GROUP_HEADER_HEIGHT });
      }
      groups.push({
        key,
        x: 0,
        y: cursorY,
        width: COLLAPSED_GROUP_WIDTH,
        height: COLLAPSED_GROUP_HEIGHT,
        collapsed: true,
        nodeIds,
      });
      cursorY += COLLAPSED_GROUP_HEIGHT + GROUP_GAP;
      continue;
    }

    const nodeIdSet = new Set(nodeIds);
    const groupEdges = edges.filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to) && e.from !== e.to);

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 72 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const node of groupNodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    for (const edge of groupEdges) g.setEdge(edge.from, edge.to);
    dagre.layout(g);

    const rankBuckets = new Map<number, { id: string; x: number }[]>();
    for (const node of groupNodes) {
      const pos = g.node(node.id) as { x: number; y: number } | undefined;
      const rankY = pos ? Math.round(pos.y) : 0;
      if (!rankBuckets.has(rankY)) rankBuckets.set(rankY, []);
      rankBuckets.get(rankY)!.push({ id: node.id, x: pos?.x ?? 0 });
    }
    const ranks = [...rankBuckets.keys()].sort((a, b) => a - b);

    const finalPos = new Map<string, { x: number; y: number }>();
    let rowCursorY = GROUP_HEADER_HEIGHT + GROUP_PADDING;
    let maxRowWidth = 0;
    for (const rankY of ranks) {
      const rankNodes = rankBuckets.get(rankY)!.sort((a, b) => a.x - b.x);
      for (let i = 0; i < rankNodes.length; i += MAX_NODES_PER_ROW) {
        const chunk = rankNodes.slice(i, i + MAX_NODES_PER_ROW);
        const rowWidth = chunk.length * NODE_WIDTH + (chunk.length - 1) * 40;
        maxRowWidth = Math.max(maxRowWidth, rowWidth);
        chunk.forEach((item, idx) => {
          finalPos.set(item.id, { x: GROUP_PADDING + idx * (NODE_WIDTH + 40), y: rowCursorY });
        });
        rowCursorY += NODE_HEIGHT + ROW_GAP;
      }
    }
    const groupWidth = Math.max(maxRowWidth, 1) + GROUP_PADDING * 2;
    const groupHeight = rowCursorY - ROW_GAP + GROUP_PADDING;

    for (const node of groupNodes) {
      const pos = finalPos.get(node.id) ?? { x: GROUP_PADDING, y: GROUP_HEADER_HEIGHT + GROUP_PADDING };
      positioned.push({ ...node, x: pos.x, y: cursorY + pos.y });
    }

    groups.push({ key, x: 0, y: cursorY, width: groupWidth, height: groupHeight, collapsed: false, nodeIds });
    cursorY += groupHeight + GROUP_GAP;
  }

  return { nodes: positioned, groups };
}
