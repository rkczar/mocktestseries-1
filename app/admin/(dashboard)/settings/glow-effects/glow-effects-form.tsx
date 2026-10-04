"use client";

import { useState, useTransition, type CSSProperties } from "react";
import { Check, MessageCircle, Moon, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  PREMIUM_GLOW_HEX_RE,
  PREMIUM_GLOW_INTENSITIES,
  PREMIUM_GLOW_OFF_VARIABLES,
  PREMIUM_GLOW_PRESETS,
  PREMIUM_GLOW_SPEEDS,
  PREMIUM_GLOW_TARGETS,
  PREMIUM_GLOW_TARGET_LABELS,
  premiumGlowVariables,
  type PremiumGlowConfig,
  type PremiumGlowTarget,
} from "@/lib/premium-glow";
import { resetGlowEffectsAction, saveGlowEffectsAction } from "./actions";

const INTENSITY_LABELS = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" } as const;
const SPEED_LABELS = { SLOW: "Slow", NORMAL: "Normal", FAST: "Fast" } as const;

function sameConfig(a: PremiumGlowConfig, b: PremiumGlowConfig) {
  return (
    a.enabled === b.enabled &&
    a.color.toUpperCase() === b.color.toUpperCase() &&
    a.intensity === b.intensity &&
    a.speed === b.speed &&
    PREMIUM_GLOW_TARGETS.every((t) => a.targets[t] === b.targets[t])
  );
}

