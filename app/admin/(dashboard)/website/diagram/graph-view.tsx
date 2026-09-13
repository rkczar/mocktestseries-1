"use client";

import { useMemo, useState, type CSSProperties } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  MarkerType,
  useReactFlow,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Search, ZoomIn, ZoomOut, Maximize2, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Button } from "@/components/ui/button";
import { layoutGraph, type DiagramGraph, type DiagramNode } from "@/lib/diagram-graph";
import { PageNode, type PageNodeType } from "./page-node";
import { ConnectionEdge, type ConnectionEdgeType } from "./connection-edge";
import { DetailsDrawer, type DrawerSelection } from "./details-drawer";
import styles from "./graph-view.module.css";

const nodeTypes = { pageNode: PageNode };
const edgeTypes = { connectionEdge: ConnectionEdge };

// Maps React Flow's own theme variables onto this app's existing design
// tokens, so the canvas re-themes automatically across dark/light/eyesaver
// without any JS branching.
const XY_THEME_VARS: CSSProperties = {
  ["--xy-background-color" as string]: "var(--color-background)",
  ["--xy-background-pattern-color" as string]: "var(--color-border)",
  ["--xy-minimap-mask-background-color" as string]: "color-mix(in srgb, var(--color-background) 70%, transparent)",
  ["--xy-attribution-background-color" as string]: "transparent",
};

const FILTER_ALL = "All";
const USER_TYPE_FILTERS = ["Public", "Student", "Admin"];
const STATUS_FILTERS = ["Working", "Broken", "Orphan", "No incoming", "Draft"];

function buildFilterOptions(nodes: DiagramNode[]) {
  const modules = Array.from(new Set(nodes.map((n) => n.module))).sort();
  return [FILTER_ALL, ...USER_TYPE_FILTERS, ...modules.filter((m) => !USER_TYPE_FILTERS.includes(m))];
}

function matchesUserTypeOrModule(node: DiagramNode, filter: string) {
  if (filter === FILTER_ALL) return true;
  if (filter === "Public") return node.userType === "PUBLIC";
  if (filter === "Student") return node.userType === "STUDENT";
  if (filter === "Admin") return node.userType === "ADMIN";
  return node.module === filter;
}

function matchesStatusFilter(node: DiagramNode, filter: string) {
  if (filter === FILTER_ALL) return true;
  if (filter === "Working") return node.status === "CONNECTED" && !node.isolated && !node.noIncoming;
  if (filter === "Broken") return node.status === "BROKEN" || node.status === "ORPHAN" || node.status === "UNAUTHORIZED";
  if (filter === "Orphan") return node.isolated;
  if (filter === "No incoming") return node.noIncoming;
  if (filter === "Draft") return node.status === "DRAFT";
  return true;
}

interface GraphViewProps {
  graph: DiagramGraph;
  /** "explorable" shows the search/filter toolbar (Site Map); "fixed" renders a curated node subset with no filter UI (the flow tabs). */
  variant: "explorable" | "fixed";
  fixedNodeIds?: string[];
  flowErrors?: string[];
  caption?: string;
}

const LEGEND_ITEMS = [
  { color: "var(--color-success)", label: "Live · working" },
  { color: "var(--color-error)", label: "Error · disabled/missing" },
  { color: "var(--color-warning)", label: "Warning · retry path" },
  { color: "var(--color-muted-foreground)", label: "Neutral / unreached" },
];

function GraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pb-2 text-xs text-[var(--color-muted-foreground)]">
      {LEGEND_ITEMS.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: item.color }} aria-hidden />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function GraphCanvas({ graph, variant, fixedNodeIds, flowErrors, caption }: GraphViewProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const [search, setSearch] = useState("");
  const [userTypeFilter, setUserTypeFilter] = useState(FILTER_ALL);
  const [statusFilter, setStatusFilter] = useState(FILTER_ALL);
  const [selection, setSelection] = useState<DrawerSelection | null>(null);

  const filterOptions = useMemo(() => buildFilterOptions(graph.nodes), [graph.nodes]);
  const pageNameByRoute = useMemo(() => new Map(graph.nodes.map((n) => [n.route, n.pageName])), [graph.nodes]);

  const visibleNodeIds = useMemo(() => {
    if (variant === "fixed") return new Set(fixedNodeIds ?? []);
    const q = search.trim().toLowerCase();
    return new Set(
      graph.nodes
        .filter(
          (n) =>
            (!q || n.pageName.toLowerCase().includes(q) || n.route.toLowerCase().includes(q)) &&
            matchesUserTypeOrModule(n, userTypeFilter) &&
            matchesStatusFilter(n, statusFilter)
        )
        .map((n) => n.id)
    );
  }, [graph.nodes, variant, fixedNodeIds, search, userTypeFilter, statusFilter]);

  const layoutedNodes = useMemo(() => {
    const visible = graph.nodes.filter((n) => visibleNodeIds.has(n.id));
    const visibleEdges = graph.edges.filter((e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to));
    return layoutGraph(visible, visibleEdges, "TB");
  }, [graph.nodes, graph.edges, visibleNodeIds]);

  const layoutedNodeIds = useMemo(() => new Set(layoutedNodes.map((n) => n.id)), [layoutedNodes]);

  // When a node is selected, everything not directly connected to it dims out.
  const neighborIds = useMemo(() => {
    if (!selection || selection.kind !== "node") return null;
    const ids = new Set<string>([selection.node.id]);
    for (const c of selection.node.incoming) ids.add(c.nodeId);
    for (const c of selection.node.outgoing) ids.add(c.nodeId);
    return ids;
  }, [selection]);

  const rfNodes: PageNodeType[] = useMemo(
    () =>
      layoutedNodes.map((node) => ({
        id: node.id,
        type: "pageNode",
        position: { x: node.x, y: node.y },
        data: { node, dimmed: neighborIds ? !neighborIds.has(node.id) : false },
      })),
    [layoutedNodes, neighborIds]
  );

  const rfEdges: ConnectionEdgeType[] = useMemo(
    () =>
      graph.edges
        .filter((e) => layoutedNodeIds.has(e.from) && layoutedNodeIds.has(e.to))
        .map((edge) => ({
          id: edge.id,
          source: edge.from,
          target: edge.to,
          type: "connectionEdge",
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            source: edge.source,
            label: edge.label,
            broken: edge.broken,
            dimmed: neighborIds ? !(neighborIds.has(edge.from) && neighborIds.has(edge.to)) : false,
          },
        })),
    [graph.edges, layoutedNodeIds, neighborIds]
  );

  const onNodeClick: NodeMouseHandler<PageNodeType> = (_event, node) => {
    setSelection({ kind: "node", node: node.data.node });
  };

  const onEdgeClick: EdgeMouseHandler<ConnectionEdgeType> = (_event, edge) => {
    const full = graph.edges.find((e) => e.id === edge.id);
    if (full) setSelection({ kind: "edge", edge: full });
  };

  const resetView = () => {
    setSearch("");
    setUserTypeFilter(FILTER_ALL);
    setStatusFilter(FILTER_ALL);
    setSelection(null);
    requestAnimationFrame(() => fitView({ padding: 0.2 }));
  };

  const visibleBrokenEdges = graph.brokenEdges.filter((e) => layoutedNodeIds.has(e.from) && layoutedNodeIds.has(e.to));

  return (
    <div className="flex flex-col gap-0">
      <GraphLegend />

      {flowErrors && flowErrors.length > 0 ? (
        <div className={styles.brokenStrip}>
          {flowErrors.map((message) => (
            <p key={message} className={styles.brokenStripTitle}>
              {message}
            </p>
          ))}
        </div>
      ) : null}

      {variant === "explorable" && visibleBrokenEdges.length > 0 ? (
        <div className={styles.brokenStrip}>
          <p className={styles.brokenStripTitle}>
            ⚠ {visibleBrokenEdges.length} broken connection{visibleBrokenEdges.length === 1 ? "" : "s"} detected
          </p>
          {visibleBrokenEdges.slice(0, 5).map((edge) => (
            <p key={edge.id} className={styles.brokenStripItem}>
              {pageNameByRoute.get(edge.from) ?? edge.from} → {pageNameByRoute.get(edge.to) ?? edge.to} ({edge.label ?? edge.source})
            </p>
          ))}
        </div>
      ) : null}

      <div className={styles.toolbar}>
        {variant === "explorable" ? (
          <>
            <div className={styles.toolbarSearch}>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted-foreground)]" aria-hidden />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search pages or routes…"
                  className="pl-8"
                  aria-label="Search pages"
                />
              </div>
            </div>
            <div className={styles.toolbarFilter}>
              <SelectNative value={userTypeFilter} onChange={(e) => setUserTypeFilter(e.target.value)} aria-label="Filter by module or user type">
                {filterOptions.map((option) => (
                  <option key={option} value={option}>
                    {option === FILTER_ALL ? "All pages" : option}
                  </option>
                ))}
              </SelectNative>
            </div>
            <div className={styles.toolbarFilter}>
              <SelectNative value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
                <option value={FILTER_ALL}>All statuses</option>
                {STATUS_FILTERS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </SelectNative>
            </div>
          </>
        ) : (
          <p className="text-xs text-[var(--color-muted-foreground)]">{caption}</p>
        )}
        <div className={styles.toolbarSpacer} />
        <Button type="button" variant="outline" size="icon" onClick={() => zoomOut()} aria-label="Zoom out">
          <ZoomOut className="h-4 w-4" aria-hidden />
        </Button>
        <Button type="button" variant="outline" size="icon" onClick={() => zoomIn()} aria-label="Zoom in">
          <ZoomIn className="h-4 w-4" aria-hidden />
        </Button>
        <Button type="button" variant="outline" size="icon" onClick={() => fitView({ padding: 0.2 })} aria-label="Fit to screen">
          <Maximize2 className="h-4 w-4" aria-hidden />
        </Button>
        <Button type="button" variant="outline" size="icon" onClick={resetView} aria-label="Reset view">
          <RotateCcw className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className={styles.canvasWrapper} style={XY_THEME_VARS}>
        <div className={styles.canvas}>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={() => setSelection(null)}
            fitView
            proOptions={{ hideAttribution: true }}
            minZoom={0.1}
          >
            <Background gap={20} />
            <MiniMap pannable zoomable className="hidden sm:block" />
          </ReactFlow>
        </div>
        {selection ? <DetailsDrawer selection={selection} pageNameByRoute={pageNameByRoute} onClose={() => setSelection(null)} /> : null}
      </div>
    </div>
  );
}

export function GraphView(props: GraphViewProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
