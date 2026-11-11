import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { QuestionPreviewBody } from "@/components/content/question-preview-body";
import { QUESTION_TYPE_LABEL, matchAssetKey, readMatchSpec, toQuestionType } from "@/lib/question-types";
import { mediaUrl } from "@/lib/media-storage";
import { MediaManager } from "./media-manager";

export const metadata = { title: "Preview Question — Mock Test Series.in Admin" };

/**
 * Read-only preview of ONE question in any status (DRAFT included) through
 * the same renderer students get — so RICH_V1 math, chemistry, images and the
 * human explanation can be checked without publishing anything. Admin only;
 * the answer key and explanation are shown.
 */
export default async function QuestionPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await hasPermission(PERMISSIONS.QUESTIONS_MANAGE))) notFound();
  const { id } = await params;
  const q = await prisma.question.findUnique({
    where: { id },
    select: {
      id: true,
      code: true,
      text: true,
      imageUrl: true,
      status: true,
      answerVerification: true,
      contentFormat: true,
      editorialStage: true,
      explanation: true,
      questionType: true,
      matchSpec: true,
      examYear: true,
      source: true,
      exam: { select: { name: true } },
      subject: { select: { name: true } },
      topic: { select: { name: true } },
      subTopic: { select: { name: true } },
      previousYearPaper: { select: { title: true, year: true, paperCode: true } },
      options: { orderBy: { order: "asc" }, select: { label: true, text: true, imageUrl: true, isCorrect: true } },
      assets: {
        orderBy: [{ role: "asc" }, { optionLabel: "asc" }, { order: "asc" }],
        select: { id: true, role: true, optionLabel: true, listKey: true, order: true, storageKey: true, alt: true, caption: true, width: true, height: true, bytes: true, sha256: true, darkBacking: true },
      },
    },
  });
  if (!q) notFound();
  // Provenance of a question added by the AI Question Importer (the import record outlives the question).
  const imported = await prisma.aiImportQuestion.findFirst({ where: { questionId: q.id }, orderBy: { importedAt: "desc" }, select: { jobId: true, id: true, sourceLabel: true, pages: true, data: true, editedData: true, answerStatus: true, job: { select: { title: true } } } });
  const importedSection = imported ? (((imported.editedData ?? imported.data) as { section?: string } | null)?.section ?? "") : "";
  const spec = q.questionType === "MATCH_THE_FOLLOWING" ? readMatchSpec(q.matchSpec) : null;
  const listKeys = spec ? [...spec.listI.map((e) => matchAssetKey("I", e.key)), ...spec.listII.map((e) => matchAssetKey("II", e.key))] : [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
        <span className="font-mono">{q.code}</span> · {q.exam.name} · {q.subject.name}
        <Badge variant="neutral">{q.status}</Badge>
        <Badge variant="neutral">{q.contentFormat}</Badge>
        {q.questionType !== "SINGLE_CORRECT" ? <Badge variant="neutral">{QUESTION_TYPE_LABEL[toQuestionType(q.questionType)]}</Badge> : null}
        {q.editorialStage ? <Badge variant="neutral">{q.editorialStage}</Badge> : null}
        {q.answerVerification === "UNVERIFIED" ? <Badge variant="warning">Answer unverified (no official key)</Badge> : null}
        {q.answerVerification === "ADMIN_CONFIRMED" ? <Badge variant="info">Answer chosen by an administrator</Badge> : null}
        {q.answerVerification === "OFFICIAL_KEY" ? <Badge variant="success">Official answer key</Badge> : null}
        {q.answerVerification === "PROVISIONAL_KEY" ? <Badge variant="warning" data-testid="badge-provisional-key">Provisional answer key (model key, not final)</Badge> : null}
        {q.answerVerification === "INDEPENDENTLY_VERIFIED" ? <Badge variant="success">Answer independently verified</Badge> : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-xs sm:grid-cols-3" data-testid="question-facts">
        <div>
          <dt className="text-[var(--color-muted-foreground)]">Exam</dt>
          <dd className="font-medium" data-testid="qf-exam">{q.exam.name}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-muted-foreground)]">Subject › Topic › Sub-topic</dt>
          <dd className="font-medium" data-testid="qf-taxonomy">
            {q.subject.name} › {q.topic?.name ?? "—"}
            {q.subTopic ? ` › ${q.subTopic.name}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--color-muted-foreground)]">Previous Year Paper</dt>
          <dd className="font-medium" data-testid="qf-paper">{q.previousYearPaper ? `${q.previousYearPaper.title} (${q.previousYearPaper.year}${q.previousYearPaper.paperCode ? `, ${q.previousYearPaper.paperCode}` : ""})` : "—"}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-muted-foreground)]">Year · Source</dt>
          <dd className="font-medium">
            {q.examYear ?? "—"} · {q.source === "PYQ" ? "Previous Year Paper" : q.source.replace(/_/g, " ").toLowerCase()}
          </dd>
        </div>
        {imported && (
          <div className="col-span-2" data-testid="qf-import">
            <dt className="text-[var(--color-muted-foreground)]">Imported by the AI Question Importer</dt>
            <dd className="font-medium">
              Original question {importedSection ? `${importedSection} ` : ""}
              {imported.sourceLabel} · page {imported.pages.join(", ") || "—"} ·{" "}
              <Link className="underline" href={`/admin/ai-importer/questions/${imported.id}`}>
                {imported.job.title}
              </Link>
            </dd>
          </div>
        )}
      </dl>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-5" data-testid="admin-question-preview">
          <QuestionPreviewBody q={q} />
        </CardContent>
      </Card>
      <MediaManager
        questionId={q.id}
        status={q.status}
        contentFormat={q.contentFormat}
        explanation={q.explanation}
        optionLabels={q.options.map((o) => o.label)}
        listKeys={listKeys}
        assets={q.assets.map((a) => ({ ...a, url: mediaUrl(a.storageKey) }))}
      />
    </div>
  );
}
