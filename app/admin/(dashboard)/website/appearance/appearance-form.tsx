"use client";

import { useActionState, useRef, useState } from "react";
import { flushSync, useFormStatus } from "react-dom";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import type { AppearanceColors, ResolvedAppearance } from "@/lib/appearance";
import { APPEARANCE_PALETTES, colorsMatchPalette, type AppearancePalette } from "@/lib/appearance-palettes";
import { saveAppearanceAction, type AppearanceFormState } from "./actions";

const COLOR_FIELDS: { id: keyof AppearanceColors; label: string }[] = [
  { id: "primary", label: "Primary" },
  { id: "secondary", label: "Secondary" },
  { id: "accent", label: "Accent" },
  { id: "success", label: "Success" },
  { id: "error", label: "Error" },
  { id: "warning", label: "Warning" },
  { id: "info", label: "Info" },
];

function SubmitButton() {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save Appearance"}</Button>;
}

function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          name={id}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-12 cursor-pointer rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)]"
        />
        <span className="text-xs text-[var(--color-muted-foreground)]">{value.toUpperCase()}</span>
      </div>
    </div>
  );
}

/** A small, self-contained mock of the site in the palette's own mode (inline styles — never touches the live tokens). */
function PalettePreview({ palette }: { palette: AppearancePalette }) {
  const st = palette.structural ?? (palette.themeType === "dark"
    ? { background: "#000000", surface: "#141414", card: "#171717", foreground: "#F5F5F5", mutedForeground: "#A3A3A3", border: "#2E2E2E" }
    : { background: "#FBFBFC", surface: "#FFFFFF", card: "#FFFFFF", foreground: "#16171A", mutedForeground: "#61646B", border: "#E6E7EA" });
  const c = palette.colors;
  const actionFill = palette.themeType === "dark" ? "#F2F2F2" : "#16171A";
  const actionInk = palette.themeType === "dark" ? "#1A1A1A" : "#FFFFFF";
  return (
    <div className="rounded-md border p-2.5" style={{ background: st.background, borderColor: st.border }} aria-hidden>
      <div className="rounded-md border p-2" style={{ background: st.card, borderColor: st.border }}>
        <p className="text-[11px] font-semibold" style={{ color: st.foreground }}>
          RUHS MO Mock Test 1
        </p>
        <p className="text-[10px]" style={{ color: st.mutedForeground }}>
          100 questions · 120 min
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="rounded px-2 py-0.5 text-[10px] font-medium" style={{ background: actionFill, color: actionInk }}>
            Start test
          </span>
          <span className="text-[10px] underline" style={{ color: c.primary }}>
            View syllabus
          </span>
        </div>
        <div className="mt-1.5 flex gap-1">
          <span className="rounded px-1.5 text-[9px]" style={{ color: c.success, border: `1px solid ${c.success}` }}>
            Correct
          </span>
          <span className="rounded px-1.5 text-[9px]" style={{ color: c.error, border: `1px solid ${c.error}` }}>
            Wrong
          </span>
        </div>
      </div>
    </div>
  );
}

