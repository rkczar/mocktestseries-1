import "server-only";
import { unstable_cache } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AUTH_ELIGIBLE_STATUSES } from "@/lib/student-lifecycle";
import {
  REVIEWS_SECTION_SETTING_KEY,
  normalizeReviewsSectionSettings,
  type PublicReview,
  type ReviewsSectionSettings,
} from "@/lib/reviews-shared";

/** Cache tag for the public homepage reviews; every admin review/settings mutation calls updateTag() with it. */
export const HOMEPAGE_REVIEWS_TAG = "homepage-reviews";

export async function getReviewsSectionSettings(): Promise<ReviewsSectionSettings> {
  const row = await prisma.setting.findUnique({ where: { key: REVIEWS_SECTION_SETTING_KEY } });
  return normalizeReviewsSectionSettings(row?.value);
}

export async function saveReviewsSectionSettings(settings: ReviewsSectionSettings) {
  const value = settings as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({
    where: { key: REVIEWS_SECTION_SETTING_KEY },
    create: { key: REVIEWS_SECTION_SETTING_KEY, value },
    update: { value },
  });
}

/**
 * Only APPROVED + published reviews, and never one whose student account is
 * no longer active (deleted/suspended). "Verified" is derived here from the
 * stored provenance — STUDENT_SUBMITTED with its student attached, which the
 * database guarantees can never be true of an ADMIN_ADDED row. Uncached;
 * exported for scripts/verify-reviews.ts — the homepage uses getHomepageReviewsSafe().
 */
export async function computeHomepageReviews(): Promise<{ settings: ReviewsSectionSettings; reviews: PublicReview[] }> {
  const settings = await getReviewsSectionSettings();
  if (!settings.enabled) return { settings, reviews: [] };

  const rows = await prisma.review.findMany({
    where: {
      status: "APPROVED",
      isPublished: true,
      OR: [{ studentId: null }, { student: { status: { in: [...AUTH_ELIGIBLE_STATUSES] } } }],
    },
    orderBy: [
      ...(settings.preferFeatured ? [{ isFeatured: "desc" as const }] : []),
      { displayOrder: "asc" },
      { approvedAt: "desc" },
      { createdAt: "desc" },
    ],
    take: settings.maxReviews,
    select: { source: true, studentId: true, displayName: true, rating: true, comment: true, examName: true },
  });

  const reviews = rows.map((r, i) => ({
    key: `r${i}`,
    name: r.displayName,
    rating: Math.min(5, Math.max(1, r.rating)),
    comment: r.comment,
    exam: settings.showExam ? r.examName : null,
    verified: settings.showVerified && r.source === "STUDENT_SUBMITTED" && r.studentId !== null,
  }));
  return { settings, reviews };
}

const cachedHomepageReviews = unstable_cache(computeHomepageReviews, ["homepage-reviews"], {
  tags: [HOMEPAGE_REVIEWS_TAG],
  revalidate: 300,
});

/**
 * Homepage entry point. Cached, bounded by a short timeout, and never
 * throws: a slow or failing reviews query hides the section instead of
 * delaying or breaking the homepage.
 */
export async function getHomepageReviewsSafe(timeoutMs = 1500): Promise<{ settings: ReviewsSectionSettings; reviews: PublicReview[] } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([cachedHomepageReviews(), timeout]);
    if (!result || !result.settings.enabled || result.reviews.length === 0) return null;
    return result;
  } catch (error) {
    console.error("[reviews] homepage reviews unavailable", error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