function Segmented<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-[var(--color-foreground)]">{label}</span>
      <div role="radiogroup" aria-label={label} className="inline-flex w-fit rounded-[var(--radius-button)] border border-[var(--color-border)] p-0.5">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={value === o}
            disabled={disabled}
            onClick={() => onChange(o)}
            className={cn(
              "rounded-[calc(var(--radius-button)-2px)] px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              value === o
                ? "bg-[var(--color-primary)] font-medium text-white"
                : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            )}
          >
            {labels[o]}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({ id, label, checked, onChange, disabled, hint }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex flex-col">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <span className="text-xs text-[var(--color-muted-foreground)]">{hint}</span> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

export function GlowEffectsForm({ initial, canManage }: { initial: PremiumGlowConfig; canManage: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [hexInput, setHexInput] = useState(initial.color);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const hexValid = PREMIUM_GLOW_HEX_RE.test(hexInput);
  const dirty = !sameConfig(draft, saved) || (!hexValid && hexInput !== draft.color);
  const locked = !canManage || isPending;

  const update = (patch: Partial<PremiumGlowConfig>) => {
    setMessage(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setTarget = (t: PremiumGlowTarget, on: boolean) => {
    setMessage(null);
    setDraft((d) => ({ ...d, targets: { ...d.targets, [t]: on } }));
  };
  const setColor = (value: string) => {
    setHexInput(value);
    if (PREMIUM_GLOW_HEX_RE.test(value)) update({ color: value.toUpperCase() });
    else setMessage(null);
  };

  const applyResult = (result: Awaited<ReturnType<typeof saveGlowEffectsAction>>, successText: string) => {
    if (!result.ok) {
      setMessage({ kind: "error", text: result.error });
      return;
    }
    setSaved(result.config);
    setDraft(result.config);
    setHexInput(result.config.color);
    setMessage({ kind: "success", text: successText });
  };

  const save = () => {
    if (!hexValid) {
      setMessage({ kind: "error", text: "Glow Color must be a 6-digit hex color like #8B5CF6." });
      return;
    }
    startTransition(async () => {
      try {
        applyResult(await saveGlowEffectsAction({ ...draft, color: hexInput }), "Saved. Students see the new glow within a few seconds.");
      } catch {
        setMessage({ kind: "error", text: "Couldn't save — check your connection or permissions and try again." });
      }
    });
  };

  const reset = () => {
    if (!window.confirm("Reset all glow settings to their defaults? This is saved immediately.")) return;
    startTransition(async () => {
      try {
        applyResult(await resetGlowEffectsAction(), "Restored the default glow.");
      } catch {
        setMessage({ kind: "error", text: "Couldn't reset — check your connection or permissions and try again." });
      }
    });
  };

  // The preview sets every glow variable inline on each button, so it shows
  // the UNSAVED draft and beats the site-wide (saved) rules in <head>.
  const glowOn = (t: PremiumGlowTarget): CSSProperties =>
    ({
      ...premiumGlowVariables(draft),
      ...(draft.enabled && draft.targets[t] ? { "--premium-glow-animation": "premium-glow" } : PREMIUM_GLOW_OFF_VARIABLES),
    }) as CSSProperties;

  const iconButton =
    "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)]";

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-[var(--radius-card)] border border-[var(--color-border)] px-4">
        <ToggleRow
          id="glow-master"
          label="Premium Glow Effects"
          hint="Master switch. Off removes every glow below; the buttons keep working."
          checked={draft.enabled}
          onChange={(v) => update({ enabled: v })}
          disabled={locked}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-semibold text-[var(--color-foreground)]">Buttons</h3>
        <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">Glow only — turning one off never disables the feature.</p>
        <div className={cn("divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)] px-4", !draft.enabled && "opacity-60")}>
          {PREMIUM_GLOW_TARGETS.map((t) => (
            <ToggleRow key={t} id={`glow-${t}`} label={PREMIUM_GLOW_TARGET_LABELS[t]} checked={draft.targets[t]} onChange={(v) => setTarget(t, v)} disabled={locked} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-5">
        <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Appearance</h3>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="glow-hex">Glow Color</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Glow color picker"
              value={draft.color.toLowerCase()}
              onChange={(e) => setColor(e.target.value.toUpperCase())}
              disabled={locked}
              className="h-10 w-12 cursor-pointer rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] disabled:cursor-not-allowed"
            />
            <Input
              id="glow-hex"
              value={hexInput}
              onChange={(e) => setColor(e.target.value.trim())}
              maxLength={7}
              spellCheck={false}
              disabled={locked}
              aria-invalid={!hexValid}
              aria-describedby="glow-hex-help"
              className="w-32 font-mono uppercase"
            />
          </div>
          <span id="glow-hex-help" className={cn("text-xs", hexValid ? "text-[var(--color-muted-foreground)]" : "text-[var(--color-error)]")}>
            {hexValid ? "6-digit hex, e.g. #8B5CF6." : "Enter a 6-digit hex color like #8B5CF6."}
          </span>
          <div className="mt-1 flex flex-wrap items-center gap-2" aria-label="Color presets">
            {PREMIUM_GLOW_PRESETS.map((p) => {
              const active = draft.color.toUpperCase() === p.color.toUpperCase() && hexValid;
              return (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setColor(p.color)}
                  disabled={locked}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    active ? "border-[var(--color-foreground)] text-[var(--color-foreground)]" : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                  )}
                >
                  <span className="h-3 w-3 rounded-full" style={{ background: p.color }} aria-hidden />
                  {p.name}
                  {active ? <Check className="h-3 w-3" aria-hidden /> : null}
                </button>
              );
            })}
            <span className="text-xs text-[var(--color-muted-foreground)]">
              {PREMIUM_GLOW_PRESETS.some((p) => p.color.toUpperCase() === draft.color.toUpperCase()) ? "" : "Custom color"}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-6">
          <Segmented label="Glow Intensity" options={PREMIUM_GLOW_INTENSITIES} labels={INTENSITY_LABELS} value={draft.intensity} onChange={(v) => update({ intensity: v })} disabled={locked} />
          <Segmented label="Animation Speed" options={PREMIUM_GLOW_SPEEDS} labels={SPEED_LABELS} value={draft.speed} onChange={(v) => update({ speed: v })} disabled={locked} />
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-semibold text-[var(--color-foreground)]">Preview</h3>
        <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
          Shows your current choices before saving. Students with reduced motion turned on see a still glow.
        </p>
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-5" aria-hidden data-testid="glow-preview">
          <Button type="button" variant="outline" size="sm" tabIndex={-1} className="ai-action premium-glow pointer-events-none" style={glowOn("ASK_AI")} data-preview-target="ASK_AI">
            <Sparkles className="ai-action-icon h-4 w-4" /> Ask AI
          </Button>
          <Button type="button" variant="outline" size="sm" tabIndex={-1} className="ai-action premium-glow pointer-events-none" style={glowOn("AI_QUESTION_VARIANT")} data-preview-target="AI_QUESTION_VARIANT">
            <Sparkles className="ai-action-icon h-4 w-4" /> AI Question Variant
          </Button>
          <Button type="button" variant="outline" size="sm" tabIndex={-1} className="premium-glow pointer-events-none" style={glowOn("WHATSAPP_SHARE")} data-preview-target="WHATSAPP_SHARE">
            <MessageCircle className="h-4 w-4" /> Share on WhatsApp
          </Button>
          <span className={cn(iconButton, "premium-glow")} style={glowOn("THEME_TOGGLE")} data-preview-target="THEME_TOGGLE">
            <Moon className="h-4 w-4" />
          </span>
          <span className={cn(iconButton, "premium-glow text-xs font-bold")} style={glowOn("TEXT_SIZE")} data-preview-target="TEXT_SIZE">
            A+
          </span>
        </div>
      </section>

      <div className="flex flex-col-reverse gap-3 border-t border-[var(--color-border)] pt-5 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={reset} disabled={locked}>
          Reset to Default
        </Button>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          {message ? (
            <span role="status" className={cn("text-sm", message.kind === "success" ? "text-[var(--color-success)]" : "text-[var(--color-error)]")}>
              {message.text}
            </span>
          ) : dirty && canManage ? (
            <span className="text-sm text-[var(--color-muted-foreground)]">Unsaved changes</span>
          ) : null}
          <Button type="button" onClick={save} disabled={locked || !dirty || !hexValid}>
            {isPending ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
