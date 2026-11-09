import type { PreviewQuestion } from "@/lib/question-preview";
import { RichText } from "@/components/content/rich-text";
import { QuestionMedia } from "@/components/content/question-media";
import { HumanExplanation } from "@/components/content/human-explanation";
import { MatchLists } from "@/components/content/match-lists";
import { liveMatchView, liveRichViews } from "@/lib/rich-content";

/**
 * The full question as students see it — stem (rich text, images, diagrams),
 * match lists, every option with the correct answer marked, and the
 * explanation. Moved unchanged from Admin → Question preview; also used by the
 * Teacher Portal question list (expand) and question page. Staff only: it
 * shows the answer key.
 */
export function QuestionPreviewBody({ q }: { q: PreviewQuestion }) {
  const { rich, explanation } = liveRichViews(q);
  const match = liveMatchView(q);
  return (
    <>
    <p className="whitespace-pre-wrap text-question text-[var(--color-foreground)]">
      <RichText text={q.text} html={rich?.textHtml} />
    </p>
    {q.imageUrl && !rich?.assets.some((a) => a.role === "QUESTION") ? (
      // eslint-disable-next-line @next/next/no-img-element -- staff preview of a legacy question image
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
            // eslint-disable-next-line @next/next/no-img-element -- staff preview of a legacy option image
            <img src={o.imageUrl} alt={`${q.code} option ${o.label}`} className="mt-2 max-h-48 w-fit rounded border border-[var(--color-border)]" />
          ) : null}
          {rich ? (
            <QuestionMedia className="mt-2" size="option" assets={rich.assets.filter((a) => a.role === "OPTION" && a.optionLabel === o.label)} />
          ) : null}
        </li>
      ))}
    </ul>
    {explanation ? <HumanExplanation explanation={explanation} /> : null}
    </>
  );
}
