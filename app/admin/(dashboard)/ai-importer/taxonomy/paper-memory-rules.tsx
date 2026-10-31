"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import type { PaperRule } from "@/lib/ai-import/paper-memory";
import { decidePaperRuleAction, removeTaxonomyMemoryAction } from "../actions";

/**
 * Paper-format memory of one exam: facts measured on its imported papers, each with its evidence and confidence.
 * Proposed rules are not used; a confirmed rule is used as a check (it flags, never changes a question).
 */
export function PaperMemoryRules({ examId, canEdit, rules, kinds }: { examId: string; canEdit: boolean; rules: PaperRule[]; kinds: Record<string, string> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const act = (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, ok: string) =>
    start(async () => {
      const r = await callImporter(fn);
      setMsg(r.ok ? { ok: true, text: ok } : { ok: false, text: r.error ?? "Failed" });
      if (r.ok) router.refresh();
    });
  const scopes = [...new Set(rules.map((r) => (r.scope === "EXAM" ? "Whole exam" : (r.paper ?? "Paper not identified"))))].sort((a, b) => (a === "Whole exam" ? -1 : b === "Whole exam" ? 1 : a.localeCompare(b)));
  return (
    <Card data-testid="paper-memory">
      <CardHeader>
        <CardTitle>Paper-format memory</CardTitle>
        <CardDescription>
          Facts measured on this exam&apos;s imported papers (Review Exceptions → Learn paper format): numbering, option labels, headings, how answers are printed and how far those marks agree with the official key, the key&apos;s layout, question formats, the subjects a paper covers and admin-corrected OCR errors. Only the source documents, complete official keys of approved questions and administrator corrections count as evidence — never AI readings or answers. A proposed rule is not used; a confirmed rule is used as a check and never changes a question. Paper rules stay separate from rules of the whole exam.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {msg && (
          <p className={`text-xs ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role="status">
            {msg.text}
          </p>
        )}
        {!rules.length && <p className="text-xs text-[var(--color-muted-foreground)]">Nothing learned yet.</p>}
        {scopes.map((scope) => (
          <section key={scope} className="flex flex-col gap-1" data-testid="paper-memory-scope" data-scope={scope}>
            <h3 className="text-sm font-semibold">{scope}</h3>
            <ul className="flex flex-col gap-2 text-xs">
              {rules
                .filter((r) => (r.scope === "EXAM" ? "Whole exam" : (r.paper ?? "Paper not identified")) === scope)
                .map((r) => (
                  <li key={r.id} className="rounded border border-[var(--color-border)] p-2" data-testid="paper-rule" data-kind={r.kind} data-status={r.status}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={r.status === "CONFIRMED" ? "success" : r.status === "REJECTED" ? "error" : "info"}>{r.status.toLowerCase()}</Badge>
                      <span className="font-medium">{kinds[r.kind] ?? r.kind}</span>
                      <span className="text-[var(--color-muted-foreground)]">
                        confidence {Math.round(r.confidence * 100)}% ({r.supporting} of {r.observed})
                      </span>
                      {r.contradictedBy && <Badge variant="warning">contradicted by newer evidence</Badge>}
                    </div>
                    <p className="mt-1">{r.statement}</p>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[var(--color-muted-foreground)]">Evidence ({r.evidence.length})</summary>
                      <ul className="mt-1 list-disc pl-5">
                        {r.evidence.map((e, i) => (
                          <li key={i}>
                            {e.source === "SOURCE_DOCUMENT" ? "Source document" : e.source === "OFFICIAL_KEY" ? "Official key" : "Administrator"} — “{e.fileName}”{e.fileSha256 ? ` (sha256 ${e.fileSha256.slice(0, 12)}…)` : ""}, import “{e.jobTitle}”: {e.detail} · {e.at.slice(0, 10)}
                          </li>
                        ))}
                      </ul>
                    </details>
                    {canEdit && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.status !== "CONFIRMED" && (
                          <Button size="sm" disabled={pending || !!r.contradictedBy} onClick={() => act(() => decidePaperRuleAction(examId, r.id, "CONFIRMED", ""), "Rule confirmed — it is used as a check from now on.")} data-testid="paper-rule-confirm">
                            Confirm
                          </Button>
                        )}
                        {r.status !== "REJECTED" && (
                          <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => decidePaperRuleAction(examId, r.id, "REJECTED", ""), "Rule rejected — it is never used.")} data-testid="paper-rule-reject">
                            Reject
                          </Button>
                        )}
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => removeTaxonomyMemoryAction(examId, "paperRule", r.id), "Removed (kept in the history).")}>
                          Remove
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
