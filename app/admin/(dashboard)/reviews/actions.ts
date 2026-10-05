"use server";

import { z } from "zod";
import { revalidatePath, updateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { HOMEPAGE_REVIEWS_TAG, saveReviewsSectionSettings } from "@/lib/reviews";
import {
  REVIEW_DIRECTIONS,
  REVIEW_LIMITS,
  REVIEW_SPEEDS,
  REVIEWS_SECTION_SETTING_KEY,
  cleanReviewText,
  normalizeReviewsSectionSettings,
} from "@/lib/reviews-shared";

/**
 * Admin → Reviews. Every action is gated server-side behind WEBSITE_MANAGE
 * (MASTER_ADMIN only — FULL_ADMIN is global read-only and is refused here),
 * writes an AuditLog row, and invalidates the cached homepage reviews.
 *
 * Provenance never changes here: a manual testimonial is created as
 * ADMIN_ADDED with no student, student reviews keep their source, student
 * and verbatim original text when edited (the database also enforces this —
 * see the Review CHECK constraints and trigger in the migration).
 */

export type ReviewActionResult = { ok: true; message?: string } | { ok: false; error: string };

const PERMISSION_ERROR = "You don't have permission to manage reviews.";

async function guard(): Promise<{ ok: true; adminId: string } | { ok: false; error: string }> {
  try {
    const session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);
    const adminId = session.user.id;
    return adminId ? { ok: true, adminId } : { ok: false, error: PERMISSION_ERROR };
  } catch (error) {
    if (error instanceof UnauthorizedError) return { ok: false, error: PERMISSION_ERROR };
    throw error;
  }
}

function refresh() {
  updateTag(HOMEPAGE_REVIEWS_TAG);
  revalidatePath("/admin/reviews");
}

const idsSchema = z.array(z.string().min(1).max(64)).min(1, "Select at least one review.").max(500);

const checkbox = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.literal("")])
  .optional()
  .transform((v) => v === "on" || v === "true");

const reviewFieldsSchema = z.object({
  displayName: z
    .string()
    .transform((v) => cleanReviewText(v, REVIEW_LIMITS.nameMax))
    .pipe(z.string().min(2, "Display name must be at least 2 characters.")),
  rating: z.coerce.number().int().min(1, "Rating must be 1–5.").max(5, "Rating must be 1–5."),
  comment: z
    .string()
    .transform((v) => cleanReviewText(v, REVIEW_LIMITS.commentMax, { multiline: true }))
    .pipe(z.string().min(10, "Comment must be at least 10 characters.")),
  examName: z
    .string()
    .optional()
    .transform((v) => (v ? cleanReviewText(v, REVIEW_LIMITS.examMax) : "") || null),
  isFeatured: checkbox,
  isPublished: checkbox,
  displayOrder: z.coerce.number().int().min(-9999).max(9999).catch(0),
});

export async function createReviewAction(formData: FormData): Promise<ReviewActionResult> {
  const g = await guard();
  if (!g.ok) return g;
  const parsed = reviewFieldsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  const d = parsed.data;
  const now = new Date();

  const review = await prisma.review.create({
    data: {
      source: "ADMIN_ADDED",
      status: "APPROVED",
      isPublished: d.isPublished,
      isFeatured: d.isFeatured,
      displayOrder: d.displayOrder,
      displayName: d.displayName,
      rating: d.rating,
      comment: d.comment,
      examName: d.examName,
      createdById: g.adminId,
      approvedAt: now,
      approvedById: g.adminId,
    },
    select: { id: true },
  });
  await prisma.auditLog.create({
    data: {
      actorId: g.adminId,
      action: "REVIEW_CREATED",
      entityType: "Review",
      entityId: review.id,
      metadata: { source: "ADMIN_ADDED", published: d.isPublished, featured: d.isFeatured },
    },
  });
  refresh();
  return { ok: true, message: "Testimonial added." };
}

export async function updateReviewAction(id: string, formData: FormData): Promise<ReviewActionResult> {
  const g = await guard();
  if (!g.ok) return g;
  const parsedId = z.string().min(1).max(64).safeParse(id);
  const parsed = reviewFieldsSchema.safeParse(Object.fromEntries(formData));
  if (!parsedId.success) return { ok: false, error: "Unknown review." };
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  const d = parsed.data;

  const existing = await prisma.review.findUnique({ where: { id: parsedId.data }, select: { status: true, source: true } });
  if (!existing) return { ok: false, error: "This review no longer exists." };
  if (d.isPublished && existing.status !== "APPROVED") {
    return { ok: false, error: "Approve this review before publishing it." };
  }

  // source / studentId / original* are deliberately not in this update.
  await prisma.review.update({
    where: { id: parsedId.data },
    data: {
      displayName: d.displayName,
      rating: d.rating,
      comment: d.comment,
      examName: d.examName,
      isFeatured: d.isFeatured,
      isPublished: d.isPublished,
      displayOrder: d.displayOrder,
      editedAt: new Date(),
      editedById: g.adminId,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: g.adminId,
      action: "REVIEW_EDITED",
      entityType: "Review",
      entityId: parsedId.data,
      metadata: { source: existing.source, published: d.isPublished, featured: d.isFeatured },
    },
  });
  refresh();
  return { ok: true, message: "Review saved." };
}

const BULK_OPERATIONS = ["publish", "unpublish", "approve", "approve_publish", "reject", "feature", "unfeature", "delete"] as const;
export type ReviewBulkOperation = (typeof BULK_OPERATIONS)[number];

