"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { learnPaperMemoryAction, sourceRereadApplyAction, sourceRereadPreviewAction } from "@/app/admin/(dashboard)/ai-importer/actions";
import type { RereadAction, RereadPreview } from "@/lib/ai-import/source-reread";

const inr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `₹${v.toFixed(2)}`);
const ACTION_LABEL: Record<RereadAction, string> = { UNCHANGED: "unchanged", CHANGED: "differs", NEW: "missing from the import", NOT_IN_SOURCE: "not in the source", LOCKED: "in the Question Bank (locked)", PENDING_EXISTS: "re-scan result waiting" };
const ACTION_TONE: Record<RereadAction, "neutral" | "warning" | "error" | "info" | "success"> = { UNCHANGED: "neutral", CHANGED: "warning", NEW: "info", NOT_IN_SOURCE: "error", LOCKED: "neutral", PENDING_EXISTS: "info" };

/**
 * Review Exceptions → Source re-read: the original paper read again locally (free), a dry-run comparison question by
 * question, then the administrator's choice per question. Changed questions get a PENDING result to take field by field
 * in the question's review (nothing is overwritten); missing questions are added; questions the source does not have are
 * rejected only when ticked. Also: learn this paper's format as PROPOSED paper-memory rules.
 */
export function SourceRereadPanel({ jobId, canUse, canLearn, finished }: { jobId: string; canUse: boolean; canLearn: boolean; finished: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<RereadPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [show, setShow] = useState<"attention" | "all">("attention");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const items = useMemo(() => (preview ? preview.files.flatMap((f) => f.items.map((x) => ({ ...x, file: f.name }))) : []), [preview]);
  const pickId = (x: (typeof items)[number]) => (x.action === "NOT_IN_SOURCE" ? `reject:${x.questionId}` : `${x.action === "NEW" ? "add" : "pending"}:${x.key}`);
  const choosable = (a: RereadAction) => a === "CHANGED" || a === "NEW" || a === "NOT_IN_SOURCE";
  const visible = items.filter((x) => show === "all" || x.action !== "UNCHANGED" || x.review.length);

  const load = () =>
    start(async () => {
      setMsg({ ok: true, text: "Reading the original paper again (local, no AI)…" });
      const r = await callImporter(() => sourceRereadPreviewAction(jobId));
      if (!r.ok) return setMsg({ ok: false, text: r.error ?? "Failed" });
      setPreview(r.data);
      // Changed and missing questions are pre-selected; removing a stored question is never pre-selected.
      setPicked(new Set(r.data.files.flatMap((f) => f.items.filter((x) => x.action === "CHANGED" || x.action === "NEW").map((x) => `${x.action === "NEW" ? "add" : "pending"}:${x.key}`))));
      setMsg(null);
    });
  const apply = () =>
    start(async () => {
      const choice = { pending: [...picked].filter((p) => p.startsWith("pending:")).map((p) => p.slice(8)), add: [...picked].filter((p) => p.startsWith("add:")).map((p) => p.slice(4)), reject: [...picked].filter((p) => p.startsWith("reject:")).map((p) => p.slice(7)) };
      const r = await callImporter(() => sourceRereadApplyAction(jobId, preview!.hash, choice));
      if (!r.ok) return setMsg({ ok: false, text: r.error ?? "Failed" });
      setMsg({ ok: true, text: `Done: ${r.data.pending} result(s) waiting for your choice in the question review, ${r.data.added} missing question(s) added, ${r.data.rejected} rejected (Restore undoes it). Nothing was approved or published. Run Verify 1 (free) next to check the paper again.` });
      setPreview(null);
      router.refresh();
    });

  const t = preview?.totals;
  const chosen = { pending: [...picked].filter((p) => p.startsWith("pending:")).length, add: [...picked].filter((p) => p.startsWith("add:")).length, reject: [...picked].filter((p) => p.startsWith("reject:")).length };
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="source-reread">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={!canUse || !finished || pending} onClick={load} data-testid="reread-preview">
          Source re-read — preview
        </Button>
        {canLearn && (
          <Button variant="outline" disabled={!finished || pending} onClick={() => start(async () => {
            const r = await callImporter(() => learnPaperMemoryAction(jobId));
            setMsg(r.ok ? { ok: true, text: `Paper format learned for ${r.data.paper ?? "this paper"}: ${r.data.added} new proposal(s), ${r.data.updated} with new evidence, ${r.data.contradicted} contradiction(s). Confirm or reject them in Taxonomy Reference → Paper-format memory; nothing is used before that.` } : { ok: false, text: r.error ?? "Failed" });
          })} data-testid="learn-paper">
            Learn paper format
          </Button>
        )}
        <span className="text-xs text-[var(--color-muted-foreground)]">Reads the original Word paper again with the current reader (free, no AI) and shows every difference before anything changes.</span>
      </div>
      {msg && (
        <p className={`text-xs ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role="status" data-testid="reread-msg">
          {msg.text}
        </p>
      )}
      {preview && t && (
        <div className="flex flex-col gap-2 text-sm" data-testid="reread-report" data-hash={preview.hash}>
          <ul className="grid gap-1 text-xs sm:grid-cols-3" data-testid="reread-totals">
            <li>Questions in the source: <b data-testid="rr-source">{t.source}</b> · stored now: <b>{t.stored}</b></li>
            <li>Unchanged: <b>{t.unchanged}</b> · differ: <b data-testid="rr-changed">{t.changed}</b> · missing from the import: <b data-testid="rr-new">{t.new}</b></li>
            <li>Stored but not in the source: <b data-testid="rr-notin">{t.notInSource}</b> · locked: {t.locked} · waiting re-scan: {t.pendingExists}</li>
            <li>Official-answer corrections: <b data-testid="rr-keycorr">{t.keyCorrections}</b> · printed mark contradicts the key: <b data-testid="rr-markconf">{t.markConflicts}</b></li>
            <li>Subject proposals that differ: {t.classificationChanges} · not settled by the free classifier: {t.unclassified}</li>
            <li>Need manual review: <b>{t.manualReview}</b> · AI cost of the re-read: <b data-testid="rr-cost">{inr(0)}</b>{preview.costInr ? ` · scanned-page re-scan estimate ${inr(preview.costInr)} (not run here)` : ""}</li>
          </ul>
          <p className="text-xs" data-testid="rr-key">
            Official key: {preview.key.files.map((k) => `${k.name} — ${k.entries} entr${k.entries === 1 ? "y" : "ies"} (${k.status.toLowerCase()})`).join("; ") || "none uploaded"}
            {preview.key.expected ? ` of ${preview.key.expected} expected` : ""} · {preview.key.complete ? "complete" : <span className="text-[var(--color-warning)]">incomplete — not used for corrections</span>}
          </p>
          {preview.notes.map((n) => (
            <p key={n} className="text-xs text-[var(--color-warning)]">{n}</p>
          ))}
          {preview.files.filter((f) => f.scanned).map((f) => (
            <div key={f.fileId} className="rounded border border-[var(--color-warning)] p-2 text-xs" data-testid="rr-scanned">
              <b>{f.name}</b> (scanned, {f.scanned!.pages} pages, {f.stored} stored questions): {f.scanned!.suspectPages.length} page(s) whose printed numbers are out of sequence — the official key is not matched there until checked
              {f.scanned!.suspectPages.length ? ` (pages ${f.scanned!.suspectPages.map((p) => p.page).join(", ")})` : ""}; {f.scanned!.instructionItems.length} instruction item(s) read as questions
              {f.scanned!.missingNumbers.length ? `; missing numbers ${f.scanned!.missingNumbers.slice(0, 30).join(", ")}` : ""}. Re-scanning the out-of-sequence pages: about {inr(f.scanned!.estimateInr)} ({f.scanned!.basis}) — use Re-scan on those questions; it is priced and confirmed there.
            </div>
          ))}
          {items.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <SelectNative className="h-8 w-auto text-xs" value={show} onChange={(e) => setShow(e.target.value as "attention" | "all")} aria-label="Show">
                  <option value="attention">Only questions that differ or need review</option>
                  <option value="all">All questions</option>
                </SelectNative>
                <span>
                  Selected: {chosen.pending} pending result(s), {chosen.add} to add, {chosen.reject} to reject
                </span>
              </div>
              <div className="max-h-[32rem] overflow-auto rounded border border-[var(--color-border)]">
                <table className="w-full text-xs" data-testid="reread-items">
                  <thead className="sticky top-0 bg-[var(--color-card)]">
                    <tr className="text-left">
                      <th className="p-1">Use</th>
                      <th className="p-1">Q</th>
                      <th className="p-1">Re-read</th>
                      <th className="p-1">What differs</th>
                      <th className="p-1">Answer (printed / key)</th>
                      <th className="p-1">Subject (now → proposal)</th>
                      <th className="p-1">Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((x) => (
                      <tr key={`${x.file}|${x.key}|${x.questionId}`} className="border-t border-[var(--color-border)] align-top" data-testid="reread-item" data-action={x.action} data-key={x.key}>
                        <td className="p-1">
                          {choosable(x.action) && (
                            <input type="checkbox" aria-label={`Use the re-read for ${x.key}`} checked={picked.has(pickId(x))} disabled={!canUse || pending} onChange={(e) => {
                              const next = new Set(picked);
                              if (e.target.checked) next.add(pickId(x));
                              else next.delete(pickId(x));
                              setPicked(next);
                            }} />
                          )}
                        </td>
                        <td className="p-1 whitespace-nowrap">{x.section ? `${x.section} ` : ""}{x.number ?? "—"}</td>
                        <td className="p-1">
                          <Badge variant={ACTION_TONE[x.action]}>{ACTION_LABEL[x.action]}</Badge>
                        </td>
                        <td className="p-1">
                          {x.action === "NEW" || x.action === "NOT_IN_SOURCE" ? <span>{x.stem.slice(0, 120)}</span> : x.fields.length ? x.fields.map((f) => (
                            <div key={f.field} title={`now: ${f.current}\nre-read: ${f.next}`}>
                              <b>{f.label}</b>: <s className="text-[var(--color-muted-foreground)]">{f.current.slice(0, 60)}</s> → {f.next.slice(0, 60)}
                            </div>
                          )) : "—"}
                          {x.formats.length > 0 && <div className="text-[var(--color-muted-foreground)]">{x.formats.map((f) => f.toLowerCase().replace(/_/g, " ")).join(" · ")}</div>}
                        </td>
                        <td className="p-1 whitespace-nowrap">
                          {x.printedAnswer.join(",") || "—"} / {x.keyValue ?? "—"}
                          {x.keyCorrection && <div className="text-[var(--color-info)]">official answer would change ({x.storedOfficial.join(",") || "none"} → {x.keyValue})</div>}
                          {x.markContradictsKey && <div className="text-[var(--color-error)]">printed mark ≠ key</div>}
                        </td>
                        <td className="p-1">{x.storedSubject ?? "—"}{x.subjectProposal && x.subjectProposal !== x.storedSubject ? ` → ${x.subjectProposal}${x.topicProposal ? ` › ${x.topicProposal}` : ""}` : ""}</td>
                        <td className="p-1">{x.review.join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={!canUse || pending || !picked.size} onClick={apply} data-testid="reread-apply">
                  Apply selected ({chosen.pending + chosen.add + chosen.reject})
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => setPreview(null)}>
                  Close
                </Button>
                <span className="text-xs text-[var(--color-muted-foreground)]">Changed questions are not overwritten: each gets a result to compare field by field in its review. Subject proposals are shown only — Verify 1 classifies questions that have no subject. Nothing is approved or published.</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
