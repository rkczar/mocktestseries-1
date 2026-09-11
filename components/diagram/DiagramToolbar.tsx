"use client";

import { Search } from "lucide-react";

import type { DiagramContentArea, DiagramNodeStatus, DiagramSection } from "@/lib/diagram/types";

import { type DiagramFilterState, toggleInSet } from "./filters";
import type { DiagramView } from "./layout";
import { STATUS_META } from "./statusMeta";

const SECTIONS: DiagramSection[] = [
  "Public Website",
  "Student Area",
  "Test Player",
  "Admin Area",
  "Authentication",
  "AI",
  "API / Backend",
];
const CONTENT_AREAS: DiagramContentArea[] = ["Exams", "Tests", "AI", "General"];
const STATUSES: DiagramNodeStatus[] = ["ACTIVE", "COMING_SOON", "DRAFT", "IN_DEVELOPMENT", "BROKEN", "DISCONNECTED", "NEEDS_REVIEW"];

function ChipGroup<T extends string>({
  label,
  values,
  selected,
  onToggle,
  onAll,
  render,
}: {
  label: string;
  values: T[];
  selected: Set<T> | "ALL";
  onToggle: (v: T) => void;
  onAll: () => void;
  render?: (v: T) => React.ReactNode;
}) {
  const isAllActive = selected === "ALL";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11.5px] font-bold uppercase tracking-wide text-text-faint">{label}</span>
      <button
        type="button"
        onClick={onAll}
        className={`rounded-full border px-2.5 py-1 text-[12px] font-bold ${
          isAllActive ? "border-primary bg-primary-tint text-primary" : "border-border-strong text-text-muted hover:bg-accent"
        }`}
      >
        All
      </button>
      {values.map((v) => {
        const active = selected !== "ALL" && selected.has(v);
        return (
          <button
            key={v}
            type="button"
            onClick={() => onToggle(v)}
            className={`rounded-full border px-2.5 py-1 text-[12px] font-bold ${
              active ? "border-primary bg-primary-tint text-primary" : "border-border-strong text-text-muted hover:bg-accent"
            }`}
          >
            {render ? render(v) : v}
          </button>
        );
      })}
    </div>
  );
}

export function DiagramToolbar({
  filters,
  onFiltersChange,
  view,
  onViewChange,
  showGlobalNav,
  onShowGlobalNavChange,
}: {
  filters: DiagramFilterState;
  onFiltersChange: (f: DiagramFilterState) => void;
  view: DiagramView | "connections";
  onViewChange: (v: DiagramView | "connections") => void;
  showGlobalNav: boolean;
  onShowGlobalNavChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-[320px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-faint" strokeWidth={2} />
          <input
            value={filters.search}
            onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
            placeholder="Search by name, route, section, status…"
            className="w-full rounded-[9px] border border-border-strong bg-background py-2 pl-9 pr-3 text-[13.5px]"
            aria-label="Search the diagram"
          />
        </div>

        <div className="flex items-center gap-1 rounded-[9px] border border-border-strong bg-background p-1">
          {(["sitemap", "flow", "connections"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onViewChange(v)}
              className={`rounded-[7px] px-3 py-1.5 text-[13px] font-bold ${
                view === v ? "bg-primary text-primary-foreground" : "text-text-muted hover:bg-accent"
              }`}
            >
              {v === "sitemap" ? "Sitemap" : v === "flow" ? "User Flow" : "Connections"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2.5 border-t border-border-subtle pt-3">
        <ChipGroup
          label="Section"
          values={SECTIONS}
          selected={filters.sections}
          onAll={() => onFiltersChange({ ...filters, sections: "ALL" })}
          onToggle={(v) => onFiltersChange({ ...filters, sections: toggleInSet(filters.sections, v, SECTIONS) })}
        />
        <ChipGroup
          label="Content"
          values={CONTENT_AREAS}
          selected={filters.contentAreas}
          onAll={() => onFiltersChange({ ...filters, contentAreas: "ALL" })}
          onToggle={(v) => onFiltersChange({ ...filters, contentAreas: toggleInSet(filters.contentAreas, v, CONTENT_AREAS) })}
        />
        <ChipGroup
          label="Status"
          values={STATUSES}
          selected={filters.statuses}
          onAll={() => onFiltersChange({ ...filters, statuses: "ALL" })}
          onToggle={(v) => onFiltersChange({ ...filters, statuses: toggleInSet(filters.statuses, v, STATUSES) })}
          render={(v) => STATUS_META[v].label}
        />
      </div>

      {view !== "connections" ? (
        <label className="flex w-fit items-center gap-2 border-t border-border-subtle pt-3 text-[12.5px] font-semibold text-text-muted">
          <input
            type="checkbox"
            checked={showGlobalNav}
            onChange={(e) => onShowGlobalNavChange(e.target.checked)}
            className="size-3.5 accent-primary"
          />
          Show shared navigation links (header / footer / sidebar)
        </label>
      ) : null}
    </div>
  );
}
