"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, PenLine, Presentation, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import { TEMPLATES, templatesForMode } from "@/lib/instagram/templates";
import { DESIGN_MODE_LABELS, FONT_CHOICES, FONT_LABELS, OVERRIDE_COLOR_KEYS, modeOfTemplate, type DesignMode, type DesignOverrides, type PostDesign, type TemplateKey } from "@/lib/instagram/types";
import { deleteDesignPresetAction, listDesignPresetsAction, saveDefaultTemplateAction, saveDesignPresetAction } from "@/app/admin/(dashboard)/instagram/studio-actions";
import type { DesignPreset } from "@/lib/instagram/presets";

const COLOR_LABELS: Record<(typeof OVERRIDE_COLOR_KEYS)[number], string> = {
  background: "Background",
  card: "Cards",
  foreground: "Text",
  accent: "Accent / ink",
  highlight: "Highlight",
};

/** Hex colour for an <input type=color> (rgba template colours fall back to black/white). */
function hexOr(v: string, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

/**
 * Design tab: Handwritten vs Professional mode, presets of that mode, colour
 * and font overrides, saved design presets, and "set as default". Switching
 * design never touches the medical content.
 */
export function DesignModePicker({ design, onChange, disabled }: { design: PostDesign; onChange: (p: Partial<PostDesign>) => void; disabled?: boolean }) {
  const mode = modeOfTemplate(design.template);
  const theme = TEMPLATES[design.template];
  const [presets, setPresets] = useState<DesignPreset[]>([]);
  const [defaultTemplate, setDefaultTemplate] = useState<TemplateKey | null>(null);
  const [presetName, setPresetName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    listDesignPresetsAction().then((r) => {
      if (r.ok) {
        setPresets(r.data.presets);
        setDefaultTemplate(r.data.defaultTemplate);
      }
    });
  }, []);

  const setMode = (m: DesignMode) => {
    if (m === mode) return;
    const first = m === "handwritten" ? "hw-doctor" : defaultTemplate && modeOfTemplate(defaultTemplate) === "professional" ? defaultTemplate : "minimal-infographic";
    onChange({ template: first, overrides: undefined });
  };
  const setOverride = (k: keyof DesignOverrides, v: string | undefined) => {
    const next: DesignOverrides = { ...(design.overrides ?? {}) };
    if (v === undefined || v === "default") delete next[k];
    else (next as Record<string, string>)[k] = v;
    onChange({ overrides: Object.keys(next).length ? next : undefined });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="design-mode-picker">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--color-muted-foreground)]">Design mode</span>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Design mode">
          {(["professional", "handwritten"] as DesignMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={disabled}
              data-testid={`mode-${m}`}
              onClick={() => setMode(m)}
              className={cn(
                "flex items-center gap-2 rounded-[var(--radius-button)] border px-3 py-2.5 text-left text-sm",
                mode === m ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10" : "border-[var(--color-border)]"
              )}
            >
              {m === "handwritten" ? <PenLine className="h-4 w-4 shrink-0" aria-hidden /> : <Presentation className="h-4 w-4 shrink-0" aria-hidden />}
              <span>
                <span className="block font-medium">{DESIGN_MODE_LABELS[m]}</span>
                <span className="block text-[11px] text-[var(--color-muted-foreground)]">{m === "handwritten" ? "Notebook, handwriting, pen & highlighter" : "Clean infographic, tables, premium type"}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--color-muted-foreground)]">{`${DESIGN_MODE_LABELS[mode]} presets`}</span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {templatesForMode(mode).map((k) => (
            <button
              key={k}
              type="button"
              disabled={disabled}
              data-testid={`template-${k}`}
              aria-pressed={design.template === k}
              onClick={() => onChange({ template: k })}
              className={cn("flex flex-col gap-1 rounded-[var(--radius-button)] border p-1.5 text-left", design.template === k ? "border-[var(--color-primary)] ring-1 ring-[var(--color-primary)]" : "border-[var(--color-border)]")}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/admin/instagram/template-sample?t=${k}&i=1`} alt="" width={160} height={200} loading="lazy" className="aspect-[4/5] w-full rounded object-cover" />
              <span className="flex items-center gap-1 text-[11px] font-medium leading-tight">
                {design.template === k ? <Check className="h-3 w-3 shrink-0" aria-hidden /> : null}
                {TEMPLATES[k].name}
                {k === defaultTemplate ? <span className="text-[var(--color-muted-foreground)]"> · default</span> : null}
              </span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-[var(--color-muted-foreground)]">{theme.description}</p>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted-foreground)]">
          Template (any mode)
          <SelectNative value={design.template} disabled={disabled} onChange={(e) => onChange({ template: e.target.value as TemplateKey })} data-testid="design-template">
            {(["professional", "handwritten"] as DesignMode[]).map((m) => (
              <optgroup key={m} label={DESIGN_MODE_LABELS[m]}>
                {templatesForMode(m).map((k) => (
                  <option key={k} value={k}>
                    {k === "midnight" ? "Midnight Medical (website)" : TEMPLATES[k].name}
                  </option>
                ))}
              </optgroup>
            ))}
          </SelectNative>
        </label>
      </div>

      <details className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
        <summary className="cursor-pointer text-sm font-medium">Fonts and colours (this post)</summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {OVERRIDE_COLOR_KEYS.map((k) => (
            <label key={k} className="flex items-center gap-2 text-xs">
              <input
                type="color"
                disabled={disabled}
                value={design.overrides?.[k] ?? hexOr((theme as unknown as Record<string, string>)[k] ?? "", k === "foreground" ? "#111111" : "#ffffff")}
                onChange={(e) => setOverride(k, e.target.value)}
                className="h-8 w-10 cursor-pointer rounded border border-[var(--color-border)] bg-transparent"
                aria-label={COLOR_LABELS[k]}
              />
              {COLOR_LABELS[k]}
              {design.overrides?.[k] ? (
                <button type="button" className="text-[var(--color-muted-foreground)] underline" onClick={() => setOverride(k, undefined)}>
                  reset
                </button>
              ) : null}
            </label>
          ))}
          <label className="col-span-2 flex flex-col gap-1 text-xs sm:col-span-1">
            Font
            <SelectNative value={design.overrides?.font ?? "default"} disabled={disabled} onChange={(e) => setOverride("font", e.target.value)}>
              {FONT_CHOICES.map((f) => (
                <option key={f} value={f}>
                  {FONT_LABELS[f]}
                </option>
              ))}
            </SelectNative>
          </label>
        </div>
        {design.overrides ? (
          <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => onChange({ overrides: undefined })} disabled={disabled}>
            Reset all to the template
          </Button>
        ) : null}
      </details>

      <details className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="design-presets">
        <summary className="cursor-pointer text-sm font-medium">{`Saved design presets (${presets.length})`}</summary>
        <div className="mt-3 flex flex-col gap-2">
          {presets.length === 0 ? <p className="text-xs text-[var(--color-muted-foreground)]">No saved presets yet.</p> : null}
          {presets.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="flex-1">{`${p.name} · ${TEMPLATES[p.template].name}${p.overrides ? " (custom colours)" : ""}`}</span>
              <Button type="button" size="compact" variant="outline" disabled={disabled} onClick={() => onChange({ template: p.template, overrides: p.overrides, questionScale: p.questionScale, bodyScale: p.bodyScale })}>
                Apply
              </Button>
              <Button
                type="button"
                size="compact"
                variant="ghost"
                aria-label={`Delete preset ${p.name}`}
                disabled={pending}
                onClick={() => start(async () => {
                  const r = await deleteDesignPresetAction(p.id);
                  if (r.ok) setPresets((x) => x.filter((y) => y.id !== p.id));
                  else setMsg(r.error);
                })}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Preset name, e.g. Pharmacology notes" maxLength={40} />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || !presetName.trim()}
              data-testid="save-preset"
              onClick={() =>
                start(async () => {
                  const r = await saveDesignPresetAction({ name: presetName, template: design.template, overrides: design.overrides, questionScale: design.questionScale, bodyScale: design.bodyScale });
                  if (!r.ok) return setMsg(r.error);
                  setPresets((x) => [...x.filter((y) => y.name.toLowerCase() !== r.data.name.toLowerCase()), r.data]);
                  setPresetName("");
                  setMsg(`Saved preset "${r.data.name}".`);
                })
              }
            >
              Save current design
            </Button>
          </div>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || design.template === defaultTemplate}
          data-testid="set-default-design"
          onClick={() =>
            start(async () => {
              const r = await saveDefaultTemplateAction(design.template);
              if (!r.ok) return setMsg(r.error);
              setDefaultTemplate(design.template);
              setMsg(`${TEMPLATES[design.template].name} is now the default design for new posts.`);
            })
          }
        >
          Set as default design for new posts
        </Button>
        {msg ? <span className="text-xs text-[var(--color-muted-foreground)]" role="status">{msg}</span> : null}
      </div>
    </div>
  );
}
