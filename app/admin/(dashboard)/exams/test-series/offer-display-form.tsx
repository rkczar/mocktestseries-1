"use client";

import { useActionState, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  CUSTOM_ROW_PREFIX,
  LOCKED_ROW_KEYS,
  MAX_OFFER_ROWS,
  type OfferCellMode,
  type OfferDisplayConfig,
  type OfferRowConfig,
  type PlanRow,
} from "@/lib/payments/offer-display-shared";
import { resetOfferDisplayAction, saveOfferDisplayAction, type TestSeriesFormState } from "./actions";

/**
 * Structured editor for the Free vs Complete presentation of one series.
 * Rows left on AUTO keep the live value derived from the access engine;
 * the Price row is canonical Product data and can only be moved or hidden.
 */

type EditorRow = OfferRowConfig & { derived?: PlanRow };

const MODE_LABEL: Record<OfferCellMode, string> = { AUTO: "Auto (live)", TEXT: "Custom text", CHECK: "Included ✓", CROSS: "Not included —" };

function initialRows(derived: PlanRow[], config: OfferDisplayConfig): EditorRow[] {
  const byKey = new Map(derived.map((d) => [d.key, d]));
  const out: EditorRow[] = [];
  const seen = new Set<string>();
  for (const r of config.rows) {
    if (seen.has(r.key) || (!byKey.has(r.key) && !r.key.startsWith(CUSTOM_ROW_PREFIX))) continue;
    seen.add(r.key);
    out.push({ ...r, derived: byKey.get(r.key) });
  }
  for (const d of derived) {
    if (!seen.has(d.key)) out.push({ key: d.key, free: { mode: "AUTO" }, paid: { mode: "AUTO" }, visible: true, highlight: false, derived: d });
  }
  return out;
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={disabled || pending}>
      {pending ? "Saving…" : "Save display"}
    </Button>
  );
}

