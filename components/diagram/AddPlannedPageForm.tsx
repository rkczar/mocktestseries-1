"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { addPlannedPageAction } from "@/app/admin/(dashboard)/diagram/actions";
import type { DiagramGraph } from "@/lib/diagram/types";

import { useDiagramAction } from "./useDiagramAction";

export function AddPlannedPageForm({ onGraphUpdate }: { onGraphUpdate: (graph: DiagramGraph) => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [section, setSection] = useState("Public Website");
  const [plannedRoute, setPlannedRoute] = useState("");
  const [notes, setNotes] = useState("");

  const add = useDiagramAction(() =>
    addPlannedPageAction({ label, section, plannedRoute: plannedRoute || undefined, notes: notes || undefined }),
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const graph = await add.execute();
    if (graph) {
      onGraphUpdate(graph);
      setLabel("");
      setPlannedRoute("");
      setNotes("");
      setOpen(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 self-start text-[13px] font-bold text-primary hover:underline"
      >
        <Plus className="size-3.5" strokeWidth={2.2} />
        Add a planned / future page
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2.5 rounded-[12px] border border-dashed border-border-strong bg-surface p-4">
      <p className="text-[13px] font-bold text-text-heading">Add a planned page</p>
      <p className="text-[12.5px] text-text-faint">
        For a page that doesn&apos;t exist in the codebase yet. It appears as &quot;Coming Soon&quot; in the diagram,
        clearly separate from detected pages.
      </p>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <input
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Page name (e.g. Leaderboard)"
          className="rounded-[9px] border border-border-strong bg-background px-3 py-2 text-[13.5px]"
        />
        <select
          value={section}
          onChange={(e) => setSection(e.target.value)}
          className="rounded-[9px] border border-border-strong bg-background px-3 py-2 text-[13.5px]"
        >
          {["Public Website", "Student Area", "Test Player", "Admin Area", "Authentication", "AI"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          value={plannedRoute}
          onChange={(e) => setPlannedRoute(e.target.value)}
          placeholder="Intended route (optional, e.g. /leaderboard)"
          className="rounded-[9px] border border-border-strong bg-background px-3 py-2 text-[13.5px] sm:col-span-2"
        />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          rows={2}
          className="rounded-[9px] border border-border-strong bg-background px-3 py-2 text-[13.5px] sm:col-span-2"
        />
      </div>
      {add.message ? <p className="text-[12.5px] text-error">{add.message}</p> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={add.isLoading}
          className="rounded-[9px] bg-primary px-3.5 py-2 text-[13px] font-bold text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
        >
          {add.isLoading ? "Adding…" : "Add planned page"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-[9px] border border-border-strong px-3.5 py-2 text-[13px] font-bold text-text-muted hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
