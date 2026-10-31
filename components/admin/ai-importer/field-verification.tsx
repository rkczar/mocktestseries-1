"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { applyVerifySuggestionAction } from "@/app/admin/(dashboard)/ai-importer/actions";
import type { FieldBoardRow } from "@/lib/ai-import/field-checks";

const FIELD_LABEL: Record<string, string> = { number: "Number", text: "Question text", options: "Options (count)", "option A": "Option A", "option B": "Option B", "option C": "Option C", "option D": "Option D", answer: "Answer", type: "Question type", subject: "Subject", topic: "Topic", source: "Source fidelity" };
const BY_LABEL = { V1: "Verify 1", V2: "Verify 2", MEMORY: "Paper memory" } as const;
const TONE = { OK: "success", PROBLEM: "error", NOT_CHECKED: "neutral" } as const;
const STATUS = { OK: "OK", PROBLEM: "Problem", NOT_CHECKED: "Not checked" } as const;

/**
 * Field-by-field verification of one question (current Verify 1 / Verify 2 results + confirmed paper memory): what is
 * wrong in which field, and a suggestion with its evidence where a source, second read or key shows another value.
 * A question-text / option suggestion can be taken with one click (a normal, recorded correction — the approval is
 * withdrawn); answers, subjects and topics are set with their own controls. Nothing is applied automatically.
 */
export function FieldVerification({ questionId, rows, canUse, stale }: { questionId: string; rows: FieldBoardRow[]; canUse: boolean; stale: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showOk, setShowOk] = useState(false);
  const problems = rows.filter((r) => r.status === "PROBLEM");
  const visible = showOk ? rows : rows.filter((r) => r.status !== "OK");
  const apply = (field: string, by: "V1" | "V2") =>
    start(async () => {
      const r = await callImporter(() => applyVerifySuggestionAction(questionId, field, by));
      if (!r.ok) return setMsg({ ok: false, text: r.error ?? "Failed" });
      setMsg({ ok: true, text: `${FIELD_LABEL[field] ?? field}: suggestion taken (recorded in the history; approve the question again after checking). Run Verify 1 / Verify 2 again to re-check it.` });
      router.refresh();
    });
  if (!rows.length) return <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="field-verification-none">{stale ?? "Field-by-field results appear after Verify 1 / Verify 2 run on this question."}</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="field-verification" data-problems={problems.length}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {rows.map((r) => (
          <Badge key={r.field} variant={TONE[r.status]} data-testid="field-chip" data-field={r.field} data-status={r.status}>
            {FIELD_LABEL[r.field] ?? r.field}: {STATUS[r.status]}
          </Badge>
        ))}
      </div>
      {stale && <p className="text-xs text-[var(--color-warning)]">{stale}</p>}
      {visible.length === 0 ? (
        <p className="text-xs text-[var(--color-success)]">Every checked field is OK.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((r) => (
            <li key={r.field} className="rounded border border-[var(--color-border)] p-2 text-xs" data-testid="field-row" data-field={r.field} data-status={r.status}>
              <p className="font-medium">
                {FIELD_LABEL[r.field] ?? r.field} · <span className={r.status === "PROBLEM" ? "text-[var(--color-error)]" : r.status === "OK" ? "text-[var(--color-success)]" : "text-[var(--color-muted-foreground)]"}>{STATUS[r.status]}</span>
              </p>
              {r.notes.filter((n) => n.problem || n.suggestion || (showOk && n.evidence)).map((n, k) => (
                <div key={k} className="mt-1 flex flex-col gap-0.5" data-testid="field-note" data-by={n.by}>
                  <p>
                    <span className="text-[var(--color-muted-foreground)]">{BY_LABEL[n.by]}:</span> {n.problem ?? (n.status === "OK" ? "OK" : "")}
                  </p>
                  {n.suggestion && (
                    <div className="rounded bg-[var(--color-muted)] p-1.5">
                      <p className="whitespace-pre-line" data-testid="field-suggestion">
                        Suggestion: {n.suggestion.slice(0, 1200)}
                      </p>
                      {n.evidence && <p className="text-[var(--color-muted-foreground)]">Evidence: {n.evidence}</p>}
                      {(n.by === "V1" || n.by === "V2") && /^(text|option [A-D])$/.test(r.field) ? (
                        <Button size="sm" variant="outline" className="mt-1" disabled={!canUse || pending || !!stale} onClick={() => apply(r.field, n.by as "V1" | "V2")} data-testid="field-apply">
                          Use this suggestion
                        </Button>
                      ) : (
                        <p className="text-[var(--color-muted-foreground)]">{r.field === "answer" ? "Set the answer with the answer control below (never changed automatically)." : r.field === "subject" || r.field === "topic" ? "Set the subject / topic with the controls below." : "Correct it in the editor below if the source confirms it."}</p>
                      )}
                    </div>
                  )}
                  {!n.suggestion && n.evidence && n.status !== "OK" && <p className="text-[var(--color-muted-foreground)]">Evidence: {n.evidence}</p>}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setShowOk((v) => !v)} data-testid="field-show-ok">
          {showOk ? "Show problems only" : "Show every field"}
        </Button>
        {msg && <span className={`text-xs ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}
