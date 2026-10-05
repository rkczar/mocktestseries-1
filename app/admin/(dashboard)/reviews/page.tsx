import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getReviewsSectionSettings } from "@/lib/reviews";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Button } from "@/components/ui/button";
import { ReviewsManager, type AdminReviewRow } from "./reviews-manager";
import { ReviewForm } from "./review-form";
import { ReviewsSettingsForm } from "./settings-form";

export const metadata = { title: "Reviews — Mock Test Series.in Admin" };

const SOURCES = ["STUDENT_SUBMITTED", "ADMIN_ADDED"] as const;
const STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
const VISIBILITY = ["published", "hidden"] as const;

type Search = { q?: string; source?: string; status?: string; rating?: string; visibility?: string };

export default async function AdminReviewsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 100);
  const source = SOURCES.find((s) => s === sp.source);
  const status = STATUSES.find((s) => s === sp.status);
  const rating = ["1", "2", "3", "4", "5"].includes(sp.rating ?? "") ? Number(sp.rating) : undefined;
  const visibility = VISIBILITY.find((v) => v === sp.visibility);

  const where: Prisma.ReviewWhereInput = {
    ...(source ? { source } : {}),
    ...(status ? { status } : {}),
    ...(rating ? { rating } : {}),
    ...(visibility ? { isPublished: visibility === "published" } : {}),
    ...(q
      ? {
          OR: [
            { displayName: { contains: q, mode: "insensitive" } },
            { comment: { contains: q, mode: "insensitive" } },
            { examName: { contains: q, mode: "insensitive" } },
            { student: { studentId: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [session, settings, rows, counts] = await Promise.all([
    getAdminSession(),
    getReviewsSectionSettings(),
    prisma.review.findMany({
      where,
      orderBy: [{ status: "asc" }, { isFeatured: "desc" }, { displayOrder: "asc" }, { createdAt: "desc" }],
      take: 500,
      select: {
        id: true,
        source: true,
        status: true,
        isPublished: true,
        isFeatured: true,
        displayOrder: true,
        displayName: true,
        rating: true,
        comment: true,
        examName: true,
        originalDisplayName: true,
        originalRating: true,
        originalComment: true,
        createdAt: true,
        approvedAt: true,
        rejectedAt: true,
        editedAt: true,
        approvedBy: { select: { name: true } },
        editedBy: { select: { name: true } },
        createdBy: { select: { name: true } },
        // Admin moderation context only — never email or phone.
        student: { select: { studentId: true, status: true } },
      },
    }),
    prisma.review.groupBy({ by: ["status", "isPublished"], _count: { _all: true } }),
  ]);
  const canManage = session?.user?.permissions?.includes(PERMISSIONS.WEBSITE_MANAGE) ?? false;
  const total = counts.reduce((n, c) => n + c._count._all, 0);
  const pending = counts.filter((c) => c.status === "PENDING").reduce((n, c) => n + c._count._all, 0);
  const published = counts.filter((c) => c.isPublished).reduce((n, c) => n + c._count._all, 0);
  const filtered = Boolean(q || source || status || rating || visibility);

  const data: AdminReviewRow[] = rows.map((r) => ({
    id: r.id,
    source: r.source,
    status: r.status,
    isPublished: r.isPublished,
    isFeatured: r.isFeatured,
    displayOrder: r.displayOrder,
    displayName: r.displayName,
    rating: r.rating,
    comment: r.comment,
    examName: r.examName,
    original:
      r.source === "STUDENT_SUBMITTED" && r.originalComment !== null
        ? { displayName: r.originalDisplayName, rating: r.originalRating, comment: r.originalComment }
        : null,
    studentCode: r.student?.studentId ?? null,
    studentInactive: r.student ? r.student.status !== "ACTIVE" && r.student.status !== "DELETION_REQUESTED" : false,
    createdAt: r.createdAt.toISOString(),
    approvedAt: r.approvedAt?.toISOString() ?? null,
    approvedBy: r.approvedBy?.name ?? null,
    rejectedAt: r.rejectedAt?.toISOString() ?? null,
    editedAt: r.editedAt?.toISOString() ?? null,
    editedBy: r.editedBy?.name ?? null,
    createdBy: r.createdBy?.name ?? null,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Reviews</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Student reviews and testimonials for the homepage &ldquo;{settings.heading}&rdquo; section. Only approved, published
          reviews appear publicly. Student-submitted reviews start as Pending; manual testimonials are labelled Admin-added and
          never receive the Verified Student badge.
        </p>
        {!canManage ? (
          <p className="mt-2 text-sm text-[var(--color-warning)]">Read-only: managing reviews requires the Master Admin role.</p>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Total" value={total} />
        <Stat label="Pending" value={pending} href={pending > 0 ? "/admin/reviews?status=PENDING" : undefined} />
        <Stat label="Published" value={published} href="/admin/reviews?visibility=published" />
      </div>

      <ReviewsSettingsForm initial={settings} canManage={canManage} />

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Add Testimonial</CardTitle>
            <CardDescription>A manual testimonial (source: Admin-added). It is approved on creation and can be hidden or deleted later.</CardDescription>
          </CardHeader>
          <CardContent>
            <ReviewForm mode="create" />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>All Reviews</CardTitle>
          <CardDescription>
            {filtered ? `${rows.length} matching` : `${total} total`}
            {rows.length === 500 ? " (showing the first 500)" : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form method="get" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto_auto_auto]" role="search" aria-label="Filter reviews">
            <Input name="q" defaultValue={q} placeholder="Search name, comment, exam or student ID" aria-label="Search reviews" />
            <SelectNative name="source" defaultValue={source ?? ""} aria-label="Filter by source">
              <option value="">All sources</option>
              <option value="STUDENT_SUBMITTED">Student-submitted</option>
              <option value="ADMIN_ADDED">Admin-added</option>
            </SelectNative>
            <SelectNative name="status" defaultValue={status ?? ""} aria-label="Filter by status">
              <option value="">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </SelectNative>
            <SelectNative name="visibility" defaultValue={visibility ?? ""} aria-label="Filter by visibility">
              <option value="">Published &amp; hidden</option>
              <option value="published">Published</option>
              <option value="hidden">Hidden</option>
            </SelectNative>
            <SelectNative name="rating" defaultValue={rating ? String(rating) : ""} aria-label="Filter by rating">
              <option value="">All ratings</option>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n} star{n === 1 ? "" : "s"}
                </option>
              ))}
            </SelectNative>
            <div className="flex gap-2">
              <Button type="submit" variant="outline">
                Filter
              </Button>
              {filtered ? (
                <Button asChild variant="ghost">
                  <Link href="/admin/reviews">Clear</Link>
                </Button>
              ) : null}
            </div>
          </form>

          <ReviewsManager rows={data} canManage={canManage} emptyText={filtered ? "No reviews match these filters." : "No reviews yet. Add a testimonial above, or wait for students to submit reviews from their dashboard."} />
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href?: string }) {
  const body = (
    <Card className="h-full">
      <CardContent className="flex flex-col gap-0.5 py-4">
        <span className="text-xs text-[var(--color-muted-foreground)]">{label}</span>
        <span className="text-lg font-semibold tabular-nums text-[var(--color-foreground)]">{value}</span>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}
