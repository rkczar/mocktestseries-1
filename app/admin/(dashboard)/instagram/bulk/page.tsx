import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listBatches, BATCH_MAX } from "@/lib/instagram/batch";
import { SCORE_DISCLAIMER, selectionFilterOptions } from "@/lib/instagram/selection";
import { BulkCreate } from "@/components/admin/instagram/bulk-create";

export const metadata = { title: "Bulk Studio — Instagram — Mock Test Series.in Admin" };

const ID = /^[a-z0-9]{10,40}$/i;
const STATUS_LABEL: Record<string, string> = { DRAFTING: "Drafting", QUEUE_RUNNING: "Publishing queue running", QUEUE_PAUSED: "Queue paused", QUEUE_STOPPED: "Queue stopped", COMPLETE: "Queue complete" };

/**
 * Admin → Instagram → Bulk Studio: Select exam → smart question selection
 * (transparent Content Opportunity Score) → choose 5, 10 or a custom number →
 * one separate draft per question, each with its own design → generate,
 * preview / edit → select completed drafts → one "Confirm & Publish Selected"
 * → attended publishing queue.
 */
export default async function BulkStudioPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const examParam = typeof sp.examId === "string" && ID.test(sp.examId) ? sp.examId : null;
  const [batches, options] = await Promise.all([listBatches(), selectionFilterOptions(examParam)]);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>New batch</CardTitle>
          <CardDescription>{`Pick up to ${BATCH_MAX} previous-year questions. Each becomes its own carousel with its own design, diagram, examiner trap, caption, review and approval. ${SCORE_DISCLAIMER}`}</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          {options.exams.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No exam is in Instagram Studio&apos;s scope yet. Choose exams in Instagram → Settings → Exam scope.</p>
          ) : (
            <BulkCreate options={options} />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Batches</CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          {batches.length === 0 ? <p className="text-sm text-[var(--color-muted-foreground)]">No batches yet.</p> : null}
          <ul className="flex flex-col divide-y divide-[var(--color-border)]" data-testid="batch-list">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <Link href={`/admin/instagram/bulk/${b.id}`} className="flex-1 font-medium hover:underline">
                  {b.name}
                </Link>
                <Badge variant={b.status === "QUEUE_RUNNING" ? "success" : b.status === "QUEUE_PAUSED" ? "warning" : "neutral"}>{STATUS_LABEL[b.status] ?? b.status}</Badge>
                <span className="text-xs text-[var(--color-muted-foreground)]">{`${b.items} posts · ${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(b.createdAt))}`}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
