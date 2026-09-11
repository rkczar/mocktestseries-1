"use client";

import { PencilLine, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { deletePlannedPageAction, updateNodeMetaAction, type UpdateNodeMetaInput } from "@/app/admin/(dashboard)/diagram/actions";
import type { DiagramGraph, DiagramNode } from "@/lib/diagram/types";

import { StatusBadge } from "./statusMeta";
import { useDiagramAction } from "./useDiagramAction";

type OverrideStatus = NonNullable<UpdateNodeMetaInput["statusOverride"]>;

const STATUS_OPTIONS: { value: OverrideStatus; label: string }[] = [
  { value: "AUTO", label: "Auto-detected (default)" },
  { value: "ACTIVE", label: "Active" },
  { value: "COMING_SOON", label: "Coming Soon" },
  { value: "DRAFT", label: "Draft" },
  { value: "IN_DEVELOPMENT", label: "In Development" },
  { value: "NEEDS_REVIEW", label: "Needs Review" },
];

function NodeChipList({ ids, nodeById, onJump }: { ids: string[]; nodeById: Map<string, DiagramNode>; onJump: (id: string) => void }) {
  if (ids.length === 0) return <p className="text-[13px] text-text-faint">None detected.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {ids.map((id) => {
        const n = nodeById.get(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => onJump(id)}
            className="rounded-full border border-border-strong bg-background px-2.5 py-1 text-[12px] font-semibold text-text-muted hover:border-primary hover:text-primary"
          >
            {n?.label ?? id}
          </button>
        );
      })}
    </div>
  );
}

