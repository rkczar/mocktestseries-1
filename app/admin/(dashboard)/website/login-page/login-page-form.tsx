"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SelectNative } from "@/components/ui/select-native";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import type { LoginPageConfig } from "@/lib/login-page";
import { saveLoginPageConfigAction, type LoginPageFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save Login Page Design"}</Button>;
}

interface Draft {
  splitLayout: boolean;
  leftPanelEnabled: boolean;
  rightPanelWidth: number;
  cardWidth: number;
  cardRadius: string;
  mobileBehavior: "stack" | "hide-left";
  contentAlignment: "left" | "center";
  canvasBg: string;
  panelBg: string;
  borderColor: string;
  ambient: boolean;
  buttonRadius: string;
  showLogo: boolean;
  loginTitle: string;
  subtitle: string;
  leftCanvasEnabled: boolean;
  leftCanvasMode: "blank" | "content";
  leftCanvasBg: string;
  leftCanvasAmbient: boolean;
  leftHeading: string;
  leftSubheading: string;
  leftText: string;
  showGoogle: boolean;
  showOtp: boolean;
  showPassword: boolean;
  showCreateAccount: boolean;
}

function toDraft(config: LoginPageConfig): Draft {
  return {
    splitLayout: config.splitLayout,
    leftPanelEnabled: config.leftPanelEnabled,
    rightPanelWidth: config.rightPanelWidth,
    cardWidth: config.cardWidth,
    cardRadius: config.cardRadius,
    mobileBehavior: config.mobileBehavior,
    contentAlignment: config.contentAlignment,
    canvasBg: config.background.canvas,
    panelBg: config.background.panel,
    borderColor: config.background.border,
    ambient: config.background.ambient,
    buttonRadius: config.buttons.radius ?? "0.5rem",
    showLogo: config.branding.showLogo,
    loginTitle: config.branding.loginTitle,
    subtitle: config.branding.subtitle,
    leftCanvasEnabled: config.leftCanvas.enabled,
    leftCanvasMode: config.leftCanvas.mode,
    leftCanvasBg: config.leftCanvas.backgroundColor ?? "",
    leftCanvasAmbient: config.leftCanvas.ambient,
    leftHeading: config.leftCanvas.content.heading ?? "",
    leftSubheading: config.leftCanvas.content.subheading ?? "",
    leftText: config.leftCanvas.content.text ?? "",
    showGoogle: true,
    showOtp: true,
    showPassword: true,
    showCreateAccount: true,
  };
}

function LivePreview({ d }: { d: Draft }) {
  const showLeft = d.splitLayout && d.leftPanelEnabled;
  const leftHasContent = d.leftCanvasEnabled && d.leftCanvasMode === "content";

  return (
    <div
      className="relative flex h-[420px] w-full overflow-hidden rounded-[var(--radius-card)] border"
      style={{ background: d.canvasBg, borderColor: d.borderColor }}
    >
      {showLeft ? (
        <div
          className="hidden flex-1 items-center justify-center p-6 sm:flex"
          style={{ background: d.leftCanvasBg || d.canvasBg }}
        >
          {leftHasContent ? (
            <div className="max-w-xs text-left text-white/90">
              {d.leftHeading ? <p className="text-lg font-semibold">{d.leftHeading}</p> : null}
              {d.leftSubheading ? <p className="mt-1 text-sm text-white/60">{d.leftSubheading}</p> : null}
              {d.leftText ? <p className="mt-3 text-xs text-white/50">{d.leftText}</p> : null}
            </div>
          ) : (
            <p className="text-xs uppercase tracking-wide text-white/20">Blank canvas</p>
          )}
        </div>
      ) : null}

      <div
        className="flex flex-col items-center justify-center gap-4 p-6"
        style={{ width: showLeft ? d.rightPanelWidth : "100%", background: d.panelBg }}
      >
        <div
          className="flex w-full flex-col items-center gap-4 rounded-2xl border p-5"
          style={{ maxWidth: d.cardWidth, borderColor: d.borderColor, borderRadius: d.cardRadius, background: "rgba(255,255,255,0.02)" }}
        >
          {d.showLogo ? (
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500 text-white">
              <GraduationCap className="h-4 w-4" aria-hidden />
            </div>
          ) : null}
          <div className="text-center">
            <p className="text-sm font-semibold text-white">{d.loginTitle}</p>
            <p className="text-xs text-white/50">{d.subtitle}</p>
          </div>

          {d.showGoogle ? (
            <div className="w-full rounded-md border border-white/15 py-2 text-center text-xs text-white/80">
              Continue with Google
            </div>
          ) : null}

          <div className="flex w-full items-center gap-2 text-[10px] text-white/30">
            <span className="h-px flex-1 bg-white/15" />
            OR
            <span className="h-px flex-1 bg-white/15" />
          </div>

          <div className="flex w-full gap-2 text-[10px]">
            {d.showPassword ? (
              <span className="flex-1 rounded-md bg-indigo-500/20 py-1.5 text-center text-indigo-200">User ID / Password</span>
            ) : null}
            {d.showOtp ? (
              <span className="flex-1 rounded-md border border-white/15 py-1.5 text-center text-white/60">Phone OTP</span>
            ) : null}
          </div>

          <div className="w-full space-y-1.5">
            <span className="block h-7 w-full rounded-md border border-white/10" />
            <span className="block h-7 w-full rounded-md border border-white/10" />
          </div>
          <div className="w-full rounded-md py-2 text-center text-xs font-medium text-white" style={{ background: "#6366f1" }}>
            Sign In
          </div>

          {d.showCreateAccount ? <p className="text-[10px] text-white/40">New User? Create Account</p> : null}
        </div>
      </div>
    </div>
  );
}

