"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { saveStudioSettingsAction } from "@/app/admin/(dashboard)/instagram/actions";
import type { StudioSettings } from "@/lib/instagram/config";
import { SLIDE_COUNTS, TEMPLATE_KEYS } from "@/lib/instagram/types";

const TEMPLATE_NAMES: Record<string, string> = { midnight: "Midnight Medical (website)", academic: "Clean Academic", clinical: "Clinical Green", premium: "Premium Dark" };

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-[var(--color-muted-foreground)]">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-[var(--color-muted-foreground)]">{hint}</span> : null}
    </label>
  );
}

/** Admin → Instagram → Settings form. Empty text fields fall back to the live website values. */
export function StudioSettingsForm({ settings, stored, exams }: { settings: StudioSettings; stored: Record<string, unknown>; exams: { id: string; name: string }[] }) {
  const router = useRouter();
  const s = (k: string) => (typeof stored[k] === "string" ? (stored[k] as string) : "");
  const [form, setForm] = useState({
    instagramHandle: s("instagramHandle"),
    telegramUrl: s("telegramUrl"),
    telegramName: s("telegramName"),
    websiteUrl: s("websiteUrl"),
    ctaHeadline: s("ctaHeadline"),
    ctaDescription: s("ctaDescription"),
    footerText: s("footerText"),
    showInstagram: settings.showInstagram,
    showTelegram: settings.showTelegram,
    showWebsite: settings.showWebsite,
    showSaveShare: settings.showSaveShare,
    defaultTemplate: settings.defaultTemplate as string,
    defaultSlideCount: String(settings.defaultSlideCount),
    defaultHashtags: settings.defaultHashtags.join(" "),
    examBadges: { ...settings.examBadges } as Record<string, string>,
  });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof form, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const r = await saveStudioSettingsAction({ ...form, defaultHashtags: form.defaultHashtags.split(/\s+/).filter(Boolean), defaultSlideCount: Number(form.defaultSlideCount) });
      setMsg(r.ok ? { ok: true, text: "Settings saved." } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="studio-settings">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Follow / Join slide</CardTitle>
          <CardDescription>Leave a field empty to use the website&apos;s own value (shown as the placeholder).</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-5 pb-5 sm:grid-cols-2">
          <Row label="Instagram handle" hint={settings.instagramSource === "footer" ? "Currently from the homepage footer's Instagram link." : undefined}>
            <Input value={form.instagramHandle} onChange={(e) => set("instagramHandle", e.target.value)} placeholder={settings.instagramSource === "footer" ? settings.instagramHandle : "e.g. mocktestseries.in"} data-testid="set-handle" />
          </Row>
          <Row label="Telegram link" hint={settings.telegramSource === "website" ? "Currently from Website → Telegram." : undefined}>
            <Input value={form.telegramUrl} onChange={(e) => set("telegramUrl", e.target.value)} placeholder={settings.telegramSource === "website" ? settings.telegramUrl : "https://t.me/…"} />
          </Row>
          <Row label="Telegram label">
            <Input value={form.telegramName} onChange={(e) => set("telegramName", e.target.value)} placeholder="Telegram Channel" />
          </Row>
          <Row label="Website URL">
            <Input value={form.websiteUrl} onChange={(e) => set("websiteUrl", e.target.value)} placeholder="https://mocktestseries.in" />
          </Row>
          <Row label="Headline">
            <Input value={form.ctaHeadline} onChange={(e) => set("ctaHeadline", e.target.value)} placeholder="Daily PYQs & Medical MCQs" data-testid="set-headline" />
          </Row>
          <Row label="Description">
            <Input value={form.ctaDescription} onChange={(e) => set("ctaDescription", e.target.value)} placeholder="Follow for one high-yield previous year question every day." />
          </Row>
          <Row label="Website line">
            <Input value={form.footerText} onChange={(e) => set("footerText", e.target.value)} placeholder="Practice full mock tests at" />
          </Row>
          <div className="flex flex-col gap-2 text-sm">
            {(
              [
                ["showInstagram", "Show Instagram follow"],
                ["showTelegram", "Show Telegram join"],
                ["showWebsite", "Show website"],
                ["showSaveShare", "Show Save / Share / Follow row"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={form[k]} onChange={(e) => set(k, e.target.checked)} />
                {label}
              </label>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Defaults for new drafts</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 px-5 pb-5 sm:grid-cols-3">
          <Row label="Template">
            <SelectNative value={form.defaultTemplate} onChange={(e) => set("defaultTemplate", e.target.value)}>
              {TEMPLATE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {TEMPLATE_NAMES[k]}
                </option>
              ))}
            </SelectNative>
          </Row>
          <Row label="Slides">
            <SelectNative value={form.defaultSlideCount} onChange={(e) => set("defaultSlideCount", e.target.value)}>
              {SLIDE_COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </SelectNative>
          </Row>
          <Row label="Default hashtags" hint="Space-separated, added to every new draft.">
            <Input value={form.defaultHashtags} onChange={(e) => set("defaultHashtags", e.target.value)} placeholder="#MockTestSeries #MedicalPG" />
          </Row>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Exam badge text</CardTitle>
          <CardDescription>The green badge on every slide. Empty = the exam&apos;s name.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-3">
          {exams.map((e) => (
            <Row key={e.id} label={e.name}>
              <Input value={form.examBadges[e.id] ?? ""} onChange={(ev) => set("examBadges", { ...form.examBadges, [e.id]: ev.target.value })} placeholder={e.name} />
            </Row>
          ))}
        </CardContent>
      </Card>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending} data-testid="settings-save">
          Save settings
        </Button>
        {msg ? (
          <span role="status" data-testid="settings-message" className={msg.ok ? "text-sm text-[var(--color-success)]" : "text-sm text-[var(--color-error)]"}>
            {msg.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}
