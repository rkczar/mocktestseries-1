import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RichText } from "@/components/content/rich-text";
import { QuestionMedia } from "@/components/content/question-media";
import { HumanExplanation } from "@/components/content/human-explanation";
import { liveMatchView, liveRichViews } from "@/lib/rich-content";
import { MatchLists } from "@/components/content/match-lists";
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
      contentFormat: true,
      editorialStage: true,
      explanation: true,
      questionType: true,
      matchSpec: true,
      exam: { select: { name: true } },
      subject: { select: { name: true } },
      options: { orderBy: { order: "asc" }, select: { label: true, text: true, imageUrl: true, isCorrect: true } },
      assets: {
        orderBy: [{ role: "asc" }, { optionLabel: "asc" }, { order: "asc" }],
        select: { id: true, role: true, optionLabel: true, listKey: true, order: true, storageKey: true, alt: true, caption: true, width: true, height: true, bytes: true, sha256: true, darkBacking: true },
      },
    },
  });
  if (!q) notFound();
  const { rich, explanation } = liveRichViews(q);
  const match = liveMatchView(q);
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
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-5" data-testid="admin-question-preview">
          <p className="whitespace-pre-wrap text-question text-[var(--color-foreground)]">
            <RichText text={q.text} html={rich?.textHtml} />
          </p>
          {q.imageUrl && !rich?.assets.some((a) => a.role === "QUESTION") ? (
            // eslint-disable-next-line @next/next/no-img-element -- admin preview of a legacy question image
            <img src={q.imageUrl} alt={`${q.code} image`} className="max-h-72 w-fit rounded border border-[var(--color-border)]" />
          ) : null}
          {rich ? <QuestionMedia assets={rich.assets.filter((a) => a.role === "QUESTION")} /> : null}
          {match ? <MatchLists match={match} /> : null}
          <ul className="flex flex-col gap-2">
            {q.options.map((o) => (
              <li
                key={o.label}
                className={
                  o.isCorrect
                    ? "rounded-[var(--radius-card)] border border-[var(--color-success)] bg-[var(--color-success)]/10 p-3 text-sm"
                    : "rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm"
                }
              >
                <span className="font-semibold">{o.label}.</span> <RichText text={o.text} html={rich?.optionHtml[o.label]} />
                {o.isCorrect ? <span className="ml-2 text-xs font-medium text-[var(--color-success)]">Correct answer</span> : null}
                {o.imageUrl && !rich?.assets.some((a) => a.role === "OPTION" && a.optionLabel === o.label) ? (
                  // eslint-disable-next-line @next/next/no-img-element -- admin preview of a legacy option image
                  <img src={o.imageUrl} alt={`${q.code} option ${o.label}`} className="mt-2 max-h-48 w-fit rounded border border-[var(--color-border)]" />
                ) : null}
                {rich ? (
                  <QuestionMedia className="mt-2" size="option" assets={rich.assets.filter((a) => a.role === "OPTION" && a.optionLabel === o.label)} />
                ) : null}
              </li>
            ))}
          </ul>
          {explanation ? <HumanExplanation explanation={explanation} /> : null}
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