export function NodeDetailsPanel({
  node,
  graph,
  onClose,
  onJump,
  onGraphUpdate,
}: {
  node: DiagramNode;
  graph: DiagramGraph;
  onClose: () => void;
  onJump: (id: string) => void;
  onGraphUpdate: (graph: DiagramGraph) => void;
}) {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(node.label);
  const [sectionLabel, setSectionLabel] = useState<string>(node.section);
  const [statusOverride, setStatusOverride] = useState<OverrideStatus>("AUTO");
  const [notes, setNotes] = useState(node.notes ?? "");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = useDiagramAction(() =>
    updateNodeMetaAction({
      route: node.route!,
      displayName: displayName.trim() || undefined,
      sectionLabel: sectionLabel.trim() || undefined,
      statusOverride,
      notes: notes.trim() || undefined,
    }),
  );

  const remove = useDiagramAction(() => deletePlannedPageAction(node.id.replace(/^planned:/, "")));

  const canEdit = node.kind === "page" || node.kind === "api";
  const canDelete = node.kind === "planned";

  async function handleSave() {
    const data = await save.execute();
    if (data) {
      onGraphUpdate(data);
      setEditing(false);
    }
  }

  async function handleDelete() {
    const data = await remove.execute();
    if (data) {
      onGraphUpdate(data);
      onClose();
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden="true" />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[420px] flex-col overflow-y-auto border-l border-border bg-surface p-5 shadow-xl"
        role="dialog"
        aria-label={`Details for ${node.label}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-display text-lg font-bold text-text-heading">{node.label}</h2>
            <p className="mt-0.5 truncate font-mono text-[12.5px] text-text-faint">{node.route ?? "Not yet built"}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 flex-none items-center justify-center rounded-md text-text-muted hover:bg-accent"
            aria-label="Close details panel"
          >
            <X className="size-4.5" strokeWidth={2} />
          </button>
        </div>

        <div className="mt-4">
          <StatusBadge status={node.status} />
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
          <div>
            <dt className="text-text-faint">Section</dt>
            <dd className="font-semibold text-text-heading">{node.section}</dd>
          </div>
          <div>
            <dt className="text-text-faint">Access Level</dt>
            <dd className="font-semibold text-text-heading">{node.accessLevel}</dd>
          </div>
          <div>
            <dt className="text-text-faint">Content Area</dt>
            <dd className="font-semibold text-text-heading">{node.contentArea}</dd>
          </div>
          <div>
            <dt className="text-text-faint">Route Type</dt>
            <dd className="font-semibold text-text-heading">{node.isDynamic ? "Dynamic" : "Static"}</dd>
          </div>
        </dl>

        {node.contentNote ? (
          <p className="mt-4 rounded-[9px] border border-primary-border bg-primary-tint px-3 py-2 text-[12.5px] text-text-muted">
            {node.contentNote}
          </p>
        ) : null}

        <div className="mt-5">
          <h3 className="text-[13px] font-bold text-text-heading">Connected From ({node.incoming.length})</h3>
          <div className="mt-2">
            <NodeChipList ids={node.incoming} nodeById={nodeById} onJump={onJump} />
          </div>
        </div>

        <div className="mt-5">
          <h3 className="text-[13px] font-bold text-text-heading">Connected To ({node.outgoing.filter((id) => nodeById.get(id)?.kind !== "missing").length})</h3>
          <div className="mt-2">
            <NodeChipList
              ids={node.outgoing.filter((id) => nodeById.get(id)?.kind !== "missing")}
              nodeById={nodeById}
              onJump={onJump}
            />
          </div>
        </div>

        {node.brokenOutgoing.length > 0 ? (
          <div className="mt-5">
            <h3 className="text-[13px] font-bold text-error">Broken Links ({node.brokenOutgoing.length})</h3>
            <ul className="mt-2 flex flex-col gap-1">
              {node.brokenOutgoing.map((pattern) => (
                <li key={pattern} className="rounded-[8px] border border-error-border bg-error-tint px-2.5 py-1.5 font-mono text-[12px] text-error">
                  {pattern}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {node.status === "DISCONNECTED" ? (
          <p className="mt-5 rounded-[9px] border border-error-border bg-error-tint px-3 py-2 text-[12.5px] text-error">
            Missing Connection: no other detected page currently links here. Needs Review if this
            page is meant to be reachable from navigation.
          </p>
        ) : null}

        <div className="mt-6 border-t border-border pt-4">
          <p className="text-[12px] text-text-faint">Last Detected</p>
          <p className="text-[13px] font-semibold text-text-heading">{new Date(graph.generatedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</p>
          <p className="mt-2 text-[12px] text-text-faint">Detection Source</p>
          <p className="text-[13px] text-text-muted">{node.detectionSource}</p>
        </div>

        {canEdit ? (
          <div className="mt-6 border-t border-border pt-4">
            {!editing ? (
              <>
                {node.notes ? <p className="mb-3 rounded-[9px] bg-accent px-3 py-2 text-[13px] text-text-muted">{node.notes}</p> : null}
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="flex items-center gap-1.5 text-[13px] font-bold text-primary hover:underline"
                >
                  <PencilLine className="size-3.5" strokeWidth={2} />
                  Edit metadata
                </button>
              </>
            ) : (
              <div className="flex flex-col gap-3">
                <label className="text-[12.5px] font-bold text-text-heading">
                  Display name
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="mt-1 w-full rounded-[9px] border border-border-strong bg-background px-3 py-2 text-[13.5px]"
                  />
                </label>
                <label className="text-[12.5px] font-bold text-text-heading">
                  Section label
                  <input
                    value={sectionLabel}
                    onChange={(e) => setSectionLabel(e.target.value)}
                    className="mt-1 w-full rounded-[9px] border border-border-strong bg-background px-3 py-2 text-[13.5px]"
                  />
                </label>
                <label className="text-[12.5px] font-bold text-text-heading">
                  Status override
                  <select
                    value={statusOverride}
                    onChange={(e) => setStatusOverride(e.target.value as OverrideStatus)}
                    className="mt-1 w-full rounded-[9px] border border-border-strong bg-background px-3 py-2 text-[13.5px]"
                  >
                    {STATUS_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-[12.5px] font-bold text-text-heading">
                  Notes
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    className="mt-1 w-full rounded-[9px] border border-border-strong bg-background px-3 py-2 text-[13.5px]"
                  />
                </label>
                {save.message ? <p className="text-[12.5px] text-error">{save.message}</p> : null}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={save.isLoading}
                    className="rounded-[9px] bg-primary px-3.5 py-2 text-[13px] font-bold text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
                  >
                    {save.isLoading ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="rounded-[9px] border border-border-strong px-3.5 py-2 text-[13px] font-bold text-text-muted hover:bg-accent"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {canDelete ? (
          <div className="mt-6 border-t border-border pt-4">
            {node.notes ? <p className="mb-3 text-[13px] text-text-muted">{node.notes}</p> : null}
            {remove.message ? <p className="mb-2 text-[12.5px] text-error">{remove.message}</p> : null}
            <button
              type="button"
              onClick={handleDelete}
              disabled={remove.isLoading}
              className="flex items-center gap-1.5 text-[13px] font-bold text-error hover:underline disabled:opacity-60"
            >
              <Trash2 className="size-3.5" strokeWidth={2} />
              {remove.isLoading ? "Removing…" : "Remove planned page"}
            </button>
          </div>
        ) : null}
      </aside>
    </>
  );
}
