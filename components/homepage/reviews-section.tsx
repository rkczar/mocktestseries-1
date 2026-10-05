import { BadgeCheck, Star } from "lucide-react";
import { REVIEW_SPEED_PX, type PublicReview, type ReviewsSectionSettings } from "@/lib/reviews-shared";
import { ReviewsMarquee } from "./reviews-marquee";

/** Fewer reviews than this render as a still, swipeable row — a loop of 2–3 cards looks repetitive. */
const MIN_FOR_MARQUEE = 4;
/** Each loop group holds at least this many cards so one group is wider than a large desktop viewport. */
const MIN_GROUP_CARDS = 10;
const LONG_COMMENT = 170;

/**
 * Homepage "What Students Say". Server-rendered from admin-managed reviews
 * (lib/reviews.ts) — there is no hardcoded fallback content; with no
 * published reviews the caller renders nothing. Every value is React text
 * (escaped). No review/rating structured data is emitted on purpose.
 */
export function ReviewsSection({ settings, reviews }: { settings: ReviewsSectionSettings; reviews: PublicReview[] }) {
  if (reviews.length === 0) return null;
  const animate = settings.autoScroll && reviews.length >= MIN_FOR_MARQUEE;

  // Animated: group A = the reviews (+ aria-hidden repeats to fill wide
  // screens), group B = an aria-hidden copy of A for the seamless wrap.
  const repeats = animate ? Math.max(1, Math.ceil(MIN_GROUP_CARDS / reviews.length)) : 1;
  const groupItems = Array.from({ length: repeats }, (_, r) => reviews.map((review) => ({ review, copy: r > 0 }))).flat();

  const header = (
    <div className="flex max-w-2xl flex-col gap-3">
      <h2 id="student-reviews-heading" className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)] sm:text-3xl">
        {settings.heading}
      </h2>
      {settings.subtitle ? <p className="leading-relaxed text-[var(--color-muted-foreground)]">{settings.subtitle}</p> : null}
    </div>
  );

  return (
    <section id="student-reviews" aria-labelledby="student-reviews-heading" className="scroll-mt-20 border-t border-[var(--color-border)] py-14 sm:py-20">
      <ReviewsMarquee header={header} animate={animate} speedPx={REVIEW_SPEED_PX[settings.speed]} direction={settings.direction}>
        <ul className="flex gap-4 pr-4" aria-label="Student reviews">
          {groupItems.map(({ review, copy }, i) => (
            <ReviewCard key={`a${i}`} review={review} settings={settings} hidden={copy} popoverId={copy ? null : `review-full-${review.key}`} />
          ))}
        </ul>
        {animate ? (
          <ul className="flex gap-4 pr-4 motion-reduce:hidden" aria-hidden inert>
            {groupItems.map(({ review }, i) => (
              <ReviewCard key={`b${i}`} review={review} settings={settings} hidden popoverId={null} />
            ))}
          </ul>
        ) : null}
      </ReviewsMarquee>
    </section>
  );
}

function ReviewCard({
  review,
  settings,
  hidden,
  popoverId,
}: {
  review: PublicReview;
  settings: ReviewsSectionSettings;
  hidden: boolean;
  popoverId: string | null;
}) {
  const long = review.comment.length > LONG_COMMENT;
  return (
    <li
      className={`flex w-[78vw] max-w-[340px] shrink-0 snap-start sm:w-[320px] lg:w-[300px] ${hidden ? "motion-reduce:hidden" : ""}`}
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <figure
        data-review-card
        tabIndex={hidden ? -1 : 0}
        aria-label={`Review by ${review.name}${settings.showRating ? `, rated ${review.rating} out of 5` : ""}`}
        className="flex w-full flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-[var(--shadow-card)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
      >
        {settings.showRating ? <Stars rating={review.rating} /> : null}
        <blockquote className="flex-1 text-sm leading-relaxed text-[var(--color-foreground)]">
          <p className="line-clamp-5 whitespace-pre-line">{review.comment}</p>
          {long && popoverId ? (
            <>
              <button
                type="button"
                popoverTarget={popoverId}
                className="mt-1 text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
              >
                Read full review
              </button>
              <div
                id={popoverId}
                popover="auto"
                role="dialog"
                aria-label={`Full review by ${review.name}`}
                className="m-auto w-[min(92vw,32rem)] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-sm leading-relaxed text-[var(--color-foreground)] shadow-[var(--shadow-card)] backdrop:bg-black/50"
              >
                <p className="whitespace-pre-line">{review.comment}</p>
                <p className="mt-4 text-xs text-[var(--color-muted-foreground)]">— {review.name}</p>
                <button
                  type="button"
                  popoverTarget={popoverId}
                  popoverTargetAction="hide"
                  className="mt-4 text-xs font-medium text-[var(--color-primary)] hover:underline"
                >
                  Close
                </button>
              </div>
            </>
          ) : null}
        </blockquote>
        <figcaption className="flex items-center gap-3 border-t border-[var(--color-border)] pt-4">
          <span
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-sm font-semibold text-[var(--color-primary)]"
            aria-hidden
          >
            {review.name.charAt(0).toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-sm font-medium text-[var(--color-foreground)]">{review.name}</span>
              {review.verified ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-success)]">
                  <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
                  Verified Student
                </span>
              ) : null}
            </span>
            {review.exam ? <span className="truncate text-xs text-[var(--color-muted-foreground)]">{review.exam}</span> : null}
          </span>
        </figcaption>
      </figure>
    </li>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="flex items-center gap-0.5" role="img" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={n <= rating ? "h-4 w-4 fill-[var(--color-warning)] text-[var(--color-warning)]" : "h-4 w-4 text-[var(--color-border)]"}
          aria-hidden
        />
      ))}
    </span>
  );
}