export async function bulkReviewAction(operation: ReviewBulkOperation, ids: string[]): Promise<ReviewActionResult> {
  const g = await guard();
  if (!g.ok) return g;
  const op = z.enum(BULK_OPERATIONS).safeParse(operation);
  const parsedIds = idsSchema.safeParse(ids);
  if (!op.success) return { ok: false, error: "Unknown action." };
  if (!parsedIds.success) return { ok: false, error: parsedIds.error.issues[0]?.message ?? "Invalid selection." };
  const where = { id: { in: parsedIds.data } };
  const adminId = g.adminId;
  const now = new Date();

  let count = 0;
  let skipped = 0;
  switch (op.data) {
    case "publish": {
      count = (await prisma.review.updateMany({ where: { ...where, status: "APPROVED" }, data: { isPublished: true } })).count;
      skipped = parsedIds.data.length - count;
      break;
    }
    case "unpublish":
      count = (await prisma.review.updateMany({ where, data: { isPublished: false } })).count;
      break;
    case "approve":
    case "approve_publish": {
      const publish = op.data === "approve_publish";
      // Already-approved rows keep their original approvedAt/approvedBy.
      const results = await prisma.$transaction([
        prisma.review.updateMany({
          where: { ...where, status: { not: "APPROVED" } },
          data: { status: "APPROVED", approvedAt: now, approvedById: adminId, rejectedAt: null, ...(publish ? { isPublished: true } : {}) },
        }),
        ...(publish ? [prisma.review.updateMany({ where: { ...where, status: "APPROVED", isPublished: false }, data: { isPublished: true } })] : []),
      ]);
      count = results.reduce((sum, r) => sum + r.count, 0);
      break;
    }
    case "reject":
      count = (
        await prisma.review.updateMany({
          where,
          data: { status: "REJECTED", isPublished: false, isFeatured: false, rejectedAt: now, approvedAt: null, approvedById: null },
        })
      ).count;
      break;
    case "feature":
      count = (await prisma.review.updateMany({ where, data: { isFeatured: true } })).count;
      break;
    case "unfeature":
      count = (await prisma.review.updateMany({ where, data: { isFeatured: false } })).count;
      break;
    case "delete":
      count = (await prisma.review.deleteMany({ where })).count;
      break;
  }

  await prisma.auditLog.create({
    data: {
      actorId: adminId,
      action: `REVIEW_BULK_${op.data.toUpperCase()}`,
      entityType: "Review",
      entityId: parsedIds.data.length === 1 ? parsedIds.data[0] : null,
      metadata: { ids: parsedIds.data, affected: count, skipped },
    },
  });
  refresh();
  const noun = count === 1 ? "review" : "reviews";
  const verb: Record<ReviewBulkOperation, string> = {
    publish: "published",
    unpublish: "hidden",
    approve: "approved",
    approve_publish: "approved and published",
    reject: "rejected",
    feature: "marked featured",
    unfeature: "unmarked featured",
    delete: "deleted",
  };
  return {
    ok: true,
    message: `${count} ${noun} ${verb[op.data]}.${skipped > 0 ? ` ${skipped} skipped — only approved reviews can be published.` : ""}`,
  };
}

export async function setReviewOrderAction(id: string, displayOrder: number): Promise<ReviewActionResult> {
  const g = await guard();
  if (!g.ok) return g;
  const parsed = z.object({ id: z.string().min(1).max(64), displayOrder: z.number().int().min(-9999).max(9999) }).safeParse({ id, displayOrder });
  if (!parsed.success) return { ok: false, error: "Order must be a whole number between -9999 and 9999." };
  const updated = await prisma.review.updateMany({ where: { id: parsed.data.id }, data: { displayOrder: parsed.data.displayOrder } });
  if (updated.count === 0) return { ok: false, error: "This review no longer exists." };
  await prisma.auditLog.create({
    data: {
      actorId: g.adminId,
      action: "REVIEW_ORDER_CHANGED",
      entityType: "Review",
      entityId: parsed.data.id,
      metadata: { displayOrder: parsed.data.displayOrder },
    },
  });
  refresh();
  return { ok: true, message: "Order saved." };
}

const settingsSchema = z.object({
  enabled: checkbox,
  heading: z.string().max(500).default(""),
  subtitle: z.string().max(1000).default(""),
  maxReviews: z.coerce.number().int().min(REVIEW_LIMITS.maxShownMin).max(REVIEW_LIMITS.maxShownMax),
  autoScroll: checkbox,
  speed: z.enum(REVIEW_SPEEDS),
  direction: z.enum(REVIEW_DIRECTIONS),
  showRating: checkbox,
  showExam: checkbox,
  showVerified: checkbox,
  preferFeatured: checkbox,
  showOnDashboard: checkbox,
});

export async function saveReviewsSettingsAction(formData: FormData): Promise<ReviewActionResult> {
  const g = await guard();
  if (!g.ok) return g;
  const parsed = settingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.path[0] === "maxReviews" ? `Maximum reviews must be ${REVIEW_LIMITS.maxShownMin}–${REVIEW_LIMITS.maxShownMax}.` : "Invalid settings." };
  }
  // normalize() cleans the text and restores the default heading when blank.
  const settings = normalizeReviewsSectionSettings(parsed.data);
  await saveReviewsSectionSettings(settings);
  await prisma.auditLog.create({
    data: {
      actorId: g.adminId,
      action: "REVIEWS_SECTION_SETTINGS_SAVED",
      entityType: "Setting",
      entityId: REVIEWS_SECTION_SETTING_KEY,
      metadata: { ...settings },
    },
  });
  refresh();
  return { ok: true, message: "Homepage review settings saved." };
}
