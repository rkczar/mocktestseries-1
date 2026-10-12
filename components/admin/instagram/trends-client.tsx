"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProviderPicker, type ProviderChoice } from "@/components/admin/instagram/ai-studio-panel";
import { useCostPreview } from "@/components/admin/ai/cost-preview";
import { addReferenceAction, deleteReferenceAction, runCompetitorAnalysisAction, runTrendAnalysisAction, setReferenceActiveAction } from "@/app/admin/(dashboard)/instagram/studio-actions";

interface Ref {
  id: string;
  kind: "HANDLE" | "POST";
  handle: string;
  url: string | null;
  topic: string | null;
  format: string | null;
  captionStyle: string | null;
  keywords: string[];
  examTags: string[];
  likes: number | null;
  comments: number | null;
  views: number | null;
  observedAt: string | null;
  active: boolean;
  createdAt: string;
}

const EMPTY = { kind: "POST", handle: "", url: "", topic: "", subject: "", format: "carousel", captionStyle: "", keywords: "", examTags: "", likes: "", comments: "", views: "", observedAt: "", notes: "" };

/** Trends & Competitors: reference handles/posts (manual, sourced), and evidence-bound AI analyses. */
export function TrendsClient({ exams, references }: { exams: { id: string; name: string }[]; references: Ref[] }) {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [provider, setProvider] = useState<ProviderChoice>("default");
  const costPreview = useCostPreview();
  const [examId, setExamId] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const handles = references.filter((r) => r.kind === "HANDLE");
  const posts = references.filter((r) => r.kind === "POST");
  const prov = provider === "default" ? null : provider;

  const go = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, ok: string) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      if (!r.ok) return setMsg({ tone: "error", text: r.error });
      setMsg({ tone: "ok", text: ok });
      router.refresh();
    });

  return (
    <>
      {costPreview.dialog}
      {msg ? (
        <p role={msg.tone === "error" ? "alert" : "status"} data-testid="trends-message" className={`rounded-md px-3 py-2 text-sm ${msg.tone === "error" ? "bg-[var(--color-error)]/10" : "bg-[var(--color-success)]/10"}`}>
          {msg.text}
        </p>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Run AI analysis (evidence only)</CardTitle>
          <CardDescription>The AI may only use the evidence listed below; any finding that does not cite evidence is discarded. Nothing is fabricated or scraped.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-5 pb-5">
          <ProviderPicker value={provider} onChange={setProvider} />
          <div className="flex flex-wrap items-center gap-2">
            <SelectNative className="w-auto" value={examId} onChange={(e) => setExamId(e.target.value)} aria-label="Exam for trend analysis">
              <option value="">All in-scope exams</option>
              {exams.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </SelectNative>
            <Button disabled={pending} data-testid="run-trends" onClick={() => costPreview.ask({ feature: "ig_trends", context: { examId: examId || null }, legacyProvider: prov !== null }, (quoteId) => go(async () => runTrendAnalysisAction({ examId: examId || null, provider: prov, quoteId }), "Trend analysis saved."))}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />} Analyse trends
            </Button>
            <Button variant="outline" disabled={pending || posts.length === 0} data-testid="run-competitors" onClick={() => costPreview.ask({ feature: "ig_competitors", context: {}, legacyProvider: prov !== null }, (quoteId) => go(async () => runCompetitorAnalysisAction({ provider: prov, quoteId }), "Competitor analysis saved."))}>
              Analyse competitor content
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Add a competitor handle or reference post</CardTitle>
          <CardDescription>Enter what you saw on a public post (topic, format, caption style, the numbers shown, and when). Do not paste competitor captions — describe the style.</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <form
            className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              go(async () => {
                const r = await addReferenceAction(form);
                if (r.ok) setForm({ ...EMPTY, kind: form.kind, handle: form.handle });
                return r;
              }, form.kind === "HANDLE" ? "Handle added." : "Reference post added.");
            }}
            data-testid="reference-form"
          >
            <label className="flex flex-col gap-1 text-xs">
              Type
              <SelectNative value={form.kind} onChange={(e) => set("kind", e.target.value)}>
                <option value="POST">Reference post</option>
                <option value="HANDLE">Competitor / reference handle</option>
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Handle
              <Input value={form.handle} onChange={(e) => set("handle", e.target.value)} placeholder="@handle" required data-testid="ref-handle" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Exams (comma separated)
              <Input value={form.examTags} onChange={(e) => set("examTags", e.target.value)} placeholder="NEET PG, FMGE" />
            </label>
            {form.kind === "POST" ? (
              <>
                <label className="flex flex-col gap-1 text-xs">
                  Post URL (optional)
                  <Input value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="https://www.instagram.com/p/…" />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  Medical topic
                  <Input value={form.topic} onChange={(e) => set("topic", e.target.value)} placeholder="e.g. Brachial plexus injuries" data-testid="ref-topic" />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  Format
                  <SelectNative value={form.format} onChange={(e) => set("format", e.target.value)}>
                    {["carousel", "reel", "single image", "notes", "quiz", "story"].map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </SelectNative>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  Caption style
                  <Input value={form.captionStyle} onChange={(e) => set("captionStyle", e.target.value)} placeholder="e.g. question hook + 3 bullet facts" />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  Keywords / hashtags seen
                  <Input value={form.keywords} onChange={(e) => set("keywords", e.target.value)} placeholder="comma separated" />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  Likes seen
                  <Input inputMode="numeric" value={form.likes} onChange={(e) => set("likes", e.target.value.replace(/\D/g, ""))} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  Comments seen
                  <Input inputMode="numeric" value={form.comments} onChange={(e) => set("comments", e.target.value.replace(/\D/g, ""))} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  Views seen
                  <Input inputMode="numeric" value={form.views} onChange={(e) => set("views", e.target.value.replace(/\D/g, ""))} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  Posted / observed on
                  <Input type="date" value={form.observedAt} onChange={(e) => set("observedAt", e.target.value)} />
                </label>
              </>
            ) : null}
            <div className="flex items-end">
              <Button type="submit" disabled={pending} data-testid="ref-add">
                Add
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>{`Handles (${handles.length}) and reference posts (${posts.length})`}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 px-5 pb-5 text-sm" data-testid="reference-list">
          {references.length === 0 ? <p className="text-[var(--color-muted-foreground)]">Nothing added yet.</p> : null}
          {references.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] py-1.5 last:border-0">
              <Badge variant={r.kind === "HANDLE" ? "primary" : "neutral"}>{r.kind === "HANDLE" ? "handle" : r.format ?? "post"}</Badge>
              <span className="font-medium">{`@${r.handle}`}</span>
              {r.kind === "POST" ? (
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  {`${r.topic ?? "no topic"} · ${[r.likes !== null ? `${r.likes} likes` : null, r.comments !== null ? `${r.comments} comments` : null, r.views !== null ? `${r.views} views` : null].filter(Boolean).join(", ") || "no numbers"} · ${r.observedAt ? r.observedAt.slice(0, 10) : "no date"} · manual entry`}
                </span>
              ) : (
                <span className="text-xs text-[var(--color-muted-foreground)]">{r.examTags.join(", ")}</span>
              )}
              {!r.active ? <Badge variant="warning">ignored</Badge> : null}
              <span className="flex-1" />
              <Button size="compact" variant="ghost" disabled={pending} onClick={() => go(async () => setReferenceActiveAction(r.id, !r.active), r.active ? "Ignored in analyses." : "Included again.")}>
                {r.active ? "Ignore" : "Include"}
              </Button>
              <Button size="compact" variant="ghost" aria-label={`Delete @${r.handle}`} disabled={pending} onClick={() => go(async () => deleteReferenceAction(r.id), "Deleted.")}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