export function OfferDisplayForm({
  seriesId,
  derivedRows,
  config,
  readOnly,
}: {
  seriesId: string;
  derivedRows: PlanRow[];
  config: OfferDisplayConfig;
  readOnly: boolean;
}) {
  const [state, formAction] = useActionState<TestSeriesFormState, FormData>(saveOfferDisplayAction.bind(null, seriesId), {});
  const [promoVisible, setPromoVisible] = useState(config.promoVisible);
  const [heading, setHeading] = useState(config.heading);
  const [description, setDescription] = useState(config.description);
  const [ctaLabel, setCtaLabel] = useState(config.ctaLabel);
  const [rows, setRows] = useState<EditorRow[]>(() => initialRows(derivedRows, config));
  const [resetting, startReset] = useTransition();
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const update = (i: number, patch: Partial<EditorRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) =>
    setRows((rs) => {
      const j = i + dir;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const addCustom = () =>
    setRows((rs) => [
      ...rs,
      { key: `${CUSTOM_ROW_PREFIX}${Date.now().toString(36)}`, feature: "", free: { mode: "CROSS" }, paid: { mode: "CHECK" }, visible: true, highlight: false },
    ]);

  const payload = JSON.stringify({
    promoVisible,
    heading,
    description,
    ctaLabel,
    rows: rows.map((r) => ({
      key: r.key,
      ...(r.feature?.trim() ? { feature: r.feature.trim() } : {}),
      free: r.free.mode === "TEXT" ? { mode: "TEXT", text: r.free.text ?? "" } : { mode: r.free.mode },
      paid: r.paid.mode === "TEXT" ? { mode: "TEXT", text: r.paid.text ?? "" } : { mode: r.paid.mode },
      visible: r.visible,
      highlight: r.highlight,
    })),
  });

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="config" value={payload} />
      <fieldset disabled={readOnly} className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)] sm:col-span-2">
            <input type="checkbox" checked={promoVisible} onChange={(e) => setPromoVisible(e.target.checked)} className="h-4 w-4" />
            Show the upgrade offer card to Free students on the Student Dashboard
            <span className="text-xs text-[var(--color-muted-foreground)]">(when off, a slim “Free Access” status line stays visible)</span>
          </label>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="od-heading">Heading</Label>
            <Input id="od-heading" value={heading} maxLength={80} onChange={(e) => setHeading(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="od-cta">CTA label</Label>
            <Input id="od-cta" value={ctaLabel} maxLength={40} onChange={(e) => setCtaLabel(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="od-desc">Short description (optional — a live default is used when empty)</Label>
            <Input id="od-desc" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-[var(--color-foreground)]">Comparison rows</p>
            <Button type="button" size="sm" variant="outline" onClick={addCustom} disabled={readOnly || rows.length >= MAX_OFFER_ROWS}>
              <Plus className="h-4 w-4" aria-hidden /> Add custom row
            </Button>
          </div>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Auto cells show what the access engine and AI settings actually enforce. Only override what you can stand behind — custom rows are
            shown exactly as written.
          </p>
          <ol className="flex flex-col gap-2">
            {rows.map((r, i) => {
              const locked = LOCKED_ROW_KEYS.has(r.key);
              const custom = r.key.startsWith(CUSTOM_ROW_PREFIX);
              return (
                <li
                  key={r.key}
                  className={`rounded-[var(--radius-card)] border p-3 ${r.visible ? "border-[var(--color-border)]" : "border-dashed border-[var(--color-border)] opacity-60"}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex gap-1">
                      <Button type="button" size="sm" variant="ghost" aria-label="Move up" onClick={() => move(i, -1)} disabled={readOnly || i === 0}>
                        <ArrowUp className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button type="button" size="sm" variant="ghost" aria-label="Move down" onClick={() => move(i, 1)} disabled={readOnly || i === rows.length - 1}>
                        <ArrowDown className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                    <Input
                      aria-label="Feature label"
                      className="min-w-[10rem] flex-1"
                      value={r.feature ?? ""}
                      placeholder={r.derived?.feature ?? "Feature name"}
                      maxLength={80}
                      disabled={locked}
                      onChange={(e) => update(i, { feature: e.target.value })}
                    />
                    {custom ? <Badge variant="info">Custom</Badge> : null}
                    <label className="flex items-center gap-1.5 text-xs text-[var(--color-foreground)]">
                      <input type="checkbox" checked={r.visible} onChange={(e) => update(i, { visible: e.target.checked })} className="h-4 w-4" /> Visible
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-[var(--color-foreground)]">
                      <input type="checkbox" checked={r.highlight} onChange={(e) => update(i, { highlight: e.target.checked })} className="h-4 w-4" /> Highlight
                    </label>
                    {custom ? (
                      <Button type="button" size="sm" variant="ghost" aria-label="Remove row" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} disabled={readOnly}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                  {locked ? (
                    <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                      Price comes from the Product (Payments → Products) — only order and visibility can change here. Live: {r.derived?.paid}
                    </p>
                  ) : (
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {(["free", "paid"] as const).map((col) => (
                        <div key={col} className="flex flex-col gap-1">
                          <span className="text-[11px] uppercase text-[var(--color-muted-foreground)]">{col === "free" ? "Free" : "Complete Access"}</span>
                          <div className="flex gap-2">
                            <select
                              aria-label={`${col === "free" ? "Free" : "Complete"} cell type`}
                              value={r[col].mode}
                              onChange={(e) => update(i, { [col]: { ...r[col], mode: e.target.value as OfferCellMode } })}
                              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-foreground)]"
                            >
                              {(custom ? (["TEXT", "CHECK", "CROSS"] as const) : (["AUTO", "TEXT", "CHECK", "CROSS"] as const)).map((m) => (
                                <option key={m} value={m}>
                                  {MODE_LABEL[m]}
                                </option>
                              ))}
                            </select>
                            {r[col].mode === "TEXT" ? (
                              <Input
                                aria-label={`${col === "free" ? "Free" : "Complete"} text`}
                                value={r[col].text ?? ""}
                                maxLength={120}
                                onChange={(e) => update(i, { [col]: { mode: "TEXT", text: e.target.value } })}
                              />
                            ) : r[col].mode === "AUTO" ? (
                              <span className="self-center truncate text-xs text-[var(--color-muted-foreground)]">Live: {r.derived?.[col]}</span>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </fieldset>

      {readOnly ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">View only — MASTER_ADMIN can change the offer display.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <SaveButton disabled={readOnly} />
          <Button
            type="button"
            variant="ghost"
            disabled={resetting}
            onClick={() => {
              if (!confirm("Reset the offer display to the live defaults?")) return;
              startReset(async () => {
                const r = await resetOfferDisplayAction(seriesId);
                setResetMsg(r.error ?? "Reset — reload to see the defaults.");
              });
            }}
          >
            Reset to defaults
          </Button>
          {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
          {state.success ? <p className="text-sm text-[var(--color-success)]">Saved — dashboard, Test Series and series page updated.</p> : null}
          {resetMsg ? <p className="text-sm text-[var(--color-muted-foreground)]">{resetMsg}</p> : null}
        </div>
      )}
    </form>
  );
}
