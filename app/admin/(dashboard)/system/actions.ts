"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getStorageSnapshot } from "@/lib/storage-stats";

export async function rescanStorageAction() {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  await getStorageSnapshot({ forceRefresh: true });
  revalidatePath("/admin/system");
  revalidatePath("/admin");
}
