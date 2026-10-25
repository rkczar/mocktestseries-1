"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { deleteSkillPresetAction, saveSkillPresetAction } from "@/app/admin/(dashboard)/video-studio/actions";
import { VIDEO_SKILLS, SKILL_MAP, type SkillCategory } from "@/lib/video-studio/skills";

const AVAIL = { ready: { label: "Ready", v: "success" }, editor: { label: "AI Video Editor (later phase)", v: "neutral" }, later: { label: "Not available yet", v: "neutral" } } as const;
const KIND = { prompt: "Instructions", logic: "Built-in check", planner: "Planner" } as const;
const CATS: SkillCategory[] = ["Teaching", "Scripting", "Visual", "Voice & Audio", "Quality", "Editing", "Motion Workflow"];

export function SkillLibrary({ presets, canUse }: { presets: { id: string; name: string; skillKeys: string[]; instructions: string; favorite: boolean }[]; canUse: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  function save() {
    setError(null);
    start(async () => {
      const r = await saveSkillPresetAction({ name, skillKeys: selected, instructions });
      if (!r.ok) setError(r.error);
      else {
        setName("");
        setInstructions("");
        setSelected([]);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-[var(--color-muted-foreground)]">
        Skills are versioned instructions and checks that shape every script. They are not separate AI models: the selected instruction Skills are combined into the one script request your video makes. Required safety Skills cannot be switched off.
      </p>
      {CATS.map((cat) => (
        <section key={cat} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{cat}</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {VIDEO_SKILLS.filter((s) => s.category === cat).map((s) => (
              <Card key={s.key} data-skill={s.key}>
                <CardHeader className="gap-1">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                    {canUse && s.availability === "ready" && !s.module ? (
                      <input type="checkbox" aria-label={`Add ${s.name} to a preset`} checked={selected.includes(s.key)} onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, s.key] : cur.filter((k) => k !== s.key)))} />
                    ) : null}
                    {s.name}
                    <span className="text-xs font-normal text-[var(--color-muted-foreground)]">v{s.version}</span>
                  </CardTitle>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant={AVAIL[s.availability].v}>{AVAIL[s.availability].label}</Badge>
                    <Badge>{KIND[s.kind]}</Badge>
                    {s.required ? <Badge variant="warning">Always on</Badge> : null}
                    {s.module === "motion" ? <Badge variant="info">Motion Workflow Studio</Badge> : null}
                    {s.extends && SKILL_MAP[s.extends] ? <Badge>Builds on {SKILL_MAP[s.extends].name}</Badge> : null}
                  </div>
                  <CardDescription>{s.description}</CardDescription>
                </CardHeader>
                {s.instructions ? (
                  <CardContent>
                    <button type="button" className="text-xs text-[var(--color-primary)] hover:underline" onClick={() => setOpen(open === s.key ? null : s.key)} aria-expanded={open === s.key}>
                      {open === s.key ? "Hide instructions" : "Show instructions"}
                    </button>
                    {open === s.key ? <p className="mt-2 whitespace-pre-wrap rounded-[var(--radius-card)] bg-[var(--color-foreground)]/5 p-2 text-xs">{s.instructions}</p> : null}
                  </CardContent>
                ) : null}
              </Card>
            ))}
          </div>
        </section>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>My Skill presets</CardTitle>
          <CardDescription>Save a favourite combination with your own extra instructions; apply it when you create a video.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {presets.length ? (
            <ul className="flex flex-col gap-2" data-testid="presets">
              {presets.map((p) => (
                <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{p.favorite ? <Star className="mr-1 inline h-3.5 w-3.5" aria-label="Favourite" /> : null}{p.name}</p>
                    <p className="text-xs text-[var(--color-muted-foreground)]">{p.skillKeys.map((k) => SKILL_MAP[k]?.name ?? k).join(" · ")}</p>
                    {p.instructions ? <p className="mt-1 text-xs">{p.instructions}</p> : null}
                  </div>
                  {canUse ? (
                    <div className="flex gap-2">
                      <Button type="button" size="compact" variant="outline" disabled={pending} onClick={() => start(async () => { await saveSkillPresetAction({ id: p.id, name: p.name, skillKeys: p.skillKeys, instructions: p.instructions, favorite: !p.favorite }); router.refresh(); })}>
                        {p.favorite ? "Unfavourite" : "Favourite"}
                      </Button>
                      <Button type="button" size="compact" variant="ghost" disabled={pending} onClick={() => start(async () => { await deleteSkillPresetAction(p.id); router.refresh(); })}>
                        Delete
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">No presets yet.</p>
          )}
          {canUse ? (
            <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-4">
              <p className="text-sm">New preset from the {selected.length} Skill(s) ticked above</p>
              <Input aria-label="Preset name" placeholder="Preset name, e.g. Hinglish MCQ Reel" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              <Textarea aria-label="Extra instructions" rows={3} maxLength={2000} placeholder="Extra instructions (optional)" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
              {error ? <p role="alert" className="text-sm text-[var(--color-error)]">{error}</p> : null}
              <div>
                <Button type="button" onClick={save} disabled={pending || !selected.length || !name.trim()} data-testid="save-preset">Save preset</Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
