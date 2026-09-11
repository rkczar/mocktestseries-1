"use client";

import { RefreshCcw } from "lucide-react";
import { useMemo, useState } from "react";

import { refreshDiagramAction } from "@/app/admin/(dashboard)/diagram/actions";
import type { DiagramGraph } from "@/lib/diagram/types";

import { AddPlannedPageForm } from "./AddPlannedPageForm";
import { ConnectionsTable } from "./ConnectionsTable";
import { DiagramCanvas } from "./DiagramCanvas";
import { DiagramToolbar } from "./DiagramToolbar";
import { DEFAULT_FILTERS, nodeMatchesFilters } from "./filters";
import { Legend } from "./Legend";
import { computeLayout, type DiagramView } from "./layout";
import { NodeDetailsPanel } from "./NodeDetailsPanel";
import { SummaryCards } from "./SummaryCards";
import { useDiagramAction } from "./useDiagramAction";

export function DiagramDashboard({ initialGraph }: { initialGraph: DiagramGraph }) {
  const [graph, setGraph] = useState(initialGraph);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [view, setView] = useState<DiagramView | "connections">("sitemap");
  const [showGlobalNav, setShowGlobalNav] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useDiagramAction(() => refreshDiagramAction());

  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const dimmedIds = useMemo(
    () => new Set(graph.nodes.filter((n) => !nodeMatchesFilters(n, filters)).map((n) => n.id)),
    [graph.nodes, filters],
  );
  const visibleIds = useMemo(() => new Set(graph.nodes.filter((n) => nodeMatchesFilters(n, filters)).map((n) => n.id)), [
    graph.nodes,
    filters,
  ]);

  const { positioned, lanes } = useMemo(
    () => computeLayout(graph.nodes, view === "connections" ? "sitemap" : view),
    [graph.nodes, view],
  );

  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null;

  async function handleRefresh() {
    const data = await refresh.execute();
    if (data) setGraph(data);
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] font-bold text-text-heading">Website Diagram</h1>
          <p className="mt-1.5 max-w-xl text-sm text-text-muted">
            A live map of every page, route, and connection this application actually has — generated
            from the real app structure, not a hand-maintained list.
          </p>
          <p className="mt-2 text-[12.5px] text-text-faint">
            Last Updated: {new Date(graph.generatedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refresh.isLoading}
          className="flex flex-none items-center gap-2 rounded-[9px] bg-primary px-4 py-2.5 text-[13.5px] font-bold text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
        >
          <RefreshCcw className={`size-4 ${refresh.isLoading ? "animate-spin" : ""}`} strokeWidth={2} />
          {refresh.isLoading ? "Refreshing…" : "Refresh Diagram"}
        </button>
      </div>
      {refresh.message ? <p className="mt-3 text-[13px] text-error">{refresh.message}</p> : null}

      <div className="mt-6">
        <SummaryCards summary={graph.summary} />
      </div>

      <div className="mt-6">
        <DiagramToolbar
          filters={filters}
          onFiltersChange={setFilters}
          view={view}
          onViewChange={setView}
          showGlobalNav={showGlobalNav}
          onShowGlobalNavChange={setShowGlobalNav}
        />
      </div>

      <div className="mt-4">
        <AddPlannedPageForm onGraphUpdate={setGraph} />
      </div>

      <div className="mt-4">
        {view === "connections" ? (
          <ConnectionsTable edges={graph.edges} nodeById={nodeById} visibleIds={visibleIds} onJump={setSelectedId} />
        ) : (
          <DiagramCanvas
            nodes={positioned}
            lanes={lanes}
            edges={graph.edges}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            dimmedIds={dimmedIds}
            showGlobalNav={showGlobalNav}
          />
        )}
      </div>

      <div className="mt-4">
        <Legend />
      </div>

      {selectedNode ? (
        <NodeDetailsPanel
          key={selectedNode.id}
          node={selectedNode}
          graph={graph}
          onClose={() => setSelectedId(null)}
          onJump={setSelectedId}
          onGraphUpdate={setGraph}
        />
      ) : null}
    </div>
  );
}
