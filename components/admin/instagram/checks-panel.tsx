"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, RotateCcw, Sparkles, Stethoscope, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { loadPostAction, refreshSnapshotAction, setQuestionNumberAction } from "@/app/admin/(dashboard)/instagram/actions";
import { acceptAiProposalAction, applyFixAction, previewFixAction, proposeAiAction, recordMedicalReviewAction, type Result } from "@/app/admin/(dashboard)/instagram/repair-actions";
import type { AskCostFn, ProviderChoice } from "@/components/admin/instagram/ai-studio-panel";
import type { PostDto } from "@/lib/instagram/posts";
import type { RepairPreview, RepairResult } from "@/lib/instagram/repair";
import type { Proposal } from "@/lib/instagram/proposals";
import { CATEGORY_LABELS, checksStatus, passedChecks, type AiTarget, type IssueAdvice, type IssueCategory } from "@/lib/instagram/fixes";
import { currentMedicalReview } from "@/lib/instagram/quality";
import { FLAG_DECISIONS, FLAG_DECISION_LABELS, type FlagDecision } from "@/lib/instagram/types";
import type { QualityIssue } from "@/lib/instagram/quality";

type EditorTab = "content" | "design" | "studio";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** A suggestion value as readable text (lists one per line; trap / diagram summarized). */
function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x && "text" in x ? String((x as { text: unknown }).text) : JSON.stringify(x))).join("\n") || "—";
  const o = v as Record<string, unknown>;
  if ("question" in o && Array.isArray(o.options)) return [String(o.question), ...(o.options as { label: string; text: string }[]).map((x) => `${x.label}. ${x.text}`), `Answer: ${String(o.correct)}`, String(o.trapExplanation ?? "")].join("\n");
  if ("kind" in o && "title" in o) return [String(o.title), ...((o.nodes as { label: string }[] | undefined) ?? []).map((n) => `• ${n.label}`), ...((o.rows as { label: string; cells: string[] }[] | undefined) ?? []).map((r) => `• ${r.label}: ${r.cells.join(" | ")}`)].join("\n");
  return JSON.stringify(v);
}

/** Sections "Rewrite one section with AI" offers (one AI call each, only that section changes). */
const SECTIONS: { key: string; target: AiTarget }[] = [
  { key: "explanation", target: { kind: "content", fields: ["explanation"], label: "explanation" } },
  { key: "quickRevision", target: { kind: "content", fields: ["quickRevision"], label: "Quick Revision" } },
  { key: "hooks", target: { kind: "content", fields: ["hooks"], label: "hook" } },
  { key: "memoryTrick", target: { kind: "content", fields: ["memoryTrick"], label: "memory trick" } },
  { key: "clinicalPearl", target: { kind: "content", fields: ["clinicalPearl"], label: "clinical pearl" } },
  { key: "pearls", target: { kind: "content", fields: ["pearls"], label: "high-yield pearls" } },
  { key: "mistakes", target: { kind: "content", fields: ["mistakes"], label: "common mistakes" } },
  { key: "caption", target: { kind: "content", fields: ["caption", "hashtags"], label: "caption and hashtags" } },
  { key: "trap", target: { kind: "trap", fields: [], label: "Examiner Trap" } },
  { key: "diagram", target: { kind: "diagram", fields: [], label: "diagram" } },
];

const KEY_LABELS: Record<string, string> = {
  hooks: "Hook options",
  hookText: "Hook",
  explanation: "Explanation",
  memoryTrick: "Memory Trick",
  clinicalPearl: "Clinical Pearl",
  quickRevision: "Quick Revision",
  pearls: "High-Yield Pearls",
  mistakes: "Common Mistakes",
  finalTrick: "Final trick",
  caption: "Caption",
  hashtags: "Hashtags",
  diagram: "Diagram",
  trap: "Examiner Trap",
};

/**
 * The Checks tab: blocking issues and warnings grouped by what fixes them
 * (automatic / your input / medical review), passed checks, Master Fix and
 * per-issue Fix This Error (preview → Apply Fixes), Generate with AI
 * suggestions (Accept / Reject / Retry), the printed question number and the
 * medical review record. Works only on the SAVED post — unsaved edits must
 * be saved or discarded first, so nothing here can overwrite them.
 */
