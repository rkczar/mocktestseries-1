import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BUCKET_LABELS, type PaperReconciliation, type ReconBucket } from "@/lib/ai-import/paper-reconciliation";

const ORDER: ReconBucket[] = ["PUBLISHED", "IN_BANK_DRAFT", "WITHDRAWN_IN_PAPER", "APPROVED_IMPORTABLE", "READY_AWAITING_APPROVAL", "BLOCKED", "WITHDRAWN_NOT_IN_PAPER", "DUPLICATE", "REJECTED", "MULTIPLE_RECORDS", "MISSING"];
const TONE: Partial<Record<ReconBucket, string>> = {
  PUBLISHED: "text-[var(--color-success)]",
  BLOCKED: "text-[var(--color-warning)]",
  WITHDRAWN_NOT_IN_PAPER: "text-[var(--color-warning)]",
  DUPLICATE: "text-[var(--color-warning)]",
  MISSING: "text-[var(--color-error)]",
  MULTIPLE_RECORDS: "text-[var(--color-error)]",
};

/** Every printed question number 1..N of the paper with its bucket and the exact reason (server-rendered, read-only). */
export function PaperReconciliationPanel({ r }: { r: PaperReconciliation }) {
  const open = r.rows.filter((x) => x.bucket !== "PUBLISHED" && x.bucket !== "WITHDRAWN_IN_PAPER");
  return (
    <Card data-testid="paper-reconciliation">
      <CardHeader>
        <CardTitle>Paper reconciliation — {r.expected} expected questions</CardTitle>
        <CardDescription>
          Every printed number is in exactly one bucket. {r.missing.length ? `Missing numbers: ${r.missing.join(", ")}.` : "No number is missing."}
          {r.unnumbered.length ? ` ${r.unnumbered.length} record(s) without a number (extraction artifacts) are not counted.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="recon-counts">
          <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-2">
            <div className="text-xs text-[var(--color-muted-foreground)]">Numbers found</div>
            <div className="text-lg font-semibold">
              {r.extracted}/{r.expected}
            </div>
          </div>
          {ORDER.filter((b) => r.counts[b] > 0).map((b) => (
            <div key={b} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-2" data-testid={`recon-count-${b}`}>
              <div className="text-xs text-[var(--color-muted-foreground)]">{BUCKET_LABELS[b]}</div>
              <div className={`text-lg font-semibold ${TONE[b] ?? ""}`}>{r.counts[b]}</div>
            </div>
          ))}
        </div>
        {open.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="recon-table">
              <thead className="text-[var(--color-muted-foreground)]">
                <tr>
                  <th className="py-1 pr-3">Q</th>
                  <th className="py-1 pr-3">Page</th>
                  <th className="py-1 pr-3">Status</th>
                  <th className="py-1 pr-3">Exact reason</th>
                  <th className="py-1">Force to Publish</th>
                </tr>
              </thead>
              <tbody>
                {open.map((x) => (
                  <tr key={x.number} className="border-t border-[var(--color-border)] align-top" data-testid="recon-row" data-number={x.number} data-bucket={x.bucket}>
                    <td className="py-1 pr-3 font-semibold">{x.ids[0] ? <Link className="underline" href={`/admin/ai-importer/questions/${x.ids[0]}`}>Q{x.number}</Link> : `Q${x.number}`}</td>
                    <td className="py-1 pr-3">{x.pages.join(", ") || "—"}</td>
                    <td className={`py-1 pr-3 ${TONE[x.bucket] ?? ""}`}>{BUCKET_LABELS[x.bucket]}</td>
                    <td className="py-1 pr-3">{x.reason || "—"}</td>
                    <td className="py-1">{x.forceAvailable ? "Master Admin" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[var(--color-success)]">Every number is published or shown as withdrawn.</p>
        )}
      </CardContent>
    </Card>
  );
}
