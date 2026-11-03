import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PAPER_PUBLISHED_QUESTION_COUNT } from "@/lib/pyq-membership";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PaperToggle } from "../paper-toggle";
import { QuestionBankPicker } from "./question-bank-picker";
import { PaperBatches } from "./paper-batches";
import { loadPaperBatchOverview } from "@/lib/pyq-import-batches";
import { RankingSettingsForm } from "@/components/admin/ranking-settings-form";
import { getRankingConfig } from "@/lib/leaderboard";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

export const metadata = { title: "Previous Year Paper — Mock Test Series.in Admin" };

export default async function PaperDetailPage({ params }: { params: Promise<{ paperId: string }> }) {
  const { paperId } = await params;

  const paper = await prisma.previousYearPaper.findUnique({
    where: { id: paperId },
    include: {
      exam: { select: { id: true, name: true, durationMinutes: true } },
      questions: {
        // Paper order (printed number), the same order the PYQ attempt serves.
        orderBy: [{ paperQuestionNumber: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { code: "asc" }],
        include: { subject: { select: { name: true } }, topic: { select: { name: true } }, options: { select: { isCorrect: true } } },
      },
      _count: { select: { ...PAPER_PUBLISHED_QUESTION_COUNT, testAttempts: true } },
    },
  });

  if (!paper) notFound();
  const [ranking, canManageRanking, canManageQuestions, overview] = await Promise.all([
    getRankingConfig({ kind: "PREVIOUS_YEAR_PAPER", id: paper.id }),
    hasPermission(PERMISSIONS.TEST_SERIES_MANAGE),
    hasPermission(PERMISSIONS.QUESTIONS_MANAGE),
    loadPaperBatchOverview(paper.id),
  ]);

  const subjects = (await getExamTaxonomy(prisma, paper.examId)).map((s) => ({
    id: s.id,
    name: s.name,
    topics: s.topics.map((t) => ({ id: t.id, name: t.name })),
  }));

  const subjectCounts = new Map<string, number>();
  paper.questions.forEach((q) => subjectCounts.set(q.subject.name, (subjectCounts.get(q.subject.name) ?? 0) + 1));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href="/admin/exams?tab=pyp" className="text-xs text-[var(--color-primary)] hover:underline">
            ← Previous Year Papers
          </Link>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{paper.title}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/exams/previous-year-papers/${paper.id}/dependencies`}>Question Dependencies</Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href="/admin/questions/replacements">Replacement History</Link>
          </Button>
          <PaperToggle paperId={paper.id} isActive={paper.isActive} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Paper Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Info label="Exam" value={paper.exam.name} />
            <Info label="Year" value={String(paper.year)} />
            <Info label="Paper Code" value={paper.paperCode ?? "—"} />
            <Info
              label="Duration (Standard Mode)"
              value={`${paper.durationMinutes ?? paper.exam.durationMinutes ?? 120} minutes${paper.durationMinutes == null ? " (default — not set on this paper)" : ""}`}
            />
            <Info
              label="Question Count"
              value={`${paper._count.questions} published${paper.questions.length > paper._count.questions ? ` (+${paper.questions.length - paper._count.questions} draft/archived)` : ""}`}
            />
            <Info label="Subjects" value={Array.from(subjectCounts.entries()).map(([name, n]) => `${name} (${n})`).join(", ") || "—"} />
            <Info label="Status" value={paper.isActive ? "Active" : "Inactive"} />
            <Info label="Test Attempts" value={String(paper._count.testAttempts)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ranking &amp; Leaderboard</CardTitle>
          <CardDescription>This paper&apos;s own leaderboard. Independent of Overall Rank.</CardDescription>
        </CardHeader>
        <CardContent>
          <RankingSettingsForm kind="PREVIOUS_YEAR_PAPER" testId={paper.id} values={ranking} readOnly={!canManageRanking} />
        </CardContent>
      </Card>

      <QuestionBankPicker paperId={paper.id} subjects={subjects} />

      <PaperBatches paperId={paper.id} batches={overview.batches} aiJobs={overview.aiJobs} questions={overview.questions} canManage={canManageQuestions} />
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase text-[var(--color-muted-foreground)]">{label}</div>
      <div className="text-sm font-medium text-[var(--color-foreground)]">{value}</div>
    </div>
  );
}
