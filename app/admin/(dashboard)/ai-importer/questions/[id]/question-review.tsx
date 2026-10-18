"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { allowDuplicateAction, approveQuestionsAction, editQuestionAction, rejectQuestionsAction, reprocessQuestionsAction, restoreQuestionAction, setAnswerAction, setFigureAction, setTaxonomyAction } from "../../actions";
import { callImporter } from "@/components/admin/ai-importer/call-importer";

interface ReviewQ {
  id: string;
  status: string;
  type: string;
  contentFormat: "PLAIN" | "RICH_V1";
  stem: string;
  options: { label: string; text: string }[];
  finalAnswer: string[];
  subjectId: string | null;
  topicId: string | null;
  allowDuplicate: boolean;
  duplicate: string | null;
  figures: { id: string; owner: string; optionLabel: string | null; mappingStatus: string; source: string; confirmed: boolean; page: number }[];
}

const TYPES = ["SINGLE_CORRECT", "MULTIPLE_CORRECT", "MATCH_THE_FOLLOWING", "ASSERTION_REASON", "NUMERICAL", "FIVE_OPTIONS", "OTHER"];

export function QuestionReview({ q, taxonomy }: { q: ReviewQ; taxonomy: { id: string; name: string; topics: { id: string; name: string }[] }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [stem, setStem] = useState(q.stem);
  const [options, setOptions] = useState(q.options.length ? q.options : ["A", "B", "C", "D"].map((label) => ({ label, text: "" })));
  const [type, setType] = useState(q.type);
  const [format, setFormat] = useState(q.contentFormat);
  const [answer, setAnswer] = useState<string[]>(q.finalAnswer);
  const [subjectId, setSubjectId] = useState(q.subjectId ?? "");
  const [topicId, setTopicId] = useState(q.topicId ?? "");
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) =>
    start(async () => {
      const r = await callImporter(fn);
      setMsg(r.ok ? { ok: true, text: ok } : { ok: false, text: r.error ?? "Failed" });
      if (r.ok) router.refresh();
    });
  const subject = taxonomy.find((s) => s.id === subjectId);

  return (
    <div className="grid gap-4 xl:grid-cols-2" data-testid="question-review">
      {msg && <p className={`xl:col-span-2 text-sm ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} data-testid="review-msg">{msg.text}</p>}
      <Card>
        <CardHeader>
          <CardTitle>Correct the extraction</CardTitle>
          <CardDescription>Your edit is saved beside the original extraction (which is kept). Use $…$ for formulas and \ce{"{…}"} for chemistry with the “formulas” format.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="rv-type">Type</Label>
              <SelectNative id="rv-type" value={type} onChange={(e) => setType(e.target.value)}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ").toLowerCase()}
                  </option>
                ))}
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="rv-format">Text format</Label>
              <SelectNative id="rv-format" value={format} onChange={(e) => setFormat(e.target.value as "PLAIN" | "RICH_V1")}>
                <option value="PLAIN">Plain text</option>
                <option value="RICH_V1">With formulas (KaTeX)</option>
              </SelectNative>
            </div>
          </div>
          <Label htmlFor="rv-stem">Question text</Label>
          <Textarea id="rv-stem" rows={5} value={stem} onChange={(e) => setStem(e.target.value)} data-testid="rv-stem" />
          {options.map((o, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-2 w-5 font-semibold">{o.label}</span>
              <Textarea rows={2} value={o.text} onChange={(e) => setOptions((cur) => cur.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} aria-label={`Option ${o.label}`} data-testid={`rv-option-${o.label}`} />
            </div>
          ))}
          <div className="flex gap-2">
            {options.length < 5 && (
              <Button variant="outline" size="sm" onClick={() => setOptions((cur) => [...cur, { label: String.fromCharCode(65 + cur.length), text: "" }])}>
                Add option
              </Button>
            )}
            {options.length > 2 && (
              <Button variant="outline" size="sm" onClick={() => setOptions((cur) => cur.slice(0, -1))}>
                Remove last option
              </Button>
            )}
          </div>
          <div>
            <Button disabled={pending} onClick={() => act(() => editQuestionAction(q.id, { stem, options, type: type as never, contentFormat: format }), "Saved and re-checked.")} data-testid="rv-save">
              Save correction
            </Button>
          </div>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Answer</CardTitle>
            <CardDescription>Choose the answer only if you are sure. It is recorded as chosen by an administrator — never as the official key.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <div className="flex gap-3">
              {options.map((o) => (
                <label key={o.label} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={answer.includes(o.label)} onChange={() => setAnswer((a) => (a.includes(o.label) ? a.filter((x) => x !== o.label) : type === "MULTIPLE_CORRECT" ? [...a, o.label] : [o.label]))} data-testid={`rv-answer-${o.label}`} />
                  {o.label}
                </label>
              ))}
            </div>
            <div>
              <Button size="sm" disabled={pending || !answer.length} onClick={() => act(() => setAnswerAction(q.id, answer), "Answer saved.")} data-testid="rv-set-answer">
                Set answer
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Subject and topic</CardTitle>
            <CardDescription>From this exam&apos;s existing configuration only.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <SelectNative value={subjectId} onChange={(e) => (setSubjectId(e.target.value), setTopicId(""))} aria-label="Subject" data-testid="rv-subject">
              <option value="">Subject…</option>
              {taxonomy.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectNative>
            <SelectNative value={topicId} onChange={(e) => setTopicId(e.target.value)} aria-label="Topic" disabled={!subject} data-testid="rv-topic">
              <option value="">No topic</option>
              {subject?.topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </SelectNative>
            <Button size="sm" disabled={pending || !subjectId} onClick={() => act(() => setTaxonomyAction(q.id, subjectId, topicId || null), "Subject/topic saved.")} data-testid="rv-set-topic">
              Save
            </Button>
          </CardContent>
        </Card>
        {q.figures.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Figures</CardTitle>
              <CardDescription>Confirm where each original figure belongs. Originals are never redrawn or replaced.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {q.figures.map((f) => (
                <div key={f.id} className="flex flex-wrap items-center gap-2 text-sm" data-testid="rv-figure">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {f.mappingStatus !== "MISSING" && <img src={`/api/admin/ai-importer/figures/${f.id}/image`} alt="Figure" className="h-16 rounded border border-[var(--color-border)] bg-white" />}
                  <span>
                    page {f.page} · {f.source.toLowerCase()} · {f.owner === "OPTION" ? `option ${f.optionLabel}` : f.owner.toLowerCase()} · {f.confirmed ? "confirmed" : f.mappingStatus.toLowerCase()}
                  </span>
                  {f.mappingStatus !== "MISSING" && (
                    <SelectNative
                      aria-label="Assign figure"
                      defaultValue=""
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!v) return;
                        act(() => setFigureAction(f.id, v === "STEM" ? "STEM" : v === "REMOVE" ? "REMOVE" : "OPTION", v.startsWith("OPT:") ? v.slice(4) : null), "Figure saved.");
                      }}
                      data-testid="rv-figure-assign"
                    >
                      <option value="">Assign…</option>
                      <option value="STEM">Question text</option>
                      {["A", "B", "C", "D"].map((l) => (
                        <option key={l} value={`OPT:${l}`}>
                          Option {l}
                        </option>
                      ))}
                      <option value="REMOVE">Not part of this question</option>
                    </SelectNative>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Decision</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {q.status !== "REJECTED" ? (
              <>
                <Button size="sm" disabled={pending} onClick={() => act(() => approveQuestionsAction([q.id]), "Approved.")} data-testid="rv-approve">
                  Approve
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => rejectQuestionsAction([q.id], prompt("Reason (optional):") ?? ""), "Rejected.")} data-testid="rv-reject">
                  Reject
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => reprocessQuestionsAction([q.id]), "Queued for another AI read.")} data-testid="rv-reprocess">
                  Reprocess with AI
                </Button>
                {q.duplicate && (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => allowDuplicateAction(q.id, !q.allowDuplicate), q.allowDuplicate ? "Duplicate check restored." : "Will be imported despite the similarity.")} data-testid="rv-allow-dup">
                    {q.allowDuplicate ? "Treat as duplicate again" : "Not a duplicate — import anyway"}
                  </Button>
                )}
              </>
            ) : (
              <Button size="sm" disabled={pending} onClick={() => act(() => restoreQuestionAction(q.id), "Restored.")}>
                Restore
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
