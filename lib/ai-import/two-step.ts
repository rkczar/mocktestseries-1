import "server-only";
import { prisma } from "@/lib/prisma";
import { autoVerifyOf, statusesStale, type AutoStep } from "@/lib/ai-import/auto-verify";
import { isStored, reviewBucket, type ReviewBucket } from "@/lib/ai-import/review-filters";

/** What the two-step importer screen shows for one job (Step 1 Import & Process, Step 2 Review & Approve). */
export interface TwoStepView {
  jobId: string;
  status: string;
  finished: boolean;
  busy: boolean;
  /** Background verification: where it stands, and why it waits (null = running or done). */
  auto: { step: AutoStep; held: string | null } | null;
  verify2: string | null;
  verifyAnswers: string | null;
  statusesStale: boolean;
  /** Provider / model switches recorded for this job (fallback chain, replacements). */
  fallbacks: number;
  /** Requests that failed for a provider reason (timeouts, rate limits, key limits, …) — never question errors. */
  providerFailures: number;
  buckets: Record<ReviewBucket, number>;
}

const FINISHED = ["NEEDS_REVIEW", "COMPLETED", "COMPLETED_WITH_ISSUES"];
const BUSY = ["ANALYZING", "QUEUED", "PROCESSING", "IMPORTING"];

export async function twoStepView(jobId: string): Promise<TwoStepView | null> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { status: true, config: true } });
  if (!job) return null;
  const [rows, fallbacks, providerFailures] = await Promise.all([
    prisma.aiImportQuestion.findMany({ where: { jobId }, select: { status: true, issueCodes: true, approvedById: true, questionId: true } }),
    prisma.aiImportEvent.count({ where: { jobId, type: { in: ["PROVIDER_FALLBACK", "MODEL_SWITCHED", "MODEL_REPLACED"] } } }),
    prisma.aiImportAiCall.count({ where: { jobId, ok: false, errorCategory: { notIn: ["unusable", "empty_response", "truncated"] } } }),
  ]);
  const buckets: Record<ReviewBucket, number> = { clean: 0, approved: 0, "needs-you": 0, system: 0, done: 0 };
  for (const q of rows) buckets[reviewBucket({ status: q.status, issueCodes: q.issueCodes, approved: !!q.approvedById, stored: isStored(q) })]++;
  const cfg = (job.config ?? {}) as { verify2?: { status?: string; outcome?: string }; verifyAnswers?: { status?: string } };
  const auto = autoVerifyOf(job.config);
  const finished = FINISHED.includes(job.status);
  return {
    jobId,
    status: job.status,
    finished,
    busy: BUSY.includes(job.status),
    auto: auto ? { step: auto.step, held: auto.held } : null,
    verify2: cfg.verify2?.status ? `${cfg.verify2.status}${cfg.verify2.outcome ? ` (${cfg.verify2.outcome})` : ""}` : null,
    verifyAnswers: cfg.verifyAnswers?.status ?? null,
    statusesStale: finished && rows.length > 0 && statusesStale(job.config),
    fallbacks,
    providerFailures,
    buckets,
  };
}
