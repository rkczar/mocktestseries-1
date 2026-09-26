"use client";

import Link from "next/link";
import { useFormStatus } from "react-dom";
import { ArrowRight, FileText, Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { startPaperFromExamAction } from "../exams/[examId]/actions";
import type { DashboardPaperView } from "./pyq-view";

/** Beyond this many, the section links to the exam page's full list instead of growing the dashboard. */
const MAX_PAPERS = 6;

/**
 * Previous Year Papers on the Student Dashboard. Start reuses the exam page's
 * startPaperFromExamAction → startPreviousYearPaperAttempt, which resumes an
 * IN_PROGRESS attempt instead of creating a second one, then lands on the
 * canonical attempt → Universal Test Player → Result → Review flow.
 */
export function PreviousYearPapers({ papers, examId, examName }: { papers: DashboardPaperView[]; examId: string; examName: string }) {
  if (papers.length === 0) return null;
  const shown = papers.slice(0, MAX_PAPERS);

  return (
    <section aria-labelledby="previous-year-papers" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="previous-year-papers" className="text-sm font-semibold text-[var(--color-foreground)]">
          Previous Year Papers<span className="font-normal text-[var(--color-muted-foreground)]"> · {examName}</span>
        </h2>
        {papers.length > MAX_PAPERS ? (
          <Link href={`/student/exams/${examId}`} className="text-xs font-medium text-[var(--color-primary)] hover:underline">
            View all {papers.length} papers
          </Link>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((p) => (
          <PaperCard key={p.id} paper={p} />
        ))}
      </div>
    </section>
  );
}

function PaperCard({ paper: p }: { paper: DashboardPaperView }) {
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-3 pt-5">
        <div className="flex items-start gap-3">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-[var(--color-foreground)]">{p.title}</p>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              {[String(p.year), p.paperCode ? `Code ${p.paperCode}` : null, `${p.questionCount} Questions`].filter(Boolean).join(" · ")}
            </p>
          </div>
          {p.locked ? null : p.inProgressAttemptId ? (
            <Badge variant="warning" className="shrink-0">
              In progress
            </Badge>
          ) : p.lastSubmittedAttemptId ? (
            <Badge variant="success" className="shrink-0">
              Attempted
            </Badge>
          ) : null}
        </div>
        <div className="mt-auto flex flex-wrap gap-2">
          <PaperActions paper={p} />
        </div>
      </CardContent>
    </Card>
  );
}

function PaperActions({ paper: p }: { paper: DashboardPaperView }) {
  if (p.locked) {
    return (
      <>
        <Badge variant="warning">
          <Lock className="h-3 w-3" aria-hidden /> {p.locked.label}
        </Badge>
        {p.locked.href ? (
          <Button asChild size="sm">
            <Link href={p.locked.href}>{p.locked.ctaLabel}</Link>
          </Button>
        ) : (
          <Button size="sm" disabled>
            Not available
          </Button>
        )}
      </>
    );
  }

  if (p.inProgressAttemptId) {
    return (
      <Button asChild size="sm">
        <Link href={`/student/attempt/${p.inProgressAttemptId}/run`}>
          Resume <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </Button>
    );
  }

  if (p.lastSubmittedAttemptId) {
    return (
      <>
        <Button asChild size="sm" variant="outline">
          <Link href={`/student/attempt/${p.lastSubmittedAttemptId}/result`}>View Result</Link>
        </Button>
        <form action={startPaperFromExamAction.bind(null, p.id)}>
          <StartButton label="Reattempt" variant="ghost" />
        </form>
      </>
    );
  }

  return (
    <form action={startPaperFromExamAction.bind(null, p.id)}>
      <StartButton label="Start" />
    </form>
  );
}

/** Disabled while the start request is in flight, so a double tap can't fire a second start. */
function StartButton({ label, variant = "primary" }: { label: string; variant?: "primary" | "ghost" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending}>
      {pending ? "Starting…" : label}
    </Button>
  );
}
