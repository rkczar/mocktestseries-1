"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit";
import { requireAdminRole } from "@/lib/auth/requireAdmin";
import { prisma } from "@/lib/db";

export type FormState = { error?: string } | undefined;

const schema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  priceInPaise: z.coerce.number().int().min(0, "Must be 0 or more"),
  period: z.string().trim().min(1, "Period is required"),
  description: z.string().trim().min(1, "Description is required"),
  features: z.string().trim().optional(),
  isPopular: z.coerce.boolean(),
  isActive: z.coerce.boolean(),
  order: z.coerce.number().int().default(0),
  ctaLabel: z.string().trim().min(1).default("Get started"),
});

function parseForm(formData: FormData) {
  return schema.safeParse({
    name: formData.get("name"),
    priceInPaise: formData.get("priceInRupees") ? Number(formData.get("priceInRupees")) * 100 : 0,
    period: formData.get("period"),
    description: formData.get("description"),
    features: formData.get("features") || undefined,
    isPopular: formData.get("isPopular") === "on",
    isActive: formData.get("isActive") === "on",
    order: formData.get("order") || 0,
    ctaLabel: formData.get("ctaLabel") || "Get started",
  });
}

function featuresArray(raw: string | undefined) {
  return raw
    ? raw
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

export async function createPricingPlanAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdminRole();
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const created = await prisma.pricingPlan.create({
    data: { ...parsed.data, features: featuresArray(parsed.data.features) },
  });

  await writeAuditLog({
    adminId: session.user.id,
    action: "create",
    entity: "PricingPlan",
    entityId: created.id,
    diff: parsed.data,
  });
  updateTag("homepage");
  redirect("/admin/pricing?success=Plan created");
}

export async function updatePricingPlanAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  await prisma.pricingPlan.update({
    where: { id },
    data: { ...parsed.data, features: featuresArray(parsed.data.features) },
  });

  await writeAuditLog({
    adminId: session.user.id,
    action: "update",
    entity: "PricingPlan",
    entityId: id,
    diff: parsed.data,
  });
  updateTag("homepage");
  redirect("/admin/pricing?success=Plan updated");
}

export async function deletePricingPlanAction(formData: FormData): Promise<void> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));

  await prisma.pricingPlan.delete({ where: { id } });

  await writeAuditLog({ adminId: session.user.id, action: "delete", entity: "PricingPlan", entityId: id });
  updateTag("homepage");
  redirect("/admin/pricing?success=Plan deleted");
}
