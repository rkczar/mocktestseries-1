import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ISSUE_DEFS, QUESTION_STATUS_LABELS } from "@/lib/ai-import/config";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { importBlocker, publishBlocker } from "@/lib/ai-import/adapter";
import { effective } from "@/lib/ai-import/post";
import { ExceptionsTable, type ExceptionRow } from "./exceptions-table";

export const metadata = { title: "AI Import Review Exceptions — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const EXCEPTION_STATUSES = ["NEEDS_CORRECTION", "NOT_IMPORTABLE", "DUPLICATE", "IMPORT_FAILED", "EXTRACTED"] as const;

/**
 * Admin → AI Question Importer → Review Exceptions: only the questions that
 * need a decision (nobody has to review every question). `status=all` lists
 * a whole job, e.g. to publish a selection.
 */
export default async function ExceptionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="Review Exceptions" />;
  const sp = await searchParams;
  const [canUse, canPublish, settings] = await Promise.all([hasPermission(PERMISSIONS.AI_IMPORTER_USE), hasPermission(PERMISSIONS.QUESTIONS_MANAGE), getImporterSettings()]);
  const jobs = await prisma.aiImportJob.findMany({ orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, title: true, status: true } });
  const jobId = sp.job && jobs.some((j) => j.id === sp.job) ? sp.job : undefined;
  const status = sp.status === "all" ? null : sp.status && sp.status in QUESTION_STATUS_LABELS ? sp.status : "exceptions";
  const issue = sp.issue && sp.issue in ISSUE_DEFS ? sp.issue : undefined;
  const where: Prisma.AiImportQuestionWhereInput = {
    ...(jobId ? { jobId } : {}),
    ...(status === "exceptions" ? { status: { in: [...EXCEPTION_STATUSES] } } : status ? { status: status as never } : {}),
    ...(issue ? { issueCodes: { has: issue } } : {}),
  };
  const rows = await prisma.aiImportQuestion.findMany({ where, orderBy: [{ jobId: "asc" }, { fileId: "asc" }, { orderIndex: "asc" }], take: 1000, include: { figures: true } });
  const subjects = await prisma.subject.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.subjectId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const topics = await prisma.topic.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.topicId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const view: ExceptionRow[] = rows.map((r) => {
    const e = effective(r);
    return {
      id: r.id,
      jobId: r.jobId,
      label: r.sourceLabel,
      section: e.section,
      stem: e.stem.slice(0, 220),
      status: r.status,
      answerStatus: r.answerStatus,
      issues: r.issueCodes,
      issueText: (r.issues as Record<string, string> | null) ?? {},
      subject: subjects.find((s) => s.id === r.subjectId)?.name ?? null,
      topic: topics.find((t) => t.id === r.topicId)?.name ?? null,
      finalAnswer: r.finalAnswer,
      figures: r.figures.length,
      importBlocker: importBlocker(r, settings),
      publishBlocker: r.questionId ? publishBlocker(r, settings) : importBlocker(r, settings) ?? publishBlocker(r, settings),
      questionId: r.questionId,
    };
  });
  const issueCounts = new Map<string, number>();
  for (const r of rows) for (const c of r.issueCodes) issueCounts.set(c, (issueCounts.get(c) ?? 0) + 1);
  const link = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ job: jobId, status: sp.status, issue, ...patch })) if (v) u.set(k, v);
    return `/admin/ai-importer/exceptions?${u}`;
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Review Exceptions</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">
          Only questions that need a decision are listed. Questions that pass every check import (and publish) in bulk from the job page — no one-by-one review needed.
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-2 py-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <span className="text-[var(--color-muted-foreground)]">Job:</span>
            <Link className={!jobId ? "font-semibold underline" : "underline"} href={link({ job: undefined })}>
              All
            </Link>
            {jobs.map((j) => (
              <Link key={j.id} className={jobId === j.id ? "font-semibold underline" : "underline"} href={link({ job: j.id })}>
                {j.title}
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="text-[var(--color-muted-foreground)]">Show:</span>
            <Link className={status === "exceptions" ? "font-semibold underline" : "underline"} href={link({ status: undefined })}>
              Exceptions
            </Link>
            <Link className={status === null ? "font-semibold underline" : "underline"} href={link({ status: "all" })}>
              All questions
            </Link>
            {Object.entries(QUESTION_STATUS_LABELS).map(([k, v]) => (
              <Link key={k} className={status === k ? "font-semibold underline" : "underline"} href={link({ status: k })}>
                {v}
              </Link>
            ))}
          </div>
          {issueCounts.size > 0 && (
            <div className="flex flex-wrap gap-2">
              <span className="text-[var(--color-muted-foreground)]">Issue:</span>
              {issue && (
                <Link className="underline" href={link({ issue: undefined })}>
                  any
                </Link>
              )}
              {[...issueCounts].map(([c, n]) => (
                <Link key={c} className={issue === c ? "font-semibold underline" : "underline"} href={link({ issue: c })}>
                  {ISSUE_DEFS[c]?.label ?? c} ({n})
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{rows.length} question(s)</CardTitle>
          <CardDescription>Open a question to see its source page beside the extracted question, fix it, set the answer or topic, or confirm its figures.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <ExceptionsTable rows={view} canUse={canUse} canPublish={canPublish && canUse} jobId={jobId ?? null} />
        </CardContent>
      </Card>
    </div>
  );
}