export function AppearanceForm({ appearance, canManage = true }: { appearance: ResolvedAppearance; canManage?: boolean }) {
  const [state, formAction] = useActionState<AppearanceFormState, FormData>(saveAppearanceAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const [colors, setColors] = useState<AppearanceColors>(appearance.colors);
  const [paletteId, setPaletteId] = useState<string>(appearance.paletteId ?? "");
  // Colors saved before palettes existed that equal the current brand colors count as "Brand Green (default)".
  const [savedPaletteId, setSavedPaletteId] = useState<string | null>(
    appearance.paletteId ?? (colorsMatchPalette(appearance.colors, APPEARANCE_PALETTES[0]) ? APPEARANCE_PALETTES[0].id : null)
  );

  const setColor = (k: keyof AppearanceColors, v: string) => {
    setColors((cur) => ({ ...cur, [k]: v }));
    // A manual edit turns the palette into Custom (the saved palette id is dropped server-side too).
    setPaletteId("");
  };

  const apply = (p: AppearancePalette) => {
    flushSync(() => {
      setColors({ ...p.colors });
      setPaletteId(p.id);
    });
    setSavedPaletteId(p.id);
    formRef.current?.requestSubmit();
  };

  const selected = (p: AppearancePalette) => savedPaletteId === p.id && colorsMatchPalette(colors, p);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-8">
      <input type="hidden" name="paletteId" value={paletteId} />
      <section>
        <h3 className="mb-1 text-sm font-semibold text-[var(--color-foreground)]">Premade palettes</h3>
        <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
          Apply sets the color tokens below and saves them. Visitors keep their own Day / Night / Eye-Saver choice; a palette adapts to each mode so text and buttons stay readable, and decides the
          mode for visitors who have not picked one. Editing any color afterwards makes it a custom palette.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="palette-cards">
          {APPEARANCE_PALETTES.map((p) => {
            const isSel = selected(p);
            return (
              <div
                key={p.id}
                className={`flex flex-col gap-2 rounded-[var(--radius-card)] border p-3 ${isSel ? "border-[var(--color-primary)] ring-1 ring-[var(--color-primary)]" : "border-[var(--color-border)]"}`}
                data-testid={`palette-${p.id}`}
                data-selected={isSel ? "true" : "false"}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{p.name}</p>
                  <Badge variant="neutral">{p.themeType === "dark" ? "Dark" : "Light"}</Badge>
                </div>
                <PalettePreview palette={p} />
                <div className="flex flex-wrap gap-1" aria-label={`${p.name} colors`}>
                  {[...(p.structural ? [p.structural.background, p.structural.surface, p.structural.foreground, p.structural.border] : []), ...Object.values(p.colors)].map((hex, i) => (
                    <span key={i} title={hex} className="h-5 w-5 rounded-full border border-[var(--color-border)]" style={{ background: hex }} />
                  ))}
                </div>
                <p className="text-xs text-[var(--color-muted-foreground)]">{p.description}</p>
                {canManage ? (
                  <Button type="button" size="sm" variant={isSel ? "outline" : "primary"} onClick={() => apply(p)} disabled={isSel} data-testid={`apply-${p.id}`}>
                    {isSel ? (
                      <>
                        <Check className="h-3.5 w-3.5" aria-hidden /> Selected
                      </>
                    ) : (
                      "Apply palette"
                    )}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-[var(--color-foreground)]">
          Colors {paletteId ? null : <span className="ml-1 text-xs font-normal text-[var(--color-muted-foreground)]">(custom)</span>}
        </h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {COLOR_FIELDS.map((f) => (
            <ColorField key={f.id} id={f.id} label={f.label} value={colors[f.id]} onChange={(v) => setColor(f.id, v)} />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-[var(--color-foreground)]">Typography</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="headingFont">Heading font stack</Label>
            <Input id="headingFont" name="headingFont" defaultValue={appearance.fonts.heading} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bodyFont">Body font stack</Label>
            <Input id="bodyFont" name="bodyFont" defaultValue={appearance.fonts.body} />
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-[var(--color-foreground)]">Buttons &amp; Components</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="buttonRadius">Button radius</Label>
            <SelectNative id="buttonRadius" name="buttonRadius" defaultValue={appearance.buttonStyle.radius}>
              <option value="0rem">Square</option>
              <option value="0.375rem">Slightly rounded</option>
              <option value="0.5rem">Rounded</option>
              <option value="1rem">Pill</option>
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cardRadius">Card radius</Label>
            <SelectNative id="cardRadius" name="cardRadius" defaultValue={appearance.componentStyle.cardRadius}>
              <option value="0rem">Square</option>
              <option value="0.5rem">Rounded</option>
              <option value="0.75rem">Soft</option>
              <option value="1.25rem">Extra soft</option>
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="shadowIntensity">Shadow intensity</Label>
            <SelectNative id="shadowIntensity" name="shadowIntensity" defaultValue={appearance.componentStyle.shadowIntensity}>
              <option value="none">None</option>
              <option value="sm">Subtle</option>
              <option value="md">Medium</option>
            </SelectNative>
          </div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <SubmitButton />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]" role="status">Saved — live across the site immediately.</p> : null}
      </div>
    </form>
  );
}
