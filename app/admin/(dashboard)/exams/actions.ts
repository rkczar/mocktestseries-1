"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit";
import { requireAdminRole } from "@/lib/auth/requireAdmin";
import { prisma } from "@/lib/db";
import { UploadValidationError, uploadAdminFile } from "@/lib/storage/uploadAdminFile";

export type FormState = { error?: string } | undefined;

const schema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens only"),
  title: z.string().trim().min(1, "Title is required"),
  shortTitle: z.string().trim().optional(),
  description: z.string().trim().min(1, "Description is required"),
  status: z.enum(["ACTIVE", "COMING_SOON", "ARCHIVED"]),
  isFeatured: z.coerce.boolean(),
  order: z.coerce.number().int().default(0),
  region: z.string().trim().optional(),
  metaChips: z.string().trim().optional(),
  seoTitle: z.string().trim().optional(),
  seoDesc: z.string().trim().optional(),
});

function parseForm(formData: FormData) {
  return schema.safeParse({
    slug: formData.get("slug"),
    title: formData.get("title"),
    shortTitle: formData.get("shortTitle") || undefined,
    description: formData.get("description"),
    status: formData.get("status"),
    isFeatured: formData.get("isFeatured") === "on",
    order: formData.get("order") || 0,
    region: formData.get("region") || undefined,
    metaChips: formData.get("metaChips") || undefined,
    seoTitle: formData.get("seoTitle") || undefined,
    seoDesc: formData.get("seoDesc") || undefined,
  });
}

function metaChipsArray(raw: string | undefined) {
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

export async function createExamAction(_prevState: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdminRole();
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const existing = await prisma.exam.findUnique({ where: { slug: parsed.data.slug } });
  if (existing) return { error: "An exam with this slug already exists." };

  let iconUrl: string | undefined;
  let imageUrl: string | undefined;
  try {
    const icon = await uploadAdminFile(formData.get("icon") as File | null, "image", session.user.id);
    const image = await uploadAdminFile(formData.get("image") as File | null, "image", session.user.id);
    iconUrl = icon?.url;
    imageUrl = image?.url;
  } catch (error) {
    if (error instanceof UploadValidationError) return { error: error.message };
    throw error;
  }

  const created = await prisma.exam.create({
    data: {
      ...parsed.data,
      metaChips: metaChipsArray(parsed.data.metaChips),
      iconUrl,
      imageUrl,
    },
  });

  await writeAuditLog({
    adminId: session.user.id,
    action: "create",
    entity: "Exam",
    entityId: created.id,
    diff: parsed.data,
  });
  updateTag("homepage");
  redirect("/admin/exams?success=Exam created");
}

export async function updateExamAction(_prevState: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const conflict = await prisma.exam.findFirst({ where: { slug: parsed.data.slug, NOT: { id } } });
  if (conflict) return { error: "Another exam already uses this slug." };

  let iconUrl: string | undefined;
  let imageUrl: string | undefined;
  try {
    const icon = await uploadAdminFile(formData.get("icon") as File | null, "image", session.user.id);
    const image = await uploadAdminFile(formData.get("image") as File | null, "image", session.user.id);
    iconUrl = icon?.url;
    imageUrl = image?.url;
  } catch (error) {
    if (error instanceof UploadValidationError) return { error: error.message };
    throw error;
  }

  await prisma.exam.update({
    where: { id },
    data: {
      ...parsed.data,
      metaChips: metaChipsArray(parsed.data.metaChips),
      ...(iconUrl ? { iconUrl } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    },
  });

  await writeAuditLog({
    adminId: session.user.id,
    action: "update",
    entity: "Exam",
    entityId: id,
    diff: parsed.data,
  });
  updateTag("homepage");
  redirect("/admin/exams?success=Exam updated");
}

export async function archiveExamAction(formData: FormData): Promise<void> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));

  await prisma.exam.update({ where: { id }, data: { status: "ARCHIVED", isFeatured: false } });

  await writeAuditLog({ adminId: session.user.id, action: "update", entity: "Exam", entityId: id, diff: { status: "ARCHIVED" } });
  updateTag("homepage");
  redirect("/admin/exams?success=Exam archived");
}
