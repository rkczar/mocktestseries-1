"use client";

import Link from "next/link";
import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ANSWER_STATUS_LABELS, ISSUE_DEFS, QUESTION_STATUS_LABELS } from "@/lib/ai-import/config";
import { approveFromListAction, approveQuestionsAction, bulkTaxonomyAction, publishFromListAction, importAction, reclassifyQuestionsAction, rejectQuestionsAction, rescanMissingQuestionAction, rescanQuestionsAction, unapproveQuestionsAction } from "../actions";
import { SelectNative } from "@/components/ui/select-native";
import { statusVariant } from "@/lib/ai-import/config";
import { callImporter } from "@/components/admin/ai-importer/call-importer";

export interface ExceptionRow {
  id: string;
  jobId: string;
  fileId: string;
  /** Printed number (null = unnumbered); places missing-question rows. */
  number: number | null;
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
  v2: "verified" | "disagree" | "not_found" | "failed" | "unavailable" | "stale" | "none";
  v2Model: string | null;
  /** Pending / Running / Passed / Findings / Disagreement / Failed / Unavailable / Out of date / Not run. */
  v1Label: string;
  v2Label: string;
  v1Findings: string[];
  v1Fixes: string[];
  /** Why Verify 2 agrees / disagrees, or the provider's / importer's reason for no result. */
  v2Detail: string | null;
  v2Fields: string[];
  /** Fields with a problem in the current Verify 1 / Verify 2 results (by: V1 / V2 / MEMORY). */
  fieldProblems: { field: string; notes: { by: "V1" | "V2" | "MEMORY"; problem: string; suggestion: string | null }[] }[];
  references: { name: string; compared: boolean; matched: string | null; similarity: number | null; conflicts: string[]; note: string | null }[];
  fullStem: string;
  options: { label: string; text: string; contaminated: boolean }[];
  statements: number;
  stemContaminated: boolean;
  answerLine: string | null;
  taxonomySource: string | null;
  taxonomyEvidence: string | null;
  /** Subject / topic decision: why, how sure, and what Verify 1 / Verify 2 found (names, never ids). */
  tax: {
    subTopic: string | null;
    confidence: number | null;
    /** Mismatch / Uncertain / Missing taxonomy configuration / Classifier failure / Text incomplete / Set by an administrator. */
    kind: string | null;
    reason: string | null;
    localSuggestion: string | null;
    ai: string | null;
    v1: { status: string; found: string | null; findings: string[] } | null;
    v2: { status: string; found: string | null; findings: string[]; model: string; vsV1: string } | null;
    agreement: string;
    /** Other valid classifications of this exam's syllabus, with where they came from (shown for review, never applied). */
    alternatives: string[];
  };
  eligible: boolean;
  /** The separate checks Ready depends on (lib/ai-import/checks.ts); null on rows not re-checked since they existed. */
  checks: { key: string; name: string; status: string; label: string; required: boolean; detail: string }[] | null;
  /** Formatting rules applied to the question text, with the text exactly as it was read. */
  formatting: { rules: string[]; original: string } | null;
}

export interface TaxonomyOption {
  id: string;
  name: string;
  topics: { id: string; name: string; subTopics: { id: string; name: string }[] }[];
}

