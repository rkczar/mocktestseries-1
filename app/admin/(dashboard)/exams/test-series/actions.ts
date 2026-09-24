"use server";

import { z } from "zod";
import { revalidateMockSeriesSurfaces } from "@/lib/mock-series-revalidate";
import type { TestSeriesStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

// Test Series Control Center mutations are gated by TEST_SERIES_MANAGE
// (MASTER_ADMIN only), not EXAMS_MANAGE — same reasoning as Mock Test
// Builder (see app/admin/(dashboard)/tests/mock/actions.ts).
const schema = z.object({
  examId: z.string().min(1, "Select an exam"),
  name: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(4000).optional(),
  testCount: z.coerce.number().int().min(0).max(1000).default(0),
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).default("DRAFT"),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug: lowercase letters, numbers and hyphens only.")
    .max(120)
    .optional(),
  order: z.coerce.number().int().min(0).max(10000).default(0),
});

const updateSchema = schema.omit({ examId: true, status: true });

export interface TestSeriesFormState {
  error?: string;
  success?: boolean;
}

export async function createTestSeriesAction(
  _prev: TestSeriesFormState,
  formData: FormData
): Promise<TestSeriesFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const parsed = schema.safeParse({
    examId: formData.get("examId"),
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    instructions: formData.get("instructions") || undefined,
    testCount: formData.get("testCount"),
    status: formData.get("status") || undefined,
    slug: formData.get("slug") || undefined,
    order: formData.get("order") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  if (parsed.data.slug && (await prisma.testSeries.findUnique({ where: { slug: parsed.data.slug } }))) {
    return { error: "That slug is already used by another series." };
  }

  const series = await prisma.testSeries.create({
    data: { ...parsed.data, slug: parsed.data.slug ?? null, isActive: parsed.data.status === "PUBLISHED" },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "TEST_SERIES_CREATED", entityType: "TestSeries", entityId: series.id },
  });

  revalidateMockSeriesSurfaces();
  return { success: true };
}

/** Edits a series' settings (name, slug, planned count, copy) from its Control Center page. */
export async function updateTestSeriesAction(id: string, _prev: TestSeriesFormState, formData: FormData): Promise<TestSeriesFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const parsed = updateSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    instructions: formData.get("instructions") || undefined,
    testCount: formData.get("testCount"),
    slug: formData.get("slug") || undefined,
    order: formData.get("order") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  if (parsed.data.slug) {
    const clash = await prisma.testSeries.findUnique({ where: { slug: parsed.data.slug }, select: { id: true } });
    if (clash && clash.id !== id) return { error: "That slug is already used by another series." };
  }
  await prisma.testSeries.update({
    where: { id },
    data: {
      ...parsed.data,
      slug: parsed.data.slug ?? null,
      description: parsed.data.description ?? null,
      instructions: parsed.data.instructions ?? null,
    },
  });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "TEST_SERIES_UPDATED", entityType: "TestSeries", entityId: id, metadata: { testCount: parsed.data.testCount } },
  });
  revalidateMockSeriesSurfaces();
  return { success: true };
}

export async function toggleTestSeriesActiveAction(id: string, isActive: boolean) {
  await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  await prisma.testSeries.update({ where: { id }, data: { isActive } });
  revalidateMockSeriesSurfaces();
}

/** Publish/unpublish/archive a Test Series. PUBLISHED also flips the legacy isActive flag the homepage reads. */
export async function setTestSeriesStatusAction(id: string, status: TestSeriesStatus) {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  await prisma.testSeries.update({ where: { id }, data: { status, isActive: status === "PUBLISHED" } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "TEST_SERIES_STATUS_CHANGED", entityType: "TestSeries", entityId: id, metadata: { status } },
  });
  revalidateMockSeriesSurfaces();
}
