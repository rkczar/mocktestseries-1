"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ANSWER_STATUS_LABELS, ISSUE_DEFS, QUESTION_STATUS_LABELS } from "@/lib/ai-import/config";
import { approveQuestionsAction, bulkTaxonomyAction, importAction, reclassifyQuestionsAction, rejectQuestionsAction, rescanQuestionsAction, unapproveQuestionsAction } from "../actions";
import { SelectNative } from "@/components/ui/select-native";
import { statusVariant } from "@/lib/ai-import/config";
import { callImporter } from "@/components/admin/ai-importer/call-importer";

export interface ExceptionRow {
  id: string;
  jobId: string;
  label: string;
  section: string;
  stem: string;
  status: string;
  answerStatus: string;
  issues: string[];
  issueText: Record<string, string>;
  subject: string | null;
  topic: string | null;
  finalAnswer: string[];
  figures: number;
  importBlocker: string | null;
  publishBlocker: string | null;
  questionId: string | null;
  /** The saved question was deleted after import (questionId is kept for history). */
  savedDeleted: boolean;
  approved: boolean;
  rescanPending: boolean;
  v1: "passed" | "problems" | "stale" | "none";
  v2: "verified" | "disagree" | "failed" | "stale" | "none";
  v2Model: string | null;
  eligible: boolean;
}

export interface TaxonomyOption {
  id: string;
  name: string;
  topics: { id: string; name: string; subTopics: { id: string; name: string }[] }[];
}

const V1_LABEL = { passed: "V1 passed", problems: "V1 findings", stale: "V1 out of date", none: "" } as const;
const V2_LABEL = { verified: "V2 agrees", disagree: "V2 disagrees", failed: "V2 no result", stale: "V2 out of date", none: "" } as const;