const toneOf = (label: string) => (label === "Passed" ? "text-[var(--color-success)]" : label.startsWith("Disagreement") ? "text-[var(--color-error)]" : label === "Not run" ? "text-[var(--color-muted-foreground)]" : "text-[var(--color-warning)]");
const STRUCTURE = new Set(["ANSWER_IN_OPTION", "STATEMENTS_MERGED", "STATEMENT_COUNT_MISMATCH", "QUESTION_TEXT_SUSPECT", "OPTIONS_INCOMPLETE", "NUMBER_CONFLICT"]);
const CHECK_TONE: Record<string, string> = { PASSED: "text-[var(--color-success)]", NOT_RUN: "text-[var(--color-muted-foreground)]", DISAGREEMENT: "text-[var(--color-error)]", FAILED: "text-[var(--color-error)]" };
/** The decisive part of a classification reason (the full text stays in the cell's tooltip). */
const shortReason = (reason: string) => {
  const matched = /matched (“[^;]*?”)(?:;|$)/.exec(reason)?.[1];
  const head = reason.replace(/; paper context:.*$/, "");
  return (matched && /\(subject \d+%/.test(head) ? `matched ${matched}` : head).slice(0, 160);
};
/** A Verify 1 / Verify 2 classification result in a few words: the finding only when the check does not simply agree. */
const verdict = (v: { status: string; found: string | null; findings: string[] } | null) => (!v ? "not run" : v.status === "AGREED" ? "agreed" : `${v.status.replace(/_/g, " ").toLowerCase()} — ${v.findings[0] ?? ""}`.slice(0, 180));
const TAXONOMY = new Set(["SUBJECT_UNKNOWN", "CLASSIFICATION_FAILED", "SUBJECT_MISMATCH", "TOPIC_UNCERTAIN", "TAXONOMY_DISAGREES", "TAXONOMY_CHECK_FAILED"]);

/**
 * Bulk subject / topic / subtopic correction — only records of the job's exam are offered. Applying needs an explicit
 * confirmation that lists the questions (the server checks the confirmed count again).
 */
function BulkTaxonomy({ taxonomy, disabled, labels, onApply }: { taxonomy: TaxonomyOption[]; disabled: boolean; labels: string[]; onApply: (s: string, t: string | null, u: string | null, confirm: { count: number; remember: boolean }) => void }) {
  const [s, setS] = useState("");
  const [t, setT] = useState("");
  const [u, setU] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [remember, setRemember] = useState(false);
  const subject = taxonomy.find((x) => x.id === s);
  const topic = subject?.topics.find((x) => x.id === t);
  const subTopic = topic?.subTopics.find((x) => x.id === u);
  if (confirming && labels.length)
    return (
      <span className="flex w-full flex-col gap-1 rounded border border-[var(--color-warning)] p-2 text-xs" data-testid="bulk-taxonomy-confirm">
        <span>
          Set <b>{subject?.name ?? "?"}</b> › {topic?.name ?? "no topic"}
          {subTopic ? ` › ${subTopic.name}` : ""} on <b data-testid="bulk-taxonomy-count">{labels.length}</b> question(s): {labels.slice(0, 40).join(", ")}
          {labels.length > 40 ? ` … (+${labels.length - 40})` : ""}
        </span>
        <span className="text-[var(--color-muted-foreground)]">Only questions of this exam can be changed. They are not verified by this: they must still be approved, and their Verify 1 / Verify 2 results become out of date until run again.</span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} data-testid="bulk-taxonomy-remember" /> Remember these as confirmed examples for this exam (only if you have checked each question; each is used only after its question is approved)
        </label>
        <span className="flex gap-1">
          <Button size="sm" disabled={disabled} onClick={() => (setConfirming(false), onApply(s, t || null, u || null, { count: labels.length, remember }))} data-testid="bulk-taxonomy-confirm-apply">
            Confirm — change {labels.length} question(s)
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfirming(false)} data-testid="bulk-taxonomy-cancel">
            Cancel
          </Button>
        </span>
      </span>
    );
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
      <Button size="sm" variant="outline" disabled={disabled || !s || !labels.length} onClick={() => setConfirming(true)} data-testid="bulk-taxonomy-apply">
        Set subject / topic…
      </Button>
    </span>
  );
}

/**
 * Approve / Publish on one row without opening the question. The server decides: Approve from a row is refused for
 * every unresolved answer / subject-topic / reference / Verify 2 conflict (decided on the question's page); Publish is
 * shown only for a question the server found eligible (Verify 1 passed, Verify 2 agreed, no open flag), asks for an
 * explicit confirmation, and is checked again on the server.
 */
function RowActions({ row: r, canUse, canPublish, pending, act }: { row: ExceptionRow; canUse: boolean; canPublish: boolean; pending: boolean; act: <T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, ok: string | ((d: T) => string)) => void }) {
  if (!canUse || r.questionId || r.status === "REJECTED") return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {!r.approved && (
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => act(() => approveFromListAction(r.id), (d) => (d.approved ? `Q${r.label} approved.` : `Q${r.label} not approved — ${d.refused[0]?.reason ?? "refused"}.`))} data-testid="row-approve">
          Approve
        </Button>
      )}
      {canPublish && r.eligible && (
        <Button size="sm" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => confirm(`Publish Q${r.label} now? It passed Verify 1 and Verify 2 and every check; students will see it once it is published.`) && act(() => publishFromListAction(r.id), `Publishing Q${r.label} — see the job page.`)} data-testid="row-publish">
          Publish
        </Button>
      )}
    </span>
  );
}

