"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";

export interface ManifestRow {
  id: string;
  file: string;
  page: number;
  status: string;
  outcome: string | null;
  reason: string | null;
  method: string | null;
  ocrConfidence: number | null;
  ocrLowLines: number | null;
  ink: number | null;
  questions: string[];
  hasOcr: boolean;
  hasImage: boolean;
}

const LABEL: Record<string, string> = {
  TEXT_LAYER: "Text layer",
  OCR: "Local OCR",
  AI: "AI vision",
  BLANK_VERIFIED: "Blank (checked)",
  INSTRUCTIONS: "Not questions",
  NO_QUESTIONS: "No question found",
  NEEDS_REVIEW: "Needs review",
  FAILED: "Failed",
};
const TONE: Record<string, "success" | "warning" | "error" | "info"> = {
  TEXT_LAYER: "success",
  OCR: "success",
  AI: "info",
  BLANK_VERIFIED: "info",
  INSTRUCTIONS: "info",
  NO_QUESTIONS: "error",
  NEEDS_REVIEW: "error",
  FAILED: "error",
};
const ATTENTION = new Set(["NO_QUESTIONS", "NEEDS_REVIEW", "FAILED"]);

type Filter = "all" | "attention" | "uncertain" | "not-questions";

function outcomeOf(r: ManifestRow): string {
  if (r.outcome) return r.outcome;
  if (r.status === "PENDING") return "PENDING";
  return "LEGACY";
}

/** Every page of the job with its documented outcome — what was read, how, and why a page holds no questions. */
export function PageManifest({ rows }: { rows: ManifestRow[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const attention = (r: ManifestRow) => ATTENTION.has(outcomeOf(r)) || outcomeOf(r) === "LEGACY";
  const counts = {
    all: rows.length,
    attention: rows.filter(attention).length,
    uncertain: rows.filter((r) => (r.ocrLowLines ?? 0) > 0).length,
    "not-questions": rows.filter((r) => r.outcome === "BLANK_VERIFIED" || r.outcome === "INSTRUCTIONS").length,
  };
  const shown = rows.filter((r) => (filter === "all" ? true : filter === "attention" ? attention(r) : filter === "uncertain" ? (r.ocrLowLines ?? 0) > 0 : r.outcome === "BLANK_VERIFIED" || r.outcome === "INSTRUCTIONS"));
  const chips: { id: Filter; label: string }[] = [
    { id: "all", label: "All pages" },
    { id: "attention", label: "Needs attention" },
    { id: "uncertain", label: "OCR uncertain" },
    { id: "not-questions", label: "Blank / not questions" },
  ];
  return (
    <section className="space-y-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-4" data-testid="page-manifest">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">Pages</h3>
        <p className="text-xs text-[var(--color-muted-foreground)]">Every page must be read, blank (checked on the page image) or explained before the paper can be completed.</p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter pages">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setFilter(c.id)}
            aria-pressed={filter === c.id}
            data-testid={`manifest-filter-${c.id}`}
            className={`rounded-full border px-3 py-1 text-xs ${filter === c.id ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]" : "border-[var(--color-border)]"}`}
          >
            {c.label} ({counts[c.id]})
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted-foreground)]">
              <th className="py-1.5 pr-2">Page</th>
              <th className="py-1.5 pr-2">Outcome</th>
              <th className="hidden py-1.5 pr-2 sm:table-cell">Read by</th>
              <th className="py-1.5 pr-2">OCR</th>
              <th className="py-1.5 pr-2">Questions</th>
              <th className="py-1.5 pr-2">Details</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const o = outcomeOf(r);
              return (
                <tr key={r.id} className="border-b border-[var(--color-border)] align-top" data-testid="manifest-row" data-outcome={o} data-page={r.page}>
                  <td className="py-1.5 pr-2 whitespace-nowrap">
                    {r.page}
                    <div className="max-w-[10rem] truncate text-[11px] text-[var(--color-muted-foreground)]" title={r.file}>{r.file}</div>
                  </td>
                  <td className="py-1.5 pr-2">
                    <Badge variant={TONE[o] ?? "warning"}>{LABEL[o] ?? (o === "PENDING" ? "Waiting" : "Not checked")}</Badge>
                  </td>
                  <td className="hidden py-1.5 pr-2 text-xs sm:table-cell">{r.method ?? "—"}</td>
                  <td className="py-1.5 pr-2 text-xs whitespace-nowrap">
                    {r.ocrConfidence !== null ? `${(r.ocrConfidence * 100).toFixed(1)}%` : "—"}
                    {(r.ocrLowLines ?? 0) > 0 ? <div className="text-[var(--color-warning)]">{r.ocrLowLines} unsure</div> : null}
                    {r.ink !== null ? <div className="text-[11px] text-[var(--color-muted-foreground)]">ink {(r.ink * 100).toFixed(1)}%</div> : null}
                  </td>
                  <td className="py-1.5 pr-2 text-xs">{r.questions.length ? `${r.questions.length}: ${r.questions.slice(0, 8).join(", ")}${r.questions.length > 8 ? " …" : ""}` : "—"}</td>
                  <td className="py-1.5 pr-2 text-xs">
                    <div className="max-w-[22rem]">{r.reason ?? (o === "LEGACY" ? "Processed before page checks existed." : "—")}</div>
                    <div className="mt-1 flex gap-3">
                      {r.hasImage ? (
                        <a className="underline" href={`/api/admin/ai-importer/pages/${r.id}/image`} target="_blank" rel="noopener noreferrer">
                          Page image
                        </a>
                      ) : null}
                      {r.hasOcr ? (
                        <a className="underline" href={`/api/admin/ai-importer/pages/${r.id}/ocr`} target="_blank" rel="noopener noreferrer" data-testid="manifest-ocr-link">
                          Original OCR text
                        </a>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!shown.length ? (
              <tr>
                <td colSpan={6} className="py-3 text-center text-xs text-[var(--color-muted-foreground)]">
                  No pages in this view.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
