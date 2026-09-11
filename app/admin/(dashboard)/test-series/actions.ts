"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit";
import { requireAdminRole } from "@/lib/auth/requireAdmin";
import { prisma } from "@/lib/db";

export type FormState = { error?: string } | undefined;

const schema = z.object({
  examId: z.string().trim().min(1, "Choose an exam"),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens only"),
  kind: z.enum(["FULL_MOCK", "PREVIOUS_YEAR", "SUBJECT_WISE"]),
  title: z.string().trim().min(1, "Title is required"),
  description: z.string().trim().min(1, "Description is required"),
  metaLabel: z.string().trim().optional(),
  isPopular: z.coerce.boolean(),
  isFree: z.coerce.boolean(),
  order: z.coerce.number().int().default(0),
});

function parseForm(formData: FormData) {
  return schema.safeParse({
    examId: formData.get("examId"),
    slug: formData.get("slug"),
    kind: formData.get("kind"),
    title: formData.get("title"),
    description: formData.get("description"),
    metaLabel: formData.get("metaLabel") || undefined,
    isPopular: formData.get("isPopular") === "on",
    isFree: formData.get("isFree") === "on",
    order: formData.get("order") || 0,
  });
}

export async function createTestSeriesAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdminRole();
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const existing = await prisma.testSeries.findUnique({ where: { slug: parsed.data.slug } });
  if (existing) return { error: "A test series with this slug already exists." };

  const created = await prisma.testSeries.create({ data: parsed.data });

  await writeAuditLog({
    adminId: session.user.id,
    action: "create",
    entity: "TestSeries",
    entityId: created.id,
    diff: parsed.data,
  });
  updateTag("homepage");
  redirect(`/admin/exams/${parsed.data.examId}/edit?success=Test series created`);
}

export async function updateTestSeriesAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const conflict = await prisma.testSeries.findFirst({ where: { slug: parsed.data.slug, NOT: { id } } });
  if (conflict) return { error: "Another test series already uses this slug." };

  await prisma.testSeries.update({ where: { id }, data: parsed.data });

  await writeAuditLog({
    adminId: session.user.id,
    action: "update",
    entity: "TestSeries",
    entityId: id,
    diff: parsed.data,
  });
  updateTag("homepage");
  redirect("/admin/test-series?success=Test series updated");
}

export async function deleteTestSeriesAction(formData: FormData): Promise<void> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));

  await prisma.testSeries.delete({ where: { id } });

  await writeAuditLog({ adminId: session.user.id, action: "delete", entity: "TestSeries", entityId: id });
  updateTag("homepage");
  redirect("/admin/test-series?success=Test series deleted");
}

const testSchema = z.object({
  testSeriesId: z.string(),
  title: z.string().trim().min(1, "Title is required"),
  durationMin: z.coerce.number().int().positive("Must be a positive number"),
  totalMarks: z.coerce.number().int().positive("Must be a positive number"),
  negativeMark: z.coerce.number().min(0).default(0),
  isPublished: z.coerce.boolean(),
  order: z.coerce.number().int().default(0),
});

export async function createTestAction(formData: FormData): Promise<void> {
  const session = await requireAdminRole();
  const parsed = testSchema.parse({
    testSeriesId: formData.get("testSeriesId"),
    title: formData.get("title"),
    durationMin: formData.get("durationMin"),
    totalMarks: formData.get("totalMarks"),
    negativeMark: formData.get("negativeMark") || 0,
    isPublished: formData.get("isPublished") === "on",
    order: formData.get("order") || 0,
  });

  const created = await prisma.test.create({ data: parsed });

  await writeAuditLog({
    adminId: session.user.id,
    action: "create",
    entity: "Test",
    entityId: created.id,
    diff: parsed,
  });
  updateTag("homepage");
  redirect(`/admin/test-series/${parsed.testSeriesId}/edit?success=Test added`);
}

export async function deleteTestAction(formData: FormData): Promise<void> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));
  const testSeriesId = String(formData.get("testSeriesId"));

  await prisma.test.delete({ where: { id } });

  await writeAuditLog({ adminId: session.user.id, action: "delete", entity: "Test", entityId: id });
  updateTag("homepage");
  redirect(`/admin/test-series/${testSeriesId}/edit?success=Test removed`);
}
