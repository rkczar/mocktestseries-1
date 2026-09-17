"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type CSSProperties } from "react";
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
import { Search, ZoomIn, ZoomOut, Maximize2, RotateCcw, ChevronsDown, ChevronsUp, AlertTriangle, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Button } from "@/components/ui/button";
import {
  layoutGraph,
  layoutGraphGrouped,
  NODE_WIDTH,
  NODE_HEIGHT,
  type DiagramGraph,
  type DiagramNode,
} from "@/lib/diagram-graph";
import { classifyGroup, DIAGRAM_GROUPS, type DiagramGroupKey } from "@/lib/diagram-groups";
import { resolveDisplayStatus, summaryBucket } from "@/lib/diagram-status";
import { computeIssues } from "@/lib/diagram-issues";
import { runDiagramCheckAction } from "./actions";
import { PageNode, type PageNodeType } from "./page-node";
import { ConnectionEdge, type ConnectionEdgeType } from "./connection-edge";
import { GroupBackground, type GroupBackgroundType } from "./group-background";
import { DetailsDrawer, type DrawerSelection } from "./details-drawer";
import { IssuesPanel } from "./issues-panel";
import { SummaryCards, type CardBucket } from "./summary-cards";
import { MobileTreeView } from "./mobile-tree-view";
import styles from "./graph-view.module.css";

const nodeTypes = { pageNode: PageNode, groupBackground: GroupBackground };
const edgeTypes = { connectionEdge: ConnectionEdge };
const GROUP_ORDER = DIAGRAM_GROUPS.map((g) => g.key);
const MOBILE_BREAKPOINT = 768;
const EMPTY_GROUP_SET: ReadonlySet<DiagramGroupKey> = new Set();

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
const STATUS_FILTERS = ["Live", "Broken", "Disconnected", "No incoming", "Draft"];

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
  if (filter === "Live") return node.status === "CONNECTED" && !node.isolated && !node.noIncoming;
  if (filter === "Broken") return node.status === "BROKEN" || node.status === "ORPHAN" || node.status === "UNAUTHORIZED";
  if (filter === "Disconnected") return node.isolated;
  if (filter === "No incoming") return node.noIncoming;
  if (filter === "Draft") return node.status === "DRAFT";
  return true;
}

function matchesBucketFilter(node: DiagramNode, bucket: CardBucket) {
  if (bucket === "ALL") return true;
  return summaryBucket(resolveDisplayStatus(node).key) === bucket;
}

function useIsNarrowViewport(breakpoint = MOBILE_BREAKPOINT) {
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [breakpoint]);
  return isNarrow;
}

interface GraphViewProps {
  graph: DiagramGraph;
  /** "explorable" shows the full site-map toolbar, grouped containers, summary cards, and issues panel (the main Website Diagram view); "fixed" renders a curated node subset with no filter UI (the flow tabs). */
  variant: "explorable" | "fixed";
  fixedNodeIds?: string[];
  flowErrors?: string[];
  caption?: string;
}

function GraphLegend() {
  return (
    <div className={styles.legend}>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--color-success)" }} aria-hidden /> Live
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--color-info)" }} aria-hidden /> Draft · Coming soon
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--color-error)" }} aria-hidden /> Broken
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--color-warning)" }} aria-hidden /> Disconnected
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--color-muted-foreground)" }} aria-hidden /> Deprecated
      </span>
      <span className={styles.legendDivider} aria-hidden />
      <span className="inline-flex items-center gap-1.5">
        <span className={styles.legendLineSolid} aria-hidden /> Navigation
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={styles.legendLineAdmin} aria-hidden /> Admin → frontend config
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={styles.legendLineBroken} aria-hidden /> Broken connection
      </span>
    </div>
  );
}