export interface MissingRow {
  fileId: string;
  fileName: string;
  section: string;
  number: number;
  pages: number[];
  label: string;
}

export function ExceptionsTable({ rows, canUse, canPublish, jobId, taxonomy = [], draft = null, missing = null }: { rows: ExceptionRow[]; canUse: boolean; canPublish: boolean; jobId: string | null; taxonomy?: TaxonomyOption[]; /** This job's "Add approved to Question Bank (Draft)": how many it adds now, and whether the job is finished. */ draft?: { count: number; open: boolean } | null; /** Reliably missing numbers of this job (placeholder rows), with why some are not shown. */ missing?: { slots: MissingRow[]; notes: string[] } | null }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const toggle = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const ids = [...selected];
  // A missing number is shown just before the first listed question of the same paper and section with a higher number.
  const placedBefore = (list: ExceptionRow[], m: MissingRow) => list.find((r) => r.fileId === m.fileId && r.section === m.section && r.number !== null && r.number > m.number)?.id ?? null;
  const missingRow = (m: MissingRow) => (
    <tr key={`missing-${m.fileId}-${m.section}-${m.number}`} className="border-t border-dashed border-[var(--color-border)] bg-[var(--color-warning)]/5 align-top" data-testid="missing-row" data-number={m.number}>
      {canUse && <td className="py-1.5" />}
      <td className="py-1.5 pr-2 whitespace-nowrap font-medium">{m.label}</td>
      <td colSpan={6} className="py-1.5 pr-2">
        <span className="font-medium text-[var(--color-warning)]">
          {m.label} — Missing / Not Extracted
        </span>
        <span className="ml-1 text-xs text-[var(--color-muted-foreground)]">
          · {m.pages.length ? `expected on page ${m.pages.join(" or ")}` : "page not established"} · {m.fileName}
        </span>
      </td>
      <td className="py-1.5 pr-2 text-xs text-[var(--color-error)]">Not in the extraction</td>
      <td className="py-1.5 pr-2 text-xs">
        {canUse && jobId && m.pages.length > 0 && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => rescanMissingQuestionAction({ jobId, fileId: m.fileId, section: m.section, number: m.number }), (d) => `${m.label}: a placeholder was added and the re-scan is queued — ${d.reads.join(" ")} The result waits on it as a candidate: open it, check it against the page and save.`)} data-testid="missing-rescan">
            Re-scan question
          </Button>
        )}
        {!m.pages.length && <span className="text-[var(--color-muted-foreground)]">Page unknown — add it by hand (Quality panel).</span>}
      </td>
    </tr>
  );
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
          {jobId && taxonomy.length > 0 && (
            <BulkTaxonomy
              taxonomy={taxonomy}
              disabled={!ids.length || pending}
              labels={rows.filter((r) => selected.has(r.id)).map((r) => `${r.section ? `${r.section} ` : ""}Q${r.label}`)}
              onApply={(s, t, u, confirm) => act(() => bulkTaxonomyAction(ids, s, t, u, confirm), (d) => `Subject / topic set on ${d.updated} question(s)${d.remembered ? ` (${d.remembered} proposed as examples, used after approval)` : ""}${d.refused.length ? `; not changed: ${d.refused.join(" ")}` : ""}. They still need approval; run Verify 1 / Verify 2 again to check them.`)}
            />
          )}
          {canPublish && (
            <Button size="sm" disabled={!sameJob || !publishable || pending} onClick={() => confirm(`Import and publish the ${publishable} selected question(s) that pass every check? The others stay as drafts/exceptions.`) && act(() => importAction(rows.find((r) => selected.has(r.id))!.jobId, "PUBLISH_SELECTED", ids), "Import & publish of the selection started — see the job page.")} data-testid="publish-selected">
              Import &amp; Publish Selected ({publishable})
            </Button>
          )}
          {jobId && draft?.open && (
            <Button size="sm" disabled={!draft.count || pending} onClick={() => confirm(`Add the ${draft.count} approved question(s) of this import to the Question Bank as Draft? Nothing is published; Import History records the run and can roll it back.`) && act(() => importAction(jobId, "DRAFT", null), "Adding the approved questions as Draft — see the job page.")} data-testid="exceptions-import-draft">
              Add approved to Question Bank (Draft) ({draft.count})
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
      {!!missing?.notes.length && (
        <ul className="mb-2 list-disc pl-5 text-xs text-[var(--color-muted-foreground)]" data-testid="missing-notes">
          {missing.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <table className="w-full min-w-[1200px] text-left text-sm" data-testid="exceptions-table">
        <thead className="text-xs text-[var(--color-muted-foreground)]">
          <tr>
            {canUse && <th className="w-6 py-1" />}
            <th className="py-1 pr-2 font-medium">Q</th>
            <th className="py-1 pr-2 font-medium">Question</th>
            <th className="py-1 pr-2 font-medium">Status</th>
            <th className="py-1 pr-2 font-medium">Verify 1 / Verify 2</th>
            <th className="py-1 pr-2 font-medium">Approval</th>
            <th className="py-1 pr-2 font-medium">Answer</th>
            <th className="py-1 pr-2 font-medium">Subject › Topic</th>
            <th className="py-1 pr-2 font-medium">Issues</th>
            <th className="py-1 pr-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.id}>
            {(missing?.slots ?? []).filter((m) => placedBefore(rows, m) === r.id).map((m) => missingRow(m))}
            <tr className="border-t border-[var(--color-border)] align-top" data-testid="exception-row">
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
                <details>
                  <summary className="cursor-pointer whitespace-pre-line" data-testid="row-stem">
                    {r.stem}
                    {r.figures > 0 && <span className="ml-1 text-xs text-[var(--color-muted-foreground)]">· {r.figures} figure(s)</span>}
                    {r.statements > 0 && <span className="ml-1 text-xs text-[var(--color-muted-foreground)]">· {r.statements} numbered statements</span>}
                  </summary>
                  {/* Stem / option / answer boundaries as stored: an answer line inside an option is marked. */}
                  <div className="mt-1 flex flex-col gap-0.5 rounded border border-[var(--color-border)] p-2 text-xs" data-testid="row-structure">
                    <p className={`whitespace-pre-line ${r.stemContaminated ? "bg-[var(--color-error)]/10" : ""}`}>{r.fullStem}</p>
                    {r.options.map((o) => (
                      <p key={o.label} className={`whitespace-pre-line ${o.contaminated ? "rounded bg-[var(--color-error)]/10 text-[var(--color-error)]" : ""}`} data-contaminated={o.contaminated ? "true" : undefined}>
                        <span className="font-mono">{o.label}.</span> {o.text}
                        {o.contaminated && <span className="ml-1 font-medium">← contains the answer line</span>}
                      </p>
                    ))}
                    {r.answerLine && <p className="text-[var(--color-muted-foreground)]">Printed answer: {r.answerLine}</p>}
                    {r.formatting && (
                      <details className="mt-1 text-[var(--color-muted-foreground)]" data-testid="row-formatting">
                        <summary className="cursor-pointer">Formatting applied: {r.formatting.rules.join(", ")} (wording unchanged) — show the text as read</summary>
                        <p className="whitespace-pre-line">{r.formatting.original}</p>
                      </details>
                    )}
                  </div>
                </details>
              </td>
              <td className="py-1.5 pr-2">
                <Badge variant={statusVariant(r.status)}>{QUESTION_STATUS_LABELS[r.status] ?? r.status}</Badge>
                {r.eligible && <span className="ml-1 text-[11px] text-[var(--color-success)]">eligible</span>}
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
              <td className="max-w-xs py-1.5 pr-2 text-[11px]" data-testid="row-verify" data-v1={r.v1} data-v2={r.v2}>
                {r.checks && (
                  <ul className="mb-1 flex flex-col gap-0.5 border-b border-[var(--color-border)] pb-1" data-testid="row-checks">
                    {r.checks.map((c) => (
                      <li key={c.key} data-testid="row-check" data-check={c.key} data-status={c.status} title={c.detail}>
                        <span className="text-[var(--color-muted-foreground)]">{c.name}: </span>
                        <span className={CHECK_TONE[c.status] ?? "text-[var(--color-warning)]"}>{c.label}</span>
                        {!c.required && c.status !== "PASSED" && <span className="text-[var(--color-muted-foreground)]"> (not required)</span>}
                        {c.status !== "PASSED" && c.status !== "NOT_RUN" && <span className="block text-[var(--color-muted-foreground)]">{c.detail.slice(0, 180)}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <p>
                  <span className="text-[var(--color-muted-foreground)]">V1: </span>
                  <span className={toneOf(r.v1Label)} data-testid="row-v1">{r.v1Label}</span>
                </p>
                {r.v1Findings.map((f) => (
                  <p key={f} className="text-[var(--color-warning)]">· {f.slice(0, 160)}</p>
                ))}
                {r.v1Fixes.map((f) => (
                  <p key={f} className="text-[var(--color-muted-foreground)]">· corrected: {f}</p>
                ))}
                {r.references.map((x) => (
                  <p key={x.name} className={!x.compared ? "text-[var(--color-warning)]" : x.conflicts.length ? "text-[var(--color-error)]" : "text-[var(--color-muted-foreground)]"} data-testid="row-reference" data-compared={x.compared ? "true" : "false"}>
                    · {x.name}: {!x.compared ? x.note ?? "not compared" : x.matched ? `${x.matched}${x.similarity !== null ? `, ${Math.round(x.similarity * 100)}% similar wording` : ""}${x.conflicts.length ? ` — ${x.conflicts.join(" ")}` : " — no difference"}` : "no matching question"}
                  </p>
                ))}
                <p className="mt-0.5">
                  <span className="text-[var(--color-muted-foreground)]">V2: </span>
                  <span className={toneOf(r.v2Label)} title={r.v2Model ?? undefined} data-testid="row-v2">
                    {r.v2Label}
                  </span>
                  {r.v2Model && r.v2 !== "none" && <span className="text-[var(--color-muted-foreground)]"> · {r.v2Model}</span>}
                </p>
                {r.v2Detail && <p className={r.v2 === "verified" ? "text-[var(--color-muted-foreground)]" : "text-[var(--color-warning)]"} data-testid="row-v2-detail">{r.v2Fields.length ? `${r.v2Fields.join(", ")}: ` : ""}{r.v2Detail}</p>}
                {r.fieldProblems.length > 0 && (
                  <div className="mt-1 flex flex-col gap-0.5" data-testid="row-field-problems" data-count={r.fieldProblems.length}>
                    <span className="text-[var(--color-muted-foreground)]">Fields:</span>
                    {r.fieldProblems.map((f) => (
                      <p key={f.field} className="text-[var(--color-error)]" data-testid="row-field-problem" data-field={f.field}>
                        · <span className="font-medium">{f.field}</span>
                        {f.notes.map((n, k) => (
                          <span key={k}>
                            {" "}— {n.by === "MEMORY" ? "paper memory" : n.by === "V1" ? "Verify 1" : "Verify 2"}: {n.problem.slice(0, 140)}
                            {n.suggestion ? <span className="text-[var(--color-muted-foreground)]"> (suggests “{n.suggestion.slice(0, 80)}”)</span> : null}
                          </span>
                        ))}
                      </p>
                    ))}
                  </div>
                )}
              </td>
              <td className="py-1.5 pr-2 text-xs" data-testid="row-approval" data-approved={r.approved ? "true" : "false"}>
                {r.questionId ? <span className="text-[var(--color-success)]">in Question Bank</span> : r.approved ? <Badge variant="success">Approved</Badge> : r.rescanPending ? <Badge variant="warning">Re-scan to decide</Badge> : <span className="text-[var(--color-muted-foreground)]">not approved</span>}
                <RowActions row={r} canUse={canUse} canPublish={canPublish} pending={pending} act={act} />
              </td>
              <td className="py-1.5 pr-2">
                <Badge variant={statusVariant(r.answerStatus)}>{ANSWER_STATUS_LABELS[r.answerStatus] ?? r.answerStatus}</Badge>
                {r.finalAnswer.length > 0 && <span className="ml-1 font-mono text-xs">{r.finalAnswer.join(",")}</span>}
              </td>
              <td className="max-w-xs py-1.5 pr-2 text-xs" data-testid="row-taxonomy" data-kind={r.tax.kind ?? undefined}>
                <span className={r.issues.some((c) => TAXONOMY.has(c)) ? "text-[var(--color-warning)]" : ""} data-testid="row-taxonomy-selected">
                  {r.subject ?? "—"} › {r.topic ?? "—"}
                  {r.tax.subTopic ? ` › ${r.tax.subTopic}` : ""}
                </span>
                <p className="text-[11px] text-[var(--color-muted-foreground)]">
                  {r.taxonomySource ?? "not set"}
                  {r.tax.confidence !== null && r.subject ? ` · ${Math.round(r.tax.confidence * 100)}%` : ""}
                </p>
                {r.tax.kind && <p className="text-[11px] font-medium text-[var(--color-warning)]" data-testid="row-taxonomy-kind">{r.tax.kind}</p>}
                {r.tax.reason && (
                  <p className="text-[11px] text-[var(--color-muted-foreground)]" title={r.tax.reason} data-testid="row-taxonomy-reason">
                    {shortReason(r.tax.reason)}
                  </p>
                )}
                {r.tax.localSuggestion && <p className="text-[11px] text-[var(--color-muted-foreground)]">Free check suggests: {r.tax.localSuggestion}</p>}
                {r.tax.ai && <p className="text-[11px] text-[var(--color-muted-foreground)]" title={r.tax.ai}>AI: {r.tax.ai.slice(0, 140)}</p>}
                <p className="mt-0.5 text-[11px]" data-testid="row-taxonomy-v1" data-status={r.tax.v1?.status ?? "none"}>
                  <span className="text-[var(--color-muted-foreground)]">V1: </span>
                  {verdict(r.tax.v1)}
                </p>
                <p className="text-[11px]" data-testid="row-taxonomy-v2" data-status={r.tax.v2?.status ?? "none"}>
                  <span className="text-[var(--color-muted-foreground)]">V2: </span>
                  {verdict(r.tax.v2)}
                </p>
                {r.tax.alternatives.length > 0 && (
                  <div className="mt-0.5 text-[11px]" data-testid="row-taxonomy-alternatives">
                    <span className="text-[var(--color-muted-foreground)]">Other valid choices:</span>
                    {r.tax.alternatives.map((a) => (
                      <p key={a} className="text-[var(--color-muted-foreground)]">· {a}</p>
                    ))}
                  </div>
                )}
                <p className={`text-[11px] ${r.tax.agreement === "Both checks agree" ? "text-[var(--color-success)]" : r.tax.agreement.startsWith("Disagreement") || r.tax.agreement.includes("failed") ? "text-[var(--color-error)]" : "text-[var(--color-muted-foreground)]"}`} data-testid="row-taxonomy-agreement">
                  {r.tax.agreement}
                </p>
              </td>
              <td className="py-1.5 pr-2 text-xs">
                <ul className="flex flex-col gap-0.5">
                  {r.issues.map((c) => (
                    <li key={c} className={ISSUE_DEFS[c]?.blocking ? "text-[var(--color-error)]" : "text-[var(--color-warning)]"} data-kind={STRUCTURE.has(c) ? "structure" : TAXONOMY.has(c) ? "taxonomy" : undefined}>
                      {STRUCTURE.has(c) && <span className="mr-1 rounded bg-[var(--color-error)]/10 px-1 text-[10px] uppercase">structure</span>}
                      {TAXONOMY.has(c) && <span className="mr-1 rounded bg-[var(--color-warning)]/10 px-1 text-[10px] uppercase">taxonomy</span>}
                      {ISSUE_DEFS[c]?.label ?? c}
                      {r.issueText[c] ? ` — ${r.issueText[c]}` : ""}
                    </li>
                  ))}
                  {r.issueText.IMPORT && <li className="text-[var(--color-error)]">Import: {r.issueText.IMPORT}</li>}
                  {r.issueText.PUBLISH && <li className="text-[var(--color-warning)]">{r.issueText.PUBLISH}</li>}
                  {!r.issues.length && !r.issueText.IMPORT && <li className="text-[var(--color-muted-foreground)]">none</li>}
                </ul>
              </td>
              <td className="py-1.5 pr-2 text-xs whitespace-nowrap" data-testid="row-actions">
                <div className="flex flex-col items-start gap-1">
                  <Link className="underline" href={`/admin/ai-importer/questions/${r.id}`} data-testid="row-view">
                    View
                  </Link>
                  {!r.questionId && (
                    <Link className="underline" href={`/admin/ai-importer/questions/${r.id}#edit`} data-testid="row-edit">
                      Edit
                    </Link>
                  )}
                  {canUse && !r.questionId && (
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => rescanQuestionsAction([r.id], "question"), (d) => `Re-scan of Q${r.label} queued — ${d.reads.join(" ")} The result waits as a candidate on the question; nothing is replaced.`)} data-testid="row-rescan">
                      Re-scan
                    </Button>
                  )}
                </div>
              </td>
            </tr>
            </Fragment>
          ))}
          {(missing?.slots ?? []).filter((m) => !placedBefore(rows, m)).map((m) => missingRow(m))}
          {!rows.length && (
            <tr>
              <td colSpan={10} className="py-4 text-[var(--color-muted-foreground)]">
                Nothing here.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
