"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { useCostPreview } from "@/components/admin/ai/cost-preview";
import { formatInr } from "@/lib/ai-engine/config";
import type { EvalResult } from "@/lib/ai-engine/eval";
import { runModelEvalAction } from "@/app/admin/(dashboard)/ai/engine-actions";

/**
 * Medical model evaluation (paid, Master Admin). Blind-solves a random sample of
 * published PYQ MCQs and compares with the verified key. Disagreements are
 * listed for editorial review — the Question Bank is never changed.
 */
export function ModelEvaluation({ models, runs, canManage, openRouterEnabled }: { models: string[]; runs: EvalResult[]; canManage: boolean; openRouterEnabled: boolean }) {
  const router = useRouter();
  const preview = useCostPreview();
  const [pending, start] = useTransition();
  const [model, setModel] = useState(models[0] ?? "");
  const [n, setN] = useState(8);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  return (
    <Card data-testid="model-eval">
      <CardHeader>
        <CardTitle>Medical quality evaluation</CardTitle>
        <CardDescription>
          Test an approved model on up to 10 random published PYQ MCQs (blind — no answer key in the prompt) before marking it medically approved. Paid: the AI Cost Preview shows the cost first.
          Disagreements are only listed for editorial review; no answer is ever changed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {preview.dialog}
        {msg ? (
          <p role={msg.tone === "error" ? "alert" : "status"} className={`rounded-md px-3 py-2 ${msg.tone === "error" ? "bg-[var(--color-error)]/10 text-[var(--color-error)]" : "bg-[var(--color-success)]/10"}`} data-testid="eval-message">
            {msg.text}
          </p>
        ) : null}
        {canManage ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-xs">
              Approved model
              <SelectNative className="h-8 text-xs" value={model} onChange={(e) => setModel(e.target.value)} data-testid="eval-model">
                {models.length === 0 ? <option value="">Approve a text model first</option> : null}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Questions
              <SelectNative className="h-8 w-20 text-xs" value={String(n)} onChange={(e) => setN(Number(e.target.value))}>
                {[3, 5, 8, 10].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </SelectNative>
            </label>
            <Button
              size="sm"
              disabled={pending || !model || !openRouterEnabled}
              data-testid="eval-run"
              onClick={() =>
                preview.ask({ feature: "explanation_admin", evaluation: true, model, units: n, context: { evalSize: n } }, (quoteId) =>
                  start(async () => {
                    setMsg(null);
                    const r = await runModelEvalAction({ quoteId, n });
                    if (!r.ok) return setMsg({ tone: "error", text: r.error });
                    setMsg({ tone: "ok", text: `${r.data.model}: ${r.data.correct}/${r.data.n} agree with the answer key.` });
                    router.refresh();
                  })
                )
              }
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Evaluate (paid)
            </Button>
            {!openRouterEnabled ? <span className="text-xs text-[var(--color-warning)]">Enable OpenRouter first.</span> : null}
          </div>
        ) : null}
        {runs.length === 0 ? <p className="text-xs text-[var(--color-muted-foreground)]">No evaluation has been run yet.</p> : null}
        {runs.map((r) => (
          <details key={`${r.model}-${r.at}`} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-2" data-testid="eval-run-row">
            <summary className="cursor-pointer text-xs">
              <span className="font-mono">{r.model}</span>
              {` · ${new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST · agreement ${r.correct}/${r.n} · valid JSON ${r.jsonOk}/${r.n} · confident-but-wrong ${r.confidentWrong} · failed ${r.failed} · avg ${(r.avgLatencyMs / 1000).toFixed(1)} s · cost ${r.costInr === null ? "not reported" : formatInr(r.costInr, 4)}`}
            </summary>
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-[var(--color-muted-foreground)]">
                <tr>
                  <th className="py-1 pr-2 font-medium">Question</th>
                  <th className="py-1 pr-2 font-medium">Key</th>
                  <th className="py-1 pr-2 font-medium">Model</th>
                  <th className="py-1 font-medium">Reason (spot-check quality)</th>
                </tr>
              </thead>
              <tbody>
                {r.items.map((i) => (
                  <tr key={i.questionId} className={`border-t border-[var(--color-border)] align-top ${!i.correct ? "bg-[var(--color-warning)]/5" : ""}`}>
                    <td className="py-1 pr-2">
                      <Link className="underline" href={`/admin/questions?tab=add&id=${i.questionId}`}>
                        {i.code}
                      </Link>
                      {!i.correct && i.answer ? <span className="block text-[var(--color-warning)]">Editorial review</span> : null}
                    </td>
                    <td className="py-1 pr-2">{i.key}</td>
                    <td className="py-1 pr-2">{i.error ? "error" : `${i.answer ?? "invalid"}${i.confidence !== null ? ` (${Math.round(i.confidence * 100)}%)` : ""}`}</td>
                    <td className="py-1 break-words">{i.error ?? i.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}
