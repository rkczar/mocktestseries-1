"use client";

import { AlertTriangle } from "lucide-react";

import type { DiagramEdge, DiagramNode } from "@/lib/diagram/types";

const KIND_LABEL: Record<DiagramEdge["kind"], string> = {
  link: "Link",
  action: "Redirect / Action",
  fetch: "API Call",
  "global-nav": "Shared Navigation",
  broken: "Broken",
};

export function ConnectionsTable({
  edges,
  nodeById,
  visibleIds,
  onJump,
}: {
  edges: DiagramEdge[];
  nodeById: Map<string, DiagramNode>;
  visibleIds: Set<string>;
  onJump: (id: string) => void;
}) {
  const rows = edges.filter((e) => visibleIds.has(e.source) || visibleIds.has(e.target));

  if (rows.length === 0) {
    return (
      <div className="rounded-[12px] border border-dashed border-border-strong bg-surface p-8 text-center text-[13.5px] text-text-faint">
        No connections match the current search/filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-[12px] border border-border bg-surface">
      <table className="w-full min-w-[560px] text-left text-[13.5px]">
        <thead>
          <tr className="border-b border-border text-[11.5px] font-bold uppercase tracking-wide text-text-faint">
            <th className="px-4 py-3">From</th>
            <th className="px-4 py-3">To</th>
            <th className="px-4 py-3">Type</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((edge) => {
            const source = nodeById.get(edge.source);
            const target = nodeById.get(edge.target);
            const broken = edge.kind === "broken";
            return (
              <tr key={edge.id} className="border-b border-border-subtle last:border-0 hover:bg-accent/60">
                <td className="px-4 py-2.5">
                  <button type="button" onClick={() => onJump(edge.source)} className="font-semibold text-primary hover:underline">
                    {source?.label ?? edge.source}
                  </button>
                </td>
                <td className="px-4 py-2.5">
                  <button type="button" onClick={() => onJump(edge.target)} className="font-semibold text-primary hover:underline">
                    {target?.label ?? edge.target}
                  </button>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center gap-1.5 font-semibold ${broken ? "text-error" : "text-text-muted"}`}>
                    {broken ? <AlertTriangle className="size-3.5" strokeWidth={2.2} /> : null}
                    {KIND_LABEL[edge.kind]}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
