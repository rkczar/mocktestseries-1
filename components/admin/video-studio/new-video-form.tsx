"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { createVideoJobAction, searchVideoQuestionsAction, type QuestionHit } from "@/app/admin/(dashboard)/video-studio/actions";
import { ASPECTS, AUDIENCES, DURATION_LIMITS, LANGUAGES, VIDEO_TYPES, type SourceType, type VideoType } from "@/lib/video-studio/types";
import { cn } from "@/lib/utils";
import { DESIGN_MAP } from "@/lib/video-studio/designs";

const SOURCES: { key: SourceType; label: string; hint: string }[] = [
  { key: "topic", label: "Topic", hint: "e.g. “Cardiac markers in MI”" },
  { key: "prompt", label: "Prompt", hint: "Describe the video in your own words" },
  { key: "questions", label: "Question Bank", hint: "Explain published MCQs (answers come from the Question Bank)" },
  { key: "pdf", label: "PDF", hint: "Notes or a chapter — upload it on the next page" },
  { key: "image", label: "Images", hint: "Screenshots, ECGs, X-rays — upload them on the next page" },
];

const QUESTION_TYPES: VideoType[] = ["explain_mcq", "question_paper", "exam_revision"];

export function NewVideoForm({ exams, designKey }: { exams: { id: string; name: string }[]; designKey: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<SourceType>("topic");
  const [videoType, setVideoType] = useState<VideoType>("teach_topic");
  const [audience, setAudience] = useState("neet_pg");
  const [language, setLanguage] = useState("hinglish");
  const [aspect, setAspect] = useState("9:16");
  const [duration, setDuration] = useState("");
  const [examId, setExamId] = useState("");
  const [topic, setTopic] = useState("");
  const [prompt, setPrompt] = useState("");
  const [custom, setCustom] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<QuestionHit[] | null>(null);
  const [picked, setPicked] = useState<QuestionHit[]>([]);
  const [searching, startSearch] = useTransition();

  const types = VIDEO_TYPES.filter((t) => (type === "questions" ? QUESTION_TYPES.includes(t.key) : type === "pdf" || type === "image" ? t.needs === type : t.needs === "topic" || t.needs === "prompt"));

  function pickSource(next: SourceType) {
    setType(next);
    setError(null);
    if (next === "questions" && !QUESTION_TYPES.includes(videoType)) setVideoType("explain_mcq");
    if (next === "pdf") setVideoType("pdf_to_video");
    else if (next === "image") setVideoType("image_to_video");
    else if (next !== "questions" && ["questions", "pdf", "image"].includes(VIDEO_TYPES.find((t) => t.key === videoType)?.needs ?? "")) setVideoType("teach_topic");
  }

  function search() {
    startSearch(async () => {
      const r = await searchVideoQuestionsAction({ examId: examId || null, q });
      if (r.ok) setHits(r.data);
      else setError(r.error);
    });
  }

  function submit() {
    setError(null);
    start(async () => {
      const r = await createVideoJobAction({
        source: {
          type,
          videoType,
          audience,
          language,
          aspect,
          durationSec: duration ? Number(duration) : 0,
          topic,
          prompt,
          questionIds: picked.map((p) => p.id),
          examId: type === "questions" ? null : examId || null,
        },
        customPrompt: custom,
        designKey,
        // PDF / image sources: create the job, upload on its page, then Auto Configure there.
        configure: type !== "pdf" && type !== "image",
      });
      if (r.ok) router.push(`/admin/video-studio/jobs/${r.data.id}`);
      else setError(r.error);
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardHeader>
          <CardTitle>Create Video</CardTitle>
          {designKey ? <p className="text-xs text-[var(--color-primary)]" data-testid="preselected-design">Design pre-selected from the gallery: {DESIGN_MAP[designKey]?.name}</p> : null}
          <CardDescription>Choose a source and basic preferences. Auto Configure then proposes everything else — it is free and nothing paid starts until you confirm the price.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Source</legend>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Source">
              {SOURCES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  role="radio"
                  aria-checked={type === s.key}
                  data-testid={`source-${s.key}`}
                  onClick={() => pickSource(s.key)}
                  className={cn(
                    "rounded-[var(--radius-button)] border px-3 py-2 text-left text-sm",
                    type === s.key ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10" : "border-[var(--color-border)] hover:bg-[var(--color-foreground)]/5"
                  )}
                >
                  <span className="block font-medium">{s.label}</span>
                  <span className="block text-xs text-[var(--color-muted-foreground)]">{s.hint}</span>
                </button>
              ))}
            </div>
            {type === "pdf" || type === "image" ? <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="upload-next">The next page asks for the {type === "pdf" ? "PDF (choose the pages to use)" : "images"}; Auto Configure runs after the upload. Uploaded files are checked by their content and kept only for the retention period.</p> : null}
          </fieldset>

          {type === "topic" || type === "pdf" || type === "image" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vs-topic">{type === "topic" ? "Topic" : "Focus (optional)"}</Label>
              <Input id="vs-topic" value={topic} maxLength={300} onChange={(e) => setTopic(e.target.value)} placeholder="Cardiac markers in myocardial infarction" />
            </div>
          ) : null}
          {type === "prompt" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vs-prompt">Prompt</Label>
              <Textarea id="vs-prompt" rows={4} value={prompt} maxLength={4000} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the video say and show?" />
            </div>
          ) : null}
          {type === "questions" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="vs-q">Find published questions</Label>
              <div className="flex gap-2">
                <SelectNative aria-label="Exam filter" value={examId} onChange={(e) => setExamId(e.target.value)} className="max-w-[200px]">
                  <option value="">All exams</option>
                  {exams.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </SelectNative>
                <Input id="vs-q" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), search())} placeholder="Code or words from the question" />
                <Button type="button" variant="outline" onClick={search} disabled={searching}>
                  <Search className="h-4 w-4" aria-hidden /> {searching ? "Searching…" : "Search"}
                </Button>
              </div>
              {hits ? (
                hits.length === 0 ? (
                  <p className="text-xs text-[var(--color-muted-foreground)]">No published questions match.</p>
                ) : (
                  <ul className="max-h-72 divide-y divide-[var(--color-border)] overflow-auto rounded-[var(--radius-card)] border border-[var(--color-border)]" data-testid="question-hits">
                    {hits.map((h) => {
                      const on = picked.some((p) => p.id === h.id);
                      return (
                        <li key={h.id} className="flex items-start gap-3 p-2.5 text-sm">
                          <input
                            type="checkbox"
                            aria-label={`Select ${h.code}`}
                            checked={on}
                            disabled={!on && picked.length >= 10}
                            onChange={() => setPicked((cur) => (on ? cur.filter((p) => p.id !== h.id) : [...cur, h]))}
                            className="mt-1"
                          />
                          <div className="min-w-0">
                            <p className="text-xs text-[var(--color-muted-foreground)]">
                              {h.code} · {h.exam} · {h.subject}
                              {!h.hasAnswer ? <span className="ml-1 text-[var(--color-warning)]">· no stored answer (will be flagged for review)</span> : null}
                            </p>
                            <p className="line-clamp-2">{h.text}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )
              ) : null}
              {picked.length ? (
                <div className="flex flex-wrap gap-1.5" data-testid="picked">
                  {picked.map((p) => (
                    <span key={p.id} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs">
                      {p.code}
                      <button type="button" aria-label={`Remove ${p.code}`} onClick={() => setPicked((cur) => cur.filter((x) => x.id !== p.id))}>
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vs-type">Video type</Label>
              <SelectNative id="vs-type" value={videoType} onChange={(e) => setVideoType(e.target.value as VideoType)}>
                {types.map((t) => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vs-aud">Target audience</Label>
              <SelectNative id="vs-aud" value={audience} onChange={(e) => setAudience(e.target.value)}>
                {AUDIENCES.map((a) => (
                  <option key={a.key} value={a.key}>{a.label}</option>
                ))}
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vs-lang">Language</Label>
              <SelectNative id="vs-lang" value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l.key} value={l.key}>{l.label}</option>
                ))}
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vs-aspect">Aspect ratio</Label>
              <SelectNative id="vs-aspect" value={aspect} onChange={(e) => setAspect(e.target.value)}>
                {ASPECTS.map((a) => (
                  <option key={a.key} value={a.key}>{a.label}</option>
                ))}
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vs-dur">Duration (seconds, optional)</Label>
              <Input id="vs-dur" type="number" inputMode="numeric" min={DURATION_LIMITS.minSec} max={DURATION_LIMITS.maxSec} value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="Auto" />
            </div>
            {type !== "questions" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="vs-exam">Exam label</Label>
                <SelectNative id="vs-exam" value={examId} onChange={(e) => setExamId(e.target.value)}>
                  <option value="">None — general educational format</option>
                  {exams.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </SelectNative>
              </div>
            ) : (
              <p className="self-end text-xs text-[var(--color-muted-foreground)]">The exam label comes from the selected questions (only when they all belong to one exam).</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="vs-custom">Custom instructions</Label>
            <Textarea
              id="vs-custom"
              rows={6}
              value={custom}
              maxLength={4000}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Create a 60-second Hinglish teaching Reel for NEET PG students. Start with a clinical clue, explain the concept with a medically accurate diagram, add readable subtitles, keep transitions subtle, and include MockTestSeries.in branding."
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">Stays editable after Auto Configure. A duration in your text (e.g. “60-second”) is used when you leave Duration empty.</p>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-[var(--color-error)]" data-testid="form-error">
              {error}
            </p>
          ) : null}
          <div>
            <Button type="button" size="lg" onClick={submit} disabled={pending} data-testid="auto-configure">
              <Sparkles className="h-4 w-4" aria-hidden /> {pending ? "Configuring…" : type === "pdf" || type === "image" ? "Continue to upload" : "Auto Configure AI"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-base">How it works</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="flex list-decimal flex-col gap-2 pl-4 text-sm text-[var(--color-muted-foreground)]">
            <li>Auto Configure proposes Skills, design, voice, length and layout — free.</li>
            <li>Review and edit everything; preview the design.</li>
            <li>Review the estimated price.</li>
            <li>Confirm &amp; Generate — the script is written and checked.</li>
            <li>Review flagged scenes, then voice and render.</li>
            <li>Download the MP4.</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
