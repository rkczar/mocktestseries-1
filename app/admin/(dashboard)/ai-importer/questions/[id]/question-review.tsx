"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { QuestionMedia } from "@/components/content/question-media";
import {
  allowDuplicateAction,
  applyRescanAction,
  approveQuestionsAction,
  discardRescanAction,
  editQuestionAction,
  cropFigureAction,
  markFigureUncertainAction,
  markImageMissingAction,
  reclassifyQuestionsAction,
  rejectQuestionsAction,
  rescanQuestionsAction,
  restoreQuestionAction,
  reverifyAnswerKeyAction,
  setAnswerAction,
  setFigureAction,
  setTaxonomyAction,
  unapproveQuestionsAction,
} from "../../actions";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { CropEditor } from "@/components/admin/ai-importer/crop-editor";

export interface ReviewFigure {
  id: string;
  owner: string;
  optionLabel: string | null;
  mappingStatus: string;
  source: string;
  confirmed: boolean;
  page: number;
  pageId: string | null;
  width: number;
  height: number;
  description: string | null;
  box: { x: number; y: number; w: number; h: number } | null;
  /** Why the placement is (not) trusted — from the deterministic mapping check or the administrator. */
  reason: string | null;
  confidence: number | null;
}

export interface ReviewQ {
  id: string;
  status: string;
  type: string;
  contentFormat: "PLAIN" | "RICH_V1";
  number: number | null;
  section: string;
  stem: string;
  options: { label: string; text: string }[];
  explanation: string;
  pages: number[];
  pageCount: number;
  finalAnswer: string[];
  subjectId: string | null;
  topicId: string | null;
  subTopicId: string | null;
  /** Why this subject / topic (or why none), how sure, and what Verify 1 / Verify 2 found. */
  classification: { source: string | null; confidence: number | null; kind: string | null; reason: string | null; v1: string | null; v2: string | null } | null;
  allowDuplicate: boolean;
  duplicate: string | null;
  approved: boolean;
  approvedBy: string | null;
  figures: ReviewFigure[];
  /** Pages of this question that have a page image to crop from. */
  pageImages: { page: number; pageId: string }[];
  rescanAllowed: { ok: boolean; reason: string | null };
}

export interface RescanCompareView {
  versionId: string;
  model: string | null;
  createdAt: string;
  rows: { field: string; label: string; current: string; rescan: string; same: boolean }[];
}

export interface VersionView {
  id: string;
  kind: string;
  status: string | null;
  createdAt: string;
  model: string | null;
  actor: string | null;
  note: string | null;
  changes: { field: string; before: string; after: string }[];
}

const TYPES = ["SINGLE_CORRECT", "MULTIPLE_CORRECT", "MATCH_THE_FOLLOWING", "ASSERTION_REASON", "NUMERICAL", "FIVE_OPTIONS", "OTHER"];
const OPTION_LABELS = ["A", "B", "C", "D", "E"];

type ActionResult = { ok: true; data?: unknown } | { ok: false; error: string };

function figureTitle(f: ReviewFigure): string {
  return f.owner === "OPTION" ? `Option ${f.optionLabel}` : f.owner === "UNASSIGNED" ? "Unassigned" : "Question text";
}