function GraphCanvas({ graph, variant, fixedNodeIds, flowErrors, caption }: GraphViewProps) {
  const { zoomIn, zoomOut, fitView, setCenter } = useReactFlow();
  const [search, setSearch] = useState("");
  const [userTypeFilter, setUserTypeFilter] = useState(FILTER_ALL);
  const [statusFilter, setStatusFilter] = useState(FILTER_ALL);
  const [bucketFilter, setBucketFilter] = useState<CardBucket>("ALL");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<DiagramGroupKey>>(new Set());
  const [selection, setSelection] = useState<DrawerSelection | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const pendingFocusRef = useRef<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const isMobile = useIsNarrowViewport();

  const filterOptions = useMemo(() => buildFilterOptions(graph.nodes), [graph.nodes]);
  const pageNameByRoute = useMemo(() => new Map(graph.nodes.map((n) => [n.route, n.pageName])), [graph.nodes]);

  const groupByNodeId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, classifyGroup(n)])), [graph.nodes]);

  const issues = useMemo(() => (variant === "explorable" ? computeIssues(graph) : []), [graph, variant]);
  const issueNodeIds = useMemo(() => new Set(issues.map((i) => i.nodeId)), [issues]);

  const groupStats = useMemo(() => {
    const stats = new Map<
      DiagramGroupKey,
      { live: number; draft: number; broken: number; disconnected: number; deprecated: number; total: number }
    >();
    for (const node of graph.nodes) {
      const key = groupByNodeId.get(node.id) as DiagramGroupKey;
      if (!stats.has(key)) stats.set(key, { live: 0, draft: 0, broken: 0, disconnected: 0, deprecated: 0, total: 0 });
      const bucket = summaryBucket(resolveDisplayStatus(node).key);
      const entry = stats.get(key)!;
      entry.total += 1;
      if (bucket === "LIVE") entry.live += 1;
      else if (bucket === "DRAFT") entry.draft += 1;
      else if (bucket === "BROKEN") entry.broken += 1;
      else if (bucket === "DISCONNECTED") entry.disconnected += 1;
      else if (bucket === "DEPRECATED") entry.deprecated += 1;
    }
    return stats;
  }, [graph.nodes, groupByNodeId]);

  // Any active search/filter auto-expands collapsed groups so a match is never hidden by a manual collapse.
  // Derived, not stored: avoids a setState-in-effect render cascade, and naturally restores the user's manual
  // collapse choices the moment filters are cleared.
  const hasActiveFilter =
    variant === "explorable" && (search.trim() !== "" || userTypeFilter !== FILTER_ALL || statusFilter !== FILTER_ALL || bucketFilter !== "ALL" || issuesOnly);
  const effectiveCollapsedGroups = hasActiveFilter ? EMPTY_GROUP_SET : collapsedGroups;

  const visibleNodeIds = useMemo(() => {
    if (variant === "fixed") return new Set(fixedNodeIds ?? []);
    const q = search.trim().toLowerCase();
    return new Set(
      graph.nodes
        .filter(
          (n) =>
            (!q || n.pageName.toLowerCase().includes(q) || n.route.toLowerCase().includes(q)) &&
            matchesUserTypeOrModule(n, userTypeFilter) &&
            matchesStatusFilter(n, statusFilter) &&
            matchesBucketFilter(n, bucketFilter) &&
            (!issuesOnly || issueNodeIds.has(n.id))
        )
        .map((n) => n.id)
    );
  }, [graph.nodes, variant, fixedNodeIds, search, userTypeFilter, statusFilter, bucketFilter, issuesOnly, issueNodeIds]);

  const { nodes: layoutedNodes, groups: groupBoxes } = useMemo(() => {
    const visible = graph.nodes.filter((n) => visibleNodeIds.has(n.id));
    const visibleEdges = graph.edges.filter((e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to));
    if (variant === "explorable") {
      return layoutGraphGrouped(visible, visibleEdges, groupByNodeId, GROUP_ORDER, effectiveCollapsedGroups);
    }
    return { nodes: layoutGraph(visible, visibleEdges, "TB"), groups: [] };
  }, [graph.nodes, graph.edges, visibleNodeIds, variant, groupByNodeId, effectiveCollapsedGroups]);

  // Members of a collapsed group are still positioned (at their group's header) but not rendered.
  const renderedNodes = useMemo(() => {
    if (variant !== "explorable") return layoutedNodes;
    return layoutedNodes.filter((n) => !effectiveCollapsedGroups.has(groupByNodeId.get(n.id) as DiagramGroupKey));
  }, [layoutedNodes, variant, effectiveCollapsedGroups, groupByNodeId]);
  const renderedNodeIds = useMemo(() => new Set(renderedNodes.map((n) => n.id)), [renderedNodes]);

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
      renderedNodes.map((node) => ({
        id: node.id,
        type: "pageNode",
        position: { x: node.x, y: node.y },
        zIndex: 1,
        data: { node, dimmed: neighborIds ? !neighborIds.has(node.id) : false },
      })),
    [renderedNodes, neighborIds]
  );

  const toggleGroup = (key: DiagramGroupKey) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const groupRfNodes: GroupBackgroundType[] = useMemo(
    () =>
      groupBoxes.map((box) => {
        const meta = DIAGRAM_GROUPS.find((g) => g.key === box.key);
        const stats = groupStats.get(box.key as DiagramGroupKey) ?? { live: 0, draft: 0, broken: 0, disconnected: 0, deprecated: 0, total: 0 };
        return {
          id: `group:${box.key}`,
          type: "groupBackground",
          position: { x: box.x, y: box.y },
          style: { width: box.width, height: box.height },
          draggable: false,
          selectable: false,
          zIndex: 0,
          data: {
            label: meta?.label ?? box.key,
            groupKey: box.key as DiagramGroupKey,
            collapsed: box.collapsed,
            counts: stats,
            onToggle: toggleGroup,
          },
        };
      }),
    [groupBoxes, groupStats]
  );

  const rfEdges: ConnectionEdgeType[] = useMemo(
    () =>
      graph.edges
        .filter((e) => renderedNodeIds.has(e.from) && renderedNodeIds.has(e.to))
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
    [graph.edges, renderedNodeIds, neighborIds]
  );

  const combinedNodes = variant === "explorable" ? [...groupRfNodes, ...rfNodes] : rfNodes;

  const onNodeClick: NodeMouseHandler = (_event, node) => {
    if (node.type !== "pageNode") return;
    setSelection({ kind: "node", node: (node as PageNodeType).data.node });
  };

  const onEdgeClick: EdgeMouseHandler<ConnectionEdgeType> = (_event, edge) => {
    const full = graph.edges.find((e) => e.id === edge.id);
    if (full) setSelection({ kind: "edge", edge: full });
  };

  const resetView = () => {
    setSearch("");
    setUserTypeFilter(FILTER_ALL);
    setStatusFilter(FILTER_ALL);
    setBucketFilter("ALL");
    setIssuesOnly(false);
    setSelection(null);
    requestAnimationFrame(() => fitView({ padding: 0.2 }));
  };

  const expandAll = () => {
    setCollapsedGroups(new Set());
    requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 }));
  };

  const collapseAllGroups = () => {
    setCollapsedGroups(new Set(GROUP_ORDER.filter((k) => (groupStats.get(k)?.total ?? 0) > 0)));
    requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 }));
  };

  const refreshLiveMap = () => {
    startTransition(async () => {
      await runDiagramCheckAction();
    });
  };

  // Focusing an issue expands its group if needed, selects the node, and re-centers on it once its final position is known.
  const focusNode = (nodeId: string) => {
    const group = groupByNodeId.get(nodeId);
    if (group && collapsedGroups.has(group)) {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        next.delete(group);
        return next;
      });
    }
    const full = graph.nodes.find((n) => n.id === nodeId);
    if (full) setSelection({ kind: "node", node: full });
    pendingFocusRef.current = nodeId;
    setFocusTick((t) => t + 1);
  };

  useEffect(() => {
    const nodeId = pendingFocusRef.current;
    if (!nodeId) return;
    const node = layoutedNodes.find((n) => n.id === nodeId);
    if (!node) return;
    setCenter(node.x + NODE_WIDTH / 2, node.y + NODE_HEIGHT / 2, { zoom: 1, duration: 400 });
    pendingFocusRef.current = null;
  }, [focusTick, layoutedNodes, setCenter]);

  const mobileGroupedNodes = useMemo(() => {
    const map = new Map<DiagramGroupKey, DiagramNode[]>();
    for (const node of graph.nodes) {
      if (!visibleNodeIds.has(node.id)) continue;
      const key = groupByNodeId.get(node.id) as DiagramGroupKey;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(node);
    }
    return map;
  }, [graph.nodes, visibleNodeIds, groupByNodeId]);

  const visibleBrokenEdges = graph.brokenEdges.filter((e) => renderedNodeIds.has(e.from) && renderedNodeIds.has(e.to));

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

      {variant === "explorable" ? <SummaryCards nodes={graph.nodes} active={bucketFilter} onSelect={setBucketFilter} /> : null}

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
            {!isMobile ? (
              <>
                <Button type="button" variant="outline" size="sm" onClick={expandAll}>
                  <ChevronsDown className="h-3.5 w-3.5" aria-hidden /> Expand All
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={collapseAllGroups}>
                  <ChevronsUp className="h-3.5 w-3.5" aria-hidden /> Collapse Groups
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-active={issuesOnly || undefined}
              className={styles.toggleButton}
              onClick={() => setIssuesOnly((v) => !v)}
            >
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Show Issues Only
            </Button>
            <Button type="button" variant="primary" size="sm" disabled={isPending} onClick={refreshLiveMap}>
              <RefreshCw className={isPending ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} aria-hidden />
              {isPending ? "Refreshing…" : "Refresh Live Map"}
            </Button>
          </>
        ) : (
          <p className="text-xs text-[var(--color-muted-foreground)]">{caption}</p>
        )}
        <div className={styles.toolbarSpacer} />
        {!isMobile ? (
          <>
            <Button type="button" variant="outline" size="icon" onClick={() => zoomOut()} aria-label="Zoom out">
              <ZoomOut className="h-4 w-4" aria-hidden />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => zoomIn()} aria-label="Zoom in">
              <ZoomIn className="h-4 w-4" aria-hidden />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => fitView({ padding: 0.2 })} aria-label="Fit to screen">
              <Maximize2 className="h-4 w-4" aria-hidden />
            </Button>
          </>
        ) : null}
        <Button type="button" variant="outline" size="icon" onClick={resetView} aria-label="Reset view">
          <RotateCcw className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {isMobile && variant === "explorable" ? (
        <div className={styles.mobileWrapper}>
          <MobileTreeView groupedNodes={mobileGroupedNodes} onSelect={(node) => setSelection({ kind: "node", node })} />
          {selection ? <DetailsDrawer selection={selection} pageNameByRoute={pageNameByRoute} onClose={() => setSelection(null)} /> : null}
        </div>
      ) : (
        <div className={styles.canvasWrapper} style={XY_THEME_VARS}>
          <div className={styles.canvas}>
            <ReactFlow
              nodes={combinedNodes}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={() => setSelection(null)}
              fitView
              proOptions={{ hideAttribution: true }}
              minZoom={0.1}
              nodesDraggable={false}
            >
              <Background gap={20} />
              <MiniMap pannable zoomable className="hidden sm:block" />
            </ReactFlow>
          </div>
          {selection ? <DetailsDrawer selection={selection} pageNameByRoute={pageNameByRoute} onClose={() => setSelection(null)} /> : null}
        </div>
      )}

      {variant === "explorable" ? (
        <div className={styles.issuesPanelCard}>
          <div className={styles.issuesPanelHeader}>
            <h3 className={styles.issuesPanelTitle}>Issues &amp; Disconnections</h3>
            <span className={styles.issuesPanelCount}>{issues.length}</span>
          </div>
          <IssuesPanel issues={issues} onFocus={focusNode} />
        </div>
      ) : null}
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
