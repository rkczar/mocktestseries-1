"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import { TEMPLATES } from "@/lib/instagram/templates";
import { TEMPLATE_KEYS, DESIGN_MODE_LABELS, modeOfTemplate, type TemplateKey } from "@/lib/instagram/types";
import type { Candidate } from "@/lib/instagram/selection";
import { InstagramStatusBadge } from "@/components/admin/instagram/status-badge";
import { createBatchAction, selectCandidatesAction } from "@/app/admin/(dashboard)/instagram/studio-actions";

type Options = { exams: { id: string; name: string }[]; examId: string | null; subjects: { id: string; name: string }[]; topics: { id: string; name: string }[]; years: number[] };
type DesignChoice = "default" | TemplateKey;

const MAX = 20;

/** Bulk Studio step 1: filters → ranked candidates (with score breakdown) → pick 5 / 10 / custom → design per question → create the batch. */
export function BulkCreate({ options }: { options: Options }) {
  const router = useRouter();
  const [f, setF] = useState({ subjectId: "", topicId: "", year: "", difficulty: "", mostMissed: false, published: "unpublished" });
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [meta, setMeta] = useState<{ evidenceCount: number; perfPosts: number } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [designs, setDesigns] = useState<Record<string, DesignChoice>>({});
  const [allDesign, setAllDesign] = useState<DesignChoice>("default");
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [custom, setCustom] = useState("7");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const examId = options.examId;

  const search = () =>
    examId &&
    start(async () => {
      setMsg(null);
      const r = await selectCandidatesAction({
        examId,
        subjectId: f.subjectId || undefined,
        topicId: f.topicId || undefined,
        year: f.year ? Number(f.year) : undefined,
        difficulty: f.difficulty || undefined,
        mostMissed: f.mostMissed,
        published: f.published,
        limit: 60,
      });
      if (!r.ok) return setMsg(r.error);
      setCands(r.data.candidates);
      setMeta({ evidenceCount: r.data.evidenceCount, perfPosts: r.data.perfPosts });
      setPicked([]);
    });

  const pickTop = (n: number) => setPicked((cands ?? []).filter((c) => !c.blockers.length && c.instagram.status === "NOT_CREATED").slice(0, Math.min(n, MAX)).map((c) => c.id));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX ? p : [...p, id]));

  return (
    <div className="flex flex-col gap-4" data-testid="bulk-create">
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs">
          Exam
          <SelectNative value={examId ?? ""} onChange={(e) => router.push(`/admin/instagram/bulk?examId=${e.target.value}`)} data-testid="bulk-exam">
            {options.exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </SelectNative>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Subject
          <SelectNative value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value })}>
            <option value="">All subjects</option>
            {options.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectNative>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Topic
          <SelectNative value={f.topicId} onChange={(e) => setF({ ...f, topicId: e.target.value })}>
            <option value="">All topics</option>
            {options.topics.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectNative>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          PYQ year
          <SelectNative value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })}>
            <option value="">All years</option>
            {options.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </SelectNative>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Difficulty
          <SelectNative value={f.difficulty} onChange={(e) => setF({ ...f, difficulty: e.target.value })}>
            <option value="">Any</option>
            <option value="EASY">Easy</option>
            <option value="MEDIUM">Medium</option>
            <option value="HARD">Hard</option>
          </SelectNative>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Instagram
          <SelectNative value={f.published} onChange={(e) => setF({ ...f, published: e.target.value })}>
            <option value="unpublished">Not yet posted</option>
            <option value="published">Already posted</option>
            <option value="any">Any</option>
          </SelectNative>
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-xs">
          <input type="checkbox" checked={f.mostMissed} onChange={(e) => setF({ ...f, mostMissed: e.target.checked })} />
          Most Missed only (last 7 days)
        </label>
        <div className="self-end">
          <Button onClick={search} disabled={pending || !examId} data-testid="bulk-search">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Search className="h-4 w-4" aria-hidden />} Suggest questions
          </Button>
        </div>
      </div>
      {msg ? <p className="text-sm text-[var(--color-error)]" role="alert">{msg}</p> : null}

      {cands ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-xs text-[var(--color-muted-foreground)]">{`${cands.length} candidates · ${meta?.evidenceCount ?? 0} evidence items · ${meta?.perfPosts ?? 0} posts with metrics`}</span>
            <span className="flex-1" />
            <Button size="sm" variant="outline" onClick={() => pickTop(5)} data-testid="pick-5">
              Top 5
            </Button>
            <Button size="sm" variant="outline" onClick={() => pickTop(10)} data-testid="pick-10">
              Top 10
            </Button>
            <Input className="h-8 w-16" inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, "").slice(0, 2))} aria-label="Custom batch size" />
            <Button size="sm" variant="outline" onClick={() => pickTop(Math.max(1, Math.min(MAX, Number(custom) || 1)))}>
              {`Top ${Math.max(1, Math.min(MAX, Number(custom) || 1))}`}
            </Button>
          </div>
          <ul className="flex flex-col gap-2" data-testid="candidate-list">
            {cands.map((c) => (
              <li key={c.id} className={cn("rounded-[var(--radius-card)] border p-2.5", picked.includes(c.id) ? "border-[var(--color-primary)]" : "border-[var(--color-border)]")} data-candidate={c.code}>
                <div className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={picked.includes(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.code}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="font-mono">{c.code}</span>
                      <Badge variant={c.score >= 60 ? "success" : c.score >= 40 ? "info" : "neutral"} data-testid="score">{`Score ${c.score}`}</Badge>
                      <span className="text-[var(--color-muted-foreground)]">{`${c.subject}${c.topic ? ` · ${c.topic}` : ""}${c.year ? ` · PYQ ${c.year}` : ""} · ${c.difficulty.toLowerCase()}${c.wrongPct !== null ? ` · ${Math.round(c.wrongPct)}% wrong` : ""}`}</span>
                      <InstagramStatusBadge status={c.instagram.status} posted={c.instagram.posted} />
                      {c.blockers.map((b) => (
                        <Badge key={b} variant="warning">
                          {b}
                        </Badge>
                      ))}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm">{c.preview}</p>
                    <button type="button" className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--color-muted-foreground)] underline" onClick={() => setOpen(open === c.id ? null : c.id)}>
                      {open === c.id ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />} Why this score
                    </button>
                    {open === c.id ? (
                      <ul className="mt-1 flex flex-col gap-0.5 text-xs" data-testid="score-breakdown">
                        {c.parts.map((p) => (
                          <li key={p.label}>
                            <span className="font-medium">{`${p.label}: ${p.points}/${p.max}`}</span> <span className="text-[var(--color-muted-foreground)]">{p.why}</span>
                          </li>
                        ))}
                        {c.blockers.length ? <li className="text-[var(--color-warning)]">−30 for blockers (the post can&apos;t be published until they are fixed)</li> : null}
                      </ul>
                    ) : null}
                  </div>
                  {picked.includes(c.id) ? (
                    <SelectNative className="h-8 w-40 text-xs" value={designs[c.id] ?? allDesign} onChange={(e) => setDesigns({ ...designs, [c.id]: e.target.value as DesignChoice })} aria-label={`Design for ${c.code}`}>
                      <option value="default">Default design</option>
                      {TEMPLATE_KEYS.map((k) => (
                        <option key={k} value={k}>
                          {`${DESIGN_MODE_LABELS[modeOfTemplate(k)].split(" ").pop()} · ${TEMPLATES[k].name}`}
                        </option>
                      ))}
                    </SelectNative>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-card)] py-3">
            <span className="text-sm font-medium" data-testid="picked-count">{`${picked.length} selected (max ${MAX})`}</span>
            <SelectNative className="h-8 w-auto text-xs" value={allDesign} onChange={(e) => (setAllDesign(e.target.value as DesignChoice), setDesigns({}))} aria-label="Design for all">
              <option value="default">All: default design</option>
              <option value="hw-doctor">All: Handwritten (Clean Doctor Notes)</option>
              <option value="minimal-infographic">All: Professional (Minimal Infographic)</option>
            </SelectNative>
            <Input className="h-8 w-48" value={name} onChange={(e) => setName(e.target.value)} placeholder="Batch name (optional)" />
            <Button
              disabled={pending || picked.length === 0}
              data-testid="create-batch"
              onClick={() =>
                start(async () => {
                  const perQuestion = Object.fromEntries(picked.map((id) => [id, designs[id] ?? allDesign]).filter(([, d]) => d !== "default")) as Record<string, string>;
                  const r = await createBatchAction({ name, examId: examId!, questionIds: picked, template: "default", perQuestion });
                  if (!r.ok) return setMsg(r.error);
                  const failed = r.data.results.filter((x) => x.error);
                  if (failed.length) setMsg(`${failed.length} question(s) skipped: ${failed.map((x) => x.error).join("; ")}`);
                  router.push(`/admin/instagram/bulk/${r.data.batchId}`);
                })
              }
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Create {picked.length || ""} separate posts
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