export function LoginPageForm({ config }: { config: LoginPageConfig }) {
  const [state, formAction] = useActionState<LoginPageFormState, FormData>(saveLoginPageConfigAction, {});
  const [draft, setDraft] = useState<Draft>(() => toDraft(config));

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_1.1fr]">
      <form action={formAction} className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Layout</CardTitle>
            <CardDescription>Desktop split layout and mobile behavior.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ToggleRow label="Split layout" name="splitLayout" checked={draft.splitLayout} onChange={(v) => set("splitLayout", v)} />
            <ToggleRow
              label="Left panel visible"
              name="leftPanelEnabled"
              checked={draft.leftPanelEnabled}
              onChange={(v) => set("leftPanelEnabled", v)}
            />
            <div className="grid grid-cols-2 gap-4">
              <NumberField
                id="rightPanelWidth"
                label="Right panel width (px)"
                value={draft.rightPanelWidth}
                onChange={(v) => set("rightPanelWidth", v)}
              />
              <NumberField id="cardWidth" label="Login card width (px)" value={draft.cardWidth} onChange={(v) => set("cardWidth", v)} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mobileBehavior">Mobile behavior</Label>
                <SelectNative
                  id="mobileBehavior"
                  name="mobileBehavior"
                  value={draft.mobileBehavior}
                  onChange={(e) => set("mobileBehavior", e.target.value as Draft["mobileBehavior"])}
                >
                  <option value="stack">Stack (left canvas above)</option>
                  <option value="hide-left">Hide left canvas</option>
                </SelectNative>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="contentAlignment">Content alignment</Label>
                <SelectNative id="contentAlignment" name="contentAlignment" defaultValue={config.contentAlignment}>
                  <option value="center">Center</option>
                  <option value="left">Left</option>
                </SelectNative>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cardRadius">Login card radius</Label>
              <Input id="cardRadius" name="cardRadius" value={draft.cardRadius} onChange={(e) => set("cardRadius", e.target.value)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Background</CardTitle>
            <CardDescription>Dark canvas tokens — independent of the site&apos;s day/night theme.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-4">
              <ColorField id="canvasBg" name="canvasBg" label="Canvas" value={draft.canvasBg} onChange={(v) => set("canvasBg", v)} />
              <ColorField id="panelBg" name="panelBg" label="Panel" value={draft.panelBg} onChange={(v) => set("panelBg", v)} />
              <ColorField id="borderColor" name="borderColor" label="Border" value={draft.borderColor} onChange={(v) => set("borderColor", v)} />
            </div>
            <ToggleRow label="Ambient gradient" name="ambient" checked={draft.ambient} onChange={(v) => set("ambient", v)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Branding</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ToggleRow label="Show logo" name="showLogo" checked={draft.showLogo} onChange={(v) => set("showLogo", v)} />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              The site wordmark is fixed (MockTestSeries.in™) and isn&apos;t editable here.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="loginTitle">Login title</Label>
              <Input id="loginTitle" name="loginTitle" value={draft.loginTitle} onChange={(e) => set("loginTitle", e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="subtitle">Subtitle</Label>
              <Input id="subtitle" name="subtitle" value={draft.subtitle} onChange={(e) => set("subtitle", e.target.value)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Buttons</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="buttonRadius">Primary button radius</Label>
              <Input id="buttonRadius" name="buttonRadius" value={draft.buttonRadius} onChange={(e) => set("buttonRadius", e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="buttonHeight">Primary button height</Label>
              <Input id="buttonHeight" name="buttonHeight" defaultValue={config.buttons.height ?? ""} placeholder="2.75rem" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Left Canvas</CardTitle>
            <CardDescription>Defaults to blank. Only shows content once configured below.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ToggleRow
              label="Left canvas enabled"
              name="leftCanvasEnabled"
              checked={draft.leftCanvasEnabled}
              onChange={(v) => set("leftCanvasEnabled", v)}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="leftCanvasMode">Content mode</Label>
              <SelectNative
                id="leftCanvasMode"
                name="leftCanvasMode"
                value={draft.leftCanvasMode}
                onChange={(e) => set("leftCanvasMode", e.target.value as Draft["leftCanvasMode"])}
              >
                <option value="blank">Blank</option>
                <option value="content">Content</option>
              </SelectNative>
            </div>
            <ColorField
              id="leftCanvasBg"
              name="leftCanvasBg"
              label="Left canvas background (optional)"
              value={draft.leftCanvasBg || draft.canvasBg}
              onChange={(v) => set("leftCanvasBg", v)}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="leftCanvasAlignment">Content alignment</Label>
              <SelectNative id="leftCanvasAlignment" name="leftCanvasAlignment" defaultValue={config.leftCanvas.contentAlignment}>
                <option value="left">Left</option>
                <option value="center">Center</option>
              </SelectNative>
            </div>
            <ToggleRow
              label="Ambient effect"
              name="leftCanvasAmbient"
              checked={draft.leftCanvasAmbient}
              onChange={(v) => set("leftCanvasAmbient", v)}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="leftHeading">Heading</Label>
              <Input id="leftHeading" name="leftHeading" value={draft.leftHeading} onChange={(e) => set("leftHeading", e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="leftSubheading">Subheading</Label>
              <Input
                id="leftSubheading"
                name="leftSubheading"
                value={draft.leftSubheading}
                onChange={(e) => set("leftSubheading", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="leftText">Body text</Label>
              <textarea
                id="leftText"
                name="leftText"
                value={draft.leftText}
                onChange={(e) => set("leftText", e.target.value)}
                rows={3}
                className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)]"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="leftImageUrl">Image URL</Label>
              <Input id="leftImageUrl" name="leftImageUrl" defaultValue={config.leftCanvas.content.imageUrl ?? ""} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="leftLogoUrl">Logo/illustration URL</Label>
              <Input id="leftLogoUrl" name="leftLogoUrl" defaultValue={config.leftCanvas.content.logoUrl ?? ""} />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center gap-3">
          <SubmitButton />
          {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
          {state.success ? <p className="text-sm text-[var(--color-success)]">Saved — visible on /login immediately.</p> : null}
        </div>
      </form>

      <div className="sticky top-4 flex flex-col gap-3 self-start">
        <p className="text-sm font-medium text-[var(--color-foreground)]">Live Preview</p>
        <LivePreview d={draft} />
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Reflects unsaved edits. Google / OTP / Password visibility is controlled from Settings → Authentication.
        </p>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  name,
  checked,
  onChange,
}: {
  label: string;
  name: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
      <p className="text-sm font-medium text-[var(--color-foreground)]">{label}</p>
      <Switch name={name} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </div>
  );
}

function ColorField({
  id,
  name,
  label,
  value,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          name={name}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-12 cursor-pointer rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)]"
        />
        <span className="text-xs text-[var(--color-muted-foreground)]">{value}</span>
      </div>
    </div>
  );
}
