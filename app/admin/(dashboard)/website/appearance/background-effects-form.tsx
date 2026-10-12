"use client";

import { useState, useTransition } from "react";
import { Monitor, Moon, RotateCcw, Smartphone, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import { BackgroundEffectsRenderer } from "@/components/background-effects/renderer";
import {
  BG_DESIGNS,
  BG_DESIGN_LABELS,
  BG_DOT_COLORS,
  BG_DOT_COLOR_LABELS,
  BG_GLOW_COLORS,
  BG_GLOW_COLOR_LABELS,
  BG_GLOW_LABELS,
  BG_GALAXY_MOBILE_MAX,
  BG_HEX_RE,
  BG_LIMITS,
  BG_POSITIONS,
  BG_POSITION_LABELS,
  BG_SCOPES,
  BG_SCOPE_LABELS,
  BG_SIZES,
  BG_SIZE_LABELS,
  BG_SPREADS,
  BG_SPREAD_LABELS,
  BG_THEME_LABELS,
  BG_THEME_MODES,
  defaultBackgroundEffectsConfig,
  type BackgroundEffectsConfig,
  type BgDesign,
  type BgDesignSettings,
} from "@/lib/background-effects";
import { saveBackgroundEffectsAction } from "./background-effects-actions";

const DESIGN_HINTS: Record<BgDesign, string> = {
  DOTTED_WATERMARK: "Large MockTestSeries.in lettering made of small dots.",
  DOTTED_PATTERN: "An even dot grid across the page background.",
  GALAXY: "Particles glide into the wordmark once, then stop.",
  GRADIENT_DOTS: "Soft gradient, edge-fading dots and the wordmark.",
};
const HAS_WATERMARK: Record<BgDesign, boolean> = { DOTTED_WATERMARK: true, DOTTED_PATTERN: false, GALAXY: true, GRADIENT_DOTS: true };

function Segmented<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (v: T) => void;
  disabled: boolean;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-[var(--color-foreground)]">{label}</span>
      <div role="radiogroup" aria-label={label} data-testid={testId} className="inline-flex w-fit max-w-full flex-wrap rounded-[var(--radius-button)] border border-[var(--color-border)] p-0.5">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={value === o}
            data-value={o}
            disabled={disabled}
            onClick={() => onChange(o)}
            className={cn(
              "rounded-[calc(var(--radius-button)-2px)] px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              value === o ? "bg-[var(--color-primary)] font-medium text-white" : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            )}
          >
            {labels[o]}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
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

function Slider({ id, label, value, min, max, step = 1, suffix, onChange, disabled }: { id: string; label: string; value: number; min: number; max: number; step?: number; suffix: string; onChange: (v: number) => void; disabled: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <span className="font-mono text-xs text-[var(--color-muted-foreground)]" data-testid={`${id}-value`}>
          {value}
          {suffix}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--color-primary)] disabled:cursor-not-allowed"
      />
    </div>
  );
}

function ColorChoice<T extends string>({
  id,
  label,
  options,
  labels,
  value,
  custom,
  onChange,
  onCustom,
  disabled,
}: {
  id: string;
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  custom: string;
  onChange: (v: T) => void;
  onCustom: (hex: string) => void;
  disabled: boolean;
}) {
  const [hex, setHex] = useState(custom);
  const valid = BG_HEX_RE.test(hex);
  const set = (v: string) => {
    setHex(v);
    if (BG_HEX_RE.test(v)) onCustom(v.toUpperCase());
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <SelectNative id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} className="w-full sm:w-56">
        {options.map((o) => (
          <option key={o} value={o}>
            {labels[o]}
          </option>
        ))}
      </SelectNative>
      {value === "CUSTOM" ? (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${label} picker`}
            value={(valid ? hex : custom).toLowerCase()}
            onChange={(e) => set(e.target.value.toUpperCase())}
            disabled={disabled}
            className="h-10 w-12 cursor-pointer rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] disabled:cursor-not-allowed"
          />
          <Input
            id={`${id}-hex`}
            aria-label={`${label} hex`}
            value={hex}
            onChange={(e) => set(e.target.value.trim())}
            maxLength={7}
            spellCheck={false}
            disabled={disabled}
            aria-invalid={!valid}
            className="w-32 font-mono uppercase"
          />
          {!valid ? <span className="text-xs text-[var(--color-error)]">Use #RRGGBB</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function PreviewFrame({ config, theme, device, replayKey }: { config: BackgroundEffectsConfig; theme: "dark" | "light"; device: "desktop" | "mobile"; replayKey: number }) {
  const dark = theme === "dark";
  const fg = dark ? "#f5f5f5" : "#16171a";
  const muted = dark ? "#a3a3a3" : "#61646b";
  const card = dark ? "#171717" : "#ffffff";
  const border = dark ? "rgba(255,255,255,.12)" : "#e6e7ea";
  return (
    <div
      data-testid="bg-preview"
      data-preview-theme={theme}
      data-preview-device={device}
      className={cn("relative isolate mx-auto overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)]", device === "mobile" ? "h-[560px] w-[360px] max-w-full" : "h-[420px] w-full")}
      style={{ background: dark ? "#000000" : "#fbfbfc", color: fg }}
    >
      <BackgroundEffectsRenderer config={config} preview={{ theme, replayKey, forceAnimate: replayKey > 0 }} />
      {/* A stand-in page so the effect is judged behind real-looking content. */}
      <div className="flex h-12 items-center justify-between px-4" style={{ borderBottom: `1px solid ${border}` }}>
        <span className="text-sm font-bold tracking-tight">MockTestSeries.in</span>
        <span className="rounded-md px-2.5 py-1 text-xs font-medium" style={{ background: dark ? "#f2f2f2" : "#16171a", color: dark ? "#1a1a1a" : "#fff" }}>
          Sign in
        </span>
      </div>
      <div className="flex flex-col gap-3 px-5 pt-8">
        <span className="w-fit rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ border: `1px solid ${border}`, color: muted }}>
          RUHS MO 2026
        </span>
        <p className={cn("max-w-md font-normal leading-tight", device === "mobile" ? "text-xl" : "text-2xl")}>Crack your Medical Officer exam with real mock tests</p>
        <p className="max-w-md text-xs" style={{ color: muted }}>
          Full-length mocks, previous year papers and AI explanations.
        </p>
        <div className="flex gap-2">
          <span className="rounded-md px-3 py-1.5 text-xs font-medium" style={{ background: dark ? "#f2f2f2" : "#16171a", color: dark ? "#1a1a1a" : "#fff" }}>
            Start Free Practice
          </span>
          <span className="rounded-md px-3 py-1.5 text-xs" style={{ border: `1px solid ${border}` }}>
            View Plans
          </span>
        </div>
        <div className={cn("mt-4 grid gap-2", device === "mobile" ? "grid-cols-1" : "grid-cols-3")}>
          {["Mock Tests", "Previous Year Papers", "AI Explanations"].map((t) => (
            <div key={t} className="rounded-lg p-3 text-xs" style={{ background: card, border: `1px solid ${border}` }}>
              <span className="font-medium">{t}</span>
              <p className="mt-1" style={{ color: muted }}>
                Card text stays fully readable.
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function BackgroundEffectsForm({ initial, canManage }: { initial: BackgroundEffectsConfig; canManage: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [previewTheme, setPreviewTheme] = useState<"dark" | "light">("dark");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [replayKey, setReplayKey] = useState(0);
  // Remounts the custom-color inputs after Save / Reset so they show the stored value.
  const [formKey, setFormKey] = useState(0);
  const [isPending, startTransition] = useTransition();

  const locked = !canManage || isPending;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const s = draft.designs[draft.design];

  const update = (patch: Partial<BackgroundEffectsConfig>) => {
    setMessage(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  // Only the selected design's settings change; the other three are untouched.
  const updateDesign = (patch: Partial<BgDesignSettings>) => {
    setMessage(null);
    setDraft((d) => ({ ...d, designs: { ...d.designs, [d.design]: { ...d.designs[d.design], ...patch } } }));
  };

  const save = () => {
    startTransition(async () => {
      try {
        const result = await saveBackgroundEffectsAction(draft);
        if (!result.ok) {
          setMessage({ kind: "error", text: result.error });
          return;
        }
        setSaved(result.config);
        setDraft(result.config);
        setFormKey((k) => k + 1);
        setMessage({
          kind: "success",
          text: result.config.enabled ? "Saved. Visitors see the new background within a few seconds." : "Saved. Background Effects are OFF on the website.",
        });
      } catch {
        setMessage({ kind: "error", text: "Couldn't save — check your connection or permissions and try again." });
      }
    });
  };

  const reset = () => {
    setDraft(defaultBackgroundEffectsConfig());
    setFormKey((k) => k + 1);
    setMessage({ kind: "success", text: "Defaults loaded (Background Effects OFF). Press Save Changes to apply them." });
  };

  return (
    <div className="flex flex-col gap-8" data-testid="bg-effects-form">
      <section className="rounded-[var(--radius-card)] border border-[var(--color-border)] px-4">
        <ToggleRow
          id="bg-enabled"
          label="Enable Background Effects"
          hint="Master switch. OFF draws nothing and loads nothing — the website looks exactly as before."
          checked={draft.enabled}
          onChange={(v) => update({ enabled: v })}
          disabled={locked}
        />
      </section>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col gap-8" key={formKey}>
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Background Design</h3>
            <div role="radiogroup" aria-label="Background Design" className="grid gap-2 sm:grid-cols-2">
              {BG_DESIGNS.map((d) => (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={draft.design === d}
                  data-design={d}
                  disabled={locked}
                  onClick={() => update({ design: d })}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-[var(--radius-card)] border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    draft.design === d ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10" : "border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                  )}
                >
                  <span className="text-sm font-medium text-[var(--color-foreground)]">{BG_DESIGN_LABELS[d]}</span>
                  <span className="text-xs text-[var(--color-muted-foreground)]">{DESIGN_HINTS[d]}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-[var(--color-muted-foreground)]">Each design keeps its own settings below; switching designs never changes another design.</p>
          </section>

          <section className="flex flex-col gap-5">
            <Segmented label="Apply To" testId="bg-scope" options={BG_SCOPES} labels={BG_SCOPE_LABELS} value={draft.scope} onChange={(v) => update({ scope: v })} disabled={locked} />
            <p className="-mt-3 text-xs text-[var(--color-muted-foreground)]">
              Never shown on the Test Player, results and review, OMR, payment checkout, Live CBT or the Admin Panel.
            </p>
            <Segmented label="Theme Behavior" testId="bg-theme" options={BG_THEME_MODES} labels={BG_THEME_LABELS} value={draft.theme} onChange={(v) => update({ theme: v })} disabled={locked} />
          </section>

          <section className="flex flex-col gap-5" data-testid="bg-design-settings" data-design={draft.design}>
            <h3 className="text-sm font-semibold text-[var(--color-foreground)]">{BG_DESIGN_LABELS[draft.design]} — Settings</h3>
            <ColorChoice
              key={`dot-${draft.design}`}
              id="bg-dot-color"
              label={draft.design === "GALAXY" ? "Particle Color" : "Dot Color"}
              options={BG_DOT_COLORS}
              labels={BG_DOT_COLOR_LABELS}
              value={s.dotColor}
              custom={s.dotCustomColor}
              onChange={(v) => updateDesign({ dotColor: v })}
              onCustom={(hex) => updateDesign({ dotCustomColor: hex })}
              disabled={locked}
            />
            <Segmented label={draft.design === "GALAXY" ? "Particle Size" : "Dot Size"} testId="bg-dot-size" options={BG_SIZES} labels={BG_SIZE_LABELS} value={s.dotSize} onChange={(v) => updateDesign({ dotSize: v })} disabled={locked} />
            <Slider id="bg-spacing" label="Dot Spacing" value={s.dotSpacing} min={BG_LIMITS.dotSpacing.min} max={BG_LIMITS.dotSpacing.max} suffix="px" onChange={(v) => updateDesign({ dotSpacing: v })} disabled={locked} />
            <Slider id="bg-opacity" label="Background Opacity" value={s.opacity} min={BG_LIMITS.opacity.min} max={BG_LIMITS.opacity.max} suffix="%" onChange={(v) => updateDesign({ opacity: v })} disabled={locked} />
            {HAS_WATERMARK[draft.design] ? (
              <div className="flex flex-wrap gap-6">
                <Segmented label="Watermark Position" testId="bg-wm-position" options={BG_POSITIONS} labels={BG_POSITION_LABELS} value={s.watermarkPosition} onChange={(v) => updateDesign({ watermarkPosition: v })} disabled={locked} />
                <Segmented label="Watermark Scale" testId="bg-wm-scale" options={BG_SIZES} labels={BG_SIZE_LABELS} value={s.watermarkScale} onChange={(v) => updateDesign({ watermarkScale: v })} disabled={locked} />
              </div>
            ) : null}
            {draft.design === "GALAXY" ? (
              <div className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-border)] px-4 pb-4">
                <ToggleRow
                  id="bg-galaxy-animate"
                  label="Galaxy Formation Animation"
                  hint="Plays once per page view, then stops. OFF shows the finished wordmark with no JavaScript."
                  checked={s.galaxyAnimate}
                  onChange={(v) => updateDesign({ galaxyAnimate: v })}
                  disabled={locked}
                />
                <Slider id="bg-galaxy-duration" label="Galaxy Animation Duration" value={s.galaxyDuration} min={BG_LIMITS.galaxyDuration.min} max={BG_LIMITS.galaxyDuration.max} step={0.5} suffix="s" onChange={(v) => updateDesign({ galaxyDuration: v })} disabled={locked} />
                <Slider id="bg-galaxy-particles" label="Galaxy Particle Count (desktop)" value={s.galaxyParticles} min={BG_LIMITS.galaxyParticles.min} max={BG_LIMITS.galaxyParticles.max} step={10} suffix="" onChange={(v) => updateDesign({ galaxyParticles: v })} disabled={locked} />
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  Upper limits: phones draw at most {Math.min(BG_GALAXY_MOBILE_MAX, s.galaxyParticles)}. Fewer are used when the wordmark needs fewer.
                </p>
              </div>
            ) : null}
          </section>

          <section className="flex flex-col gap-5" data-testid="bg-glow-settings">
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] px-4">
              <ToggleRow id="bg-glow" label={`Enable Glow — ${BG_GLOW_LABELS[draft.design]}`} hint="Separate from the button Glow Effects in Settings." checked={s.glowEnabled} onChange={(v) => updateDesign({ glowEnabled: v })} disabled={locked} />
            </div>
            <div className={cn("flex flex-col gap-5", !s.glowEnabled && "opacity-60")}>
              <ColorChoice
                key={`glow-${draft.design}`}
                id="bg-glow-color"
                label="Glow Color"
                options={BG_GLOW_COLORS}
                labels={BG_GLOW_COLOR_LABELS}
                value={s.glowColor}
                custom={s.glowCustomColor}
                onChange={(v) => updateDesign({ glowColor: v })}
                onCustom={(hex) => updateDesign({ glowCustomColor: hex })}
                disabled={locked}
              />
              <Slider id="bg-glow-intensity" label="Glow Intensity" value={s.glowIntensity} min={BG_LIMITS.glowIntensity.min} max={BG_LIMITS.glowIntensity.max} suffix="%" onChange={(v) => updateDesign({ glowIntensity: v })} disabled={locked} />
              <Segmented label="Glow Spread" testId="bg-glow-spread" options={BG_SPREADS} labels={BG_SPREAD_LABELS} value={s.glowSpread} onChange={(v) => updateDesign({ glowSpread: v })} disabled={locked} />
              <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] px-4">
                <ToggleRow
                  id="bg-glow-animation"
                  label="Enable Glow Animation"
                  hint={draft.design === "GALAXY" ? "Particle trails while the wordmark forms." : "A slow, gentle breathing glow. Never flashes; still for reduced-motion visitors."}
                  checked={s.glowAnimation}
                  onChange={(v) => updateDesign({ glowAnimation: v })}
                  disabled={locked}
                />
              </div>
            </div>
          </section>
        </div>

        <section className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-4 xl:self-start">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Live Preview</h3>
            <div className="flex flex-wrap items-center gap-2">
              <div role="radiogroup" aria-label="Preview theme" className="inline-flex rounded-[var(--radius-button)] border border-[var(--color-border)] p-0.5">
                {(["dark", "light"] as const).map((t) => (
                  <button key={t} type="button" role="radio" aria-checked={previewTheme === t} aria-label={t === "dark" ? "Dark preview" : "Light preview"} data-testid={`bg-preview-${t}`} onClick={() => setPreviewTheme(t)} className={cn("rounded-[calc(var(--radius-button)-2px)] p-1.5", previewTheme === t ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted-foreground)]")}>
                    {t === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                  </button>
                ))}
              </div>
              <div role="radiogroup" aria-label="Preview device" className="inline-flex rounded-[var(--radius-button)] border border-[var(--color-border)] p-0.5">
                {(["desktop", "mobile"] as const).map((d) => (
                  <button key={d} type="button" role="radio" aria-checked={device === d} aria-label={d === "desktop" ? "Desktop preview" : "Mobile preview"} data-testid={`bg-preview-${d}`} onClick={() => setDevice(d)} className={cn("rounded-[calc(var(--radius-button)-2px)] p-1.5", device === d ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted-foreground)]")}>
                    {d === "desktop" ? <Monitor className="h-4 w-4" /> : <Smartphone className="h-4 w-4" />}
                  </button>
                ))}
              </div>
              {draft.design === "GALAXY" ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setReplayKey((k) => k + 1)} data-testid="bg-replay">
                  <RotateCcw className="h-3.5 w-3.5" /> Replay Animation
                </Button>
              ) : null}
            </div>
          </div>
          <PreviewFrame config={draft} theme={previewTheme} device={device} replayKey={replayKey} />
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {draft.enabled ? "" : "Background Effects are OFF — the website shows none of this until you turn them on and save. "}
            The preview uses the same renderer as the website and shows unsaved changes only here.
          </p>
        </section>
      </div>

      <div className="flex flex-col-reverse gap-3 border-t border-[var(--color-border)] pt-5 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={reset} disabled={locked}>
          Reset to Defaults
        </Button>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          {message ? (
            <span role="status" className={cn("text-sm", message.kind === "success" ? "text-[var(--color-success)]" : "text-[var(--color-error)]")}>
              {message.text}
            </span>
          ) : dirty && canManage ? (
            <span className="text-sm text-[var(--color-muted-foreground)]">Unsaved changes</span>
          ) : null}
          <Button type="button" onClick={save} disabled={locked || !dirty} data-testid="bg-save">
            {isPending ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
