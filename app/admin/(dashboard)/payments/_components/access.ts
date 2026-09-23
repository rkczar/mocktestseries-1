import "server-only";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import type { FilterOptions } from "./shared";

/** View = PAYMENTS_VIEW (MASTER + FULL_ADMIN); manage = PAYMENTS_MANAGE (MASTER only). */
export async function getPaymentsAccess() {
  const session = await getAdminSession();
  const perms = session?.user?.permissions ?? [];
  return { canView: perms.includes(PERMISSIONS.PAYMENTS_VIEW), canManage: perms.includes(PERMISSIONS.PAYMENTS_MANAGE) };
}

export async function getFilterOptions(): Promise<FilterOptions> {
  const [exams, products, coupons] = await Promise.all([
    prisma.exam.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.product.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.coupon.findMany({ select: { id: true, code: true }, orderBy: { code: "asc" } }),
  ]);
  return { exams, products, coupons };
}
