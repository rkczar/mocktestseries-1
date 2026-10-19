"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ANSWER_STATUS_LABELS, ISSUE_DEFS, QUESTION_STATUS_LABELS } from "@/lib/ai-import/config";
import { approveQuestionsAction, importAction, reclassifyQuestionsAction, rejectQuestionsAction, rescanQuestionsAction, unapproveQuestionsAction } from "../actions";
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
}

export function ExceptionsTable({ rows, canUse, canPublish, jobId }: { rows: ExceptionRow[]; canUse: boolean; canPublish: boolean; jobId: string | null }) {
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
