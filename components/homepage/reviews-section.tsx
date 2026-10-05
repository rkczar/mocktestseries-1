import { BadgeCheck, Star } from "lucide-react";
import { REVIEW_SPEED_PX, type PublicReview, type ReviewsSectionSettings } from "@/lib/reviews-shared";
import { ReviewsMarquee } from "./reviews-marquee";

/** Fewer reviews than this render as a still, swipeable row — a loop of 2–3 cards looks repetitive. */
const MIN_FOR_MARQUEE = 4;
/** Each loop group holds at least this many cards so one group is wider than a large desktop viewport (dashboard: its column). */
const MIN_GROUP_CARDS = { homepage: 10, dashboard: 6 } as const;
/** The dashboard copy moves slower than the admin speed: it sits inside the authenticated workspace. */
const DASHBOARD_SPEED_FACTOR = 0.6;
const LONG_COMMENT = 170;
const LONG_COMMENT_COMPACT = 130;

/**
 * Homepage "What Students Say". Server-rendered from admin-managed reviews
 * (lib/reviews.ts) — there is no hardcoded fallback content; with no
 * published reviews the caller renders nothing. Every value is React text
 * (escaped). No review/rating structured data is emitted on purpose.
 *
 * `variant="dashboard"` is the compact Student Dashboard copy (block
 * "student-reviews"): same data and rules, smaller heading and cards, slower.
 */
export function ReviewsSection({
  settings,
  reviews,
  variant = "homepage",
}: {
  settings: ReviewsSectionSettings;
  reviews: PublicReview[];
  variant?: "homepage" | "dashboard";
}) {
  if (reviews.length === 0) return null;
  const compact = variant === "dashboard";
  const idBase = compact ? "dashboard-reviews" : "student-reviews";
  const animate = settings.autoScroll && reviews.length >= MIN_FOR_MARQUEE;
  const speedPx = REVIEW_SPEED_PX[settings.speed] * (compact ? DASHBOARD_SPEED_FACTOR : 1);

  // Animated: group A = the reviews (+ aria-hidden repeats to fill wide
  // screens), group B = an aria-hidden copy of A for the seamless wrap.
  const repeats = animate ? Math.max(1, Math.ceil(MIN_GROUP_CARDS[variant] / reviews.length)) : 1;
  const groupItems = Array.from({ length: repeats }, (_, r) => reviews.map((review) => ({ review, copy: r > 0 }))).flat();

  const header = compact ? (
    <h2 id={`${idBase}-heading`} className="text-sm font-semibold text-[var(--color-foreground)]">
      {settings.heading}
    </h2>
  ) : (
    <div className="flex max-w-2xl flex-col gap-3">
      <h2 id="student-reviews-heading" className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)] sm:text-3xl">
        {settings.heading}
      </h2>
      {settings.subtitle ? <p className="leading-relaxed text-[var(--color-muted-foreground)]">{settings.subtitle}</p> : null}
    </div>
  );

  return (
    <section
      id={idBase}
      aria-labelledby={`${idBase}-heading`}
      className={compact ? "flex min-w-0 flex-col" : "scroll-mt-20 border-t border-[var(--color-border)] py-14 sm:py-20"}
    >
      <ReviewsMarquee header={header} animate={animate} speedPx={speedPx} direction={settings.direction} compact={compact}>
        <ul className={compact ? "flex gap-3 pr-3" : "flex gap-4 pr-4"} aria-label="Student reviews">
          {groupItems.map(({ review, copy }, i) => (
            <ReviewCard
              key={`a${i}`}
              review={review}
              settings={settings}
              hidden={copy}
              compact={compact}
              popoverId={copy ? null : `${idBase}-full-${review.key}`}
            />
          ))}
        </ul>
        {animate ? (
          <ul className={`${compact ? "flex gap-3 pr-3" : "flex gap-4 pr-4"} motion-reduce:hidden`} aria-hidden inert>
            {groupItems.map(({ review }, i) => (
              <ReviewCard key={`b${i}`} review={review} settings={settings} hidden compact={compact} popoverId={null} />
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
  compact = false,
  popoverId,
}: {
  review: PublicReview;
  settings: ReviewsSectionSettings;
  hidden: boolean;
  compact?: boolean;
  popoverId: string | null;
}) {
  const long = review.comment.length > (compact ? LONG_COMMENT_COMPACT : LONG_COMMENT);
  const width = compact ? "w-[82vw] max-w-[320px] sm:w-[300px] lg:w-[340px]" : "w-[78vw] max-w-[340px] sm:w-[320px] lg:w-[300px]";
  return (
    <li
      className={`flex ${width} shrink-0 snap-start ${hidden ? "motion-reduce:hidden" : ""}`}
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <figure
        data-review-card
        tabIndex={hidden ? -1 : 0}
        aria-label={`Review by ${review.name}${settings.showRating ? `, rated ${review.rating} out of 5` : ""}`}
        className={`flex w-full flex-col rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] ${compact ? "gap-3 p-4" : "gap-4 p-5"}`}
      >
        {settings.showRating ? <Stars rating={review.rating} /> : null}
        <blockquote className="flex-1 text-sm leading-relaxed text-[var(--color-foreground)]">
          <p className={`${compact ? "line-clamp-3" : "line-clamp-5"} whitespace-pre-line`}>{review.comment}</p>
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
        <figcaption className={`flex items-center gap-3 border-t border-[var(--color-border)] ${compact ? "pt-3" : "pt-4"}`}>
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
