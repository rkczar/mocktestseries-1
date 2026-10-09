"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, ClipboardCopy, Download, ExternalLink, Flag, ImageIcon, Link2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SelectNative } from "@/components/ui/select-native";
import { COPY_ISSUE_LABEL, type CopyIssue } from "@/lib/question-insights-format";
import type { InsightRow, InsightSort, InsightTab } from "@/lib/question-insights";
import { prepareCopyAction, selectTopQuestionsAction } from "./actions";

type Row = Omit<InsightRow, "lastReportedAt"> & { lastReportedAt?: string };
type Prepared = Extract<Awaited<ReturnType<typeof prepareCopyAction>>, { ok: true }>["data"];

const REVIEW_REASONS = [
  "High report count",
  "Unusually high wrong rate",
  "Answer-key concern",
  "Ambiguous question",
  "Image issue",
  "Explanation issue",
];

const BLOCK_MODES = [
  { value: 0, label: "All selected in one block" },
  { value: 5, label: "5 questions per block" },
  { value: 10, label: "10 questions per block" },
];

const EMPTY_LABEL: Record<InsightTab, string> = {
  wrong: "No answered questions match these filters in this period.",
  attempted: "No answered questions match these filters in this period.",
  reported: "No questions were reported in this period.",
  saved: "No questions were saved in this period.",
  ai: "No Ask AI opens in this period.",
};