/** One figure: complete image with zoom, its facts, and the correction tools. */
function FigureRow({ f, questionId, busy, act, onUpload }: { f: ReviewFigure; questionId: string; busy: boolean; act: (fn: () => Promise<ActionResult>, ok: string) => void; onUpload: (file: File, owner: "STEM" | "OPTION", label: string | null, replace: string | null) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [showPage, setShowPage] = useState(false);
  const [editing, setEditing] = useState(false);
  const missing = f.mappingStatus === "MISSING";
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-2" data-testid="rv-figure" data-figure-id={f.id} data-status={f.mappingStatus}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{figureTitle(f)}</span>
        <Badge variant={missing ? "error" : f.confirmed ? "success" : f.mappingStatus === "UNCERTAIN" ? "warning" : "neutral"}>{missing ? "missing" : f.confirmed ? "placement confirmed" : f.mappingStatus === "UNCERTAIN" ? "placement uncertain" : "not confirmed"}</Badge>
        <span className="text-[var(--color-muted-foreground)]">
          page {f.page || "—"} · {f.source === "ADMIN_UPLOAD" ? "uploaded" : f.source.toLowerCase()}
          {!missing && f.width ? ` · ${f.width}×${f.height}px original` : ""}
          {f.box ? ` · box ${Math.round(f.box.x * 100)}%,${Math.round(f.box.y * 100)}% ${Math.round(f.box.w * 100)}×${Math.round(f.box.h * 100)}%` : ""}
          {f.confidence !== null && !f.confirmed ? ` · mapping ${Math.round(f.confidence * 100)}%` : ""}
        </span>
      </div>
      {f.reason && !f.confirmed && (
        <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="rv-figure-reason">
          {f.reason}
        </p>
      )}
      {missing ? (
        <p className="text-xs text-[var(--color-error)]">{f.description ?? "This image could not be extracted."}</p>
      ) : (
        <QuestionMedia
          assets={[{ role: "QUESTION", optionLabel: f.optionLabel, order: 0, url: `/api/admin/ai-importer/figures/${f.id}/image`, alt: f.description ?? `${figureTitle(f)} image`, caption: null, width: f.width, height: f.height, darkBacking: true }]}
        />
      )}
      {f.pageId && f.box && (
        <div>
          <button type="button" className="text-xs underline" onClick={() => setShowPage((v) => !v)} data-testid="rv-figure-source">
            {showPage ? "Hide" : "Show"} where it was cut from the page
          </button>
          {showPage && (
            <div className="relative mt-1 w-full max-w-md">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/admin/ai-importer/pages/${f.pageId}/image`} alt={`Page ${f.page}`} className="w-full rounded border border-[var(--color-border)] bg-white" />
              <span className="pointer-events-none absolute border-2 border-[var(--color-error)]" style={{ left: `${f.box.x * 100}%`, top: `${f.box.y * 100}%`, width: `${f.box.w * 100}%`, height: `${f.box.h * 100}%` }} />
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!missing && (
          <SelectNative
            aria-label="Place this figure"
            defaultValue=""
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value;
              e.target.value = "";
              if (!v) return;
              act(() => setFigureAction(f.id, v === "STEM" ? "STEM" : v === "REMOVE" ? "REMOVE" : "OPTION", v.startsWith("OPT:") ? v.slice(4) : null), v === "REMOVE" ? "Figure detached (kept in the vault)." : "Placement confirmed.");
            }}
            data-testid="rv-figure-assign"
          >
            <option value="">Place / confirm…</option>
            <option value="STEM">Question text</option>
            {["A", "B", "C", "D"].map((l) => (
              <option key={l} value={`OPT:${l}`}>
                Option {l}
              </option>
            ))}
            <option value="REMOVE">Not part of this question</option>
          </SelectNative>
        )}
        {!missing && f.confirmed && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => markFigureUncertainAction(f.id, prompt("What is uncertain about this image? (optional)") ?? ""), "Marked uncertain.")} data-testid="rv-figure-uncertain">
            Mark uncertain
          </Button>
        )}
        {f.pageId && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing((v) => !v)} data-testid="rv-figure-recrop">
            {missing ? "Crop it from the page" : "Adjust crop"}
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()} data-testid="rv-figure-replace">
          {missing ? "Upload the image" : "Replace image"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onUpload(file, f.owner === "OPTION" ? "OPTION" : "STEM", f.optionLabel, f.id);
          }}
          data-testid="rv-figure-replace-input"
        />
      </div>
      {editing && f.pageId && (
        <CropEditor
          pageUrl={`/api/admin/ai-importer/pages/${f.pageId}/image`}
          pageNumber={f.page}
          initial={f.box}
          busy={busy}
          saveLabel="Save crop"
          onCancel={() => setEditing(false)}
          onSave={(box) => {
            setEditing(false);
            act(() => cropFigureAction({ questionId, pageNumber: f.page, box, owner: f.owner === "OPTION" ? "OPTION" : "STEM", optionLabel: f.optionLabel, replaceFigureId: f.id }), "New crop saved and confirmed — the earlier image is kept in the vault.");
          }}
        />
      )}
    </div>
  );
}

export function QuestionReview({
  q,
  taxonomy,
  compare,
  history,
}: {
  q: ReviewQ;
  taxonomy: { id: string; name: string; topics: { id: string; name: string; subTopics: { id: string; name: string }[] }[] }[];
  compare: RescanCompareView | null;
  history: VersionView[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const initial = {
    number: q.number === null ? "" : String(q.number),
    stem: q.stem,
    options: q.options.length ? q.options : ["A", "B", "C", "D"].map((label) => ({ label, text: "" })),
    type: q.type,
    format: q.contentFormat,
    explanation: q.explanation,
    pages: q.pages.join(", "),
  };
  const [form, setForm] = useState(initial);
  const [answer, setAnswer] = useState<string[]>(q.finalAnswer);
  const [subjectId, setSubjectId] = useState(q.subjectId ?? "");
  const [topicId, setTopicId] = useState(q.topicId ?? "");
  const [subTopicId, setSubTopicId] = useState(q.subTopicId ?? "");
  const [rememberTax, setRememberTax] = useState(true);
  const [take, setTake] = useState<Set<string>>(new Set());
  const [addImg, setAddImg] = useState({ owner: "STEM", label: "A" });
  const [addCrop, setAddCrop] = useState<number | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const act = (fn: () => Promise<ActionResult>, ok: string | ((d: unknown) => string)) =>
    start(async () => {
      const r = await callImporter(fn as () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>);
      setMsg(r.ok ? { ok: true, text: typeof ok === "function" ? ok(r.data) : ok } : { ok: false, text: r.error ?? "Failed" });
      if (r.ok) router.refresh();
    });
  const upload = (file: File, owner: "STEM" | "OPTION", label: string | null, replace: string | null) =>
    start(async () => {
      const body = new FormData();
      body.set("file", file);
      body.set("owner", owner);
      if (label) body.set("optionLabel", label);
      if (replace) body.set("replaceFigureId", replace);
      const res = await fetch(`/api/admin/ai-importer/questions/${q.id}/figures`, { method: "POST", body }).catch(() => null);
      const data = res ? await res.json().catch(() => ({})) : {};
      setMsg(res?.ok ? { ok: true, text: replace ? "Image replaced. The previous one is kept in the vault." : "Image added." } : { ok: false, text: data.error ?? "The image could not be uploaded." });
      if (res?.ok) router.refresh();
    });

  // Client-side checks, shown before anything is sent (the server checks again).
  const problems: string[] = [];
  if (!form.stem.trim()) problems.push("The question text cannot be empty.");
  if (form.number && !/^\d{1,3}$/.test(form.number)) problems.push("The question number must be a whole number from 1 to 999.");
  const pageList = form.pages.split(/[,\s]+/).filter(Boolean).map(Number);
  if (!pageList.length || pageList.some((p) => !Number.isInteger(p) || p < 1 || p > q.pageCount)) problems.push(`Source pages must be numbers from 1 to ${q.pageCount}.`);
  form.options.forEach((o) => {
    if (!o.text.trim() && !q.figures.some((f) => f.owner === "OPTION" && f.optionLabel === o.label && f.mappingStatus !== "MISSING")) problems.push(`Option ${o.label} has neither text nor an image.`);
  });

  const subject = taxonomy.find((s) => s.id === subjectId);
  const topic = subject?.topics.find((t) => t.id === topicId);
  const save = () =>
    act(
      () =>
        editQuestionAction(q.id, {
          stem: form.stem,
          options: form.options,
          type: form.type as never,
          contentFormat: form.format,
          number: form.number ? Number(form.number) : null,
          explanation: form.explanation,
          pages: pageList,
        }),
      "Saved and re-checked. Approve it again when you are done.",
    );

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2" data-testid="question-review">
      {msg && (
        <p className={`text-sm xl:col-span-2 ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role={msg.ok ? "status" : "alert"} data-testid="review-msg">
          {msg.text}
        </p>
      )}

      {compare && (
        <Card className="xl:col-span-2" data-testid="rv-compare">
          <CardHeader>
            <CardTitle>Re-scan result waiting for your choice</CardTitle>
            <CardDescription>
              Read again from the original page{compare.model ? ` by ${compare.model}` : ""} on {compare.createdAt}. This question has manual corrections, so nothing was replaced. Tick the fields to take from the re-scan; everything else stays as it is now.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-[var(--color-muted-foreground)]">
                <tr>
                  <th className="w-24 py-1 font-medium">Use re-scan</th>
                  <th className="py-1 font-medium">Field</th>
                  <th className="py-1 font-medium">Current (kept unless ticked)</th>
                  <th className="py-1 font-medium">Re-scan</th>
                </tr>
              </thead>
              <tbody>
                {compare.rows.map((r) => (
                  <tr key={r.field} className={`border-t border-[var(--color-border)] align-top ${r.same ? "text-[var(--color-muted-foreground)]" : ""}`} data-testid="rv-compare-row" data-field={r.field} data-same={r.same ? "true" : "false"}>
                    <td className="py-1.5">
                      {!r.same && (
                        <input
                          type="checkbox"
                          aria-label={`Use the re-scan for ${r.label}`}
                          checked={take.has(r.field)}
                          onChange={() => setTake((t) => (t.has(r.field) ? new Set([...t].filter((x) => x !== r.field)) : new Set([...t, r.field])))}
                          data-testid={`rv-take-${r.field}`}
                        />
                      )}
                    </td>
                    <td className="py-1.5 pr-2 font-medium">{r.label}</td>
                    <td className="whitespace-pre-wrap py-1.5 pr-2">{r.current}</td>
                    <td className={`whitespace-pre-wrap py-1.5 ${r.same ? "" : "bg-[var(--color-warning)]/10"}`}>{r.same ? "same" : r.rescan}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending} onClick={() => act(() => applyRescanAction(compare.versionId, [...take]), take.size ? "Applied the ticked fields; everything else was kept." : "Kept the current question.")} data-testid="rv-compare-apply">
                {take.size ? `Apply ${take.size} ticked field(s)` : "Keep the current question"}
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => discardRescanAction(compare.versionId), "Re-scan result discarded (kept in the history).")} data-testid="rv-compare-discard">
                Discard re-scan result
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Edit question</CardTitle>
          <CardDescription>Your edit is saved beside the original extraction, which is kept with every earlier version. Use $…$ for formulas and \ce{"{…}"} for chemistry with the “formulas” format.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="rv-number">Question number{q.section ? ` (section ${q.section})` : ""}</Label>
              <Input id="rv-number" className="w-24" inputMode="numeric" value={form.number} onChange={(e) => setForm((f) => ({ ...f, number: e.target.value.replace(/\D/g, "") }))} data-testid="rv-number" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="rv-type">Type</Label>
              <SelectNative id="rv-type" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} data-testid="rv-type">
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ").toLowerCase()}
                  </option>
                ))}
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="rv-format">Text format</Label>
              <SelectNative id="rv-format" value={form.format} onChange={(e) => setForm((f) => ({ ...f, format: e.target.value as "PLAIN" | "RICH_V1" }))}>
                <option value="PLAIN">Plain text</option>
                <option value="RICH_V1">With formulas (KaTeX)</option>
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="rv-pages">Source page(s)</Label>
              <Input id="rv-pages" className="w-28" value={form.pages} onChange={(e) => setForm((f) => ({ ...f, pages: e.target.value }))} data-testid="rv-pages" />
            </div>
          </div>
          <Label htmlFor="rv-stem">Question text</Label>
          <Textarea id="rv-stem" rows={5} value={form.stem} onChange={(e) => setForm((f) => ({ ...f, stem: e.target.value }))} data-testid="rv-stem" />
          {form.options.map((o, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-2 w-5 font-semibold">{o.label}</span>
              <Textarea rows={2} value={o.text} onChange={(e) => setForm((f) => ({ ...f, options: f.options.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)) }))} aria-label={`Option ${o.label}`} data-testid={`rv-option-${o.label}`} />
            </div>
          ))}
          <div className="flex gap-2">
            {form.options.length < 5 && (
              <Button variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, options: [...f.options, { label: String.fromCharCode(65 + f.options.length), text: "" }] }))}>
                Add option
              </Button>
            )}
            {form.options.length > 2 && (
              <Button variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, options: f.options.slice(0, -1) }))}>
                Remove last option
              </Button>
            )}
          </div>
          <Label htmlFor="rv-explanation">Explanation (optional)</Label>
          <Textarea id="rv-explanation" rows={3} value={form.explanation} onChange={(e) => setForm((f) => ({ ...f, explanation: e.target.value }))} data-testid="rv-explanation" />
          {dirty && problems.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-[var(--color-error)]" role="alert" data-testid="rv-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Button disabled={pending || !dirty || problems.length > 0} onClick={save} data-testid="rv-save">
              Save changes
            </Button>
            <Button variant="outline" disabled={pending || !dirty} onClick={() => setForm(initial)} data-testid="rv-cancel">
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Approval</CardTitle>
            <CardDescription>Only approved questions are added to the Question Bank (as Draft). Any later change withdraws the approval.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            {q.approved ? <Badge variant="success" data-testid="rv-approved">Approved{q.approvedBy ? ` by ${q.approvedBy}` : ""}</Badge> : <Badge variant="neutral" data-testid="rv-not-approved">Not approved</Badge>}
            {q.status !== "REJECTED" ? (
              <>
                {!q.approved ? (
                  <Button size="sm" disabled={pending || dirty} onClick={() => act(() => approveQuestionsAction([q.id]), (d) => {
                    const r = d as { approved: number; refused: { reason: string }[] };
                    return r.approved ? "Approved." : `Not approved: ${r.refused[0]?.reason ?? "it has a problem to fix first"}.`;
                  })} data-testid="rv-approve">
                    Approve
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => unapproveQuestionsAction([q.id]), "Approval withdrawn.")} data-testid="rv-unapprove">
                    Withdraw approval
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => rejectQuestionsAction([q.id], prompt("Reason (optional):") ?? ""), "Rejected.")} data-testid="rv-reject">
                  Reject
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
            {dirty && <span className="text-xs text-[var(--color-warning)]">Save or cancel your edit first.</span>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Answer</CardTitle>
            <CardDescription>Choose the answer only if you are sure. It is recorded as chosen by an administrator — never as the official key.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <div className="flex gap-3">
              {form.options.map((o) => (
                <label key={o.label} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={answer.includes(o.label)} onChange={() => setAnswer((a) => (a.includes(o.label) ? a.filter((x) => x !== o.label) : form.type === "MULTIPLE_CORRECT" ? [...a, o.label] : [o.label]))} data-testid={`rv-answer-${o.label}`} />
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
            <CardTitle>Subject, topic and sub-topic</CardTitle>
            <CardDescription>From this exam&apos;s existing configuration only — nothing is created.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <SelectNative value={subjectId} onChange={(e) => (setSubjectId(e.target.value), setTopicId(""), setSubTopicId(""))} aria-label="Subject" data-testid="rv-subject">
              <option value="">Subject…</option>
              {taxonomy.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectNative>
            <SelectNative value={topicId} onChange={(e) => (setTopicId(e.target.value), setSubTopicId(""))} aria-label="Topic" disabled={!subject} data-testid="rv-topic">
              <option value="">No topic</option>
              {subject?.topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </SelectNative>
            {topic && topic.subTopics.length > 0 && (
              <SelectNative value={subTopicId} onChange={(e) => setSubTopicId(e.target.value)} aria-label="Sub-topic" data-testid="rv-subtopic">
                <option value="">No sub-topic</option>
                {topic.subTopics.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </SelectNative>
            )}
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={rememberTax} onChange={(e) => setRememberTax(e.target.checked)} data-testid="rv-remember-topic" /> Remember as a confirmed example for this exam
            </label>
            <Button size="sm" disabled={pending || !subjectId} onClick={() => act(() => setTaxonomyAction(q.id, subjectId, topicId || null, subTopicId || null, rememberTax), "Subject/topic saved. The question still needs approval; run Verify 1 / Verify 2 again to check it.")} data-testid="rv-set-topic">
              Save
            </Button>
            {q.classification && (
              <div className="flex w-full flex-col gap-0.5 text-xs text-[var(--color-muted-foreground)]" data-testid="rv-classification">
                <p>
                  Source: {q.classification.source ?? "not set"}
                  {q.classification.confidence !== null ? ` · ${Math.round(q.classification.confidence * 100)}%` : ""}
                  {q.classification.kind ? <span className="ml-1 font-medium text-[var(--color-warning)]">{q.classification.kind}</span> : null}
                </p>
                {q.classification.reason && <p>{q.classification.reason}</p>}
                {q.classification.v1 && <p>Verify 1: {q.classification.v1}</p>}
                {q.classification.v2 && <p>Verify 2: {q.classification.v2}</p>}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Images</CardTitle>
            <CardDescription>Each image is shown complete at its original aspect ratio — tap it to zoom. Originals are never redrawn or deleted; a replacement keeps the old one in the vault.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {q.figures.length === 0 && <p className="text-sm text-[var(--color-muted-foreground)]">No images.</p>}
            {q.figures.map((f) => (
              <FigureRow key={f.id} f={f} questionId={q.id} busy={pending} act={act} onUpload={upload} />
            ))}
            <div className="flex flex-wrap items-end gap-2 border-t border-[var(--color-border)] pt-3 text-sm" data-testid="rv-add-image">
              <SelectNative aria-label="Image belongs to" value={addImg.owner === "STEM" ? "STEM" : `OPT:${addImg.label}`} onChange={(e) => setAddImg(e.target.value === "STEM" ? { owner: "STEM", label: "A" } : { owner: "OPTION", label: e.target.value.slice(4) })}>
                <option value="STEM">Question text</option>
                {OPTION_LABELS.slice(0, Math.max(4, form.options.length)).map((l) => (
                  <option key={l} value={`OPT:${l}`}>
                    Option {l}
                  </option>
                ))}
              </SelectNative>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => addRef.current?.click()} data-testid="rv-add-image-button">
                Add an image
              </Button>
              {q.pageImages.length > 0 && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => setAddCrop((v) => (v === null ? q.pageImages[0].page : null))} data-testid="rv-add-crop">
                  Crop another figure from the page
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => markImageMissingAction(q.id, addImg.owner === "OPTION" ? "OPTION" : "STEM", addImg.owner === "OPTION" ? addImg.label : null, prompt("Describe the missing image (optional):") ?? ""), "Marked missing — upload the image or re-scan the page.")} data-testid="rv-mark-missing">
                Mark an image missing
              </Button>
              <input
                ref={addRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) upload(file, addImg.owner === "OPTION" ? "OPTION" : "STEM", addImg.owner === "OPTION" ? addImg.label : null, null);
                }}
                data-testid="rv-add-image-input"
              />
            </div>
            {addCrop !== null && (
              <div className="flex flex-col gap-2" data-testid="rv-add-crop-panel">
                {q.pageImages.length > 1 && (
                  <SelectNative aria-label="Page to crop from" value={String(addCrop)} onChange={(e) => setAddCrop(Number(e.target.value))}>
                    {q.pageImages.map((p) => (
                      <option key={p.page} value={p.page}>
                        Page {p.page}
                      </option>
                    ))}
                  </SelectNative>
                )}
                <CropEditor
                  key={addCrop}
                  pageUrl={`/api/admin/ai-importer/pages/${q.pageImages.find((p) => p.page === addCrop)?.pageId ?? q.pageImages[0].pageId}/image`}
                  pageNumber={addCrop}
                  initial={null}
                  busy={pending}
                  saveLabel={`Add crop to ${addImg.owner === "OPTION" ? `option ${addImg.label}` : "the question text"}`}
                  onCancel={() => setAddCrop(null)}
                  onSave={(box) => {
                    const page = addCrop;
                    setAddCrop(null);
                    act(() => cropFigureAction({ questionId: q.id, pageNumber: page, box, owner: addImg.owner === "OPTION" ? "OPTION" : "STEM", optionLabel: addImg.owner === "OPTION" ? addImg.label : null, replaceFigureId: null }), "Crop added and confirmed.");
                  }}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Re-scan / re-check</CardTitle>
            <CardDescription>Reads the ORIGINAL uploaded page again. Your corrections are never overwritten: if this question was corrected, the new read waits here for you to compare and choose.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {!q.rescanAllowed.ok && <p className="text-xs text-[var(--color-warning)]" data-testid="rv-rescan-unavailable">{q.rescanAllowed.reason}</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={pending || !q.rescanAllowed.ok} onClick={() => act(() => rescanQuestionsAction([q.id], "question"), "Re-scan queued — the result appears here when the worker has read the page.")} data-testid="rv-rescan-question">
                Re-scan this question
              </Button>
              <Button size="sm" variant="outline" disabled={pending || !q.rescanAllowed.ok} onClick={() => act(() => rescanQuestionsAction([q.id], "page"), "Re-scan of the whole page queued.")} data-testid="rv-rescan-page">
                Re-scan its source page{q.pages.length > 1 ? "s" : ""}
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => reverifyAnswerKeyAction([q.id]), (d) => `Answer key re-checked: ${Object.entries((d as { answerStatus: Record<string, number> }).answerStatus).map(([k, n]) => `${k.toLowerCase().replace(/_/g, " ")} ${n}`).join(", ")}.`)} data-testid="rv-reverify-key">
                Re-verify answer key
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => reclassifyQuestionsAction([q.id]), "Queued for subject/topic classification.")} data-testid="rv-reclassify">
                Re-classify subject / topic
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {history.length > 0 && (
        <Card className="xl:col-span-2" data-testid="rv-history">
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>Every extraction, re-scan and manual correction of this question, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-xs">
              {history.map((h) => (
                <li key={h.id} className="rounded border border-[var(--color-border)] p-2" data-testid="rv-history-row" data-kind={h.kind} data-status={h.status ?? ""}>
                  <div className="flex flex-wrap gap-2">
                    <span className="font-medium">{h.kind === "ADMIN_EDIT" ? "Manual correction" : h.kind === "RESCAN" ? "Re-scan" : "Earlier extraction"}</span>
                    {h.status && <Badge variant={h.status === "PENDING" ? "warning" : "neutral"}>{h.status.toLowerCase().replace(/_/g, " ")}</Badge>}
                    <span className="text-[var(--color-muted-foreground)]">
                      {h.createdAt}
                      {h.actor ? ` · ${h.actor}` : ""}
                      {h.model ? ` · ${h.model}` : ""}
                    </span>
                  </div>
                  {h.note && <p className="mt-0.5">{h.note}</p>}
                  {h.changes.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {h.changes.slice(0, 12).map((c, i) => (
                        <li key={i} className="[overflow-wrap:anywhere]">
                          <span className="font-medium">{c.field}:</span> <span className="line-through opacity-70">{c.before.slice(0, 200)}</span> → {c.after.slice(0, 200)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