/** Bulk subject / topic / subtopic correction — only records of the job's exam are offered. */
function BulkTaxonomy({ taxonomy, disabled, onApply }: { taxonomy: TaxonomyOption[]; disabled: boolean; onApply: (s: string, t: string | null, u: string | null) => void }) {
  const [s, setS] = useState("");
  const [t, setT] = useState("");
  const [u, setU] = useState("");
  const subject = taxonomy.find((x) => x.id === s);
  const topic = subject?.topics.find((x) => x.id === t);
  return (
    <span className="flex flex-wrap items-center gap-1" data-testid="bulk-taxonomy">
      <SelectNative className="h-8 w-auto max-w-48 text-xs" aria-label="Subject" value={s} onChange={(e) => (setS(e.target.value), setT(""), setU(""))} data-testid="bulk-subject">
        <option value="">Subject…</option>
        {taxonomy.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </SelectNative>
      <SelectNative className="h-8 w-auto max-w-48 text-xs" aria-label="Topic" value={t} disabled={!subject} onChange={(e) => (setT(e.target.value), setU(""))} data-testid="bulk-topic">
        <option value="">Topic (none)</option>
        {subject?.topics.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </SelectNative>
      {topic && topic.subTopics.length > 0 && (
        <SelectNative className="h-8 w-auto max-w-48 text-xs" aria-label="Subtopic" value={u} onChange={(e) => setU(e.target.value)} data-testid="bulk-subtopic">
          <option value="">Subtopic (none)</option>
          {topic.subTopics.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </SelectNative>
      )}
      <Button size="sm" variant="outline" disabled={disabled || !s} onClick={() => onApply(s, t || null, u || null)} data-testid="bulk-taxonomy-apply">
        Set subject / topic
      </Button>
    </span>
  );
}

export function ExceptionsTable({ rows, canUse, canPublish, jobId, taxonomy = [] }: { rows: ExceptionRow[]; canUse: boolean; canPublish: boolean; jobId: string | null; taxonomy?: TaxonomyOption[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const toggle = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const ids = [...selected];
  const act = <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, ok: string | ((d: T) => string)) =>
    start(async () => {
      const r = await callImporter(fn);
      setMsg(r.ok ? { ok: true, text: typeof ok === "function" ? ok(r.data) : ok } : { ok: false, text: r.error ?? "Failed" });
      if (r.ok) {
        setSelected(new Set());
        router.refresh();
      }
    });
  const sameJob = ids.length > 0 && new Set(rows.filter((r) => selected.has(r.id)).map((r) => r.jobId)).size === 1;
  const publishable = rows.filter((r) => selected.has(r.id) && !r.publishBlocker).length;
  return (
    <div className="flex flex-col gap-3">
      {canUse && (
        <div className="flex flex-wrap items-center gap-2" data-testid="bulk-bar">
          <span className="text-xs text-[var(--color-muted-foreground)]">{ids.length} selected</span>
          <Button size="sm" variant="outline" onClick={() => setSelected(new Set(rows.map((r) => r.id)))}>
            Select all
          </Button>
          <Button size="sm" variant="outline" disabled={!ids.length || pending} onClick={() => act(() => approveQuestionsAction(ids), (d) => `${d.approved} approved${d.refused.length ? `; ${d.refused.length} not approved — ${d.refused.slice(0, 4).map((x) => `Q${x.label}: ${x.reason}`).join("; ")}${d.refused.length > 4 ? " …" : ""}` : ""}.`)} data-testid="bulk-approve">
            Approve
          </Button>
          <Button size="sm" variant="outline" disabled={!ids.length || pending} onClick={() => act(() => unapproveQuestionsAction(ids), (d) => `${d.withdrawn} approval(s) withdrawn.`)} data-testid="bulk-unapprove">
            Withdraw approval
          </Button>
          <Button size="sm" variant="outline" disabled={!ids.length || pending} onClick={() => {
            const reason = prompt("Reason for rejecting (optional):") ?? "";
            act(() => rejectQuestionsAction(ids, reason), "Rejected.");
          }} data-testid="bulk-reject">
            Reject
          </Button>
          <Button size="sm" variant="outline" disabled={!sameJob || pending} onClick={() => act(() => rescanQuestionsAction(ids, "question"), (d) => `Re-scan queued: ${d.questions} question(s) on ${d.pages} page(s). Manual corrections are kept.`)} data-testid="bulk-reprocess">
            Re-scan selected
          </Button>
          <Button size="sm" variant="outline" disabled={!sameJob || pending} onClick={() => act(() => reclassifyQuestionsAction(ids), (d) => `${d.queued} question(s) queued for subject/topic classification.`)} data-testid="bulk-reclassify">
            Re-classify
          </Button>
          {jobId && taxonomy.length > 0 && <BulkTaxonomy taxonomy={taxonomy} disabled={!ids.length || pending} onApply={(s, t, u) => act(() => bulkTaxonomyAction(ids, s, t, u), (d) => `Subject / topic set on ${d.updated} question(s)${d.refused.length ? `; not changed: ${d.refused.join(" ")}` : ""}.`)} />}
          {canPublish && (
            <Button size="sm" disabled={!sameJob || !publishable || pending} onClick={() => confirm(`Import and publish the ${publishable} selected question(s) that pass every check? The others stay as drafts/exceptions.`) && act(() => importAction(rows.find((r) => selected.has(r.id))!.jobId, "PUBLISH_SELECTED", ids), "Import & publish of the selection started — see the job page.")} data-testid="publish-selected">
              Import &amp; Publish Selected ({publishable})
            </Button>
          )}
          {jobId && (
            <Link className="text-xs underline" href={`/admin/ai-importer/jobs/${jobId}`}>
              Back to the job
            </Link>
          )}
        </div>
      )}
      {msg && <p className={`text-sm ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} data-testid="bulk-msg">{msg.text}</p>}
      <table className="w-full min-w-[1000px] text-left text-sm" data-testid="exceptions-table">
        <thead className="text-xs text-[var(--color-muted-foreground)]">
          <tr>
            {canUse && <th className="w-6 py-1" />}
            <th className="py-1 pr-2 font-medium">Q</th>
            <th className="py-1 pr-2 font-medium">Question</th>
            <th className="py-1 pr-2 font-medium">Status</th>
            <th className="py-1 pr-2 font-medium">Approval</th>
            <th className="py-1 pr-2 font-medium">Answer</th>
            <th className="py-1 pr-2 font-medium">Subject › Topic</th>
            <th className="py-1 pr-2 font-medium">Issues</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-[var(--color-border)] align-top" data-testid="exception-row">
              {canUse && (
                <td className="py-1.5">
                  <input type="checkbox" aria-label={`Select Q${r.label}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                </td>
              )}
              <td className="py-1.5 pr-2 whitespace-nowrap">
                <Link className="underline" href={`/admin/ai-importer/questions/${r.id}`}>
                  {r.section ? `${r.section} ` : ""}Q{r.label}
                </Link>
              </td>
              <td className="max-w-md py-1.5 pr-2">
                {r.stem}
                {r.figures > 0 && <span className="ml-1 text-xs text-[var(--color-muted-foreground)]">· {r.figures} figure(s)</span>}
              </td>
              <td className="py-1.5 pr-2">
                <Badge variant={statusVariant(r.status)}>{QUESTION_STATUS_LABELS[r.status] ?? r.status}</Badge>
                {(r.v1 !== "none" || r.v2 !== "none") && (
                  <span className="mt-0.5 flex flex-wrap gap-1 text-[11px]" data-testid="row-verify" data-v1={r.v1} data-v2={r.v2}>
                    {r.v1 !== "none" && <span className={r.v1 === "passed" ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"}>{V1_LABEL[r.v1]}</span>}
                    {r.v2 !== "none" && <span className={r.v2 === "verified" ? "text-[var(--color-success)]" : r.v2 === "disagree" ? "text-[var(--color-error)]" : "text-[var(--color-warning)]"} title={r.v2Model ?? undefined}>{V2_LABEL[r.v2]}</span>}
                    {r.eligible && <span className="text-[var(--color-success)]">· eligible</span>}
                  </span>
                )}
                {r.questionId &&
                  (r.savedDeleted ? (
                    <span className="ml-1 text-xs text-[var(--color-muted-foreground)]" data-testid="saved-deleted">
                      deleted
                    </span>
                  ) : (
                    <Link className="ml-1 text-xs underline" href={`/admin/questions/preview/${r.questionId}`}>
                      open
                    </Link>
                  ))}
              </td>
              <td className="py-1.5 pr-2 text-xs" data-testid="row-approval" data-approved={r.approved ? "true" : "false"}>
                {r.questionId ? <span className="text-[var(--color-success)]">in Question Bank</span> : r.approved ? <Badge variant="success">Approved</Badge> : r.rescanPending ? <Badge variant="warning">Re-scan to decide</Badge> : <span className="text-[var(--color-muted-foreground)]">not approved</span>}
              </td>
              <td className="py-1.5 pr-2">
                <Badge variant={statusVariant(r.answerStatus)}>{ANSWER_STATUS_LABELS[r.answerStatus] ?? r.answerStatus}</Badge>
                {r.finalAnswer.length > 0 && <span className="ml-1 font-mono text-xs">{r.finalAnswer.join(",")}</span>}
              </td>
              <td className="py-1.5 pr-2 text-xs">
                {r.subject ?? "—"} › {r.topic ?? "—"}
              </td>
              <td className="py-1.5 pr-2 text-xs">
                <ul className="flex flex-col gap-0.5">
                  {r.issues.map((c) => (
                    <li key={c} className={ISSUE_DEFS[c]?.blocking ? "text-[var(--color-error)]" : "text-[var(--color-warning)]"}>
                      {ISSUE_DEFS[c]?.label ?? c}
                      {r.issueText[c] ? ` — ${r.issueText[c]}` : ""}
                    </li>
                  ))}
                  {r.issueText.IMPORT && <li className="text-[var(--color-error)]">Import: {r.issueText.IMPORT}</li>}
                  {r.issueText.PUBLISH && <li className="text-[var(--color-warning)]">{r.issueText.PUBLISH}</li>}
                  {!r.issues.length && !r.issueText.IMPORT && <li className="text-[var(--color-muted-foreground)]">none</li>}
                </ul>
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={8} className="py-4 text-[var(--color-muted-foreground)]">
                Nothing here.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
