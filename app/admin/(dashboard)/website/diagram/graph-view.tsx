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
import { Search, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
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

function buildFilterOptions(nodes: DiagramNode[]) {
  const modules = Array.from(new Set(nodes.map((n) => n.module))).sort();
  return [FILTER_ALL, ...USER_TYPE_FILTERS, ...modules.filter((m) => !USER_TYPE_FILTERS.includes(m))];
}

function matchesFilter(node: DiagramNode, filter: string) {
  if (filter === FILTER_ALL) return true;
  if (filter === "Public") return node.userType === "PUBLIC";
  if (filter === "Student") return node.userType === "STUDENT";
  if (filter === "Admin") return node.userType === "ADMIN";
  return node.module === filter;
}

interface GraphViewProps {
  graph: DiagramGraph;
  mode: "wiring" | "flow";
  journeyOrder?: string[];
}

function GraphCanvas({ graph, mode, journeyOrder }: GraphViewProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState(FILTER_ALL);
  const [selection, setSelection] = useState<DrawerSelection | null>(null);

  const filterOptions = useMemo(() => buildFilterOptions(graph.nodes), [graph.nodes]);

  const visibleNodeIds = useMemo(() => {
    if (mode === "flow") {
      return new Set(journeyOrder ?? []);
    }
    const q = search.trim().toLowerCase();
    return new Set(
      graph.nodes
        .filter((n) => (!q || n.pageName.toLowerCase().includes(q) || n.route.toLowerCase().includes(q)) && matchesFilter(n, filter))
        .map((n) => n.id)
    );
  }, [graph.nodes, mode, journeyOrder, search, filter]);

  const layoutedNodes = useMemo(() => {
    if (mode === "flow" && journeyOrder) {
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      return journeyOrder.filter((route) => byId.has(route)).map((route, index) => ({ ...byId.get(route)!, x: 0, y: index * 150 }));
    }
    const visible = graph.nodes.filter((n) => visibleNodeIds.has(n.id));
    const visibleEdges = graph.edges.filter((e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to));
    return layoutGraph(visible, visibleEdges, "TB");
  }, [graph.nodes, graph.edges, visibleNodeIds, mode, journeyOrder]);

  const layoutedNodeIds = useMemo(() => new Set(layoutedNodes.map((n) => n.id)), [layoutedNodes]);

  const rfNodes: PageNodeType[] = useMemo(
    () =>
      layoutedNodes.map((node) => ({
        id: node.id,
        type: "pageNode",
        position: { x: node.x, y: node.y },
        data: { node },
      })),
    [layoutedNodes]
  );

  const rfEdges: ConnectionEdgeType[] = useMemo(() => {
    if (mode === "flow" && journeyOrder) {
      const pairs: ConnectionEdgeType[] = [];
      for (let i = 0; i < journeyOrder.length - 1; i++) {
        const from = journeyOrder[i];
        const to = journeyOrder[i + 1];
        if (!layoutedNodeIds.has(from) || !layoutedNodeIds.has(to)) continue;
        pairs.push({
          id: `flow:${from}->${to}`,
          source: from,
          target: to,
          type: "connectionEdge",
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { source: "internal", broken: false, showLabel: false },
        });
      }
      return pairs;
    }
    return graph.edges
      .filter((e) => layoutedNodeIds.has(e.from) && layoutedNodeIds.has(e.to))
      .map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: "connectionEdge",
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { source: edge.source, label: edge.label, broken: edge.broken },
      }));
  }, [graph.edges, layoutedNodeIds, mode, journeyOrder]);

  const onNodeClick: NodeMouseHandler<PageNodeType> = (_event, node) => {
    setSelection({ kind: "node", node: node.data.node });
  };

  const onEdgeClick: EdgeMouseHandler<ConnectionEdgeType> = (_event, edge) => {
    const full = graph.edges.find((e) => e.id === edge.id);
    if (full) setSelection({ kind: "edge", edge: full });
  };

  return (
    <div className="flex flex-col gap-0">
      {mode === "wiring" && graph.brokenEdges.length > 0 ? (
        <div className={styles.brokenStrip}>
          <p className={styles.brokenStripTitle}>
            ⚠ {graph.brokenEdges.length} broken connection{graph.brokenEdges.length === 1 ? "" : "s"} detected
          </p>
          {graph.brokenEdges.slice(0, 5).map((edge) => (
            <p key={edge.id} className={styles.brokenStripItem}>
              {edge.from} → {edge.to} ({edge.label ?? edge.source})
            </p>
          ))}
        </div>
      ) : null}

      {mode === "wiring" ? (
        <div className={styles.toolbar}>
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
            <SelectNative value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by module or user type">
              {filterOptions.map((option) => (
                <option key={option} value={option}>
                  {option === FILTER_ALL ? "All pages" : option}
                </option>
              ))}
            </SelectNative>
          </div>
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
        </div>
      ) : (
        <div className={styles.toolbar}>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            The canonical student journey — every step is a real, currently-connected page.
          </p>
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
        </div>
      )}

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
        {selection ? <DetailsDrawer selection={selection} onClose={() => setSelection(null)} /> : null}
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