/**
 * Copies text with the async Clipboard API, falling back to a hidden
 * textarea + execCommand (non-secure contexts, older WebViews). Resolves
 * true only when the browser actually reports success.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function pct(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

function RowBadges({ r }: { r: Row }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {r.keyIssue && (
        <Badge variant="error" title={COPY_ISSUE_LABEL[r.keyIssue as CopyIssue]}>
          DATA ISSUE · {COPY_ISSUE_LABEL[r.keyIssue as CopyIssue]}
        </Badge>
      )}
      {r.keyChanged && (
        <Badge variant="warning" title="Some answers in this period were scored against an earlier answer key">
          Answer key changed
        </Badge>
      )}
      {r.reviewRequired && <Badge variant="warning">Needs Review{r.reviewReason ? ` · ${r.reviewReason}` : ""}</Badge>}
      {r.hasImage && (
        <Badge variant="info">
          <ImageIcon className="mr-1 h-3 w-3" aria-hidden />
          Image Required
        </Badge>
      )}
      {r.status !== "PUBLISHED" && <Badge variant="neutral">{r.status}</Badge>}
    </div>
  );
}

export function InsightTable({
  tab,
  query,
  rows,
  total,
  page,
  pageCount,
  pageSize,
  minAttempts,
  sort,
  canManage,
  exportHref,
  prevHref,
  nextHref,
}: {
  tab: InsightTab;
  query: string;
  rows: Row[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  minAttempts: number;
  sort: InsightSort;
  canManage: boolean;
  exportHref: string;
  prevHref: string | null;
  nextHref: string | null;
}) {
  const router = useRouter();
  // Selection survives pagination (this component is keyed by the filters, not the page).
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, startBusy] = useTransition();
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Copy preview state.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [source, setSource] = useState<{ ids?: string[]; top?: number } | null>(null);
  const [blockSize, setBlockSize] = useState(0);
  const [includeExplanation, setIncludeExplanation] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [copiedBlock, setCopiedBlock] = useState<number | null>(null);
  const [copyMessage, setCopyMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [preparing, startPreparing] = useTransition();

  // Needs Review dialog.
  const [reviewIds, setReviewIds] = useState<string[] | null>(null);
  const [reviewReason, setReviewReason] = useState(REVIEW_REASONS[0]);
  const [reviewSaving, startReviewSaving] = useTransition();
  const [reviewError, setReviewError] = useState<string | null>(null);

  const selectedSet = new Set(selected);
  const visibleIds = rows.map((r) => r.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((x) => selectedSet.has(x));

  function toggle(id: string, on: boolean) {
    setSelected((prev) => (on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)));
  }

  function selectTop(n: number) {
    setNotice(null);
    startBusy(async () => {
      const res = await selectTopQuestionsAction(query, n);
      if (!res.ok) return setNotice({ kind: "error", text: res.error });
      setSelected(res.data);
      setNotice({ kind: "ok", text: `Selected the top ${res.data.length} question${res.data.length === 1 ? "" : "s"} in this ranking.` });
    });
  }

  function runPrepare(src: { ids?: string[]; top?: number }, size: number, withExplanation: boolean) {
    setPreviewError(null);
    setCopiedBlock(null);
    setCopyMessage(null);
    startPreparing(async () => {
      const res = await prepareCopyAction({ query, ...src, blockSize: size, includeExplanation: withExplanation });
      if (!res.ok) {
        setPrepared(null);
        setPreviewError(res.error);
        return;
      }
      setPrepared(res.data);
    });
  }

  function openPreview(src: { ids?: string[]; top?: number }) {
    setSource(src);
    setPrepared(null);
    setPreviewOpen(true);
    runPrepare(src, blockSize, includeExplanation);
  }

  async function copyBlock(index: number) {
    if (!prepared) return;
    const block = prepared.blocks[index];
    const ok = await copyText(block.text);
    const count = block.to - block.from + 1;
    if (ok) {
      setCopiedBlock(index);
      setCopyMessage({ kind: "ok", text: `${count} question${count === 1 ? "" : "s"} copied${prepared.blocks.length > 1 ? ` (Block ${index + 1})` : ""}` });
    } else {
      setCopiedBlock(null);
      setCopyMessage({ kind: "error", text: "The browser blocked clipboard access. Select the text in the box and copy it manually." });
    }
  }

  async function copyImageLink(link: string) {
    const ok = await copyText(link);
    setNotice(ok ? { kind: "ok", text: "Image link copied" } : { kind: "error", text: "The browser blocked clipboard access." });
  }

  function saveReview(ids: string[], reviewRequired: boolean, reason?: string) {
    setReviewError(null);
    startReviewSaving(async () => {
      const res = await fetch("/api/admin/questions/bulk-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "SET_REVIEW_REQUIRED", ids, reviewRequired, reviewReason: reason }),
      }).catch(() => null);
      if (!res || !res.ok) {
        const msg = res?.status === 403 ? "You don't have permission to change question review status." : "Could not update review status. Try again.";
        if (reviewIds) setReviewError(msg);
        else setNotice({ kind: "error", text: msg });
        return;
      }
      setReviewIds(null);
      setNotice({ kind: "ok", text: reviewRequired ? `Marked ${ids.length} question${ids.length === 1 ? "" : "s"} as Needs Review.` : "Review flag cleared." });
      router.refresh();
    });
  }

  const answerTab = tab === "wrong" || tab === "attempted";
  const firstRank = (page - 1) * pageSize + 1;
  const sortLabel = answerTab
    ? { wrong: "most wrong answers", wrongPct: "highest wrong %", attempts: "most attempts", reports: "most reports", saves: "most saves" }[sort]
    : { reported: "report count", saved: "save count", ai: "Ask AI opens" }[tab as "reported" | "saved" | "ai"];

  const actions = (r: Row) => (
    <div className="flex flex-wrap items-center gap-1">
      <Button asChild size="compact" variant="outline" title="Open the question for review / editing">
        <Link href={`/admin/questions/add?id=${r.id}`} target="_blank">
          <ExternalLink className="h-3 w-3" aria-hidden />
          Open / Edit
        </Link>
      </Button>
      {canManage &&
        (r.reviewRequired ? (
          <Button size="compact" variant="ghost" disabled={reviewSaving} onClick={() => saveReview([r.id], false)}>
            Clear Review
          </Button>
        ) : (
          <Button size="compact" variant="ghost" onClick={() => setReviewIds([r.id])}>
            <Flag className="h-3 w-3" aria-hidden />
            Needs Review
          </Button>
        ))}
      {r.imageLink && (
        <Button size="compact" variant="ghost" onClick={() => copyImageLink(r.imageLink!)} title="Copy the public image link">
          <Link2 className="h-3 w-3" aria-hidden />
          Copy Image Link
        </Button>
      )}
    </div>
  );

  return (
    <>
      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>
                {total.toLocaleString("en-IN")} question{total === 1 ? "" : "s"}
              </CardTitle>
              <CardDescription>
                Ranked by {sortLabel}
                {answerTab && minAttempts > 1 ? ` · at least ${minAttempts} valid attempts` : ""}
                {answerTab && " · wrong % = wrong ÷ answered (skipped questions are not counted)"}
              </CardDescription>
            </div>
            <Button asChild size="sm" variant="outline">
              <a href={exportHref}>
                <Download className="h-3.5 w-3.5" aria-hidden />
                Export CSV
              </a>
            </Button>
          </div>

          {/* Copy actions — the primary workflow (QUESTIONS_MANAGE, enforced server-side too) */}
          {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="cta" disabled={total === 0} onClick={() => openPreview({ top: 10 })}>
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
              Copy Top 10
            </Button>
            <Button size="sm" variant="cta" disabled={total === 0} onClick={() => openPreview({ top: 20 })}>
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
              Copy Top 20
            </Button>
            <Button size="sm" variant="primary" disabled={selected.length === 0} onClick={() => openPreview({ ids: selected })}>
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
              Copy Selected ({selected.length})
            </Button>
          </div>
          )}

          {/* Selection controls */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
            <span className="font-medium text-[var(--color-foreground)]">{selected.length} selected</span>
            <span className="text-[var(--color-muted-foreground)]">·</span>
            {canManage && [10, 20, 50].map((n) => (
              <Button key={n} size="compact" variant="secondary" disabled={busy || total === 0} onClick={() => selectTop(n)}>
                Top {n}
              </Button>
            ))}
            <Button
              size="compact"
              variant="ghost"
              disabled={rows.length === 0}
              onClick={() => setSelected((prev) => (allVisibleSelected ? prev.filter((x) => !visibleIds.includes(x)) : Array.from(new Set([...prev, ...visibleIds]))))}
            >
              {allVisibleSelected ? "Unselect Visible" : "Select All Visible"}
            </Button>
            <Button size="compact" variant="ghost" disabled={selected.length === 0} onClick={() => setSelected([])}>
              Clear Selection
            </Button>
            {canManage && selected.length > 0 && (
              <Button size="compact" variant="ghost" onClick={() => setReviewIds(selected)}>
                <Flag className="h-3 w-3" aria-hidden />
                Mark Selected Needs Review
              </Button>
            )}
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-muted-foreground)]" aria-label="Loading" />}
          </div>
          {notice && (
            <p role="status" className={`text-xs font-medium ${notice.kind === "ok" ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>
              {notice.text}
            </p>
          )}
        </CardHeader>

        <CardContent>
          {rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">
              <p>{EMPTY_LABEL[tab]}</p>
              {answerTab && minAttempts > 1 && <p className="mt-1">Try a lower “Minimum attempts” or a longer date range.</p>}
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[960px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                      <th className="w-8 py-2 pr-2">
                        <Checkbox
                          aria-label="Select all visible"
                          checked={allVisibleSelected}
                          onCheckedChange={(v) =>
                            setSelected((prev) => (v ? Array.from(new Set([...prev, ...visibleIds])) : prev.filter((x) => !visibleIds.includes(x))))
                          }
                        />
                      </th>
                      <th className="w-8 py-2 pr-2">#</th>
                      <th className="py-2 pr-4">Question</th>
                      <th className="py-2 pr-4">Subject / Topic</th>
                      <th className="py-2 pr-3 text-right">Attempts</th>
                      <th className="py-2 pr-3 text-right">Correct</th>
                      <th className="py-2 pr-3 text-right">Wrong</th>
                      <th className="py-2 pr-3 text-right">Wrong %</th>
                      {tab === "reported" ? (
                        <>
                          <th className="py-2 pr-3 text-right">Reports</th>
                          <th className="py-2 pr-3 text-right">Reporters</th>
                          <th className="py-2 pr-3">Reasons</th>
                          <th className="py-2 pr-3">Last Report</th>
                        </>
                      ) : tab === "ai" ? (
                        <>
                          <th className="py-2 pr-3 text-right">AI Opens</th>
                          <th className="py-2 pr-3 text-right">Students</th>
                        </>
                      ) : (
                        <>
                          <th className="py-2 pr-3 text-right">Reports</th>
                          <th className="py-2 pr-3 text-right">Saves</th>
                        </>
                      )}
                      <th className="py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                        <td className="py-2.5 pr-2">
                          <Checkbox aria-label={`Select ${r.code}`} checked={selectedSet.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} />
                        </td>
                        <td className="py-2.5 pr-2 text-[var(--color-muted-foreground)]">{firstRank + i}</td>
                        <td className="max-w-md py-2.5 pr-4">
                          <span className="font-mono text-xs text-[var(--color-muted-foreground)]">{r.code}</span>
                          <p className="text-[var(--color-foreground)]">{r.textPreview}</p>
                          <RowBadges r={r} />
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                          <span className="text-[var(--color-foreground)]">{r.subjectName}</span>
                          {r.topicName && <br />}
                          {r.topicName}
                          {r.subTopicName ? ` › ${r.subTopicName}` : ""}
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums">{r.attempts}</td>
                        <td className="py-2.5 pr-3 text-right tabular-nums">{r.correct}</td>
                        <td className="py-2.5 pr-3 text-right font-medium tabular-nums">{r.wrong}</td>
                        <td className="py-2.5 pr-3 text-right font-medium tabular-nums">{pct(r.wrongPct)}</td>
                        {tab === "reported" ? (
                          <>
                            <td className="py-2.5 pr-3 text-right font-medium tabular-nums">
                              {r.reports}
                              {r.openReports ? <span className="block text-[10px] font-normal text-[var(--color-warning)]">{r.openReports} open</span> : null}
                            </td>
                            <td className="py-2.5 pr-3 text-right tabular-nums">{r.reporters}</td>
                            <td className="py-2.5 pr-3 text-xs text-[var(--color-muted-foreground)]">{(r.reportTypes ?? []).map((t) => t.replace(/_/g, " ").toLowerCase()).join(", ")}</td>
                            <td className="py-2.5 pr-3 text-xs text-[var(--color-muted-foreground)]">
                              {r.lastReportedAt ? new Date(r.lastReportedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "—"}
                            </td>
                          </>
                        ) : tab === "ai" ? (
                          <>
                            <td className="py-2.5 pr-3 text-right font-medium tabular-nums">{r.aiViews ?? 0}</td>
                            <td className="py-2.5 pr-3 text-right tabular-nums">{r.aiStudents ?? 0}</td>
                          </>
                        ) : (
                          <>
                            <td className="py-2.5 pr-3 text-right tabular-nums">{r.reports}</td>
                            <td className="py-2.5 pr-3 text-right tabular-nums">{r.saves}</td>
                          </>
                        )}
                        <td className="py-2.5">{actions(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <ul className="flex flex-col gap-3 md:hidden">
                {rows.map((r, i) => (
                  <li key={r.id} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
                    <div className="flex items-start gap-3">
                      <Checkbox className="mt-0.5" aria-label={`Select ${r.code}`} checked={selectedSet.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} />
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-xs text-[var(--color-muted-foreground)]">
                          #{firstRank + i} · {r.code}
                        </p>
                        <p className="text-sm text-[var(--color-foreground)]">{r.textPreview}</p>
                        <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                          {r.subjectName}
                          {r.topicName ? ` › ${r.topicName}` : ""}
                        </p>
                        <RowBadges r={r} />
                        <dl className="mt-2 grid grid-cols-4 gap-1 text-center text-xs">
                          {[
                            ["Attempts", r.attempts],
                            ["Wrong", r.wrong],
                            ["Wrong %", pct(r.wrongPct)],
                            tab === "ai" ? ["AI Opens", r.aiViews ?? 0] : tab === "saved" ? ["Saves", r.saves] : ["Reports", r.reports],
                          ].map(([label, value]) => (
                            <div key={String(label)} className="rounded-md bg-[color-mix(in_srgb,var(--color-foreground)_5%,transparent)] py-1">
                              <dt className="text-[10px] uppercase text-[var(--color-muted-foreground)]">{label}</dt>
                              <dd className="font-semibold tabular-nums text-[var(--color-foreground)]">{value}</dd>
                            </div>
                          ))}
                        </dl>
                        <div className="mt-2">{actions(r)}</div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {pageCount > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm text-[var(--color-muted-foreground)]">
              <span>
                Page {page} of {pageCount}
              </span>
              <div className="flex gap-2">
                {prevHref ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={prevHref} scroll={false}>
                      Previous
                    </Link>
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled>
                    Previous
                  </Button>
                )}
                {nextHref ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={nextHref} scroll={false}>
                      Next
                    </Link>
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled>
                    Next
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Copy preview */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Copy preview</DialogTitle>
            <DialogDescription>Plain text that pastes cleanly into Telegram, WhatsApp or email. Nothing is sent anywhere.</DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              Copy as
              <SelectNative
                className="h-9"
                value={blockSize}
                disabled={preparing}
                onChange={(e) => {
                  const size = Number(e.target.value);
                  setBlockSize(size);
                  if (source) runPrepare(source, size, includeExplanation);
                }}
              >
                {BLOCK_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </SelectNative>
            </label>
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-[var(--color-foreground)]">
              <Checkbox
                checked={includeExplanation}
                disabled={preparing}
                onCheckedChange={(v) => {
                  setIncludeExplanation(v === true);
                  if (source) runPrepare(source, blockSize, v === true);
                }}
              />
              Include explanation
            </label>
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
            {preparing && (
              <p className="flex items-center gap-2 py-6 text-sm text-[var(--color-muted-foreground)]">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Preparing…
              </p>
            )}
            {previewError && !preparing && <p className="py-4 text-sm font-medium text-[var(--color-error)]">{previewError}</p>}
            {prepared && !preparing && (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  Selected questions: <span className="font-medium text-[var(--color-foreground)]">{prepared.ids.length}</span> · Copying:{" "}
                  <span className="font-medium text-[var(--color-foreground)]">{prepared.includedCount}</span> · Copy mode:{" "}
                  <span className="font-medium text-[var(--color-foreground)]">{blockSize === 0 ? "All" : `${blockSize} per block`}</span> · Include
                  explanation: <span className="font-medium text-[var(--color-foreground)]">{includeExplanation ? "Yes" : "No"}</span>
                </p>

                {prepared.excluded.length > 0 && (
                  <div className="rounded-md border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 p-2.5 text-xs text-[var(--color-foreground)]">
                    <p className="flex items-center gap-1.5 font-semibold text-[var(--color-error)]">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {prepared.excluded.length} left out — DATA ISSUE / NEEDS REVIEW
                    </p>
                    <ul className="mt-1 list-disc pl-5">
                      {prepared.excluded.map((e) => (
                        <li key={e.id}>
                          {e.code}: {COPY_ISSUE_LABEL[e.issue]}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {prepared.keyChangedCodes.length > 0 && (
                  <p className="rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-2.5 text-xs">
                    The answer key changed after students attempted {prepared.keyChangedCodes.join(", ")}. The copy uses the current answer, but the wrong %
                    was scored against the earlier key.
                  </p>
                )}
                {prepared.imageCodes.length > 0 && (
                  <p className="rounded-md border border-[var(--color-info)]/40 bg-[var(--color-info)]/10 p-2.5 text-xs">
                    🖼 Image required for {prepared.imageCodes.join(", ")}. Images are not copied. The text says “view it on MockTestSeries.in”; share the image
                    separately (Copy Image Link) if you need to.
                  </p>
                )}
                {prepared.noAttemptCodes.length > 0 && (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    No answered attempts in this period for {prepared.noAttemptCodes.join(", ")}, so the wrong % line is left out for them.
                  </p>
                )}
                {prepared.missingExplanationCodes.length > 0 && (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    No saved explanation for {prepared.missingExplanationCodes.join(", ")}, so none is included for them. Nothing is generated.
                  </p>
                )}

                {prepared.blocks.map((b, i) => (
                  <div key={i} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--color-foreground)]">
                        {prepared.blocks.length > 1 ? `Block ${i + 1} — Q${b.from}–Q${b.to}` : `Q${b.from}–Q${b.to}`}
                      </span>
                      <Button size="sm" variant={copiedBlock === i ? "success" : "cta"} onClick={() => copyBlock(i)}>
                        {copiedBlock === i ? <Check className="h-3.5 w-3.5" aria-hidden /> : <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />}
                        {copiedBlock === i ? "Copied" : "Copy"}
                      </Button>
                    </div>
                    <textarea
                      readOnly
                      value={b.text}
                      onFocus={(e) => e.currentTarget.select()}
                      className="h-48 w-full resize-y rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-xs text-[var(--color-foreground)]"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {copyMessage && (
            <p role="status" className={`mt-2 text-sm font-medium ${copyMessage.kind === "ok" ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>
              {copyMessage.text}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              {copiedBlock !== null ? "Done" : "Cancel"}
            </Button>
            {prepared && prepared.blocks.length === 1 && !preparing && (
              <Button variant="cta" onClick={() => copyBlock(0)}>
                <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
                Copy
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Needs Review */}
      <Dialog open={reviewIds !== null} onOpenChange={(open) => !open && setReviewIds(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark Needs Review</DialogTitle>
            <DialogDescription>
              Sets the existing Question Bank “Review Required” flag on {reviewIds?.length ?? 0} question{reviewIds?.length === 1 ? "" : "s"}. It does not
              change the question’s status, and students are not affected.
            </DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
            Reason
            <SelectNative value={reviewReason} onChange={(e) => setReviewReason(e.target.value)} className="h-9">
              {REVIEW_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </SelectNative>
          </label>
          {reviewError && <p className="mt-2 text-sm text-[var(--color-error)]">{reviewError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewIds(null)}>
              Cancel
            </Button>
            <Button disabled={reviewSaving} onClick={() => reviewIds && saveReview(reviewIds, true, reviewReason)}>
              {reviewSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Mark Needs Review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
