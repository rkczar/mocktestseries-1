"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { refreshImagePriceAction, syncModelsAction, updateModelAction } from "@/app/admin/(dashboard)/ai/engine-actions";

export function SyncModelsButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        disabled={pending}
        data-testid="sync-models"
        onClick={() =>
          start(async () => {
            setMsg(null);
            const r = await syncModelsAction();
            if (!r.ok) return setMsg({ tone: "error", text: r.error });
            setMsg({ tone: "ok", text: `Synced ${r.data.text} text + ${r.data.image} image models (${r.data.added} new, ${r.data.missing} no longer listed).` });
            router.refresh();
          })
        }
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />} Sync models
      </Button>
      {msg ? (
        <p role={msg.tone === "error" ? "alert" : "status"} className={`text-xs ${msg.tone === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`} data-testid="sync-message">
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}

interface ModelFlags {
  id: string;
  approved: boolean;
  medicallyApproved: boolean;
  disabled: boolean;
  isImageModel: boolean;
  imageUnit: string | null;
  imageUnitsPerImage: number | null;
  notes: string | null;
}

/** Approve / medically approve / disable one model (Master Admin). FULL_ADMIN sees the flags read-only. */
export function ModelRowControls({ model, canManage }: { model: ModelFlags; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [units, setUnits] = useState(model.imageUnitsPerImage?.toString() ?? "");
  // Optimistic: the box changes immediately and reverts if the server refuses.
  const [flags, setFlags] = useState({ approved: model.approved, medicallyApproved: model.medicallyApproved, disabled: model.disabled });
  const save = (patch: Partial<ModelFlags> & { imageUnitsPerImage?: number | null }) => {
    const prev = flags;
    setFlags((f) => ({ ...f, ...patch, ...(patch.approved === false ? { medicallyApproved: false } : {}) }));
    start(async () => {
      setErr(null);
      const r = await updateModelAction({ id: model.id, ...patch });
      if (!r.ok) {
        setFlags(prev);
        return setErr(r.error);
      }
      router.refresh();
    });
  };

  if (!canManage) {
    return <span className="text-xs">{[model.approved ? "Approved" : "Not approved", model.medicallyApproved ? "Medical ✓" : null, model.disabled ? "Disabled" : null].filter(Boolean).join(" · ")}</span>;
  }
  return (
    <div className="flex min-w-[190px] flex-col gap-1 text-xs" data-testid={`model-controls-${model.id}`}>
      <label className="flex items-center gap-2">
        <input type="checkbox" disabled={pending} checked={flags.approved} onChange={(e) => save({ approved: e.target.checked })} data-testid="approve" /> Approved for routing
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" disabled={pending || !flags.approved} checked={flags.medicallyApproved} onChange={(e) => save({ medicallyApproved: e.target.checked })} data-testid="medical" /> Medically approved
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" disabled={pending} checked={flags.disabled} onChange={(e) => save({ disabled: e.target.checked })} data-testid="disable" /> Disabled
      </label>
      {model.isImageModel ? (
        <div className="flex flex-col gap-1">
          {model.imageUnit && model.imageUnit !== "image" && model.imageUnit !== "megapixel" ? (
            <span className="flex items-center gap-1">
              <input
                className="h-7 w-24 rounded border border-[var(--color-border)] bg-transparent px-1"
                type="number"
                min="1"
                placeholder={`${model.imageUnit}s/image`}
                value={units}
                onChange={(e) => setUnits(e.target.value)}
                aria-label="Billable units per image"
              />
              <button type="button" className="underline" disabled={pending} onClick={() => save({ imageUnitsPerImage: units ? Number(units) : null })}>
                Set
              </button>
            </span>
          ) : null}
          <button
            type="button"
            className="w-fit underline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await refreshImagePriceAction(model.id);
                if (!r.ok) setErr(r.error);
                router.refresh();
              })
            }
          >
            Refresh image price
          </button>
        </div>
      ) : null}
      {err ? (
        <span role="alert" className="text-[var(--color-error)]">
          {err}
        </span>
      ) : null}
    </div>
  );
}