export function ChecksPanel({
  post,
  editable,
  dirty,
  provider,
  askCost,
  onPost,
  onTab,
  onStart,
}: {
  post: PostDto;
  editable: boolean;
  dirty: boolean;
  provider: ProviderChoice;
  askCost: AskCostFn;
  onPost: (p: PostDto, message: string) => void;
  onTab: (t: EditorTab) => void;
  /** Clears the editor's message bar when an action starts (so a stale result is never shown). */
  onStart: () => void;
}) {
  const [busy, start] = useTransition();
  const [error, setError] = useState<{ text: string; provider: boolean; retry?: () => void } | null>(null);
  const [preview, setPreview] = useState<{ codes: string[] | "all"; data: RepairPreview } | null>(null);
  const [result, setResult] = useState<RepairResult | null>(null);
  const [proposal, setProposal] = useState<{ target: AiTarget; data: Proposal } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [section, setSection] = useState(SECTIONS[0].key);
  const [sectionInstr, setSectionInstr] = useState("");
  const [qNumber, setQNumber] = useState(post.questionNumber ? String(post.questionNumber) : "");
  const [qVerified, setQVerified] = useState(post.questionNumberVerified);
  // Re-sync the inputs when the saved number changes (fix, undo, another tab) — adjusted during render, not in an effect.
  const savedNumber = `${post.questionNumber ?? ""}|${post.questionNumberVerified}`;
  const [syncedNumber, setSyncedNumber] = useState(savedNumber);
  if (syncedNumber !== savedNumber) {
    setSyncedNumber(savedNumber);
    setQNumber(post.questionNumber ? String(post.questionNumber) : "");
    setQVerified(post.questionNumberVerified);
  }

  const issues = post.issues;
  const adviceOf = (code: string) => post.advice.find((a) => a.code === code);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const status = checksStatus(issues, post.advice);
  const passed = passedChecks(issues, post.design);
  const autoCodes = post.advice.filter((a) => a.category === "auto").map((a) => a.code);
  const locked = !editable || dirty || busy;
  const review = currentMedicalReview(post.content);
  const staleReview = post.content.medicalReview && !review;

  function call<T>(fn: () => Promise<Result<T>>, ok: (d: T) => void, retry?: () => void) {
    setError(null);
    onStart();
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setError({ text: r.error, provider: r.kind === "provider", retry: r.kind === "provider" ? retry : undefined });
        return;
      }
      ok(r.data);
    });
  }

  const openFix = (codes: string[] | "all") => {
    setResult(null);
    call(() => previewFixAction({ postId: post.id, codes }), (data) => setPreview({ codes, data }));
  };
  const applyFix = () => {
    if (!preview) return;
    call(
      () => applyFixAction({ postId: post.id, expectedRevision: preview.data.baseRevision, planHash: preview.data.planHash, codes: preview.codes }),
      (r) => {
        setPreview(null);
        setResult(r);
        onPost(r.post, `Fixed ${r.changes.length} item(s) — revision ${r.post.revision}. Undo restores the previous version.`);
      }
    );
  };

  const generate = (target: AiTarget) => {
    const feature = target.kind === "trap" ? "ig_trap" : target.kind === "diagram" ? "ig_diagram" : "ig_carousel";
    const runIt = () =>
      askCost({ feature, context: { postId: post.id }, legacyProvider: provider !== "default" }, (quoteId) =>
        call(
          () => proposeAiAction({ postId: post.id, expectedRevision: post.revision, kind: target.kind, fields: target.fields, instruction: target.instruction, label: target.label, provider: provider === "default" ? null : provider, quoteId }),
          (data) => setProposal({ target, data }),
          runIt
        )
      );
    setProposal(null);
    runIt();
  };
  const accept = () => {
    if (!proposal) return;
    call(
      () => acceptAiProposalAction({ postId: post.id, expectedRevision: proposal.data.baseRevision, token: proposal.data.token }),
      (p) => {
        setProposal(null);
        onPost(p, `AI suggestion for the ${proposal.data.label} accepted (revision ${p.revision}). Checks re-ran; medical review is needed for the new text.`);
      }
    );
  };

  const rerun = () => call(() => loadPostAction(post.id), (p) => onPost(p, "Checks re-run on the saved version."));

  const groups: { cat: IssueCategory; items: { issue: QualityIssue; advice: IssueAdvice }[] }[] = (["auto", "admin", "medical"] as IssueCategory[]).map((cat) => ({
    cat,
    items: issues.map((issue) => ({ issue, advice: adviceOf(issue.code)! })).filter((x) => x.advice && x.advice.category === cat),
  }));

  const hasNumberIssue = post.advice.some((a) => a.action.kind === "question-number");
  const qNumberRow = (
    <div className="flex flex-wrap items-center gap-2" data-testid="q-number-row">
      <Input className="w-24" inputMode="numeric" aria-label="Printed question number" value={qNumber} onChange={(e) => setQNumber(e.target.value.replace(/\D/g, "").slice(0, 3))} disabled={!editable} data-testid="q-number" />
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={qVerified} onChange={(e) => setQVerified(e.target.checked)} disabled={!editable} data-testid="q-verified" />
        Verified against the original paper
      </label>
      <Button
        size="compact"
        variant="outline"
        disabled={locked}
        data-testid="q-save"
        onClick={() => call(() => setQuestionNumberAction(post.id, post.revision, qNumber ? Number(qNumber) : null, qVerified), (p) => onPost(p, "Question number saved."))}
      >
        Save number
      </Button>
      {post.snapshot.importPosition ? <span className="text-[11px] text-[var(--color-muted-foreground)]">{`Stored position ${post.snapshot.importPosition} is the import order, not necessarily the printed number.`}</span> : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="review-panel">
      {dirty ? (
        <p className="rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-2 text-sm" data-testid="checks-dirty">
          Save or discard your changes first — the checks and fixes below work on the saved version, so they can never overwrite unsaved edits.
        </p>
      ) : null}

      {/* Status + primary actions */}
      <section
        className={cn(
          "flex flex-col gap-3 rounded-[var(--radius-card)] border p-3",
          status.tone === "error" && "border-[var(--color-error)]/40 bg-[var(--color-error)]/5",
          status.tone === "warning" && "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5",
          status.tone === "ok" && "border-[var(--color-success)]/40 bg-[var(--color-success)]/5"
        )}
      >
        <div className="flex items-start gap-2">
          {status.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-[var(--color-success)]" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4" aria-hidden />}
          <div className="flex-1">
            <p className="text-sm font-semibold" data-testid="checks-status">{status.text}</p>
            <p className="text-xs text-[var(--color-muted-foreground)]">{`${errors.length} blocking · ${warnings.length} warning${warnings.length === 1 ? "" : "s"} · ${passed.length} passed`}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={locked || autoCodes.length === 0} onClick={() => openFix("all")} data-testid="master-fix">
            {busy && preview === null ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Wand2 className="h-4 w-4" aria-hidden />} Master Fix — Fix All Repairable Issues
            {autoCodes.length ? ` (${autoCodes.length})` : ""}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || dirty} onClick={rerun} data-testid="rerun-checks">
            <RefreshCw className="h-4 w-4" aria-hidden /> Re-run Checks
          </Button>
        </div>
        {autoCodes.length === 0 && issues.length ? <p className="text-xs text-[var(--color-muted-foreground)]">Nothing left that can be fixed automatically — see the items below.</p> : null}
      </section>

      {error ? (
        <div role="alert" data-testid={error.provider ? "provider-error" : "checks-error"} className="flex flex-wrap items-start gap-2 rounded-md border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 p-2 text-sm">
          <span className="flex-1">
            {error.provider ? <span className="font-semibold">{`${CATEGORY_LABELS.provider}: `}</span> : null}
            {error.text}
          </span>
          {error.retry ? (
            <Button size="compact" variant="outline" onClick={error.retry} data-testid="provider-retry">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry
            </Button>
          ) : null}
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}

      {/* Fix preview: nothing is saved until Apply Fixes */}
      {preview ? (
        <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-primary)]/40 p-3" data-testid="fix-preview">
          <h3 className="text-sm font-semibold">{preview.codes === "all" ? "Master Fix — proposed changes" : "Fix This Error — proposed change"}</h3>
          {preview.data.changes.length === 0 ? (
            <p className="text-sm">Nothing can be fixed automatically right now.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {[...new Set(preview.data.changes.map((c) => c.group))].map((g) => (
                <li key={g} className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">{g}</span>
                  {preview.data.changes
                    .filter((c) => c.group === g)
                    .map((c, i) => (
                      <div key={`${c.target}-${i}`} className="grid gap-1 rounded-md border border-[var(--color-border)] p-2 text-sm sm:grid-cols-[8rem_1fr]" data-testid="fix-change">
                        <span className="text-xs font-medium">{c.target}</span>
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className="whitespace-pre-wrap break-words text-[var(--color-error)] line-through decoration-1">{c.before || "—"}</span>
                          <span className="whitespace-pre-wrap break-words text-[var(--color-success)]">{c.after || "—"}</span>
                        </div>
                      </div>
                    ))}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs" data-testid="fix-before-after">{`Before: ${preview.data.before.errors} blocking, ${preview.data.before.warnings} warnings → after: ${preview.data.after.errors} blocking, ${preview.data.after.warnings} warnings.`}</p>
          {preview.data.remaining.length ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">{`Still needed after the fix: ${preview.data.remaining.filter((r) => r.advice.category === "admin").length} item(s) need your input, ${preview.data.remaining.filter((r) => r.advice.category === "medical").length} need medical review.`}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={locked || preview.data.changes.length === 0} onClick={applyFix} data-testid="apply-fixes">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Apply Fixes
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setPreview(null)} data-testid="cancel-fixes">
              Cancel
            </Button>
          </div>
        </section>
      ) : null}

      {result ? (
        <section className="flex flex-col gap-1 rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/5 p-3 text-sm" data-testid="fix-result">
          <span className="font-semibold">{`Applied ${result.changes.length} fix(es).`}</span>
          <span>{`Before: ${result.before.errors} blocking, ${result.before.warnings} warnings → now: ${result.after.errors} blocking, ${result.after.warnings} warnings.`}</span>
          {result.rendered.length ? <span className="text-xs text-[var(--color-muted-foreground)]">{`Re-rendered slide${result.rendered.length === 1 ? "" : "s"} ${result.rendered.map((r) => r.slide).join(", ")} (${result.rendered[0].width}×${result.rendered[0].height}).`}</span> : null}
        </section>
      ) : null}

      {/* AI suggestion: old vs new, nothing saved until Accept */}
      {proposal ? (
        <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-primary)]/40 p-3" data-testid="ai-proposal">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4" aria-hidden /> {`AI suggestion — ${proposal.data.label}`}
          </h3>
          {proposal.data.diff.map((d) => (
            <div key={d.key} className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-[var(--color-muted-foreground)]">{`${KEY_LABELS[d.key] ?? d.key} — current`}</span>
                <p className="whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface)] p-2" data-testid="proposal-before">{show(d.before)}</p>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-[var(--color-muted-foreground)]">{`${KEY_LABELS[d.key] ?? d.key} — suggested`}</span>
                <p className="whitespace-pre-wrap break-words rounded-md border border-[var(--color-primary)]/30 p-2" data-testid="proposal-after">{show(d.after)}</p>
              </div>
            </div>
          ))}
          {proposal.data.flags.length ? <p className="text-xs">{`New AI notes for the reviewer: ${proposal.data.flags.join(" · ")}`}</p> : null}
          <p className="text-xs text-[var(--color-muted-foreground)]">The question, options and answer key are unchanged. Accepted text is AI-generated and still needs medical review. Undo or History restores the current version.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={locked} onClick={accept} data-testid="proposal-accept">
              Accept
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setProposal(null)} data-testid="proposal-reject">
              Reject
            </Button>
            <Button size="sm" variant="outline" disabled={locked} onClick={() => generate(proposal.target)} data-testid="proposal-retry">
              <RotateCcw className="h-4 w-4" aria-hidden /> Retry
            </Button>
          </div>
        </section>
      ) : null}

      {issues.length === 0 ? <p className="text-sm text-[var(--color-success)]">No problems found.</p> : null}

      {/* Issues grouped by what fixes them */}
      <div className="flex flex-col gap-4" data-testid="issue-list">
      {groups
        .filter((g) => g.items.length)
        .map((g) => (
          <section key={g.cat} className="flex flex-col gap-2" data-testid={`group-${g.cat}`}>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              {g.cat === "medical" ? <Stethoscope className="h-4 w-4" aria-hidden /> : g.cat === "auto" ? <Wand2 className="h-4 w-4" aria-hidden /> : null}
              {`${CATEGORY_LABELS[g.cat]} (${g.items.length})`}
            </h3>
            <ul className="flex flex-col gap-1.5" data-testid={`issues-${g.cat}`}>
              {g.items.map(({ issue, advice }) => (
                <li
                  key={issue.code}
                  data-code={issue.code}
                  data-category={advice.category}
                  className={cn("flex flex-col gap-2 rounded-md border p-2 text-sm", issue.severity === "error" ? "border-[var(--color-error)]/40 bg-[var(--color-error)]/5" : "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5")}
                >
                  <div className="flex flex-wrap items-start gap-2">
                    <Badge variant={issue.severity === "error" ? "error" : "warning"}>{issue.severity === "error" ? "Blocking" : "Warning"}</Badge>
                    <span className="min-w-0 flex-1 break-words">{issue.message}</span>
                  </div>
                  <p className="text-xs text-[var(--color-muted-foreground)]">{advice.next}</p>
                  <div className="flex flex-wrap gap-2">
                    {advice.action.kind === "fix" ? (
                      <Button size="compact" disabled={locked} onClick={() => openFix([issue.code])} data-testid="fix-this">
                        <Wand2 className="h-3.5 w-3.5" aria-hidden /> Fix This Error
                      </Button>
                    ) : null}
                    {advice.ai ? (
                      <Button size="compact" variant="outline" disabled={locked} onClick={() => generate(advice.ai!)} data-testid="generate-ai">
                        <Sparkles className="h-3.5 w-3.5" aria-hidden /> Generate with AI
                      </Button>
                    ) : null}
                    {advice.action.kind === "tab" ? (
                      <Button size="compact" variant="ghost" onClick={() => onTab((advice.action as { tab: EditorTab }).tab)}>
                        {advice.action.label}
                      </Button>
                    ) : null}
                    {advice.action.kind === "link" ? (
                      <a className="inline-flex h-7 items-center rounded-[var(--radius-button)] px-2 text-xs underline" href={advice.action.href} target="_blank" rel="noreferrer">
                        {advice.action.label}
                      </a>
                    ) : null}
                    {advice.action.kind === "refresh-snapshot" ? (
                      <Button size="compact" variant="outline" disabled={locked} onClick={() => call(() => refreshSnapshotAction(post.id, post.revision), (p) => onPost(p, "Snapshot refreshed from the Question Bank. Check the slides again before publishing."))}>
                        Refresh snapshot
                      </Button>
                    ) : null}
                    {advice.action.kind === "medical-review" ? (
                      <Button size="compact" variant="outline" disabled={locked} onClick={() => setReviewOpen(true)} data-testid="open-medical-review">
                        <Stethoscope className="h-3.5 w-3.5" aria-hidden /> Review
                      </Button>
                    ) : null}
                  </div>
                  {advice.action.kind === "question-number" ? qNumberRow : null}
                </li>
              ))}
            </ul>
          </section>
        ))}

      </div>

      {post.series === "PYQ" && !hasNumberIssue ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Printed question number</h3>
          <p className="text-xs text-[var(--color-muted-foreground)]">Optional on every template. Shown on the slide only when verified against the original paper.</p>
          {qNumberRow}
        </section>
      ) : null}

      {/* Medical review */}
      <section className="flex flex-col gap-2" data-testid="medical-review">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Stethoscope className="h-4 w-4" aria-hidden /> Medical review
        </h3>
        {review ? (
          <p className="text-sm" data-testid="medical-review-status">
            {`${review.fullReview ? "Medical review recorded" : "AI notes decided"} by ${review.reviewerName} on ${fmt(review.at)}${review.fullReview ? "" : " (the full content is not reviewed yet)"}.`}
            {review.note ? ` Note: ${review.note}` : ""}
          </p>
        ) : (
          <p className="text-sm text-[var(--color-muted-foreground)]" data-testid="medical-review-status">
            {staleReview ? "The earlier medical review no longer applies — the text changed after it was recorded." : "No medical review recorded. AI-generated content is shown as unreviewed until a reviewer records one."}
          </p>
        )}
        {reviewOpen ? (
          <MedicalReviewForm post={post} disabled={locked} onCancel={() => setReviewOpen(false)} onSubmit={(input) => call(() => recordMedicalReviewAction({ postId: post.id, expectedRevision: post.revision, ...input }), (p) => (setReviewOpen(false), onPost(p, "Medical review recorded.")))} />
        ) : editable ? (
          <div>
            <Button size="sm" variant="outline" disabled={locked} onClick={() => setReviewOpen(true)} data-testid="open-medical-review-main">
              Record medical review
            </Button>
          </div>
        ) : null}
      </section>

      {/* Regenerate one section on request (e.g. after a medical review finds a weak explanation) */}
      {editable ? (
        <section className="flex flex-col gap-2" data-testid="section-ai">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4" aria-hidden /> Rewrite one section with AI
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <SelectNative className="h-8 w-auto text-xs" value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section" data-testid="section-ai-pick">
              {SECTIONS.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.target.label[0].toUpperCase() + x.target.label.slice(1)}
                </option>
              ))}
            </SelectNative>
            <Input className="h-8 min-w-[12rem] flex-1 text-xs" placeholder="Optional instruction, e.g. simpler, mention the initial investigation" value={sectionInstr} onChange={(e) => setSectionInstr(e.target.value)} data-testid="section-ai-instruction" />
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              data-testid="section-ai-generate"
              onClick={() => {
                const t = SECTIONS.find((x) => x.key === section)!.target;
                generate({ ...t, ...(sectionInstr.trim() ? { instruction: sectionInstr.trim() } : {}) });
              }}
            >
              <Sparkles className="h-4 w-4" aria-hidden /> Generate with AI
            </Button>
          </div>
          <p className="text-xs text-[var(--color-muted-foreground)]">Only the chosen section is regenerated, shown next to the current text first. The question, answer key, source and printed number never change.</p>
        </section>
      ) : null}

      {/* Passed checks */}
      <details className="text-sm" data-testid="passed-checks">
        <summary className="cursor-pointer text-sm font-semibold">{`Passed checks (${passed.length})`}</summary>
        <ul className="mt-2 flex flex-col gap-1">
          {passed.map((p) => (
            <li key={p} className="flex items-center gap-2 text-[var(--color-success)]">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              <span className="text-[var(--color-foreground)]">{p}</span>
            </li>
          ))}
        </ul>
      </details>

      <p className="text-xs text-[var(--color-muted-foreground)]">
        Blocking issues must be fixed before publishing. Warnings are shown again in the final &quot;Publish to Instagram?&quot; confirmation. Fixes and accepted AI suggestions are saved as revisions — Undo restores the previous version.
      </p>
    </div>
  );
}

