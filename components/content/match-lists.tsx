import type { MatchItemView, MatchView } from "@/lib/rich-content-types";
import { RichText } from "@/components/content/rich-text";
import { QuestionMedia } from "@/components/content/question-media";
import { cn } from "@/lib/utils";

/**
 * Match the Following (NEET Phase 4): List I and List II of one question,
 * rendered from the server-built MatchView (lib/rich-content.ts#matchView).
 * The same component serves the Test Player, Review, Saved Questions and the
 * admin preview. Two columns from md up; stacked on a phone, so a long formula
 * or figure never forces a tiny table or page-level horizontal scroll (long
 * formulas scroll inside their own box, see RichText). Presentation only — the
 * coded options below it are the answer.
 */
export function MatchLists({ match, className }: { match: MatchView; className?: string }) {
  return (
    <div data-testid="match-lists" className={cn("grid grid-cols-1 gap-3 md:grid-cols-2", className)}>
      <MatchList title="List I" list="I" items={match.listI} />
      <MatchList title="List II" list="II" items={match.listII} />
    </div>
  );
}

function MatchList({ title, list, items }: { title: string; list: "I" | "II"; items: MatchItemView[] }) {
  return (
    <section
      aria-label={title}
      data-testid={`match-list-${list}`}
      className="min-w-0 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
    >
      <h3 className="mb-2 text-xs font-semibold text-[var(--color-muted-foreground)]">{title}</h3>
      <ul className="flex flex-col gap-2.5">
        {items.map((item) => (
          <li key={item.key} className="flex min-w-0 gap-2 text-sm text-[var(--color-foreground)]" data-testid="match-item" data-key={`${list}:${item.key}`}>
            <span className="w-7 shrink-0 font-semibold">{item.key}.</span>
            <div className="min-w-0 flex-1">
              <span className="whitespace-pre-wrap">
                <RichText content={item.body} />
              </span>
              {item.assets.length ? <QuestionMedia className="mt-2" size="option" assets={item.assets} /> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
