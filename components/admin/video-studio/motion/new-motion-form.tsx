"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { searchVideoQuestionsAction, type QuestionHit } from "@/app/admin/(dashboard)/video-studio/actions";
import { createMotionJobAction } from "@/app/admin/(dashboard)/video-studio/motion/actions";
import { MotionFramePreview } from "@/components/admin/video-studio/motion/frame-preview";
import { ASPECTS, AUDIENCES, LANGUAGES } from "@/lib/video-studio/types";
import { MOTION_STYLES } from "@/lib/video-studio/motion/styles";
import { DEFAULT_STYLE, MOTION_LIMITS, MOTION_VIDEO_TYPES, estimateTiming, type MotionVideoType } from "@/lib/video-studio/motion/storyboard";
import { cn } from "@/lib/utils";

const SAMPLE = "Troponin I सबसे specific cardiac marker है।";
const sampleTiming = estimateTiming([SAMPLE], "hinglish", 4, "estimated");
const sampleWords = sampleTiming.words.map((w) => ({ text: w.text, start: w.start, end: w.end }));

/** Step 0 of the motion workflow: input, the locked style and the basic settings. Free — nothing paid starts here. */
export function NewMotionForm({ exams, wordmark }: { exams: { id: string; name: string }[]; wordmark: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [videoType, setVideoType] = useState<MotionVideoType>("medical_explainer");
  const [styleKey, setStyleKey] = useState(DEFAULT_STYLE.medical_explainer);
  const [styleTouched, setStyleTouched] = useState(false);
  const [aspect, setAspect] = useState("9:16");
  const [language, setLanguage] = useState("hinglish");
  const [audience, setAudience] = useState("neet_pg");
  const [targetSec, setTargetSec] = useState(40);
  const [topic, setTopic] = useState("");
  const [brief, setBrief] = useState("");
  const [examId, setExamId] = useState("");
  const [cta, setCta] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<QuestionHit[] | null>(null);
  const [picked, setPicked] = useState<QuestionHit[]>([]);
  const [searching, startSearch] = useTransition();

  function pickType(t: MotionVideoType) {
    setVideoType(t);
    if (!styleTouched) setStyleKey(DEFAULT_STYLE[t]);
  }

  function submit() {
    setError(null);
    start(async () => {
      const r = await createMotionJobAction({ videoType, styleKey, aspect, language, audience, targetSec, topic, brief, examId: examId || null, cta, questionIds: picked.map((p) => p.id) });
      if (r.ok) router.push(`/admin/video-studio/motion/${r.data.id}`);
      else setError(r.error);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>1 · Input or topic</CardTitle>
          <CardDescription>What the video teaches. A Question Bank question can be the “boss” frame; its stem, options and answer are always shown exactly as stored.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mw-type">Video type</Label>
            <SelectNative id="mw-type" value={videoType} onChange={(e) => pickType(e.target.value as MotionVideoType)} data-testid="mw-type">
              {MOTION_VIDEO_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mw-topic">Topic</Label>
            <Input id="mw-topic" maxLength={200} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Cardiac markers after myocardial infarction" data-testid="mw-topic" />
          </div>
          <div className="flex flex-col gap-1.5 md:col-span-2">
            <Label htmlFor="mw-brief">Brief (optional)</Label>
            <Textarea id="mw-brief" rows={3} maxLength={2000} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What must the viewer remember? Any facts, product details or wording to use." />
          </div>
          <div className="flex flex-col gap-2 md:col-span-2">
            <Label htmlFor="mw-q">Question Bank question (optional, up to 3)</Label>
            <div className="flex flex-wrap gap-2">
              <SelectNative aria-label="Exam" value={examId} onChange={(e) => setExamId(e.target.value)} className="max-w-[220px]">
                <option value="">No exam label</option>
                {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </SelectNative>
              <Input id="mw-q" className="min-w-0 flex-1" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), startSearch(async () => { const r = await searchVideoQuestionsAction({ examId: examId || null, q }); if (r.ok) setHits(r.data); else setError(r.error); }))} placeholder="Code or words from the question" />
              <Button type="button" variant="outline" disabled={searching} onClick={() => startSearch(async () => { const r = await searchVideoQuestionsAction({ examId: examId || null, q }); if (r.ok) setHits(r.data); else setError(r.error); })} data-testid="mw-search">
                <Search className="h-4 w-4" aria-hidden /> Search
              </Button>
            </div>
            {hits ? (
              <ul className="max-h-56 divide-y divide-[var(--color-border)] overflow-auto rounded-[var(--radius-card)] border border-[var(--color-border)]" data-testid="mw-hits">
                {hits.length ? hits.map((h) => {
                  const on = picked.some((p) => p.id === h.id);
                  return (
                    <li key={h.id} className="flex items-start gap-3 p-2 text-sm">
                      <input type="checkbox" className="mt-1" aria-label={`Select ${h.code}`} checked={on} disabled={!on && picked.length >= 3} onChange={() => setPicked((c) => (on ? c.filter((p) => p.id !== h.id) : [...c, h]))} />
                      <div className="min-w-0">
                        <p className="text-xs text-[var(--color-muted-foreground)]">{h.code} · {h.exam}{!h.hasAnswer ? <span className="text-[var(--color-warning)]"> · no stored answer (no reveal)</span> : null}</p>
                        <p className="line-clamp-2">{h.text}</p>
                      </div>
                    </li>
                  );
                }) : <li className="p-2 text-xs text-[var(--color-muted-foreground)]">No published questions match.</li>}
              </ul>
            ) : null}
            {picked.length ? (
              <div className="flex flex-wrap gap-1.5">
                {picked.map((p) => (
                  <span key={p.id} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs">
                    {p.code}
                    <button type="button" aria-label={`Remove ${p.code}`} onClick={() => setPicked((c) => c.filter((x) => x.id !== p.id))}><X className="h-3 w-3" aria-hidden /></button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2 · Pick one style. Only one.</CardTitle>
          <CardDescription>The style is locked for every frame — layout, motion set, transition and highlight — so the video looks planned. You can switch it later; the frames keep their content.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Motion style">
            {MOTION_STYLES.map((s) => (
              <button
                key={s.key}
                type="button"
                role="radio"
                aria-checked={styleKey === s.key}
                data-style={s.key}
                onClick={() => { setStyleKey(s.key); setStyleTouched(true); }}
                className={cn("flex gap-3 rounded-[var(--radius-card)] border p-3 text-left", styleKey === s.key ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10" : "border-[var(--color-border)] hover:bg-[var(--color-foreground)]/5")}
              >
                <MotionFramePreview
                  frame={{ sentence: SAMPLE, onScreen: "Troponin I: most specific", visual: { kind: "motion", type: "statement", motion: s.motions[0], highlight: "Troponin", tag: s.tagHint ? s.tagHint.split(" / ")[0] : null } }}
                  styleKey={s.key}
                  aspect="9:16"
                  index={0}
                  all={[{ onScreen: "Troponin I: most specific", tag: null }, { onScreen: "CK-MB: reinfarction", tag: null }, { onScreen: "Myoglobin: earliest", tag: null }]}
                  durationSec={4}
                  words={sampleWords}
                  subtitles
                  brand={{ wordmark, examLabel: null, showBranding: true, cta: "" }}
                  width={84}
                  replay={false}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{s.name}</span>
                  <span className="block text-xs text-[var(--color-muted-foreground)]">{s.job}</span>
                  {s.status === "needs_images" ? <span className="mt-1 block text-xs text-[var(--color-warning)]">Needs your uploaded images</span> : null}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3 · Format</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1.5 text-sm">Aspect ratio
            <SelectNative value={aspect} onChange={(e) => setAspect(e.target.value)}>{ASPECTS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}</SelectNative>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">Language
            <SelectNative value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGUAGES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</SelectNative>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">Audience
            <SelectNative value={audience} onChange={(e) => setAudience(e.target.value)}>{AUDIENCES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}</SelectNative>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">Length (seconds)
            <Input type="number" min={MOTION_LIMITS.minSec} max={MOTION_LIMITS.maxSec} value={targetSec} onChange={(e) => setTargetSec(Number(e.target.value))} data-testid="mw-length" />
          </label>
          <label className="flex flex-col gap-1.5 text-sm sm:col-span-2">Call to action (last frame)
            <Input maxLength={80} value={cta} onChange={(e) => setCta(e.target.value)} placeholder="Default from Settings & Branding" />
          </label>
        </CardContent>
      </Card>

      {error ? <p role="alert" className="text-sm text-[var(--color-error)]" data-testid="mw-error">{error}</p> : null}
      <div>
        <Button type="button" size="lg" disabled={pending} onClick={submit} data-testid="mw-create">
          {pending ? "Creating…" : "Create motion video (free)"}
        </Button>
      </div>
    </div>
  );
}