function MedicalReviewForm({
  post,
  disabled,
  onCancel,
  onSubmit,
}: {
  post: PostDto;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (input: { fullReview: boolean; attested: boolean; note: string; flags: { flag: string; decision: string; note: string }[] }) => void;
}) {
  const review = currentMedicalReview(post.content);
  const open = post.content.aiFlags.filter((f) => !review?.flags.some((x) => x.flag === f));
  const [decisions, setDecisions] = useState<Record<string, { decision: FlagDecision | ""; note: string }>>(() => Object.fromEntries(open.map((f) => [f, { decision: "", note: "" }])));
  const [fullReview, setFullReview] = useState(!review?.fullReview);
  const [attested, setAttested] = useState(false);
  const [note, setNote] = useState("");
  const decided = Object.entries(decisions).filter(([, d]) => d.decision);
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="medical-review-form">
      {open.map((f, i) => (
        <fieldset key={f} className="flex flex-col gap-1.5 rounded-md border border-[var(--color-border)] p-2" data-testid={`flag-${i}`}>
          <legend className="px-1 text-xs font-semibold">AI note</legend>
          <p className="text-sm">{f}</p>
          {FLAG_DECISIONS.map((d) => (
            <label key={d} className="flex items-start gap-2 text-xs">
              <input type="radio" name={`flag-${i}`} checked={decisions[f]?.decision === d} onChange={() => setDecisions({ ...decisions, [f]: { ...decisions[f], decision: d } })} className="mt-0.5" />
              {FLAG_DECISION_LABELS[d]}
            </label>
          ))}
          <Input placeholder="Reviewer note (required for exam context)" value={decisions[f]?.note ?? ""} onChange={(e) => setDecisions({ ...decisions, [f]: { ...decisions[f], note: e.target.value } })} data-testid={`flag-note-${i}`} />
        </fieldset>
      ))}
      {open.length === 0 && post.content.aiFlags.length ? <p className="text-xs text-[var(--color-muted-foreground)]">Every AI note already has a reviewer decision.</p> : null}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={fullReview} onChange={(e) => setFullReview(e.target.checked)} className="mt-1" data-testid="review-full" />
        I checked every medical statement on these slides (explanation, trick, pearls, revision points, mistakes, diagram, Examiner Trap and image).
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-1" data-testid="review-attest" />
        I am qualified to review this content and checked it against a standard medical reference.
      </label>
      <Textarea rows={2} placeholder="Review note (optional)" value={note} onChange={(e) => setNote(e.target.value)} data-testid="review-note" />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={disabled || !attested || (!fullReview && decided.length === 0)}
          data-testid="review-submit"
          onClick={() => onSubmit({ fullReview, attested, note, flags: decided.map(([flag, d]) => ({ flag, decision: d.decision, note: d.note })) })}
        >
          Record medical review
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-[var(--color-muted-foreground)]">The record covers exactly the current text. Any later edit or AI regeneration makes it lapse, and the warnings come back.</p>
    </div>
  );
}
